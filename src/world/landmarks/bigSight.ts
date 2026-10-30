import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 東京ビッグサイトの会議棟（1996年、58m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x・z = 正方形の平面（一辺 97m、OpenStreetMap の形）の辺の向き、y = 上。
 *
 * - 足元：エントランスプラザの台（〜8m）
 * - 4本のガラスの塔（柱）が、逆さの四角錐（上を切った形）を1つずつ支える。四角錐は平面を 4 つに分けた区画いっぱいに広がる
 * - 四角錐の面は、三角形の格子の入ったベージュ灰色の金属の板。裏（下向きの面）は暗い
 * - 真ん中：四角錐の谷の奥のガラスの芯と、下の暗い天井
 * - 屋上：白い機械室の箱2つと、真ん中の切妻の屋根
 */
export interface BigSightParts {
  panel: THREE.BufferGeometry;
  under: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  deck: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
}

const HALF = 48.5;
const DECK = 8;
/** 四角錐の下の端（ガラスの塔の上）と上の端 */
const PY0 = 22;
const PY1 = 52;
/** 四角錐の下の面の一辺の半分 */
const LOW = 7.5;

/** 四角錐（上を切った逆さの形）：中心 (x, z)、上の一辺の半分 top（y1）、下の一辺の半分 bottom（y0） */
function frustum(
  P: Record<keyof BigSightParts, THREE.BufferGeometry[]>,
  x: number,
  z: number,
  top: number,
  bottom: number,
) {
  const ring = (h: number, y: number) => [
    new THREE.Vector3(x - h, y, z - h),
    new THREE.Vector3(x + h, y, z - h),
    new THREE.Vector3(x + h, y, z + h),
    new THREE.Vector3(x - h, y, z + h),
  ];
  const lo = ring(bottom, PY0);
  const hi = ring(top, PY1);
  const slant = Math.hypot(top - bottom, PY1 - PY0);
  // 横の面（外向き・上向きの斜めの面）。uv は m（横は上の辺に沿った長さ、縦は斜面に沿った長さ）
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const push = (v: THREE.Vector3, u: number, w: number) => {
      pos.push(v.x, v.y, v.z);
      uv.push(u, w);
    };
    const off = top - bottom;
    push(lo[i], off, 0);
    push(lo[j], off + 2 * bottom, 0);
    push(hi[j], 2 * top, slant);
    push(lo[i], off, 0);
    push(hi[j], 2 * top, slant);
    push(hi[i], 0, slant);
  }
  const side = new THREE.BufferGeometry();
  side.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  side.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  P.panel.push(side);
  // 上の面（屋上）と、下の小さな面
  P.white.push(new THREE.BoxGeometry(top * 2, 0.6, top * 2).translate(x, PY1 + 0.3, z));
  P.under.push(new THREE.BoxGeometry(bottom * 2, 0.6, bottom * 2).translate(x, PY0 - 0.3, z));
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

export function buildBigSight(cx: number): BigSightParts {
  const P: Record<keyof BigSightParts, THREE.BufferGeometry[]> = {
    panel: [],
    under: [],
    glass: [],
    deck: [],
    white: [],
  };
  const Q = HALF / 2;

  // ---- エントランスプラザの台 ----
  P.deck.push(box(cx - HALF - 22, cx + HALF + 22, 0, DECK, -HALF - 22, HALF + 22));

  // ---- 4つの区画：ガラスの塔と、逆さの四角錐 ----
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = cx + sx * Q;
      const z = sz * Q;
      P.glass.push(box(x - LOW, x + LOW, DECK, PY0, z - LOW, z + LOW));
      frustum(P, x, z, Q, LOW);
    }
  }
  // ---- 真ん中：谷の奥のガラスの芯と、下の暗い天井 ----
  P.glass.push(box(cx - 12, cx + 12, 26, PY1 - 4, -12, 12));
  P.under.push(box(cx - 16, cx + 16, 24, 26, -16, 16));
  P.glass.push(box(cx - 6, cx + 6, DECK, 24, -6, 6));

  // ---- 屋上：白い機械室の箱2つと、真ん中の切妻の屋根 ----
  for (const sz of [-1, 1]) P.white.push(box(cx + Q - 9, cx + Q + 9, PY1, PY1 + 9, sz * Q - 8, sz * Q + 8));
  P.white.push(
    new THREE.CylinderGeometry(0, 16, 6, 4, 1)
      .rotateY(Math.PI / 4)
      .scale(1.4, 1, 0.6)
      .translate(cx - 4, PY1 + 3, 0),
  );

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes))
        if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      if (!out.getAttribute('uv')) {
        out.setAttribute(
          'uv',
          new THREE.Float32BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2),
        );
      }
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as BigSightParts;
}

/** 四角錐の面：ベージュ灰色の金属の板に、三角形の格子の線（1枚 = 6m × 6m） */
export function createBigSightPanelMaterial(): THREE.MeshStandardMaterial {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#c4bcab';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#857d70';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(S, 0);
  g.moveTo(0, S);
  g.lineTo(S / 2, 0);
  g.lineTo(S, S);
  g.moveTo(-S / 2, 0);
  g.lineTo(0, S);
  g.moveTo(S, S);
  g.lineTo(S * 1.5, 0);
  g.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / 6, 1 / 6);
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.45, metalness: 0.45, side: THREE.DoubleSide });
}
