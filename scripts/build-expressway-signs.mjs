// 高速道路の分岐の手前に立てる方面看板（門型の標識）を作り、public/expressway-signs.json に書き出す。
// 使い方: node scripts/build-expressway-signs.mjs（build-expressways.mjs の後に実行。REGION= で地域）
//
// 方針：
// - 元にするのは fetch-expressways.mjs が保存した OpenStreetMap の道（data/cache/expressways。タグ付き）。
//   道どうしは端の点の座標が同じことでつながる（ノードの番号は保存していない）
// - 分岐：一方通行の道の上の点から、2本以上の道が出ていく所（本線から連絡路が分かれる・本線が二股に分かれる）
// - 看板は分岐の BEFORE m 手前（上流へたどる。手前に別の分岐があればその間）の本線の上に、進む向きに向けて立てる
// - 方面（看板の文字）は、
//   1. その先の道（連絡路）に OSM の方面（destination・destination:ref）があればそれ
//   2. 無ければ、つながりを先へたどって推定：別の名前の高速に入ればその路線名、一般道へ出て終われば「出口」と
//      出た所に近い駅の名前、同じ道がずっと続けば先の方の大きな駅（地域の hubs）の名前
// - 看板の高さは描く側で、路面に下ろして決める（ここでは路面の地面からの高さを目安として入れておく）
//
// 出力の形式: { "s": [[緯度, 経度（1e-6度）, 進む向き（北から時計回り、0.1度）, 路面の地面からの高さ（0.1m）,
//   路面の半幅（0.1m）, [[向き（-1 左・0 まっすぐ・1 右）, 路線番号, 方面1, 方面2, 出口(0/1)], ...]], ...] }
// データ: © OpenStreetMap contributors (ODbL)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { regionPath, SETTINGS } from './lib/region.mjs';

const CACHE_DIR = new URL('../data/cache/expressways/', import.meta.url);
const RAW = regionPath('data/osm/expressways.json');
const TILE_DIR = regionPath('public/expressways/15/');
const OUT = regionPath('public/expressway-signs.json');
const STATIONS = regionPath('src/data/stations.json');

/** 看板を立てる、分岐の手前の距離 (m) */
const BEFORE = 230;
/** これより手前に取れない（すぐ上流に別の分岐がある）時は立てない (m) */
const MIN_BEFORE = 70;
/** 方面を推定する時に先へたどる距離 (m) */
const LOOKAHEAD = 9000;
/** 同じ向きの看板がこれより近ければ1つにする (m) */
const DEDUPE = 150;

const K = Math.PI / 180;
const meters = (a, b) =>
  Math.hypot((b[1] - a[1]) * K * Math.cos(((a[0] + b[0]) / 2) * K), (b[0] - a[0]) * K) * 6371000;
const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
/** a から b への向き（北から時計回り、度） */
const bearing = (a, b) =>
  (Math.atan2((b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * K), b[0] - a[0]) / K + 360) % 360;
const turn = (from, to) => ((to - from + 540) % 360) - 180;

// ---- 地域の高速の点（この地域の道だけ使う） ----
const raw = JSON.parse(await readFile(RAW, 'utf8'));
const regionKeys = new Set();
for (const w of raw) for (const p of w[6]) regionKeys.add(key(p));

// ---- OSM の道（タグ付き） ----
const ways = [];
const seen = new Set();
for (const file of await readdir(CACHE_DIR)) {
  if (!file.endsWith('.json')) continue;
  const elements = JSON.parse(await readFile(new URL(file, CACHE_DIR), 'utf8'));
  for (const e of elements) {
    if (e.type !== 'way' || seen.has(e.id) || !e.geometry) continue;
    seen.add(e.id);
    const t = e.tags ?? {};
    if (t.oneway === 'no') continue;
    let pts = e.geometry.map((g) => [g.lat, g.lon]);
    if (t.oneway === '-1') pts = pts.reverse();
    if (pts.length < 2 || !regionKeys.has(key(pts[0])) || !regionKeys.has(key(pts[pts.length - 1]))) continue;
    const length = pts.slice(1).reduce((sum, p, i) => sum + meters(pts[i], p), 0);
    ways.push({ id: e.id, tags: t, pts, length, link: t.highway === 'motorway_link' });
  }
}

/** 点 → その点を通る道（何番目の点か） */
const at = new Map();
for (const w of ways) {
  w.pts.forEach((p, i) => {
    const k = key(p);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push({ w, i });
  });
}
/** 点から出ていく道（その点から先の部分） */
function outgoing(p, except) {
  return (at.get(key(p)) ?? []).filter(({ w, i }) => w !== except && i < w.pts.length - 1);
}
/** 点に入ってくる道（その点までの部分） */
function incoming(p) {
  return (at.get(key(p)) ?? []).filter(({ i }) => i > 0);
}

/** 路線名を看板向けに短くする（「首都高速湾岸線」→「湾岸線」） */
const ALIAS = {
  首都圏中央連絡自動車道: '圏央道',
  東京外環自動車道: '外環道',
  東京湾アクアライン: 'アクアライン',
  第三京浜道路: '第三京浜',
  京葉道路: '京葉道路',
  近畿自動車道: '近畿道',
  名神高速道路: '名神',
  新名神高速道路: '新名神',
  東名高速道路: '東名',
  新東名高速道路: '新東名',
  中国自動車道: '中国道',
  山陽自動車道: '山陽道',
  九州自動車道: '九州道',
  東名阪自動車道: '東名阪',
  伊勢湾岸自動車道: '伊勢湾岸道',
  名古屋第二環状自動車道: '名二環',
};
function shortName(name) {
  if (!name) return '';
  const base = name.replace(/[（(].*[）)]$/, '');
  if (ALIAS[base]) return ALIAS[base];
  return base.replace(/^首都高速(道路)?/, '').replace(/^阪神高速(道路)?/, '').replace(/^名古屋高速(道路)?/, '').replace(/^福岡高速(道路)?/, '').replace(/^(.+自動車道).*$/, '$1').replace(/\s.*$/, '');
}
const roadName = (t) => t['name:ja'] ?? t.name ?? '';
const firstRef = (t) => (t.ref ?? '').split(';')[0].trim();

// ---- 駅（方面の推定） ----
const stations = JSON.parse(await readFile(STATIONS, 'utf8'));
const hubs = stations.filter((s) => (SETTINGS.hubs ?? []).includes(s.name));
function nearest(list, p, max) {
  let best = null;
  let bestD = max;
  for (const s of list) {
    const d = meters(p, [s.lat, s.lon]);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** p から道に沿って d m 進んだ（d が負なら戻った）所。たどれる所まで */
function walkForward(w, i, distance) {
  // 先へ：同じ名前（無ければ本線）の続きを選ぶ
  let way = w;
  let idx = i;
  let left = distance;
  const path = [];
  for (let guard = 0; guard < 200; guard++) {
    for (; idx < way.pts.length - 1; idx++) {
      const d = meters(way.pts[idx], way.pts[idx + 1]);
      path.push({ way, p: way.pts[idx] });
      if (d >= left) {
        const t = left / d;
        const a = way.pts[idx];
        const b = way.pts[idx + 1];
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], way, path, ended: false };
      }
      left -= d;
    }
    const end = way.pts[way.pts.length - 1];
    const next = outgoing(end, way);
    if (next.length === 0) return { p: end, way, path, ended: true };
    const same = next.find((n) => roadName(n.w.tags) === roadName(way.tags)) ?? next.find((n) => !n.w.link) ?? next[0];
    way = same.w;
    idx = same.i;
  }
  return { p: way.pts[idx], way, path, ended: false };
}

/** 分岐の上流へ distance m 戻った所と、その所の進む向き。途中で別の分岐（出ていく道が2本以上）に当たったらその手前まで */
function walkBack(w, i, distance) {
  let way = w;
  let idx = i;
  let left = distance;
  let walked = 0;
  for (let guard = 0; guard < 100; guard++) {
    for (; idx > 0; idx--) {
      const a = way.pts[idx - 1];
      const b = way.pts[idx];
      const d = meters(a, b);
      if (d >= left) {
        const t = 1 - left / d;
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b), way, walked: walked + left };
      }
      left -= d;
      walked += d;
      // 上流の点で別の道が出ていく（別の分岐）なら、そこで止める
      if (idx - 1 > 0 && outgoing(a, way).length > 0) return { p: a, heading: bearing(a, b), way, walked };
    }
    const start = way.pts[0];
    const prev = incoming(start).filter((n) => n.w !== way);
    // 上流の始まり、または合流（入ってくる道が2本以上）なら止める
    if (prev.length !== 1 || outgoing(start, way).length > 0) {
      return { p: start, heading: bearing(way.pts[0], way.pts[1]), way, walked };
    }
    way = prev[0].w;
    idx = prev[0].i;
  }
  return null;
}

/** 分かれた先の道の方面 */
function destinationOf(branch) {
  // 1. OSM の方面（この道か、すぐ先の道に付いていれば）
  let way = branch.w;
  for (let k = 0, walked = 0; k < 4 && way && walked < 1500; k++) {
    const t = way.tags;
    const dest = t['destination:ja'] ?? t.destination;
    if (dest) {
      const names = dest.split(';').map((s) => s.trim()).filter(Boolean).slice(0, 2);
      const ref = (t['destination:ref'] ?? '').split(';')[0].trim();
      return { ref, names, exit: false };
    }
    walked += way.length;
    const next = outgoing(way.pts[way.pts.length - 1], way);
    way = next.length === 1 ? next[0].w : null;
  }

  // 2. つながりをたどって推定
  const start = branch.w;
  const startName = roadName(start.tags);
  const ahead = walkForward(start, branch.i, LOOKAHEAD);
  // 別の名前の高速（本線）に入ったら、その路線
  for (const { way: w } of ahead.path) {
    if (w.link) continue;
    const name = roadName(w.tags);
    if (name && name !== startName) {
      return { ref: firstRef(w.tags), names: [shortName(name)], exit: false };
    }
  }
  // 連絡路のまま一般道へ出て終わる＝出口
  if (ahead.ended && ahead.path.every(({ way: w }) => w.link)) {
    const s = nearest(stations, ahead.p, 4000);
    return { ref: '', names: s ? [s.name] : [], exit: true };
  }
  // 同じ道が続く：先の方の大きな駅
  const s = nearest(hubs, ahead.p, 6000) ?? nearest(stations, ahead.p, 3000);
  const w = ahead.path.find(({ way: x }) => !x.link)?.way ?? start;
  return { ref: firstRef(w.tags), names: [s?.name, shortName(roadName(w.tags))].filter(Boolean).slice(0, 2), exit: false };
}

// ---- 路面の高さ（build-expressways.mjs の出力から、近い点の地面からの高さ） ----
const lift = new Map();
const cell = (lat, lon) => `${Math.floor(lat * 2000)},${Math.floor(lon * 2000)}`;
for (const x of await readdir(TILE_DIR).catch(() => [])) {
  for (const f of await readdir(new URL(`${x}/`, TILE_DIR))) {
    const tile = JSON.parse(await readFile(new URL(`${x}/${f}`, TILE_DIR), 'utf8'));
    for (const w of tile.w) {
      let lat = 0;
      let lon = 0;
      const c = w[4];
      for (let i = 0; i < c.length; i += 2) {
        lat += c[i];
        lon += c[i + 1];
        const p = [lat / 1e6, lon / 1e6, w[5][i / 2] / 10];
        const k = cell(p[0], p[1]);
        if (!lift.has(k)) lift.set(k, []);
        lift.get(k).push(p);
      }
    }
  }
}
function liftAt(p) {
  let best = null;
  let bestD = 25;
  const [cy, cx] = [Math.floor(p[0] * 2000), Math.floor(p[1] * 2000)];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const q of lift.get(`${cy + dy},${cx + dx}`) ?? []) {
        const d = meters(p, q);
        if (d < bestD) {
          bestD = d;
          best = q[2];
        }
      }
    }
  }
  return best;
}

// ---- 分岐を探して看板を作る ----
const signs = [];
const done = new Set();
let fromOsm = 0;
let inferred = 0;
for (const w of ways) {
  const s = w.pts[0];
  const k = key(s);
  if (done.has(k)) continue;
  const out = outgoing(s);
  if (out.length < 2) continue;
  // 上流：この点に入ってくる道（本線を優先）
  const inc = incoming(s);
  if (inc.length === 0) continue;
  done.add(k);
  const up = inc.find((n) => !n.w.link) ?? inc[0];
  const back = walkBack(up.w, up.i, BEFORE);
  if (!back || back.walked < MIN_BEFORE) continue;
  // 分岐の点での進む向きと、それぞれの道の向き（分岐から 80m 先へ）
  const upHeading = bearing(up.w.pts[Math.max(0, up.i - 1)], s);
  const branches = out
    .map((b) => {
      const ahead = walkForward(b.w, b.i, 80);
      return { ...b, angle: turn(upHeading, bearing(s, ahead.p)) };
    })
    .sort((a, b) => a.angle - b.angle);
  // 左右の決め方：まっすぐに近い本線の続きが1本あれば「まっすぐ」で、他はそれより左か右か。
  // 無ければ（二股）、一番左を左、一番右を右（両方とも同じ側へ曲がっていても）
  const straightest = branches.reduce((a, b) => (Math.abs(b.angle) < Math.abs(a.angle) ? b : a));
  const hasStraight = !straightest.w.link && Math.abs(straightest.angle) < 12;
  const sideOf = (b, index) => {
    if (hasStraight) return b === straightest ? 0 : b.angle < straightest.angle ? -1 : 1;
    if (index === 0) return -1;
    if (index === branches.length - 1) return 1;
    return 0;
  };
  const panels = branches.map((b, index) => {
    const dest = destinationOf(b);
    if ((b.w.tags['destination:ja'] ?? b.w.tags.destination) !== undefined) fromOsm++;
    else inferred++;
    const side = sideOf(b, index);
    return [side, dest.ref, dest.names[0] ?? '', dest.names[1] ?? '', dest.exit ? 1 : 0];
  });
  // 中身の無い看板・同じ方面だけの看板は立てない
  if (panels.every((p) => !p[2])) continue;
  if (new Set(panels.map((p) => `${p[1]}|${p[2]}`)).size < panels.length) continue;
  const h = liftAt(back.p);
  if (h === null) continue;
  const lanes = Number(back.way.tags.lanes) || (back.way.link ? 1 : 2);
  const half = (lanes * 3.5) / 2 + 1.2;
  signs.push({ p: back.p, heading: back.heading, lift: h, half, panels });
}

// 近くに同じ向きの看板があれば1つにする（細かく分かれた分岐の続き）
const kept = [];
for (const s of signs) {
  if (kept.some((k) => meters(k.p, s.p) < DEDUPE && Math.abs(turn(k.heading, s.heading)) < 30)) continue;
  kept.push(s);
}

await writeFile(
  OUT,
  JSON.stringify({
    s: kept.map((s) => [
      Math.round(s.p[0] * 1e6),
      Math.round(s.p[1] * 1e6),
      Math.round(s.heading * 10),
      Math.round(s.lift * 10),
      Math.round(s.half * 10),
      s.panels,
    ]),
  }),
);
console.log(`看板 ${kept.length}（分岐 ${signs.length}）。方面：OSM ${fromOsm}・推定 ${inferred}`);
