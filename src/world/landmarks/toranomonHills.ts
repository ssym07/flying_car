import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, cap, extrudeWalls, facadeMaterial, roundedRect } from './azabudaiHills';

/**
 * 虎ノ門ヒルズの4棟。航空写真と公開されている高さを参考に、手続き的に形を作る。
 * 座標は建物ごと：中心が (cx, 0, 0)、x = 街区の長い向き（北北西へ +）、z = それに直角、y = 上。
 *
 * - 森タワー（2014年、247m）：足元が細く上が広い、角を丸めた平面のガラスの塔。頂部は中央が高い弧。
 *   足元に楕円の広場（オーバル広場）の低層部と屋上の緑
 * - ビジネスタワー（2020年、185m）：角を落とした四角いガラスの塔。片側に緑の段々の低層部
 * - レジデンシャルタワー（2022年、220m）：暗い灰色の縦の筋の四角い塔
 * - ステーションタワー（2023年、266m）：ガラスの塔の頂部に、四隅の柱だけ残した吹き抜け（TOKYO NODE）
 */
export interface ToranomonParts {
  /** 森タワーの明るい銀色がかったガラス */
  mori: THREE.BufferGeometry;
  /** ビジネスタワー・ステーションタワーの青灰色のガラス */
  glass: THREE.BufferGeometry;
  /** レジデンシャルタワーの暗い外壁 */
  dark: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
}

type Lists = Record<keyof ToranomonParts, THREE.BufferGeometry[]>;
const empty = (): Lists => ({ mori: [], glass: [], dark: [], white: [], podium: [], green: [] });

export function buildToranomonMori(cx: number): ToranomonParts {
  const p = empty();
  const H = 247;
  // 平面：x の向きに長い、角を丸めた長方形。足元 56×32m から頂部 66×42m へ広がる
  p.mori.push(
    loftRounded(cx, 12, H, (h) => THREE.MathUtils.lerp(56, 66, h / H), (h) => THREE.MathUtils.lerp(32, 42, h / H), 12, (x, w) =>
      H - 10 + 10 * Math.cos((Math.PI * x) / w),
    ),
  );
  // 足元：楕円の広場の低層部と、屋上の緑
  p.podium.push(new THREE.CylinderGeometry(1, 1, 12, 48).scale(70, 1, 48).translate(cx, 6, 0));
  p.green.push(new THREE.CylinderGeometry(1, 1, 0.6, 48).scale(66, 1, 44).translate(cx, 12.3, 0));
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
  const W = 70;
  const D = 56;
  const body = H - 22;
  const shape = roundedRect(W, D, 4);
  p.glass.push(extrudeWalls(shape, cx, 0, body));
  p.white.push(cap(shape, cx, body));
  // 頂部の吹き抜け：四隅の柱と、上の縁の梁（ガラスの帯）
  for (const [sx, sz] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    p.glass.push(extrudeWalls(roundedRect(14, 12, 2), cx + sx * (W / 2 - 7), body, H - 4, sz * (D / 2 - 6)));
  }
  const ring = new THREE.Shape(shape.getPoints(6));
  ring.holes.push(new THREE.Path(roundedRect(W - 12, D - 12, 2).getPoints(6)));
  p.glass.push(
    new THREE.ExtrudeGeometry(ring, { depth: 4, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(cx, H - 4, 0),
  );
  p.green.push(new THREE.BoxGeometry(W - 14, 0.6, D - 14).translate(cx, body + 1.8, 0));
  // 足元の低層部（駅前広場側に張り出す）
  p.podium.push(new THREE.BoxGeometry(W + 30, 20, D + 16).translate(cx, 10, 0));
  return finish(p);
}

/**
 * 角を丸めた長方形の平面を、高さごとに幅 w(h)・奥行き d(h) で積んだ外壁と、上のふた（上の縁の高さ top(x, w)）。
 * u = 周に沿った長さ / 3m、v = 高さ / FLOOR
 */
function loftRounded(
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
      grad.addColorStop(0, '#8fa9bd');
      grad.addColorStop(1, '#a9bfcf');
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
