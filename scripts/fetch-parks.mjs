// 東京23区まわりの公園・緑地の形と、その中の園路を OpenStreetMap (Overpass API) から取得し、
// 地形チャンクと同じタイル（ズーム15）ごとに public/parks/15/{x}/{y}.json に書き出す。
// 形はタイルにかかるもの全部を入れる（タイルごとに芝生の画像を作るため）。
// 使い方: node scripts/fetch-parks.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/parks に保存し、途中で止まっても次はその続きから取得する
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）:
// { "a": [[種類, [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...],   // 種類 0=公園・庭園 1=林 2=グラウンド
//   "p": [[幅(m), [緯度,経度,...]], ...] }                                // 公園の中の園路
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const [SOUTH, WEST, NORTH, EAST] = (process.argv[2] ?? '35.52,139.56,35.82,139.92').split(',').map(Number);
const partial = process.argv[2] !== undefined;
const SPLIT = Number(process.argv[3] ?? 8);
const ZOOM = 15;
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OUT_DIR = new URL('../public/parks/15/', import.meta.url);
/** 取得済みの区画を保存しておく場所（通信が切れても、次に流した時はそこから続ける） */
const CACHE_DIR = new URL('../data/cache/parks/', import.meta.url);
/** 園路の種類ごとの幅 (m) */
const PATH_WIDTH = { pedestrian: 5, track: 3, footway: 2.5, path: 2, steps: 2.5, cycleway: 2.5 };
/** これより小さい公園 (m²) は描かない（道路脇の植え込みなど） */
const MIN_AREA = 150;

async function overpass(query) {
  // 通信が不安定でも粘る（約10分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (park script)' },
          body: new URLSearchParams({ data: query }),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
  throw new Error('Overpass API から取得できませんでした（もう一度流せば、取得済みの区画の続きから再開します）');
}

const K = Math.PI / 180;
const tileXY = (lat, lon) => {
  const n = 2 ** ZOOM;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n)];
};
/** 多角形の面積 (m²) */
const area = (ring) => {
  let s = 0;
  const c = Math.cos(ring[0][0] * K);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][1] * c * 111320) * (ring[i][0] * 111320) - (ring[i][1] * c * 111320) * (ring[j][0] * 111320);
  }
  return Math.abs(s / 2);
};
const inside = (lat, lon, ring) => {
  let ok = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ay, ax] = ring[i];
    const [by, bx] = ring[j];
    if (ay > lat !== by > lat && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) ok = !ok;
  }
  return ok;
};
/** マルチポリゴンの outer のウェイをつないで輪にする */
function joinRings(segments) {
  const rings = [];
  const left = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  while (left.length > 0) {
    let ring = left.shift();
    let grown = true;
    while (grown && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        const end = ring[ring.length - 1];
        const same = (a, b) => a[0] === b[0] && a[1] === b[1];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) ring = ring.concat([...s].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

const areas = new Map(); // id → { kind, ring }
const paths = new Map(); // id → { width, line }
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
        way["leisure"~"^(park|garden)$"](${bbox});
        way["natural"="wood"](${bbox});
        way["landuse"="forest"](${bbox});
        way["leisure"="pitch"](${bbox});
      );
      out tags geom qt;
      way["highway"~"^(${Object.keys(PATH_WIDTH).join('|')})$"]["area"!="yes"](${bbox});
      out tags geom qt;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(elements));
    }
    for (const el of elements) {
      // マルチポリゴン（大きな公園）は下でまとめて取る（ここでは形が付いていない）
      if (el.type === 'relation') continue;
      const t = el.tags ?? {};
      if (t.highway) {
        if (el.geometry) paths.set(el.id, { width: PATH_WIDTH[t.highway] ?? 2, line: el.geometry.map((p) => [p.lat, p.lon]) });
        continue;
      }
      const kind = t.leisure === 'pitch' ? 2 : t.natural === 'wood' || t.landuse === 'forest' ? 1 : 0;
      const rings =
        el.type === 'way'
          ? el.geometry
            ? [el.geometry.map((p) => [p.lat, p.lon])]
            : []
          : joinRings(
              (el.members ?? [])
                .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry)
                .map((m) => m.geometry.map((p) => [p.lat, p.lon])),
            );
      rings.forEach((ring, k) => {
        if (area(ring) >= MIN_AREA) areas.set(`${el.type}${el.id}/${k}`, { kind, ring });
      });
    }
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${areas.size} areas, ${paths.size} paths`);
  }
}

// 大きな公園・林（マルチポリゴン）。形を組み立てるには members の形が要るので out body geom で取る
{
  const half = (a, b) => [a, (a + b) / 2, b];
  const lats = half(SOUTH, NORTH);
  const lons = half(WEST, EAST);
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const bbox = `${lats[j]},${lons[i]},${lats[j + 1]},${lons[i + 1]}`;
      const cacheFile = new URL(`relations-${bbox}.json`, CACHE_DIR);
      let elements = await readFile(cacheFile, 'utf8').then(JSON.parse, () => null);
      if (!elements) {
        elements = await overpass(`[out:json][timeout:180];
          (
            relation["leisure"~"^(park|garden)$"]["type"="multipolygon"](${bbox});
            relation["landuse"="forest"]["type"="multipolygon"](${bbox});
            relation["natural"="wood"]["type"="multipolygon"](${bbox});
          );
          out body geom qt;`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(elements));
      }
      for (const el of elements) {
        const t = el.tags ?? {};
        const kind = t.natural === 'wood' || t.landuse === 'forest' ? 1 : 0;
        const rings = joinRings(
          (el.members ?? [])
            .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry)
            .map((m) => m.geometry.map((p) => [p.lat, p.lon])),
        );
        rings.forEach((ring, k) => {
          if (area(ring) >= MIN_AREA) areas.set(`relation${el.id}/${k}`, { kind, ring });
        });
      }
      console.log(`relations ${i * 2 + j + 1}/4: ${areas.size} areas`);
    }
  }
}

// 公園・林の中を通る園路だけ残す（歩道などを除く）
const CELL = 0.005;
const grid = new Map();
for (const a of areas.values()) {
  if (a.kind === 2) continue;
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lon] of a.ring) (s = Math.min(s, lat)), (n = Math.max(n, lat)), (w = Math.min(w, lon)), (e = Math.max(e, lon));
  a.box = [s, w, n, e];
  for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
    for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) {
      const k = `${y},${x}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(a);
    }
  }
}
const inPark = (lat, lon) =>
  (grid.get(`${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`) ?? []).some(
    (a) => lat >= a.box[0] && lat <= a.box[2] && lon >= a.box[1] && lon <= a.box[3] && inside(lat, lon, a.ring),
  );
const parkPaths = [...paths.values()].filter(({ line }) => {
  let hits = 0;
  for (let i = 0; i < line.length; i++) if (inPark(line[i][0], line[i][1])) hits++;
  return hits * 2 >= line.length;
});

// タイルにかかるものを全部そのタイルに入れる
const tiles = new Map();
const q = (v) => Math.round(v * 1e6);
const encode = (pts) => {
  const out = [];
  let plat = 0;
  let plon = 0;
  for (const [lat, lon] of pts) {
    out.push(q(lat) - plat, q(lon) - plon);
    plat = q(lat);
    plon = q(lon);
  }
  return out;
};
const addTo = (pts, field, record) => {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lon] of pts) (s = Math.min(s, lat)), (n = Math.max(n, lat)), (w = Math.min(w, lon)), (e = Math.max(e, lon));
  const [x0, y1] = tileXY(s, w);
  const [x1, y0] = tileXY(n, e);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const key = `${x}/${y}`;
      if (!tiles.has(key)) tiles.set(key, { a: [], p: [] });
      tiles.get(key)[field].push(record);
    }
  }
};
for (const a of areas.values()) addTo(a.ring, 'a', [a.kind, encode(a.ring.slice(0, -1))]);
for (const p of parkPaths) addTo(p.line, 'p', [p.width, encode(p.line)]);

if (!partial) await rm(OUT_DIR, { recursive: true, force: true });
let bytes = 0;
for (const [key, data] of tiles) {
  const [x, y] = key.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
console.log(`${areas.size} areas, ${parkPaths.length}/${paths.size} paths in parks → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB`);
