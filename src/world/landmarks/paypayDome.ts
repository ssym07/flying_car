import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeMaterial } from './azabudaiHills';

/**
 * みずほPayPayドーム福岡（1993年、直径 216m・高さ 68m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 東、z = 南、y = 上。
 *
 * - 壁：ベージュの円筒（0〜36m）。上の方に縦の細い窓がぐるりと並ぶ
 * - 屋根の縁：白い張り出した縁
 * - 屋根：銅色のチタンの低いドーム（38m の縁から 68m のてっぺんへ）。開閉する3枚の屋根の境目が、てっぺんから縁へ放射状に走る
 * - 足元：2階の高さ（6m）でドームを囲むデッキと、外へ下がる植え込みの斜面
 * - 南の正面：白い水平の帯が4段重なる、ガラスの低い建物（「MIZUHO PayPay Dome FUKUOKA」の看板の下）
 */
export interface PayPayDomeParts {
  wall: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  /** 屋根の境目の骨 */
  seam: THREE.BufferGeometry;
  deck: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
}

const SEG = 180;
const R = 108;
const WALL_H = 36;
/** 屋根の縁（半径・高さ）と、てっぺんの高さ */
const ROOF_R = 106;
const ROOF_Y = WALL_H + 2.3;
const TOP = 68;
const DECK_Y = 6;
const DECK_R = 122;
const SLOPE_R = 136;
/** 縦の窓の間隔 (m)。壁の uv の u は窓 1 つ分 = 1 */
const SLIT = 6;
/** 開閉する屋根の境目の向き（東から南へ, 度） */
const SEAMS = [20, 145, 265];

/** 円の帯：半径 r0（高さ y0）から r1（高さ y1）。uv の u は周り uRepeat 回、v は 0→1 */
function ring(cx: number, r0: number, y0: number, r1: number, y1: number, uRepeat = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k <= SEG; k++) {
    const t = (k / SEG) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pos.push(cx + r0 * c, y0, r0 * s, cx + r1 * c, y1, r1 * s);
    uv.push((k / SEG) * uRepeat, 0, (k / SEG) * uRepeat, 1);
  }
  for (let k = 0; k < SEG; k++) {
    const i = k * 2;
    idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** 屋根の高さ（中心からの距離 r）：縁からてっぺんへの球の一部 */
function roofY(r: number): number {
  const rise = TOP - ROOF_Y;
  const sphere = (ROOF_R * ROOF_R + rise * rise) / (2 * rise);
  return ROOF_Y + Math.sqrt(Math.max(0, sphere * sphere - r * r)) - (sphere - rise);
}

/** 箱（中心 x・y・z、大きさ w・h・d） */
function box(x: number, y: number, z: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  return g;
}

export function buildPayPayDome(cx: number): PayPayDomeParts {
  const P: Record<keyof PayPayDomeParts, THREE.BufferGeometry[]> = {
    wall: [],
    rim: [],
    roof: [],
    seam: [],
    deck: [],
    green: [],
    white: [],
    glass: [],
  };
  const around = Math.round((2 * Math.PI * R) / SLIT);

  // ---- 壁と、屋根の白い縁 ----
  P.wall.push(ring(cx, R, 0, R, WALL_H, around));
  P.rim.push(ring(cx, R, WALL_H, R + 1.5, WALL_H + 0.6));
  P.rim.push(ring(cx, R + 1.5, WALL_H + 0.6, R + 1.5, WALL_H + 2.6));
  P.rim.push(ring(cx, R + 1.5, WALL_H + 2.6, ROOF_R, ROOF_Y));

  // ---- 屋根：てっぺんから縁への輪を重ねる。uv：u = 周りの向き（細い継ぎ目 72 本）、v = 縁からの距離 ----
  {
    const RINGS = 36;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= RINGS; i++) {
      const r = (ROOF_R * i) / RINGS;
      const y = roofY(r);
      for (let k = 0; k <= SEG; k++) {
        const t = (k / SEG) * Math.PI * 2;
        pos.push(cx + r * Math.cos(t), y, r * Math.sin(t));
        uv.push((k / SEG) * 72, (r / ROOF_R) * 12);
      }
    }
    for (let i = 0; i < RINGS; i++) {
      for (let k = 0; k < SEG; k++) {
        const a = i * (SEG + 1) + k;
        const b = a + SEG + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    P.roof.push(g);
  }
  // 開閉する屋根の境目：屋根の面に沿った、少し浮いた細い帯
  for (const deg of SEAMS) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const pos: number[] = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const r0 = 6 + ((ROOF_R - 6) * i) / N;
      const r1 = 6 + ((ROOF_R - 6) * (i + 1)) / N;
      const w = 0.6;
      const p = (r: number, side: number) => [cx + r * c - s * w * side, roofY(r) + 0.35, r * s + c * w * side];
      pos.push(...p(r0, -1), ...p(r1, -1), ...p(r1, 1), ...p(r0, -1), ...p(r1, 1), ...p(r0, 1));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    P.seam.push(g);
  }
  // てっぺんの丸い台（屋根が回る軸）
  {
    const g = new THREE.CylinderGeometry(6.5, 7, 1.2, 24).toNonIndexed();
    g.translate(cx, TOP + 0.2, 0);
    P.seam.push(g);
  }

  // ---- 足元のデッキと、植え込みの斜面 ----
  P.deck.push(ring(cx, R, DECK_Y, DECK_R, DECK_Y));
  P.deck.push(ring(cx, DECK_R, DECK_Y, DECK_R, DECK_Y - 0.8));
  P.green.push(ring(cx, DECK_R, DECK_Y - 0.8, SLOPE_R, 0));
  // デッキの縁の手すり（白い低い帯）
  P.white.push(ring(cx, DECK_R - 0.2, DECK_Y, DECK_R - 0.2, DECK_Y + 1.1));

  // ---- 南の正面の建物：幅 96m、壁から張り出して前面が z = 120 ----
  {
    const HALF = 48;
    const Z0 = 88;
    const Z1 = 120;
    const H = 25;
    const zc = (Z0 + Z1) / 2;
    // ガラスの中身（前面は 1.2m 引っ込める）
    P.glass.push(box(cx, H / 2, zc - 0.6, HALF * 2 - 2, H, Z1 - Z0 - 1.2));
    // 水平の白い帯（床ごと）と、屋上の白い縁
    for (const y of [DECK_Y, 11, 16, 21]) P.white.push(box(cx, y, zc + 0.5, HALF * 2 + 1, 0.9, Z1 - Z0 + 1));
    P.white.push(box(cx, H - 0.6, zc + 0.3, HALF * 2 + 0.6, 1.4, Z1 - Z0 + 0.6));
    // 両端の白い壁と、前面の縦の細い柱
    for (const side of [-1, 1]) P.white.push(box(cx + side * (HALF - 0.7), H / 2, zc, 1.6, H, Z1 - Z0));
    for (let x = -HALF + 8; x < HALF - 4; x += 8) P.white.push(box(cx + x, H / 2, Z1 - 0.5, 0.35, H, 0.35));
  }

  // ガラスの uv は m 単位（u = 横 3m、v = 1 階 5m）
  for (const g of P.glass) {
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - cx + pos.getZ(i)) / 3, pos.getY(i) / 5);
  }

  const merge = (list: THREE.BufferGeometry[], smooth: boolean, keepUv: boolean) => {
    const prepared = list.map((g) => {
      const out = smooth || !g.index ? g : g.toNonIndexed();
      for (const name of Object.keys(out.attributes)) {
        if (name !== 'position' && !(keepUv && name === 'uv')) out.deleteAttribute(name);
      }
      return out;
    });
    const g = mergeGeometries(prepared)!;
    g.computeVertexNormals();
    return g;
  };
  return {
    wall: merge(P.wall, true, true),
    rim: merge(P.rim, false, false),
    roof: merge(P.roof, true, true),
    seam: merge(P.seam, false, false),
    deck: merge(P.deck, false, false),
    green: merge(P.green, true, false),
    white: merge(P.white, false, false),
    glass: merge(P.glass, false, true),
  };
}

/** 壁：ベージュのパネルに、上の方の縦の細い窓（1枚 = 窓 1 つ分 × 壁の高さ。v = 0 が足元） */
export function createPayPayDomeWallMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#b3a38f';
      g.fillRect(0, 0, W, H);
      // パネルの横の目地
      g.fillStyle = 'rgba(90,75,60,0.18)';
      for (let y = 0; y < H; y += 8) g.fillRect(0, y, W, 1);
      // 縦の窓（壁の高さの 66〜86%）
      g.fillStyle = '#3e3f42';
      g.fillRect(W * 0.42, H * 0.14, W * 0.16, H * 0.2);
      // てっぺんの少し明るい帯
      g.fillStyle = '#c4b6a3';
      g.fillRect(0, 0, W, H * 0.05);
    },
    0.8,
    0,
  );
}

/** 屋根：銅色のチタン（一色。金属の照り返しで濃淡が出る） */
export function createPayPayDomeRoofMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#ad806a';
      g.fillRect(0, 0, W, H);
    },
    0.35,
    0.55,
  );
}

/** 正面の建物のガラス：濃い青灰色に細い縦の桟 */
export function createPayPayDomeGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#3d4d5c';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(190,215,235,0.2)';
      g.fillRect(0, 0, W, H * 0.45);
      g.fillStyle = '#d8dcdf';
      g.fillRect(0, 0, 3, H);
    },
    0.15,
    0.4,
  );
}
