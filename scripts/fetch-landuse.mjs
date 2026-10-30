// 東京23区と横浜市・川崎市まわりの「道路・公園・水以外の地面」の種類（駐車場・線路の敷地・墓地・寺社・学校・工事現場・工場・草地・畑・広場）の形を
// OpenStreetMap (Overpass API) から取得し、地形チャンクと同じタイル（ズーム15）ごとに public/landuse/15/{x}/{y}.json に書き出す。
// ゲームは地形チャンクごとにこの形で「地面の種類」の画像を作り、種類ごとのテンプレート（アスファルトと白線・砂利など）で塗る。
// 形はタイルにかかるもの全部を入れる（タイルごとに画像を作るため）。
// 使い方: node scripts/fetch-landuse.mjs [南,西,北,東] [分割数]
//   取得した区画は data/cache/landuse に保存し、途中で止まっても次はその続きから取得する
// データ: © OpenStreetMap contributors (ODbL)
//
// 出力の形式（1タイル）: { "a": [[種類, 向き(度, 0〜179), [緯度,経度,...（1e-6度、先頭以外は前の点との差）]], ...] }
//   種類は KIND（src/core/config.ts の LANDUSE と同じ番号）。向きは一番長い辺の向き（駐車場の白線をそろえるのに使う）
//   重なった時に上に塗るものほど後ろに並べる（PRIORITY）
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { snapBbox, tileInBbox } from './lib/tiles.mjs';
import { AREAS, regionPath } from './lib/region.mjs';

// 範囲に '-' を渡すと、範囲を省いた時と同じ（地域の最初の範囲を丸ごと作り直す。分割数だけ変えたい時用）
const bboxArg = process.argv[2] === '-' ? undefined : process.argv[2];
const partial = bboxArg !== undefined;
// 範囲を指定した時は、タイルの境目まで外へ広げ、範囲の中に丸ごと入るタイルだけを書き出す（まわりのタイルは触らない）
const [SOUTH, WEST, NORTH, EAST] = ((b) => (partial ? snapBbox(b, 15) : b))(
  (bboxArg ?? AREAS[0].join(',')).split(',').map(Number),
);
const SPLIT = Number(process.argv[3] ?? 12);
const ZOOM = 15;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OUT_DIR = regionPath('public/landuse/15/');
/** 取得済みの区画を保存しておく場所（通信が切れても、次に流した時はそこから続ける） */
const CACHE_DIR = new URL('../data/cache/landuse/', import.meta.url);
/** これより小さい形 (m²) は使わない */
const MIN_AREA = 50;

/** 地面の種類の番号（src/core/config.ts の LANDUSE.kinds と同じ並び） */
const KIND = {
  parking: 0,
  railway: 1,
  cemetery: 2,
  religious: 3,
  school: 4,
  construction: 5,
  industrial: 6,
  grass: 7,
  farmland: 8,
  paved: 9,
  // 10 は砂浜（scripts/add-beaches.mjs が後から足す）
};
/** 重なった時の塗る順（後ろほど上）。広く大まかなもの → 狭く細かいもの */
const PRIORITY = [
  KIND.industrial,
  KIND.paved,
  KIND.religious,
  KIND.school,
  KIND.grass,
  KIND.farmland,
  KIND.cemetery,
  KIND.construction,
  KIND.railway,
  KIND.parking,
];
/** 印 → 種類 */
function kindOf(t) {
  if (t.amenity === 'parking') return ['multi-storey', 'underground', 'rooftop'].includes(t.parking) ? null : KIND.parking;
  if (t.landuse === 'railway') return KIND.railway;
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return KIND.cemetery;
  if (t.landuse === 'religious' || t.amenity === 'place_of_worship') return KIND.religious;
  if (['school', 'university', 'college', 'kindergarten'].includes(t.amenity)) return KIND.school;
  if (['construction', 'brownfield', 'greenfield'].includes(t.landuse)) return KIND.construction;
  if (['industrial', 'port', 'garages'].includes(t.landuse)) return KIND.industrial;
  if (['grass', 'meadow', 'village_green', 'recreation_ground'].includes(t.landuse)) return KIND.grass;
  if (['grassland', 'scrub', 'heath'].includes(t.natural)) return KIND.grass;
  if (['farmland', 'allotments'].includes(t.landuse)) return KIND.farmland;
  if (['commercial', 'retail'].includes(t.landuse) || t.place === 'square') return KIND.paved;
  if (t.highway === 'pedestrian' && t.area === 'yes') return KIND.paved;
  return null;
}
const SELECTORS = [
  '["amenity"="parking"]',
  '["landuse"~"^(railway|cemetery|religious|construction|brownfield|greenfield|industrial|port|garages|grass|meadow|village_green|recreation_ground|farmland|allotments|commercial|retail)$"]',
  '["amenity"~"^(grave_yard|place_of_worship|school|university|college|kindergarten)$"]',
  '["natural"~"^(grassland|scrub|heath)$"]',
  '["place"="square"]',
  '["highway"="pedestrian"]["area"="yes"]',
];

async function overpass(query) {
  // 通信が不安定・サーバーが混んでいても粘る（約20分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (landuse script)' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240000),
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
    s += ring[j][1] * c * 111320 * (ring[i][0] * 111320) - ring[i][1] * c * 111320 * (ring[j][0] * 111320);
  }
  return Math.abs(s / 2);
};
/** 一番長い辺の向き（度, 0〜179。東が 0、北へ回る） */
const direction = (ring) => {
  const c = Math.cos(ring[0][0] * K);
  let best = 0;
  let angle = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = (ring[i][1] - ring[i - 1][1]) * c;
    const dy = ring[i][0] - ring[i - 1][0];
    const len = Math.hypot(dx, dy);
    if (len > best) {
      best = len;
      angle = Math.atan2(dy, dx) / K;
    }
  }
  return Math.round((angle + 360) % 180);
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
const addRings = (id, kind, rings) => {
  rings.forEach((ring, k) => {
    if (ring.length >= 4 && area(ring) >= MIN_AREA) areas.set(`${id}/${k}`, { kind, ring });
  });
};
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
        ${SELECTORS.map((sel) => `way${sel}(${bbox});`).join('\n        ')}
      );
      out tags geom qt;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(elements));
    }
    for (const el of elements) {
      const kind = kindOf(el.tags ?? {});
      if (kind === null || el.type !== 'way' || !el.geometry) continue;
      addRings(`way${el.id}`, kind, [el.geometry.map((p) => [p.lat, p.lon])]);
    }
    console.log(`part ${i * SPLIT + j + 1}/${SPLIT * SPLIT}: ${areas.size} areas`);
  }
}

// 大きなもの（マルチポリゴン）。形を組み立てるには members の形が要るので out body geom で取る
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
            ${SELECTORS.map((sel) => `relation${sel}["type"="multipolygon"](${bbox});`).join('\n            ')}
          );
          out body geom qt;`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(elements));
      }
      for (const el of elements) {
        const kind = kindOf(el.tags ?? {});
        if (kind === null) continue;
        const rings = joinRings(
          (el.members ?? [])
            .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry)
            .map((m) => m.geometry.map((p) => [p.lat, p.lon])),
        );
        addRings(`relation${el.id}`, kind, rings);
      }
      console.log(`relations ${i * 2 + j + 1}/4: ${areas.size} areas`);
    }
  }
}

// タイルにかかるものを全部そのタイルに入れる（塗る順に並べる）
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
const sorted = [...areas.values()].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || area(b.ring) - area(a.ring));
const counts = {};
for (const a of sorted) {
  counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lat, lon] of a.ring) (s = Math.min(s, lat)), (n = Math.max(n, lat)), (w = Math.min(w, lon)), (e = Math.max(e, lon));
  const [x0, y1] = tileXY(s, w);
  const [x1, y0] = tileXY(n, e);
  const record = [a.kind, direction(a.ring), encode(a.ring.slice(0, -1))];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const key = `${x}/${y}`;
      if (!tiles.has(key)) tiles.set(key, { a: [] });
      tiles.get(key).a.push(record);
    }
  }
}

if (!partial) await rm(OUT_DIR, { recursive: true, force: true });
let bytes = 0;
for (const [key, data] of tiles) {
  if (partial && !tileInBbox(key, [SOUTH, WEST, NORTH, EAST], ZOOM)) continue;
  const [x, y] = key.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
const names = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
console.log(
  `${areas.size} areas (${Object.entries(counts)
    .map(([k, c]) => `${names[k]} ${c}`)
    .join(', ')}) → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB`,
);
