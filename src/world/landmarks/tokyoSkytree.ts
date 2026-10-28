import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 東京スカイツリー（2012年、高さ 634m）と、東京スカイツリータウン（ソラマチの低層部・イーストタワー）。
 * 写真とゾーニング図を参考に、手続き的に形を作る。
 * 座標：スカイツリーの中心が (cx, 0, 0)、x = タウンの長い向き（東へ +）、z = 南へ +、y = 地面からの高さ。
 *
 * - 塔の断面：足元は一辺約 68m の正三角形、上へ行くほど円に近づく（約 300m で円）。白い鋼管の柱と、
 *   リング・ダイヤ形の斜材のトラス。中心に灰色の心柱
 * - 天望デッキ（340〜360m）：3層のガラスの円筒。天望回廊（445〜452m）：細いガラスのリング
 * - その上：ゲイン塔（白い骨組み）とアンテナ（〜634m）
 * - ソラマチ：塔の東西に低層の建物（屋上に緑）。イーストタワー：東の端の高さ 158m のガラスの高層ビル
 */
const WHITE = new THREE.Color(0xf2f4f6);
const CORE = new THREE.Color(0x9ea3a8);

/** 高さ h の、塔の骨組みの外接円の半径 (m)。写真の輪郭から目で測った値を直線でつなぐ */
const PROFILE: Array<[number, number]> = [
  [0, 39],
  [60, 31],
  [150, 24],
  [250, 19.5],
  [340, 17],
  [360, 15],
  [445, 11.5],
  [460, 9],
  [500, 7.5],
  [585, 4],
];
function radius(h: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [h0, r0] = PROFILE[i - 1];
    const [h1, r1] = PROFILE[i];
    if (h <= h1) return r0 + ((r1 - r0) * (h - h0)) / (h1 - h0);
  }
  return PROFILE[PROFILE.length - 1][1];
}

/** 高さ h・角度 a の断面の点までの距離：三角形（足元）から円（300m 以上）へ */
function section(h: number, a: number): number {
  const r = radius(h);
  // 正三角形（外接円の半径 r、頂点は a = 90°, 210°, 330°）の、角度 a の方向の境界までの距離
  const local = ((((a - Math.PI / 2) % ((2 * Math.PI) / 3)) + (2 * Math.PI) / 3) % ((2 * Math.PI) / 3)) - Math.PI / 3;
  const tri = (r * Math.cos(Math.PI / 3)) / Math.cos(local);
  const t = THREE.MathUtils.smoothstep(h, 0, 300);
  return THREE.MathUtils.lerp(tri, r, t);
}

export interface SkytreeParts {
  /** 白い鋼管と心柱（頂点色） */
  steel: THREE.BufferGeometry;
  /** 展望台・イーストタワーのガラス */
  glass: THREE.BufferGeometry;
  /** 展望台の白い床・屋根、ソラマチの壁 */
  white: THREE.BufferGeometry;
  /** ソラマチの壁（暗い灰色） */
  podium: THREE.BufferGeometry;
  /** 屋上の緑 */
  green: THREE.BufferGeometry;
}

export function buildSkytree(cx: number): SkytreeParts {
  const steel: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const white: THREE.BufferGeometry[] = [];
  const podium: THREE.BufferGeometry[] = [];
  const green: THREE.BufferGeometry[] = [];
  const beam = (a: THREE.Vector3, b: THREE.Vector3, t: number, color = WHITE) => steel.push(member(a, b, t, color));

  // ---- 塔の骨組み（0〜585m）：柱 N 本、リングの段ごとにダイヤ形の斜材 ----
  const N = 18;
  const point = (h: number, j: number) => {
    const a = Math.PI / 2 + (j / N) * Math.PI * 2;
    const r = section(h, a);
    return new THREE.Vector3(cx + Math.cos(a) * r, h, -Math.sin(a) * r);
  };
  const rings: number[] = [];
  for (let h = 0; h < 585; h += h < 340 ? 13 : 10) rings.push(h);
  rings.push(585);
  for (let i = 1; i < rings.length; i++) {
    const h0 = rings[i - 1];
    const h1 = rings[i];
    // デッキの中（340〜360m、445〜452m）は骨組みを描かない（展望台の床と壁で隠れる）
    const hidden = (h0 >= 340 && h1 <= 362) || (h0 >= 444 && h1 <= 454);
    const t = THREE.MathUtils.lerp(1.4, 0.45, h0 / 585);
    for (let j = 0; j < N; j++) {
      const a0 = point(h0, j);
      const a1 = point(h1, j);
      const b1 = point(h1, (j + 1) % N);
      const b0 = point(h0, (j + 1) % N);
      // 三角形の頂点の主柱（足元の3本）は太く
      const main = j % (N / 3) === 0 && h0 < 350;
      beam(a0, a1, main ? t * 1.8 : t);
      if (hidden) continue;
      beam(a1, b1, t * 0.6);
      // ダイヤ形：段ごとに斜材の向きを変える
      if (i % 2 === 0) beam(a0, b1, t * 0.5);
      else beam(b0, a1, t * 0.5);
    }
  }
  // 中心の心柱（灰色の円筒）
  for (const [h0, h1, r] of [
    [0, 340, 8],
    [360, 445, 6],
    [452, 500, 4],
  ]) {
    steel.push(colored(new THREE.CylinderGeometry(r, r, h1 - h0, 20).translate(cx, (h0 + h1) / 2, 0), CORE));
  }

  // ---- 天望デッキ（340〜360m）：3層のガラスの円筒と、白い床・屋根 ----
  for (const [y, r] of [
    [340, 24],
    [347, 25.5],
    [354, 24],
  ]) {
    white.push(cyl(cx, y, r + 0.5, 0.8));
    glass.push(cyl(cx, y + 0.8, r, 6.2, true));
  }
  white.push(cyl(cx, 361, 23, 1.2));
  // 天望回廊（445〜452m）：細いガラスのリング
  white.push(cyl(cx, 444, 17.5, 0.8));
  glass.push(cyl(cx, 444.8, 17, 6.4, true));
  white.push(cyl(cx, 451.2, 16.5, 1));

  // ---- アンテナ（585〜634m）：細い柱と継ぎ目 ----
  for (let h = 585; h < 634; h += 7) {
    const top = Math.min(634, h + 7);
    const r0 = THREE.MathUtils.lerp(2.6, 0.5, (h - 585) / 49);
    const r1 = THREE.MathUtils.lerp(2.6, 0.5, (top - 585) / 49);
    steel.push(colored(new THREE.CylinderGeometry(r1, r0, top - h, 10).translate(cx, (h + top) / 2, 0), WHITE));
    white.push(cyl(cx, top - 0.4, r1 + 0.7, 0.4));
  }

  // ---- ソラマチ（低層部）：塔の西と東。塔のまわりは低い 4 階の床（入口フロア） ----
  const block = (x0: number, x1: number, z0: number, z1: number, h: number) => {
    podium.push(new THREE.BoxGeometry(x1 - x0, h, z1 - z0).translate(cx + (x0 + x1) / 2, h / 2, (z0 + z1) / 2));
    // 屋上の緑と白い縁
    green.push(new THREE.BoxGeometry(x1 - x0 - 6, 0.6, z1 - z0 - 6).translate(cx + (x0 + x1) / 2, h + 0.3, (z0 + z1) / 2));
    white.push(new THREE.BoxGeometry(x1 - x0 + 0.6, 1.2, z1 - z0 + 0.6).translate(cx + (x0 + x1) / 2, h - 0.6, (z0 + z1) / 2));
    // 階ごとの白い帯
    for (let y = 5; y < h - 2; y += 5) {
      white.push(new THREE.BoxGeometry(x1 - x0 + 0.3, 0.5, z1 - z0 + 0.3).translate(cx + (x0 + x1) / 2, y, (z0 + z1) / 2));
    }
  };
  block(-179, -50, -65, 25, 24);
  block(50, 207, -65, 25, 28);
  // 塔の北側の 4 階の入口フロア
  block(-50, 50, -65, -44, 15);

  // ---- イーストタワー（東の端、高さ 158m）：低層部の上に、角を丸めたガラスの高層棟 ----
  const ET = { x: 283, z: -21, dir: Math.atan2(-0.914, 0.407) };
  const etGroup: THREE.BufferGeometry[] = [];
  const etGlass: THREE.BufferGeometry[] = [];
  etGroup.push(new THREE.BoxGeometry(90, 22, 48));
  green.push(new THREE.BoxGeometry(84, 0.6, 42).translate(0, 22.3, 0).rotateY(-ET.dir).translate(cx + ET.x, 0, ET.z));
  const shape = roundedRect(58, 30, 12);
  const tower = new THREE.ExtrudeGeometry(shape, { depth: 136, bevelEnabled: false, curveSegments: 8 })
    .rotateX(-Math.PI / 2)
    .translate(0, 22, 0);
  etGlass.push(tower);
  // 階ごとの水平の帯（白い縁）
  for (let y = 26; y < 158; y += 4.4) {
    etGroup.push(
      new THREE.ExtrudeGeometry(roundedRect(58.6, 30.6, 12.3), { depth: 0.5, bevelEnabled: false, curveSegments: 8 })
        .rotateX(-Math.PI / 2)
        .translate(0, y, 0),
    );
  }
  // 頂部の少し細い塔屋
  etGroup.push(
    new THREE.ExtrudeGeometry(roundedRect(40, 20, 8), { depth: 6, bevelEnabled: false, curveSegments: 8 })
      .rotateX(-Math.PI / 2)
      .translate(0, 158, 0),
  );
  const place = (g: THREE.BufferGeometry) => g.rotateY(-ET.dir).translate(cx + ET.x, 0, ET.z);
  for (const g of etGroup) white.push(place(g.translate(0, g === etGroup[0] ? 11 : 0, 0)));
  for (const g of etGlass) glass.push(place(g));

  const merge = (list: THREE.BufferGeometry[], keepColor = false) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes)) {
        if (name !== 'position' && !(keepColor && name === 'color')) out.deleteAttribute(name);
      }
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return {
    steel: merge(steel, true),
    glass: merge(glass),
    white: merge(white),
    podium: merge(podium),
    green: merge(green),
  };
}

/** 角を丸めた長方形（中心が原点、x・y の平面。押し出した後に x・z へ回す） */
function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function cyl(cx: number, y: number, r: number, h: number, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, h, 36, 1, open).translate(cx, y + h / 2, 0);
}

function colored(g: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position') out.deleteAttribute(name);
  const n = out.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return out;
}

/** a から b への鋼管（断面 t m の八角形） */
function member(a: THREE.Vector3, b: THREE.Vector3, t: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(t / 2, t / 2, a.distanceTo(b), 6, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return colored(g, color);
}
