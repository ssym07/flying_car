// 高速道路の元データ（data/osm/expressways.json）に各点の「地面からの高さ」を付け、
// 地形チャンクと同じタイル（ズーム15）ごとに public/expressways/15/{x}/{y}.json に書き出す。
// 使い方: node scripts/build-expressways.mjs（fetch-expressways.mjs の後に実行）
//
// 方針：
// - 高架は地面から VIADUCT m。OSM の layer が1つ上がるごとに STACK m 上げる（ジャンクションの立体交差）
// - 短い橋（川をまたぐだけの地上区間の橋）は地上扱い
// - 掘割（cutting、または layer が負）は高さ 0（地形を削って底に置くのは描画側）
// - 地上・掘割と高架の間は勾配 GRADE の坂でつなぐ（つながりをたどって高さを決める）
// - 出入口（連絡路）の行き止まり、一般道の点につながる行き止まり、トンネルの入口は地上（0m）に固定し、
//   そこから勾配 GRADE で上がるよう高さを抑える（高架のまま空中で途切れないように）
// - 一般道・線路と交わる所は橋脚を立てない（x）
// - 隣に高さのほぼ同じ別の道が並ぶ側（点ごと・左右ごと）：同じ向き（合流・分岐）なら縁を付けずに路面をつなぎ、
//   逆向き（上下線）なら間に分離帯の壁を置く。外側だけに壁高欄が立つようにする
// - 分岐・合流の付け根で同じ向きの路面が重なる・くっつく間は、本線（順位の高い道）の高さにそろえ、坂は離れてから始める
//
// 出力の形式（1タイル）:
// { "w": [[連絡路(0/1), 車線数, 掘割(0/1), 名前, [緯度,経度,...（1e-6度、先頭以外は差分）], [各点の高さ（0.1m）...],
//          [各点の左の隣], [各点の右の隣]], ...],
//   隣：0 = 無し（壁高欄）、正 = 同じ向きの道（1 + 譲る(0/1)×1000 + (路面の縁どうしのすき間 + 50m) を 0.1m で。
//   負のすき間は重なり）、負 = 逆向きの道（-(1 + すき間 0.1m)）
//   "x": [[緯度, 経度（1e-6度）, 半径(m)], ...] }
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { regionPath, SETTINGS } from './lib/region.mjs';

const RAW = regionPath('data/osm/expressways.json');
const ROAD_DIR = regionPath('public/roads/15/');
const RAIL_DIR = regionPath('public/rail-tracks/15/');
const OUT_DIR = regionPath('public/expressways/15/');

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
/** トンネルの端（fetch-expressways.mjs）。ここで終わる道はトンネルの入口へ下りる */
const tunnelEnds = new Set(
  JSON.parse(await readFile(regionPath('data/osm/expressway-tunnels.json'), 'utf8').catch(() => '[]')).map(
    (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`,
  ),
);
const ways = raw.map(([link, bridge, cutting, layer, lanes, name, pts]) => ({
  link,
  bridge,
  // トンネルの入口につながる地上の道は掘割にする（地形を削って入口へ下りる）
  cut:
    cutting === 1 ||
    (layer < 0 && !bridge) ||
    (!bridge && [pts[0], pts[pts.length - 1]].some((p) => tunnelEnds.has(key(p)))),
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

// ---- 一般道（地上へのつながりを調べるのと、橋脚を立てない所に使う） ----
async function readTiles(dir) {
  const out = [];
  for (const x of await readdir(dir).catch(() => [])) {
    for (const f of await readdir(new URL(`${x}/`, dir))) out.push(JSON.parse(await readFile(new URL(`${x}/${f}`, dir), 'utf8')));
  }
  return out;
}
const roadLines = [];
const roadPoints = new Set();
for (const t of await readTiles(ROAD_DIR)) {
  for (const w of t.w) {
    const pts = decode(w[3]);
    roadLines.push([pts, ROAD_HALF[w[0]] ?? 3]);
    // 橋の上の一般道は地上ではないので除く
    if (!w[5]) for (const p of pts) roadPoints.add(key(p));
  }
}

// 地上に固定する点：行き止まり（1本の道にしか使われない端）のうち、連絡路のものか、一般道の点と一致するもの
const usage = new Map();
for (const w of ways) for (const k of w.keys) usage.set(k, (usage.get(k) ?? 0) + 1);
const pinned = new Set();
for (const w of ways) {
  for (const k of [w.keys[0], w.keys[w.keys.length - 1]]) {
    if (usage.get(k) === 1 && (w.link || roadPoints.has(k) || tunnelEnds.has(k))) pinned.add(k);
    // トンネルの入口は掘割の底（坂で高架から下りてくる）
    if (tunnelEnds.has(k)) nodes.get(k).cut = true;
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

// 上限：地上に固定した点から、つながりをたどって「勾配 × 距離」より高くしない（地上からの坂）
const ceil = new Map();
{
  const queue = [...pinned].map((k) => [0, k]);
  for (const k of pinned) ceil.set(k, 0);
  // 距離の短い順に広げる（点の数が少ないので単純な並べ替えで足りる）
  while (queue.length > 0) {
    queue.sort((a, b) => b[0] - a[0]);
    const [v, k] = queue.pop();
    if (v > (ceil.get(k) ?? Infinity)) continue;
    for (const [nk, d] of nodes.get(k).edges) {
      const h = v + GRADE * d;
      if (h < (ceil.get(nk) ?? Infinity)) {
        ceil.set(nk, h);
        queue.push([h, nk]);
      }
    }
  }
  for (const [k, n] of nodes) if (ceil.has(k)) n.offset = Math.min(n.offset, ceil.get(k));
}

// ---- 一般道・線路と交わる所（橋脚を立てない） ----
const lines = []; // [[pts], 半径]
for (const pts of roadLines) lines.push(pts);
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

// ---- 各点の左右の隣の道 ----
const LANE_WIDTH = 3.5;
const SHOULDER = 1.0;
/** 同じ向きの道は、路面の縁どうしがこれより近ければつなぐ (m)。逆向きはこれより近ければ間に分離帯 */
const JOIN_GAP = 1.5;
const MEDIAN_GAP = 8;
/** 隣とみなす高さの差 (m)：つなぐ所・分離帯。付け根をそろえる前は、坂を上り始めた分岐も拾うよう広めに */
const SAME_LEVEL = 0.3;
const MEDIAN_LEVEL = 1.0;
const LEVEL_SEARCH = 4;
/** 付け根をそろえた後の坂の上限（足りない所は少し急にする） */
const GRADE_MAX = 0.08;
const MX = 111320 * Math.cos(SETTINGS.lat0 * K);
const MY = 111320;
const halfOf = (w) => (w.lanes * LANE_WIDTH) / 2 + SHOULDER;
/** 譲る順：本線 > 連絡路、車線の多い方、同じなら番号の小さい方。順位の低い方が重なる所で路面を切り、高さを合わせる */
const rank = (wi) => [ways[wi].link ? 0 : 1, ways[wi].lanes, -wi];
const outranks = (a, b) => {
  const ra = rank(a);
  const rb = rank(b);
  for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return ra[k] > rb[k];
  return false;
};
const SCELL = 60;
const segs = new Map();
ways.forEach((w, wi) => {
  w.xy = w.pts.map((p) => [p[1] * MX, p[0] * MY]);
  for (let j = 1; j < w.xy.length; j++) {
    const [ax, ay] = w.xy[j - 1];
    const [bx, by] = w.xy[j];
    const cells = new Set();
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / SCELL) + 1;
    for (let k = 0; k <= n; k++) {
      cells.add(`${Math.floor((ax + ((bx - ax) * k) / n) / SCELL)},${Math.floor((ay + ((by - ay) * k) / n) / SCELL)}`);
    }
    for (const c of cells) {
      if (!segs.has(c)) segs.set(c, []);
      segs.get(c).push([wi, j]);
    }
  }
});

/** 各点の左右（1 = 進行方向の左、-1 = 右）で一番近い隣：{ oi, gap, kind（1 同じ向き / -1 逆向き）, oh（隣の高さ） } */
function neighbors(joinLevel, medianLevel) {
  for (const w of ways) w.h = w.keys.map((k) => nodes.get(k).offset);
  return ways.map((w, wi) => {
    const hw = halfOf(w);
    return w.xy.map(([px, py], i) => {
      const a = w.xy[Math.max(0, i - 1)];
      const b = w.xy[Math.min(w.xy.length - 1, i + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const tx = (b[0] - a[0]) / tl;
      const ty = (b[1] - a[1]) / tl;
      const best = { 1: null, '-1': null };
      const cx = Math.floor(px / SCELL);
      const cy = Math.floor(py / SCELL);
      const seen = new Set();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const [oi, j] of segs.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (oi === wi || seen.has(`${oi}/${j}`)) continue;
            seen.add(`${oi}/${j}`);
            const o = ways[oi];
            const [ax, ay] = o.xy[j - 1];
            const [bx, by] = o.xy[j];
            const sx = bx - ax;
            const sy = by - ay;
            const sl = Math.hypot(sx, sy) || 1;
            const t = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / (sl * sl)));
            const qx = ax + sx * t - px;
            const qy = ay + sy * t - py;
            const along = qx * tx + qy * ty;
            const across = -qx * ty + qy * tx;
            if (Math.abs(along) > 6 || Math.abs(across) < 0.3) continue;
            const dot = (sx * tx + sy * ty) / sl;
            if (Math.abs(dot) < 0.7) continue;
            const kind = dot > 0 ? 1 : -1;
            const oh = o.h[j - 1] + (o.h[j] - o.h[j - 1]) * t;
            if (Math.abs(oh - w.h[i]) > (kind === 1 ? joinLevel : medianLevel)) continue;
            const side = across > 0 ? 1 : -1;
            const gap = Math.abs(across) - hw - halfOf(o);
            if ((kind === 1 && gap > JOIN_GAP) || (kind === -1 && gap > MEDIAN_GAP)) continue;
            if (!best[side] || gap < best[side].gap) best[side] = { oi, gap, kind, oh };
          }
        }
      }
      return best;
    });
  });
}

// 分岐・合流の付け根：同じ向きの道と路面が重なる・くっつく間は、順位の高い道の高さにそろえる（坂は離れてから）
{
  const fixed = new Map();
  const found = neighbors(LEVEL_SEARCH, 0);
  ways.forEach((w, wi) => {
    found[wi].forEach((best, i) => {
      for (const side of [1, -1]) {
        const n = best[side];
        if (!n || n.kind !== 1 || !outranks(n.oi, wi)) continue;
        const k = w.keys[i];
        // 2本以上の道にそろえる時は高い方
        fixed.set(k, Math.max(fixed.get(k) ?? -Infinity, n.oh));
      }
    });
  });
  for (const [k, v] of fixed) nodes.get(k).offset = v;
  // そろえた点から、つながった点を勾配 GRADE_MAX の範囲に収める（上と下の両方から）
  const spread = (sign) => {
    const bound = new Map();
    const heapB = [];
    const pushB = (k, v) => {
      heapB.push([v, k]);
      let i = heapB.length - 1;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (sign * heapB[pi][0] <= sign * heapB[i][0]) break;
        [heapB[pi], heapB[i]] = [heapB[i], heapB[pi]];
        i = pi;
      }
    };
    const popB = () => {
      const top = heapB[0];
      const last = heapB.pop();
      if (heapB.length > 0) {
        heapB[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heapB.length && sign * heapB[l][0] < sign * heapB[m][0]) m = l;
          if (r < heapB.length && sign * heapB[r][0] < sign * heapB[m][0]) m = r;
          if (m === i) break;
          [heapB[m], heapB[i]] = [heapB[i], heapB[m]];
          i = m;
        }
      }
      return top;
    };
    for (const [k, v] of fixed) {
      bound.set(k, v);
      pushB(k, v);
    }
    while (heapB.length > 0) {
      const [v, k] = popB();
      if (sign * v > sign * bound.get(k)) continue;
      for (const [nk, d] of nodes.get(k).edges) {
        const h = v + sign * GRADE_MAX * d;
        if (!bound.has(nk) || sign * h < sign * bound.get(nk)) {
          bound.set(nk, h);
          pushB(nk, h);
        }
      }
    }
    return bound;
  };
  const upper = spread(1);
  const lower = spread(-1);
  for (const [k, n] of nodes) {
    if (fixed.has(k)) continue;
    if (upper.has(k)) n.offset = Math.min(n.offset, upper.get(k));
    if (lower.has(k)) n.offset = Math.max(n.offset, lower.get(k));
    // 地上に固定した点からの坂（行き止まりの出入口）は、そろえた高さより優先
    if (ceil.has(k)) n.offset = Math.min(n.offset, ceil.get(k) * (GRADE_MAX / GRADE));
  }
  console.log(`levelled ${fixed.size} points where lanes in the same direction overlap`);
}

// 描く時の左右の隣（高さをそろえた後）。join の値に「譲る（重なる所で自分の路面を切る）」を足す
{
  const found = neighbors(SAME_LEVEL, MEDIAN_LEVEL);
  let joined = 0;
  let medians = 0;
  ways.forEach((w, wi) => {
    w.left = [];
    w.right = [];
    found[wi].forEach((best) => {
      for (const [side, list] of [
        [1, w.left],
        [-1, w.right],
      ]) {
        const n = best[side];
        if (!n) list.push(0);
        else if (n.kind === 1) {
          joined++;
          list.push(encodeJoin(n.gap, outranks(n.oi, wi)));
        } else {
          medians++;
          list.push(-(1 + Math.round(Math.max(0, n.gap) * 10)));
        }
      }
    });
  });
  console.log(`sides: ${joined} joined to a lane in the same direction, ${medians} next to the opposite direction`);
}
/** 同じ向きの隣：1 + 譲る(0/1) × 1000 + (すき間 + 50) × 10。すき間は負（重なり）も -50m まで */
function encodeJoin(gap, yields) {
  return 1 + (yields ? 1000 : 0) + Math.round((Math.max(-50, Math.min(JOIN_GAP, gap)) + 50) * 10);
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
      run.idx.map((i) => w.left[i]),
      run.idx.map((i) => w.right[i]),
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
console.log(
  `${ways.length} ways, ${nodes.size} points (${elevatedPts} elevated), ${pinned.size} ends pinned to the ground → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB`,
);
