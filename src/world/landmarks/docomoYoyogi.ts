import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * NTTドコモ代々木ビル（2000年、240m・アンテナ頂部 272m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 平面の長い向き（44m）、z = それに直角（36m）、y = 上。
 *
 * - 本体（0〜165m）：茶色い石の四角い塔。各面の中央に細い水色のガラスの縦の帯
 * - 本体の頂部（160〜180m）：上の段のまわりを囲む、明るい灰色の縦のフィンの枠
 * - 先細りの段（165〜240m）：エンパイアステートビルのように、上へ行くほど段々に細くなる5段。本体と同じ茶色に縦の筋
 * - 大きな時計：最初の段の長い2面に、文字盤と白い長針・短針・目盛り（ローマ数字の代わりに太い目盛り）
 * - アンテナ（240〜272m）：赤と白の鉄塔。段の角に白いパラボラアンテナ
 */
export interface DocomoParts {
  shaft: THREE.BufferGeometry;
  tier: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  fin: THREE.BufferGeometry;
  clock: THREE.BufferGeometry;
  /** 時計の針・目盛り */
  hands: THREE.BufferGeometry;
  red: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
}

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

/** 先細りの段：[下, 上, 長い向きの幅, 短い向きの幅] */
const TIERS: Array<[number, number, number, number]> = [
  [165, 190, 36, 30],
  [190, 203, 30, 25],
  [203, 215, 24, 20],
  [215, 227, 18, 15],
  [227, 240, 12, 10],
];
const SHAFT = 165;
const W = 44;
const D = 36;

export function buildDocomoYoyogi(cx: number): DocomoParts {
  const L: Record<keyof DocomoParts, THREE.BufferGeometry[]> = {
    shaft: [],
    tier: [],
    glass: [],
    fin: [],
    clock: [],
    hands: [],
    red: [],
    white: [],
  };
  // ---- 本体：四隅を少し切り欠いた（十字形の）塔 ----
  L.shaft.push(box(cx - W / 2 + 2, cx + W / 2 - 2, 0, SHAFT, -D / 2, D / 2));
  L.shaft.push(box(cx - W / 2, cx + W / 2, 0, SHAFT, -D / 2 + 2, D / 2 - 2));
  // 各面の中央の水色のガラスの縦の帯
  for (const s of [-1, 1]) {
    L.glass.push(box(cx - 2, cx + 2, 10, SHAFT - 4, s * (D / 2) - 0.3, s * (D / 2) + 0.3));
    L.glass.push(box(cx + s * (W / 2) - 0.3, cx + s * (W / 2) + 0.3, 10, SHAFT - 4, -2, 2));
  }
  // ---- 本体の頂部：まわりを囲む縦のフィンの枠（160〜181m） ----
  const finAt = (x: number, z: number, along: 'x' | 'z') =>
    L.fin.push(
      along === 'x'
        ? box(x - 0.4, x + 0.4, 158, 181, z - 1.2, z + 1.2)
        : box(x - 1.2, x + 1.2, 158, 181, z - 0.4, z + 0.4),
    );
  // 時計のある長い面（±z）は両端だけ（時計を隠さない）
  for (let x = -W / 2 + 2; x <= W / 2 - 2; x += 3.2) {
    if (Math.abs(x) < 13) continue;
    for (const s of [-1, 1]) finAt(cx + x, s * (D / 2 + 1.2), 'x');
  }
  for (let z = -D / 2 + 2; z <= D / 2 - 2; z += 3.2) for (const s of [-1, 1]) finAt(cx + s * (W / 2 + 1.2), z, 'z');
  // 枠の上の縁
  for (const s of [-1, 1]) {
    for (const [x0, x1] of [
      [-W / 2 - 2.4, -12],
      [12, W / 2 + 2.4],
    ]) {
      L.fin.push(box(cx + x0, cx + x1, 180, 181.5, s * (D / 2 + 1.2) - 1.2, s * (D / 2 + 1.2) + 1.2));
    }
    L.fin.push(box(cx + s * (W / 2 + 1.2) - 1.2, cx + s * (W / 2 + 1.2) + 1.2, 180, 181.5, -D / 2 - 2.4, D / 2 + 2.4));
  }
  // ---- 先細りの段 ----
  for (const [y0, y1, w, d] of TIERS) {
    L.tier.push(box(cx - w / 2, cx + w / 2, y0, y1, -d / 2, d / 2));
    // 段の縁の明るい帯
    L.white.push(box(cx - w / 2 - 0.3, cx + w / 2 + 0.3, y1 - 0.6, y1, -d / 2 - 0.3, d / 2 + 0.3));
    // 角のパラボラアンテナ（白い半球）
    for (const [sx, sz] of [
      [1, 1],
      [-1, -1],
    ]) {
      L.white.push(new THREE.SphereGeometry(1.1, 10, 6).translate(cx + (sx * w) / 2, y1 + 1, (sz * d) / 2));
    }
  }
  // ---- 大きな時計：最初の段の長い2面（文字盤の直径 17m、中心 178m。本体の頂部より上に出る） ----
  const [cy0, , , d0] = TIERS[0];
  const C = cy0 + 13;
  const R = 8.5;
  const faces: Array<[number, number, number]> = [
    // [面の中心 x, z, 外向きの角度]
    [cx, d0 / 2 + 0.05, 0],
    [cx, -d0 / 2 - 0.05, Math.PI],
  ];
  for (const [fx, fz, rot] of faces) {
    const put = (g: THREE.BufferGeometry, lift = 0) => g.translate(0, 0, lift).rotateY(rot).translate(fx, C, fz);
    L.clock.push(put(new THREE.CircleGeometry(R, 48)));
    // 12 の目盛り（3・6・9・12 は太く長い）
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const big = k % 3 === 0;
      const len = big ? 1.8 : 1;
      const g = new THREE.BoxGeometry(big ? 0.6 : 0.35, len, 0.15).translate(0, R - 0.5 - len / 2, 0).rotateZ(-a);
      L.hands.push(put(g, 0.1));
    }
    // 針（10時10分ごろ）
    L.hands.push(put(new THREE.BoxGeometry(0.55, R * 0.85, 0.2).translate(0, (R * 0.85) / 2, 0).rotateZ(-Math.PI / 6 * 2), 0.2));
    L.hands.push(put(new THREE.BoxGeometry(0.75, R * 0.55, 0.2).translate(0, (R * 0.55) / 2, 0).rotateZ(Math.PI / 6 * 2), 0.25));
    L.hands.push(put(new THREE.CylinderGeometry(0.6, 0.6, 0.3, 12).rotateX(Math.PI / 2), 0.3));
  }
  // ---- アンテナ（240〜272m）：赤と白の帯の鉄塔 ----
  for (let k = 0; k < 8; k++) {
    const y = 240 + k * 4;
    const r0 = THREE.MathUtils.lerp(2.2, 0.6, k / 8);
    const r1 = THREE.MathUtils.lerp(2.2, 0.6, (k + 1) / 8);
    (k % 2 === 0 ? L.red : L.white).push(new THREE.CylinderGeometry(r1, r0, 4, 6).translate(cx, y + 2, 0));
  }

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      if (!out.getAttribute('uv')) {
        out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
      }
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as DocomoParts;
}

/** 本体：茶色い石に、細長い窓（1枚 = 3m × 1階） */
export function createDocomoShaftMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, Wp, Hp) => {
      g.fillStyle = '#6e5e57';
      g.fillRect(0, 0, Wp, Hp);
      g.fillStyle = '#3a3c42';
      g.fillRect(Wp * 0.3, Hp * 0.2, Wp * 0.4, Hp * 0.6);
      g.fillStyle = 'rgba(40,30,25,0.3)';
      g.fillRect(0, Hp - 3, Wp, 3);
    },
    0.6,
    0.1,
  );
}

/** 先細りの段：本体と同じ茶色の板に、縦の筋 */
export function createDocomoTierMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, Wp, Hp) => {
      g.fillStyle = '#6e5e57';
      g.fillRect(0, 0, Wp, Hp);
      g.fillStyle = 'rgba(70,65,60,0.5)';
      g.fillRect(0, 0, 3, Hp);
      g.fillRect(Wp / 2, 0, 2, Hp);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(3, 0, 6, Hp);
    },
    0.45,
    0.35,
  );
}
