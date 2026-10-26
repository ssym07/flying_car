// 線路の元データ（data/osm/railways/15）に、各点の「地面からの高さ」を付けて public/rail-tracks/15 に書き出す。
// あわせて、地上の線路をまたぐ道路の橋（跨線橋）に、必要な高さの印を public/roads/15 に書き込む。
// 使い方: node scripts/build-rail-heights.mjs（fetch-railways.mjs・fetch-road-network.mjs の後に実行）
//
// 方針：
// - 高架は地面から 8m で揃える。線路どうしが立体交差する所だけ、上を通る線路を 5m 上げる
//   （並んで走る線路の高さがずれて段差にならないように）。短い橋（川をまたぐ築堤の橋など）は地上扱い
// - 地上の線路が地上の道路と交わる所は、線路を持ち上げて高架にし、道路を下に通す
// - 地上と高架の間は勾配 GRADE のスロープでつなぐ（線路のつながりをたどって高さを決める）
// - 線路が地上のまま道路の橋と交わる所は、道路の橋を線路の上 ROAD_CLEARANCE m 以上に上げる
//
// 出力の形式（1タイル）:
// { "t": [[軌間(mm), [緯度,経度,...（1e-6度、先頭以外は差分）], [各点の高さ（0.1m 単位）...]], ...],
//   "x": [[緯度, 経度（1e-6度）, 半径(m)], ...] }   // 道路と交わる所（橋脚を立てない）
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const RAW_DIR = new URL('../data/osm/railways/15/', import.meta.url);
const ROAD_DIR = new URL('../public/roads/15/', import.meta.url);
const OUT_DIR = new URL('../public/rail-tracks/15/', import.meta.url);

/** 高架の高さ (m) と、上に重なる線路の1段あたりの追加 (m) */
const VIADUCT = 8;
const STACK = 5;
/** この長さ (m) より短い橋のつながりは地上扱い（築堤の上の小さな橋） */
const MIN_VIADUCT_LENGTH = 150;
/** スロープの勾配 */
const GRADE = 0.03;
/** 跨線橋の、線路からの高さ (m) */
const ROAD_CLEARANCE = 6.5;
/** これより低い線路は「地上」とみなす (m) */
const GROUND_MAX = 3;
/** 道路の種別ごとの、中心から歩道の外までの半分の幅 (m) */
const ROAD_HALF = [11, 6, 2.5];

const K = Math.PI / 180;
const meters = (a, b) =>
  Math.hypot((b[1] - a[1]) * K * Math.cos(((a[0] + b[0]) / 2) * K), (b[0] - a[0]) * K) * 6371000;
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
const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;

async function readTiles(dir) {
  const out = [];
  for (const x of await readdir(dir)) {
    for (const f of await readdir(new URL(`${x}/`, dir))) {
      out.push({ x, y: f.replace('.json', ''), data: JSON.parse(await readFile(new URL(`${x}/${f}`, dir), 'utf8')) });
    }
  }
  return out;
}

// ---- 線路を読み、点のグラフを作る ----
const rawTiles = await readTiles(RAW_DIR);
const runs = []; // { tile, gauge, bridge, layer, pts, keys }
const nodes = new Map(); // key → { p, base, offset, edges: [[key, dist]] }
const node = (p) => {
  const k = key(p);
  if (!nodes.has(k)) nodes.set(k, { p, base: 0, offset: 0, edges: [] });
  return nodes.get(k);
};
for (const { x, y, data } of rawTiles) {
  for (const [bridge, layer, gauge, coords] of data) {
    const pts = decode(coords);
    const keys = pts.map(key);
    pts.forEach(node);
    for (let i = 1; i < pts.length; i++) {
      const d = meters(pts[i - 1], pts[i]);
      nodes.get(keys[i - 1]).edges.push([keys[i], d]);
      nodes.get(keys[i]).edges.push([keys[i - 1], d]);
    }
    runs.push({ tile: `${x}/${y}`, gauge, bridge, layer, pts, keys });
  }
}

// ---- 橋のつながりの長さ（タイルで分かれた区間も端点でつなぐ） ----
const parent = runs.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const bridgeAt = new Map();
runs.forEach((r, i) => {
  if (!r.bridge) return;
  for (const k of [r.keys[0], r.keys[r.keys.length - 1]]) {
    if (bridgeAt.has(k)) parent[find(i)] = find(bridgeAt.get(k));
    else bridgeAt.set(k, i);
  }
});
const componentLength = new Map();
runs.forEach((r, i) => {
  if (!r.bridge) return;
  let len = 0;
  for (let k = 1; k < r.pts.length; k++) len += meters(r.pts[k - 1], r.pts[k]);
  componentLength.set(find(i), (componentLength.get(find(i)) ?? 0) + len);
});

// ---- 各点の基本の高さ ----
runs.forEach((r, i) => {
  let base = 0;
  if (r.bridge && (componentLength.get(find(i)) >= MIN_VIADUCT_LENGTH || r.layer >= 2)) base = VIADUCT;
  for (const k of r.keys) nodes.get(k).base = Math.max(nodes.get(k).base, base);
});

// ---- 道路を読み、地上の線路と交わる所を探す ----
const roadTiles = await readTiles(ROAD_DIR);
const roads = []; // { cls, bridge(info or 0), pts }
for (const { data } of roadTiles) {
  for (const w of data.w) {
    // 前回の印を消してから付け直す
    if (w[5] && w[5].length > 7) w[5].length = 7;
    roads.push({ cls: w[0], bridge: w[5] || 0, pts: decode(w[3]), info: w });
  }
}
const CELL = 0.002;
const grid = new Map();
roads.forEach((road, idx) => {
  for (let j = 1; j < road.pts.length; j++) {
    const c = `${Math.floor(road.pts[j][0] / CELL)},${Math.floor(road.pts[j][1] / CELL)}`;
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push([idx, j]);
  }
});
/** 線分 p1-p2 と q1-q2 の交点のパラメータ（交わらなければ null） */
function intersect(p1, p2, q1, q2) {
  const d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0]);
  if (d === 0) return null;
  const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d;
  const u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [t, u] : null;
}
/** 線路の線分ごとに、交わる道路を探す */
function crossings(fn) {
  for (const r of runs) {
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const seen = new Set();
      for (const p of [a, b]) {
        const cy = Math.floor(p[0] / CELL);
        const cx = Math.floor(p[1] / CELL);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const [idx, j] of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
              if (seen.has(`${idx}/${j}`)) continue;
              seen.add(`${idx}/${j}`);
              const road = roads[idx];
              const hit = intersect(a, b, road.pts[j - 1], road.pts[j]);
              if (hit) fn(r, i, hit[0], road);
            }
          }
        }
      }
    }
  }
}

// 地上の線路 × 地上の道路：線路を持ち上げる（交わる線分の両端を高架の高さに）
let raised = 0;
crossings((r, i, _t, road) => {
  if (road.bridge) return;
  const a = nodes.get(r.keys[i - 1]);
  const b = nodes.get(r.keys[i]);
  if (Math.max(a.base, b.base) >= VIADUCT) return;
  a.base = b.base = VIADUCT;
  raised++;
});

// 線路どうしの立体交差：layer の大きい方を、交わる線分の両端で 5m 上げる
const railGrid = new Map();
runs.forEach((r, ri) => {
  for (let j = 1; j < r.pts.length; j++) {
    const c = `${Math.floor(r.pts[j][0] / CELL)},${Math.floor(r.pts[j][1] / CELL)}`;
    if (!railGrid.has(c)) railGrid.set(c, []);
    railGrid.get(c).push([ri, j]);
  }
});
let stacked = 0;
runs.forEach((r) => {
  for (let i = 1; i < r.pts.length; i++) {
    const cy = Math.floor(r.pts[i][0] / CELL);
    const cx = Math.floor(r.pts[i][1] / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const [oi, j] of railGrid.get(`${cy + dy},${cx + dx}`) ?? []) {
          const o = runs[oi];
          if (o.layer >= r.layer) continue;
          if (!intersect(r.pts[i - 1], r.pts[i], o.pts[j - 1], o.pts[j])) continue;
          for (const k of [r.keys[i - 1], r.keys[i]]) {
            const n = nodes.get(k);
            n.base = Math.max(n.base, VIADUCT + STACK);
          }
          stacked++;
        }
      }
    }
  }
});

// ---- スロープ：高い所から順に、つながった点へ「勾配ぶん下げた高さ」を広げる ----
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
      const rr = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
      if (rr < heap.length && heap[rr][0] > heap[m][0]) m = rr;
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
  const n = nodes.get(k);
  if (v < n.offset) continue;
  for (const [nk, d] of n.edges) {
    const m = nodes.get(nk);
    const h = v - GRADE * d;
    if (h > m.offset) {
      m.offset = h;
      push(nk, h);
    }
  }
}

// ---- 地上に残った線路 × 道路の橋：道路の橋を線路の上に上げる ----
const raiseRoad = new Map(); // 橋の両端のキー → 必要な高さ（地面から）
let overpasses = 0;
crossings((r, i, t, road) => {
  if (!road.bridge) return;
  const h = nodes.get(r.keys[i - 1]).offset * (1 - t) + nodes.get(r.keys[i]).offset * t;
  if (h > GROUND_MAX) return;
  const k = road.bridge.slice(0, 4).join(',');
  raiseRoad.set(k, Math.max(raiseRoad.get(k) ?? 0, h + ROAD_CLEARANCE));
  overpasses++;
});
for (const road of roads) {
  if (!road.bridge) continue;
  const need = raiseRoad.get(road.bridge.slice(0, 4).join(','));
  if (need) road.info[5][7] = Math.round(need * 10) / 10;
}
for (const { x, y, data } of roadTiles) {
  await writeFile(new URL(`${x}/${y}.json`, ROAD_DIR), JSON.stringify(data));
}

// ---- 橋脚を立てない所：線路が道路の上を通る交点 ----
const noPier = new Map();
crossings((r, i, t, road) => {
  const a = r.pts[i - 1];
  const b = r.pts[i];
  const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (!noPier.has(r.tile)) noPier.set(r.tile, []);
  noPier.get(r.tile).push([Math.round(p[0] * 1e6), Math.round(p[1] * 1e6), ROAD_HALF[road.cls] ?? 3]);
});

// ---- 書き出し ----
await rm(OUT_DIR, { recursive: true, force: true });
const out = new Map();
for (const r of runs) {
  if (!out.has(r.tile)) out.set(r.tile, { t: [], x: noPier.get(r.tile) ?? [] });
  out.get(r.tile).t.push([r.gauge, encode(r.pts), r.keys.map((k) => Math.round(nodes.get(k).offset * 10))]);
}
let bytes = 0;
for (const [tile, data] of out) {
  const [x, y] = tile.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}
console.log(
  `${runs.length} runs, ${nodes.size} points; raised at ${raised} level crossings; ${stacked} rail-over-rail; ` +
    `${overpasses} overpass crossings → ${raiseRoad.size} road bridges raised; ${(bytes / 1e6).toFixed(2)} MB`,
);
