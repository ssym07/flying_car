import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeMaterial } from './azabudaiHills';

/**
 * 国立競技場（2019年、47.4m）。写真を参考に作る。
 * 座標：中心が (cx, 0, 0)、x = 楕円の長い向き（北北東）、z = それに直角、y = 上。平面はどこも楕円（半径 a × b）。
 *
 * - 屋根：楕円の白い屋根（外周 350m × 260m）。内側の縁はガラスの帯で、真ん中は開いている。外周の縁は木の羽目板の庇
 * - 外観：3段の木の軒（ひさし）が重なり、軒の上に植え込み。軒の間はガラスの壁と白い柱
 * - 軒から屋根へ、白い柱が斜めに立ち上がる（V 字と斜めの支え）
 * - 中：すり鉢の観客席（3段）、陸上のトラック（赤茶）と芝のフィールド
 */
export interface StadiumParts {
  /** 木の羽目板（u = m、v = m） */
  wood: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  roofGlass: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  seats: THREE.BufferGeometry;
  track: THREE.BufferGeometry;
  field: THREE.BufferGeometry;
}

const SEG = 128;

/**
 * 楕円 (a0, b0) の高さ y0 から、楕円 (a1, b1) の高さ y1 までをつなぐ帯の面（壁・水平の輪・すり鉢）。
 * uv：u = 周りに沿った長さ (m)、v = 帯に沿った長さ (m)
 */
function band(cx: number, a0: number, b0: number, y0: number, a1: number, b1: number, y1: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let around = 0;
  const across = Math.hypot((a0 + b0) / 2 - (a1 + b1) / 2, y1 - y0);
  for (let k = 0; k <= SEG; k++) {
    const t = (k / SEG) * Math.PI * 2;
    if (k > 0) {
      const tp = ((k - 1) / SEG) * Math.PI * 2;
      around += Math.hypot(a0 * (Math.cos(t) - Math.cos(tp)), b0 * (Math.sin(t) - Math.sin(tp)));
    }
    pos.push(cx + a0 * Math.cos(t), y0, b0 * Math.sin(t), cx + a1 * Math.cos(t), y1, b1 * Math.sin(t));
    uv.push(around, 0, around, across);
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

/** 平らな楕円の板（高さ y） */
function disc(cx: number, a: number, b: number, y: number): THREE.BufferGeometry {
  return new THREE.CircleGeometry(1, SEG).rotateX(-Math.PI / 2).scale(a, 1, b).translate(cx, y, 0);
}

/** 2点を結ぶ太さ r の柱 */
function strut(from: THREE.Vector3, to: THREE.Vector3, r: number): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(to, from);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 6);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  return g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
}

export function buildNationalStadium(cx: number): StadiumParts {
  const P: Record<keyof StadiumParts, THREE.BufferGeometry[]> = {
    wood: [],
    roof: [],
    roofGlass: [],
    white: [],
    glass: [],
    green: [],
    seats: [],
    track: [],
    field: [],
  };
  const at = (a: number, b: number, t: number, y: number) =>
    new THREE.Vector3(cx + a * Math.cos(t), y, b * Math.sin(t));

  // ---- 1階：ガラスの壁と白い柱 ----
  P.glass.push(band(cx, 150, 110, 0, 150, 110, 9));
  const COLS = 72;
  for (let k = 0; k < COLS; k++) {
    const t = (k / COLS) * Math.PI * 2;
    P.white.push(strut(at(153, 113, t, 0), at(153, 113, t, 9), 0.6));
  }

  // ---- 3段の木の軒（9・17・25m）。少しずつ外へ張り出し、上に植え込み。軒の間はガラスの壁 ----
  const EAVES: Array<[number, number, number]> = [
    // [高さ, 外周の a, b]
    [9, 160, 119],
    [17, 162, 121],
    [25, 164, 123],
  ];
  for (const [i, [y, a, b]] of EAVES.entries()) {
    // 軒の先の羽目板（高さ 2.2m）と、軒の裏・上の面
    P.wood.push(band(cx, a, b, y - 1.4, a, b, y + 0.8));
    P.wood.push(band(cx, 150, 110, y - 1.4, a, b, y - 1.4));
    P.roof.push(band(cx, a, b, y + 0.8, 150, 110, y + 0.8));
    // 軒の上の植え込み
    P.green.push(band(cx, a - 1.2, b - 1.2, y + 1.6, a - 1.2, b - 1.2, y + 0.8));
    P.green.push(band(cx, a - 3.4, b - 3.4, y + 1.6, a - 1.2, b - 1.2, y + 1.6));
    // 上の段までのガラスの壁（一番上の段の上は、屋根を支える柱の奥の通路の壁）
    const top = i < EAVES.length - 1 ? EAVES[i + 1][0] - 1.4 : 30;
    P.glass.push(band(cx, 148, 108, y + 0.8, 148, 108, top));
  }
  // 段の間の白い柱
  for (let k = 0; k < COLS; k++) {
    const t = (k / COLS) * Math.PI * 2;
    for (const [y0, y1] of [
      [10, 15.6],
      [18, 23.6],
    ]) {
      P.white.push(strut(at(156, 116, t, y0), at(156, 116, t, y1), 0.45));
    }
  }

  // ---- 屋根を支える白い柱：一番上の軒から屋根の縁の下へ（外へ傾いた柱と V 字の支え） ----
  const RAFTERS = 56;
  for (let k = 0; k < RAFTERS; k++) {
    const t = (k / RAFTERS) * Math.PI * 2;
    const tn = ((k + 0.5) / RAFTERS) * Math.PI * 2;
    P.white.push(strut(at(152, 112, t, 26), at(166, 124, t, 44.5), 0.75));
    // V 字：隣の柱との間に、根元から斜めに
    P.white.push(strut(at(152, 112, t, 27), at(160, 119, tn, 40), 0.4));
    P.white.push(strut(at(152, 112, tn + (Math.PI * 2) / RAFTERS / 2, 27), at(160, 119, tn, 40), 0.4));
  }
  // 屋根の下の白い梁の輪
  P.white.push(band(cx, 160, 119, 40, 160, 119, 41.2));

  // ---- 屋根：外周の庇（木の羽目板）、白い屋根面、内側のガラスの帯 ----
  P.wood.push(band(cx, 176, 132, 43.5, 176, 132, 47.2));
  P.wood.push(band(cx, 150, 110, 43.5, 176, 132, 43.5));
  P.roof.push(band(cx, 176, 132, 47.2, 128, 90, 49.4));
  P.roofGlass.push(band(cx, 128, 90, 49.4, 100, 66, 49.8));
  // 内側の縁（開口の縁）と、屋根の裏
  P.white.push(band(cx, 100, 66, 49.8, 100, 66, 48.2));
  P.wood.push(band(cx, 100, 66, 48.2, 150, 110, 43.6));

  // ---- 観客席：すり鉢の3段（段の間に通路の帯） ----
  const TIERS: Array<[number, number, number, number, number, number]> = [
    // [下の a, b, 高さ, 上の a, b, 高さ]
    [82, 52, 1.5, 112, 76, 13],
    [114, 78, 15, 132, 94, 27],
    [134, 96, 29, 148, 108, 42],
  ];
  for (const [a0, b0, y0, a1, b1, y1] of TIERS) {
    P.seats.push(band(cx, a1, b1, y1, a0, b0, y0));
    // 前の縁の手すり壁
    P.white.push(band(cx, a0, b0, y0, a0, b0, y0 - 1.3));
  }
  // 段の間の床（通路）
  P.roof.push(band(cx, 114, 78, 15, 112, 76, 13));
  P.roof.push(band(cx, 134, 96, 29, 132, 94, 27));

  // ---- フィールド：トラック（赤茶）と芝 ----
  P.track.push(disc(cx, 82, 52, 0.2));
  P.field.push(disc(cx, 62, 35, 0.3));

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
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as StadiumParts;
}

/** 木の羽目板：細い縦の板の並び（1枚 = 幅 1.2m × 高さ 1.2m） */
export function createStadiumWoodMaterial(): THREE.MeshStandardMaterial {
  const m = facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#5a3f2b';
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 4; i++) {
        g.fillStyle = i % 2 ? '#9a714c' : '#a77c55';
        g.fillRect((i * W) / 4 + 2, 0, W / 4 - 4, H);
      }
    },
    0.75,
    0,
  );
  m.map!.repeat.set(1 / 1.2, 1 / 1.2);
  return m;
}

/** 観客席：段ごとの座席の列（1枚 = 2m × 2m） */
export function createStadiumSeatMaterial(): THREE.MeshStandardMaterial {
  const m = facadeMaterial(
    (g, W, H) => {
      const colors = ['#6b5a46', '#8a7a5e', '#4e5b4a', '#a39a86', '#7c6a52'];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 6; c++) {
          g.fillStyle = colors[(r * 7 + c * 3) % colors.length];
          g.fillRect((c * W) / 6, (r * H) / 4, W / 6, H / 4);
        }
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(0, (r * H) / 4, W, 3);
      }
    },
    0.85,
    0,
  );
  m.map!.repeat.set(1 / 2, 1 / 2);
  return m;
}
