import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 東京ビル TOKIA（2005年、164m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 線路に沿った長い向き（北北東が +）、z = 線路の側（東南東）が +、y = 上。
 * 平面は 114 × 44m の板。
 *
 * - 塔の南の部分：青緑のガラスの壁。北の部分：白い縦のフィン（羽根板）が並ぶ壁、北の端の面は白い石
 * - 2つの境に、上まで通る白い石の柱
 * - 北の端の近くに縦の暗いすき間と、高い所に飛び出したガラスの箱
 * - 低層部：ガラスの箱（〜22m）、張り出した白い庇と植え込み、その上の暗い奥まった階（〜30m）
 * - 屋上：北の部分の上に白い目隠しの壁
 */
export interface TokiaParts {
  glass: THREE.BufferGeometry;
  fins: THREE.BufferGeometry;
  stone: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

type Lists = Record<keyof TokiaParts, THREE.BufferGeometry[]>;
type Face = keyof TokiaParts | null;

/** (x0, z0) 〜 (x1, z1) の縦の壁（uv：横 / 3m、縦 / FLOOR） */
function quad(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): THREE.BufferGeometry {
  const u1 = Math.hypot(x1 - x0, z1 - z0) / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0], 3),
  );
  const v0 = y0 / FLOOR;
  const v1 = y1 / FLOOR;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, v0, u1, v0, u1, v1, 0, v0, u1, v1, 0, v1], 2));
  return g;
}

/** 箱の4つの面（南 x0・北 x1・西 z0・東 z1）を、面ごとの材質で。null の面は作らない。上に屋根 */
function mass(
  L: Lists,
  faces: { s: Face; n: Face; w: Face; e: Face },
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  roof = true,
): void {
  if (faces.s) L[faces.s].push(quad(x0, z1, x0, z0, y0, y1));
  if (faces.n) L[faces.n].push(quad(x1, z0, x1, z1, y0, y1));
  if (faces.w) L[faces.w].push(quad(x0, z0, x1, z0, y0, y1));
  if (faces.e) L[faces.e].push(quad(x1, z1, x0, z1, y0, y1));
  if (roof) L.roof.push(new THREE.BoxGeometry(x1 - x0, 0.4, z1 - z0).translate((x0 + x1) / 2, y1 + 0.2, (z0 + z1) / 2));
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

export function buildTokyoBuilding(cx: number): TokiaParts {
  const L: Lists = { glass: [], fins: [], stone: [], podium: [], dark: [], white: [], green: [], roof: [] };
  const X0 = cx - 57;
  const X1 = cx + 57;
  const Z = 22;
  const SPLIT = cx - 10;

  // ---- 低層部：ガラスの箱、張り出した白い庇と植え込み、暗い奥まった階 ----
  mass(L, { s: 'podium', n: 'podium', w: 'podium', e: 'podium' }, X0, X1, 0, 22, -Z, Z, false);
  L.white.push(box(X0 - 3, X1, 22, 23.2, -Z - 3, Z));
  for (const [x0, x1, z0, z1] of [
    [X0 - 3, X1, -Z - 3, -Z - 1.6],
    [X0 - 3, X0 - 1.6, -Z - 3, Z],
  ]) {
    L.green.push(box(x0, x1, 23.2, 24.2, z0, z1));
  }
  for (let x = X0 + 4; x < X1; x += 9) {
    L.green.push(new THREE.IcosahedronGeometry(1.6, 0).scale(1, 1.2, 1).translate(x, 25.4, -Z - 2.3));
  }
  mass(L, { s: 'dark', n: 'dark', w: 'dark', e: 'dark' }, X0 + 1.5, X1 - 1.5, 23.2, 30, -Z + 1.5, Z - 1.5, false);

  // ---- 塔：南はガラス（164m）、北は縦のフィン（160m）、北の端の面は石 ----
  mass(L, { s: 'glass', n: null, w: 'glass', e: 'glass' }, X0, SPLIT, 30, 164, -Z, Z);
  mass(L, { s: null, n: 'stone', w: 'fins', e: 'fins' }, SPLIT, X1, 30, 160, -Z, Z);
  // 境の白い石の柱（少し出す）と、北の端の角の石の柱
  L.stone.push(box(SPLIT - 2, SPLIT + 2.5, 0, 166, -Z - 1, Z + 1));
  L.stone.push(box(X1 - 3, X1 + 0.5, 30, 160, -Z - 0.6, Z + 0.6));
  // 北の端の近くの縦の暗いすき間と、高い所に飛び出したガラスの箱（白い枠）
  L.dark.push(box(cx + 38, cx + 42, 30, 160, -Z - 0.3, Z + 0.3));
  for (const s of [-1, 1]) {
    L.glass.push(box(cx + 35, cx + 45, 128, 138, s < 0 ? -Z - 3 : Z, s < 0 ? -Z : Z + 3));
    const zf = s < 0 ? -Z - 3.3 : Z + 3;
    L.white.push(box(cx + 34.5, cx + 45.5, 137.5, 138.8, zf, zf + 0.3));
    L.white.push(box(cx + 34.5, cx + 45.5, 127.2, 128.5, zf, zf + 0.3));
  }
  // 屋上：北の部分の上の白い目隠しの壁（上へ行くほど少し外へ）、南の部分の上の細い手すり壁
  mass(L, { s: 'white', n: 'white', w: 'white', e: 'white' }, SPLIT + 3, X1 - 2, 160.4, 167, -Z + 0.5, Z - 0.5, false);
  mass(L, { s: 'white', n: null, w: 'white', e: 'white' }, X0, SPLIT, 164.4, 165.6, -Z, Z, false);

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes))
        if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as TokiaParts;
}

/** 南の部分の青緑のガラス：細い縦横の桟（1枚 = 3m × 1階） */
export function createTokiaGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#6fa7b8');
      grad.addColorStop(1, '#447c90');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(215,228,232,0.6)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(W / 2, 0, 1, H);
      g.fillStyle = '#3c5f6c';
      g.fillRect(0, H - 8, W, 8);
    },
    0.12,
    0.35,
  );
}

/** 北の部分：ガラスの前に白い縦のフィンが並ぶ（1枚 = 3m × 1階、フィン 4 本） */
export function createTokiaFinMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#6f8d9e';
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 4; i++) {
        const x = (i * W) / 4;
        g.fillStyle = '#e9e9e6';
        g.fillRect(x, 0, 5, H);
        g.fillStyle = 'rgba(60,70,80,0.35)';
        g.fillRect(x + 5, 0, 3, H);
      }
    },
    0.55,
    0.1,
  );
}

/** 白い石：細い縦長の窓（1枚 = 3m × 1階） */
export function createTokiaStoneMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#dedbd4';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#5b6873';
      g.fillRect(W * 0.4, H * 0.15, W * 0.2, H * 0.7);
    },
    0.75,
    0,
  );
}

/** 低層部の明るいガラス（1枚 = 3m × 1階） */
export function createTokiaPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#9cc0cf';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(240,244,246,0.8)';
      g.fillRect(0, 0, 3, H);
      g.fillRect(0, H - 4, W, 4);
    },
    0.1,
    0.3,
  );
}
