import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * セルリアンタワー（2001年、184m・47階）。写真を参考に、手続き的に形を作る。
 * 座標：塔の中心が (cx, 0, 0)、x = 平面の長い向き、z = それに直角（-z が国道246号の側＝正面）、y = 上。
 *
 * - 低層部（0〜80m）：四隅を階段状に切り欠いた、広い四角い平面（54×46m）
 * - 切り替え（80〜90m）：四隅がのこぎりの歯のように段々に引っ込む
 * - 上層部（90〜170m）：一回り細い平面（44×36m）。四隅に暗い縦の溝。正面と背面の中央に青いガラスの帯
 * - 最上層部（170〜184m）：上へ向かって細くなる台形（側面が内へ傾く）の冠と、上の縁
 * - 足元：段々の低層棟
 */
export interface CeruleanParts {
  stone: THREE.BufferGeometry;
  /** 青いガラスの帯・冠のガラス */
  glass: THREE.BufferGeometry;
  /** 四隅の溝・切り欠きの暗い面 */
  dark: THREE.BufferGeometry;
  /** 足元の宴会棟・低層棟 */
  podium: THREE.BufferGeometry;
}

const LOW_TOP = 80;
const STEP_TOP = 90;
const UP_TOP = 170;
const H = 184;

/** 四隅を n m ずつ 2 段に切り欠いた長方形（中心が原点）の点（反時計回り） */
function steppedRect(w: number, d: number, n: number): THREE.Vector2[] {
  const x = w / 2;
  const y = d / 2;
  const pts: Array<[number, number]> = [];
  // 右下の角から反時計回り。角ごとに 2 段の階段
  const corner = (sx: number, sy: number, first: 'x' | 'y') => {
    const c: Array<[number, number]> =
      first === 'x'
        ? [
            [sx * x, sy * (y - 2 * n)],
            [sx * (x - n), sy * (y - 2 * n)],
            [sx * (x - n), sy * (y - n)],
            [sx * (x - 2 * n), sy * (y - n)],
            [sx * (x - 2 * n), sy * y],
          ]
        : [
            [sx * (x - 2 * n), sy * y],
            [sx * (x - 2 * n), sy * (y - n)],
            [sx * (x - n), sy * (y - n)],
            [sx * (x - n), sy * (y - 2 * n)],
            [sx * x, sy * (y - 2 * n)],
          ];
    pts.push(...c);
  };
  corner(1, -1, 'y');
  corner(1, 1, 'x');
  corner(-1, 1, 'y');
  corner(-1, -1, 'x');
  // 重なった点を除く
  return pts
    .map(([a, b]) => new THREE.Vector2(a, b))
    .filter((p, i, arr) => i === 0 || p.distanceTo(arr[i - 1]) > 0.01);
}

/** 平面 pts を、y0〜y1 で s0 倍から s1 倍へ変えながら積んだ外壁。u = 周の長さ / 3m、v = 高さ / FLOOR */
function walls(cx: number, pts: THREE.Vector2[], y0: number, y1: number, s0 = 1, s1 = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  let s = 0;
  for (let j = 0; j < pts.length; j++) {
    const a = pts[j];
    const b = pts[(j + 1) % pts.length];
    const len = a.distanceTo(b);
    const u0 = s / 3;
    const u1 = (s + len) / 3;
    s += len;
    const P = (q: THREE.Vector2, k: number, y: number) => [cx + q.x * k, y, q.y * k];
    pos.push(...P(a, s0, y0), ...P(b, s0, y0), ...P(b, s1, y1), ...P(a, s0, y0), ...P(b, s1, y1), ...P(a, s1, y1));
    uv.push(u0, y0 / FLOOR, u1, y0 / FLOOR, u1, y1 / FLOOR, u0, y0 / FLOOR, u1, y1 / FLOOR, u0, y1 / FLOOR);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 平面 pts（scale 倍）の上のふた（厚み 1m） */
function lid(cx: number, pts: THREE.Vector2[], y: number, scale = 1): THREE.BufferGeometry {
  return new THREE.ExtrudeGeometry(new THREE.Shape(pts.map((q) => q.clone().multiplyScalar(scale))), {
    depth: 1,
    bevelEnabled: false,
  })
    .rotateX(Math.PI / 2)
    .translate(cx, y + 1, 0);
}

export function buildCeruleanTower(cx: number): CeruleanParts {
  const L: Record<keyof CeruleanParts, THREE.BufferGeometry[]> = { stone: [], glass: [], dark: [], podium: [] };

  // ---- 低層部 ----
  const low = steppedRect(54, 46, 3);
  L.stone.push(walls(cx, low, 0, LOW_TOP));
  L.stone.push(lid(cx, low, LOW_TOP - 1));
  // ---- 切り替え：四隅がのこぎりの歯のように引っ込む（2 段） ----
  const mid1 = steppedRect(50, 42, 4);
  const mid2 = steppedRect(46, 38, 4.5);
  L.stone.push(walls(cx, mid1, LOW_TOP, LOW_TOP + 5));
  L.stone.push(lid(cx, mid1, LOW_TOP + 4));
  L.stone.push(walls(cx, mid2, LOW_TOP + 5, STEP_TOP));
  // ---- 上層部 ----
  const up = steppedRect(44, 36, 4);
  L.stone.push(walls(cx, up, STEP_TOP, UP_TOP));
  // 四隅の暗い縦の溝（切り欠きの奥）
  for (const [sx, sz] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    L.dark.push(new THREE.BoxGeometry(4.2, UP_TOP - STEP_TOP, 4.2).translate(cx + sx * 16, (STEP_TOP + UP_TOP) / 2, sz * 12));
    L.dark.push(new THREE.BoxGeometry(4.2, LOW_TOP, 4.2).translate(cx + sx * 22.2, LOW_TOP / 2, sz * 18.2));
  }
  // 正面と背面の中央の青いガラスの帯
  for (const sz of [-1, 1]) {
    L.glass.push(new THREE.BoxGeometry(14, UP_TOP - STEP_TOP - 4, 0.6).translate(cx, (STEP_TOP + UP_TOP) / 2 + 2, sz * 18.05));
    L.glass.push(new THREE.BoxGeometry(12, LOW_TOP - 30, 0.6).translate(cx + 8, LOW_TOP / 2 + 12, sz * 23.05));
  }
  // ---- 最上層部：上へ細くなる台形の冠（側面が内へ傾く）。暗いガラスと、上の縁 ----
  L.glass.push(walls(cx, up, UP_TOP, H - 2, 1, 0.82));
  L.stone.push(walls(cx, up, UP_TOP - 0.5, UP_TOP + 1.5, 1.03, 1.03));
  L.stone.push(lid(cx, up, H - 3, 0.82));
  L.stone.push(walls(cx, up, H - 3, H, 0.84, 0.84));

  // ---- 足元：西と東の段々の低層棟（正面の円筒の宴会棟は、国道246号と重なるので置かない） ----
  for (const [x0, x1, z0, z1, h] of [
    [-70, -27, -30, 30, 26],
    [-70, -45, 30, 44, 18],
    [27, 52, -20, 26, 30],
  ]) {
    L.podium.push(new THREE.BoxGeometry(x1 - x0, h, z1 - z0).translate(cx + (x0 + x1) / 2, h / 2, (z0 + z1) / 2));
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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as CeruleanParts;
}

/** ベージュの石の外壁に、小さな四角い窓の並び（1枚 = 3m × 1階） */
export function createCeruleanStoneMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, Hp) => {
      g.fillStyle = '#a99c8c';
      g.fillRect(0, 0, W, Hp);
      g.fillStyle = '#3b4652';
      g.fillRect(W * 0.28, Hp * 0.3, W * 0.44, Hp * 0.45);
      g.fillStyle = 'rgba(80,70,60,0.35)';
      g.fillRect(0, Hp - 3, W, 3);
    },
    0.75,
    0.05,
  );
}
