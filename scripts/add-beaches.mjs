// 砂浜（OpenStreetMap の natural=beach）の形を取得し、地面の種類のタイル（public/landuse/15）に「砂浜」（種類 10）として書き足す。
// 地面の種類（scripts/fetch-landuse.mjs）は区画ごとに取得結果を残しているので、種類を足すと全部を取り直すことになる。
// 砂浜は少ないので、地域の範囲全体を1回で取って、できているタイルに足す（前に足した砂浜は消してから足すので、何回流してもよい）。
// 使い方: node scripts/add-beaches.mjs（fetch-landuse.mjs の後に実行。REGION=osaka で大阪）
// データ: © OpenStreetMap contributors (ODbL)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BOUNDS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT_DIR = regionPath('public/landuse/15/');
const CACHE = new URL(`../data/cache/beaches-${REGION_ID}.json`, import.meta.url);
const ZOOM = 15;
/** 砂浜の種類の番号（scripts/fetch-landuse.mjs の KIND・src/world/landuse.ts と同じ） */
const BEACH = 10;
/** これより小さい形 (m²) は使わない */
const MIN_AREA = 200;
/** 砂浜の形を入れる、まわりのタイルまでの距離 (m) */
const REACH = 150;
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(query) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (beach script)' },
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
  throw new Error('Overpass API から取得できませんでした');
}

let elements = await readFile(CACHE, 'utf8').then(JSON.parse, () => null);
if (!elements) {
  const bbox = BOUNDS.join(',');
  elements = await overpass(`[out:json][timeout:240];
    (way["natural"="beach"](${bbox}); relation["natural"="beach"](${bbox}););
    out geom;`);
  await mkdir(new URL('./', CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(elements));
}

const K = Math.PI / 180;
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
    if (len > best) ((best = len), (angle = Math.atan2(dy, dx) / K));
  }
  return Math.round((angle + 360) % 180);
};
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
/** マルチポリゴンの outer のウェイをつないで輪にする */
function joinRings(segments) {
  const rings = [];
  const left = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  while (left.length > 0) {
    let ring = left.shift();
    let grown = true;
    while (grown && !same(ring[0], ring[ring.length - 1])) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        const end = ring[ring.length - 1];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) ring = ring.concat([...s].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

const rings = [];
for (const el of elements) {
  if (el.type === 'way' && el.geometry) {
    const ring = el.geometry.map((p) => [p.lat, p.lon]);
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  } else if (el.type === 'relation') {
    const outer = (el.members ?? [])
      .filter((m) => m.role === 'outer' && m.geometry)
      .map((m) => m.geometry.map((p) => [p.lat, p.lon]));
    rings.push(...joinRings(outer));
  }
}
const beaches = rings.filter((r) => area(r) >= MIN_AREA);

const tileXY = (lat, lon) => {
  const n = 2 ** ZOOM;
  return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n)];
};
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
// タイルごとの砂浜（地面の種類の一番上に塗るので、タイルの最後に足す）
const add = new Map();
for (const ring of beaches) {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lat, lon] of ring)
    ((s = Math.min(s, lat)), (n = Math.max(n, lat)), (w = Math.min(w, lon)), (e = Math.max(e, lon)));
  // 砂浜の前の海（浅瀬の色と寄せる波、ゲームの LANDUSE.beachReach = 100m）は隣のタイルにもかかるので、まわり 150m のタイルにも入れる
  const dLat = REACH / 111320;
  const dLon = REACH / (111320 * Math.cos(s * K));
  const [x0, y1] = tileXY(s - dLat, w - dLon);
  const [x1, y0] = tileXY(n + dLat, e + dLon);
  const record = [BEACH, direction(ring), encode(ring.slice(0, -1))];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const key = `${x}/${y}`;
      if (!add.has(key)) add.set(key, []);
      add.get(key).push(record);
    }
  }
}

let written = 0;
for (const [key, records] of add) {
  const [x, y] = key.split('/');
  const file = new URL(`${x}/${y}.json`, OUT_DIR);
  const data = await readFile(file, 'utf8').then(JSON.parse, () => ({ a: [] }));
  data.a = data.a.filter(([kind]) => kind !== BEACH).concat(records);
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  await writeFile(file, JSON.stringify(data));
  written++;
}
console.log(`${beaches.length} beaches → ${written} tiles`);
