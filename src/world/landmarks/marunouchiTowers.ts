import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, cap, extrudeWalls, facadeMaterial, roundedRect } from './azabudaiHills';

/**
 * 丸ビル（丸の内ビルディング、2002年、179m）と新丸ビル（新丸の内ビルディング、2007年、198m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 街区の長い向き（北北東が +）、z = 東京駅の側（東南東）が +、y = 上。
 *
 * どちらも、旧丸ビルと同じ高さ 31m の低層部（街区いっぱい）の上に、少し西へ寄せた塔が立つ。
 * 塔は縦のガラスのすき間で南北に分かれ、南の側が高い。塔の四隅は切り欠いて、奥をガラスにする
 *
 * - 丸ビル：低層部はベージュの石に縦長の窓、角は大きく丸い。1階は暗いアーケード。
 *   塔は明るいベージュの石に横長の窓の帯。上に短い機械室
 * - 新丸ビル：低層部は暗い灰色の格子に大きなガラス。上の 7階は奥へ下げたテラス（植え込み）。
 *   塔は暗い青灰色のガラスに灰色の縦の桟。てっぺんは明るいガラスの冠と、角の柱の枠
 */
export interface MarunouchiParts {
  podium: THREE.BufferGeometry;
  tower: THREE.BufferGeometry;
  /** 明るいガラス（塔のすき間・四隅・冠） */
  glass: THREE.BufferGeometry;
  /** 1階の暗いアーケード・奥へ下げた階 */
  dark: THREE.BufferGeometry;
  /** 軒（コーニス）と枠 */
  trim: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
}

type Lists = Record<keyof MarunouchiParts, THREE.BufferGeometry[]>;

/** 箱（外面の uv は m 単位：横 / 3、縦 / FLOOR） */
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

/** 塔の胴：四隅を n m 切り欠いた箱（十字形）。切り欠きの奥にガラスの柱、上に屋根 */
function shaft(L: Lists, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n: number): void {
  L.tower.push(box(x0 + n, x1 - n, y0, y1, z0, z1));
  L.tower.push(box(x0, x1, y0, y1, z0 + n, z1 - n));
  for (const [xa, xb] of [
    [x0 + 1, x0 + n],
    [x1 - n, x1 - 1],
  ]) {
    for (const [za, zb] of [
      [z0 + 1, z0 + n],
      [z1 - n, z1 - 1],
    ]) {
      L.glass.push(box(xa, xb, y0, y1, za, zb));
    }
  }
  L.roof.push(box(x0 + n, x1 - n, y1, y1 + 0.4, z0 + 0.6, z1 - 0.6));
  L.roof.push(box(x0 + 0.6, x1 - 0.6, y1, y1 + 0.4, z0 + n, z1 - n));
}

/** 塔を南北に分ける縦のガラスのすき間（x0〜x1、面から少し出す） */
function slit(L: Lists, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  L.glass.push(box(x0, x1, y0, y1, z0 - 0.3, z1 + 0.3));
}

function merge(L: Lists): MarunouchiParts {
  const one = (list: THREE.BufferGeometry[]) => {
    // 使わない部品（丸ビルの植え込み）は空の形
    if (list.length === 0) {
      const empty = new THREE.BufferGeometry();
      empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      return empty;
    }
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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, one(v)])) as unknown as MarunouchiParts;
}

const lists = (): Lists => ({ podium: [], tower: [], glass: [], dark: [], trim: [], roof: [], green: [] });

/** 丸ビル：街区 94 × 78m */
export function buildMaruBuilding(cx: number): MarunouchiParts {
  const L = lists();
  // ---- 低層部（〜31m）：角の丸い石の箱。1階は暗いアーケード。上に軒と、奥へ下げたガラスの階 ----
  const base = roundedRect(94, 78, 12);
  L.dark.push(extrudeWalls(base, cx, 0, 5.5));
  L.podium.push(extrudeWalls(base, cx, 5.5, 31));
  L.trim.push(cap(roundedRect(95.6, 79.6, 12.6), cx, 31));
  L.glass.push(extrudeWalls(roundedRect(90, 74, 10), cx, 32.5, 36));
  L.roof.push(cap(roundedRect(91, 75, 10.5), cx, 36));
  // ---- 塔：南（x < 8）は 177m まで、北は 163m まで。境に縦のガラスのすき間 ----
  const z0 = -28;
  const z1 = 16;
  shaft(L, cx - 31, cx + 7, 37.5, 177, z0, z1, 4);
  shaft(L, cx + 9, cx + 31, 37.5, 163, z0, z1, 4);
  slit(L, cx + 6, cx + 10, 37.5, 163, z0 + 2, z1 - 2);
  // 低い側の上の、少し奥の階と、高い側の上の機械室
  L.dark.push(box(cx + 12, cx + 28, 163.4, 167, z0 + 5, z1 - 5));
  L.roof.push(box(cx + 12, cx + 28, 167, 167.4, z0 + 5, z1 - 5));
  L.trim.push(box(cx - 24, cx - 2, 177.4, 181.5, z0 + 8, z1 - 8));
  return merge(L);
}

/** 新丸ビル：街区 100 × 77m */
export function buildShinMarunouchi(cx: number): MarunouchiParts {
  const L = lists();
  // ---- 低層部（〜31m）：1階は高いガラス、上は暗い格子。軒の上は奥へ下げたテラスの階と植え込み ----
  const base = roundedRect(100, 76, 4);
  L.dark.push(extrudeWalls(base, cx, 0, 6));
  L.podium.push(extrudeWalls(base, cx, 6, 31));
  L.trim.push(cap(roundedRect(101.2, 77.2, 4.5), cx, 31));
  L.dark.push(extrudeWalls(roundedRect(92, 68, 3), cx, 32.5, 37));
  L.roof.push(cap(roundedRect(94, 70, 3.5), cx, 37));
  // テラスの縁の植え込みと、ところどころの木
  for (const [x0, x1, z0, z1] of [
    [-49, 49, 35.5, 37.5],
    [-49, 49, -37.5, -35.5],
    [-49, -47, -35.5, 35.5],
    [47, 49, -35.5, 35.5],
  ]) {
    L.green.push(box(cx + x0, cx + x1, 32.5, 33.6, z0, z1));
  }
  for (let x = -44; x <= 44; x += 8) {
    for (const z of [-34.5, 34.5]) {
      L.green.push(new THREE.IcosahedronGeometry(1.8, 0).scale(1, 1.2, 1).translate(cx + x, 35.2, z));
    }
  }
  // ---- 塔：南（x < -1）は冠まで 198m、北は 182m まで。境に縦のガラスのすき間 ----
  const z0 = -27;
  const z1 = 15;
  shaft(L, cx - 38, cx - 1, 38.5, 186, z0, z1, 3.5);
  shaft(L, cx + 1, cx + 38, 38.5, 176, z0, z1, 3.5);
  slit(L, cx - 2, cx + 2, 38.5, 176, z0 + 2, z1 - 2);
  // 北の側の上：明るいガラスの帯（176〜182m）
  L.glass.push(box(cx + 2.5, cx + 37, 176.4, 182, z0 + 1, z1 - 1));
  L.roof.push(box(cx + 2, cx + 37.5, 182, 182.5, z0 + 0.5, z1 - 0.5));
  // 南の側の冠（186〜198m）：明るいガラスの箱と、角の柱・上の梁の枠
  L.glass.push(box(cx - 36.5, cx - 2.5, 186.4, 197, z0 + 1.5, z1 - 1.5));
  L.roof.push(box(cx - 36.5, cx - 2.5, 197, 197.4, z0 + 1.5, z1 - 1.5));
  for (const x of [cx - 38, cx - 3]) {
    for (const z of [z0, z1 - 2]) L.trim.push(box(x, x + 2, 186.4, 198, z, z + 2));
  }
  for (const z of [z0, z1 - 1.2]) L.trim.push(box(cx - 38, cx - 1, 196.8, 198, z, z + 1.2));
  for (const x of [cx - 38, cx - 2.2]) L.trim.push(box(x, x + 1.2, 196.8, 198, z0, z1));
  return merge(L);
}

/** 丸ビルの低層部：ベージュの石に縦長の窓（1枚 = 3m × 1階、窓 1 つ） */
export function createMaruPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#cbb99a';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#56606a';
      g.fillRect(W * 0.22, H * 0.18, W * 0.56, H * 0.62);
      g.fillStyle = 'rgba(120,100,70,0.35)';
      g.fillRect(0, H - 3, W, 3);
    },
    0.8,
    0,
  );
}

/** 丸ビルの塔：明るいベージュの石に、横長の窓の帯（1枚 = 3m × 1階） */
export function createMaruTowerMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#d9d0c0';
      g.fillRect(0, 0, W, H);
      const grad = g.createLinearGradient(0, H * 0.2, 0, H * 0.78);
      grad.addColorStop(0, '#8d9eae');
      grad.addColorStop(1, '#6b7c8c');
      g.fillStyle = grad;
      g.fillRect(0, H * 0.2, W, H * 0.58);
      g.fillStyle = '#c9c0b0';
      g.fillRect(W / 2 - 1, H * 0.2, 3, H * 0.58);
    },
    0.6,
    0.05,
  );
}

/** 新丸ビルの低層部：暗い灰色の格子に大きなガラス（1枚 = 3m × 1階） */
export function createShinMaruPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#55524e';
      g.fillRect(0, 0, W, H);
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#7f93a4');
      grad.addColorStop(1, '#5a6c7c');
      g.fillStyle = grad;
      g.fillRect(W * 0.12, H * 0.12, W * 0.76, H * 0.72);
    },
    0.5,
    0.2,
  );
}

/** 新丸ビルの塔：暗い青灰色のガラスに、灰色の縦の桟と階の線（1枚 = 3m × 1階） */
export function createShinMaruTowerMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#465c70');
      grad.addColorStop(1, '#2f4152');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#8b959d';
      g.fillRect(0, 0, 4, H);
      g.fillRect(W / 2 - 1, 0, 3, H);
      g.fillStyle = '#3a4550';
      g.fillRect(0, H - 10, W, 10);
    },
    0.2,
    0.5,
  );
}

/** 明るいガラス（塔のすき間・冠）：薄い青に細い桟（1枚 = 3m × 1階） */
export function createMarunouchiGlassMaterial(tint: string): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = tint;
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(225,232,238,0.7)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(0, H - 3, W, 3);
    },
    0.15,
    0.4,
  );
}
