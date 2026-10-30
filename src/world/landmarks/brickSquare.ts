import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 丸の内ブリックスクエア（2009年）：丸の内パークビルディング（170m）と、復元した三菱一号館（1894年の建物の復元、3階）。
 * 写真を参考に作る。
 *
 * パークビル：中心が (cx, 0, 0)、x = 東、z = 南、y = 上。平面は PLATEAU の形（南の面が外へふくらむ曲線）。
 * - 塔は赤茶の石の格子。南と北の面の真ん中は青緑のガラスに白い階の線。てっぺんに銀色の帯
 * - 低層部（〜20m）は暗いガラス、上の縁にテラスの植え込み
 *
 * 三菱一号館：中心が (cx, 0, 0)、x = 北北東、z = 東南東（通りの側）、y = 上。L 字の2つの棟。
 * - 赤レンガの壁に白い石の窓枠・階の帯・角の石。足元は灰色の石
 * - 急な灰色のスレートの屋根に、切妻の屋根窓・煙突、角と真ん中に尖った屋根
 */
export interface ParkBuildingParts {
  stone: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
  podium: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

export interface IchigokanParts {
  brick: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  slate: THREE.BufferGeometry;
  base: THREE.BufferGeometry;
}

type P2 = [number, number];

/** 点 a〜b の間の縦の壁（uv：横 / 3m、縦 / FLOOR） */
function wall(cx: number, a: P2, b: P2, y0: number, y1: number): THREE.BufferGeometry {
  const u1 = Math.hypot(b[0] - a[0], b[1] - a[1]) / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        cx + a[0],
        y0,
        a[1],
        cx + b[0],
        y0,
        b[1],
        cx + b[0],
        y1,
        b[1],
        cx + a[0],
        y0,
        a[1],
        cx + b[0],
        y1,
        b[1],
        cx + a[0],
        y1,
        a[1],
      ],
      3,
    ),
  );
  const v0 = y0 / FLOOR;
  const v1 = y1 / FLOOR;
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, v0, u1, v0, u1, v1, 0, v0, u1, v1, 0, v1], 2));
  return g;
}

/** 平らな屋根（多角形を三角形に分けた板、高さ y） */
function slab(cx: number, pts: P2[], y: number): THREE.BufferGeometry {
  // 形の y = -z にして -90° 回すと、面が上を向いたまま z に戻る
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(cx, y, 0);
}

/** 点を中心から d m 外へ（内へは負） */
function grow(pts: P2[], d: number): P2[] {
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const mz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, z]) => {
    const l = Math.hypot(x - mx, z - mz) || 1;
    return [x + ((x - mx) / l) * d, z + ((z - mz) / l) * d];
  });
}

function mergeParts<K extends string>(P: Record<K, THREE.BufferGeometry[]>): Record<K, THREE.BufferGeometry> {
  const one = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes))
        if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      if (!out.getAttribute('uv')) {
        out.setAttribute(
          'uv',
          new THREE.Float32BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2),
        );
      }
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, one(v as THREE.BufferGeometry[])])) as Record<
    K,
    THREE.BufferGeometry
  >;
}

/**
 * パークビルの平面（PLATEAU の点。OBB の座標 a = 西北西、b = 南南西 から東・南へ直したもの）。
 * 北の辺は3つに分け、真ん中をガラスにする。南の曲線は点を細かく並べる
 */
const PARK_AB: Array<[number, number, boolean]> = [
  // [a, b, この点から次の点までの面がガラスか]
  [-45, -35, false],
  [-13, -35.4, true],
  [13, -35.7, false],
  [40, -36, false],
  [44, 38, false],
  [42, 42, false],
  [31, 44, true],
  [22, 45, true],
  [9, 45, true],
  [4, 45, true],
  [-8, 42, true],
  [-12, 40, true],
  [-17, 38, false],
  [-23, 30, false],
  [-28, 26, false],
  [-35, 21, false],
  [-39, 20, false],
  [-39, -29, false],
  [-45, -29, false],
];
const A_EAST = Math.cos((168 * Math.PI) / 180);
const A_NORTH = Math.sin((168 * Math.PI) / 180);
const PARK: Array<{ p: P2; glass: boolean }> = PARK_AB.map(([a, b, glass]) => {
  // b の向き = (-sin, cos)（東, 北）
  const east = a * A_EAST - b * A_NORTH;
  const north = a * A_NORTH + b * A_EAST;
  return { p: [east, -north], glass };
});

export function buildParkBuilding(cx: number): ParkBuildingParts {
  const P: Record<keyof ParkBuildingParts, THREE.BufferGeometry[]> = {
    stone: [],
    glass: [],
    crown: [],
    podium: [],
    green: [],
    roof: [],
  };
  const pts = PARK.map((q) => q.p);
  const tower = grow(pts, -3);
  const TOP = 170;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    // 低層部（〜20m）とテラスの縁の植え込み
    P.podium.push(wall(cx, pts[i], pts[j], 0, 20));
    P.green.push(wall(cx, pts[i], pts[j], 20, 21.2));
    // 塔（20〜163m）と、てっぺんの銀色の帯（163〜170m）
    P[PARK[i].glass ? 'glass' : 'stone'].push(wall(cx, tower[i], tower[j], 20, 163));
    P.crown.push(wall(cx, tower[i], tower[j], 163, TOP));
  }
  P.green.push(slab(cx, pts, 21.2));
  P.roof.push(slab(cx, tower, TOP - 0.5));
  return mergeParts(P);
}

/** 寄棟の屋根：長方形（y0）から、内へ inset m 寄せた上の面（y1）まで。上は平ら */
function hipRoof(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, inset: number) {
  const b: P2[] = [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  const t: P2[] = [
    [x0 + inset, z0 + inset],
    [x1 - inset, z0 + inset],
    [x1 - inset, z1 - inset],
    [x0 + inset, z1 - inset],
  ];
  const pos: number[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    pos.push(b[i][0], y0, b[i][1], b[j][0], y0, b[j][1], t[j][0], y1, t[j][1]);
    pos.push(b[i][0], y0, b[i][1], t[j][0], y1, t[j][1], t[i][0], y1, t[i][1]);
  }
  pos.push(t[0][0], y1, t[0][1], t[1][0], y1, t[1][1], t[2][0], y1, t[2][1]);
  pos.push(t[0][0], y1, t[0][1], t[2][0], y1, t[2][1], t[3][0], y1, t[3][1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

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

export function buildIchigokan(cx: number): IchigokanParts {
  const P: Record<keyof IchigokanParts, THREE.BufferGeometry[]> = { brick: [], trim: [], slate: [], base: [] };
  const EAVE = 14;
  // [x0, x1, z0, z1]：通りに沿った長い棟と、南の端から西へ出る短い棟
  const wings: Array<[number, number, number, number]> = [
    [cx - 26, cx + 34, 3, 23],
    [cx - 26, cx - 9, -25, 3],
  ];
  for (const [x0, x1, z0, z1] of wings) {
    P.base.push(box(x0 - 0.3, x1 + 0.3, 0, 1.4, z0 - 0.3, z1 + 0.3));
    P.brick.push(box(x0, x1, 1.4, EAVE, z0, z1));
    // 階の帯と軒の白い石
    P.trim.push(box(x0 - 0.25, x1 + 0.25, 5.6, 6.1, z0 - 0.25, z1 + 0.25));
    P.trim.push(box(x0 - 0.25, x1 + 0.25, 9.8, 10.3, z0 - 0.25, z1 + 0.25));
    P.trim.push(box(x0 - 0.6, x1 + 0.6, EAVE - 0.6, EAVE, z0 - 0.6, z1 + 0.6));
    // 角の石
    for (const x of [x0, x1]) for (const z of [z0, z1]) P.trim.push(box(x - 0.5, x + 0.5, 1.4, EAVE, z - 0.5, z + 0.5));
    // 急なスレートの屋根
    P.slate.push(hipRoof(x0 - 0.6, x1 + 0.6, z0 - 0.6, z1 + 0.6, EAVE, EAVE + 6, 4.5));
  }
  // 切妻の屋根窓：長い棟の通りの側と裏の側に並べる
  for (let x = cx - 22; x <= cx + 30; x += 6.5) {
    for (const [z, s] of [
      [23, 1],
      [3, -1],
    ] as const) {
      if (s < 0 && x < cx - 8) continue;
      const zf = z - s * 1.2;
      P.brick.push(box(x - 1.2, x + 1.2, EAVE, EAVE + 2.6, Math.min(zf, zf - s * 2.2), Math.max(zf, zf - s * 2.2)));
      P.slate.push(
        new THREE.CylinderGeometry(0, 1.9, 1.8, 4, 1)
          .rotateY(Math.PI / 4)
          .scale(1, 1, 1.3)
          .translate(x, EAVE + 3.5, zf - s * 1.1),
      );
      P.trim.push(box(x - 0.6, x + 0.6, EAVE + 0.5, EAVE + 2.1, zf + s * 0.05, zf + s * 0.15));
    }
  }
  // 角と真ん中の尖った屋根（四角い塔屋と、高い四角錐の屋根）
  for (const [x, z] of [
    [cx + 30, 19],
    [cx - 22, 19],
    [cx + 4, 19],
    [cx - 22, -21],
  ]) {
    P.brick.push(box(x - 4, x + 4, EAVE, EAVE + 2.5, z - 4, z + 4));
    P.trim.push(box(x - 4.3, x + 4.3, EAVE + 2.5, EAVE + 3, z - 4.3, z + 4.3));
    P.slate.push(new THREE.ConeGeometry(6, 8, 4, 1).rotateY(Math.PI / 4).translate(x, EAVE + 7, z));
  }
  // 煙突
  for (const [x, z] of [
    [cx - 12, 13],
    [cx + 16, 13],
    [cx - 18, -10],
  ]) {
    P.brick.push(box(x - 0.9, x + 0.9, EAVE + 3, EAVE + 8, z - 0.9, z + 0.9));
    P.trim.push(box(x - 1.1, x + 1.1, EAVE + 8, EAVE + 8.4, z - 1.1, z + 1.1));
  }
  return mergeParts(P);
}

/** パークビルの塔：赤茶の石の縦の格子と、奥の暗い窓（1枚 = 3m × 1階） */
export function createParkStoneMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#80503f';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3f4448';
      g.fillRect(W * 0.14, H * 0.12, W * 0.3, H * 0.72);
      g.fillRect(W * 0.56, H * 0.12, W * 0.3, H * 0.72);
      g.fillStyle = '#9a6650';
      g.fillRect(W * 0.47, 0, 4, H);
    },
    0.7,
    0,
  );
}

/** パークビルのガラス：青緑のガラスに、白い階の線（1枚 = 3m × 1階） */
export function createParkGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#5aa0b4');
      grad.addColorStop(1, '#3a7c92');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#e6eef0';
      g.fillRect(0, H - 8, W, 8);
      g.fillStyle = 'rgba(220,235,240,0.5)';
      g.fillRect(0, 0, 2, H);
    },
    0.12,
    0.35,
  );
}

/** パークビルの低層部：暗いガラスに石の柱（1枚 = 3m × 1階） */
export function createParkPodiumMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#3c4c56';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#b8a894';
      g.fillRect(0, 0, 6, H);
      g.fillRect(0, H - 6, W, 6);
    },
    0.3,
    0.3,
  );
}

/** 三菱一号館の赤レンガ：白い石の枠の縦長の窓（1枚 = 3m × 1階） */
export function createBrickWallMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#a34e3c';
      g.fillRect(0, 0, W, H);
      // レンガの目地
      g.fillStyle = 'rgba(70,30,25,0.25)';
      for (let y = 0; y < H; y += 6) g.fillRect(0, y, W, 1);
      g.fillStyle = '#ece6d8';
      g.fillRect(W * 0.3, H * 0.14, W * 0.4, H * 0.66);
      g.fillStyle = '#2c3236';
      g.fillRect(W * 0.35, H * 0.2, W * 0.3, H * 0.56);
      g.fillStyle = '#ece6d8';
      g.fillRect(W * 0.49, H * 0.2, 2, H * 0.56);
    },
    0.85,
    0,
  );
}
