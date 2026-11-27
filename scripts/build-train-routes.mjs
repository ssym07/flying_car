// 電車の走る道（路線ごと）を作る：public/train-routes.json（大阪などは public/<地域>/train-routes.json）。src/world/Trains.ts が読む。
// 使い方: REGION=kanto node scripts/build-train-routes.mjs（fetch-railways.mjs・fetch-route-map.mjs の後に実行）
// データ: © OpenStreetMap contributors (ODbL)
//
// - 路線と駅の並びは路線図（public/route-map.json）のもの。線路の形は fetch-railways.mjs が取った区画のキャッシュ
//   （data/cache/railways。名前などのタグ付き）から、トンネルの外の線路（側線・車庫の線は除く）をつないだ網にする
// - 隣の駅どうしを、網の上の最短の道で結ぶ。次の区間は前の区間で着いた線路の点から続ける（上下線の線路を行き来しない）。
//   行きと帰りを別に作り、帰りは行きの線路を少し長く数えて、並んだ反対向きの線路を通りやすくする。その路線の名前の線路（「JR山手線」なら「山手線」）は短く、
//   ほかの路線の線路は長く数えて、なるべく自分の線路を通る（並んで走る京浜東北線と山手線を取り違えない）
// - 道の見つからない区間（地下・トンネル）は、駅と駅をまっすぐ結んで「見えない区間」にする（電車はそこを通る間は描かない）
//
// 出力: { lines: [{ n: 路線名, c: 色, k: 種類, d: 向き（0 = 駅の並びの順、1 = 逆）, loop: 環状なら 1, p: [緯度, 経度, ...（1e-6度、先頭以外は差分）],
//         st: [[駅名, 点の番号], ...], g: [[見えない区間の始めの点, 終わりの点], ...] }] }
// 種類：train（JR・私鉄）・subway（地下鉄の地上区間）・shinkansen・monorail・agt（新交通）・tram（路面電車・小さな電車）
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { BOUNDS, regionPath } from './lib/region.mjs';

const CACHE_DIR = new URL('../data/cache/railways/', import.meta.url);
const OUT = regionPath('public/train-routes.json');
/** 駅を線路に当てはめる距離 (m) */
const SNAP = 350;
/** ほかの路線の線路・渡り線・側線の長さの数え方（倍） */
const OTHER_LINE = 1.6;
const CROSSOVER = 3;
const SIDING = 2.5;
/** 駅で隣の線路に乗り換える時に足す長さ (m) */
const JUMP = 400;
/** 間引きの許容 (m) */
const SIMPLIFY = 0.4;

const route = JSON.parse(await readFile(regionPath('public/route-map.json'), 'utf8'));

// ---- 線路の網 ----
const ways = new Map();
for (const f of await readdir(CACHE_DIR)) {
  const [s, w, n, e] = f.replace(/\.json$/, '').split(',').map(Number);
  if (n < BOUNDS[0] - 0.02 || s > BOUNDS[2] + 0.02 || e < BOUNDS[1] - 0.02 || w > BOUNDS[3] + 0.02) continue;
  const elements = JSON.parse(await readFile(new URL(f, CACHE_DIR), 'utf8'));
  for (const el of Array.isArray(elements) ? elements : (elements.elements ?? [])) {
    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) ways.set(el.id, el);
  }
}

const K = Math.PI / 180;
const COS = Math.cos(((BOUNDS[0] + BOUNDS[2]) / 2) * K);
const meters = (la1, lo1, la2, lo2) => Math.hypot((la1 - la2) * 110950, (lo1 - lo2) * 111320 * COS);

/** 点（緯度経度を 1e-7 度で丸めた値で同じ点にする） */
const nodeIndex = new Map();
const nodeLat = [];
const nodeLon = [];
/** 隣の点：[点, 長さ (m), 線路の番号] */
const adj = [];
const wayList = [];
const nodeOf = (lat, lon) => {
  const key = `${Math.round(lat * 1e7)},${Math.round(lon * 1e7)}`;
  let i = nodeIndex.get(key);
  if (i === undefined) {
    i = nodeLat.length;
    nodeIndex.set(key, i);
    nodeLat.push(lat);
    nodeLon.push(lon);
    adj.push([]);
  }
  return i;
};
for (const way of ways.values()) {
  const t = way.tags ?? {};
  if (t.service === 'yard' || t.service === 'spur') continue;
  const w = wayList.length;
  wayList.push({
    name: t.name ?? '',
    service: t.service ?? '',
    monorail: t.railway === 'monorail',
    gauge: parseInt(t.gauge ?? '1067', 10) || 1067,
  });
  const g = way.geometry;
  let prev = nodeOf(g[0].lat, g[0].lon);
  for (let k = 1; k < g.length; k++) {
    const cur = nodeOf(g[k].lat, g[k].lon);
    if (cur === prev) continue;
    const d = meters(g[k - 1].lat, g[k - 1].lon, g[k].lat, g[k].lon);
    adj[prev].push([cur, d, w]);
    adj[cur].push([prev, d, w]);
    prev = cur;
  }
}

// 点の格子（駅に近い点を探す）
const CELL = 0.002;
const grid = new Map();
nodeLat.forEach((lat, i) => {
  if (adj[i].length === 0) return;
  const key = `${Math.floor(lat / CELL)},${Math.floor(nodeLon[i] / CELL)}`;
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(i);
});

// ---- 路線名と線路の名前の照合 ----
const STRIP = /JR|ＪＲ|東京メトロ|都営|東急電鉄|東急|京王電鉄|小田急電鉄|西武鉄道|東武鉄道|京成電鉄|京浜急行電鉄|相模鉄道|横浜市営地下鉄|電鉄|鉄道|本線|各駅|線|\(.*?\)|（.*?）|[\s・]/g;
const bigrams = (s) => {
  const t = s.replace(STRIP, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
};
const wayGrams = wayList.map((w) => bigrams(w.name));
/** 線路の名前がこの路線のものか（路線名の 2 文字の組の 6 割以上が線路の名前にある、または逆） */
function matcher(lineName) {
  // 「中央・総武緩行線」は「中央緩行線」「総武緩行線」のどちらにも当てはまるよう、・で分けた名前も見る
  const names = [lineName, ...lineName.split(/[・／/]/).filter((p) => p.length >= 2)];
  const sets = names.map(bigrams).filter((s) => s.size > 0);
  const cache = new Map();
  return (w) => {
    let hit = cache.get(w);
    if (hit !== undefined) return hit;
    const g = wayGrams[w];
    hit = false;
    if (g.size > 0) {
      for (const s of sets) {
        let common = 0;
        for (const x of s) if (g.has(x)) common++;
        if (common / Math.min(s.size, g.size) >= 0.6) {
          hit = true;
          break;
        }
      }
    }
    cache.set(w, hit);
    return hit;
  };
}

function nearNodes(lat, lon) {
  const out = [];
  const r = Math.ceil(SNAP / 111000 / CELL);
  const ci = Math.floor(lat / CELL);
  const cj = Math.floor(lon / CELL);
  for (let i = ci - r; i <= ci + r; i++) {
    for (let j = cj - r; j <= cj + r; j++) {
      for (const n of grid.get(`${i},${j}`) ?? []) {
        const d = meters(lat, lon, nodeLat[n], nodeLon[n]);
        if (d < SNAP) out.push([n, d]);
      }
    }
  }
  return out;
}

/** 駅のまわりの、この路線の線路の点（無ければ、どの線路でも）と駅からの距離 */
function stationNodes(lat, lon, isMine) {
  const near = nearNodes(lat, lon);
  const mine = near.filter(([n]) => adj[n].some(([, , w]) => isMine(w)));
  return mine.length > 0 ? mine : near;
}

/**
 * 最短の道（ダイクストラ）。sources の点から始め、targets（[点, 駅からの距離]）のどれかで終わる。
 * 終わりの点は「道の長さ + 駅からの距離 × 2」がいちばん小さいもの（駅の真ん中に近い所に止まる）。
 * penalty の辺（行きの向きが使った線路）は長く数える。limit より長くなったらあきらめる。点の並びか null
 */
function shortest(sources, targets, isMine, limit, penalty) {
  const goal = new Map(targets.map(([n, d]) => [n, d * 2]));
  const dist = new Map();
  const prev = new Map();
  const heap = [];
  const push = (item) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const [n, d] of sources) {
    dist.set(n, d);
    push([d, n]);
  }
  let best = null;
  let bestCost = Infinity;
  while (heap.length > 0) {
    const [d, n] = pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    if (d >= bestCost || d > limit) break;
    const g = goal.get(n);
    if (g !== undefined && d + g < bestCost) ((bestCost = d + g), (best = n));
    for (const [nb, len, w] of adj[n]) {
      const info = wayList[w];
      let k = isMine(w) ? 1 : info.service === 'crossover' ? CROSSOVER : info.service === 'siding' ? SIDING : OTHER_LINE;
      if (penalty?.has(edgeKey(n, nb))) k *= 1.4;
      const nd = d + len * k;
      if (nd < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, nd);
        prev.set(nb, n);
        push([nd, nb]);
      }
    }
  }
  if (best === null) return null;
  const out = [best];
  while (prev.has(out[out.length - 1])) out.push(prev.get(out[out.length - 1]));
  return out.reverse();
}
const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** 間引き（ダグラス・ポイカー、m） */
function simplify(pts) {
  if (pts.length <= 2) return pts;
  const [alat, alon] = pts[0];
  const [blat, blon] = pts[pts.length - 1];
  const bx = (blon - alon) * 111320 * COS;
  const by = (blat - alat) * 110950;
  const L = Math.hypot(bx, by) || 1e-9;
  let far = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = (pts[i][1] - alon) * 111320 * COS;
    const py = (pts[i][0] - alat) * 110950;
    const d = Math.abs(bx * py - by * px) / L;
    if (d > far) ((far = d), (at = i));
  }
  if (far <= SIMPLIFY) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, at + 1)).slice(0, -1), ...simplify(pts.slice(at))];
}

function kindOf(name, monorailShare) {
  if (/新幹線/.test(name)) return 'shinkansen';
  if (monorailShare > 0.5 || /モノレール/.test(name)) return 'monorail';
  if (/ゆりかもめ|シーサイドライン|ニューシャトル|伊奈線|ディズニーリゾートライン|山口線|舎人ライナー|ニュートラム|ポートライナー|六甲ライナー/.test(name)) return 'agt';
  if (/世田谷線|荒川線|江ノ島電鉄|江ノ電|阪堺|嵐電|市電/.test(name)) return 'tram';
  if (/メトロ|都営|地下鉄|市営/.test(name)) return 'subway';
  return 'train';
}

// ---- 路線ごとの道 ----
const q = (v) => Math.round(v * 1e6);
const out = [];
let segments = 0;
let found = 0;

/**
 * 駅の並びに沿った道。次の区間は前の区間で着いた線路の点から続けて探す（上下線の線路を行き来しない）。
 * 戻り値：点 [緯度, 経度]・各駅の点の番号・見えない区間・使った辺・モノレールの割合
 */
function buildPath(stops, isMine, penalty) {
  const pts = [];
  const st = [];
  const gaps = [];
  const used = new Set();
  let monorail = 0;
  let total = 0;
  let at = null;
  for (let k = 0; k < stops.length; k++) {
    const [sname, slat, slon] = stops[k];
    const targets = stationNodes(slat, slon, isMine);
    if (k === 0) {
      const first = targets.sort((a, b) => a[1] - b[1])[0];
      pts.push(first ? [nodeLat[first[0]], nodeLon[first[0]]] : [slat, slon]);
      st.push([sname, 0]);
      at = first ? first[0] : null;
      continue;
    }
    segments++;
    const [, plat, plon] = stops[k - 1];
    const straight = meters(plat, plon, slat, slon);
    // 前の区間で着いた点から続ける。その線路が反対向き・途中で切れている時のため、前の駅のまわりのほかの線路の点からも
    // 始められるようにする（乗り換えは JUMP m 長く数えるので、ふだんは同じ線路を続ける）
    const around = stationNodes(plat, plon, isMine).map(([n, d]) => [n, d * 2 + (at !== null ? JUMP : 0)]);
    const sources = at !== null ? [[at, 0], ...around.filter(([n]) => n !== at)] : around;
    const path = sources.length > 0 && targets.length > 0 ? shortest(sources, targets, isMine, straight * 2 + 1500, penalty) : null;
    if (path && path.length >= 2) {
      found++;
      if (pts.length > 0 && path[0] !== at) pts.push([nodeLat[path[0]], nodeLon[path[0]]]);
      for (let i = 1; i < path.length; i++) {
        used.add(edgeKey(path[i - 1], path[i]));
        const e = adj[path[i - 1]].find(([nb]) => nb === path[i]);
        if (e && wayList[e[2]].monorail) monorail++;
        total++;
      }
      pts.push(...simplify(path.map((n) => [nodeLat[n], nodeLon[n]])).slice(1));
      at = path[path.length - 1];
    } else {
      // 見えない区間：前の駅の点から、この駅のいちばん近い線路の点（無ければ駅の位置）へまっすぐ
      const start = pts.length - 1;
      const near = targets.sort((a, b) => a[1] - b[1])[0];
      pts.push(near ? [nodeLat[near[0]], nodeLon[near[0]]] : [slat, slon]);
      gaps.push([start, pts.length - 1]);
      at = near ? near[0] : null;
    }
    st.push([sname, pts.length - 1]);
  }
  return { pts, st, gaps, used, monorail: total > 0 ? monorail / total : 0 };
}

const encode = (pts) => {
  const p = [];
  let plat = 0;
  let plon = 0;
  for (const [lat, lon] of pts) {
    p.push(q(lat) - plat, q(lon) - plon);
    plat = q(lat);
    plon = q(lon);
  }
  return p;
};

for (const [name, color, ids] of route.lines) {
  const isMine = matcher(name);
  const loop = ids.length > 2 && ids[0] === ids[ids.length - 1];
  const stops = ids.map((i) => route.stations[i]);
  // 行きと帰り。帰りは行きの線路を少し長く数えて、並んだもう 1 本の線路（反対向きの線路）を通りやすくする
  const go = buildPath(stops, isMine, null);
  const back = buildPath([...stops].reverse(), isMine, go.used);
  if (go.pts.length < 2) continue;
  const kind = kindOf(name, go.monorail);
  for (const [dir, r] of [[0, go], [1, back]]) {
    out.push({ n: name, c: color, k: kind, d: dir, loop: loop ? 1 : 0, p: encode(r.pts), st: r.st, g: r.gaps });
  }
}

const json = JSON.stringify({ lines: out });
await writeFile(OUT, json);
console.log(
  `${ways.size} ways, ${nodeLat.length} nodes → ${out.length} lines, ${found}/${segments} segments on tracks, ${(json.length / 1e6).toFixed(2)} MB → ${OUT.pathname}`,
);
