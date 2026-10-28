import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 東京タワー（1958年、高さ 333m）。写真を参考に、鉄骨の骨組みを細い角材で組む。
 * 座標：中心が (cx, 0, 0)、x・z が四角い塔の辺の向き、y = 地面からの高さ。
 *
 * - 脚：地面で一辺約 80m の四角から、ゆるく反った線で細くなる。下の 45m は脚が4本に分かれ、間は大きなアーチ
 * - 骨組み：四隅の柱、各段の水平材、各面の X 形の斜材。メインデッキ（150m）の下はインターナショナルオレンジ、
 *   上はオレンジと白を交互に塗る
 * - メインデッキ（145〜154m）：八角形の2層の展望台（ガラス）。トップデッキ（約 250m）も小さな展望台
 * - アンテナ（253〜333m）：赤と白の帯
 * - 足元の建物（フットタウン）：PLATEAU の箱（屋上の設備まで含んだ 42m）の代わりに、高さ 22m の箱と窓の帯
 */
const ORANGE = new THREE.Color(0xe8471c);
const WHITE = new THREE.Color(0xeeeeec);

/** 高さ h (m) での塔の幅の半分（四隅の柱の位置）。写真の輪郭から目で測った値を、なめらかにつなぐ */
const PROFILE: Array<[number, number]> = [
  [0, 40],
  [20, 31],
  [45, 22],
  [80, 15],
  [120, 10.5],
  [150, 8.5],
  [200, 6],
  [250, 3.6],
];
function halfWidth(h: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [h0, w0] = PROFILE[i - 1];
    const [h1, w1] = PROFILE[i];
    if (h <= h1) {
      const t = (h - h0) / (h1 - h0);
      // 区間の中は、なめらかに（両端の傾きをそろえる程度に）
      return w0 + (w1 - w0) * (t * t * (3 - 2 * t) * 0.35 + t * 0.65);
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

/** 高さ h (m) での脚の断面の一辺 (m)。下の 45m だけ */
function legSize(h: number): number {
  return THREE.MathUtils.lerp(10, 4, Math.min(1, h / 45));
}

/** 高さ h (m) の色：メインデッキの下はオレンジ、上は約 12m ごとにオレンジと白を交互に */
function paint(h: number): THREE.Color {
  if (h < 150) return ORANGE;
  return Math.floor((h - 154) / 12) % 2 === 0 ? ORANGE : WHITE;
}

export interface TowerParts {
  /** 鉄骨（頂点色） */
  steel: THREE.BufferGeometry;
  /** 展望台のガラス */
  glass: THREE.BufferGeometry;
  /** 展望台の白い枠・床・屋根 */
  deck: THREE.BufferGeometry;
  /** 足元の建物の壁 */
  base: THREE.BufferGeometry;
}

/** 足元の建物（フットタウン）：塔の中心からの位置（x = 長い向き、z）・大きさ (m)。4本の脚の間に収める */
const FOOT_TOWN = { x: 0, z: 0, length: 70, depth: 45, height: 22 };

export function buildTokyoTower(cx: number): TowerParts {
  const steel: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const deck: THREE.BufferGeometry[] = [];
  const corner = (h: number, sx: number, sz: number, inset = 0) => {
    const w = halfWidth(h) - inset;
    return new THREE.Vector3(cx + sx * w, h, sz * w);
  };
  const corners: Array<[number, number]> = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  const beam = (a: THREE.Vector3, b: THREE.Vector3, t: number, color?: THREE.Color) =>
    steel.push(member(a, b, t, color ?? paint((a.y + b.y) / 2)));

  // ---- 下の 45m：4本の脚（それぞれ四角い骨組み）と、脚の間のアーチ ----
  const LEG_TOP = 45;
  const legLevels = [0, 9, 18, 27, 36, LEG_TOP];
  for (const [sx, sz] of corners) {
    // 脚の断面：外側の角は塔の輪郭、内側へ s(h) の四角
    const section = (h: number) => {
      const s = legSize(h);
      const o = corner(h, sx, sz);
      return [
        o,
        o.clone().add(new THREE.Vector3(-sx * s, 0, 0)),
        o.clone().add(new THREE.Vector3(-sx * s, 0, -sz * s)),
        o.clone().add(new THREE.Vector3(0, 0, -sz * s)),
      ];
    };
    for (let i = 1; i < legLevels.length; i++) {
      const lo = section(legLevels[i - 1]);
      const hi = section(legLevels[i]);
      for (let k = 0; k < 4; k++) {
        beam(lo[k], hi[k], 0.9);
        beam(hi[k], hi[(k + 1) % 4], 0.45);
        beam(lo[k], hi[(k + 1) % 4], 0.35);
        beam(lo[(k + 1) % 4], hi[k], 0.35);
      }
    }
  }
  // 脚の間のアーチ（各面）：両側の脚の内側の柱（角から legSize ぶん内側）から立ち上がり、面の中央で LEG_TOP の水平材に届く。
  // 面の上の点：面の向きに固定した座標は塔の輪郭（halfWidth）、面に沿った座標 u は角から角へ
  const SPRING = 8;
  const onFace = (k: number, u: number, h: number) => {
    const [ax, az] = corners[k];
    const [bx] = corners[(k + 1) % 4];
    const w = halfWidth(h);
    // a と b で同じ側の座標が面の向き。もう一方が面に沿った向き（a の側が +u）
    return ax === bx
      ? new THREE.Vector3(cx + ax * w, h, az * u)
      : new THREE.Vector3(cx + ax * u, h, az * w);
  };
  for (let k = 0; k < 4; k++) {
    const pts: THREE.Vector3[] = [];
    const us: number[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const h = SPRING + (LEG_TOP - SPRING) * Math.sin(t * Math.PI);
      const u = (halfWidth(h) - legSize(h)) * (1 - 2 * t);
      pts.push(onFace(k, u, h));
      us.push(u);
    }
    for (let i = 1; i < pts.length; i++) {
      beam(pts[i - 1], pts[i], 1.1);
      // アーチと LEG_TOP の水平材をつなぐ縦の材（水平材の範囲の中だけ）
      if (i < pts.length - 1 && i % 2 === 0 && Math.abs(us[i]) < halfWidth(LEG_TOP) - 1.5 && pts[i].y < LEG_TOP - 1.5) {
        beam(pts[i], onFace(k, us[i], LEG_TOP), 0.35);
      }
    }
    // アーチの足元を、脚の内側の柱に沿って地面まで下ろす
    beam(onFace(k, halfWidth(0) - legSize(0), 0), pts[0], 1.1);
    beam(onFace(k, -(halfWidth(0) - legSize(0)), 0), pts[pts.length - 1], 1.1);
  }

  // ---- 45m から上：四隅の柱・水平材・X 形の斜材 ----
  const levels: number[] = [LEG_TOP];
  while (levels[levels.length - 1] < 250) {
    const h = levels[levels.length - 1];
    levels.push(Math.min(250, h + Math.max(5, halfWidth(h) * 1.15)));
  }
  for (let i = 1; i < levels.length; i++) {
    const h0 = levels[i - 1];
    const h1 = levels[i];
    const t = THREE.MathUtils.lerp(2.2, 0.7, h0 / 250);
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k];
      const [bx, bz] = corners[(k + 1) % 4];
      const a0 = corner(h0, ax, az);
      const a1 = corner(h1, ax, az);
      const b0 = corner(h0, bx, bz);
      const b1 = corner(h1, bx, bz);
      beam(a0, a1, t);
      beam(a1, b1, t * 0.45);
      beam(a0, b1, t * 0.3);
      beam(b0, a1, t * 0.3);
      // 低い所は面が広いので、面の中を縦に2つに分けて斜材を足す
      if (halfWidth(h0) > 12) {
        const m0 = a0.clone().lerp(b0, 0.5);
        const m1 = a1.clone().lerp(b1, 0.5);
        beam(m0, m1, t * 0.3);
        beam(a0, m1, t * 0.2);
        beam(m0, b1, t * 0.2);
      }
    }
    // 内側の水平の筋交い（上から見て X）
    if (i % 3 === 0) {
      beam(corner(h1, 1, 1), corner(h1, -1, -1), t * 0.25);
      beam(corner(h1, -1, 1), corner(h1, 1, -1), t * 0.25);
    }
  }

  // ---- メインデッキ（145〜154m）とトップデッキ（248〜254m） ----
  observatory(glass, deck, cx, 144, 2, 4.2, 15.5);
  observatory(glass, deck, cx, 247, 1, 4.5, 6.5);

  // ---- アンテナ（254〜333m）：太い骨組みの塔から、細い柱へ。赤と白の帯 ----
  const mast: Array<[number, number, number]> = [
    [254, 3.2, 2.6],
    [275, 2.6, 2.0],
    [295, 1.6, 1.2],
    [310, 0.9, 0.6],
    [333, 0.4, 0.15],
  ];
  for (let i = 1; i < mast.length; i++) {
    const [h0, r0] = mast[i - 1];
    const [h1, , r1] = mast[i];
    for (let h = h0; h < h1; h += 4) {
      const top = Math.min(h1, h + 4);
      const t0 = (h - h0) / (h1 - h0);
      const t1 = (top - h0) / (h1 - h0);
      const g = new THREE.CylinderGeometry(
        THREE.MathUtils.lerp(r0, r1, t1),
        THREE.MathUtils.lerp(r0, r1, t0),
        top - h,
        8,
      ).translate(cx, (h + top) / 2, 0);
      steel.push(colored(g, Math.floor((h - 254) / 8) % 2 === 0 ? ORANGE : WHITE));
    }
    // 継ぎ目の小さな足場
    deck.push(new THREE.CylinderGeometry(r0 + 0.8, r0 + 0.8, 0.5, 12).translate(cx, h0, 0));
  }

  // ---- 足元の建物：暗い灰色の箱と、階ごとの窓の帯 ----
  const base: THREE.BufferGeometry[] = [];
  const F = FOOT_TOWN;
  base.push(new THREE.BoxGeometry(F.length, F.height, F.depth).translate(cx + F.x, F.height / 2, F.z));
  for (let y = 3; y < F.height - 2; y += 4.5) {
    glass.push(new THREE.BoxGeometry(F.length + 0.2, 1.6, F.depth + 0.2).translate(cx + F.x, y + 1.5, F.z));
  }
  deck.push(new THREE.BoxGeometry(F.length + 0.6, 0.8, F.depth + 0.6).translate(cx + F.x, F.height, F.z));

  const merge = (list: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(list.map((x) => (x.index ? x.toNonIndexed() : x)))!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return {
    steel: merge(steel),
    glass: merge(glass.map(strip)),
    deck: merge(deck.map(strip)),
    base: merge(base.map(strip)),
  };
}

/** 展望台：八角形の層（ガラスの帯と白い床・屋根の板）を floors 階重ね、上に屋根 */
function observatory(
  glass: THREE.BufferGeometry[],
  deck: THREE.BufferGeometry[],
  cx: number,
  y: number,
  floors: number,
  storey: number,
  r: number,
): void {
  for (let f = 0; f < floors; f++) {
    const base = y + f * storey;
    const radius = r - f * 1.2;
    deck.push(octagonPrism(cx, base, radius + 0.6, 0.8));
    glass.push(octagonPrism(cx, base + 0.8, radius, storey - 0.8, true));
  }
  deck.push(octagonPrism(cx, y + floors * storey, r - floors * 1.2 + 0.8, 0.9));
}

function octagonPrism(cx: number, y: number, r: number, h: number, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, h, 8, 1, open, Math.PI / 8).translate(cx, y + h / 2, 0);
}

/** 位置だけにする（まとめるため） */
function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position') out.deleteAttribute(name);
  return out;
}

/** 位置と頂点色だけにする */
function colored(g: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const out = strip(g);
  const n = out.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return out;
}

/** a から b への角材（断面 t m の四角） */
function member(a: THREE.Vector3, b: THREE.Vector3, t: number, color: THREE.Color): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(t, len, t);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return colored(g, color);
}
