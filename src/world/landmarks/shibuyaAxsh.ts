import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cap, extrudeWalls, facadeMaterial, roundedRect } from './azabudaiHills';

/**
 * 渋谷アクシュ（2024年、120m・23階）。写真と OpenStreetMap の敷地の形を参考に作る。
 * 座標：敷地の基準点（緯度 35.6591, 経度 139.7045）が (cx, 0, 0)、x = 東へ +、z = 南へ +、y = 上。
 *
 * - 塔：敷地の南東の長い辺（明治通り側）にそろえた長方形（56×34m）
 * - 上半身（28〜120m）：暗い青のガラスに、白い斜めの格子（三角形の枠）
 * - 下半身（0〜28m）：銀色の縦のフィンのガラス。正面の中央に白い門の枠、
 *   10m と 22m の高さに斜めに折れた白い庇の帯
 * - ガーデン：塔の前から南の角（交差点）へ下りる段々の植え込みと木、木の大階段、芝生
 * - 歩道橋（明治通りをまたぐ、渋谷クロスタワーへの橋）：屋根付きの茶色い橋と、両端の六角形の東屋、
 *   アクシュ側で南北へ下りる階段と、クロスタワー側で南へ下りる階段。位置は OpenStreetMap の歩道橋の線
 */
export interface AxshParts {
  upper: THREE.BufferGeometry;
  lower: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  /** 下半身の奥の暗い壁 */
  dark: THREE.BufferGeometry;
  plant: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  trunk: THREE.BufferGeometry;
  /** 木の階段・デッキ */
  wood: THREE.BufferGeometry;
  /** 敷地の舗装 */
  paving: THREE.BufferGeometry;
  /** 歩道橋の床・手すり・柱（茶色） */
  bridge: THREE.BufferGeometry;
  /** 歩道橋の屋根・東屋の屋根（こげ茶） */
  bridgeRoof: THREE.BufferGeometry;
}

/** 塔の長い向き（東から北へ、度）と中心（東・北, m） */
const ANGLE = 54;
const CENTER: [number, number] = [6, 4];
const LEN = 56;
const DEP = 34;
const H = 120;
const SPLIT = 28;

/** 敷地の外形（東・北, m。OpenStreetMap の建物の形） */
const SITE: Array<[number, number]> = [
  [-31, 0.2],
  [-26.3, -9.2],
  [-7, -47.8],
  [53.7, 35.4],
  [44.8, 41.8],
  [40.3, 42.4],
  [7.1, 31.2],
  [-4.5, 27.3],
  [-29.8, 6.1],
];

export function buildShibuyaAxsh(cx: number): AxshParts {
  const L: Record<keyof AxshParts, THREE.BufferGeometry[]> = {
    upper: [],
    lower: [],
    white: [],
    dark: [],
    plant: [],
    leaves: [],
    trunk: [],
    wood: [],
    paving: [],
    bridge: [],
    bridgeRoof: [],
  };
  const a = (ANGLE * Math.PI) / 180;
  /** 塔の座標（u = 長い向き、w = 正面（南東）へ +）→ 東・北 */
  const tw = (u: number, w: number): [number, number] => [
    CENTER[0] + u * Math.cos(a) + w * Math.sin(a),
    CENTER[1] + u * Math.sin(a) - w * Math.cos(a),
  ];
  /** 塔の座標で作った形を、敷地の座標（x = 東、z = 南）へ置く */
  const place = (g: THREE.BufferGeometry, u = 0, w = 0) => {
    const [e, n] = tw(u, w);
    return g.rotateY(a).translate(cx + e, 0, -n);
  };

  // ---- 敷地の舗装（地面から少し上） ----
  const site = new THREE.Shape(SITE.map(([e, n]) => new THREE.Vector2(e, n)));
  L.paving.push(
    new THREE.ExtrudeGeometry(site, { depth: 0.4, bevelEnabled: false })
      .rotateX(-Math.PI / 2)
      .translate(cx, 0, 0),
  );

  // ---- 塔 ----
  const body = roundedRect(LEN, DEP, 0.5);
  // 下半身：少し奥まった暗い壁と、その外の銀色のフィンのガラス（正面の中央は門の形に空ける）
  L.dark.push(place(extrudeWalls(roundedRect(LEN - 3, DEP - 3, 0.5), 0, 0, SPLIT)));
  // 外の銀色のフィンのガラス（正面の中央の門の所だけ空ける：門の左右と、背面・両側面）
  const fin = (u0: number, u1: number, w0: number, w1: number) =>
    L.lower.push(place(extrudeWalls(roundedRect(u1 - u0, w1 - w0, 0.1), (u0 + u1) / 2, 2, SPLIT, (w0 + w1) / 2)));
  fin(-LEN / 2, -7, DEP / 2 - 0.6, DEP / 2);
  fin(7, LEN / 2, DEP / 2 - 0.6, DEP / 2);
  fin(-LEN / 2, LEN / 2, -DEP / 2, -DEP / 2 + 0.6);
  fin(-LEN / 2, -LEN / 2 + 0.6, -DEP / 2, DEP / 2);
  fin(LEN / 2 - 0.6, LEN / 2, -DEP / 2, DEP / 2);
  // 正面の白い門の枠（中央、高さ 26m）
  L.white.push(place(new THREE.BoxGeometry(2, 26, 3).translate(-7, 13, DEP / 2 + 0.6)));
  L.white.push(place(new THREE.BoxGeometry(2, 26, 3).translate(7, 13, DEP / 2 + 0.6)));
  L.white.push(place(new THREE.BoxGeometry(16, 2, 3).translate(0, 26, DEP / 2 + 0.6)));
  // 斜めに折れた白い庇の帯（10m と 22m）：正面から張り出し、端で折れ下がる
  for (const [y, out] of [
    [10, 7],
    [22, 4],
  ]) {
    L.white.push(place(new THREE.BoxGeometry(LEN + 4, 0.8, out).translate(0, y, DEP / 2 + out / 2)));
    for (const s of [-1, 1]) {
      L.white.push(
        place(
          new THREE.BoxGeometry(14, 0.8, out)
            .translate(s * 7, 0, 0)
            .rotateZ(s * 0.35)
            .translate(s * (LEN / 2 + 2), y, DEP / 2 + out / 2),
        ),
      );
    }
  }
  // 上半身：斜めの格子のガラス
  L.upper.push(place(extrudeWalls(body, 0, SPLIT, H)));
  L.white.push(place(cap(body, 0, H)));
  L.white.push(place(new THREE.BoxGeometry(LEN + 1, 1.2, DEP + 1).translate(0, SPLIT, 0)));

  // ---- ガーデン：塔の南西の端から、敷地の南の角（交差点、u = -50, w = 20）へ下りる段々の植え込み ----
  // 段ごとに、角へ向かって狭くなる（敷地の三角形の中に収める）
  const terraces: Array<[number, number, number, number, number]> = [
    // [u0, u1, w0, w1, 高さ]
    [-34, -28, -16, 16, 6],
    [-39, -34, -10, 17, 4.5],
    [-44, -39, -2, 18, 3],
    [-49, -44, 8, 19, 1.5],
  ];
  for (const [u0, u1, w0, w1, h] of terraces) {
    L.paving.push(place(new THREE.BoxGeometry(u1 - u0, h, w1 - w0).translate((u0 + u1) / 2, h / 2, (w0 + w1) / 2)));
    L.plant.push(place(new THREE.BoxGeometry(u1 - u0 - 1.5, 0.5, w1 - w0 - 1.5).translate((u0 + u1) / 2, h + 0.25, (w0 + w1) / 2)));
    for (let w = w0 + 3; w < w1 - 1.5; w += 6) tree(L, place, (u0 + u1) / 2, w, h);
  }
  // 木の大階段：庭の段の脇（正面側）を、塔の足元から南の角へ下る
  for (let k = 0; k < 9; k++) {
    L.wood.push(place(new THREE.BoxGeometry(2.4, 0.6, 3).translate(-28 - k * 2.4, 6.5 - k * 0.72, 18.5)));
  }
  // 正面の細い植え込み（塔と明治通りの間）
  L.plant.push(place(new THREE.BoxGeometry(LEN - 10, 0.5, 2).translate(4, 0.65, DEP / 2 + 2)));
  buildFootbridge(L, cx);

  // 塔の脇の芝生と木（北西側）
  L.plant.push(place(new THREE.BoxGeometry(LEN - 8, 0.4, 6).translate(0, 0.6, -DEP / 2 - 5)));
  for (let u = -22; u <= 22; u += 11) tree(L, place, u, -DEP / 2 - 5, 0.4);

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
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, merge(v)])) as unknown as AxshParts;
}

/** 歩道橋の床の高さ (m)、幅 (m) */
const DECK = 6.5;
const BRIDGE_W = 4;

/** 歩道橋（敷地の座標：東・北, m） */
function buildFootbridge(L: Record<keyof AxshParts, THREE.BufferGeometry[]>, cx: number): void {
  const P = (e: number, n: number, y: number) => new THREE.Vector3(cx + e, y, -n);
  const A = [13.6, -27.2] as const; // アクシュ側の東屋
  const B = [33.3, -42.0] as const; // クロスタワー側の東屋
  /** a から b への床の板（幅 w、厚み t）と、両側の手すり。屋根付きなら上に屋根 */
  const span = (a: THREE.Vector3, b: THREE.Vector3, w: number, roof: boolean, steps = 0) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
    const pitch = Math.atan2(b.y - a.y, len);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const at = (g: THREE.BufferGeometry) => g.rotateZ(pitch).rotateY(yaw).translate(mid.x, mid.y, mid.z);
    const slen = Math.hypot(len, b.y - a.y);
    if (steps > 0) {
      // 階段：段の板を並べる
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const p = a.clone().lerp(b, t);
        L.bridge.push(new THREE.BoxGeometry(len / steps + 0.05, 0.25, w).rotateY(yaw).translate(p.x, p.y - 0.12, p.z));
      }
    } else L.bridge.push(at(new THREE.BoxGeometry(slen, 0.5, w).translate(0, -0.25, 0)));
    for (const s of [-1, 1]) {
      L.bridge.push(at(new THREE.BoxGeometry(slen, 1.1, 0.12).translate(0, 0.55, (s * w) / 2)));
      L.bridge.push(at(new THREE.BoxGeometry(slen, 0.1, 0.2).translate(0, 1.1, (s * w) / 2)));
    }
    if (roof) {
      // 切妻の屋根（こげ茶）と、屋根を支える柱
      for (const s of [-1, 1]) {
        L.bridgeRoof.push(
          at(new THREE.BoxGeometry(slen, 0.15, w / 2 + 0.9).translate(0, 0, (s * (w / 2 + 0.9)) / 2).rotateX(s * -0.35).translate(0, 3.2, 0)),
        );
      }
      const n = Math.max(2, Math.round(slen / 4));
      for (let k = 0; k <= n; k++) {
        const p = a.clone().lerp(b, k / n);
        for (const s of [-1, 1]) {
          const o = new THREE.Vector3(0, 0, (s * w) / 2).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          L.bridge.push(new THREE.BoxGeometry(0.2, 3, 0.2).translate(p.x + o.x, p.y + 1.5, p.z + o.z));
        }
      }
    }
  };
  /** 東屋：六角形の床と、6本の柱、六角すいの屋根と頂部の飾り */
  const pavilion = (e: number, n: number) => {
    const c = P(e, n, DECK);
    L.bridge.push(new THREE.CylinderGeometry(4, 4, 0.6, 6).translate(c.x, DECK - 0.3, c.z));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      L.bridge.push(new THREE.BoxGeometry(0.3, 3.4, 0.3).translate(c.x + Math.cos(a) * 3.6, DECK + 1.7, c.z + Math.sin(a) * 3.6));
    }
    L.bridgeRoof.push(new THREE.ConeGeometry(5, 2.6, 6).translate(c.x, DECK + 3.4 + 1.3, c.z));
    L.bridgeRoof.push(new THREE.ConeGeometry(0.4, 1.4, 6).translate(c.x, DECK + 3.4 + 2.6 + 0.6, c.z));
    // 床の下の柱
    L.paving.push(new THREE.CylinderGeometry(0.8, 0.8, DECK, 12).translate(c.x, DECK / 2, c.z));
  };
  pavilion(...A);
  pavilion(...B);
  // 橋（明治通りをまたぐ）
  span(P(...A, DECK), P(...B, DECK), BRIDGE_W, true);
  // アクシュ側の階段：東屋から北東と南西へ、敷地の縁に沿って下りる
  span(P(...A, DECK), P(21.9, -16.3, 0.3), 2.6, false, 22);
  span(P(...A, DECK), P(2.4, -42.6, 0.3), 2.6, false, 22);
  // クロスタワー側：東屋から南へ下りる階段（途中の踊り場で折れる）と、北東のクロスタワーのデッキへの短い通路
  span(P(...B, DECK), P(29.4, -47.2, DECK - 2.2), 2.6, false, 8);
  L.bridge.push(new THREE.BoxGeometry(3, 0.4, 3).translate(cx + 30.5, DECK - 2.4, 49));
  span(P(31.6, -49.5, DECK - 2.2), P(32.6, -58.5, 0.3), 2.6, false, 14);
  span(P(...B, DECK), P(37.4, -36.3, DECK), 3, true);
  // 橋の下の柱（道路の両側）
  for (const t of [0.3, 0.7]) {
    const p = P(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, 0);
    L.paving.push(new THREE.BoxGeometry(0.8, DECK - 0.5, 0.8).translate(p.x, (DECK - 0.5) / 2, p.z));
  }
}

function tree(
  L: Record<keyof AxshParts, THREE.BufferGeometry[]>,
  place: (g: THREE.BufferGeometry, u?: number, w?: number) => THREE.BufferGeometry,
  u: number,
  w: number,
  base: number,
): void {
  const s = 0.8 + (((u * 7.3 + w * 3.1) % 1) + 1) % 1 * 0.5;
  L.trunk.push(place(new THREE.CylinderGeometry(0.15, 0.25, 3 * s, 6).translate(u, base + 1.5 * s, w)));
  L.leaves.push(place(new THREE.ConeGeometry(2 * s, 5 * s, 8).translate(u, base + 4.5 * s, w)));
}

/** 上半身：暗い青のガラスに、白い縦横の枠と斜めの格子（1枚 = 2列 × 2階） */
export function createAxshUpperMaterial(): THREE.MeshStandardMaterial {
  const mat = facadeMaterial(
    (g, W, Hp) => {
      const grad = g.createLinearGradient(0, 0, W, Hp);
      grad.addColorStop(0, '#2e4560');
      grad.addColorStop(1, '#3d5b7a');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, Hp);
      g.strokeStyle = '#dfe4e8';
      g.lineWidth = 2;
      g.beginPath();
      // 縦の枠・各階の枠
      for (const x of [0, W / 2]) (g.moveTo(x + 1, 0), g.lineTo(x + 1, Hp));
      for (const y of [0, Hp / 2]) (g.moveTo(0, y + 1), g.lineTo(W, y + 1));
      // 斜めの格子（左下から右上へ、2列 × 2階を横切る）
      g.moveTo(0, Hp);
      g.lineTo(W, 0);
      g.stroke();
    },
    0.12,
    0.55,
  );
  mat.map!.repeat.set(0.5, 0.5);
  return mat;
}

/** 下半身：明るい銀色の縦のフィンと、奥の青灰色のガラス */
export function createAxshLowerMaterial(): THREE.MeshStandardMaterial {
  const mat = facadeMaterial(
    (g, W, Hp) => {
      g.fillStyle = '#7d93a3';
      g.fillRect(0, 0, W, Hp);
      g.fillStyle = '#d6dbdf';
      for (let k = 0; k < 4; k++) g.fillRect((k * W) / 4, 0, 5, Hp);
    },
    0.3,
    0.4,
  );
  return mat;
}

