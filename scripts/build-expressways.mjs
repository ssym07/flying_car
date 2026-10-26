// 高速道路の元データ（data/osm/expressways.json）に各点の「地面からの高さ」を付け、
// 地形チャンクと同じタイル（ズーム15）ごとに public/expressways/15/{x}/{y}.json に書き出す。
// 使い方: node scripts/build-expressways.mjs（fetch-expressways.mjs の後に実行）
//
// 方針：
// - 高架は地面から VIADUCT m。OSM の layer が1つ上がるごとに STACK m 上げる（ジャンクションの立体交差）
// - 短い橋（川をまたぐだけの地上区間の橋）は地上扱い
// - 掘割（cutting、または layer が負）は高さ 0（地形を削って底に置くのは描画側）
// - 地上・掘割と高架の間は勾配 GRADE の坂でつなぐ（つながりをたどって高さを決める）
// - 一般道・線路と交わる所は橋脚を立てない（x）
//
// 出力の形式（1タイル）:
// { "w": [[連絡路(0/1), 車線数, 掘割(0/1), 名前, [緯度,経度,...（1e-6度、先頭以外は差分）], [各点の高さ（0.1m）...]], ...],
//   "x": [[緯度, 経度（1e-6度）, 半径(m)], ...] }
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const RAW = new URL('../data/osm/expressways.json', import.meta.url);
const ROAD_DIR = new URL('../public/roads/15/', import.meta.url);
const RAIL_DIR = new URL('../public/rail-tracks/15/', import.meta.url);
const OUT_DIR = new URL('../public/expressways/15/', import.meta.url);

const VIADUCT = 10;
const STACK = 7;
const GRADE = 0.05;
const MIN_VIADUCT_LENGTH = 100;
const ZOOM = 15;
const ROAD_HALF = [11, 6, 2.5];

const K = Math.PI / 180;
const meters = (a, b) =>
  Math.hypot((b[1] - a[1]) * K * Math.cos(((a[0] + b[0]) / 2) * K), (b[0] - a[0]) * K) * 6371000;
const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
const tileOf = (lat, lon) => {
  const n = 2 ** ZOOM;
  return `${Math.floor(((lon + 180) / 360) * n)}/${Math.floor(((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n)}`;
};
const decode = (c) => {
  const out = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < c.length; i += 2) {
    lat += c[i];
    lon += c[i + 1];
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
};
const encode = (pts) => {
  const out = [];
  let plat = 0;
  let plon = 0;
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e6);
    const b = Math.round(lon * 1e6);
    out.push(a - plat, b - plon);
    plat = a;
    plon = b;
  }
  return out;
};

// ---- 道と点のグラフ ----
const raw = JSON.parse(await readFile(RAW, 'utf8'));
const ways = raw.map(([link, bridge, cutting, layer, lanes, name, pts]) => ({
  link,
  bridge,
  cut: cutting === 1 || (layer < 0 && !bridge),
  layer,
  lanes,
  name,
  pts,
  keys: pts.map(key),
}));
const nodes = new Map();
for (const w of ways) {
  w.pts.forEach((p, i) => {
    if (!nodes.has(w.keys[i])) nodes.set(w.keys[i], { base: 0, offset: 0, cut: false, edges: [] });
  });
  for (let i = 1; i < w.pts.length; i++) {
    const d = meters(w.pts[i - 1], w.pts[i]);
    nodes.get(w.keys[i - 1]).edges.push([w.keys[i], d]);
    nodes.get(w.keys[i]).edges.push([w.keys[i - 1], d]);
  }
}

// 橋のつながりの長さ
const parent = ways.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const bridgeAt = new Map();
ways.forEach((w, i) => {
  if (!w.bridge) return;
  for (const k of [w.keys[0], w.keys[w.keys.length - 1]]) {
    if (bridgeAt.has(k)) parent[find(i)] = find(bridgeAt.get(k));
    else bridgeAt.set(k, i);
  }
});
const compLength = new Map();
ways.forEach((w, i) => {
  if (!w.bridge) return;
  let len = 0;
  for (let k = 1; k < w.pts.length; k++) len += meters(w.pts[k - 1], w.pts[k]);
  compLength.set(find(i), (compLength.get(find(i)) ?? 0) + len);
});

for (const [i, w] of ways.entries()) {
  const elevated = w.bridge && (compLength.get(find(i)) >= MIN_VIADUCT_LENGTH || w.layer >= 2);
  const base = elevated ? VIADUCT + STACK * Math.max(0, w.layer - 1) : 0;
  for (const k of w.keys) {
    const n = nodes.get(k);
    n.base = Math.max(n.base, base);
    if (w.cut) n.cut = true;
  }
}

// 坂：高い所から、つながった点へ「勾配ぶん下げた高さ」を広げる
const heap = [];
const push = (k, v) => {
  heap.push([v, k]);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p][0] >= heap[i][0]) break;
    [heap[p], heap[i]] = [heap[i], heap[p]];
    i = p;
  }
};
const pop = () => {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
};
for (const [k, n] of nodes) {
  n.offset = n.base;
  if (n.base > 0) push(k, n.base);
}
while (heap.length > 0) {
  const [v, k] = pop();
  if (v < nodes.get(k).offset) continue;
  for (const [nk, d] of nodes.get(k).edges) {
    const m = nodes.get(nk);
    const h = v - GRADE * d;
    if (h > m.offset && !(m.cut && m.base === 0)) {
      m.offset = h;
      push(nk, h);
    }
  }
}

// ---- 一般道・線路と交わる所（橋脚を立てない） ----
async function readTiles(dir) {
  const out = [];
  for (const x of await readdir(dir).catch(() => [])) {
    for (const f of await readdir(new URL(`${x}/`, dir))) out.push(JSON.parse(await readFile(new URL(`${x}/${f}`, dir), 'utf8')));
  }
  return out;
}
const lines = []; // [[pts], 半径]
for (const t of await readTiles(ROAD_DIR)) for (const w of t.w) lines.push([decode(w[3]), ROAD_HALF[w[0]] ?? 3]);
for (const t of await readTiles(RAIL_DIR)) for (const r of t.t) lines.push([decode(r[1]), 3]);
const CELL = 0.002;
const grid = new Map();
lines.forEach(([pts], idx) => {
  for (let j = 1; j < pts.length; j++) {
    const c = `${Math.floor(pts[j][0] / CELL)},${Math.floor(pts[j][1] / CELL)}`;
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push([idx, j]);
  }
});
function intersect(p1, p2, q1, q2) {
  const d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0]);
  if (d === 0) return null;
  const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d;
  const u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0 && t < 1 && u > 0 && u < 1 ? t : null;
}
const noPier = new Map();
for (const w of ways) {
  for (let i = 1; i < w.pts.length; i++) {
    const a = w.pts[i - 1];
    const b = w.pts[i];
    const seen = new Set();
    for (const p of [a, b]) {
      const cy = Math.floor(p[0] / CELL);
      const cx = Math.floor(p[1] / CELL);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const [idx, j] of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
            if (seen.has(`${idx}/${j}`)) continue;
            seen.add(`${idx}/${j}`);
            const [pts, r] = lines[idx];
            const t = intersect(a, b, pts[j - 1], pts[j]);
            if (t === null) continue;
            const lat = a[0] + (b[0] - a[0]) * t;
            const lon = a[1] + (b[1] - a[1]) * t;
            const tile = tileOf(lat, lon);
            if (!noPier.has(tile)) noPier.set(tile, []);
            noPier.get(tile).push([Math.round(lat * 1e6), Math.round(lon * 1e6), r]);
          }
        }
      }
    }
  }
}

// ---- タイルに分けて書き出す（線分の中点が入るタイル） ----
const tiles = new Map();
const tile = (k) => {
  if (!tiles.has(k)) tiles.set(k, { w: [], x: noPier.get(k) ?? [] });
  return tiles.get(k);
};
for (const w of ways) {
  let run = null;
  const flush = () => {
    if (!run || run.idx.length < 2) return;
    tile(run.key).w.push([
      w.link,
      w.lanes,
      w.cut ? 1 : 0,
      w.name,
      encode(run.idx.map((i) => w.pts[i])),
      run.idx.map((i) => Math.round(nodes.get(w.keys[i]).offset * 10)),
    ]);
  };
  for (let k = 1; k < w.pts.length; k++) {
    const t = tileOf((w.pts[k - 1][0] + w.pts[k][0]) / 2, (w.pts[k - 1][1] + w.pts[k][1]) / 2);
    if (!run || run.key !== t) {
      flush();
      run = { key: t, idx: [k - 1] };
    }
    run.idx.push(k);
  }
  flush();
}
await rm(OUT_DIR, { recursive: true, force: true });
let bytes = 0;
for (const [k, data] of tiles) {
  const [x, y] = k.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
const elevatedPts = [...nodes.values()].filter((n) => n.offset > 3).length;
console.log(`${ways.length} ways, ${nodes.size} points (${elevatedPts} elevated) → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB`);
