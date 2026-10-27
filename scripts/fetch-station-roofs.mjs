// 東京23区まわりの駅の屋根（駅舎・ホームの上屋）の形を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに public/station-roofs/15/{x}/{y}.json に書き出す。
// 駅（src/data/stations.json）から一定距離以内のものだけ残す（ガソリンスタンドの屋根などを除くため）。
// ホームが線で描かれているもの（東京駅の JR など）は、両脇の線路（data/osm/railways）から
// PLATFORM_CLEAR m ずつ空けた形の面にする（fetch-railways.mjs の後に実行）。
// 使い方: node scripts/fetch-station-roofs.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/station-roofs に保存し、2回目からはそれを使う（取得し直す時は消す）
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）: [[種類, 地面からの高さ(m), 駅の番号, [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...]
//   種類：0 = 駅舎、1 = 上屋（屋根）、2 = ホーム（床）
//   上屋・ホームの高さは仮の値。scripts/build-platforms.mjs が線路の高さに合わせて書き換える
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const partial = process.argv[2] !== undefined;
const SPLIT = Number(process.argv[3] ?? 4);
const ZOOM = 15;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OUT_DIR = new URL('../public/station-roofs/15/', import.meta.url);
const CACHE_DIR = new URL('../data/cache/station-roofs/', import.meta.url);
const RAIL_DIR = new URL('../data/osm/railways/15/', import.meta.url);
/** 駅からこの距離 (m) 以内の屋根だけ残す */
const NEAR_STATION = 300;
/** 1層（layer）あたりの高さ (m)。高架の線路はおよそこの高さ */
const LAYER_HEIGHT = 8;
/** 上屋の、乗っている面からの高さ (m) */
const CANOPY_HEIGHT = 6;
/** 線で描かれたホーム：ホームの縁と線路の中心の間 (m)、線路を探す範囲 (m)、片側に線路が無い時の半分の幅 (m) */
const PLATFORM_CLEAR = 1.6;
const TRACK_SEARCH = 9;
const DEFAULT_HALF = 2.5;
/** これより短い線のホームは使わない (m) */
const MIN_LINE_PLATFORM = 20;

const stations = JSON.parse(await readFile(new URL('../src/data/stations.json', import.meta.url), 'utf8'));

async function overpass(query) {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (station roof script)' },
          body: new URLSearchParams({ data: query }),
          // 応答の無いサーバーで止まらないよう、一定時間で次へ
          signal: AbortSignal.timeout(240000),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

const K = Math.PI / 180;
function meters(a, b) {
  const east = (b.lon - a.lon) * K * Math.cos(((a.lat + b.lat) / 2) * K);
  return Math.hypot(east, (b.lat - a.lat) * K) * 6371000;
}
function tileOf(lat, lon) {
  const n = 2 ** ZOOM;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n);
  return `${x}/${y}`;
}
/** 一番近い駅の番号と距離 */
function nearestStation(p) {
  let best = -1;
  let bestD = Infinity;
  stations.forEach((s, i) => {
    const d = meters(p, s);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return [best, bestD];
}

const ways = new Map();
for (let i = 0; i < SPLIT; i++) {
  for (let j = 0; j < SPLIT; j++) {
    const s = SOUTH + ((NORTH - SOUTH) * j) / SPLIT;
    const n = SOUTH + ((NORTH - SOUTH) * (j + 1)) / SPLIT;
    const w = WEST + ((EAST - WEST) * i) / SPLIT;
    const e = WEST + ((EAST - WEST) * (i + 1)) / SPLIT;
    const bbox = `${s},${w},${n},${e}`;
    const cacheFile = new URL(`${bbox}.json`, CACHE_DIR);
    let elements = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
    if (!elements) {
      elements = await overpass(`[out:json][timeout:180];
        (
          way["building"~"^(train_station|roof)$"](${bbox});
          way["railway"="platform"](${bbox});
        );
        out tags geom qt;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(elements));
    }
    for (const el of elements) ways.set(el.id, el);
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${ways.size} ways`);
  }
}

// ---- 線で描かれたホームを面にするための線路 ----
const MX = 111320 * Math.cos(35.68 * K);
const MY = 111320;
const T_CELL = 0.0005;
const trackGrid = new Map();
for (const x of await readdir(RAIL_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
    for (const [, , , coords] of JSON.parse(await readFile(new URL(`${x}/${f}`, RAIL_DIR), 'utf8'))) {
      let lat = 0;
      let lon = 0;
      const pts = [];
      for (let i = 0; i < coords.length; i += 2) {
        lat += coords[i];
        lon += coords[i + 1];
        pts.push([lon * 1e-6 * MX, lat * 1e-6 * MY]);
      }
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
        const cells = new Set();
        for (let k = 0; k <= n; k++) {
          cells.add(
            `${Math.floor((a[1] + ((b[1] - a[1]) * k) / n) / MY / T_CELL)},${Math.floor((a[0] + ((b[0] - a[0]) * k) / n) / MX / T_CELL)}`,
          );
        }
        for (const c of cells) {
          if (!trackGrid.has(c)) trackGrid.set(c, []);
          trackGrid.get(c).push([a, b]);
        }
      }
    }
  }
}
/** 点 p（平面の m）から、向き normal の側にある一番近い線路までの距離（TRACK_SEARCH m 以内に無ければ null） */
function trackDistance(p, normal) {
  let best = null;
  const cy = Math.floor(p[1] / MY / T_CELL);
  const cx = Math.floor(p[0] / MX / T_CELL);
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (const [a, b] of trackGrid.get(`${y},${x}`) ?? []) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
        const ox = a[0] + dx * t - p[0];
        const oy = a[1] + dy * t - p[1];
        const d = Math.hypot(ox, oy);
        // 向きの側にあり、ほぼ真横（ホームと並んで走る線路）
        if (d > TRACK_SEARCH || ox * normal[0] + oy * normal[1] < d * 0.7) continue;
        if (best === null || d < best) best = d;
      }
    }
  }
  return best;
}
/** 線のホームを、両脇の線路から PLATFORM_CLEAR m 空けた幅の面（緯度経度の輪）にする */
function lineToRing(g) {
  const line = g.map((p) => [p.lon * MX, p.lat * MY]);
  const pts = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const left = [];
  const right = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const normal = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const half = (side) => {
      const d = trackDistance(p, [normal[0] * side, normal[1] * side]);
      return d === null ? DEFAULT_HALF : Math.max(0.8, d - PLATFORM_CLEAR);
    };
    const l = half(1);
    const r = half(-1);
    left.push([p[0] + normal[0] * l, p[1] + normal[1] * l]);
    right.push([p[0] - normal[0] * r, p[1] - normal[1] * r]);
  });
  return [...left, ...right.reverse()].map(([x, y]) => ({ lat: y / MY, lon: x / MX }));
}
const lineLength = (g) => g.slice(1).reduce((s, p, i) => s + meters(g[i], p), 0);

const tiles = new Map();
const q = (v) => Math.round(v * 1e6);
let kept = 0;
let lines = 0;
for (const way of ways.values()) {
  let g = way.geometry;
  if (!g || g.length < 2) continue;
  const closed = g.length >= 4 && meters(g[0], g[g.length - 1]) <= 0.5;
  if (!closed) {
    // 線で描かれたホームは面にする（それ以外の閉じていない形は使わない）
    if (way.tags.railway !== 'platform' || lineLength(g) < MIN_LINE_PLATFORM) continue;
    const ring = lineToRing(g);
    g = [...ring, ring[0]];
    lines++;
  } else if (way.tags.railway === 'platform' && way.tags.area === 'no') continue;
  const center = {
    lat: g.reduce((a, p) => a + p.lat, 0) / g.length,
    lon: g.reduce((a, p) => a + p.lon, 0) / g.length,
  };
  const [station, distance] = nearestStation(center);
  if (distance > NEAR_STATION) continue;

  const t = way.tags;
  const kind = t.building === 'train_station' ? 0 : t.building === 'roof' ? 1 : 2;
  const layer = Math.max(0, parseInt(t.layer ?? '0', 10) || 0);
  let height = parseFloat(t.height ?? '');
  if (!Number.isFinite(height)) {
    const levels = parseFloat(t['building:levels'] ?? '');
    height = Number.isFinite(levels) ? levels * 4 : kind === 0 ? 10 : CANOPY_HEIGHT;
  }
  // 高架（layer 1 以上）の上屋は、高架の上に載せる
  if (kind !== 0) height += layer * LAYER_HEIGHT;

  const coords = [];
  let plat = 0;
  let plon = 0;
  for (const p of g.slice(0, -1)) {
    coords.push(q(p.lat) - plat, q(p.lon) - plon);
    plat = q(p.lat);
    plon = q(p.lon);
  }
  const key = tileOf(center.lat, center.lon);
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push([kind, Math.round(height * 10) / 10, station, coords]);
  // 屋根付きのホーム（covered=yes）は、同じ形の上屋も置く
  if (kind === 2 && t.covered === 'yes') tiles.get(key).push([1, Math.round(height * 10) / 10, station, coords]);
  kept++;
}

if (!partial) await rm(OUT_DIR, { recursive: true, force: true });
let bytes = 0;
for (const [key, data] of tiles) {
  const [x, y] = key.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
console.log(
  `${ways.size} ways → ${kept} roofs near stations (${lines} platforms drawn as lines), ${tiles.size} tiles, ` +
    `${(bytes / 1e6).toFixed(2)} MB`,
);
