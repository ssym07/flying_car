// 駅の上屋・ホームの高さを、線路の高さ（public/rail-tracks と data/stations/structure.json）に合わせて
// public/station-roofs を書き換える。
// 使い方: node scripts/build-platforms.mjs（fetch-station-roofs.mjs と build-rail-heights.mjs の後に実行）
//
// - ホーム（種類 2）：床の高さ = 駅の高さ + 道床の高さ + PLATFORM_HEIGHT。地面の基準は駅の基準点（線路と同じ）
//   線路の中心から PLATFORM_CLEAR m より近い角は、線路から離す（ホームが線路にかぶらないように）
// - 上屋（種類 1）：屋根の高さ = 重なるホームの床 + CANOPY_HEIGHT
// - 駅にまとまらなかったホーム・上屋は、一番近い線路の高さに合わせる。近くに線路が無ければ、ホームは描かず（地下の駅）、
//   上屋は地面に置く（駅前のバス乗り場・駐輪場の屋根など）
// - 駅舎（種類 0）：そのまま（描かない。PLATEAU の建物が駅かどうかの判定にだけ使う）
//
// 書き換えた後の形式: [種類, 地面からの高さ(m)（描かないものは -1）, 駅の番号, 座標, 基準点の緯度, 経度（1e-6度）, 掘割(0/1)]
//   基準点の3つは、駅にまとまったホーム・上屋だけ
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { regionPath, SETTINGS } from './lib/region.mjs';

const ROOF_DIR = regionPath('public/station-roofs/15/');
const RAIL_DIR = regionPath('public/rail-tracks/15/');
const STRUCTURE = regionPath('data/stations/structure.json');
/** 道床の上面の、地面からの高さ (m)。src/core/config.ts の RAILWAYS.lift と同じ */
const BALLAST = 0.3;
/** ホームの床の、道床の上面からの高さ (m) */
const PLATFORM_HEIGHT = 1.1;
/** 上屋の屋根の、ホームの床からの高さ (m) */
const CANOPY_HEIGHT = 4.5;
/** ホームの縁と線路の中心の間を、少なくともこれだけ空ける (m) */
const PLATFORM_CLEAR = 1.6;
/** 線路の中心からこの距離 (m) 以内の角だけ動かす（それより遠い線路は、このホームに面していない） */
const TRIM_NEAR = 3;
/** 駅にまとまらなかったものは、この距離 (m) 以内の線路の高さに合わせる */
const SEARCH = 12;

const K = Math.PI / 180;
const MX = 111320 * Math.cos(SETTINGS.lat0 * K);
const MY = 111320;
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
/** 線分 a-b 上で点 p に一番近い点の、a からの割合 t と距離 (m)（緯度経度を平面の m に直して） */
function nearestOnSegment(p, a, b) {
  const ax = (a[1] - p[1]) * MX;
  const ay = (a[0] - p[0]) * MY;
  const dx = (b[1] - a[1]) * MX;
  const dy = (b[0] - a[0]) * MY;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { t, d: Math.hypot(ax + dx * t, ay + dy * t), dx, dy };
}

// 線路の線分（高さ付き）を格子に入れる
const CELL = 0.0005;
const grid = new Map();
for (const x of await readdir(RAIL_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
    const { t } = JSON.parse(await readFile(new URL(`${x}/${f}`, RAIL_DIR), 'utf8'));
    for (const [, coords, offsets] of t) {
      const pts = decode(coords);
      for (let i = 1; i < pts.length; i++) {
        const seg = [pts[i - 1], pts[i], offsets[i - 1] / 10, offsets[i] / 10];
        const cells = new Set();
        const n = Math.ceil(Math.hypot((pts[i][0] - pts[i - 1][0]) * MY, (pts[i][1] - pts[i - 1][1]) * MX) / 20);
        for (let k = 0; k <= n; k++) {
          const la = pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / n;
          const lo = pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / n;
          cells.add(`${Math.floor(la / CELL)},${Math.floor(lo / CELL)}`);
        }
        for (const c of cells) {
          if (!grid.has(c)) grid.set(c, []);
          grid.get(c).push(seg);
        }
      }
    }
  }
}
/** 点 p のまわり radius m 以内の線路の線分 */
function segmentsNear(p, radius) {
  const out = new Set();
  const dy = Math.ceil(radius / MY / CELL);
  const dx = Math.ceil(radius / MX / CELL);
  const cy = Math.floor(p[0] / CELL);
  const cx = Math.floor(p[1] / CELL);
  for (let y = cy - dy; y <= cy + dy; y++) {
    for (let x = cx - dx; x <= cx + dx; x++) for (const s of grid.get(`${y},${x}`) ?? []) out.add(s);
  }
  return out;
}
/** 形の頂点から一番近い線路の高さ（SEARCH m 以内に無ければ null） */
function nearestTrackHeight(ring) {
  let best = null;
  let bestD = SEARCH;
  for (const p of ring) {
    for (const [a, b, ha, hb] of segmentsNear(p, SEARCH)) {
      const { t, d } = nearestOnSegment(p, a, b);
      if (d < bestD) {
        bestD = d;
        best = ha + (hb - ha) * t;
      }
    }
  }
  return best;
}
/** ホームの角のうち線路に近すぎるものを、線路から PLATFORM_CLEAR m の所まで離す */
function trim(ring) {
  let moved = 0;
  const out = ring.map((p) => {
    let q = p;
    for (const [a, b] of segmentsNear(p, TRIM_NEAR)) {
      const { t, d, dx, dy } = nearestOnSegment(q, a, b);
      // 保存の時の丸め（約 0.1m）で行ったり来たりしないよう、少し余裕を見る
      if (d >= PLATFORM_CLEAR - 0.15 || d > TRIM_NEAR) continue;
      // 線路に直角な向きのうち、角のある側へ
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      let nx = -dy / len;
      let ny = dx / len;
      const ox = (q[1] - (a[1] + (b[1] - a[1]) * t)) * MX;
      const oy = (q[0] - (a[0] + (b[0] - a[0]) * t)) * MY;
      if (nx * ox + ny * oy < 0) (nx = -nx), (ny = -ny);
      const push = PLATFORM_CLEAR - d;
      q = [q[0] + (ny * push) / MY, q[1] + (nx * push) / MX];
    }
    // 両側の線路に挟まれて離しきれない角は動かさない（行ったり来たりしないように）
    if (q === p || [...segmentsNear(q, TRIM_NEAR)].some(([a, b]) => nearestOnSegment(q, a, b).d < PLATFORM_CLEAR - 0.15)) {
      return p;
    }
    moved++;
    return q;
  });
  return { ring: out, moved };
}
const inside = (p, ring) => {
  let r = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ay, ax] = ring[i];
    const [by, bx] = ring[j];
    if (ay > p[0] !== by > p[0] && p[1] < ((bx - ax) * (p[0] - ay)) / (by - ay) + ax) r = !r;
  }
  return r;
};

const structure = JSON.parse(await readFile(STRUCTURE, 'utf8'));
const stationOf = new Map();
for (const st of structure) for (const id of st.platforms) stationOf.set(id, st);

const files = [];
for (const x of await readdir(ROOF_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, ROOF_DIR))) {
    const file = new URL(`${x}/${f}`, ROOF_DIR);
    files.push({ file, id: `${x}/${f.replace('.json', '')}`, data: JSON.parse(await readFile(file, 'utf8')) });
  }
}
const ref = (st) => [Math.round(st.ref[0] * 1e6), Math.round(st.ref[1] * 1e6), st.cut ? 1 : 0];

// ホーム
const grouped = []; // [駅, ホームの形]（上屋を合わせるのに使う）
let platforms = 0;
let hidden = 0;
let movedCorners = 0;
for (const { id, data } of files) {
  data.forEach((rec, i) => {
    if (rec[0] !== 2) return;
    const st = stationOf.get(`${id}#${i}`);
    const { ring, moved } = trim(decode(rec[3]));
    movedCorners += moved;
    rec[3] = encode(ring);
    rec.length = 4;
    if (st) {
      rec[1] = Math.round((st.level + BALLAST + PLATFORM_HEIGHT) * 10) / 10;
      rec.push(...ref(st));
      grouped.push([st, ring]);
    } else {
      const h = nearestTrackHeight(ring);
      rec[1] = h === null ? -1 : Math.round((h + BALLAST + PLATFORM_HEIGHT) * 10) / 10;
      if (h === null) hidden++;
    }
    platforms++;
  });
}
// 上屋：重なるホームの駅に合わせる
let roofs = 0;
let roofsGrouped = 0;
for (const { data } of files) {
  for (const rec of data) {
    if (rec[0] !== 1) continue;
    const ring = decode(rec[3]);
    const center = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const hit = grouped.find(([, pr]) => inside(center, pr) || pr.some((p) => inside(p, ring)));
    rec.length = 4;
    if (hit) {
      rec[1] = Math.round((hit[0].level + BALLAST + PLATFORM_HEIGHT + CANOPY_HEIGHT) * 10) / 10;
      rec.push(...ref(hit[0]));
      roofsGrouped++;
    } else {
      // 線路の無い所の屋根（駅前のバス乗り場・駐輪場など）は地面に置く
      const h = nearestTrackHeight(ring) ?? 0;
      rec[1] = Math.round((h + BALLAST + PLATFORM_HEIGHT + CANOPY_HEIGHT) * 10) / 10;
    }
    roofs++;
  }
}
for (const { file, data } of files) await writeFile(file, JSON.stringify(data));
console.log(
  `${platforms} platforms, ${roofs} canopies (${roofsGrouped} matched to a station); ` +
    `${hidden} platforms hidden (no track nearby); ${movedCorners} platform corners moved off the tracks`,
);
