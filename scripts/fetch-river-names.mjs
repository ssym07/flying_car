// 地図（ミニマップ）に川の名前を書くための、名前のある川の線（public/rivers.json、大阪は public/kinki/rivers.json）を作る。
// src/ui/minimap.ts が線に沿って名前を書く（線そのものは描かない。川の形は国土地理院の地図の水面で見える）。
// 使い方: node scripts/fetch-river-names.mjs（REGION= で地域）
//
// - OpenStreetMap の waterway=river・canal で名前のあるもの（国土地理院の地図の注記には川の名前がほとんど無い）
// - 同じ名前の道（OSM の way）は端どうしをつないで長い線にする（名前を書く場所が増える）
// - データを取る範囲（AREAS、少し広げる）の中の部分だけ。点は SIMPLIFY m で間引く
//
// 出力の形式: { "r": [[名前, [経度, 緯度, 経度, 緯度, ...]], ...] }（座標は 1e-5 度に丸める）
// データ: © OpenStreetMap contributors (ODbL)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AREAS, BOUNDS, REGION_ID, regionPath } from './lib/region.mjs';

const OUT = regionPath('public/rivers.json');
/** 取った線のキャッシュ（範囲を広げたら消す） */
const CACHE = new URL(`../data/cache/rivers-${REGION_ID}.json`, import.meta.url);
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** 範囲を広げる量（度）：端で名前が切れないように */
const MARGIN = 0.02;
/** 線を間引く許容のずれ (m) */
const SIMPLIFY = 15;

async function overpass(query) {
  // 混んでいても粘る（約20分）
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'sky-drive-dev/0.1 (river script)' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(300000),
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

let elements = await readFile(CACHE, 'utf8').then(JSON.parse, () => null);
if (!elements) {
  elements = await overpass(`[out:json][timeout:280];
    way["waterway"~"^(river|canal)$"]["name"](${BOUNDS.join(',')});
    out tags geom;`);
  await mkdir(new URL('./', CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(elements));
}

const inArea = ([lon, lat]) =>
  AREAS.some(([s, w, n, e]) => lat >= s - MARGIN && lat <= n + MARGIN && lon >= w - MARGIN && lon <= e + MARGIN);

// 範囲の中の部分（続いている点の並び）に切る
const pieces = [];
for (const way of elements) {
  const name = way.tags['name:ja'] ?? way.tags.name;
  let run = [];
  const flush = () => {
    if (run.length >= 2) pieces.push({ name, points: run });
    run = [];
  };
  for (const { lat, lon } of way.geometry ?? []) {
    if (inArea([lon, lat])) run.push([lon, lat]);
    else flush();
  }
  flush();
}

// 同じ名前で端がつながる線をつなぐ（向きが逆なら裏返す）
const key = ([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`;
const byName = new Map();
for (const piece of pieces) {
  if (!byName.has(piece.name)) byName.set(piece.name, []);
  byName.get(piece.name).push(piece.points);
}
const lines = [];
for (const [name, list] of byName) {
  const open = list.map((points) => points.slice());
  while (open.length > 0) {
    let line = open.pop();
    for (let grown = true; grown; ) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const other = open[i];
        const [head, tail] = [key(line[0]), key(line[line.length - 1])];
        let joined = null;
        if (key(other[0]) === tail) joined = line.concat(other.slice(1));
        else if (key(other[other.length - 1]) === tail) joined = line.concat(other.slice(0, -1).reverse());
        else if (key(other[other.length - 1]) === head) joined = other.concat(line.slice(1));
        else if (key(other[0]) === head) joined = other.slice().reverse().concat(line.slice(1));
        if (joined) {
          line = joined;
          open.splice(i, 1);
          grown = true;
          break;
        }
      }
    }
    lines.push([name, line]);
  }
}

// 間引く（ダグラス・ポーカー）
const K = Math.PI / 180;
function simplify(points) {
  if (points.length <= 2) return points;
  const cos = Math.cos(points[0][1] * K);
  const xy = points.map(([lon, lat]) => [lon * 111320 * cos, lat * 110950]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1;
    let worstD = SIMPLIFY;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / len;
      if (d > worstD) (worst = i), (worstD = d);
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const out = lines
  .map(([name, points]) => [name, simplify(points).flatMap(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)])])
  .filter(([, flat]) => flat.length >= 4)
  .sort((a, b) => a[0].localeCompare(b[0], 'ja'));
await writeFile(OUT, JSON.stringify({ r: out }));
const size = JSON.stringify({ r: out }).length;
console.log(`${new Set(out.map((l) => l[0])).size} 本の川（線 ${out.length} 本、${(size / 1e6).toFixed(2)} MB） → ${OUT}`);
