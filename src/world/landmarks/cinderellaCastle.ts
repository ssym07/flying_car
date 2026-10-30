import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * シンデレラ城（東京ディズニーランド、1983年、51m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 東、z = 南（正面はワールドバザール側の南）、y = 上。
 *
 * - 土台：岩の石垣の台。南北にアーチの通り抜け（暗いアーチの口）
 * - 城の本体：白い石の壁の2段。上の縁に凸凹の狭間（はざま）
 * - 塔：四隅と2段目に、丸い塔と青いとんがり屋根・金の飾り。正面に切妻の屋根の張り出し
 * - 中央：八角の塔に高い青い屋根と金の尖塔（てっぺん 51m）
 */
export interface CastleParts {
  base: THREE.BufferGeometry;
  wall: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  gold: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

export function buildCinderellaCastle(cx: number): CastleParts {
  const P: Record<keyof CastleParts, THREE.BufferGeometry[]> = { base: [], wall: [], roof: [], gold: [], dark: [] };
  const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(cx + x, y, z);

  /** 丸い塔：半径 r、壁は y0〜y1、とんがり屋根の高さ h。屋根の上に金の飾り */
  const tower = (x: number, z: number, r: number, y0: number, y1: number, h: number) => {
    P.wall.push(at(new THREE.CylinderGeometry(r, r * 1.05, y1 - y0, 16), x, (y0 + y1) / 2, z));
    // 屋根の下の張り出した縁
    P.wall.push(at(new THREE.CylinderGeometry(r * 1.18, r * 1.18, 0.7, 16), x, y1 - 0.35, z));
    P.roof.push(at(new THREE.ConeGeometry(r * 1.25, h, 16), x, y1 + h / 2, z));
    P.gold.push(at(new THREE.CylinderGeometry(0.12, 0.2, h * 0.28, 6), x, y1 + h + h * 0.14, z));
    P.gold.push(at(new THREE.SphereGeometry(r * 0.12 + 0.15, 8, 6), x, y1 + h * 0.98, z));
    // 細長い窓（4方向）
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      P.dark.push(
        at(new THREE.BoxGeometry(0.5, 1.8, 0.3).rotateY(-a), x + Math.cos(a) * r * 1.01, y1 - 3, z + Math.sin(a) * r * 1.01),
      );
    }
  };
  /** 壁の上の狭間（凸凹）：x0〜x1・z の辺に沿って */
  const merlonsX = (x0: number, x1: number, y: number, z: number) => {
    for (let x = x0 + 0.6; x < x1 - 0.3; x += 1.6) P.wall.push(at(box(0, 0.8, 0, 1, -0.3, 0.3), x, y, z));
  };
  const merlonsZ = (z0: number, z1: number, y: number, x: number) => {
    for (let z = z0 + 0.6; z < z1 - 0.3; z += 1.6) P.wall.push(at(box(-0.3, 0.3, 0, 1, 0, 0.8), x, y, z));
  };

  // ---- 土台：岩の石垣（少し裾広がり）と、南北の通り抜けのアーチ ----
  P.base.push(at(new THREE.CylinderGeometry(21, 23, 9, 8, 1).rotateY(Math.PI / 8).scale(1, 1, 0.9), 0, 4.5, 0));
  // アーチ：四角い口と、上の丸い部分（南北に通した円柱。両端の面だけが石垣から見える）
  P.dark.push(at(box(-3.2, 3.2, 0, 6.2, -19.4, 19.4), 0, 0, 0));
  P.dark.push(at(new THREE.CylinderGeometry(3.2, 3.2, 38.8, 16).rotateX(Math.PI / 2), 0, 6.2, 0));

  // ---- 1段目の本体（9〜20m）と四隅の太い塔 ----
  P.wall.push(at(box(-15, 15, 9, 20, -11, 11), 0, 0, 0));
  merlonsX(-15, 15, 20, -11);
  merlonsX(-15, 15, 20, 11);
  merlonsZ(-11, 11, 20, -15);
  merlonsZ(-11, 11, 20, 15);
  for (const [x, z] of [
    [-15, -11],
    [15, -11],
    [-15, 11],
    [15, 11],
  ]) {
    tower(x, z, 3.4, 9, 25, 9);
  }
  // 正面（南）の、アーチの上の張り出しと切妻の屋根
  P.wall.push(at(box(-6, 6, 9, 27, 9, 14), 0, 0, 0));
  P.roof.push(at(new THREE.CylinderGeometry(0, 8.4, 7, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.55), 0, 30.5, 11.5));
  P.dark.push(at(box(-1.4, 1.4, 14, 22, 13.9, 14.2), 0, 0, 0));
  P.gold.push(at(new THREE.CylinderGeometry(0.1, 0.18, 2.5, 6), 0, 35.2, 11.5));
  // 正面の窓の列
  for (const x of [-10, -6.5, 6.5, 10]) P.dark.push(at(box(-0.6, 0.6, 13, 17, 10.9, 11.2), x, 0, 0));

  // ---- 2段目（20〜31m）と、まわりの細い塔 ----
  P.wall.push(at(box(-9, 9, 20, 31, -7, 7), 0, 0, 0));
  merlonsX(-9, 9, 31, -7);
  merlonsX(-9, 9, 31, 7);
  merlonsZ(-7, 7, 31, -9);
  merlonsZ(-7, 7, 31, 9);
  for (const [x, z, h] of [
    [-9, -7, 34],
    [9, -7, 34],
    [-9, 7, 36],
    [9, 7, 36],
  ]) {
    tower(x, z, 2.2, 20, h, 7);
  }
  // 横の細い塔（高さを変えて、にぎやかに）
  tower(-12, 0, 1.8, 20, 32, 6);
  tower(12, 0, 1.8, 20, 30, 6);
  tower(-5, 9.5, 1.5, 27, 33, 5);
  tower(5, 9.5, 1.5, 27, 33, 5);
  for (const x of [-5.5, -2, 2, 5.5]) P.dark.push(at(box(-0.5, 0.5, 24, 28, 6.9, 7.2), x, 0, 0));

  // ---- 中央の八角の塔（31〜41m）と高い青い屋根・金の尖塔（〜51m） ----
  P.wall.push(at(new THREE.CylinderGeometry(4.4, 4.6, 10, 8), 0, 36, 0));
  P.wall.push(at(new THREE.CylinderGeometry(5.1, 5.1, 0.8, 8), 0, 40.6, 0));
  P.roof.push(at(new THREE.ConeGeometry(5.3, 8.6, 8), 0, 45.3, 0));
  P.gold.push(at(new THREE.CylinderGeometry(0.12, 0.3, 2.4, 6), 0, 50.4, 0));
  P.gold.push(at(new THREE.SphereGeometry(0.45, 8, 6), 0, 49.2, 0));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    P.dark.push(at(new THREE.BoxGeometry(0.7, 2.6, 0.3).rotateY(-a), Math.cos(a) * 4.45, 37, Math.sin(a) * 4.45));
  }
  // 金の帯（屋根の縁）
  P.gold.push(at(new THREE.TorusGeometry(5.2, 0.12, 4, 24).rotateX(Math.PI / 2), 0, 41.05, 0));

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
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as CastleParts;
}
