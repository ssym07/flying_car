import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 丸の内永楽ビルディング（2012年、158m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 北北東が +、z = 東京駅の側（東南東）が +、y = 上。街区は 83 × 82m。
 *
 * - 低層部（〜28m）：ベージュの石の枠に縦の細いフィンと濃い緑のガラス。1階は石の柱が並ぶ奥まった入口。
 *   上に石の軒、その上に丸い柱の並ぶ奥まった階と、大きく張り出した暗い庇（塔の足元）
 * - 塔：3つの面は濃い緑灰色のガラスに細いベージュの縦のフィン。縦の暗い溝で4つの区画に分かれる
 * - 塔の東の面：太い石の枠に囲まれた、彫りの深い窓の石の格子。てっぺんは枠だけの吹き抜け（縦の石の板の並び）
 */
export interface EirakuParts {
  podium: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  grid: THREE.BufferGeometry;
  stone: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

type Lists = Record<keyof EirakuParts, THREE.BufferGeometry[]>;

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

export function buildEiraku(cx: number): EirakuParts {
  const L: Lists = { podium: [], glass: [], grid: [], stone: [], dark: [], roof: [] };
  const X0 = cx - 41;
  const X1 = cx + 42;
  const Z0 = -42;
  const Z1 = 40;

  // ---- 低層部：1階の奥まった入口と石の柱、2〜7階の壁、石の軒 ----
  L.dark.push(box(X0 + 3, X1 - 3, 0, 4.5, Z0 + 3, Z1 - 3));
  for (let x = X0 + 1; x <= X1 - 1; x += (X1 - X0 - 2) / 9) {
    for (const z of [Z0 + 1, Z1 - 1]) L.stone.push(box(x - 1, x + 1, 0, 4.5, z - 1, z + 1));
  }
  for (let z = Z0 + 1; z <= Z1 - 1; z += (Z1 - Z0 - 2) / 9) {
    for (const x of [X0 + 1, X1 - 1]) L.stone.push(box(x - 1, x + 1, 0, 4.5, z - 1, z + 1));
  }
  L.podium.push(box(X0, X1, 4.5, 27, Z0, Z1));
  L.stone.push(box(X0 - 0.8, X1 + 0.8, 27, 28.5, Z0 - 0.8, Z1 + 0.8));
  // ---- 奥まった階（丸い柱の並び）と、大きく張り出した暗い庇 ----
  L.dark.push(box(X0 + 5, X1 - 5, 28.5, 34, Z0 + 5, Z1 - 5));
  const col = (x: number, z: number) =>
    L.stone.push(new THREE.CylinderGeometry(0.9, 0.9, 5.5, 10).translate(x, 31.25, z));
  for (let i = 0; i <= 8; i++) {
    const x = X0 + 2.5 + ((X1 - X0 - 5) * i) / 8;
    const z = Z0 + 2.5 + ((Z1 - Z0 - 5) * i) / 8;
    col(x, Z0 + 2.5);
    col(x, Z1 - 2.5);
    col(X0 + 2.5, z);
    col(X1 - 2.5, z);
  }
  L.dark.push(box(X0 - 1.5, X1 + 1.5, 34, 36.5, Z0 - 1.5, Z1 + 1.5));
  L.roof.push(box(X0 - 1.5, X1 + 1.5, 36.5, 36.8, Z0 - 1.5, Z1 + 1.5));

  // ---- 塔（36.5〜158m）：ガラスとフィンの3つの面、縦の暗い溝 ----
  const T0 = cx - 30;
  const T1 = cx + 32;
  const W0 = -30;
  const W1 = 25;
  const TOP = 158;
  L.glass.push(box(T0, T1, 36.5, TOP - 0.5, W0, W1));
  for (const t of [0.25, 0.5, 0.75]) {
    const x = T0 + (T1 - T0) * t;
    const z = W0 + (W1 - W0) * t;
    L.dark.push(box(x - 0.6, x + 0.6, 36.5, TOP - 0.5, W0 - 0.2, W0 + 1));
    L.dark.push(box(T0 - 0.2, T0 + 1, 36.5, TOP - 0.5, z - 0.6, z + 0.6));
    L.dark.push(box(T1 - 1, T1 + 0.2, 36.5, TOP - 0.5, z - 0.6, z + 0.6));
  }
  L.roof.push(box(T0, T1, TOP - 0.5, TOP, W0, W1));
  // ---- 東の面：太い石の枠と、彫りの深い窓の石の格子。てっぺんは吹き抜けの枠 ----
  const E = W1 + 2.5;
  const CROWN = 146;
  L.grid.push(box(T0 + 3, T1 - 3, 36.5, CROWN, W1, E - 0.5));
  for (const x of [T0, T1 - 3.5]) L.stone.push(box(x, x + 3.5, 36.5, TOP + 1, W1 - 1, E));
  L.stone.push(box(T0, T1, TOP - 2, TOP + 1, W1 - 1, E));
  L.stone.push(box(T0 + 3, T1 - 3, CROWN - 1, CROWN, W1, E));
  // 吹き抜け：奥の暗い面と、縦の石の板
  L.dark.push(box(T0 + 3, T1 - 3, CROWN, TOP - 2, W1 - 2, W1 - 1.5));
  for (let x = T0 + 6; x < T1 - 4; x += 3.1) L.stone.push(box(x - 0.35, x + 0.35, CROWN, TOP - 2, W1 - 1.5, E - 0.3));

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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as EirakuParts;
}

/** 低層部：ベージュの石の枠に、縦の細いフィンと濃い緑のガラス（1枚 = 3m × 1階） */
export function createEirakuPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#c9bca4';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3d5552';
      g.fillRect(W * 0.12, H * 0.08, W * 0.76, H * 0.84);
      g.fillStyle = '#b9ac93';
      for (const x of [0.36, 0.62]) g.fillRect(W * x, H * 0.08, 3, H * 0.84);
    },
    0.5,
    0.1,
  );
}

/** 塔のガラス：濃い緑灰色のガラスに、細いベージュの縦のフィンと階の線（1枚 = 3m × 1階） */
export function createEirakuGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#7f9a99');
      grad.addColorStop(1, '#55706f');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#cdbfa6';
      g.fillRect(0, 0, 4, H);
      g.fillRect(W / 2 - 1, 0, 3, H);
      g.fillStyle = '#6b6658';
      g.fillRect(0, H - 9, W, 9);
    },
    0.25,
    0.35,
  );
}

/** 東の面の石の格子：ベージュの石に、彫りの深い窓（影の付いた暗いガラス）（1枚 = 3m × 1階） */
export function createEirakuGridMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#d4c6aa';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3f4b52';
      g.fillRect(W * 0.18, H * 0.16, W * 0.64, H * 0.66);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(W * 0.18, H * 0.16, W * 0.64, 6);
      g.fillRect(W * 0.18, H * 0.16, 5, H * 0.66);
    },
    0.7,
    0,
  );
}
