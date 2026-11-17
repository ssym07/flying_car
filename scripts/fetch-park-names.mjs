// 大きな公園の名前と位置（public/park-names.json、大阪は public/kinki/park-names.json）を作る。
// src/ui/minimap.ts が地図に、src/world/Labels.ts が 3D の空の上に名前を出す。
// 使い方: node scripts/fetch-park-names.mjs（REGION= で地域）
//
// - OpenStreetMap の leisure=park・garden・nature_reserve、tourism=zoo、名前のある敷地の形（way・relation）
//   （地面の緑を塗る public/parks には名前が無いので、名前つきで取り直す）
// - 広さが MIN_AREA ha 以上のものだけ。「児童遊園」「ちびっこ広場」「〇〇広場」などの小さな公園は、広さにかかわらず出さない
// - 名前を置く点は、形の内側で縁からいちばん遠い点（細長い・いびつな形でも公園の外に出ないように）
// - 同じ名前の形が近く（GROUP m 以内）にあれば、まとめて1つにする（広さは足し、点はいちばん広い形のもの）
// - データを取る範囲（AREAS）の中のものだけ。長方形ごとに取ってキャッシュする（範囲を足しても前の長方形は取り直さない）
//
// 出力の形式: { "p": [[名前, 緯度, 経度, 広さ (ha)], ...] }
// データ: © OpenStreetMap contributors (ODbL)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/park-names.json');
/** 取った公園のキャッシュ（長方形ごと。名前・広さ・点だけにして保存） */
const CACHE = new URL(`../data/cache/park-names-${REGION_ID}.json`, import.meta.url);
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 出す公園の広さの下限 (ha) */
const MIN_AREA = 3;
/** 同じ名前の形をまとめる距離 (m) */
const GROUP = 1000;
/** 出さない名前（小さな公園・公園の一部） */
const SKIP = /児童遊園|ちびっこ|広場$|遊園地?$|児童公園|プレイロット|ポケットパーク|緑道$|遊歩道$|駐車場|墓地|霊園/;

async function overpass(query) {
  // 混んでいても粘る（約20分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (park name script)' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240000),
        });
        if (res.ok) return (await res.json()).elements;
        console.warn(`${endpoint} → ${res.status}`);
      } catch (e) {
        console.warn(`${endpoint} → ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 60000));
  }
  throw new Error('Overpass API から取得できませんでした');
}

const K = Math.PI / 180;

/** 輪（[経度, 緯度] の並び）の広さ (m²)。lat0 の緯度で平面にする */
function ringArea(ring, lat0) {
  const cos = Math.cos(lat0 * K);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * cos * 111320 * ring[i][1] * 110950 - ring[i][0] * cos * 111320 * ring[j][1] * 110950;
  }
  return Math.abs(sum / 2);
}

/** 線（[経度, 緯度] の並び）をつないで閉じた輪にする（relation の外周は何本かの線に分かれている） */
function joinRings(lines) {
  const key = ([lon, lat]) => `${lon},${lat}`;
  const open = lines.map((l) => l.slice());
  const rings = [];
  while (open.length > 0) {
    let line = open.pop();
    for (let grown = true; grown && key(line[0]) !== key(line[line.length - 1]); ) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const other = open[i];
        const tail = key(line[line.length - 1]);
        let joined = null;
        if (key(other[0]) === tail) joined = line.concat(other.slice(1));
        else if (key(other[other.length - 1]) === tail) joined = line.concat(other.slice(0, -1).reverse());
        if (joined) {
          line = joined;
          open.splice(i, 1);
          grown = true;
          break;
        }
      }
    }
    if (line.length >= 4 && key(line[0]) === key(line[line.length - 1])) rings.push(line);
  }
  return rings;
}

/** 点が輪の中か */
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** 点から輪の縁までのいちばん近い距離 (m) */
function edgeDistance([x, y], rings, cos) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0] * cos * 111320;
      const ay = ring[j][1] * 110950;
      const bx = ring[i][0] * cos * 111320;
      const by = ring[i][1] * 110950;
      const px = x * cos * 111320;
      const py = y * 110950;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
  }
  return best;
}

/** 外周の中（穴の外）で縁からいちばん遠い点を、格子で探して細かくする */
function labelPoint(outers, inners, cos) {
  const all = [...outers, ...inners];
  const isIn = (p) => outers.some((r) => inside(p, r)) && !inners.some((r) => inside(p, r));
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of outers) for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
  let best = null;
  let bestD = -1;
  let [cx, cy, sx, sy] = [(w + e) / 2, (s + n) / 2, (e - w) / 2, (n - s) / 2];
  for (let round = 0; round < 4; round++) {
    const N = 12;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const p = [cx - sx + (2 * sx * i) / N, cy - sy + (2 * sy * j) / N];
        if (!isIn(p)) continue;
        const d = edgeDistance(p, all, cos);
        if (d > bestD) (bestD = d), (best = p);
      }
    }
    if (!best) break;
    // 見つけた点のまわりを細かく
    [cx, cy, sx, sy] = [best[0], best[1], sx / 4, sy / 4];
  }
  return best;
}

/** OSM の形 → { name, area (ha), lat, lon }。形が閉じていなければ null */
function summarize(el) {
  const name = el.tags['name:ja'] ?? el.tags.name;
  let outers;
  let inners = [];
  if (el.type === 'way') {
    const ring = (el.geometry ?? []).map((p) => [p.lon, p.lat]);
    if (ring.length < 4) return null;
    outers = [ring];
  } else {
    const lines = (role) =>
      (el.members ?? []).filter((m) => m.type === 'way' && (m.role || 'outer') === role && m.geometry).map((m) => m.geometry.map((p) => [p.lon, p.lat]));
    outers = joinRings(lines('outer'));
    inners = joinRings(lines('inner'));
  }
  if (outers.length === 0) return null;
  const lat0 = outers[0][0][1];
  const area = outers.reduce((a, r) => a + ringArea(r, lat0), 0) - inners.reduce((a, r) => a + ringArea(r, lat0), 0);
  if (area / 10000 < MIN_AREA) return { name, area: area / 10000, lat: null, lon: null };
  const p = labelPoint(outers, inners, Math.cos(lat0 * K));
  if (!p) return null;
  return { name, area: +(area / 10000).toFixed(1), lat: +p[1].toFixed(5), lon: +p[0].toFixed(5) };
}

const cache = await readFile(CACHE, 'utf8').then(JSON.parse, () => ({}));
const parks = new Map();
for (const area of AREAS) {
  const key = area.join(',');
  if (!cache[key]) {
    console.log(`取得: ${key}`);
    const list = await overpass(`[out:json][timeout:200];
      (
        wr["leisure"~"^(park|garden|nature_reserve)$"]["name"](${key});
        wr["tourism"="zoo"]["name"](${key});
      );
      out tags geom;`);
    // 広さと点だけにして残す（形そのものは大きいので保存しない）
    cache[key] = list
      .map((el) => ({ id: `${el.type}/${el.id}`, ...summarize(el) }))
      .filter((p) => p.name && p.lat !== null && p.lat !== undefined);
    await mkdir(new URL('./', CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify(cache));
  }
  // 長方形の重なりで同じ形が2回来るので、OSM の id でまとめる
  for (const p of cache[key]) parks.set(p.id, p);
}

const dist = (a, b) => Math.hypot((a.lat - b.lat) * 110950, (a.lon - b.lon) * 111320 * Math.cos(a.lat * K));
const inArea = (lat, lon) => AREAS.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e);

const clean = (raw) =>
  raw
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s*[（(][^）)]*[）)]\s*$/g, '')
    .trim();

// 広い順に並べて、同じ名前の近い形をまとめる（点はいちばん広い形のもの）
const groups = [];
let skipped = 0;
for (const p of [...parks.values()].sort((a, b) => b.area - a.area)) {
  if (!inArea(p.lat, p.lon)) continue;
  const name = clean(p.name);
  // ローマ字だけの名前（「Hiragino_Undo_Koen」）も出さない
  if (SKIP.test(name) || /^[\x00-\x7f]+$/.test(name)) {
    skipped++;
    continue;
  }
  const group = groups.find((g) => g.name === name && dist(g, p) < GROUP);
  if (group) group.area += p.area;
  else groups.push({ name, lat: p.lat, lon: p.lon, area: p.area });
}

const out = groups
  .filter((g) => g.area >= MIN_AREA)
  .map((g) => [g.name, g.lat, g.lon, Math.round(g.area)])
  .sort((a, b) => b[3] - a[3]);
await writeFile(OUT, JSON.stringify({ p: out }));
const count = (min) => out.filter((p) => p[3] >= min).length;
console.log(
  `${out.length} か所（${MIN_AREA}ha 以上。5ha 以上 ${count(5)}・30ha 以上 ${count(30)}。名前で除いたもの ${skipped}） → ${OUT}`,
);
