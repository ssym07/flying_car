import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 損保ジャパン本社ビル（1976年、43階・187m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 平面の長い向き（北北東へ）、z = それに直角、y = 上。
 *
 * - 本体：長さ 57m・奥行き 26m の板状の塔。両側の長い面（縦のフィンが並ぶ面）は、下へ行くほど滑り台のように
 *   なだらかに外へ反り出し、足元では奥行き 55m まで広がる
 * - 反り出した面の端（短い面）は暗い茶色の壁。両端に白いコアの塔（幅 23m・張り出し 10m）が本体より少し高く立つ
 * - コアの端の面に暗い窓の縦の列、上から 1/4 のあたりに張り出した帯
 * - 足元：反りの裾の白い帯の下は、柱の並ぶピロティとガラスのロビー
 */
export interface SompoParts {
  /** 縦のフィンの面（u, v = m / 階） */
  fin: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
}

const L = 57;
/** 上部の奥行きの半分と、足元で広がった奥行きの半分 */
const D_TOP = 13;
const D_BASE = 27.5;
/** 反りの裾（白い帯の上）と、反りの始まる高さ */
const Y0 = 13;
const Y1 = 115;
/** 本体の屋上と、コアの頂部 */
const TOP = 180;
const CORE_TOP = 187;
const CORE_W = 23;
const CORE_OUT = 10;

/** 高さ y での奥行きの半分 */
function depth(y: number): number {
  if (y >= Y1) return D_TOP;
  const s = (Y1 - Math.max(y, Y0)) / (Y1 - Y0);
  return D_TOP + (D_BASE - D_TOP) * s ** 2.2;
}

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

/** 反りの高さの刻み */
function rows(): number[] {
  const out: number[] = [];
  for (let y = Y0; y < Y1; y += 2) out.push(y);
  out.push(Y1, TOP);
  return out;
}

export function buildSompoJapan(cx: number): SompoParts {
  const P: Record<keyof SompoParts, THREE.BufferGeometry[]> = { fin: [], core: [], dark: [], glass: [] };
  const x0 = cx - L / 2;
  const x1 = cx + L / 2;
  const ys = rows();

  // ---- 両側の長い面：滑り台のように反り出す縦のフィンの面 ----
  for (const s of [-1, 1]) {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const y of ys) {
      for (const x of [x0, x1]) {
        pos.push(x, y, s * depth(y));
        uv.push((x - x0) / 3, y / FLOOR);
      }
    }
    for (let r = 0; r < ys.length - 1; r++) {
      const a = r * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    P.fin.push(g);
  }

  // ---- 短い面（反りの断面の形の暗い壁）と屋上 ----
  for (const x of [x0, x1]) {
    const pos: number[] = [];
    const idx: number[] = [];
    for (const y of ys) pos.push(x, y, -depth(y), x, y, depth(y));
    for (let r = 0; r < ys.length - 1; r++) {
      const a = r * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    P.dark.push(g);
    // 反り出した面の端の白い縁（面の曲線に沿う帯）
    const out = x + (x < cx ? -0.15 : 0.15);
    for (const s of [-1, 1]) {
      const rim: number[] = [];
      const rimIdx: number[] = [];
      for (const y of ys) rim.push(out, y, s * (depth(y) - 1.4), out, y, s * (depth(y) + 0.2));
      for (let r = 0; r < ys.length - 1; r++) {
        const a = r * 2;
        rimIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(rim, 3));
      rg.setIndex(rimIdx);
      P.core.push(rg);
    }
  }
  P.dark.push(box(x0, x1, TOP - 0.5, TOP, -D_TOP, D_TOP));
  // 屋上の縁の低い壁
  for (const s of [-1, 1]) P.core.push(box(x0, x1, TOP, TOP + 1.5, s * D_TOP - 0.4, s * D_TOP + 0.4));
  // 屋上の設備
  P.core.push(box(cx - 15, cx + 15, TOP, TOP + 4, -7, 7));

  // ---- 両端のコアの塔 ----
  for (const s of [-1, 1]) {
    const inner = cx + s * (L / 2 - 2);
    const outer = cx + s * (L / 2 + CORE_OUT);
    const [a, b] = inner < outer ? [inner, outer] : [outer, inner];
    P.core.push(box(a, b, 0, CORE_TOP, -CORE_W / 2, CORE_W / 2));
    // 上から 1/4 のあたりの張り出した帯
    P.core.push(box(a - 0.8, b + 0.8, 138, 140.5, -CORE_W / 2 - 0.8, CORE_W / 2 + 0.8));
    // 端の面の暗い窓の縦の列（中心から少しずらす）
    const zc = s * 4;
    P.dark.push(box(outer - 0.25, outer + 0.25, 14, CORE_TOP - 6, zc - 1.8, zc + 1.8).translate(s * 0.1, 0, 0));
    // 頂部の縁
    P.core.push(box(a - 0.4, b + 0.4, CORE_TOP - 1, CORE_TOP + 0.6, -CORE_W / 2 - 0.4, CORE_W / 2 + 0.4));
  }

  // ---- 足元：白い帯とピロティ ----
  P.core.push(box(x0 - 0.5, x1 + 0.5, 9, Y0, -D_BASE - 0.6, D_BASE + 0.6));
  P.glass.push(box(x0 + 2, x1 - 2, 0, 9, -D_BASE + 4, D_BASE - 4));
  for (const s of [-1, 1]) {
    for (let x = x0 + 1.5; x <= x1 - 1.5 + 0.01; x += (L - 3) / 9) {
      P.core.push(box(x - 0.7, x + 0.7, 0, 9, s * (D_BASE - 1.2) - 0.7, s * (D_BASE - 1.2) + 0.7));
    }
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
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as SompoParts;
}

/** 長い面：明るい灰色の縦のフィンと、間の暗い茶色の窓（1枚 = 3m × 1階、フィン2本） */
export function createSompoFinMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, Wp, Hp) => {
      g.fillStyle = '#3f3633';
      g.fillRect(0, 0, Wp, Hp);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, Hp * 0.75, Wp, Hp * 0.25);
      for (const x0 of [0, Wp / 2]) {
        g.fillStyle = '#d4d4d4';
        g.fillRect(x0, 0, Wp * 0.2, Hp);
        g.fillStyle = '#a9a9ab';
        g.fillRect(x0 + Wp * 0.2, 0, Wp * 0.04, Hp);
      }
    },
    0.55,
    0.15,
  );
}

/** コア：白いパネル（1枚 = 3m × 1階）の目地 */
export function createSompoCoreMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, Wp, Hp) => {
      g.fillStyle = '#e4e4e2';
      g.fillRect(0, 0, Wp, Hp);
      g.fillStyle = 'rgba(120,120,120,0.35)';
      g.fillRect(0, 0, 1, Hp);
      g.fillRect(0, Hp - 1, Wp, 1);
    },
    0.5,
    0.05,
  );
}
