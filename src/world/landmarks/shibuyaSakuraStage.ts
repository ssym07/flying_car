import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cap, extrudeWalls, facadeMaterial, roundedRect } from './azabudaiHills';

/**
 * 渋谷サクラステージ（2023年）。配置図と写真を参考に、4つの棟を作る。
 * 座標：中心が (cx, 0, 0)、x = 線路に沿った向き（駅の側 = x が小さい側から南東へ +）、z = それに直角
 * （TRACK_SIDE の符号の側が線路）、y = 上。敷地は x = -128〜128、z = -38〜38。
 *
 * - SHIBUYAタワー（A1、179m）：駅に近い端。曲面の角を持つ低層部（ピンクの桜の模様のガラス）の上に、
 *   駅側の角を丸めた青いガラスの塔。丸い角には緑がかったガラスの縦の帯
 * - セントラルタワー（A2、約 80m）：SHIBUYAタワーの南東、線路側に続く低い棟
 * - SAKURAテラス（約 30m）：道の向こう側に沿う、とても細長い棟（幅 7m）
 * - SAKURAタワー（B、155m）：南東の端。青いガラスの事務所の低層の箱（白い横の帯）の上に、片側に寄った細い住宅の塔
 * - 棟の間の広場とデッキ：緑の植え込み
 */
export interface SakuraParts {
  glass: THREE.BufferGeometry;
  /** 低層部のピンクの桜の模様のガラス */
  pink: THREE.BufferGeometry;
  /** 丸い角の緑がかったガラス */
  green: THREE.BufferGeometry;
  /** SAKURAタワーの住宅棟（ベージュと灰色のバルコニー） */
  residence: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
  plant: THREE.BufferGeometry;
}

/** 線路の側の z の符号 */
const TRACK_SIDE = 1;

export function buildSakuraStage(cx: number): SakuraParts {
  const L: Record<keyof SakuraParts, THREE.BufferGeometry[]> = {
    glass: [],
    pink: [],
    green: [],
    residence: [],
    white: [],
    podium: [],
    plant: [],
  };
  const T = TRACK_SIDE;
  const X = (x: number) => cx + x;
  const Z = (z: number) => T * z;
  const block = (list: THREE.BufferGeometry[], x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, r = 2) => {
    const shape = roundedRect(x1 - x0, z1 - z0, r);
    list.push(extrudeWalls(shape, X((x0 + x1) / 2), y0, y1, Z((z0 + z1) / 2)));
    L.white.push(cap(shape, X((x0 + x1) / 2), y1, Z((z0 + z1) / 2)));
  };

  // ---- SHIBUYAタワー（A1） ----
  block(L.pink, -128, -35, -36, 36, 0, 32, 18);
  L.white.push(new THREE.BoxGeometry(95, 1.2, 74).translate(X(-81), 32.6, 0));
  // 塔：駅側の角を大きく丸める。丸い角に緑がかったガラスの縦の帯
  block(L.glass, -115, -50, -28, 22, 32, 179, 14);
  L.green.push(new THREE.CylinderGeometry(10, 10, 147, 20, 1, true, 0, Math.PI / 2).translate(X(-101), 105.5, Z(8)));
  // 屋上の緑
  L.plant.push(new THREE.BoxGeometry(50, 0.6, 36).translate(X(-82), 179.9, Z(-3)));

  // ---- セントラルタワー（A2） ----
  block(L.glass, -35, 30, 6, 36, 0, 80, 3);
  L.podium.push(new THREE.BoxGeometry(65, 10, 30).translate(X(-2), 5, Z(21)));

  // ---- SAKURAテラス：道の反対側の細長い棟（両端を尖らせる代わりに大きく丸める） ----
  block(L.pink, -20, 60, -38, -31, 0, 30, 3.4);

  // ---- SAKURAタワー（B） ----
  block(L.glass, 70, 128, -36, 30, 0, 92, 3);
  for (let y = 10; y < 92; y += 8.2) L.white.push(new THREE.BoxGeometry(58.6, 0.7, 66.6).translate(X(99), y, Z(-3)));
  // 上の細い住宅の塔（線路と反対側に寄せる）
  block(L.residence, 76, 112, -34, -6, 92, 155, 3);

  // ---- 棟の間の広場・デッキと植え込み ----
  L.podium.push(new THREE.BoxGeometry(40, 8, 60).translate(X(48), 4, 0));
  L.plant.push(new THREE.BoxGeometry(36, 0.6, 56).translate(X(48), 8.3, 0));
  L.plant.push(new THREE.BoxGeometry(18, 0.6, 30).translate(X(-25), 0.4, Z(-15)));

  const merge = (list: THREE.BufferGeometry[]) => {
    if (list.length === 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      return g;
    }
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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as SakuraParts;
}

/** 青いガラスに、白い桟と階ごとの線 */
export function createSakuraGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#4f75a3';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#d3dce6';
      g.fillRect(0, 0, 3, H);
      g.fillRect(0, H - 4, W, 4);
    },
    0.12,
    0.5,
  );
}

/** 低層部：薄い緑がかったガラスに、ピンクの桜の花びらの模様 */
export function createSakuraPinkMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#a9c8c6';
      g.fillRect(0, 0, W, H);
      let seed = 9;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let k = 0; k < 6; k++) {
        g.fillStyle = `rgba(${220 + rand() * 30},${90 + rand() * 50},${150 + rand() * 40},0.85)`;
        g.beginPath();
        g.ellipse(rand() * W, rand() * H, 6 + rand() * 10, 4 + rand() * 7, rand() * 3, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#eef2f2';
      g.fillRect(0, 0, 3, H);
      g.fillRect(0, H - 4, W, 4);
    },
    0.2,
    0.3,
  );
}

/** SAKURAタワーの住宅棟：灰色の壁に、ベージュのバルコニーの帯 */
export function createSakuraResidenceMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#556373';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#c4b8a4';
      g.fillRect(0, H * 0.65, W, H * 0.35);
    },
    0.5,
    0.15,
  );
}
