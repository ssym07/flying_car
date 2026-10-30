import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 日本武道館（1964年、42m）。法隆寺夢殿を手本にした八角形。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 東、z = 南、y = 上。八角形の角の向きは OSM の形に合わせる（THETA0）。
 *
 * - 1階：コンクリートの壁とガラスの入口。2階の帯にガラスの窓の列
 * - 角ごとに、軒を支える太いコンクリートの斜めの梁
 * - 上の壁は縦の格子（ルーバー）
 * - 大きく張り出した軒（金茶色の鼻先）と、反りのある緑青色の八角の屋根。角の稜線は濃い色
 * - てっぺんに金の擬宝珠（ぎぼし）
 */
export interface BudokanParts {
  concrete: THREE.BufferGeometry;
  louver: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  eave: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  ridge: THREE.BufferGeometry;
  gold: THREE.BufferGeometry;
}

/** 八角形の角の向き（東から北へ, rad） */
const THETA0 = (189.5 * Math.PI) / 180;

export function buildBudokan(cx: number): BudokanParts {
  const P: Record<keyof BudokanParts, THREE.BufferGeometry[]> = {
    concrete: [],
    louver: [],
    glass: [],
    eave: [],
    roof: [],
    ridge: [],
    gold: [],
  };
  /** 八角形の角 k（半径 R = 中心から角まで）の点 */
  const corner = (k: number, R: number, y: number) => {
    const a = THETA0 + (k * Math.PI) / 4;
    return new THREE.Vector3(cx + R * Math.cos(a), y, -R * Math.sin(a));
  };
  /** 八角形 R0（高さ y0）から R1（高さ y1）までの帯（8枚の四角） */
  const band = (list: THREE.BufferGeometry[], R0: number, y0: number, R1: number, y1: number) => {
    const pos: number[] = [];
    const uv: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = corner(k, R0, y0);
      const b = corner(k + 1, R0, y0);
      const c = corner(k + 1, R1, y1);
      const d = corner(k, R1, y1);
      const w = a.distanceTo(b);
      const h = Math.hypot(R1 - R0, y1 - y0);
      pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
      uv.push(0, 0, w, 0, w, h, 0, 0, w, h, 0, h);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    list.push(g);
  };
  const strut = (list: THREE.BufferGeometry[], from: THREE.Vector3, to: THREE.Vector3, w: number, h: number) => {
    const d = new THREE.Vector3().subVectors(to, from);
    const g = new THREE.BoxGeometry(w, d.length(), h);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    list.push(g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2));
  };

  // ---- 1階（0〜7m）：コンクリートの壁、各面の真ん中にガラスの入口 ----
  band(P.concrete, 50, 0, 50, 7);
  for (let k = 0; k < 8; k++) {
    const a = corner(k, 50.3, 0);
    const b = corner(k + 1, 50.3, 0);
    const m = a.clone().lerp(b, 0.5);
    const along = b.clone().sub(a).normalize();
    const g = new THREE.BoxGeometry(14, 4.5, 0.4);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), along));
    P.glass.push(g.translate(m.x, 2.25, m.z));
  }
  // 2階の張り出した床（7〜8.5m）と、窓の帯（8.5〜11m）
  band(P.concrete, 50, 7, 53, 7);
  band(P.concrete, 53, 7, 53, 8.5);
  band(P.concrete, 53, 8.5, 48, 8.5);
  band(P.glass, 48, 8.5, 48, 11);
  band(P.concrete, 48, 11, 48, 13);
  // ---- 上の壁（13〜21m）：縦の格子 ----
  band(P.louver, 47, 13, 47, 21.5);
  // ---- 角の太い斜めの梁：2階の床から軒の下へ（各角に2本、少し開いて） ----
  for (let k = 0; k < 8; k++) {
    for (const off of [-0.06, 0.06]) {
      const from = corner(k + off, 49, 8.5);
      const to = corner(k + off * 0.5, 57, 21);
      strut(P.concrete, from, to, 1.6, 1.4);
    }
    // 面の中ほどにも細い支え
    strut(P.concrete, corner(k + 0.5, 47.5, 13), corner(k + 0.5, 55, 21), 0.9, 0.9);
  }
  // ---- 軒：裏（21m）と、金茶色の鼻先（21〜24m）。張り出しは角まで 58m ----
  band(P.concrete, 47, 21.5, 58, 21);
  band(P.eave, 58, 21, 58.5, 24);
  // ---- 屋根：反りのある緑青色の八角の屋根（24m → 38m）。上ほど急に細くなる ----
  const STEPS = 10;
  const rAt = (t: number) => 58.5 * (1 - t) ** 1.35 + 2.4 * t;
  const yAt = (t: number) => 24 + 14 * t;
  for (let i = 0; i < STEPS; i++) {
    const t0 = i / STEPS;
    const t1 = (i + 1) / STEPS;
    band(P.roof, rAt(t0), yAt(t0), rAt(t1), yAt(t1));
  }
  // 角の稜線（濃い色の細い帯）
  for (let k = 0; k < 8; k++) {
    for (let i = 0; i < STEPS; i++) {
      const t0 = i / STEPS;
      const t1 = (i + 1) / STEPS;
      strut(P.ridge, corner(k, rAt(t0) + 0.2, yAt(t0) + 0.25), corner(k, rAt(t1) + 0.2, yAt(t1) + 0.25), 0.9, 0.5);
    }
  }
  // ---- てっぺん：八角の台と金の擬宝珠 ----
  band(P.ridge, 2.6, 38, 2.6, 39.2);
  band(P.ridge, 2.6, 39.2, 0.01, 39.2);
  P.gold.push(new THREE.SphereGeometry(1.7, 16, 12).scale(1, 0.95, 1).translate(cx, 40.7, 0));
  P.gold.push(new THREE.ConeGeometry(0.9, 1.4, 16).translate(cx, 42.6, 0));

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
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as BudokanParts;
}

/** 縦の格子：明るい灰色の縦の板と、奥の暗い影（1枚 = 幅 1m × 高さ 4m） */
export function createBudokanLouverMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#4a4c50';
  g.fillRect(0, 0, 32, 64);
  g.fillStyle = '#c9c6bd';
  g.fillRect(4, 0, 18, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1 / 4);
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, side: THREE.DoubleSide });
}
