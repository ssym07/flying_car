import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';
import { beam } from './fukuokaTower';

/**
 * 博多ポートタワー（1964年、高さ 103m）。写真を参考に作る。
 * 座標：塔の中心が (cx, 0, 0)、x・z が四角い塔の辺の向き、y = 上。
 *
 * - 骨組み：赤い鉄骨の四角い塔。地面で一辺約 31m の脚から、内へ反った線で細くなり、展望室の下（66m）で一辺約 10m。
 *   段ごとの水平材と、各面の X 形の斜材
 * - 芯：骨組みの中を通る、白い八角形の柱（エレベーター）。縦の細い窓
 * - 展望室（70m）：八角形。下は白いラッパ形に広がり、ガラスの2段の窓、白い屋根。屋上に小さな八角の塔屋とアンテナ
 * - 足元の低い建物は PLATEAU の箱のまま（脚がその上をまたぐ）
 */
export interface PortTowerParts {
  steel: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  window: THREE.BufferGeometry;
}

/** 高さ h (m) での骨組みの幅の半分。写真の輪郭から目で測った値 */
const PROFILE: Array<[number, number]> = [
  [0, 15.5],
  [12, 11.5],
  [26, 8.6],
  [42, 6.6],
  [66, 5.2],
];
/** 水平材の高さ */
const LEVELS = [0, 6, 12, 19, 26, 34, 42, 50, 58, 66];
const CORE_R = 4.2;
const DECK_R = 11.5;

function halfWidth(h: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [h0, w0] = PROFILE[i - 1];
    const [h1, w1] = PROFILE[i];
    if (h <= h1) return w0 + ((w1 - w0) * (h - h0)) / (h1 - h0);
  }
  return PROFILE[PROFILE.length - 1][1];
}

/** 八角形の筒（y0〜y1、半径 r0→r1）。辺が x・z に平行になるよう回す。uv の u は周り 2.5m ごと、v は高さの割合 × vScale */
function octagon(y0: number, y1: number, r0: number, r1: number, capped: boolean, vScale = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, 8, 1, !capped);
  g.rotateY(Math.PI / 8);
  g.translate(0, (y0 + y1) / 2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const around = (8 * 2 * Math.max(r0, r1) * Math.sin(Math.PI / 8)) / 2.5;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.round(around), uv.getY(i) * vScale);
  return g.toNonIndexed();
}

export function buildHakataPortTower(cx: number): PortTowerParts {
  const steel: THREE.BufferGeometry[] = [];
  const corner = (h: number, k: number) => {
    const w = halfWidth(h);
    return new THREE.Vector3(cx + (k === 0 || k === 3 ? -w : w), h, k < 2 ? -w : w);
  };
  // 脚・水平材・斜材
  for (let i = 1; i < LEVELS.length; i++) {
    const h0 = LEVELS[i - 1];
    const h1 = LEVELS[i];
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      beam(steel, corner(h0, k), corner(h1, k), 1.0);
      beam(steel, corner(h1, k), corner(h1, n), 0.6);
      beam(steel, corner(h0, k), corner(h1, n), 0.45);
      beam(steel, corner(h0, n), corner(h1, k), 0.45);
    }
  }
  // 展望室の下の受け台：骨組みの上から芯へ、斜めに支える
  for (let k = 0; k < 4; k++) {
    const top = corner(66, k);
    beam(steel, top, new THREE.Vector3(cx + (top.x - cx) * 1.6, 68.5, top.z * 1.6), 0.6);
  }
  // アンテナ：屋上の塔屋から 103m まで、赤い細い柱と2つの輪
  const pole = new THREE.CylinderGeometry(0.3, 0.7, 17, 8).toNonIndexed();
  pole.translate(cx, 86 + 8.5, 0);
  steel.push(pole);
  for (const y of [92, 98]) {
    const ring = new THREE.CylinderGeometry(1.1, 1.1, 0.5, 8).toNonIndexed();
    ring.translate(cx, y, 0);
    steel.push(ring);
  }

  // 芯：白い八角の柱（地面から展望室の下まで）
  const core = octagon(0, 64, CORE_R, CORE_R, false, 64 / FLOOR);
  core.translate(cx, 0, 0);

  // 展望室
  const whites = [
    // 下のラッパ形の白い受け
    octagon(63, 69, CORE_R + 0.4, DECK_R, false),
    // 2段の窓の間の白い帯
    octagon(74.4, 75.4, DECK_R + 0.3, DECK_R + 0.3, true),
    // 屋根と、屋上の塔屋
    octagon(80, 81, DECK_R + 0.2, DECK_R - 0.6, true),
    octagon(81, 85, 5.2, 4.6, true),
    octagon(85, 86, 3.2, 2.6, true),
  ];
  for (const g of whites) g.translate(cx, 0, 0);
  const windows = [octagon(69, 74.4, DECK_R, DECK_R, false), octagon(75.4, 80, DECK_R, DECK_R - 0.5, false)];
  for (const g of windows) g.translate(cx, 0, 0);

  const merge = (list: THREE.BufferGeometry[], keepUv = false) => {
    for (const g of list) {
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && !(keepUv && name === 'uv')) g.deleteAttribute(name);
      }
      if (!g.getAttribute('normal')) g.computeVertexNormals();
    }
    return mergeGeometries(list);
  };
  return { steel: merge(steel), core, white: merge(whites), window: merge(windows, true) };
}

/** 芯の白い柱：縦の細い窓 */
export function createPortTowerCoreMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#e9ebea';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#5d6872';
      g.fillRect(W * 0.44, 0, W * 0.12, H);
    },
    0.55,
    0.05,
  );
}

/** 展望室の窓：濃い青灰色のガラスに、白い縦の桟 */
export function createPortTowerWindowMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#44586a';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(200,225,245,0.25)';
      g.fillRect(0, 0, W, H * 0.4);
      g.fillStyle = '#f0f1ef';
      g.fillRect(0, 0, 4, H);
      g.fillRect(0, H - 6, W, 6);
    },
    0.15,
    0.4,
  );
}
