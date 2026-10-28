import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, cap, extrudeWalls, facadeMaterial, roundedRect } from './azabudaiHills';

/**
 * 虎ノ門ヒルズの4棟。航空写真と公開されている高さを参考に、手続き的に形を作る。
 * 座標は建物ごと：中心が (cx, 0, 0)、x = 街区の長い向き（北北西へ +）、z = それに直角、y = 上。
 *
 * - 森タワー（2014年、247m）：角を丸めた平面の青緑のガラスの塔。上へ行くほど奥行きが細くなり、長い面には
 *   足元の中央から上の両角へ走る斜めの白い折れ線。頂部は両端が高い弧の屋根。足元に緑のガラスの縦長の箱と、
 *   オーバル広場の上へ張り出す白い縁の楕円の庇
 * - ビジネスタワー（2020年、185m）：角を落とした四角いガラスの塔。片側に緑の段々の低層部
 * - レジデンシャルタワー（2022年、220m）：暗い灰色の縦の筋の四角い塔
 * - ステーションタワー（2023年、266m）：四隅を切り欠いた十字形の平面が上へ細くなる、白い縦のフィンの多い銀青色の
 *   ガラスの塔。頂部は段違いの塔屋。足元はガラスの低層部と、その上を巻いて南へ張り出す白い帯（門の形）
 */
export interface ToranomonParts {
  /** 森タワーの明るい銀色がかったガラス */
  mori: THREE.BufferGeometry;
  /** ビジネスタワー・ステーションタワーの青灰色のガラス */
  glass: THREE.BufferGeometry;
  /** レジデンシャルタワーの暗い外壁 */
  dark: THREE.BufferGeometry;
  /** 森タワーの足元の緑のガラスの箱 */
  accent: THREE.BufferGeometry;
  /** ステーションタワーの、白い縦のフィンの多い銀青色のガラス */
  station: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
}

type Lists = Record<keyof ToranomonParts, THREE.BufferGeometry[]>;
const empty = (): Lists => ({ mori: [], glass: [], dark: [], accent: [], station: [], white: [], podium: [], green: [] });

export function buildToranomonMori(cx: number): ToranomonParts {
  const p = empty();
  const H = 247;
  const Y0 = 12;
  // 平面：x の向きに長い、角を丸めた長方形。上へ行くほど奥行きが細くなる（横から見ると先細り）
  const w = (h: number) => THREE.MathUtils.lerp(60, 56, h / H);
  const d = (h: number) => THREE.MathUtils.lerp(42, 28, h / H);
  // 頂部：両端が高く中央が下がる、ゆるい弧の屋根
  const top = (x: number, wTop: number) => H - 12 + 12 * ((2 * x) / wTop) ** 2;
  p.mori.push(loftRounded(cx, Y0, H, w, d, 10, top));
  // 頂部の縁の白い帯
  for (let j = 0; j < 40; j++) {
    const x0 = -w(H) / 2 + (w(H) * j) / 40;
    const x1 = -w(H) / 2 + (w(H) * (j + 1)) / 40;
    for (const side of [1, -1]) {
      p.white.push(
        member(
          new THREE.Vector3(cx + x0, top(x0, w(H)) + 0.5, (side * d(H)) / 2),
          new THREE.Vector3(cx + x1, top(x1, w(H)) + 0.5, (side * d(H)) / 2),
          1.2,
        ),
      );
    }
  }
  // 長い面の斜めの白い折れ線：足元の中央から、上の両角へ（面が折れて先細る形）
  for (const side of [1, -1]) {
    for (const sx of [1, -1]) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 12; k++) {
        const h = THREE.MathUtils.lerp(Y0 + 18, H - 14, k / 12);
        const x = sx * THREE.MathUtils.lerp(2, w(h) / 2 - 6, (k / 12) ** 1.3);
        pts.push(new THREE.Vector3(cx + x, h, side * (d(h) / 2 + 0.3)));
      }
      for (let k = 1; k < pts.length; k++) p.white.push(member(pts[k - 1], pts[k], 0.7));
    }
  }
  // 正面の足元：縦長の緑のガラスの箱（エレベーターホール、高さ約 60m）
  p.accent.push(new THREE.BoxGeometry(14, 60, 6).translate(cx - 16, Y0 + 30, d(Y0 + 30) / 2 + 2));
  // 足元の大きな楕円の庇：白い縁と、灰色のガラスの屋根（裏側のオーバル広場の上へ張り出す）
  const canopy = new THREE.Shape();
  canopy.absellipse(0, 0, 40, 26, 0, Math.PI * 2, false, 0);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, 37, 23, 0, Math.PI * 2, false, 0);
  const rim = new THREE.Shape(canopy.getPoints(64));
  rim.holes.push(new THREE.Path(hole.getPoints(64)));
  p.white.push(
    new THREE.ExtrudeGeometry(rim, { depth: 2.2, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(cx + 4, Y0 + 2, -d(Y0) / 2 - 12),
  );
  p.mori.push(
    new THREE.ExtrudeGeometry(new THREE.Shape(hole.getPoints(64)), { depth: 0.6, bevelEnabled: false })
      .rotateX(-Math.PI / 2)
      .translate(cx + 4, Y0 + 3, -d(Y0) / 2 - 12),
  );
  // 低層部（オーバル広場の下の建物）と、まわりの緑
  p.podium.push(new THREE.BoxGeometry(70, Y0, 50).translate(cx, Y0 / 2, 0));
  p.green.push(new THREE.CylinderGeometry(1, 1, 0.6, 48).scale(46, 1, 30).translate(cx + 4, Y0 - 2, -d(Y0) / 2 - 18));
  return finish(p);
}

export function buildToranomonBusiness(cx: number): ToranomonParts {
  const p = empty();
  const H = 185;
  const shape = roundedRect(58, 52, 3);
  p.glass.push(extrudeWalls(shape, cx, 0, H));
  p.white.push(cap(shape, cx, H));
  // 西側の緑の段々の低層部（4段、下ほど広い）
  for (let k = 0; k < 4; k++) {
    const w = 30 - k * 6;
    p.podium.push(new THREE.BoxGeometry(64, 8, w).translate(cx, 4 + k * 8, -26 - w / 2));
    p.green.push(new THREE.BoxGeometry(62, 0.6, 5).translate(cx, 8.3 + k * 8, -26 - w + 2.5));
  }
  return finish(p);
}

export function buildToranomonResidential(cx: number): ToranomonParts {
  const p = empty();
  const H = 220;
  const shape = roundedRect(50, 48, 6);
  p.dark.push(extrudeWalls(shape, cx, 0, H));
  p.white.push(cap(shape, cx, H));
  // 頂部の少し細い塔屋
  const top = roundedRect(38, 36, 5);
  p.dark.push(extrudeWalls(top, cx, H, H + 6));
  p.white.push(cap(top, cx, H + 6));
  p.podium.push(new THREE.BoxGeometry(62, 10, 60).translate(cx, 5, 0));
  return finish(p);
}

export function buildToranomonStation(cx: number): ToranomonParts {
  const p = empty();
  const H = 266;
  const BASE = 52;
  // 塔：四隅を切り欠いた十字形の平面（70×58m、切り欠き 7m）が、上へ向かって細くなる（頂部で 0.68 倍）
  const plan = notchedRect(70, 58, 7);
  const scale = (h: number) => THREE.MathUtils.lerp(1, 0.68, (h - BASE) / (H - BASE));
  p.station.push(loftPolygon(cx, 0, BASE, H - 14, plan, scale));
  p.white.push(capPolygon(cx, H - 14, plan, scale(H - 14)));
  // 頂部：一回り細い塔屋が片側に寄って 14m 突き出る（写真の、段違いの頂部）
  const crown = notchedRect(40, 40, 5).map((q) => new THREE.Vector2(q.x + 6, q.y));
  p.station.push(loftPolygon(cx, 0, H - 14, H, crown, (h) => scale(h) / scale(H - 14)));
  p.white.push(capPolygon(cx, H, crown, scale(H) / scale(H - 14)));
  // 足元：ガラスの低層部（0〜40m）と、その上の白い帯の張り出し（40〜52m）。南側へ 16m 張り出して門の形をつくる
  p.station.push(extrudeWalls(roundedRect(84, 66, 2), cx, 0, 40));
  p.white.push(new THREE.BoxGeometry(92, 12, 74).translate(cx, 46, 8));
  p.white.push(new THREE.BoxGeometry(30, 12, 18).translate(cx - 18, 46, 52));
  p.podium.push(new THREE.BoxGeometry(30, 0.4, 18).translate(cx - 18, 39.8, 52));
  // 低層部の階段状の緑（正面の大階段）
  for (let k = 0; k < 4; k++) p.green.push(new THREE.BoxGeometry(20, 3, 6).translate(cx + 30, 1.5 + k * 3, 36 + k * 5));
  return finish(p);
}

/** 四隅を n m 切り欠いた長方形（中心が原点）の点（反時計回り） */
function notchedRect(w: number, d: number, n: number): THREE.Vector2[] {
  const x = w / 2;
  const y = d / 2;
  return [
    [x, -y + n],
    [x, y - n],
    [x - n, y - n],
    [x - n, y],
    [-x + n, y],
    [-x + n, y - n],
    [-x, y - n],
    [-x, -y + n],
    [-x + n, -y + n],
    [-x + n, -y],
    [x - n, -y],
    [x - n, -y + n],
  ].map(([a, b]) => new THREE.Vector2(a, b));
}

/** 平面 pts を、高さ h で scale(h) 倍にしながら y0〜y1 に積んだ外壁（BASE までは等倍）。u = 周の長さ / 3m、v = 高さ / FLOOR */
function loftPolygon(
  cx: number,
  base: number,
  y0: number,
  y1: number,
  pts: THREE.Vector2[],
  scale: (h: number) => number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const rows: number[] = [];
  for (let h = y0; h < y1; h += 12) rows.push(h);
  rows.push(y1);
  const k = (h: number) => (h <= base ? 1 : scale(h));
  for (let i = 1; i < rows.length; i++) {
    const h0 = rows[i - 1];
    const h1 = rows[i];
    let s = 0;
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j];
      const b = pts[(j + 1) % pts.length];
      const len = a.distanceTo(b) * k(h0);
      const u0 = s / 3;
      const u1 = (s + len) / 3;
      s += len;
      const P = (q: THREE.Vector2, h: number) => [cx + q.x * k(h), h, q.y * k(h)];
      pos.push(...P(a, h0), ...P(b, h0), ...P(b, h1), ...P(a, h0), ...P(b, h1), ...P(a, h1));
      uv.push(u0, h0 / FLOOR, u1, h0 / FLOOR, u1, h1 / FLOOR, u0, h0 / FLOOR, u1, h1 / FLOOR, u0, h1 / FLOOR);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 平面 pts（scale 倍）の上のふた（厚み 1.5m） */
function capPolygon(cx: number, y: number, pts: THREE.Vector2[], scale: number): THREE.BufferGeometry {
  return new THREE.ExtrudeGeometry(new THREE.Shape(pts.map((q) => q.clone().multiplyScalar(scale))), {
    depth: 1.5,
    bevelEnabled: false,
  })
    .rotateX(Math.PI / 2)
    .translate(cx, y + 1.5, 0);
}

/**
 * 角を丸めた長方形の平面を、高さごとに幅 w(h)・奥行き d(h) で積んだ外壁と、上のふた（上の縁の高さ top(x, w)）。
 * u = 周に沿った長さ / 3m、v = 高さ / FLOOR
 */
export function loftRounded(
  cx: number,
  y0: number,
  y1: number,
  w: (h: number) => number,
  d: (h: number) => number,
  r: number,
  top: (x: number, w: number) => number,
): THREE.BufferGeometry {
  const ringAt = (h: number) => roundedRect(w(h), d(h), r).getPoints(6);
  const rows: number[] = [];
  for (let h = y0; h < y1 - 10; h += 10) rows.push(h);
  rows.push(y1);
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, u: number) => {
    pos.push(cx + x, y, z);
    uv.push(u, y / FLOOR);
  };
  for (let i = 1; i < rows.length; i++) {
    const a = ringAt(rows[i - 1]);
    const b = ringAt(rows[i]);
    const last = i === rows.length - 1;
    let s = 0;
    for (let j = 0; j < a.length - 1; j++) {
      const len = a[j].distanceTo(a[j + 1]);
      const u0 = s / 3;
      const u1 = (s + len) / 3;
      s += len;
      const yb = rows[i - 1];
      const yt0 = last ? top(b[j].x, w(y1)) : rows[i];
      const yt1 = last ? top(b[j + 1].x, w(y1)) : rows[i];
      push(a[j].x, yb, a[j].y, u0);
      push(a[j + 1].x, yb, a[j + 1].y, u1);
      push(b[j + 1].x, yt1, b[j + 1].y, u1);
      push(a[j].x, yb, a[j].y, u0);
      push(b[j + 1].x, yt1, b[j + 1].y, u1);
      push(b[j].x, yt0, b[j].y, u0);
    }
  }
  // ふた
  const b = ringAt(y1);
  const peak = Math.min(...b.map((q) => top(q.x, w(y1)))) - 0.5;
  for (let j = 0; j < b.length - 1; j++) {
    push(0, peak, 0, 0);
    push(b[j].x, top(b[j].x, w(y1)), b[j].y, 0);
    push(b[j + 1].x, top(b[j + 1].x, w(y1)), b[j + 1].y, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function finish(p: Lists): ToranomonParts {
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
    mori: merge(p.mori),
    glass: merge(p.glass),
    dark: merge(p.dark),
    accent: merge(p.accent),
    station: merge(p.station),
    white: merge(p.white),
    podium: merge(p.podium),
    green: merge(p.green),
  };
}

/** 森タワー：明るい銀色がかった水色のガラスに、細い縦の桟と階ごとの線 */
export function createMoriGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#6f909f');
      grad.addColorStop(1, '#88a8b4');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#dfe6eb';
      g.fillRect(0, 0, 3, H);
      g.fillRect(W / 2, 0, 2, H);
      g.fillStyle = 'rgba(220,228,234,0.7)';
      g.fillRect(0, H - 3, W, 3);
    },
    0.12,
    0.55,
  );
}

/** ビジネスタワー・ステーションタワー：青灰色のガラスに、はっきりした縦の桟 */
export function createBlueGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#4d6478';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#9aa9b6';
      g.fillRect(0, 0, 4, H);
      g.fillStyle = 'rgba(160,175,188,0.8)';
      g.fillRect(0, H - 5, W, 5);
    },
    0.18,
    0.5,
  );
}

/** レジデンシャルタワー：暗い灰色の縦の筋と、奥の暗いガラス */
export function createDarkFacadeMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#2f343a';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#5d636a';
      g.fillRect(0, 0, 8, H);
      g.fillRect(W / 2, 0, 5, H);
      g.fillStyle = 'rgba(120,126,132,0.8)';
      g.fillRect(0, H - 4, W, 4);
    },
    0.5,
    0.2,
  );
}

/** a から b への細い板（幅 t） */
export function member(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(t, a.distanceTo(b), t);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

/** ステーションタワー：銀色がかった青のガラスに、細かい白い縦のフィン（1枚 = 3m に 3本） */
export function createStationGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#6f8fae');
      grad.addColorStop(1, '#5b7c9c');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#e4e9ee';
      for (let k = 0; k < 3; k++) g.fillRect((k * W) / 3, 0, 4, H);
      g.fillStyle = 'rgba(210,220,230,0.8)';
      g.fillRect(0, H - 4, W, 4);
    },
    0.15,
    0.5,
  );
}
