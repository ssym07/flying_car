import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 東京都庁舎（1991年）：第一本庁舎（243m）、第二本庁舎（163m）、都議会議事堂（41m）と都民広場。写真を参考に作る。
 * 座標：基準点（緯度 35.6896, 経度 139.6917）が (cx, 0, 0)、x = 東へ +、z = 南へ +、y = 上。
 * 各庁舎は、自分の座標（u = 長い向き（ほぼ南北）、w = 正面（東、都民広場の側）へ +）で作って回して置く。
 *
 * - 第一本庁舎：下は全体の四角い箱。上は南北の2本の塔（ツインタワー）に分かれ、間の中央部は低い。
 *   塔は段々に細くなり、頂部（202〜243m）は四隅の柱の間を大きくくり抜いた冠（中は暗い）。南の塔にアンテナ
 * - 第二本庁舎：下は全体の箱。上は東西に2つの塔が段々に下がる形
 * - 都議会議事堂：東側の7階の箱と、ドーム。都民広場：議事堂の前の半円の広場を、柱廊の建物が囲む
 * 外壁は灰色の石に、細かい格子の窓
 */
export interface MetroGovParts {
  stone: THREE.BufferGeometry;
  /** 冠のくり抜きの奥・柱廊の奥の暗い面 */
  dark: THREE.BufferGeometry;
  /** 議事堂のドームのガラス */
  glass: THREE.BufferGeometry;
  /** 広場の舗装 */
  paving: THREE.BufferGeometry;
  /** アンテナ（赤と白） */
  antenna: THREE.BufferGeometry;
}

type Lists = Record<keyof MetroGovParts, THREE.BufferGeometry[]>;

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

/** 四隅を n m 切り欠いた（十字形の）箱：中央の2つの箱を重ねる */
function notched(L: Lists, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n: number): void {
  L.stone.push(box(x0 + n, x1 - n, y0, y1, z0, z1));
  L.stone.push(box(x0, x1, y0, y1, z0 + n, z1 - n));
}

function buildFirst(L: Lists): void {
  // u = 南北（北が +）、w = 東（正面）が +。全体 115×48m
  notched(L, -57.5, 57.5, 0, 40, -24, 24, 3);
  // 中央部（低い）
  L.stone.push(box(-16, 16, 40, 138, -20, 20));
  for (const s of [-1, 1]) {
    const c = s * 36.5; // 塔の中心
    // 塔の下（〜160m）、段（160〜202m）、冠（202〜243m）。上へはほとんど細くしない
    notched(L, c - 21, c + 21, 40, 160, -24, 24, 4);
    notched(L, c - 20, c + 20, 160, 182, -23, 23, 4.5);
    notched(L, c - 19.5, c + 19.5, 182, 202, -22.5, 22.5, 4.5);
    // 冠：四隅の柱と、上の梁。面の中央を大きくくり抜く（奥は暗い）
    const hw = 19;
    const hd = 22;
    const p = 7;
    for (const [su, sw] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      L.stone.push(box(c + su * hw - (su > 0 ? p : 0), c + su * hw + (su < 0 ? p : 0), 202, 243, sw * hd - (sw > 0 ? p : 0), sw * hd + (sw < 0 ? p : 0)));
    }
    L.stone.push(box(c - hw, c + hw, 236, 243, -hd, hd));
    L.dark.push(box(c - hw + 3, c + hw - 3, 202, 236, -hd + 3, hd - 3));
    // 冠の中の丸い塔（アンテナの台）
    L.stone.push(new THREE.CylinderGeometry(7, 7, 34, 16).translate(c, 219, 0));
  }
  // 南の塔のアンテナ（赤と白の帯）
  for (let k = 0; k < 4; k++) {
    L.antenna.push(new THREE.CylinderGeometry(0.7, 0.9, 3, 8).translate(-36.5 - 8, 244.5 + k * 3, -10));
  }
}

function buildSecond(L: Lists): void {
  // 全体 107×49m。u = 南北、w = 東が +
  notched(L, -53.5, 53.5, 0, 100, -24.5, 24.5, 3);
  // 北の塔（高い）：段々に下がる
  notched(L, -2, 53.5, 100, 125, -22, 22, 4);
  notched(L, 4, 50, 125, 145, -19, 19, 4);
  notched(L, 10, 46, 145, 163, -16, 16, 4);
  // 南の塔（低い）
  notched(L, -53.5, -2, 100, 118, -22, 22, 4);
  notched(L, -48, -8, 118, 135, -18, 18, 4);
}

/** 都議会議事堂と都民広場（敷地の座標：東・北, m） */
function buildAssembly(L: Lists, cx: number): void {
  const P = (e: number, n: number) => [cx + e, -n] as const;
  // 議事堂（東側の7階の箱）とドーム
  const [ax, az] = P(142, 10);
  L.stone.push(box(ax - 24, ax + 24, 0, 41, az - 66, az + 66));
  L.stone.push(new THREE.CylinderGeometry(22, 22, 8, 32).translate(ax, 45, az + 30));
  L.glass.push(new THREE.SphereGeometry(20, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1).translate(ax, 49, az + 30));
  // 都民広場：中心 (75, 0)、半径 50 の東向きの半円の床と、まわりを囲む柱廊（高さ 16m、奥行き 9m）
  const [px, pz] = P(75, 0);
  L.paving.push(new THREE.CylinderGeometry(50, 50, 0.6, 48, 1, false, 0, Math.PI).rotateY(-Math.PI / 2).translate(px, 0.3, pz));
  L.paving.push(box(px - 90, px, 0, 0.6, pz - 50, pz + 50));
  const N = 18;
  for (let k = 0; k < N; k++) {
    const a0 = -Math.PI / 2 + (k / N) * Math.PI;
    const a1 = -Math.PI / 2 + ((k + 1) / N) * Math.PI;
    const am = (a0 + a1) / 2;
    const len = 2 * 54 * Math.sin((a1 - a0) / 2) + 0.5;
    const g = box(-len / 2, len / 2, 0, 16, 0, 9).rotateY(-am + Math.PI / 2);
    const r = 50;
    L.stone.push(g.translate(px + Math.cos(am) * r, 0, pz - Math.sin(am) * r));
    // 柱廊の奥の暗い面（柱の間）
    L.dark.push(box(-len / 2 + 0.6, len / 2 - 0.6, 0.6, 7, -0.3, 0.2).rotateY(-am + Math.PI / 2).translate(px + Math.cos(am) * (r - 0.1), 0, pz - Math.sin(am) * (r - 0.1)));
  }
  // 南北の腕（第一本庁舎の方へ延びる柱廊）
  for (const s of [-1, 1]) {
    L.stone.push(box(px - 95, px, 0, 16, pz - s * 50 - (s > 0 ? 9 : 0), pz - s * 50 + (s < 0 ? 9 : 0)));
  }
}

export function buildMetroGov(cx: number): MetroGovParts {
  const L: Lists = { stone: [], dark: [], glass: [], paving: [], antenna: [] };
  /** 庁舎を、中心（東・北）と長い向き（東から北へ、度）で置く */
  const place = (build: (l: Lists) => void, e: number, n: number, deg: number) => {
    const sub: Lists = { stone: [], dark: [], glass: [], paving: [], antenna: [] };
    build(sub);
    const a = (deg * Math.PI) / 180;
    for (const k of Object.keys(sub) as Array<keyof MetroGovParts>) {
      for (const g of sub[k]) L[k].push(g.rotateY(a).translate(cx + e, 0, -n));
    }
  };
  place(buildFirst, 1.8, -11, 101);
  place(buildSecond, 34.4, -173.7, 102);
  buildAssembly(L, cx);

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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as MetroGovParts;
}

/** 灰色の石に、細かい格子の窓（窓との明暗の差は控えめ）（1枚 = 3m × 1階、窓は 2 つ） */
export function createMetroGovStoneMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, Hp) => {
      g.fillStyle = '#8f8d89';
      g.fillRect(0, 0, W, Hp);
      g.fillStyle = '#5e6670';
      for (const x of [0.1, 0.55]) g.fillRect(W * x, Hp * 0.28, W * 0.32, Hp * 0.5);
      g.fillStyle = 'rgba(90,80,70,0.35)';
      g.fillRect(0, Hp - 4, W, 4);
      g.fillRect(W * 0.47, 0, 3, Hp);
    },
    0.7,
    0.05,
  );
}
