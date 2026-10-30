import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 東京ドーム（1988年、56m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x・z = 角の丸い四角の2つの辺の向き、y = 上。平面は超楕円（|x/R|^N + |z/R|^N = 1）。
 *
 * - 壁：外へ少し傾いた暗いガラスの壁（下が細く、上が太い）。足元はコンクリートの台
 * - 屋根の縁：白い帯と、内側へ下がる灰色の縁（細い格子）
 * - 屋根：空気で膨らませた白い膜。斜めに交わるケーブルで、枕のようにふくらんだ升目に分かれる
 */
export interface DomeParts {
  glass: THREE.BufferGeometry;
  concrete: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  membrane: THREE.BufferGeometry;
}

const N = 3.2;
const SEG = 160;

/** 超楕円の向き t の点の、中心からの距離（R = 1） */
function superR(t: number): number {
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return (c ** N + s ** N) ** (-1 / N);
}

/** 超楕円の大きさ R0（高さ y0）から R1（高さ y1）までの帯 */
function band(cx: number, R0: number, y0: number, R1: number, y1: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k <= SEG; k++) {
    const t = (k / SEG) * Math.PI * 2;
    const r = superR(t);
    pos.push(cx + R0 * r * Math.cos(t), y0, R0 * r * Math.sin(t), cx + R1 * r * Math.cos(t), y1, R1 * r * Math.sin(t));
    uv.push(k / 4, 0, k / 4, 1);
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

export function buildTokyoDome(cx: number): DomeParts {
  const P: Record<keyof DomeParts, THREE.BufferGeometry[]> = { glass: [], concrete: [], rim: [], membrane: [] };

  // ---- 足元の台（0〜4m）と、外へ傾いた暗いガラスの壁（4〜32m） ----
  P.concrete.push(band(cx, 97, 0, 97, 4));
  P.concrete.push(band(cx, 97, 4, 95, 4));
  P.glass.push(band(cx, 95, 4, 100.5, 32));
  // ---- 屋根の縁：白い帯（32〜36m）と、内側へ下がる灰色の縁 ----
  P.rim.push(band(cx, 100.5, 32, 101, 36.5));
  P.rim.push(band(cx, 101, 36.5, 96, 37.5));
  P.rim.push(band(cx, 96, 37.5, 94, 36.8));

  // ---- 膜の屋根：縁（94m、36.8m）から真ん中（56m）へ。s = 中心からの割合 ----
  {
    const RINGS = 40;
    const R = 94;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= RINGS; i++) {
      const s = i / RINGS;
      // 中心ほど高い、平たいドーム（縁ではなめらかに縁へつなぐ）
      const y = 36.8 + 19.4 * (1 - s * s) ** 0.75;
      for (let k = 0; k <= SEG; k++) {
        const t = (k / SEG) * Math.PI * 2;
        const r = superR(t) * R * s;
        const x = r * Math.cos(t);
        const z = r * Math.sin(t);
        pos.push(cx + x, y, z);
        // 升目の模様は斜め45度の向き（ケーブル）で、1升 = UV 1
        uv.push((x + z) / Math.SQRT2 / 13, (x - z) / Math.SQRT2 / 13);
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
    g.computeVertexNormals();
    P.membrane.push(g);
  }

  const merge = (list: THREE.BufferGeometry[], smooth: boolean) => {
    const prepared = list.map((g) => {
      const out = smooth ? g : g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      return out;
    });
    const g = mergeGeometries(prepared)!;
    g.computeVertexNormals();
    return g;
  };
  return {
    glass: merge(P.glass, true),
    concrete: merge(P.concrete, false),
    rim: merge(P.rim, false),
    membrane: merge(P.membrane, true),
  };
}

/** 膜の屋根：白い升目の中ほどがふくらんで明るく、ケーブルの線は細い灰色（1升分の画像） */
export function createDomeMembraneMaterial(): THREE.MeshStandardMaterial {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S * 0.75);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#d7dadd');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#9aa0a6';
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, 0, 3, S);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55, side: THREE.DoubleSide });
}

/** ガラスの壁：暗い青灰色に、縦横の細い枠（1枚 = 幅 1/4 周 × 壁の高さ） */
export function createDomeGlassMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#2f3b44';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = 'rgba(160,175,185,0.55)';
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 2, 128);
  for (let y = 0; y < 128; y += 16) g.fillRect(0, y, 64, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.15, metalness: 0.5, side: THREE.DoubleSide });
}
