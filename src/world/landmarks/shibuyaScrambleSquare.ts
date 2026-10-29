import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 渋谷スクランブルスクエア（2019年、230m）。写真を参考に、手続き的に形を作る。
 * 座標：中心が (cx, 0, 0)、x = 平面の幅の向き、z = 正面（駅側、+）、y = 上。
 *
 * - 四角い塔（64×58m）。下半身（0〜85m）は、正面の右側が斜めの曲線で大きくえぐれる：
 *   えぐれの縁は足元の中ほどから、上へ行くほど右へ反って、85m で右の角に届く。えぐれの曲面は暗い縦のルーバー
 * - 正面の左寄りの足元には小さなアーチのえぐれ
 * - 外壁：青緑のガラスに、互い違いの黒い縦の桟
 * - 頂部（SHIBUYA SKY）：一回り小さく奥まった最上階の上に、縁が張り出した屋上。屋上は中央が低く窪んだ鞍形で、
 *   中央に芝生、まわりに木のデッキ、縁にガラスの柵
 */
export interface ScrambleParts {
  glass: THREE.BufferGeometry;
  /** えぐれの曲面の暗いルーバー */
  louver: THREE.BufferGeometry;
  /** えぐれの奥の明るいガラス */
  inner: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  deck: THREE.BufferGeometry;
  grass: THREE.BufferGeometry;
  fence: THREE.BufferGeometry;
}

const W = 64;
const D = 58;
const H = 230;
/** えぐれの高さ・奥行き (m)、小さなアーチの高さ・奥行き */
const NOTCH_TOP = 85;
const NOTCH_DEPTH = 12;
const ARCH_TOP = 34;
const ARCH_DEPTH = 6;

/** 高さ h のえぐれの縁の x（えぐれは x がこれより大きい所）。足元で中ほど、上へ反って右の角へ */
function notchX(h: number): number {
  if (h >= NOTCH_TOP) return W / 2;
  const t = h / NOTCH_TOP;
  return THREE.MathUtils.lerp(-W * 0.02, W / 2, t ** 2.4);
}
/** 小さなアーチの左右の端（高さ h、無ければ同じ値） */
function archX(h: number): [number, number] {
  const c = -W * 0.22;
  if (h >= ARCH_TOP) return [c, c];
  const half = 9 * Math.sqrt(1 - (h / ARCH_TOP) ** 2);
  return [c - half, c + half];
}

/**
 * 高さ h の平面（反時計回り）。点の数は高さによらず同じ（えぐれの無い所は点が重なる）。
 * 各辺の種類：'g' = ガラス、'l' = えぐれの面（奥の壁と縁の曲面。暗いルーバー）
 */
function plan(h: number): Array<[number, number, 'g' | 'l' | 'i']> {
  const xc = notchX(h);
  const [a0, a1] = archX(h);
  const zf = D / 2;
  return [
    [-W / 2, -zf, 'g'],
    [W / 2, -zf, 'g'],
    [W / 2, zf - NOTCH_DEPTH, 'l'],
    [xc, zf - NOTCH_DEPTH, 'l'],
    [xc, zf, 'g'],
    [a1, zf, 'l'],
    [a1, zf - ARCH_DEPTH, 'l'],
    [a0, zf - ARCH_DEPTH, 'l'],
    [a0, zf, 'g'],
    [-W / 2, zf, 'g'],
  ];
}

export function buildScrambleSquare(cx: number): ScrambleParts {
  const lists: Record<keyof ScrambleParts, THREE.BufferGeometry[]> = {
    glass: [],
    louver: [],
    inner: [],
    white: [],
    deck: [],
    grass: [],
    fence: [],
  };
  const BODY = H - 14;
  // 外壁：高さ方向に細かく区切って、平面を積む（えぐれの曲線が滑らかになるよう、下は 2.5m おき）
  const rows: number[] = [];
  for (let h = 0; h < NOTCH_TOP; h += 2.5) rows.push(h);
  for (let h = NOTCH_TOP; h < BODY; h += 12) rows.push(h);
  rows.push(BODY);
  const bufs: Record<'g' | 'l' | 'i', { pos: number[]; uv: number[] }> = {
    g: { pos: [], uv: [] },
    l: { pos: [], uv: [] },
    i: { pos: [], uv: [] },
  };
  for (let r = 1; r < rows.length; r++) {
    const h0 = rows[r - 1];
    const h1 = rows[r];
    const p0 = plan(h0);
    const p1 = plan(h1);
    let s = 0;
    for (let j = 0; j < p0.length; j++) {
      const k = (j + 1) % p0.length;
      const kind = p0[j][2];
      const a0 = p0[j];
      const b0 = p0[k];
      const a1 = p1[j];
      const b1 = p1[k];
      const len = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
      const u0 = s / 3;
      const u1 = (s + len) / 3;
      s += len;
      const b = bufs[kind];
      const P = (q: [number, number, string], y: number) => [cx + q[0], y, q[1]];
      b.pos.push(...P(a0, h0), ...P(b0, h0), ...P(b1, h1), ...P(a0, h0), ...P(b1, h1), ...P(a1, h1));
      b.uv.push(u0, h0 / FLOOR, u1, h0 / FLOOR, u1, h1 / FLOOR, u0, h0 / FLOOR, u1, h1 / FLOOR, u0, h1 / FLOOR);
    }
  }
  const toGeo = (b: { pos: number[]; uv: number[] }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    return g;
  };
  lists.glass.push(toGeo(bufs.g));
  lists.louver.push(toGeo(bufs.l));
  lists.inner.push(toGeo(bufs.i));

  // 頂部：奥まった最上階（BODY〜BODY+6、4m 内側）と、縁の張り出した屋上の床（厚み 2m）
  lists.inner.push(new THREE.BoxGeometry(W - 8, 6, D - 8).translate(cx, BODY + 3, 0));
  const ROOF = BODY + 6;
  // 屋上：x の向きに鞍形（中央が低い）。床の板は細かく区切った帯の集まり
  const lift = (x: number) => 5 * ((2 * x) / (W + 4)) ** 2;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const x0 = -(W + 4) / 2 + ((W + 4) * i) / N;
    const x1 = -(W + 4) / 2 + ((W + 4) * (i + 1)) / N;
    const y0 = ROOF + lift(x0);
    const y1 = ROOF + lift(x1);
    // 床の縁の白い板（厚み 2m）
    lists.white.push(slope(cx, x0, x1, y0, y1, -(D + 4) / 2, (D + 4) / 2, 2));
    // 木のデッキと、中央の芝生
    lists.deck.push(slope(cx, x0, x1, y0 + 0.1, y1 + 0.1, -(D + 2) / 2, (D + 2) / 2, 0.1));
    const xm = (x0 + x1) / 2;
    if (Math.abs(xm) < W * 0.28) lists.grass.push(slope(cx, x0, x1, y0 + 0.25, y1 + 0.25, -D * 0.25, D * 0.22, 0.1));
    // ガラスの柵（前後の縁）
    for (const z of [-(D + 4) / 2, (D + 4) / 2]) lists.fence.push(fence(cx, x0, x1, y0 + 0.1, y1 + 0.1, z, true));
  }
  // 左右の縁の柵
  for (const sx of [-1, 1]) {
    const x = (sx * (W + 4)) / 2;
    lists.fence.push(fence(cx, x, x, ROOF + lift(x) + 0.1, ROOF + lift(x) + 0.1, 0, false, D + 4));
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
  return Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, merge(v)])) as unknown as ScrambleParts;
}

/** x0〜x1 の帯（高さ y0→y1 に傾いた板、奥行き z0〜z1、厚み t） */
function slope(cx: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, t: number) {
  const g = new THREE.BoxGeometry(1, t, z1 - z0).translate(0.5, -t / 2, (z0 + z1) / 2);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i);
    pos.setX(i, cx + x0 + (x1 - x0) * u);
    pos.setY(i, pos.getY(i) + y0 + (y1 - y0) * u);
  }
  return g;
}

/** ガラスの柵（高さ 1.8m）。along = true なら x0〜x1 に沿う、false なら z の向きに長さ len */
function fence(cx: number, x0: number, x1: number, y0: number, y1: number, z: number, along: boolean, len = 0) {
  if (along) return slope(cx, x0, x1, y0 + 1.8, y1 + 1.8, z - 0.1, z + 0.1, 1.8);
  return new THREE.BoxGeometry(0.2, 1.8, len).translate(cx + x0, y0 + 0.9, z);
}

/** 青緑のガラスに、互い違いの黒い縦の桟（1枚 = 幅 3m × 1階。4階ぶんで1枚の模様） */
export function createScrambleGlassMaterial(): THREE.MeshStandardMaterial {
  const mat = facadeMaterial(
    (g, Wpx, Hpx) => {
      const grad = g.createLinearGradient(0, 0, Wpx, Hpx);
      grad.addColorStop(0, '#5f9fb4');
      grad.addColorStop(1, '#3f7d97');
      g.fillStyle = grad;
      g.fillRect(0, 0, Wpx, Hpx);
      // 階ごとの細い線
      g.fillStyle = 'rgba(30,50,60,0.5)';
      for (let k = 0; k < 4; k++) g.fillRect(0, (k * Hpx) / 4, Wpx, 2);
      // 互い違いの黒い縦の桟：階ごとに位置をずらす
      g.fillStyle = '#152028';
      for (let k = 0; k < 4; k++) {
        const x = [0.15, 0.55, 0.35, 0.8][k] * Wpx;
        g.fillRect(x, (k * Hpx) / 4, 3, Hpx / 4 + 1);
      }
    },
    0.12,
    0.55,
  );
  // 画像は4階ぶんなので、縦を 1/4 にする
  mat.map!.repeat.set(1, 0.25);
  return mat;
}

/** えぐれの曲面：暗い灰色の縦のルーバー */
export function createLouverMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, Wpx, Hpx) => {
      g.fillStyle = '#2a3036';
      g.fillRect(0, 0, Wpx, Hpx);
      g.fillStyle = '#6a737b';
      for (let k = 0; k < 4; k++) g.fillRect((k * Wpx) / 4, 0, 5, Hpx);
    },
    0.4,
    0.5,
  );
}
