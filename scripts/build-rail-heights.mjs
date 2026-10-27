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
// - 掘割（layer が負でトンネルでない）の線路は高さ 0 のまま（地形を削って底に置くのは描画側）。道路は上を通す
// - 駅（ホーム = public/station-roofs の種類 2）：ホームに面した線路をホームごとにまとめて1つの駅とし、
//   駅の中は1つの高さで水平にする（面した線路の基本の高さで多いもの）。駅の外へは勾配 GRADE の坂でつなぐ。
//   描画側が線路とホームで同じ地面を基準にできるよう、駅ごとの基準点を書き出す（駅の外 STATION_BLEND m で地形に戻す）
//
// 出力の形式（1タイル）:
// { "t": [[軌間(mm), [緯度,経度,...（1e-6度、先頭以外は差分）], [各点の高さ（0.1m 単位）...], 掘割(0/1),
//          [各点の駅（s の番号、駅の外は -1）...], [各点の駅の地面に合わせる割合（0〜10）...]], ...],  // 駅の2つは駅の近くの線路だけ
//   "x": [[緯度, 経度（1e-6度）, 半径(m)], ...],   // 道路と交わる所（橋脚を立てない）
//   "s": [[基準点の緯度, 経度（1e-6度）, 掘割(0/1)], ...] }   // 駅の地面の基準点
// あわせて data/stations/structure.json に、駅ごとのホーム・高さ・基準点を書き出す（scripts/build-platforms.mjs が使う）
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const RAW_DIR = new URL('../data/osm/railways/15/', import.meta.url);
const ROAD_DIR = new URL('../public/roads/15/', import.meta.url);
const ROOF_DIR = new URL('../public/station-roofs/15/', import.meta.url);
const OUT_DIR = new URL('../public/rail-tracks/15/', import.meta.url);
const STRUCTURE = new URL('../data/stations/structure.json', import.meta.url);

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
/** ホームの縁からこの距離 (m) 以内の線路を、そのホームに面した線路とする */
const PLATFORM_NEAR = 3.5;
/** ホームからこの距離 (m) 以内の、駅と同じ高さの線路（ホームの無い通過線）も駅の中として平らにする */
const STATION_AREA = 8;
/** 同じ駅のホームどうしがこの距離 (m) 以内なら、間に通過線があっても1つの駅にまとめる */
const PLATFORM_JOIN = 12;
/** 駅の外へ、この距離 (m) かけて線路の地面を駅の基準から地形に戻す */
const STATION_BLEND = 60;
/** ホームの近くの線路は、この間隔 (m) で点を補う（ホームの端で高さを切り替えられるように） */
const DENSIFY = 10;

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

// ---- 駅のホームを読む ----
// 平面の座標 (m)。23区の範囲なら経度方向の縮みは一定とみてよい
const MX = 111320 * Math.cos(35.68 * K);
const MY = 111320;
const xy = (p) => [p[1] * MX, p[0] * MY];
/** 点 p から線分 a-b までの距離 (m)（平面の座標で） */
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
/** 点 p（緯度経度）からホームまでの距離 (m)。中なら 0 */
function platformDistance(p, platform) {
  const q = xy(p);
  const ring = platform.xy;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    best = Math.min(best, segmentDistance(q, a, b));
  }
  return inside ? 0 : best;
}
const platforms = []; // { id: 'x/y#番号', station, ring, xy }
for (const { x, y, data } of await readTiles(ROOF_DIR)) {
  data.forEach(([kind, , station, coords], i) => {
    if (kind !== 2) return;
    const ring = decode(coords);
    platforms.push({ id: `${x}/${y}#${i}`, station, ring, xy: ring.map(xy) });
  });
}
// ホームを探しやすくする格子（ホームのまわり 60m までのマスに入れる）
const P_CELL = 0.001;
const platformGrid = new Map();
platforms.forEach((pl, i) => {
  const lats = pl.ring.map((p) => p[0]);
  const lons = pl.ring.map((p) => p[1]);
  const m = 60 / MY;
  for (let cy = Math.floor((Math.min(...lats) - m) / P_CELL); cy <= Math.floor((Math.max(...lats) + m) / P_CELL); cy++) {
    for (let cx = Math.floor((Math.min(...lons) - m) / P_CELL); cx <= Math.floor((Math.max(...lons) + m) / P_CELL); cx++) {
      const c = `${cy},${cx}`;
      if (!platformGrid.has(c)) platformGrid.set(c, []);
      platformGrid.get(c).push(i);
    }
  }
});
/** 点 p（緯度経度）のまわり 60m 以内にありそうなホームの番号 */
const platformsAround = (p) => platformGrid.get(`${Math.floor(p[0] / P_CELL)},${Math.floor(p[1] / P_CELL)}`) ?? [];

/** ホームの近くを通る区間に、DENSIFY m ごとの点を補う */
function densify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.ceil(meters(a, b) / DENSIFY);
    let near = false;
    for (let k = 0; k <= n && !near; k++) {
      const t = k / n;
      near = platformsAround([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]).length > 0;
    }
    if (near) {
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([+(a[0] + (b[0] - a[0]) * t).toFixed(6), +(a[1] + (b[1] - a[1]) * t).toFixed(6)]);
      }
    }
    out.push(b);
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
    const pts = densify(decode(coords));
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
  if (road.bridge || r.layer < 0) return;
  const a = nodes.get(r.keys[i - 1]);
  const b = nodes.get(r.keys[i]);
  if (Math.max(a.base, b.base) >= VIADUCT) return;
  a.base = b.base = VIADUCT;
  raised++;
});

// 線路どうしの立体交差：layer の大きい方（橋のもの）を、交わる線分の両端で 5m 上げる
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
  // 橋の印の無い線路は、layer が大きくても上に重ねない（印が地上の線路にも付いていることがある）
  if (!r.bridge) return;
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
/** 各点の高さ offset を決める（駅の中 fixed はその高さのまま）。掘割の線路は 0 */
function slopes() {
  for (const [k, n] of nodes) {
    n.offset = n.fixed ?? n.base;
    if (n.offset > 0) push(k, n.offset);
  }
  while (heap.length > 0) {
    const [v, k] = pop();
    const n = nodes.get(k);
    if (v < n.offset) continue;
    for (const [nk, d] of n.edges) {
      const m = nodes.get(nk);
      // 駅の中は駅の高さのまま
      if (m.fixed !== undefined) continue;
      const h = v - GRADE * d;
      if (h > m.offset) {
        m.offset = h;
        push(nk, h);
      }
    }
  }
  // 掘割の線路は持ち上げない（スロープで隣から高さが伝わっても 0 に戻す）
  for (const r of runs) if (r.layer < 0) for (const k of r.keys) if (nodes.get(k).fixed === undefined) nodes.get(k).offset = 0;
}

// 駅を考えずに一度決める（駅の高さを決めるのに使う）
slopes();

// ---- 駅：ホームに面した線路をまとめ、駅の中を1つの高さにする ----
for (const r of runs) {
  if (r.layer < 0 && !r.bridge) for (const k of r.keys) nodes.get(k).cut = true;
}
// 各ホームに面した線路の点
const facing = platforms.map(() => []);
const platformsOf = new Map(); // 点 → 面しているホームの番号
for (const [k, n] of nodes) {
  for (const pi of platformsAround(n.p)) {
    if (platformDistance(n.p, platforms[pi]) > PLATFORM_NEAR) continue;
    facing[pi].push(k);
    if (!platformsOf.has(k)) platformsOf.set(k, []);
    platformsOf.get(k).push(pi);
  }
}
// 同じ線路の点に面したホームどうし・同じ駅の近いホームどうしを1つの駅にまとめる
const pParent = platforms.map((_, i) => i);
const pFind = (i) => (pParent[i] === i ? i : (pParent[i] = pFind(pParent[i])));
for (const list of platformsOf.values()) for (const pi of list) pParent[pFind(pi)] = pFind(list[0]);
platforms.forEach((a, i) => {
  if (facing[i].length === 0) return;
  for (const j of platformsAround(a.ring[0])) {
    const b = platforms[j];
    if (j <= i || facing[j].length === 0 || b.station !== a.station) continue;
    if (Math.min(...b.ring.map((p) => platformDistance(p, a))) <= PLATFORM_JOIN) pParent[pFind(j)] = pFind(i);
  }
});
const groups = new Map(); // 代表のホーム → { platforms, nodes }
platforms.forEach((_, i) => {
  if (facing[i].length === 0) return;
  const g = pFind(i);
  if (!groups.has(g)) groups.set(g, { platforms: [], nodes: new Set() });
  groups.get(g).platforms.push(i);
  for (const k of facing[i]) groups.get(g).nodes.add(k);
});
const stations = [];
for (const g of groups.values()) {
  // 駅の高さ：駅を考えずに決めた、面した線路の点の高さの中央値
  // （築堤の上の駅は橋の印が無いので、基本の高さではなく、道路をまたぐために持ち上げた後の高さで決める）
  const heights = [...g.nodes].map((k) => nodes.get(k).offset).sort((a, b) => a - b);
  const level = Math.round(heights[Math.floor(heights.length / 2)] * 10) / 10;
  const cut = [...g.nodes].filter((k) => nodes.get(k).cut).length;
  // 基準点：ホームの頂点の平均
  const all = g.platforms.flatMap((i) => platforms[i].ring);
  const ref = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
  stations.push({ ...g, level, cut: cut * 2 > g.nodes.size, ref });
}
// ホームの近くを通る、駅と同じ高さの線路（通過線）も駅に入れる
stations.forEach((st, si) => {
  for (const pi of st.platforms) {
    for (const [k, n] of nodes) {
      if (n.station !== undefined || Math.abs(n.offset - st.level) > 0.5 || st.nodes.has(k)) continue;
      if (Math.abs(n.p[0] - platforms[pi].ring[0][0]) > 0.003 || Math.abs(n.p[1] - platforms[pi].ring[0][1]) > 0.004) continue;
      if (platformDistance(n.p, platforms[pi]) <= STATION_AREA && !platformsOf.has(k)) st.nodes.add(k);
    }
  }
  for (const k of st.nodes) {
    const n = nodes.get(k);
    if (n.station !== undefined) continue;
    n.station = si;
    n.fixed = st.level;
  }
});

/** 決まった値から始めて、つながった点へ「距離 × perMeter」を足しながら広げる（小さい方を残す）。limit を超えたら止める */
function spread(sources, perMeter, limit = Infinity) {
  const best = new Map(); // 点 → [値, 元の駅]
  const queue = [];
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (queue[p][0] <= queue[i][0]) break;
      [queue[p], queue[i]] = [queue[i], queue[p]];
      i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = i * 2 + 1;
      let m = i;
      if (l < queue.length && queue[l][0] < queue[m][0]) m = l;
      if (l + 1 < queue.length && queue[l + 1][0] < queue[m][0]) m = l + 1;
      if (m === i) return;
      [queue[m], queue[i]] = [queue[i], queue[m]];
      i = m;
    }
  };
  const add = (v, k, tag) => {
    if (v > limit || (best.has(k) && best.get(k)[0] <= v)) return;
    best.set(k, [v, tag]);
    queue.push([v, k, tag]);
    up(queue.length - 1);
  };
  for (const [k, v, tag] of sources) add(v, k, tag);
  while (queue.length > 0) {
    const [v, k, tag] = queue[0];
    const last = queue.pop();
    if (queue.length > 0) {
      queue[0] = last;
      down(0);
    }
    if (best.get(k)[0] < v) continue;
    for (const [nk, d] of nodes.get(k).edges) add(v + perMeter * d, nk, tag);
  }
  return best;
}

// 駅の中を平らにして決め直す
slopes();
// 駅より低い所へは、駅から坂で下りる（駅の高さ + 勾配ぶんより高くしない）
const ceiling = spread(
  [...nodes].filter(([, n]) => n.fixed !== undefined).map(([k, n]) => [k, n.fixed, n.station]),
  GRADE,
);
for (const [k, n] of nodes) {
  if (n.fixed === undefined && ceiling.has(k)) n.offset = Math.min(n.offset, ceiling.get(k)[0]);
}

// 駅の地面の基準に合わせる割合：駅の中は 1、駅の外へ STATION_BLEND m で 0 に
const blend = spread(
  [...nodes].filter(([, n]) => n.station !== undefined).map(([k, n]) => [k, 0, n.station]),
  1,
  STATION_BLEND,
);

// ---- 地上に残った線路 × 道路の橋：道路の橋を線路の上に上げる ----
const raiseRoad = new Map(); // 橋の両端のキー → 必要な高さ（地面から）
let overpasses = 0;
crossings((r, i, t, road) => {
  if (!road.bridge || r.layer < 0) return;
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
const refIndex = new Map(); // タイル → (駅 → s の番号)
for (const r of runs) {
  if (!out.has(r.tile)) out.set(r.tile, { t: [], x: noPier.get(r.tile) ?? [], s: [] });
  const tile = out.get(r.tile);
  const track = [
    r.gauge,
    encode(r.pts),
    r.keys.map((k) => Math.round(nodes.get(k).offset * 10)),
    r.layer < 0 && !r.bridge ? 1 : 0,
  ];
  if (r.keys.some((k) => blend.has(k))) {
    if (!refIndex.has(r.tile)) refIndex.set(r.tile, new Map());
    const refs = refIndex.get(r.tile);
    const index = (si) => {
      if (!refs.has(si)) {
        const st = stations[si];
        refs.set(si, tile.s.length);
        tile.s.push([Math.round(st.ref[0] * 1e6), Math.round(st.ref[1] * 1e6), st.cut ? 1 : 0]);
      }
      return refs.get(si);
    };
    track.push(
      r.keys.map((k) => (blend.has(k) ? index(blend.get(k)[1]) : -1)),
      r.keys.map((k) => (blend.has(k) ? Math.round(10 * (1 - blend.get(k)[0] / STATION_BLEND)) : 0)),
    );
  }
  tile.t.push(track);
}
for (const tile of out.values()) if (tile.s.length === 0) delete tile.s;
let bytes = 0;
for (const [tile, data] of out) {
  const [x, y] = tile.split('/');
  await mkdir(new URL(`${x}/`, OUT_DIR), { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  await writeFile(new URL(`${x}/${y}.json`, OUT_DIR), json);
}

// ---- 駅のまとめ（ホームの高さを決める scripts/build-platforms.mjs と、駅ビルの加工が使う） ----
const stationNames = JSON.parse(await readFile(new URL('../src/data/stations.json', import.meta.url), 'utf8'));
await mkdir(new URL('./', STRUCTURE), { recursive: true });
await writeFile(
  STRUCTURE,
  JSON.stringify(
    stations.map((st, i) => ({
      id: i,
      name: stationNames[platforms[st.platforms[0]].station]?.name ?? '',
      level: st.level,
      cut: st.cut,
      ref: st.ref.map((v) => +v.toFixed(6)),
      platforms: st.platforms.map((pi) => platforms[pi].id),
    })),
    null,
    1,
  ),
);
console.log(
  `${platforms.length} platforms → ${stations.length} stations ` +
    `(${stations.filter((s) => s.level > 0).length} elevated, ${stations.filter((s) => s.cut).length} in cuttings)`,
);
console.log(
  `${runs.length} runs, ${nodes.size} points; raised at ${raised} level crossings; ${stacked} rail-over-rail; ` +
    `${overpasses} overpass crossings → ${raiseRoad.size} road bridges raised; ${(bytes / 1e6).toFixed(2)} MB`,
);
