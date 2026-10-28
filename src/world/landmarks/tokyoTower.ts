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

/** 高さ h (m) での主柱（四隅の四角い骨組み）の断面の一辺 (m)。下の 45m で 10m → 4m、上は 1.6m まで細くなる */
function legSize(h: number): number {
  return h < 45 ? THREE.MathUtils.lerp(10, 4, h / 45) : THREE.MathUtils.lerp(4, 1.6, Math.min(1, (h - 45) / 205));
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

  // ---- 4本の主柱：地面から 250m まで続く四角い骨組み（断面 legSize、外側の角が塔の輪郭）。
  // 一段ごとに、主柱の4つの面へ水平材と X 形の斜材を入れる。足元はコンクリートの台座 ----
  const LEG_TOP = 45;
  const pedestals: THREE.BufferGeometry[] = [];
  const levels: number[] = [0];
  while (levels[levels.length - 1] < 250) {
    const h = levels[levels.length - 1];
    levels.push(Math.min(250, h + THREE.MathUtils.clamp(legSize(h) * 0.75, 2.5, 6)));
  }
  /** 主柱 (sx, sz) の高さ h の断面の4点：外側の角、面 x に沿った内側、内側の角、面 z に沿った内側 */
  const section = (h: number, sx: number, sz: number) => {
    const s = legSize(h);
    const o = corner(h, sx, sz);
    return [
      o,
      o.clone().add(new THREE.Vector3(-sx * s, 0, 0)),
      o.clone().add(new THREE.Vector3(-sx * s, 0, -sz * s)),
      o.clone().add(new THREE.Vector3(0, 0, -sz * s)),
    ];
  };
  for (const [sx, sz] of corners) {
    for (let i = 1; i < levels.length; i++) {
      const lo = section(levels[i - 1], sx, sz);
      const hi = section(levels[i], sx, sz);
      const t = THREE.MathUtils.lerp(0.9, 0.35, levels[i] / 250);
      for (let k = 0; k < 4; k++) {
        beam(lo[k], hi[k], t * (k === 2 ? 0.8 : 1));
        beam(hi[k], hi[(k + 1) % 4], t * 0.45);
        // 斜材は段ごとに向きを変える（ジグザグ）。低い所は X 形
        if (i % 2 === 0 || levels[i] < LEG_TOP) beam(lo[k], hi[(k + 1) % 4], t * 0.35);
        if (i % 2 === 1 || levels[i] < LEG_TOP) beam(lo[(k + 1) % 4], hi[k], t * 0.35);
      }
    }
    // コンクリートの台座
    const base = corner(0, sx, sz).add(new THREE.Vector3((-sx * legSize(0)) / 2, 0, (-sz * legSize(0)) / 2));
    pedestals.push(new THREE.BoxGeometry(legSize(0) + 2, 5, legSize(0) + 2).translate(base.x, 1.5, base.z));
  }

  // ---- 面（主柱の間）：面に沿った座標 u は a の側が +。固定した座標は塔の輪郭 ----
  const onFace = (k: number, u: number, h: number) => {
    const [ax, az] = corners[k];
    const [bx] = corners[(k + 1) % 4];
    const w = halfWidth(h);
    return ax === bx ? new THREE.Vector3(cx + ax * w, h, az * u) : new THREE.Vector3(cx + ax * u, h, az * w);
  };
  /** 高さ h での、面の両端（主柱の内側の柱）の u */
  const inner = (h: number) => halfWidth(h) - legSize(h);

  // 下の 45m：脚の間のアーチ。両側の主柱の内側の柱から立ち上がり、面の中央で LEG_TOP に届く。
  // アーチの上は縦の材と X 形の斜材で、LEG_TOP の水平材とつなぐ
  const SPRING = 8;
  const ARCH = 16;
  for (let k = 0; k < 4; k++) {
    const pts: THREE.Vector3[] = [];
    const us: number[] = [];
    for (let i = 0; i <= ARCH; i++) {
      const t = i / ARCH;
      const h = SPRING + (LEG_TOP - SPRING) * Math.sin(t * Math.PI);
      const u = inner(h) * (1 - 2 * t);
      pts.push(onFace(k, u, h));
      us.push(u);
    }
    beam(onFace(k, inner(0), 0), pts[0], 1.0);
    beam(onFace(k, -inner(0), 0), pts[ARCH], 1.0);
    let prevPost: [THREE.Vector3, THREE.Vector3] | null = null;
    for (let i = 1; i <= ARCH; i++) {
      beam(pts[i - 1], pts[i], 1.0);
      if (i === ARCH || Math.abs(us[i]) >= inner(LEG_TOP) - 0.5) {
        prevPost = null;
        continue;
      }
      const top = onFace(k, us[i], LEG_TOP);
      if (pts[i].y < LEG_TOP - 1) beam(pts[i], top, 0.4);
      if (prevPost) {
        beam(prevPost[0], top, 0.3);
        beam(prevPost[1], pts[i], 0.3);
      }
      prevPost = [pts[i], top];
    }
  }

  // 45m から上：面ごとに、主柱の間を幅 8m ほどの小さな区画に分け、縦の材と X 形の斜材を入れる（2段ごと）
  const faceLevels = levels.filter((h) => h >= LEG_TOP).filter((_, i) => i % 2 === 0);
  if (faceLevels[faceLevels.length - 1] !== 250) faceLevels.push(250);
  for (let k = 0; k < 4; k++) {
    for (let i = 1; i < faceLevels.length; i++) {
      const h0 = faceLevels[i - 1];
      const h1 = faceLevels[i];
      const span = inner(h0) * 2;
      if (span < 0.5) continue;
      const n = Math.max(1, Math.round(span / 8));
      const t = THREE.MathUtils.lerp(0.5, 0.25, h0 / 250);
      for (let j = 0; j < n; j++) {
        const u0 = (a: number) => inner(a) * (1 - (2 * j) / n);
        const u1 = (a: number) => inner(a) * (1 - (2 * (j + 1)) / n);
        const p00 = onFace(k, u0(h0), h0);
        const p01 = onFace(k, u1(h0), h0);
        const p10 = onFace(k, u0(h1), h1);
        const p11 = onFace(k, u1(h1), h1);
        beam(p10, p11, t);
        if (j > 0) beam(p00, p10, t * 0.8);
        beam(p00, p11, t * 0.7);
        beam(p01, p10, t * 0.7);
      }
      if (i === 1) beam(onFace(k, inner(h0), h0), onFace(k, -inner(h0), h0), t * 1.4);
    }
  }
  // 内側の水平の筋交い（上から見て X。数段ごと）
  for (let i = 3; i < faceLevels.length; i += 3) {
    const h = faceLevels[i];
    beam(corner(h, 1, 1), corner(h, -1, -1), 0.35);
    beam(corner(h, -1, 1), corner(h, 1, -1), 0.35);
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
  const base: THREE.BufferGeometry[] = [...pedestals];
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
