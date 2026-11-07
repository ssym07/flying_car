import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';
import { beam } from './fukuokaTower';

/**
 * 横浜みなとみらいの高層ビル。写真と OpenStreetMap の平面を参考に作る。
 *
 * 座標：建物ごとに中心が (cx, 0, 0)。平面の点は (u, v) で書き、x = cx + u、z = -v に置く。
 * u・v の向きは建物ごとに違う（Landmarks.ts の around の角度）：みなとみらいの街区にそろえたものは
 * u = 東から北へ 33°（東北東）、v = 北北西。横浜三井ビルディングと横浜シンフォステージは u = 東、v = 北。
 *
 * - 横浜ランドマークタワー：裾の広がる 296m の塔。角を段に切り欠いた正方形で、200m まで細くなる。明るい灰色の石に
 *   暗い横の窓の帯、面の真ん中に濃い縦の帯、上の方は真ん中が深い溝になり、頂部は四隅が立ち上がる。段の境目に白い三角の飾り。
 *   南南東の足元に黒いピラミッドの屋根の小塔が4つ、北北西にランドマークプラザ
 * - クイーンズスクエア横浜：A・B・C の3つの塔（172m・138m・109m）が海へ向かって低くなる。白い横の帯と横長の窓、
 *   下の 30m は少し張り出す。屋上の縁は長い面の真ん中がへこんだ曲線
 * - ヨコハマ グランド インターコンチネンタル ホテル：帆の形の 140m の薄い板。南の端が一番高く、北へ弧を描いて 66m まで下がる。
 *   板の両側の足元に、曲線の白い段々のテラス。まわりにパシフィコ横浜の低層部と会議センター
 * - 横浜メディアタワー：灰色の格子の四角い棟（110m）の上に、白い格子の鉄塔（253m まで、青いガラスの段が2つ）。
 *   後ろに東の端の丸い白い棟（122m）
 * - 横浜シンフォステージ：ウエストタワーは紺のガラスに細い白い横の線、東の面は白い縦のフィン。北の奥の部分が 161m、
 *   南の手前は 140m で屋上が緑。イーストタワー（90m）は南の面に白い縦のフィン
 * - みなとみらいグランドセントラルタワー：長い面は青いガラスに横の線、短い面は灰色の縦の縞。屋上にベージュの塔屋と緑。
 *   まわりに 14m のテラスの低層部
 * - 横浜コネクトスクエア：下の 98m は黒に細い白い縦の線、白い棚と暗い溝を挟んで、上は少し張り出した白い横の帯
 * - KDX横浜みなとみらいタワー：四隅を切り欠いた十字の平面の 152m の塔。白っぽいベージュに横の窓の帯、切り欠きは青いガラス。
 *   屋上は一段引っ込んでヘリポート。足元にアーチの窓の低層部
 * - 横浜三井ビルディング：北西の辺が斜めの平面。灰色に細かい縦の縞、屋根は北へ上がる斜めの面
 */
export type MinatoKey =
  | 'white'
  | 'roofTop'
  | 'green'
  | 'dark'
  | 'heli'
  | 'steel'
  | 'skyGlass'
  | 'red'
  | 'lmStone'
  | 'lmBay'
  | 'lmGlass'
  | 'lmPlaza'
  | 'lmPavilion'
  | 'qsTower'
  | 'ichSail'
  | 'ichLow'
  | 'ichHall'
  | 'mediaBlock'
  | 'mediaDrum'
  | 'symWest'
  | 'symGrid'
  | 'symFin'
  | 'gctGlass'
  | 'gctStripe'
  | 'gctCrown'
  | 'gctTerrace'
  | 'conDark'
  | 'conWhite'
  | 'conLow'
  | 'kdxWhite'
  | 'kdxBlue'
  | 'kdxPodium'
  | 'mitsuiGlass';
export type MinatoParts = Partial<Record<MinatoKey, THREE.BufferGeometry>>;

type P2 = [number, number];
type Lists = Partial<Record<MinatoKey, THREE.BufferGeometry[]>>;
type Pick = (nu: number, nv: number) => MinatoKey | null;

const push = (out: Lists, key: MinatoKey, g: THREE.BufferGeometry) => (out[key] ??= []).push(g);

/** 外壁の uv の横の大きさ (m)。縦は 1 階 = FLOOR */
const PANEL = 3.2;

const rect = (u0: number, u1: number, v0: number, v1: number): P2[] => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1],
];

/** 角の丸い四角（u0〜u1, v0〜v1）。r は角ごとの半径（南西・南東・北東・北西の順）。反時計回り */
function rounded(u0: number, u1: number, v0: number, v1: number, r: [number, number, number, number]): P2[] {
  const corners: Array<[number, number, number, number]> = [
    [u0 + r[0], v0 + r[0], Math.PI, r[0]],
    [u1 - r[1], v0 + r[1], -Math.PI / 2, r[1]],
    [u1 - r[2], v1 - r[2], 0, r[2]],
    [u0 + r[3], v1 - r[3], Math.PI / 2, r[3]],
  ];
  const pts: P2[] = [];
  for (const [cu, cv, a0, rad] of corners) {
    const n = rad > 0 ? 8 : 0;
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((Math.PI / 2) * i) / Math.max(1, n);
      pts.push([cu + Math.cos(a) * rad, cv + Math.sin(a) * rad]);
      if (n === 0) break;
    }
  }
  return pts;
}

/** 中心 (cu, cv)、半径 r の円弧（a0〜a1 度）と中心を結んだ扇形。反時計回り */
function sector(cu: number, cv: number, r: number, a0: number, a1: number): P2[] {
  const pts: P2[] = [];
  const n = Math.max(4, Math.ceil((a1 - a0) / 10));
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([cu + Math.cos(a) * r, cv + Math.sin(a) * r]);
  }
  return pts;
}

/** 辺を step m 以下に分ける（上の縁が曲線の壁のため） */
function densify(pts: P2[], step: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [ua, va] = pts[i];
    const [ub, vb] = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(ub - ua, vb - va) / step));
    for (let k = 0; k < n; k++) out.push([ua + ((ub - ua) * k) / n, va + ((vb - va) * k) / n]);
  }
  return out;
}

/** 平面 pts のうち、f(u, v) >= 0 の側（f は u・v の一次式） */
function clip(pts: P2[], f: (u: number, v: number) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const fa = f(...a);
    const fb = f(...b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * 平面 pts（反時計回り）の壁。下の縁は y0、上の縁は頂点ごとの top(u, v)（間は直線）。
 * 辺ごとに外向きの向き (nu, nv) から材質を選ぶ（null の辺は作らない）
 */
function walls(out: Lists, cx: number, pts: P2[], y0: number, top: (u: number, v: number) => number, pick: Pick): void {
  const byKey = new Map<MinatoKey, { pos: number[]; nor: number[]; uv: number[] }>();
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ua, va] = pts[i];
    const [ub, vb] = pts[(i + 1) % pts.length];
    const len = Math.hypot(ub - ua, vb - va);
    if (len < 1e-3) continue;
    const nu = (vb - va) / len;
    const nv = -(ub - ua) / len;
    const key = pick(nu, nv);
    if (key === null) {
      s += len;
      continue;
    }
    const b = byKey.get(key) ?? { pos: [], nor: [], uv: [] };
    byKey.set(key, b);
    const ya = top(ua, va);
    const yb = top(ub, vb);
    const s0 = s / PANEL;
    const s1 = (s + len) / PANEL;
    b.pos.push(cx + ua, y0, -va, cx + ub, y0, -vb, cx + ub, yb, -vb, cx + ua, y0, -va, cx + ub, yb, -vb, cx + ua, ya, -va);
    for (let k = 0; k < 6; k++) b.nor.push(nu, 0, -nv);
    const t0 = y0 / FLOOR;
    b.uv.push(s0, t0, s1, t0, s1, yb / FLOOR, s0, t0, s1, yb / FLOOR, s0, ya / FLOOR);
    s += len;
  }
  for (const [key, b] of byKey) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    push(out, key, g);
  }
}

/** 平面 pts を y0〜y1 に立てた壁と、上の平らな屋根 */
function prism(
  out: Lists,
  cx: number,
  pts: P2[],
  y0: number,
  y1: number,
  pick: Pick,
  roof: MinatoKey | null = 'roofTop',
): void {
  walls(out, cx, pts, y0, () => y1, pick);
  if (roof) push(out, roof, cap(cx, pts, y1));
}

/** 平面 pts の平らな面（高さ y） */
function cap(cx: number, pts: P2[], y: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, v)));
  const g = new THREE.ShapeGeometry(shape).toNonIndexed();
  g.rotateX(-Math.PI / 2);
  g.translate(cx, y, 0);
  return g;
}

/** 平面 pts の斜めの屋根（高さは top(u, v)。一次式なら平らな斜面になる） */
function slopedCap(cx: number, pts: P2[], top: (u: number, v: number) => number): THREE.BufferGeometry {
  const g = cap(cx, pts, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, top(p.getX(i) - cx, -p.getZ(i)));
  g.computeVertexNormals();
  return g;
}

/** 下の平面 lower（y0）から上の平面 upper（y1）へすぼまる壁（2つの平面は同じ数の頂点） */
function taper(out: Lists, cx: number, lower: P2[], upper: P2[], y0: number, y1: number, key: MinatoKey): void {
  const pos: number[] = [];
  const uv: number[] = [];
  let s = 0;
  for (let i = 0; i < lower.length; i++) {
    const j = (i + 1) % lower.length;
    const len = Math.hypot(lower[j][0] - lower[i][0], lower[j][1] - lower[i][1]);
    const A = [cx + lower[i][0], y0, -lower[i][1]];
    const B = [cx + lower[j][0], y0, -lower[j][1]];
    const C = [cx + upper[j][0], y1, -upper[j][1]];
    const D = [cx + upper[i][0], y1, -upper[i][1]];
    pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    const s0 = s / PANEL;
    const s1 = (s + len) / PANEL;
    uv.push(s0, y0 / FLOOR, s1, y0 / FLOOR, s1, y1 / FLOOR, s0, y0 / FLOOR, s1, y1 / FLOOR, s0, y1 / FLOOR);
    s += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  push(out, key, g);
}

/** 平面 pts を外へ d m 広げた（縮めた）形。角の二等分線の向きに動かす */
function offset(pts: P2[], d: number): P2[] {
  return pts.map((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length];
    const b = pts[(i + 1) % pts.length];
    const n1 = normal(a, p);
    const n2 = normal(p, b);
    const mu = n1[0] + n2[0];
    const mv = n1[1] + n2[1];
    const m = Math.hypot(mu, mv) || 1;
    const k = d / Math.max(0.3, (mu * n1[0] + mv * n1[1]) / m);
    return [p[0] + (mu / m) * k, p[1] + (mv / m) * k];
  });
}
function normal(a: P2, b: P2): P2 {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
}

/** 横の帯（平面 pts を少し広げて、高さ y0〜y1） */
function band(out: Lists, cx: number, pts: P2[], y0: number, y1: number, grow = 0.4, key: MinatoKey = 'white') {
  prism(out, cx, offset(pts, grow), y0, y1, () => key, null);
}

/** 屋上の設備などの箱（中心 u, v、大きさ w × d、高さ y0〜y1） */
function block(out: Lists, cx: number, u: number, v: number, w: number, d: number, y0: number, y1: number, key: MinatoKey = 'white') {
  prism(out, cx, rect(u - w / 2, u + w / 2, v - d / 2, v + d / 2), y0, y1, () => key, key === 'white' ? 'white' : 'roofTop');
}

/** 屋上のヘリポート（中心 u, v、一辺 size、高さ y） */
function heliport(out: Lists, cx: number, u: number, v: number, size: number, y: number) {
  const pad = new THREE.BoxGeometry(size, 0.5, size).toNonIndexed();
  pad.translate(cx + u, y + 0.25, -v);
  push(out, 'heli', pad);
}

/** 屋上の緑（平面 pts を内へ inset m 縮めて、高さ y） */
function garden(out: Lists, cx: number, pts: P2[], y: number, inset = 1) {
  push(out, 'green', cap(cx, offset(pts, -inset), y + 0.15));
}

const P = (cx: number, u: number, y: number, v: number) => new THREE.Vector3(cx + u, y, -v);

function finish(out: Lists): MinatoParts {
  const parts: MinatoParts = {};
  for (const [key, list] of Object.entries(out) as Array<[MinatoKey, THREE.BufferGeometry[]]>) {
    const prepared = list.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(name)) n.deleteAttribute(name);
      if (!n.getAttribute('normal')) n.computeVertexNormals();
      if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
      return n;
    });
    parts[key] = mergeGeometries(prepared)!;
  }
  return parts;
}

// ---------------------------------------------------------------- 横浜ランドマークタワー
// 座標：中心は OpenStreetMap の塔の形の中心、u = 東から北へ 33°、v = 北北西

/** 塔の中心（OpenStreetMap の形の中心からのずれ） */
const LM_C: P2 = [4, -2.5];
/** 塔の半分の幅：足元の 37m から 200m の高さで 30m へ細くなる */
const lmHalf = (y: number) => 37 - (7 * Math.min(y, 200)) / 200;

/** 角を段に切り欠いた正方形（中心 c、半分の幅 a、切り欠き n）。反時計回り */
function notchedSquare([cu, cv]: P2, a: number, n: number): P2[] {
  return [
    [cu + a - n, cv - a],
    [cu + a - n, cv - a + n],
    [cu + a, cv - a + n],
    [cu + a, cv + a - n],
    [cu + a - n, cv + a - n],
    [cu + a - n, cv + a],
    [cu - a + n, cv + a],
    [cu - a + n, cv + a - n],
    [cu - a, cv + a - n],
    [cu - a, cv - a + n],
    [cu - a + n, cv - a + n],
    [cu - a + n, cv - a],
  ];
}

/** 塔の4つの面の真ん中に貼る縦の帯（半分の幅 w、高さ y0〜y1。面は塔のすぼまりに沿う） */
function lmFacePanels(out: Lists, cx: number, y0: number, y1: number, w: number, key: MinatoKey, lift = 0.3) {
  const [cu, cv] = LM_C;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const [nu, nv] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]) {
    const tu = -nv;
    const tv = nu;
    const at = (t: number, y: number) => {
      const d = lmHalf(y) + lift;
      return [cx + cu + nu * d + tu * t, y, -(cv + nv * d + tv * t)];
    };
    pos.push(...at(-w, y0), ...at(w, y0), ...at(w, y1), ...at(-w, y0), ...at(w, y1), ...at(-w, y1));
    const s1 = (2 * w) / PANEL;
    uv.push(0, y0 / FLOOR, s1, y0 / FLOOR, s1, y1 / FLOOR, 0, y0 / FLOOR, s1, y1 / FLOOR, 0, y1 / FLOOR);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  push(out, key, g);
}

/** 段の境目の白い三角の飾り（下向きの三角を面の真ん中に並べる。高さ y が三角の下の頂点） */
function lmChevrons(out: Lists, cx: number, y: number, count: number, size: number) {
  const [cu, cv] = LM_C;
  const pos: number[] = [];
  for (const [nu, nv] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]) {
    const tu = -nv;
    const tv = nu;
    const d = lmHalf(y) + 0.6;
    const at = (t: number, yy: number) => [cx + cu + nu * d + tu * t, yy, -(cv + nv * d + tv * t)];
    for (let k = 0; k < count; k++) {
      const t = (k - (count - 1) / 2) * size;
      pos.push(...at(t - size / 2, y + size), ...at(t, y), ...at(t + size / 2, y + size));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  push(out, 'white', g);
}

/** ランドマークプラザ（OpenStreetMap の形） */
const LM_PLAZA: P2[] = [
  [-68.5, 62],
  [-66, 62],
  [-66, 51.5],
  [-65.5, 41.5],
  [-68, 41],
  [-67.5, 18.5],
  [-50.5, 18.5],
  [-50, 30],
  [-32, 29.5],
  [-32, 34.5],
  [-22, 34.5],
  [-16.5, 30],
  [25, 30],
  [28.5, 35],
  [41, 35],
  [41, 29],
  [44.5, 29],
  [45, 19.5],
  [135.5, 21],
  [136, 74.5],
  [122.5, 74.5],
  [89.5, 74],
  [78.5, 74],
  [78, 113],
  [71, 113],
  [70.5, 116.5],
  [61.5, 116.5],
  [61.5, 113.5],
  [44, 112.5],
  [43, 123],
  [-37.5, 122],
  [-37.5, 112],
  [-67.5, 111.5],
];

export function buildLandmarkTower(cx: number): MinatoParts {
  const out: Lists = {};
  const [cu, cv] = LM_C;
  const CROWN = 268;
  // ---- 塔の本体：200m まで細くなり、その上はまっすぐ ----
  taper(out, cx, notchedSquare(LM_C, lmHalf(0), 5), notchedSquare(LM_C, lmHalf(200), 4), 0, 200, 'lmStone');
  prism(out, cx, notchedSquare(LM_C, lmHalf(200), 4), 200, CROWN, () => 'lmStone', null);
  // 面の真ん中：下は濃い横の帯の縦の帯、上は深い溝のガラス
  lmFacePanels(out, cx, 14, 196, 10, 'lmBay');
  lmFacePanels(out, cx, 200, CROWN, 10, 'lmGlass', -1.5);
  // 溝の両側の壁（溝を深く見せる）
  for (const [nu, nv] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]) {
    for (const side of [-1, 1]) {
      const tu = -nv * side * 10;
      const tv = nu * side * 10;
      const a = lmHalf(200);
      const g: P2[] = [
        [cu + nu * (a - 1.5) + tu, cv + nv * (a - 1.5) + tv],
        [cu + nu * (a + 0.2) + tu, cv + nv * (a + 0.2) + tv],
      ];
      const pos = [
        ...[cx + g[0][0], 200, -g[0][1]],
        ...[cx + g[1][0], 200, -g[1][1]],
        ...[cx + g[1][0], CROWN, -g[1][1]],
        ...[cx + g[0][0], 200, -g[0][1]],
        ...[cx + g[1][0], CROWN, -g[1][1]],
        ...[cx + g[0][0], CROWN, -g[0][1]],
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      push(out, 'lmStone', geo);
    }
  }
  // 段の境目の白い三角の飾り（足元・中ほど・細くなり終わる所）
  lmChevrons(out, cx, 8, 5, 4);
  lmChevrons(out, cx, 112, 5, 4);
  lmChevrons(out, cx, 194, 5, 4);
  // ---- 頂部：四隅が立ち上がり、間は低いガラスと展望フロアの箱 ----
  const a = lmHalf(200);
  for (const [su, sv] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    const u0 = Math.min(cu + su * (a - 15), cu + su * a);
    const u1 = Math.max(cu + su * (a - 15), cu + su * a);
    const v0 = Math.min(cv + sv * (a - 15), cv + sv * a);
    const v1 = Math.max(cv + sv * (a - 15), cv + sv * a);
    prism(out, cx, rect(u0, u1, v0, v1), CROWN, 296, () => 'lmStone');
    band(out, cx, rect(u0, u1, v0, v1), 294.5, 296.3, 0.2);
  }
  prism(out, cx, rect(cu - 15, cu + 15, cv - a + 1.5, cv + a - 1.5), CROWN, 282, () => 'lmGlass');
  prism(out, cx, rect(cu - a + 1.5, cu + a - 1.5, cv - 15, cv + 15), CROWN, 282, () => 'lmGlass');
  prism(out, cx, rect(cu - 15, cu + 15, cv - 13, cv + 13), 282, 290, () => 'lmStone');
  band(out, cx, notchedSquare(LM_C, a, 4), CROWN - 1, CROWN + 1, 0.3);
  block(out, cx, cu - 5, cv + 2, 10, 8, 290, 293.5);
  block(out, cx, cu + 6, cv - 4, 6, 6, 290, 292.5, 'roofTop');
  // ---- 足元：南南東の面の前のガラスの入口と、黒いピラミッドの屋根の小塔 ----
  const front = cv - lmHalf(0);
  prism(out, cx, rect(cu - 10, cu + 10, front - 5, front + 1), 0, 14, () => 'lmGlass');
  for (const [du, h] of [
    [-58, 34],
    [-41, 42],
    [41, 40],
    [58, 33],
  ]) {
    const u = cu + du;
    const v = front - 9;
    prism(out, cx, rect(u - 7.5, u + 7.5, v - 7.5, v + 7.5), 0, h, () => 'lmPavilion');
    band(out, cx, rect(u - 7.5, u + 7.5, v - 7.5, v + 7.5), h - 1, h + 0.5, 0.5);
    const roof = new THREE.ConeGeometry(7.5 * Math.SQRT2 + 0.6, 9, 4, 1).toNonIndexed();
    roof.rotateY(Math.PI / 4);
    roof.translate(cx + u, h + 0.5 + 4.5, -v);
    push(out, 'dark', roof);
  }
  // 小塔をつなぐ低い棟
  for (const side of [-1, 1]) {
    const u0 = cu + side * 34;
    const u1 = cu + side * 66;
    prism(out, cx, rect(Math.min(u0, u1), Math.max(u0, u1), front - 15, front - 3), 0, 20, () => 'lmPavilion');
  }
  // ---- ランドマークプラザ（北北西）：白っぽい壁に緑がかったガラスの帯 ----
  prism(out, cx, LM_PLAZA, 0, 27, () => 'lmPlaza');
  band(out, cx, LM_PLAZA, 26.5, 29, 0.5);
  garden(out, cx, rect(60, 120, 30, 68), 27, 0);
  return finish(out);
}

// ---------------------------------------------------------------- クイーンズスクエア横浜
// 座標：中心は B 棟の中心、u = 東から北へ 33°、v = 北北西

const QUEENS: Array<{ pts: P2[]; h: number }> = [
  {
    // A 棟
    pts: [
      [-116.5, -1],
      [-119, -3],
      [-119.5, -6],
      [-119, -9],
      [-116.5, -11],
      [-116.5, -45.5],
      [-62, -45.5],
      [-59.5, -43],
      [-58.5, -40],
      [-59.5, -37],
      [-62, -34],
      [-62, -1],
    ],
    h: 172,
  },
  {
    // B 棟
    pts: [
      [-48.5, 30.5],
      [-48, -13],
      [13, -12.5],
      [15, -10.5],
      [16, -7.5],
      [15, -4],
      [13, -2],
      [12.5, 31.5],
    ],
    h: 138,
  },
  {
    // C 棟
    pts: [
      [26, 63.5],
      [24, 62],
      [23.5, 59.5],
      [24, 57.5],
      [26, 55.5],
      [26, 20.5],
      [94.5, 20.5],
      [96, 22],
      [97.5, 24.5],
      [96.5, 27],
      [94.5, 29.5],
      [94, 64],
    ],
    h: 109,
  },
];

export function buildQueensSquare(cx: number): MinatoParts {
  const out: Lists = {};
  for (const { pts, h } of QUEENS) {
    const us = pts.map((p) => p[0]);
    const vs = pts.map((p) => p[1]);
    const u0 = Math.min(...us);
    const u1 = Math.max(...us);
    const vm = (Math.min(...vs) + Math.max(...vs)) / 2;
    const um = (u0 + u1) / 2;
    // 下の 30m は少し張り出す
    prism(out, cx, pts, 0, 30, () => 'qsTower', 'roofTop');
    band(out, cx, pts, 29, 30.5, 0.4);
    // 上の縁：長い面の真ん中がへこんだ曲線（両端が高い）
    const body = offset(pts, -1.5);
    const DIP = 9;
    const top = (u: number) => h - DIP * Math.sin(Math.PI * Math.min(1, Math.max(0, (u - u0) / (u1 - u0))));
    walls(out, cx, densify(body, 3), 30, (u) => top(u), () => 'qsTower');
    // 屋上は縁の一番低い所より下の平らな面。ヘリポートと設備
    const roofY = h - DIP - 1.5;
    push(out, 'roofTop', cap(cx, body, roofY));
    heliport(out, cx, um, vm, 20, roofY);
    block(out, cx, u0 + 9, vm, 8, 14, roofY, roofY + 5);
    block(out, cx, u1 - 9, vm, 8, 14, roofY, roofY + 5);
  }
  return finish(out);
}

// ---------------------------------------------------------------- ヨコハマ グランド インターコンチネンタル ホテル
// 座標：中心は OpenStreetMap のホテルの形の中心、u = 東から北へ 33°（海の向き）、v = 北北西

/** 帆の板の高さ：南の端（v = -45）の 140m から、北の端（v = 35.5）の 66m へ弧を描いて下がる */
const sailHeight = (v: number) => (v <= -40 ? 140 : 66 + 74 * Math.sqrt(Math.max(0, 1 - ((v + 40) / 75.5) ** 2)));
const SAIL_V0 = -45;
const SAIL_V1 = 35.5;

/** パシフィコ横浜の、ホテルを囲む低層部（OpenStreetMap の形） */
const PACIFICO_LOW: P2[] = [
  [-13.5, 34],
  [-101, 27.5],
  [-102.5, -31.5],
  [-102, -36.5],
  [-99.5, -40],
  [-96, -42],
  [-92, -43.5],
  [-60, -43.5],
  [-37, -43],
  [-14, -40],
  [12.5, -32.5],
  [23.5, -26.5],
  [25, -23],
  [27, -20],
  [29.5, -15.5],
  [29.5, -13],
  [33, -9],
  [33.5, -7],
  [37, -1],
  [37.5, 2],
  [40.5, 7.5],
  [41.5, 10],
  [42.5, 16],
  [41.5, 19],
  [9.5, 54],
];

/** 会議センター（OpenStreetMap の形）：南の面が弧を描く */
const PACIFICO_HALL: P2[] = [
  [-91, 15],
  [-30.5, 15.5],
  [-9.5, 20.5],
  [3.5, 27.5],
  [16, 37.5],
  [24, 47],
  [2, 66],
  [-5, 59],
  [-15.5, 51.5],
  [-27, 47],
  [-38.5, 45],
  [-88.5, 44],
  [-92.5, 43],
  [-96.5, 41],
  [-99.5, 38],
  [-101.5, 35.5],
  [-102.5, 32.5],
  [-103.5, 29],
  [-103, 26],
  [-102.5, 23],
  [-101, 19.5],
  [-98, 17],
  [-94.5, 15.5],
];

export function buildInterContinental(cx: number): MinatoParts {
  const out: Lists = {};
  // ---- 帆の板（u 5〜21）：両面は客室の窓の格子、上の弧は白い縁 ----
  const slab = rect(5, 21, SAIL_V0, SAIL_V1);
  walls(out, cx, densify(slab, 2.5), 0, (_u, v) => sailHeight(v), () => 'ichSail');
  {
    const pos: number[] = [];
    const N = 32;
    for (let i = 0; i < N; i++) {
      const v0 = SAIL_V0 + ((SAIL_V1 - SAIL_V0) * i) / N;
      const v1 = SAIL_V0 + ((SAIL_V1 - SAIL_V0) * (i + 1)) / N;
      const y0 = sailHeight(v0) + 0.6;
      const y1 = sailHeight(v1) + 0.6;
      // 縁は板より少し外へ出す
      pos.push(cx + 4.4, y0, -v0, cx + 21.6, y0, -v0, cx + 21.6, y1, -v1, cx + 4.4, y0, -v0, cx + 21.6, y1, -v1, cx + 4.4, y1, -v1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    push(out, 'white', g);
  }
  // 縁の厚み（両側の白い帯）
  for (const u of [4.4, 21.6]) {
    const pos: number[] = [];
    const N = 32;
    for (let i = 0; i < N; i++) {
      const v0 = SAIL_V0 + ((SAIL_V1 - SAIL_V0) * i) / N;
      const v1 = SAIL_V0 + ((SAIL_V1 - SAIL_V0) * (i + 1)) / N;
      const a = sailHeight(v0) + 0.6;
      const b = sailHeight(v1) + 0.6;
      pos.push(cx + u, a - 3, -v0, cx + u, b - 3, -v1, cx + u, b, -v1, cx + u, a - 3, -v0, cx + u, b, -v1, cx + u, a, -v0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    push(out, 'white', g);
  }
  // 南の端の白い縦のひれ（一番高い所）
  prism(out, cx, rect(4, 22, SAIL_V0 - 1.5, SAIL_V0), 0, 143, () => 'white', 'white');

  // ---- 板の両側の足元：曲線の白い段々のテラス ----
  const terraces: Array<[number, number, number, number, number[]]> = [
    // 中心 u, v、扇の角度（度）、各段の半径
    [5, -5, 90, 270, [30, 24, 18, 12]],
    [21, -5, -90, 90, [20, 15, 10]],
  ];
  for (const [u, v, a0, a1, radii] of terraces) {
    radii.forEach((r, k) => {
      const y0 = 16 + k * 5;
      prism(out, cx, sector(u, v, r, a0, a1), y0, y0 + 5, () => 'ichLow', 'white');
      band(out, cx, sector(u, v, r, a0, a1), y0 + 4.2, y0 + 5.2, 0.3);
    });
  }

  // ---- パシフィコ横浜の低層部（16m）・会議センター（34m）・北の棟（20m） ----
  prism(out, cx, PACIFICO_LOW, 0, 16, () => 'ichLow');
  band(out, cx, PACIFICO_LOW, 15.5, 16.8, 0.4);
  garden(out, cx, rect(-80, -40, -30, 10), 16, 0);
  prism(out, cx, PACIFICO_HALL, 0, 34, () => 'ichHall');
  band(out, cx, PACIFICO_HALL, 33.5, 35.5, 0.5);
  block(out, cx, -60, 30, 20, 12, 34, 38);
  const north: P2[] = [
    [5.5, 72],
    [2, 66],
    [24, 47],
    [31, 56.5],
    [37, 70],
    [9, 81],
  ];
  prism(out, cx, north, 0, 20, () => 'ichLow');
  garden(out, cx, north, 20, 3);
  return finish(out);
}

// ---------------------------------------------------------------- 横浜メディアタワー
// 座標：中心は OpenStreetMap の形の中心、u = 東から北へ 33°、v = 北北西

export function buildMediaTower(cx: number): MinatoParts {
  const out: Lists = {};
  // ---- 手前の四角い棟（110m）：灰色の格子。屋上に鉄塔 ----
  const front = rect(-29, 7, -35, -1);
  prism(out, cx, front, 0, 110, () => 'mediaBlock');
  band(out, cx, front, 109, 111, 0.3);
  block(out, cx, -24, -30, 6, 6, 110, 114);
  block(out, cx, 2, -6, 6, 8, 110, 113.5);
  // ---- 後ろの棟（122m）：東の端が丸い、白に横の窓の帯。屋上は白い縁 ----
  const back = rounded(-29, 44, -1, 24.5, [0, 12.5, 12.5, 0]);
  prism(out, cx, back, 0, 122, () => 'mediaDrum');
  band(out, cx, back, 120.5, 123, 0.4);
  block(out, cx, 10, 12, 18, 12, 122, 127);
  // ---- 東の低い棟（28m） ----
  prism(out, cx, rect(7, 44, -35, -1), 0, 28, () => 'mediaBlock');
  band(out, cx, rect(7, 44, -35, -1), 27.5, 29, 0.3);

  // ---- 鉄塔（110m の屋上から 250m まで）：4本の柱と、10m おきの横の枠と筋かい ----
  const [mu, mv] = [-11, -18];
  const Y0 = 110;
  const Y1 = 250;
  const half = (y: number) => 7 - (2.5 * (y - Y0)) / (Y1 - Y0);
  const steel: THREE.BufferGeometry[] = [];
  const corner = (y: number, su: number, sv: number) => P(cx, mu + su * half(y), y, mv + sv * half(y));
  const CORNERS: Array<[number, number]> = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  for (const [su, sv] of CORNERS) beam(steel, corner(Y0, su, sv), corner(Y1, su, sv), 1.1);
  for (let y = Y0; y < Y1; y += 10) {
    const y1 = Math.min(Y1, y + 10);
    for (let k = 0; k < 4; k++) {
      const [au, av] = CORNERS[k];
      const [bu, bv] = CORNERS[(k + 1) % 4];
      beam(steel, corner(y1, au, av), corner(y1, bu, bv), 0.6);
      beam(steel, corner(y, au, av), corner(y1, bu, bv), 0.35);
      beam(steel, corner(y, bu, bv), corner(y1, au, av), 0.35);
    }
  }
  beam(steel, P(cx, mu, Y1, mv), P(cx, mu, Y1 + 3, mv), 0.6);
  for (const g of steel) push(out, 'steel', g);
  // 鉄塔の青いガラスの段（下の展望の段と、上の段）
  for (const [y0, y1] of [
    [114, 142],
    [226, 240],
  ]) {
    const h = half((y0 + y1) / 2) - 0.6;
    const glass = new THREE.BoxGeometry(2 * h, y1 - y0, 2 * h).toNonIndexed();
    glass.translate(cx + mu, (y0 + y1) / 2, -mv);
    push(out, 'skyGlass', glass);
    band(out, cx, rect(mu - h, mu + h, mv - h, mv + h), y1, y1 + 1, 0.4);
  }
  return finish(out);
}

// ---------------------------------------------------------------- 横浜シンフォステージ
// 座標：中心は2つの塔の間、u = 東、v = 北

const SYM_WEST: P2[] = [
  [-48.5, 14.5],
  [-48.5, 16.5],
  [-92, 16],
  [-92, -5.5],
  [-96.5, -5.5],
  [-96.5, -18.5],
  [-91.5, -18.5],
  [-91.5, -40],
  [-9, -39],
  [-9.5, -36],
  [-7.5, -36],
  [-8, -17.5],
  [-3.5, -17.5],
  [-3.5, -5],
  [-8, -5],
  [-8, 15],
];
const SYM_EAST: P2[] = [
  [19, 1.5],
  [23, 1.5],
  [23, -16.5],
  [43, -16.5],
  [43, -18.5],
  [77, -18.5],
  [76.5, 50],
  [51, 50],
  [51, 53.5],
  [18.5, 53.5],
];

export function buildSymphoStage(cx: number): MinatoParts {
  const out: Lists = {};
  // ---- ウエストタワー：紺のガラスに細い白い横の線、東の面は白い縦のフィン ----
  const westPick: Pick = (nu) => (nu > 0.5 ? 'symFin' : 'symWest');
  // 南の手前（140m、屋上は緑）と、北の奥（161m、上の 30m は明るい枠に暗い窓）
  const south = clip(SYM_WEST, (_u, v) => -6 - v);
  const north = clip(SYM_WEST, (_u, v) => v + 6);
  prism(out, cx, south, 0, 140, westPick);
  band(out, cx, south, 139, 141.5, 0.4);
  garden(out, cx, south, 140, 3);
  prism(out, cx, north, 0, 131, westPick, null);
  prism(out, cx, north, 131, 161, () => 'symGrid');
  band(out, cx, north, 160, 162, 0.4);
  block(out, cx, -50, 5, 30, 12, 161, 166);
  // ---- イーストタワー（90m）：南の面は白い縦のフィン ----
  prism(out, cx, SYM_EAST, 0, 90, (_nu, nv) => (nv < -0.5 ? 'symFin' : 'symWest'));
  band(out, cx, SYM_EAST, 89, 91.5, 0.4);
  block(out, cx, 48, 20, 22, 18, 90, 95);
  block(out, cx, 35, 40, 10, 8, 90, 93, 'roofTop');
  return finish(out);
}

// ---------------------------------------------------------------- みなとみらいグランドセントラルタワー
// 座標：中心は OpenStreetMap の塔の形の中心、u = 東から北へ 33°、v = 北北西

const GCT_TOWER: P2[] = [
  [-30.5, 22.5],
  [-30.5, 17],
  [-36, 17],
  [-36, -16.5],
  [-30, -16.5],
  [-30, -22.5],
  [41.5, -22.5],
  [41.5, -16.5],
  [48.5, -16.5],
  [48.5, 17.5],
  [41.5, 17.5],
  [41.5, 23],
];
const GCT_TERRACE: P2[] = [
  [27, -22.5],
  [27, -32],
  [25, -32],
  [25, -45.5],
  [40.5, -45.5],
  [40.5, -47],
  [46, -47],
  [46, -44],
  [59.5, -44],
  [59.5, 21],
  [60.5, 21],
  [60, 48],
  [-36, 47.5],
  [-36, 37.5],
  [-32, 37.5],
  [-32, 27],
  [-28, 27],
  [-28, 22.5],
  [41.5, 23],
  [41.5, 17.5],
  [48.5, 17.5],
  [48.5, -16.5],
  [41.5, -16.5],
  [41.5, -22.5],
];

export function buildGrandCentralTower(cx: number): MinatoParts {
  const out: Lists = {};
  // 長い面は青いガラスに横の線、短い面は灰色の縦の縞
  prism(out, cx, GCT_TOWER, 0, 118, (_nu, nv) => (Math.abs(nv) > 0.5 ? 'gctGlass' : 'gctStripe'));
  band(out, cx, GCT_TOWER, 117, 119.5, 0.3, 'gctCrown');
  // 屋上：ベージュの塔屋と、まわりの緑
  prism(out, cx, rect(-8, 24, -12, 12), 119.5, 126, () => 'gctCrown', 'white');
  garden(out, cx, rect(-32, -12, -18, 18), 118, 0);
  garden(out, cx, rect(28, 44, -14, 14), 118, 0);
  // テラスの低層部（14m）：屋上に緑
  prism(out, cx, GCT_TERRACE, 0, 14, () => 'gctTerrace');
  band(out, cx, GCT_TERRACE, 13.5, 15, 0.3);
  garden(out, cx, rect(-30, 20, 28, 44), 14, 0);
  garden(out, cx, rect(50, 57, -40, 40), 14, 0);
  return finish(out);
}

// ---------------------------------------------------------------- 横浜コネクトスクエア
// 座標：中心は OpenStreetMap の敷地の中心、u = 東から北へ 33°、v = 北北西

export function buildConnectSquare(cx: number): MinatoParts {
  const out: Lists = {};
  // 南の低い棟（22m）
  const low = rect(-45, 45, -45, -6);
  prism(out, cx, low, 0, 22, () => 'conLow');
  band(out, cx, low, 21.5, 23, 0.3);
  garden(out, cx, rect(-40, 0, -40, -12), 22, 0);
  // 塔：下の 98m は黒に細い白い縦の線
  const tower = rect(-33, 33, -6, 38);
  prism(out, cx, tower, 0, 98, () => 'conDark', null);
  // 境目：白い棚と、その上の暗い溝
  band(out, cx, tower, 98, 99.6, 2.2);
  push(out, 'white', cap(cx, offset(tower, 2.2), 99.6));
  prism(out, cx, offset(tower, -1), 99.6, 103.5, () => 'dark', null);
  // 上の 43m：少し張り出した白い横の帯
  const upper = offset(tower, 1.2);
  prism(out, cx, upper, 103.5, 145, () => 'conWhite');
  band(out, cx, upper, 145, 146.5, 0.2);
  block(out, cx, -14, 16, 18, 14, 145, 150);
  block(out, cx, 12, 14, 12, 10, 145, 149, 'roofTop');
  return finish(out);
}

// ---------------------------------------------------------------- KDX横浜みなとみらいタワー
// 座標：中心は OpenStreetMap の塔の形の中心、u = 東から北へ 33°、v = 北北西

const KDX_PODIUM: P2[][] = [
  [
    [-33.5, 31.5],
    [-33.5, -27],
    [-19, -27],
    [-19, -20],
    [-26.5, -20],
    [-26.5, 20],
    [-19, 20],
    [-19, 26.5],
    [19, 27],
    [19, 20],
    [26.5, 20],
    [26.5, -20],
    [19, -20],
    [19, -26.5],
    [34, -26.5],
    [34, 32],
    [25.5, 32],
    [25.5, 39.5],
    [-25.5, 39.5],
    [-25, 31.5],
  ],
  [
    [-33.5, -42],
    [-22, -42.5],
    [-21.5, -36],
    [-12.5, -36],
    [-12.5, -49.5],
    [-8.5, -52.5],
    [-2.5, -54],
    [4, -54],
    [9.5, -52.5],
    [12.5, -49.5],
    [13, -36],
    [22.5, -36],
    [22.5, -42],
    [34, -41],
    [34, -26.5],
    [19, -26.5],
    [-33.5, -27],
  ],
];

export function buildKdxTower(cx: number): MinatoParts {
  const out: Lists = {};
  // ---- 塔：十字の平面。切り欠きの奥の面は青いガラス ----
  const H = 145;
  prism(out, cx, rect(-19, 19, -27, 27), 0, H, (nu) => (Math.abs(nu) > 0.5 ? 'kdxBlue' : 'kdxWhite'));
  prism(out, cx, rect(-26.5, 26.5, -20, 20), 0, H, (_nu, nv) => (Math.abs(nv) > 0.5 ? 'kdxBlue' : 'kdxWhite'));
  band(out, cx, rect(-19, 19, -27, 27), H - 1, H + 1, 0.3);
  band(out, cx, rect(-26.5, 26.5, -20, 20), H - 1, H + 1, 0.3);
  // 屋上：一段引っ込んだ2階分と、その上のヘリポート・隅の箱
  prism(out, cx, rect(-16, 16, -23, 23), H + 1, 151, () => 'kdxWhite', null);
  prism(out, cx, rect(-23, 23, -16, 16), H + 1, 151, () => 'kdxWhite', null);
  push(out, 'roofTop', cap(cx, rect(-16, 16, -23, 23), 151));
  push(out, 'roofTop', cap(cx, rect(-23, 23, -16, 16), 151));
  band(out, cx, rect(-16, 16, -23, 23), 150.5, 152, 0.3);
  heliport(out, cx, 0, 0, 22, 151.5);
  block(out, cx, -20, 12, 5, 6, 151, 155);
  block(out, cx, 20, -12, 5, 6, 151, 155);
  // 北北西の面の上の赤いロゴ
  const logo = new THREE.BoxGeometry(5, 4, 0.4).toNonIndexed();
  logo.translate(cx - 6, H - 8, -27.3);
  push(out, 'red', logo);
  // ---- 足元の低層部（12m）：アーチの窓。四隅に小さな塔屋 ----
  for (const pts of KDX_PODIUM) {
    prism(out, cx, pts, 0, 12, () => 'kdxPodium');
    band(out, cx, pts, 11.5, 13, 0.4);
  }
  garden(out, cx, rect(-30, -21, -24, 28), 12, 0);
  garden(out, cx, rect(21, 31, -24, 28), 12, 0);
  for (const [u, v] of [
    [-29, 35],
    [29, 35],
    [-29, -38],
    [29, -38],
  ]) {
    block(out, cx, u, v, 8, 8, 12, 17, 'kdxPodium');
    band(out, cx, rect(u - 4, u + 4, v - 4, v + 4), 16.5, 17.5, 0.3);
  }
  return finish(out);
}

// ---------------------------------------------------------------- 横浜三井ビルディング
// 座標：中心は OpenStreetMap の形の中心、u = 東、v = 北

const MITSUI: P2[] = [
  [19, 15.5],
  [12, 27.5],
  [7.5, 33],
  [-46, 8.5],
  [-46, 0],
  [-45.5, -8.5],
  [-45, -12.5],
  [-42, -25],
  [39, -25.5],
  [39, 9],
  [21.5, 9],
];

export function buildYokohamaMitsui(cx: number): MinatoParts {
  const out: Lists = {};
  // 屋根は北へ上がる斜めの面（南の縁 140m → 北の角 152.6m）
  const top = (_u: number, v: number) => 140 + (12.6 * (v + 25.5)) / 58.5;
  walls(out, cx, MITSUI, 0, top, () => 'mitsuiGlass');
  // 縁の白い帯と、斜めの屋根
  prismBand(out, cx, offset(MITSUI, 0.3), top);
  push(out, 'roofTop', slopedCap(cx, MITSUI, top));
  block(out, cx, -5, 5, 14, 10, top(0, 5) - 2, top(0, 5) + 3);
  return finish(out);
}

/** 斜めの屋根の縁の白い帯（上の縁 top より 1.2m 下から 1.2m 上まで） */
function prismBand(out: Lists, cx: number, pts: P2[], top: (u: number, v: number) => number) {
  const byTop: Lists = {};
  walls(byTop, cx, pts, 0, (u, v) => top(u, v) + 1.2, () => 'white');
  // 下の縁を top - 1.2 に上げる
  for (const g of byTop.white ?? []) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) === 0) p.setY(i, top(p.getX(i) - cx, -p.getZ(i)) - 1.2);
    }
    push(out, 'white', g);
  }
}

// ---------------------------------------------------------------- 材質

/** ランドマークタワーの外壁：明るい灰色の石に、暗い横の窓の帯 */
export function createLandmarkStoneMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#c9c7c1';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#2f3a46';
      g.fillRect(0, H * 0.52, W, H * 0.2);
      g.fillStyle = 'rgba(160,185,205,0.35)';
      g.fillRect(0, H * 0.52, W, H * 0.06);
      g.fillStyle = '#e3e2dd';
      g.fillRect(0, H * 0.74, W, 3);
    },
    0.7,
    0.1,
  );
}

/** ランドマークタワーの面の真ん中の縦の帯：窓の帯が太く、暗く見える */
export function createLandmarkBayMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#b9b8b3';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#29323c';
      g.fillRect(0, H * 0.3, W, H * 0.46);
      g.fillStyle = 'rgba(150,175,195,0.3)';
      g.fillRect(0, H * 0.3, W, H * 0.1);
      g.fillStyle = 'rgba(40,40,40,0.4)';
      g.fillRect(W - 2, H * 0.3, 2, H * 0.46);
    },
    0.5,
    0.2,
  );
}

/** ランドマークタワーの上の溝・頂部の暗いガラス */
export function createLandmarkGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#3c4b57';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(170,195,215,0.25)';
      g.fillRect(0, 0, W, H * 0.4);
      g.fillStyle = '#8d9396';
      g.fillRect(0, H - 4, W, 4);
      g.fillRect(0, 0, 2, H);
    },
    0.15,
    0.45,
  );
}

/** ランドマークプラザ：白っぽい壁に、緑がかったガラスの帯 */
export function createLandmarkPlazaMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#e2ddd0';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#6f9184';
      g.fillRect(0, H * 0.3, W, H * 0.3);
      g.fillStyle = 'rgba(210,230,220,0.3)';
      g.fillRect(0, H * 0.3, W, H * 0.08);
    },
    0.6,
    0.1,
  );
}

/** ランドマークタワーの足元の小塔：ベージュに細い横の線と、小さな窓 */
export function createLandmarkPavilionMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#d8d1c2';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#9c968a';
      g.fillRect(0, H * 0.18, W, 3);
      g.fillRect(0, H * 0.82, W, 3);
      g.fillStyle = '#3d4248';
      g.fillRect(W * 0.38, H * 0.38, W * 0.24, H * 0.3);
    },
    0.8,
    0,
  );
}

/** クイーンズスクエアの塔：白い横の帯と、薄い青灰色の横長の窓 */
export function createQueensTowerMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#e9eae8';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#8197a8';
      g.fillRect(0, H * 0.48, W, H * 0.24);
      g.fillStyle = 'rgba(70,80,90,0.35)';
      g.fillRect(0, H * 0.72, W, 2);
    },
    0.5,
    0.1,
  );
}

/** インターコンチネンタルの帆の板：白い格子に、客室の窓が1枚に2つ */
export function createSailMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#ebedec';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#5d7489';
      g.fillRect(W * 0.08, H * 0.22, W * 0.36, H * 0.5);
      g.fillRect(W * 0.56, H * 0.22, W * 0.36, H * 0.5);
      g.fillStyle = 'rgba(200,220,235,0.3)';
      g.fillRect(W * 0.08, H * 0.22, W * 0.84, H * 0.12);
    },
    0.45,
    0.1,
  );
}

/** パシフィコ横浜の低層部・テラス：白い横の帯と暗いガラス */
export function createPacificoLowMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#eff1f0';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#4f5f6b';
      g.fillRect(0, H * 0.32, W, H * 0.4);
      g.fillStyle = 'rgba(190,210,225,0.3)';
      g.fillRect(0, H * 0.32, W, H * 0.12);
    },
    0.4,
    0.15,
  );
}

/** 会議センター：白い縦の桟と、明るいガラス */
export function createPacificoHallMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#86a0b2';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(225,238,245,0.35)';
      g.fillRect(0, 0, W, H * 0.4);
      g.fillStyle = '#f1f2f0';
      g.fillRect(0, 0, 6, H);
      g.fillRect(W / 2, 0, 4, H);
      g.fillRect(0, H - 10, W, 10);
    },
    0.25,
    0.3,
  );
}

/** メディアタワーの四角い棟：灰色の格子に、四角い暗い窓 */
export function createMediaBlockMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#a7abae';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#48525c';
      g.fillRect(W * 0.14, H * 0.22, W * 0.72, H * 0.54);
      g.fillStyle = 'rgba(160,180,195,0.3)';
      g.fillRect(W * 0.14, H * 0.22, W * 0.72, H * 0.14);
    },
    0.6,
    0.15,
  );
}

/** メディアタワーの後ろの丸い棟：白に横の窓の帯 */
export function createMediaDrumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#e5e6e3';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#5a6873';
      g.fillRect(0, H * 0.42, W, H * 0.3);
      g.fillStyle = 'rgba(40,45,50,0.3)';
      g.fillRect(W - 2, H * 0.42, 2, H * 0.3);
    },
    0.55,
    0.1,
  );
}

/** シンフォステージ：紺のガラスに、細い白い横の線 */
export function createSymphoGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#26324a';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(150,175,210,0.22)';
      g.fillRect(0, 0, W, H * 0.45);
      g.fillStyle = '#dfe3e8';
      g.fillRect(0, H - 4, W, 4);
    },
    0.15,
    0.5,
  );
}

/** シンフォステージ・ウエストタワーの北の奥の上の部分：明るい枠に、暗い窓 */
export function createSymphoGridMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#cfd3d5';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#2e3949';
      g.fillRect(W * 0.1, H * 0.12, W * 0.8, H * 0.72);
    },
    0.3,
    0.3,
  );
}

/** シンフォステージの白い縦のフィンの面 */
export function createSymphoFinMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#3b4454';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#efe9e6';
      for (let x = 0; x < W; x += 8) g.fillRect(x, 0, 4, H);
    },
    0.4,
    0.2,
  );
}

/** グランドセントラルタワーの長い面：青いガラスに、細い明るい横の線 */
export function createGrandCentralGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#35577f';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(180,205,230,0.25)';
      g.fillRect(0, 0, W, H * 0.4);
      g.fillStyle = '#a3b8cc';
      g.fillRect(0, H - 3, W, 3);
      g.fillRect(0, H * 0.5, W, 1);
    },
    0.12,
    0.5,
  );
}

/** グランドセントラルタワーの短い面：灰色と暗い色の縦の縞 */
export function createGrandCentralStripeMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#7f8c97';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3c4955';
      g.fillRect(W * 0.5, 0, W * 0.28, H);
      g.fillStyle = 'rgba(30,35,40,0.3)';
      g.fillRect(0, H - 2, W, 2);
    },
    0.3,
    0.35,
  );
}

/** グランドセントラルテラス：明るい石と、ガラスの窓 */
export function createGrandCentralTerraceMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#c6c9c6';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#566672';
      g.fillRect(W * 0.08, H * 0.2, W * 0.84, H * 0.6);
    },
    0.4,
    0.2,
  );
}

/** コネクトスクエアの下の部分：黒に、細い白い縦の線が密に並ぶ */
export function createConnectDarkMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#272e36';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#d9dde0';
      for (let x = 0; x < W; x += 6) g.fillRect(x, 0, 2, H);
    },
    0.3,
    0.4,
  );
}

/** コネクトスクエアの上の部分：白い横の帯と、細い暗い窓 */
export function createConnectWhiteMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#eef0ef';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#4b5560';
      g.fillRect(0, H * 0.6, W, H * 0.18);
    },
    0.5,
    0.1,
  );
}

/** コネクトスクエアの低い棟：明るい灰色に四角い窓 */
export function createConnectLowMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#bfc3c4';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#4d5862';
      g.fillRect(W * 0.12, H * 0.25, W * 0.76, H * 0.5);
    },
    0.6,
    0.1,
  );
}

/** KDX の塔：白っぽいベージュに、横の窓の帯と細い縦の桟 */
export function createKdxWhiteMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#e2ded5';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#56626c';
      g.fillRect(0, H * 0.38, W, H * 0.32);
      g.fillStyle = '#e2ded5';
      g.fillRect(W / 2 - 1, H * 0.38, 2, H * 0.32);
    },
    0.6,
    0.05,
  );
}

/** KDX の切り欠きの青いガラス */
export function createKdxBlueMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#335c8e';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(190,215,240,0.25)';
      g.fillRect(0, 0, W, H * 0.5);
      g.fillStyle = 'rgba(20,35,55,0.5)';
      g.fillRect(0, H - 3, W, 3);
    },
    0.12,
    0.5,
  );
}

/** KDX の低層部：ベージュの壁に、背の高いアーチの窓（1枚 = 横 6.4m × 2 階） */
export function createKdxPodiumMaterial(): THREE.MeshStandardMaterial {
  const m = facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#dcd5c7';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#4a545c';
      const x0 = W * 0.22;
      const x1 = W * 0.78;
      const r = (x1 - x0) / 2;
      g.beginPath();
      g.moveTo(x0, H);
      g.lineTo(x0, H * 0.25 + r);
      g.arc(W / 2, H * 0.25 + r, r, Math.PI, 0);
      g.lineTo(x1, H);
      g.fill();
    },
    0.7,
    0.05,
  );
  m.map!.repeat.set(PANEL / 6.4, 1 / 2);
  return m;
}

/** 横浜三井ビルディング：灰色に、細かい不揃いな縦の縞 */
export function createMitsuiMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#8f989e';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#4d565d';
      for (const [x, w] of [
        [3, 3],
        [11, 2],
        [17, 4],
        [27, 2],
        [34, 3],
        [43, 2],
        [50, 4],
        [59, 2],
      ])
        g.fillRect(x, 0, w, H);
      g.fillStyle = 'rgba(200,210,220,0.25)';
      g.fillRect(0, H - 3, W, 3);
    },
    0.3,
    0.35,
  );
}
