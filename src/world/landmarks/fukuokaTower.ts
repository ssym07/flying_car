import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 福岡タワー（1989年、高さ 234m）。写真を参考に作る。
 * 座標：塔の中心が (cx, 0, 0)、x = 東、z = 南、y = 上。
 *
 * - 本体：平面は一辺 28m の正三角形の柱。北の辺が海（百道浜）を向き、南の角が正面の道を向く。
 *   全面を青いハーフミラーのガラスで包む
 * - 屋根：南の角へ下がる斜めの面で切る（南から見上げると、白い三角の屋根が「▽」に見える）
 * - アンテナ：屋根の上に、白い鉄骨の三角の骨組み（234m まで）。途中に2段の丸い台
 * - 足元：PLATEAU の低い箱の代わりに、本体を囲む高さ 6m の低い建物
 */
export interface FukuokaTowerParts {
  glass: THREE.BufferGeometry;
  /** 屋根・足元の建物の縁 */
  white: THREE.BufferGeometry;
  /** アンテナの鉄骨と台 */
  steel: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
}

const SIDE = 28;
const R = SIDE / Math.sqrt(3);
/** 屋根の高さ：南の角と、北の2つの角 */
const TOP_SOUTH = 136;
const TOP_NORTH = 150;
const HEIGHT = 234;
/** アンテナの骨組みの根元の半径（三角の角まで）と、てっぺんの半径 */
const MAST_BASE = 5.5;
const MAST_TOP = 0.7;
const PODIUM_H = 6;
const PODIUM_GROW = 5;

/** 平面の三角の角（南・北東・北西）。grow m 外へ広げる */
function corners(cx: number, grow = 0): Array<[number, number]> {
  const r = R + grow * 2;
  return [Math.PI / 2, -Math.PI / 6, (-5 * Math.PI) / 6].map((a) => [cx + Math.cos(a) * r, Math.sin(a) * r]);
}

/** 角 k の屋根の高さ（0 = 南の角） */
const topOf = (k: number) => (k === 0 ? TOP_SOUTH : TOP_NORTH);

/** 2点を結ぶ角材 */
export function beam(out: THREE.BufferGeometry[], a: THREE.Vector3, b: THREE.Vector3, w: number): void {
  const len = a.distanceTo(b);
  if (len < 1e-3) return;
  const g = new THREE.BoxGeometry(w, w, len);
  const m = new THREE.Matrix4().lookAt(b, a, Math.abs(b.y - a.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  out.push(g.toNonIndexed());
}

export function buildFukuokaTower(cx: number): FukuokaTowerParts {
  const c = corners(cx);

  // ---- 本体のガラスの面（3面）。屋根が斜めなので、上の縁は角ごとの高さ ----
  const pos: number[] = [];
  const uv: number[] = [];
  let u0 = 0;
  for (let k = 0; k < 3; k++) {
    const [ax, az] = c[k];
    const [bx, bz] = c[(k + 1) % 3];
    const ha = topOf(k);
    const hb = topOf((k + 1) % 3);
    // 面を縦に細かく分けて、上の縁を斜めの屋根に沿わせる
    const N = 8;
    for (let i = 0; i < N; i++) {
      const t0 = i / N;
      const t1 = (i + 1) / N;
      const x0 = ax + (bx - ax) * t0;
      const z0 = az + (bz - az) * t0;
      const x1 = ax + (bx - ax) * t1;
      const z1 = az + (bz - az) * t1;
      const y0 = ha + (hb - ha) * t0;
      const y1 = ha + (hb - ha) * t1;
      const s0 = (u0 + SIDE * t0) / 3;
      const s1 = (u0 + SIDE * t1) / 3;
      pos.push(x0, 0, z0, x1, 0, z1, x1, y1, z1, x0, 0, z0, x1, y1, z1, x0, y0, z0);
      uv.push(s0, 0, s1, 0, s1, y1 / FLOOR, s0, 0, s1, y1 / FLOOR, s0, y0 / FLOOR);
    }
    u0 += SIDE;
  }
  const glass = new THREE.BufferGeometry();
  glass.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  glass.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  glass.computeVertexNormals();

  // ---- 白い屋根（斜めの三角）と、屋根の縁の白い枠 ----
  const whites: THREE.BufferGeometry[] = [];
  const roof = new THREE.BufferGeometry();
  const top = c.map(([x, z], k) => new THREE.Vector3(x, topOf(k), z));
  roof.setAttribute('position', new THREE.Float32BufferAttribute(top.flatMap((v) => [v.x, v.y, v.z]), 3));
  roof.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  roof.computeVertexNormals();
  whites.push(roof);
  for (let k = 0; k < 3; k++) beam(whites, top[k], top[(k + 1) % 3], 0.9);
  // 角の縦の白い線（ガラスの角の金物）
  for (let k = 0; k < 3; k++) beam(whites, new THREE.Vector3(c[k][0], PODIUM_H, c[k][1]), top[k], 0.5);

  // ---- アンテナ：三角の骨組み ----
  const steel: THREE.BufferGeometry[] = [];
  const roofCenter = top.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / 3);
  const base = TOP_NORTH - 4;
  const mastTop = HEIGHT - 8;
  const mastAt = (y: number) => {
    const t = (y - base) / (mastTop - base);
    const r = MAST_BASE + (MAST_TOP - MAST_BASE) * Math.sqrt(t);
    return [0, 1, 2].map((k) => {
      const a = Math.PI / 2 + (k * Math.PI * 2) / 3;
      return new THREE.Vector3(roofCenter.x + Math.cos(a) * r, y, Math.sin(a) * r);
    });
  };
  const STEP = 4;
  let prev = mastAt(base);
  for (let y = base + STEP; y <= mastTop + 1e-6; y += STEP) {
    const ring = mastAt(y);
    for (let k = 0; k < 3; k++) {
      beam(steel, prev[k], ring[k], 0.45);
      beam(steel, ring[k], ring[(k + 1) % 3], 0.22);
      // 面ごとの斜材（段ごとに向きを変えて X に見せる）
      beam(steel, prev[k], ring[(k + 1) % 3], 0.16);
      beam(steel, prev[(k + 1) % 3], ring[k], 0.16);
    }
    prev = ring;
  }
  // てっぺんの細い棒
  beam(steel, new THREE.Vector3(roofCenter.x, mastTop, 0), new THREE.Vector3(roofCenter.x, HEIGHT, 0), 0.35);
  // 途中の2段の丸い台（アンテナの機器の足場）
  for (const [y, r] of [
    [166, 4.2],
    [182, 3.0],
  ]) {
    const deck = new THREE.CylinderGeometry(r, r, 1.0, 18).toNonIndexed();
    deck.translate(roofCenter.x, y, 0);
    steel.push(deck);
  }
  // 根元：屋根から骨組みを受ける短い台
  const foot = new THREE.CylinderGeometry(MAST_BASE + 0.8, MAST_BASE + 1.2, 3, 3).toNonIndexed();
  foot.rotateY(Math.PI / 6);
  foot.translate(roofCenter.x, base + 0.5, 0);
  steel.push(foot);

  // ---- 足元の低い建物：本体を囲む三角を、角を落として広げた形 ----
  const pc = corners(cx, PODIUM_GROW);
  const shape = new THREE.Shape();
  pc.forEach(([x, z], k) => {
    const [px, pz] = pc[(k + 2) % 3];
    const [nx, nz] = pc[(k + 1) % 3];
    // 角を 4m 落とす
    const cut = 4 / (SIDE + PODIUM_GROW * 2 * Math.sqrt(3));
    const p0: [number, number] = [x + (px - x) * cut, z + (pz - z) * cut];
    const p1: [number, number] = [x + (nx - x) * cut, z + (nz - z) * cut];
    if (k === 0) shape.moveTo(p0[0], -p0[1]);
    else shape.lineTo(p0[0], -p0[1]);
    shape.lineTo(p1[0], -p1[1]);
  });
  const podium = new THREE.ExtrudeGeometry(shape, { depth: PODIUM_H, bevelEnabled: false });
  // Shape は x-y 平面なので、y を -z にして立てる
  podium.rotateX(-Math.PI / 2);
  const rim = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
  rim.rotateX(-Math.PI / 2);
  rim.scale(1.01, 1, 1.01);
  rim.translate(-cx * 0.01, PODIUM_H, 0);
  whites.push(rim.toNonIndexed());

  const merge = (list: THREE.BufferGeometry[]) => {
    for (const g of list) {
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
    }
    return list.length > 0 ? mergeGeometries(list) : new THREE.BufferGeometry();
  };
  return { glass, white: merge(whites), steel: merge(steel), podium: podium.toNonIndexed() };
}

/** 青いハーフミラーのガラス：細かいパネルの目地と、上ほど空を映して明るくなる帯 */
export function createFukuokaTowerGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#3d74c4');
      grad.addColorStop(1, '#1f4f99');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      // 空を映す明るい斜めの帯
      g.fillStyle = 'rgba(170,205,255,0.18)';
      g.beginPath();
      g.moveTo(0, H * 0.2);
      g.lineTo(W, 0);
      g.lineTo(W, H * 0.25);
      g.lineTo(0, H * 0.45);
      g.fill();
      // パネルの目地（横2本・縦1本）
      g.fillStyle = 'rgba(15,30,60,0.55)';
      g.fillRect(0, 0, W, 2);
      g.fillRect(0, H / 2, W, 1);
      g.fillRect(0, 0, 1, H);
    },
    0.12,
    0.55,
  );
}
