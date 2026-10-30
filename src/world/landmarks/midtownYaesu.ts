import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 東京ミッドタウン八重洲（2022年、240m）：八重洲セントラルタワーと低層部、八重洲セントラルスクエア。写真を参考に作る。
 * 座標：敷地の中心が (cx, 0, 0)、x = 街区の長い向き（北北東寄り、東から 65°）、z = 東南東が +（東京駅の側が -）、y = 上。
 * 平面の点は OpenStreetMap の形を [x, z]（m）に直したもの。
 *
 * - 塔：2枚の板が並び、間に縦の暗いすき間（短い面にもすき間）。白い横のルーバーの入ったガラス。
 *   上の階（ホテル、200m〜）は透明なガラス。てっぺんに枠と、屋上のヘリポート
 * - 低層部（〜28m）：横の帯のガラス。屋上はテラスの植え込みと木
 * - 八重洲セントラルスクエア：北東の角の小さなガラスの建物（〜36m）
 */
export interface MidtownYaesuParts {
  louver: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

type P2 = [number, number];
type Lists = Record<keyof MidtownYaesuParts, THREE.BufferGeometry[]>;

/** 低層部の平面（OSM の「東京ミッドタウン八重洲」の街区） */
const PODIUM: P2[] = [
  [-76.7, -69.5],
  [-79, 4.1],
  [-43.4, 8.6],
  [-22.5, 8.6],
  [0.2, 6.5],
  [18.4, 3.6],
  [19.7, -47.8],
  [13.3, -48.3],
  [-19.2, -67.2],
  [-23.9, -67.4],
];
/** 八重洲セントラルスクエア */
const SQUARE: P2[] = [
  [52.5, 3.8],
  [25.4, 2.4],
  [24.5, 21.1],
  [51.6, 22.4],
];

/** 点 a〜b の間の縦の壁（uv：横 / 3m、縦 / FLOOR） */
function wall(cx: number, a: P2, b: P2, y0: number, y1: number): THREE.BufferGeometry {
  const u1 = Math.hypot(b[0] - a[0], b[1] - a[1]) / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        cx + a[0],
        y0,
        a[1],
        cx + b[0],
        y0,
        b[1],
        cx + b[0],
        y1,
        b[1],
        cx + a[0],
        y0,
        a[1],
        cx + b[0],
        y1,
        b[1],
        cx + a[0],
        y1,
        a[1],
      ],
      3,
    ),
  );
  const v0 = y0 / FLOOR;
  const v1 = y1 / FLOOR;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, v0, u1, v0, u1, v1, 0, v0, u1, v1, 0, v1], 2));
  return g;
}

/** 平らな板（多角形、高さ y、上向き） */
function slab(cx: number, pts: P2[], y: number): THREE.BufferGeometry {
  // 形の y = -z にして -90° 回すと、面が上を向いたまま z に戻る
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(cx, y, 0);
}

/** 多角形の壁と屋根 */
function prism(L: Lists, key: keyof MidtownYaesuParts, cx: number, pts: P2[], y0: number, y1: number): void {
  for (let i = 0; i < pts.length; i++) L[key].push(wall(cx, pts[i], pts[(i + 1) % pts.length], y0, y1));
  L.roof.push(slab(cx, pts, y1));
}

/** 箱（外面の uv は m 単位：横 / 3、縦 / FLOOR） */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const across = Math.abs(nor.getX(i)) > 0.5 ? pos.getZ(i) : pos.getX(i);
    uv.setXY(i, across / 3, pos.getY(i) / FLOOR);
  }
  return g;
}

export function buildMidtownYaesu(cx: number): MidtownYaesuParts {
  const L: Lists = { louver: [], glass: [], podium: [], dark: [], frame: [], green: [], roof: [] };

  // ---- 低層部（1階の暗いガラスと、上の横の帯のガラス）と屋上のテラス ----
  prism(L, 'dark', cx, PODIUM, 0, 6);
  prism(L, 'podium', cx, PODIUM, 6, 28);
  for (let i = 0; i < PODIUM.length; i++) L.green.push(wall(cx, PODIUM[i], PODIUM[(i + 1) % PODIUM.length], 28, 29.2));
  for (const [x, z] of [
    [-74, -6],
    [-66, 2],
    [-56, 4],
    [-44, 4],
    [-32, 4],
    [-20, 4],
    [-8, 2],
    [4, 0],
    [14, -2],
    [15, -14],
    [15, -26],
    [15, -38],
  ]) {
    L.green.push(new THREE.IcosahedronGeometry(2, 0).scale(1, 1.3, 1).translate(cx + x, 30.8, z));
  }

  // ---- 塔：2枚の板（南西の板は 236m、北東の板は 240m）と間の暗いすき間 ----
  const Z0 = -66;
  const Z1 = -16;
  const ZM = (Z0 + Z1) / 2;
  const LOUVER_TOP = 200;
  for (const [x0, x1, top] of [
    [-68, -32, 236],
    [-30, 6, 240],
  ]) {
    L.louver.push(box(cx + x0, cx + x1, 28, LOUVER_TOP, Z0, Z1));
    L.glass.push(box(cx + x0, cx + x1, LOUVER_TOP, top - 4, Z0, Z1));
    // てっぺんの枠（縁の壁）と、屋根
    for (const [a0, a1, b0, b1] of [
      [x0, x1, Z0, Z0 + 1],
      [x0, x1, Z1 - 1, Z1],
      [x0, x0 + 1, Z0, Z1],
      [x1 - 1, x1, Z0, Z1],
    ]) {
      L.frame.push(box(cx + a0, cx + a1, top - 4, top, b0, b1));
    }
    L.roof.push(box(cx + x0, cx + x1, top - 4, top - 3.6, Z0, Z1));
  }
  L.dark.push(box(cx - 32.5, cx - 29.5, 28, 236, Z0 + 1.5, Z1 - 1.5));
  // 短い面の縦の暗いすき間（面から少し出す）
  for (const x of [-68.3, 6]) L.dark.push(box(cx + x, cx + x + 0.3, 28, 234, ZM - 1.2, ZM + 1.2));
  // 屋上のヘリポート（北東の板の上）
  L.green.push(box(cx - 20, cx - 4, 236.4, 236.9, ZM - 8, ZM + 8));

  // ---- 八重洲セントラルスクエア ----
  prism(L, 'glass', cx, SQUARE, 0, 36);
  L.frame.push(slab(cx, SQUARE, 36.3));

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes))
        if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as MidtownYaesuParts;
}

/** 塔：薄い青のガラスに、白い横のルーバーの帯（1枚 = 3m × 1階） */
export function createYaesuLouverMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#86a9c4');
      grad.addColorStop(1, '#5f86a6');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#e4e9ec';
      g.fillRect(0, H * 0.7, W, H * 0.16);
      g.fillStyle = 'rgba(80,90,100,0.35)';
      g.fillRect(0, H * 0.86, W, 3);
      g.fillStyle = 'rgba(210,222,230,0.5)';
      g.fillRect(0, 0, 2, H * 0.7);
    },
    0.2,
    0.35,
  );
}

/** 上の階の透明なガラス（1枚 = 3m × 1階） */
export function createYaesuGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#a6c8de');
      grad.addColorStop(1, '#7aa3c2');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(235,242,246,0.7)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(W / 2, 0, 1, H);
      g.fillRect(0, H - 3, W, 3);
    },
    0.1,
    0.35,
  );
}

/** 低層部：明るい灰色の横の帯と、ガラスの帯（1枚 = 3m × 1階） */
export function createYaesuPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#6f8597';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#d6d9db';
      g.fillRect(0, H * 0.72, W, H * 0.28);
      g.fillStyle = 'rgba(220,226,230,0.6)';
      g.fillRect(0, 0, 3, H * 0.72);
    },
    0.35,
    0.2,
  );
}
