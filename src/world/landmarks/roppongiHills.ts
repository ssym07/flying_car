import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeMaterial } from './azabudaiHills';
import { loftRounded, member } from './toranomonHills';

/**
 * 六本木ヒルズ森タワー（2003年、238m）。写真を参考に、手続き的に形を作る。
 * 座標：中心が (cx, 0, 0)、x = 平面の長い向き、y = 上、z = それに直角。
 * PLATEAU には塔が無く、足元の複合施設（低層部）だけがあるので、低層部はそのまま残して塔だけを置く。
 *
 * - 平面：両端を丸めた横長の形（86×56m）。上へ少し細くなる
 * - 正面：足元の左から頂部の右へ、面を斜めに分ける折れ目（白い線と、少し奥まった縦の溝）
 * - 頂部：片側が高い斜めの縁と、屋上の設備（ヘリポートの円盤・アンテナ）
 * - 外壁：銀色がかった灰色のガラスに、階ごとの白い横の線
 */
export interface RoppongiParts {
  glass: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  /** 屋上の設備（濃い灰色） */
  roof: THREE.BufferGeometry;
}

export function buildRoppongiMoriTower(cx: number): RoppongiParts {
  const glass: THREE.BufferGeometry[] = [];
  const white: THREE.BufferGeometry[] = [];
  const roof: THREE.BufferGeometry[] = [];
  const H = 238;
  const Y0 = 0;
  const w = (h: number) => THREE.MathUtils.lerp(86, 80, h / H);
  const d = (h: number) => THREE.MathUtils.lerp(56, 50, h / H);
  // 頂部の縁：片側（x が負）が高い斜め
  const top = (x: number, wTop: number) => H - 6 - 8 * (x / wTop);
  glass.push(loftRounded(cx, Y0, H, w, d, 18, top));
  // 頂部の縁の白い帯
  for (let j = 0; j < 30; j++) {
    const x0 = -w(H) / 2 + 10 + ((w(H) - 20) * j) / 30;
    const x1 = -w(H) / 2 + 10 + ((w(H) - 20) * (j + 1)) / 30;
    for (const side of [1, -1]) {
      white.push(
        member(
          new THREE.Vector3(cx + x0, top(x0, w(H)) + 0.6, (side * d(H)) / 2),
          new THREE.Vector3(cx + x1, top(x1, w(H)) + 0.6, (side * d(H)) / 2),
          1.4,
        ),
      );
    }
  }
  // 正面と背面の斜めの折れ目：足元の左寄りから頂部の右寄りへ
  for (const side of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 16; k++) {
      const h = THREE.MathUtils.lerp(Y0 + 40, H - 12, k / 16);
      const x = THREE.MathUtils.lerp(-w(h) * 0.22, w(h) * 0.12, k / 16) * side;
      pts.push(new THREE.Vector3(cx + x, h, side * (d(h) / 2 + 0.3)));
    }
    for (let k = 1; k < pts.length; k++) white.push(member(pts[k - 1], pts[k], 1.8));
  }
  // 屋上の設備：ヘリポートの円盤、塔屋、アンテナ
  roof.push(new THREE.CylinderGeometry(14, 14, 1.2, 32).translate(cx + 8, H + 2, 0));
  roof.push(new THREE.BoxGeometry(20, 6, 18).translate(cx - 14, H + 1, 4));
  for (const [x, z, h] of [
    [-20, -8, 14],
    [-8, 12, 10],
    [18, -14, 8],
  ]) {
    roof.push(new THREE.CylinderGeometry(0.4, 0.6, h, 6).translate(cx + x, H + h / 2, z));
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
  return { glass: merge(glass), white: merge(white), roof: merge(roof) };
}

/** 銀色がかった灰色のガラスに、階ごとの白い横の線と細い縦の桟 */
export function createRoppongiGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#8e9ea8');
      grad.addColorStop(1, '#75868f');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#e1e5e8';
      g.fillRect(0, H - 9, W, 9);
      g.fillStyle = 'rgba(200,208,214,0.7)';
      g.fillRect(0, 0, 2, H);
    },
    0.2,
    0.45,
  );
}
