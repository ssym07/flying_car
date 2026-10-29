import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * モード学園コクーンタワー（2008年、204m）。写真を参考に作る。
 * 座標：塔の中心が (cx, 0, 0)、x = 東、z = 南、y = 上。
 *
 * - 本体：平面は楕円（東西 50m・南北 40m）。下から 1/4 の高さで一番太く、上へ行くほど弾丸の先のように丸く細くなる。
 *   勾玉のように、上ほど中心を少し東へずらす（西の縁はまっすぐ、東の縁が丸く張り出す）
 * - ガラス：本体の面は明るい青灰色のガラスに、階ごとの床の縁の帯
 * - 白い梁：本体を包む、右回り・左回りのらせんの白い梁。交わってひし形の網になる（上へ行くほど細長いひし形）
 * - 上部の楕円の窓：南北の広い面の上部は、網を抜いて白い縁で囲む
 * - 足元のドーム：東の広場に、白い三角のパネルを張った低いドーム（地下の大ホールの入口）
 */
export interface CocoonParts {
  glass: THREE.BufferGeometry;
  /** 白い梁・窓の縁・ドームのパネル */
  lattice: THREE.BufferGeometry;
  /** ドームのパネルの間の目地 */
  dark: THREE.BufferGeometry;
}

const H = 204;
/** 一番太いところの半径（東西・南北） */
const A = 25;
const B = 20;
/** 頂部での中心の東へのずれ (m) */
const SHIFT = 4;
/** らせんの本数（片方の向き）と、高さ 1m あたりの回る角度 */
const N = 24;
const TWIST = (Math.PI * 2) / N / 14;
/** 上部の楕円の窓：中心の高さ・半分の幅（面に沿って）・半分の高さ */
const OVAL_Y = 178;
const OVAL_U = 9.5;
const OVAL_V = 17;

/** 高さの割合 t での太さ（一番太いところ = 1） */
function profile(t: number): number {
  const bulge = t < 0.25 ? 0.88 + 0.12 * Math.sin(((t / 0.25) * Math.PI) / 2) : 1 - 0.3 * ((t - 0.25) / 0.75) ** 2;
  // 頂部は丸く（超楕円で、ふちまで太さを保つ）
  const u = Math.max(0, (t - 0.82) / 0.18);
  const nose = Math.max(0, 1 - u ** 2.4) ** (1 / 2.4);
  return bulge * nose;
}

/** 本体の面の点（off = 面から外へ m） */
function surface(cx: number, theta: number, y: number, off: number): THREE.Vector3 {
  const t = y / H;
  const s = profile(t);
  return new THREE.Vector3(
    cx + SHIFT * t * t + (A * s + off) * Math.cos(theta),
    y,
    (B * s + off) * Math.sin(theta),
  );
}

/** 面の外向き（水平）の向き */
function outward(theta: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(theta) / A, 0, Math.sin(theta) / B).normalize();
}

/** 上部の楕円の窓の中か（南北の面） */
function inOval(theta: number, y: number): boolean {
  const a = A * profile(y / H);
  for (const c of [Math.PI / 2, -Math.PI / 2]) {
    let d = theta - c;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if ((((d * a) / OVAL_U) ** 2 + ((y - OVAL_Y) / OVAL_V) ** 2) < 1) return true;
  }
  return false;
}

/**
 * 点の列に沿った四角い断面の梁（w = 面に沿った幅、d = 厚み）。closed なら輪にする。
 * keep[i] が false の点を含む区間は作らない
 */
function bar(
  out: number[],
  pts: THREE.Vector3[],
  normals: THREE.Vector3[],
  w: number,
  d: number,
  closed = false,
  keep?: boolean[],
): void {
  const n = pts.length;
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tan = next.clone().sub(prev).normalize();
    const side = new THREE.Vector3().crossVectors(tan, normals[i]).normalize().multiplyScalar(w / 2);
    const up = normals[i].clone().multiplyScalar(d / 2);
    const p = pts[i];
    rings.push([
      p.clone().add(side).add(up),
      p.clone().sub(side).add(up),
      p.clone().sub(side).sub(up),
      p.clone().add(side).sub(up),
    ]);
  }
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, e: THREE.Vector3) =>
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, e.x, e.y, e.z);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    if (keep && (!keep[i] || !keep[j])) continue;
    for (let k = 0; k < 4; k++) quad(rings[i][k], rings[i][(k + 1) % 4], rings[j][(k + 1) % 4], rings[j][k]);
  }
}

function fromPositions(list: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
  return g;
}

export function buildCocoonTower(cx: number): CocoonParts {
  const L: Record<keyof CocoonParts, THREE.BufferGeometry[]> = { glass: [], lattice: [], dark: [] };

  // ---- ガラスの本体：楕円の輪を高さごとに重ねる ----
  {
    const SEG = 72;
    const rows: number[] = [];
    for (let y = 0; y < H - 0.01; y += 2) rows.push(y);
    rows.push(H);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (const y of rows) {
      for (let k = 0; k <= SEG; k++) {
        const theta = (k / SEG) * Math.PI * 2;
        const p = surface(cx, theta, y, -0.6);
        pos.push(p.x, p.y, p.z);
        uv.push((theta * (A + B)) / 2 / 3, y / FLOOR);
      }
    }
    for (let r = 0; r < rows.length - 1; r++) {
      for (let k = 0; k < SEG; k++) {
        const a = r * (SEG + 1) + k;
        const b = a + SEG + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    L.glass.push(g);
  }

  // ---- 白い梁：右回り・左回りのらせん ----
  const beams: number[] = [];
  const TOP = H * 0.985;
  for (const dir of [1, -1]) {
    for (let k = 0; k < N; k++) {
      const pts: THREE.Vector3[] = [];
      const nors: THREE.Vector3[] = [];
      const keep: boolean[] = [];
      for (let y = 0; y <= TOP; y += 2) {
        const theta = (k / N) * Math.PI * 2 + dir * TWIST * y;
        pts.push(surface(cx, theta, y, 0.5));
        nors.push(outward(theta));
        keep.push(!inOval(theta, y));
      }
      bar(beams, pts, nors, 1.1, 0.9, false, keep);
    }
  }
  // 足元と頂部の輪
  for (const [y, w] of [
    [0.6, 1.2],
    [TOP, 1.2],
  ]) {
    const pts: THREE.Vector3[] = [];
    const nors: THREE.Vector3[] = [];
    for (let k = 0; k < 72; k++) {
      const theta = (k / 72) * Math.PI * 2;
      pts.push(surface(cx, theta, y, 0.5));
      nors.push(outward(theta));
    }
    bar(beams, pts, nors, w, 1, true);
  }
  // 頂部のふた（梁が集まるところ）
  {
    const r = A * profile(TOP / H);
    L.lattice.push(
      new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2)
        .scale(r + 0.6, 2.5, ((r + 0.6) * B) / A)
        .translate(cx + SHIFT * (TOP / H) ** 2, TOP, 0),
    );
  }
  // 上部の楕円の窓の白い縁
  for (const c of [Math.PI / 2, -Math.PI / 2]) {
    const pts: THREE.Vector3[] = [];
    const nors: THREE.Vector3[] = [];
    for (let k = 0; k < 48; k++) {
      const phi = (k / 48) * Math.PI * 2;
      const y = OVAL_Y + OVAL_V * Math.sin(phi);
      const theta = c + (OVAL_U * Math.cos(phi)) / (A * profile(y / H));
      pts.push(surface(cx, theta, y, 0.6));
      nors.push(outward(theta));
    }
    bar(beams, pts, nors, 1.6, 1.1, true);
  }
  L.lattice.push(fromPositions(beams));

  // ---- 足元のドーム：白い三角のパネル（目地は暗い灰色の下地が見える） ----
  {
    const R = 11;
    const dx = cx + 38;
    const dz = 4;
    const ico = new THREE.IcosahedronGeometry(R, 2);
    const p = ico.getAttribute('position');
    const panels: number[] = [];
    for (let i = 0; i < p.count; i += 3) {
      const tri = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(p, i + j));
      const c = tri[0].clone().add(tri[1]).add(tri[2]).divideScalar(3);
      if (c.y < -0.5) continue;
      for (const v of tri) {
        const q = v.clone().lerp(c, 0.08);
        panels.push(dx + q.x * 1.02, Math.max(0, q.y) * 0.72 * 1.02, dz + q.z * 1.02);
      }
    }
    ico.dispose();
    L.lattice.push(fromPositions(panels));
    L.dark.push(
      new THREE.SphereGeometry(R * 0.93, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.72, 1).translate(dx, 0, dz),
    );
    // ドームの縁の低い台
    L.dark.push(new THREE.CylinderGeometry(R + 0.8, R + 1, 0.8, 40).translate(dx, 0.4, dz));
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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as CocoonParts;
}

/** 本体のガラス：明るい青灰色に、階ごとの床の縁の帯（1枚 = 3m × 1階） */
export function createCocoonGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, Wp, Hp) => {
      g.fillStyle = '#8eaabd';
      g.fillRect(0, 0, Wp, Hp);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(0, 0, Wp, Hp * 0.45);
      g.fillStyle = '#c3c8cc';
      g.fillRect(0, Hp - 10, Wp, 10);
      g.fillStyle = 'rgba(60,70,80,0.35)';
      g.fillRect(0, 0, 2, Hp);
    },
    0.15,
    0.45,
  );
}
