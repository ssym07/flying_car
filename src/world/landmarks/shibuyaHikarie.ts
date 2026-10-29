import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeMaterial } from './azabudaiHills';

/**
 * 渋谷ヒカリエ（2012年、182.5m）。写真を参考に、大きさの違う箱の組み合わせで作る。
 * 座標：中心が (cx, 0, 0)、x = 長い向き（東へ +。正面は西の端 = x が小さい側）、y = 上、z = 幅の向き。
 *
 * 正面（西）は下から、
 * - 足元：低い基壇と、角の丸いガラスの入口
 * - ブロックA（8〜42m）：横に広い、白い枠のガラスの箱
 * - くびれ（42〜47m）：奥まった暗い帯
 * - ブロックB（47〜80m）：いちばん大きく張り出した、白い枠のガラスの箱（右寄り）
 * - ブロックC（42〜64m）：左に寄った小さな白い枠のガラスの箱
 * - タワー（80〜182.5m）：濃い青のガラスの高層部。横に白い縦の壁（コア）と、暗いガラスの細い棟が並ぶ
 */
export interface HikarieParts {
  /** ブロックのガラス（明るい青灰色、格子） */
  glass: THREE.BufferGeometry;
  /** タワーの濃い青のガラス */
  tower: THREE.BufferGeometry;
  /** 白い枠・コアの壁 */
  white: THREE.BufferGeometry;
  /** 暗い壁・くびれ・基壇 */
  dark: THREE.BufferGeometry;
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

/** 箱の外面に、uv を m 単位で付け直す（横 = x か z、縦 = y） */
function metricUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const across = Math.abs(nor.getX(i)) > 0.5 ? pos.getZ(i) : pos.getX(i);
    uv.setXY(i, across / 3, pos.getY(i) / 4.2);
  }
  return g;
}

export function buildHikarie(cx: number): HikarieParts {
  const glass: THREE.BufferGeometry[] = [];
  const tower: THREE.BufferGeometry[] = [];
  const white: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const X = (x: number) => cx + x;

  /** 白い枠のガラスの箱：ガラスの箱と、上下の白い板（少し張り出す）、正面の左右の白い縦の枠 */
  const framed = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    glass.push(metricUv(box(X(x0), X(x1), y0, y1, z0, z1)));
    const o = 1.2;
    white.push(box(X(x0 - o), X(x1), y1, y1 + 1.4, z0 - o, z1 + o));
    white.push(box(X(x0 - o), X(x1), y0 - 1.2, y0, z0 - o, z1 + o));
    for (const z of [z0 - o, z1]) white.push(box(X(x0 - o), X(x0 + 2), y0 - 1.2, y1 + 1.4, z, z + o));
  };

  // ---- 奥の低層部と基壇 ----
  dark.push(box(X(-55), X(65), 0, 40, -28, 28));
  white.push(box(X(-60), X(-5), 7, 8, -31, 31));
  // 角の丸いガラスの入口
  glass.push(new THREE.CylinderGeometry(10, 10, 8, 32).translate(X(-58), 4, -12));

  // ---- 正面のブロック ----
  framed(-60, -5, 8, 41, -24, 30); // A
  // A の左の暗い壁（C の下から足元まで）
  dark.push(box(X(-56), X(-5), 8, 41, -30, -24));
  dark.push(box(X(-46), X(-5), 41, 49, -26, 26)); // くびれ（深く奥まった帯）
  framed(-58, -36, 44, 66, 19, 33); // C（左に寄った小さな箱）
  framed(-70, -12, 49, 82, -38, 15); // B（いちばん大きく、正面と右へ張り出す）

  // ---- タワー ----
  tower.push(metricUv(box(X(-34), X(22), 82, 182.5, -26, 16)));
  white.push(box(X(-33), X(23), 182.5, 184, -27, 17));
  // 横の白い縦の壁（コア）と、暗いガラスの細い棟
  white.push(box(X(-12), X(30), 40, 178, 16, 27));
  tower.push(metricUv(box(X(-22), X(30), 40, 170, -28, -16)));

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return { glass: merge(glass), tower: merge(tower), white: merge(white), dark: merge(dark) };
}

/** ブロックのガラス：明るい青灰色に、白い縦横の桟 */
export function createHikarieGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#7f9db3';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#d9e1e7';
      g.fillRect(0, 0, 3, H);
      g.fillRect(0, H - 4, W, 4);
    },
    0.15,
    0.45,
  );
}

/** タワー：濃い青のガラスに、細い桟 */
export function createHikarieTowerMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#2f4f78';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(150,175,200,0.7)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(0, H - 3, W, 3);
    },
    0.12,
    0.5,
  );
}
