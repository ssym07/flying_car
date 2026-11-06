import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';
import { beam } from './fukuokaTower';

/**
 * 大阪ステーションシティ（大阪駅の大屋根・ノースゲートビルディング・サウスゲートビルディング）と、
 * 駅の西のJPタワー大阪・イノゲート大阪。写真と PLATEAU の箱の平面を参考に作る。
 *
 * 座標：建物ごとに中心が (cx, 0, 0)。x = 線路の向き（東から北へ 31.4°、東北東）、z = 線路から南南東の向き、y = 上。
 * 平面の点は (u, v) = (線路の向き, 北北西の向き) で書き、x = cx + u、z = -v に置く。
 *
 * - 大屋根：東西 184m・南北 100m。南（サウスゲート側）の 35m から北（ノースゲート側）の 49m へ反り上がる、ガラスの片流れの屋根。
 *   白い鉄骨の格子と、東西の端の大きな白いトラス・柱。下に線路をまたぐ駅舎と、その上の時空の広場
 * - ノースゲートビルディング：灰色の細かい窓の 150m の長い板のような高層棟。西端に北西の角が丸いガラスの 62m の棟と段の庭、
 *   東に 78m の低層棟（屋上の庭）、間にガラスの吹き抜け
 * - サウスゲートビルディング：東端に 122m の旧アクティ大阪の塔（ベージュに白い縦の帯、屋上にヘリポート）、その西に青いガラスの塔、
 *   西へ続く 58〜70m の茶色の低い棟と段ごとの屋上の庭
 * - イノゲート大阪：線路と道路に挟まれた、西へ細くなる楔形の平面の 122m の薄いビル。北面はガラスに縦の金属のフィン、南面（線路側）は芯の壁
 * - JPタワー大阪：白い縦のルーバーの KITTE大阪の低層部（38m、西に屋上の庭、南の道沿いに 22m の棟）の上に、
 *   青いガラスに白い縦の線の 188m の四角い塔。南東に 128m までの箱が少し張り出す
 */
export type StationCityKey =
  | 'roofGlass'
  | 'steel'
  | 'white'
  | 'roofTop'
  | 'green'
  | 'ngbGlass'
  | 'ngbLow'
  | 'sgbTile'
  | 'sgbGlass'
  | 'sgbLow'
  | 'heli'
  | 'inoGlass'
  | 'inoCore'
  | 'fin'
  | 'jpGlass'
  | 'jpPodium';
export type StationCityParts = Partial<Record<StationCityKey, THREE.BufferGeometry>>;

type P2 = [number, number];
type Lists = Partial<Record<StationCityKey, THREE.BufferGeometry[]>>;

const push = (out: Lists, key: StationCityKey, g: THREE.BufferGeometry) => (out[key] ??= []).push(g);

/** 外壁の uv の横の大きさ (m)。縦は 1 階 = FLOOR */
const PANEL = 3.2;

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

/**
 * 平面 pts（反時計回り）を y0〜y1 に立てた壁。辺ごとに外向きの向き (nu, nv) から材質を選ぶ。
 * roof が有れば上に平らな屋根を置く
 */
function prism(
  out: Lists,
  cx: number,
  pts: P2[],
  y0: number,
  y1: number,
  pick: (nu: number, nv: number) => StationCityKey,
  roof: StationCityKey | null = 'roofTop',
): void {
  const byKey = new Map<StationCityKey, { pos: number[]; nor: number[]; uv: number[] }>();
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ua, va] = pts[i];
    const [ub, vb] = pts[(i + 1) % pts.length];
    const len = Math.hypot(ub - ua, vb - va);
    if (len < 1e-3) continue;
    const nu = (vb - va) / len;
    const nv = -(ub - ua) / len;
    const key = pick(nu, nv);
    const b = byKey.get(key) ?? { pos: [], nor: [], uv: [] };
    byKey.set(key, b);
    const s0 = s / PANEL;
    const s1 = (s + len) / PANEL;
    const t0 = y0 / FLOOR;
    const t1 = y1 / FLOOR;
    const A = [cx + ua, y0, -va];
    const B = [cx + ub, y0, -vb];
    const C = [cx + ub, y1, -vb];
    const D = [cx + ua, y1, -va];
    b.pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    for (let k = 0; k < 6; k++) b.nor.push(nu, 0, -nv);
    b.uv.push(s0, t0, s1, t0, s1, t1, s0, t0, s1, t1, s0, t1);
    s += len;
  }
  for (const [key, b] of byKey) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    push(out, key, g);
  }
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

/** 白い横の帯（平面 pts を少し広げて、高さ y0〜y1） */
function band(out: Lists, cx: number, pts: P2[], y0: number, y1: number, grow = 0.4, key: StationCityKey = 'white') {
  prism(out, cx, offset(pts, grow), y0, y1, () => key, null);
}

const P = (cx: number, u: number, y: number, v: number) => new THREE.Vector3(cx + u, y, -v);

function finish(out: Lists): StationCityParts {
  const parts: StationCityParts = {};
  for (const [key, list] of Object.entries(out) as Array<[StationCityKey, THREE.BufferGeometry[]]>) {
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

// ---------------------------------------------------------------- 大屋根

const ROOF_U = 92;
const ROOF_V = 50;
/** 大屋根の高さ（v = 南北の位置）：南の 35m から北の 49m へ反り上がる */
const roofY = (v: number) => 35 + 14 * Math.sin(((v + ROOF_V) / (2 * ROOF_V)) * (Math.PI / 2));

export function buildOsakaStationRoof(cx: number): StationCityParts {
  const out: Lists = {};
  // ガラスの面
  {
    const NU = 24;
    const NV = 20;
    const pos: number[] = [];
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const u0 = -ROOF_U + (2 * ROOF_U * i) / NU;
        const u1 = -ROOF_U + (2 * ROOF_U * (i + 1)) / NU;
        const v0 = -ROOF_V + (2 * ROOF_V * j) / NV;
        const v1 = -ROOF_V + (2 * ROOF_V * (j + 1)) / NV;
        const a = [cx + u0, roofY(v0), -v0];
        const b = [cx + u1, roofY(v0), -v0];
        const c = [cx + u1, roofY(v1), -v1];
        const d = [cx + u0, roofY(v1), -v1];
        pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    push(out, 'roofGlass', g);
  }
  // 白い鉄骨の格子：南北の梁（約 11.5m おき）と、東西の梁（10m おき）
  const steel: THREE.BufferGeometry[] = [];
  const SEG = 10;
  for (let i = 0; i <= 16; i++) {
    const u = -ROOF_U + (2 * ROOF_U * i) / 16;
    const w = i === 0 || i === 16 ? 1.6 : 0.7;
    for (let j = 0; j < SEG; j++) {
      const v0 = -ROOF_V + (2 * ROOF_V * j) / SEG;
      const v1 = -ROOF_V + (2 * ROOF_V * (j + 1)) / SEG;
      beam(steel, P(cx, u, roofY(v0) - 0.5, v0), P(cx, u, roofY(v1) - 0.5, v1), w);
    }
  }
  for (let j = 0; j <= 10; j++) {
    const v = -ROOF_V + (2 * ROOF_V * j) / 10;
    beam(steel, P(cx, -ROOF_U, roofY(v) - 0.5, v), P(cx, ROOF_U, roofY(v) - 0.5, v), j === 0 || j === 10 ? 1.6 : 0.5);
  }
  // 東西の端の大きなトラス（上下の弦と斜材）と、それを支える柱
  for (const u of [-ROOF_U, ROOF_U]) {
    const D = 5;
    for (let j = 0; j < SEG; j++) {
      const v0 = -ROOF_V + (2 * ROOF_V * j) / SEG;
      const v1 = -ROOF_V + (2 * ROOF_V * (j + 1)) / SEG;
      beam(steel, P(cx, u, roofY(v0) - D, v0), P(cx, u, roofY(v1) - D, v1), 1.2);
      beam(steel, P(cx, u, roofY(v0) - 0.5, v0), P(cx, u, roofY(v1) - D, v1), 0.6);
      beam(steel, P(cx, u, roofY(v0) - D, v0), P(cx, u, roofY(v1) - 0.5, v1), 0.6);
    }
    for (const v of [-ROOF_V + 4, 0, ROOF_V - 4]) beam(steel, P(cx, u, 0, v), P(cx, u, roofY(v) - 5, v), 2.2);
  }
  // 南の縁の梁（屋根の重みを受ける太い梁）
  beam(steel, P(cx, -ROOF_U, roofY(-ROOF_V) - 2, -ROOF_V), P(cx, ROOF_U, roofY(-ROOF_V) - 2, -ROOF_V), 3);
  for (const g of steel) push(out, 'steel', g);

  // 線路をまたぐ駅舎（13〜25m）と、上の時空の広場
  const station: P2[] = [
    [-12, -44],
    [48, -44],
    [48, 44],
    [-12, 44],
  ];
  prism(out, cx, station, 13, 25, () => 'sgbGlass', 'white');
  band(out, cx, station, 24.2, 26, 0.2);
  band(out, cx, station, 13, 14, 0.3);
  return finish(out);
}

// ---------------------------------------------------------------- ノースゲートビルディング

/** 屋上の設備の白い箱（中心 u, v、大きさ w × d、高さ y0〜y1） */
function block(out: Lists, cx: number, u: number, v: number, w: number, d: number, y0: number, y1: number, key: StationCityKey = 'white') {
  const pts: P2[] = [
    [u - w / 2, v - d / 2],
    [u + w / 2, v - d / 2],
    [u + w / 2, v + d / 2],
    [u - w / 2, v + d / 2],
  ];
  prism(out, cx, pts, y0, y1, () => key, key === 'white' ? 'white' : 'roofTop');
}

export function buildNorthGateBuilding(cx: number): StationCityParts {
  const out: Lists = {};
  // 西端の低い棟（62m）：北西の角が丸いガラス。上は段になった庭
  const west = rounded(-132, -86, -39, 39, [0, 0, 0, 22]);
  prism(out, cx, west, 0, 62, (nu, nv) => (nu < -0.2 && nv > 0.2 ? 'sgbGlass' : 'ngbLow'));
  band(out, cx, west, 61, 63, 0.3);
  push(out, 'green', cap(cx, offset(west, -4), 63.2));
  block(out, cx, -104, -20, 22, 24, 62, 74, 'ngbLow');
  push(out, 'green', cap(cx, offset(rounded(-115, -93, -32, -8, [0, 0, 0, 0]), -1.5), 74.2));
  // 高層棟（150m）：灰色の壁に細かい窓の、長い板のような形。屋上に設備の箱と光庭
  const tower: P2[] = [
    [-86, -37],
    [30, -37],
    [30, 37],
    [-86, 37],
  ];
  prism(out, cx, tower, 0, 146, () => 'ngbGlass');
  band(out, cx, tower, 145, 150, 0.4, 'ngbLow');
  block(out, cx, -60, 0, 30, 40, 146, 151);
  block(out, cx, -18, 14, 24, 18, 146, 152);
  block(out, cx, 8, -16, 20, 16, 146, 150.5);
  // 吹き抜け（62m、ガラス）と、東の低層棟（78m、屋上の庭）
  const atrium: P2[] = [
    [30, -34],
    [50, -34],
    [50, 34],
    [30, 34],
  ];
  prism(out, cx, atrium, 0, 62, () => 'sgbGlass');
  const low = rounded(50, 132, -39, 39, [0, 10, 10, 0]);
  prism(out, cx, low, 0, 78, () => 'ngbLow');
  band(out, cx, low, 77, 79.5, 0.3);
  push(out, 'green', cap(cx, offset(low, -6), 78.4));
  return finish(out);
}

// ---------------------------------------------------------------- サウスゲートビルディング

export function buildSouthGateBuilding(cx: number): StationCityParts {
  const out: Lists = {};
  // 東端の塔（旧アクティ大阪、122m）：ベージュに白い縦の帯。屋上にヘリポート
  const tower: P2[] = [
    [20, -30],
    [62, -30],
    [62, 30],
    [20, 30],
  ];
  prism(out, cx, tower, 0, 122, () => 'sgbTile');
  band(out, cx, tower, 121, 123.5, 0.3);
  const pad = new THREE.BoxGeometry(30, 0.6, 30).toNonIndexed();
  pad.translate(cx + 41, 123.8, -2);
  push(out, 'heli', pad);
  // 塔の西に付く、青いガラスの塔（105m）
  const glass: P2[] = [
    [2, -20],
    [20, -20],
    [20, 30],
    [2, 30],
  ];
  prism(out, cx, glass, 0, 105, () => 'inoGlass');
  band(out, cx, glass, 104, 106, 0.3);
  // 西へ続く低い棟：南は 58m、北は 70m。段ごとの屋上の庭（太陽の広場）
  const south = rounded(-62, 20, -30, 0, [6, 0, 0, 0]);
  prism(out, cx, south, 0, 58, () => 'sgbLow');
  band(out, cx, south, 57, 59, 0.3);
  push(out, 'green', cap(cx, offset(south, -3), 59.2));
  const north: P2[] = [
    [-62, 0],
    [2, 0],
    [2, 30],
    [-62, 30],
  ];
  prism(out, cx, north, 0, 70, () => 'sgbLow');
  band(out, cx, north, 69, 71, 0.3);
  push(out, 'green', cap(cx, offset(north, -4), 71.2));
  for (const [u, v, h] of [
    [-50, -14, 66],
    [-56, 14, 78],
    [-20, 16, 76],
  ]) {
    block(out, cx, u, v, 10, 12, 0, h, 'sgbLow');
  }
  block(out, cx, -30, 8, 16, 10, 70, 74);
  return finish(out);
}

// ---------------------------------------------------------------- イノゲート大阪

/** 平面（PLATEAU の箱から）。西へ細くなる楔形で、北の辺が斜め */
const INNOGATE: P2[] = [
  [-63, -16],
  [46, -16],
  [46, -10],
  [61, -10],
  [61, -7],
  [64, -7],
  [64, 17],
  [60, 17],
  [-61, 4],
  [-64, 2],
];
const INNOGATE_H = 121.6;

export function buildInnogate(cx: number): StationCityParts {
  const out: Lists = {};
  // 北を向く面はガラス、ほか（線路側の南・東西の端）は芯の壁
  prism(out, cx, INNOGATE, 0, INNOGATE_H, (_nu, nv) => (nv > 0.5 ? 'inoGlass' : 'inoCore'));
  band(out, cx, INNOGATE, INNOGATE_H - 1, INNOGATE_H + 1.2, 0.3);
  // 北面の縦の金属のフィン（3m おき）
  const [a, b] = [INNOGATE[7], INNOGATE[8]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [nu, nv] = normal(a, b);
  const fins: THREE.BufferGeometry[] = [];
  for (let s = 1.5; s < len; s += 3) {
    const t = s / len;
    const u = a[0] + (b[0] - a[0]) * t + nu * 0.5;
    const v = a[1] + (b[1] - a[1]) * t + nv * 0.5;
    beam(fins, P(cx, u, 4, v), P(cx, u, INNOGATE_H - 1, v), 0.35);
  }
  for (const g of fins) push(out, 'fin', g);
  return finish(out);
}

// ---------------------------------------------------------------- JPタワー大阪

export function buildJpTowerOsaka(cx: number): StationCityParts {
  const out: Lists = {};
  const rect = (u0: number, u1: number, v0: number, v1: number): P2[] => [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  // KITTE大阪の低層部（38m）：白い縦のルーバー。塔の西は屋上の庭と、庭の上の箱
  const podium = rect(-58, 36, -34, 30);
  prism(out, cx, podium, 0, 38, () => 'jpPodium');
  band(out, cx, podium, 37, 39.5, 0.3);
  push(out, 'green', cap(cx, rect(-55, -32, -31, 27), 39.6));
  block(out, cx, -44, -12, 14, 16, 38, 46, 'jpPodium');
  // 南の道沿いの低い棟（22m、屋上の庭）
  const wing = rect(-58, 14, -44, -34);
  prism(out, cx, wing, 0, 22, () => 'jpPodium');
  push(out, 'green', cap(cx, offset(wing, -1.5), 22.2));
  // 塔：188m の四角い箱と、その南東に 4m 張り出す 128m までの箱。境目に暗い帯
  const tower = rect(-30, 30, -22, 24);
  prism(out, cx, tower, 38, 186, () => 'jpGlass');
  band(out, cx, tower, 186, 188.5, 0.2);
  const front = rect(-12, 34, -26, 14);
  prism(out, cx, front, 38, 127, () => 'jpGlass', 'roofTop');
  band(out, cx, front, 127, 129, 0.1, 'inoGlass');
  // 屋上の設備
  block(out, cx, 4, 0, 30, 22, 186, 192);
  return finish(out);
}

// ---------------------------------------------------------------- 材質

/** ノースゲートの高層棟：灰色の壁に、細かい四角の窓（1枚 = 横 3.2m × 1 階に窓 2 つ） */
export function createNgbGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#9a9fa2';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3c454d';
      g.fillRect(W * 0.12, H * 0.3, W * 0.3, H * 0.45);
      g.fillRect(W * 0.58, H * 0.3, W * 0.3, H * 0.45);
      g.fillStyle = 'rgba(170,195,215,0.3)';
      g.fillRect(W * 0.12, H * 0.3, W * 0.76, H * 0.12);
    },
    0.6,
    0.15,
  );
}

/** ノースゲートの低層棟（ルクア）：白い縦のルーバーと、奥の暗いガラス */
export function createNgbLowMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#4b5862';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#e8eaea';
      for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 6, H);
      g.fillRect(0, H - 6, W, 6);
    },
    0.5,
    0.1,
  );
}

/** サウスゲートの塔：ベージュの壁に、白い縦の帯と、縦に連なる暗い窓 */
export function createSgbTileMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#cdb994';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#efece4';
      g.fillRect(0, 0, W * 0.16, H);
      g.fillStyle = '#4a4c4f';
      g.fillRect(W * 0.48, H * 0.12, W * 0.24, H * 0.8);
    },
    0.75,
    0.05,
  );
}

/** サウスゲートの西の低い棟：茶色のパネルと、縦に連なる暗い窓 */
export function createSgbLowMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#8a6a52';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3d3a3a';
      g.fillRect(W * 0.3, H * 0.15, W * 0.4, H * 0.7);
      g.fillStyle = 'rgba(230,220,205,0.5)';
      g.fillRect(0, H - 5, W, 5);
    },
    0.7,
    0.05,
  );
}

/** サウスゲートの屋上のヘリポート：濃い緑灰色に白い円と H */
export function createHeliportMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#5d6b63';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#f2f2ee';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(64, 64, 46, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f2f2ee';
  g.fillRect(44, 40, 9, 48);
  g.fillRect(75, 40, 9, 48);
  g.fillRect(44, 60, 40, 8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 });
}

/** サウスゲートの増築部・駅舎：明るいガラスに白い枠 */
export function createSgbGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#7d95a6';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(215,232,242,0.3)';
      g.fillRect(0, 0, W, H * 0.45);
      g.fillStyle = '#eceeed';
      g.fillRect(0, H - 8, W, 8);
      g.fillRect(0, 0, 3, H);
    },
    0.2,
    0.35,
  );
}

/** イノゲートの北面：濃い青灰色のガラス（フィンは別の形） */
export function createInnogateGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#3f5568';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(190,215,235,0.2)';
      g.fillRect(0, 0, W, H * 0.55);
      g.fillStyle = 'rgba(20,30,40,0.6)';
      g.fillRect(0, H - 3, W, 3);
    },
    0.12,
    0.5,
  );
}

/** イノゲートの芯の壁（線路側）：明るい灰色の金属パネルに、縦の細いガラスの帯 */
export function createInnogateCoreMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#b9bcbd';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#56656f';
      g.fillRect(W * 0.7, 0, W * 0.18, H);
      g.fillStyle = 'rgba(60,60,60,0.25)';
      g.fillRect(0, H - 2, W, 2);
    },
    0.45,
    0.3,
  );
}

/** JPタワー大阪の塔：青いガラスに、細かい白い縦の線 */
export function createJpTowerGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#3f5f8c';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(200,220,245,0.22)';
      g.fillRect(0, 0, W, H * 0.45);
      g.fillStyle = '#e3e8ec';
      for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 3, H);
      g.fillStyle = 'rgba(25,40,60,0.55)';
      g.fillRect(0, H - 4, W, 4);
    },
    0.15,
    0.45,
  );
}

/** KITTE大阪の低層部：暗いガラスの前に、白い縦のルーバーが細かく並ぶ */
export function createJpPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#56636d';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#eceeee';
      for (let x = 0; x < W; x += 11) g.fillRect(x, 0, 5, H);
      g.fillStyle = 'rgba(40,45,50,0.4)';
      g.fillRect(0, H - 3, W, 3);
    },
    0.5,
    0.1,
  );
}
