// 東京23区まわりの駅の屋根（駅舎・ホームの上屋）の形を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに public/station-roofs/15/{x}/{y}.json に書き出す。
// 駅（src/data/stations.json）から一定距離以内のものだけ残す（ガソリンスタンドの屋根などを除くため）。
// 使い方: node scripts/fetch-station-roofs.mjs [南,西,北,東] [分割数]
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）: [[種類, 地面からの高さ(m), 駅の番号, [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...]
//   種類：0 = 駅舎、1 = 上屋（屋根）、2 = ホーム（床）
//   上屋・ホームの高さは仮の値。scripts/build-platforms.mjs が線路の高さに合わせて書き換える
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const partial = process.argv[2] !== undefined;
const SPLIT = Number(process.argv[3] ?? 4);
const ZOOM = 15;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT_DIR = new URL('../public/station-roofs/15/', import.meta.url);
/** 駅からこの距離 (m) 以内の屋根だけ残す */
const NEAR_STATION = 300;
/** 1層（layer）あたりの高さ (m)。高架の線路はおよそこの高さ */
const LAYER_HEIGHT = 8;
/** 上屋の、乗っている面からの高さ (m) */
const CANOPY_HEIGHT = 6;

const stations = JSON.parse(await readFile(new URL('../src/data/stations.json', import.meta.url), 'utf8'));

async function overpass(query) {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (station roof script)' },
          body: new URLSearchParams({ data: query }),
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
    const elements = await overpass(`[out:json][timeout:180];
      (
        way["building"~"^(train_station|roof)$"](${bbox});
        way["railway"="platform"]["area"!="no"](${bbox});
      );
      out tags geom qt;`);
    for (const el of elements) ways.set(el.id, el);
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${ways.size} ways`);
  }
}

const tiles = new Map();
const q = (v) => Math.round(v * 1e6);
let kept = 0;
for (const way of ways.values()) {
  const g = way.geometry;
  // 閉じた形だけ（ホームが線で描かれているものは除く）
  if (!g || g.length < 4 || meters(g[0], g[g.length - 1]) > 0.5) continue;
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
console.log(`${ways.size} ways → ${kept} roofs near stations, ${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB`);
