import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 麻布台ヒルズ（2023年）：森JPタワー（高さ 325m）と、レジデンスA・B。写真を参考に、手続き的に形を作る。
 * 座標：建物の座標（x = PLATEAU の箱の長い向き、y = 上、z = それに直角）。中心が (cx, 0, 0)。
 *
 * - 森JPタワー：角を大きく丸めた四角い平面が、中ほどで少しふくらみ上へ細くなる。各面の中央に縦の白い筋、
 *   頂部は面の中央が下がる波形。青いガラスに階ごとの横の線。足元に低層部と屋上の緑
 * - レジデンス：角を丸めた長方形の白い高層棟（階ごとのバルコニーの白い帯）。B は高く、上の方で片側が一段下がる
 */
export interface AzabudaiParts {
  /** 森JPタワーのガラス（u = 周に沿った長さ / 3m、v = 高さ / 1階） */
  glass: THREE.BufferGeometry;
  /** レジデンスの外壁（u, v は同じ） */
  residence: THREE.BufferGeometry;
  /** 白い筋・縁・屋上 */
  white: THREE.BufferGeometry;
  /** 低層部 */
  podium: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
}

/** 1階の高さ (m)。外壁の画像はこの高さで1枚 */
export const FLOOR = 4.4;

export function buildMoriJpTower(cx: number): AzabudaiParts {
  const p = emptyParts();
  const H = 325;
  // 平面の半分の幅（高さ h）：足元 34m、中ほど（120m）で 36m、頂部で 30m
  const half = (h: number) =>
    h < 120 ? THREE.MathUtils.lerp(34, 36, h / 120) : THREE.MathUtils.lerp(36, 30, (h - 120) / (H - 120));
  // 頂部の波：各面の中央が下がる（角が高い）
  const crown = (a: number) => H - 6 * (0.5 + 0.5 * Math.cos(4 * a));
  p.glass.push(loft(cx, 22, H, half, 13, crown));
  // 各面の中央の縦の白い筋（角の向き a = 45° + 90°k の間 = 面の中央）
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    for (let h = 22; h < H - 6; h += 10) {
      const r0 = roundedSquare(a, half(h), 13) + 0.3;
      const r1 = roundedSquare(a, half(h + 10), 13) + 0.3;
      p.white.push(
        member(
          new THREE.Vector3(cx + Math.cos(a) * r0, h, -Math.sin(a) * r0),
          new THREE.Vector3(cx + Math.cos(a) * r1, Math.min(H - 6, h + 10), -Math.sin(a) * r1),
          0.9,
        ),
      );
    }
  }
  // 低層部（足元の広い建物）と屋上の緑
  p.podium.push(new THREE.BoxGeometry(110, 22, 104).translate(cx, 11, 0));
  p.green.push(new THREE.BoxGeometry(104, 0.6, 98).translate(cx, 22.3, 0));
  return finish(p);
}

export function buildAzabudaiResidences(cx: number): AzabudaiParts {
  const p = emptyParts();
  // レジデンスB（西寄り、高さ 237m）とレジデンスA（東寄り、高さ 196m）。長い向きは箱の短い向き（z）
  for (const { x, w, d, h, step } of [
    { x: 30, w: 34, d: 50, h: 237, step: true },
    { x: -30, w: 32, d: 44, h: 196, step: false },
  ]) {
    const shape = roundedRect(w, d, 7);
    const main = step ? h - 22 : h;
    p.residence.push(extrudeWalls(shape, cx + x, 0, main));
    p.white.push(cap(shape, cx + x, main));
    if (step) {
      // 上の方は片側だけ高い（写真の、頂部の一段下がった形）
      const top = roundedRect(w, d * 0.6, 7);
      const z = (d - d * 0.6) / 2;
      p.residence.push(extrudeWalls(top, cx + x, main, h, z));
      p.white.push(cap(top, cx + x, h, z));
    }
  }
  // 足元の低層部と屋上の緑
  p.podium.push(new THREE.BoxGeometry(112, 14, 70).translate(cx, 7, 0));
  p.green.push(new THREE.BoxGeometry(106, 0.6, 64).translate(cx, 14.3, 0));
  return finish(p);
}

function emptyParts(): Record<keyof AzabudaiParts, THREE.BufferGeometry[]> {
  return { glass: [], residence: [], white: [], podium: [], green: [] };
}

function finish(p: Record<keyof AzabudaiParts, THREE.BufferGeometry[]>): AzabudaiParts {
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
  return {
    glass: merge(p.glass),
    residence: merge(p.residence),
    white: merge(p.white),
    podium: merge(p.podium),
    green: merge(p.green),
  };
}

/** 角を半径 r で丸めた正方形（半分の幅 half）の、中心から角度 a の方向の境界までの距離 */
function roundedSquare(a: number, half: number, r: number): number {
  // 正方形の辺の向きにそろえた座標で、角の丸みの円との交点を求める
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const flat = half / Math.max(c, s);
  const x = flat * c;
  const y = flat * s;
  const inner = half - r;
  if (x <= inner || y <= inner) return flat;
  // 中心 (inner, inner)・半径 r の円との交点（原点から方向 (c, s)）
  const b = c * inner + s * inner;
  const disc = b * b - (2 * inner * inner - r * r);
  return b + Math.sqrt(Math.max(0, disc));
}

/**
 * 高さ y0〜y1 の、半分の幅 half(h) の角の丸い正方形を積んだ外壁（上の縁は top(a) の高さ）と、上のふた。
 * u = 周に沿った長さ / 3m、v = 高さ / FLOOR
 */
function loft(
  cx: number,
  y0: number,
  y1: number,
  half: (h: number) => number,
  r: number,
  top: (a: number) => number,
): THREE.BufferGeometry {
  const N = 96;
  const rows: number[] = [];
  for (let h = y0; h < y1 - 10; h += 10) rows.push(h);
  const pos: number[] = [];
  const uv: number[] = [];
  const ring = (h: number, j: number, yOverride?: number) => {
    const a = (j / N) * Math.PI * 2;
    const rr = roundedSquare(a, half(h), r);
    return [cx + Math.cos(a) * rr, yOverride ?? h, -Math.sin(a) * rr] as const;
  };
  const perimeter = (h: number) => {
    let s = 0;
    for (let j = 0; j < N; j++) {
      const p = ring(h, j);
      const q = ring(h, j + 1);
      s += Math.hypot(q[0] - p[0], q[2] - p[2]);
    }
    return s;
  };
  const push = (p: readonly [number, number, number], u: number) => {
    pos.push(...p);
    uv.push(u, p[1] / FLOOR);
  };
  const levels = [...rows, -1];
  for (let i = 0; i < levels.length - 1; i++) {
    const h0 = levels[i];
    const last = levels[i + 1] === -1;
    const h1 = last ? y1 : levels[i + 1];
    const per = perimeter(h0) / N / 3;
    for (let j = 0; j < N; j++) {
      const a1 = ((j + 1) / N) * Math.PI * 2;
      const a0 = (j / N) * Math.PI * 2;
      const p00 = ring(h0, j);
      const p01 = ring(h0, j + 1);
      const p10 = ring(h1, j, last ? top(a0) : undefined);
      const p11 = ring(h1, j + 1, last ? top(a1) : undefined);
      push(p00, j * per);
      push(p01, (j + 1) * per);
      push(p11, (j + 1) * per);
      push(p00, j * per);
      push(p11, (j + 1) * per);
      push(p10, j * per);
    }
  }
  // ふた（中心から上の縁へ）
  const cTop = Math.min(...Array.from({ length: N }, (_, j) => top((j / N) * Math.PI * 2))) - 1;
  for (let j = 0; j < N; j++) {
    const a0 = (j / N) * Math.PI * 2;
    const a1 = ((j + 1) / N) * Math.PI * 2;
    push([cx, cTop, 0], 0);
    push(ring(y1, j, top(a0)), 0);
    push(ring(y1, j + 1, top(a1)), 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 角を丸めた長方形（中心が原点、x・y の平面） */
function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** 形の外壁（高さ y0〜y1、中心 (x, z)）。u = 周に沿った長さ / 3m、v = 高さ / FLOOR */
function extrudeWalls(shape: THREE.Shape, x: number, y0: number, y1: number, z = 0): THREE.BufferGeometry {
  const pts = shape.getPoints(6);
  const pos: number[] = [];
  const uv: number[] = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = a.distanceTo(b);
    const u0 = s / 3;
    const u1 = (s + len) / 3;
    s += len;
    const P = (p: THREE.Vector2, y: number) => [x + p.x, y, z + p.y];
    pos.push(...P(a, y0), ...P(b, y0), ...P(b, y1), ...P(a, y0), ...P(b, y1), ...P(a, y1));
    uv.push(u0, y0 / FLOOR, u1, y0 / FLOOR, u1, y1 / FLOOR, u0, y0 / FLOOR, u1, y1 / FLOOR, u0, y1 / FLOOR);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 屋上のふた（形の上面、厚み 1.5m） */
function cap(shape: THREE.Shape, x: number, y: number, z = 0): THREE.BufferGeometry {
  return new THREE.ExtrudeGeometry(shape, { depth: 1.5, bevelEnabled: false, curveSegments: 6 })
    .rotateX(Math.PI / 2)
    .translate(x, y + 1.5, z);
}

/** a から b への細い板（幅 t） */
function member(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(t, a.distanceTo(b), t);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

/** 外壁の画像：1枚 = 幅 3m × 1階。ガラス（森JPタワー）は青いガラスに細い横の線と縦の桟 */
export function createGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial((g, W, H) => {
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#5f86a8');
    grad.addColorStop(1, '#3f6688');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#c9d3dc';
    g.fillRect(0, H - 6, W, 6);
    g.fillStyle = 'rgba(210,220,230,0.6)';
    g.fillRect(0, 0, 2, H);
  }, 0.15, 0.5);
}

/** レジデンスの外壁：白いバルコニーの帯と、奥の暗いガラス */
export function createResidenceMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial((g, W, H) => {
    g.fillStyle = '#4c5866';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#e9ecee';
    g.fillRect(0, H * 0.62, W, H * 0.38);
    g.fillStyle = 'rgba(160,170,180,0.8)';
    g.fillRect(0, H * 0.62, W, 3);
    g.fillStyle = '#d5dade';
    g.fillRect(0, 0, 3, H * 0.62);
  }, 0.55, 0.1);
}

function facadeMaterial(
  draw: (g: CanvasRenderingContext2D, W: number, H: number) => void,
  roughness: number,
  metalness: number,
): THREE.MeshStandardMaterial {
  const W = 64;
  const H = 96;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  draw(canvas.getContext('2d')!, W, H);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness, metalness, side: THREE.DoubleSide });
}
