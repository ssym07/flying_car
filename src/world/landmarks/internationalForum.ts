import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, facadeMaterial } from './azabudaiHills';

/**
 * 東京国際フォーラム（1996年）：ガラス棟（レンズ形のガラスのアトリウム、57.5m）と、西のホール棟。写真を参考に作る。
 * 座標：中心（緯度 35.6766, 経度 139.7643）が (cx, 0, 0)、x = 東、z = 南、y = 上。平面は OpenStreetMap の形。
 *
 * - ガラス棟の西の面：全面ガラス（中の骨組みの線）
 * - ガラス棟の東の面（線路の側）：下は灰色の曲がった壁（〜25m）。上はテラスの植え込みと、奥へ下げたガラスの面
 * - ガラス棟の屋根：レンズ形のガラスの格子
 * - ホール棟：暗い灰色の箱。屋上に白い縦の塔
 */
export interface ForumParts {
  glass: THREE.BufferGeometry;
  roofGlass: THREE.BufferGeometry;
  wall: THREE.BufferGeometry;
  terrace: THREE.BufferGeometry;
  hall: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

type P2 = [number, number];
type LatLon = [number, number];

const LAT0 = 35.6766;
const LON0 = 139.7643;
const toXZ = ([lat, lon]: LatLon): P2 => [
  (lon - LON0) * 111320 * Math.cos((LAT0 * Math.PI) / 180),
  -(lat - LAT0) * 111320,
];

/** ガラス棟の東の弧（北の先 → 南の先） */
const GLASS_EAST: LatLon[] = [
  [35.677509, 139.764906],
  [35.677484, 139.765016],
  [35.677417, 139.765012],
  [35.677308, 139.764988],
  [35.677104, 139.764898],
  [35.676872, 139.76478],
  [35.676731, 139.764678],
  [35.676537, 139.764529],
  [35.676292, 139.764317],
  [35.676142, 139.764164],
  [35.67596, 139.763925],
  [35.675814, 139.763733],
  [35.67574, 139.763623],
];
/** ガラス棟の西の弧（北の先 → 南の先） */
const GLASS_WEST: LatLon[] = [
  [35.677509, 139.764906],
  [35.677407, 139.764882],
  [35.677359, 139.764819],
  [35.67727, 139.76469],
  [35.677085, 139.764458],
  [35.676849, 139.764215],
  [35.676623, 139.764027],
  [35.676263, 139.76378],
  [35.676023, 139.763678],
  [35.675833, 139.763597],
  [35.67574, 139.763623],
];
/** ホール棟 */
const HALL: LatLon[] = [
  [35.677773, 139.763486],
  [35.677808, 139.763497],
  [35.677786, 139.763595],
  [35.677752, 139.763583],
  [35.677722, 139.76372],
  [35.677762, 139.763733],
  [35.677648, 139.764255],
  [35.677591, 139.764236],
  [35.677559, 139.764383],
  [35.676994, 139.764197],
  [35.677068, 139.763856],
  [35.676997, 139.763833],
  [35.676966, 139.763978],
  [35.676559, 139.763844],
  [35.676614, 139.763588],
  [35.676536, 139.763562],
  [35.676505, 139.763703],
  [35.676177, 139.763595],
  [35.676188, 139.763547],
  [35.676226, 139.763373],
  [35.676152, 139.763349],
  [35.676122, 139.763489],
  [35.675874, 139.763407],
  [35.675893, 139.763318],
  [35.675809, 139.763291],
  [35.675877, 139.762977],
  [35.6759, 139.76287],
  [35.675983, 139.762897],
];

const GLASS_TOP = 57.5;
const WALL_TOP = 25;
/** 東の面の上のガラスを奥へ下げる幅（m） */
const SETBACK = 6;
/** 弧を細かく分ける数 */
const N = 48;

/** 折れ線を長さで N 等分した点 */
function resample(pts: P2[], n: number): P2[] {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = lens[lens.length - 1];
  const out: P2[] = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * total;
    while (j < pts.length - 1 && lens[j] < s) j++;
    const t = (s - lens[j - 1]) / (lens[j] - lens[j - 1] || 1);
    out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t]);
  }
  return out;
}

/** 点 a〜b の間の縦の壁（uv：横 / 3m、縦 / FLOOR） */
function wall(cx: number, a: P2, b: P2, y0: number, y1: number, u0: number): THREE.BufferGeometry {
  const u1 = u0 + Math.hypot(b[0] - a[0], b[1] - a[1]) / 3;
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
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1], 2));
  return g;
}

/** 折れ線に沿った壁（uv の横は続けて数える） */
function walls(list: THREE.BufferGeometry[], cx: number, pts: P2[], y0: number, y1: number): void {
  let u = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    list.push(wall(cx, pts[i], pts[i + 1], y0, y1, u));
    u += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) / 3;
  }
}

/** 2本の折れ線（同じ点の数）の間の水平な帯（高さ y）。uv は m / 3 */
function strip(cx: number, a: P2[], b: P2[], y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < a.length - 1; i++) {
    const q = [a[i], b[i], a[i + 1], b[i + 1]];
    for (const k of [0, 1, 2, 2, 1, 3]) {
      pos.push(cx + q[k][0], y, q[k][1]);
      uv.push(q[k][0] / 3, q[k][1] / 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export function buildInternationalForum(cx: number): ForumParts {
  const P: Record<keyof ForumParts, THREE.BufferGeometry[]> = {
    glass: [],
    roofGlass: [],
    wall: [],
    terrace: [],
    hall: [],
    white: [],
    roof: [],
  };

  // ---- ガラス棟 ----
  const east = resample(GLASS_EAST.map(toXZ), N);
  const west = resample(GLASS_WEST.map(toXZ), N);
  // 東の面の上のガラス：東の弧から西の弧へ SETBACK m 寄せる（両端の細い所は幅の 3 割まで）
  const upper: P2[] = east.map((e, i) => {
    const w = west[i];
    const width = Math.hypot(w[0] - e[0], w[1] - e[1]);
    const k = width > 0 ? Math.min(SETBACK / width, 0.3) : 0;
    return [e[0] + (w[0] - e[0]) * k, e[1] + (w[1] - e[1]) * k];
  });
  walls(P.glass, cx, west, 0, GLASS_TOP);
  walls(P.wall, cx, east, 0, WALL_TOP);
  P.terrace.push(strip(cx, east, upper, WALL_TOP));
  walls(P.glass, cx, upper, WALL_TOP, GLASS_TOP);
  P.roofGlass.push(strip(cx, upper, west, GLASS_TOP));
  // 屋根の縁の細い枠
  walls(P.white, cx, west, GLASS_TOP, GLASS_TOP + 0.8);
  walls(P.white, cx, upper, GLASS_TOP, GLASS_TOP + 0.8);

  // ---- ホール棟：暗い灰色の箱と、屋上の白い縦の塔 ----
  const hall = HALL.map(toXZ);
  const HALL_TOP = 42;
  walls(P.hall, cx, [...hall, hall[0]], 0, HALL_TOP);
  const shape = new THREE.Shape(hall.map(([x, z]) => new THREE.Vector2(x, -z)));
  P.roof.push(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(cx, HALL_TOP, 0));
  // 白い塔：ホール棟の東の縁に沿って（北の端と南の端の間を 5 つに分けた所）
  const north = toXZ([35.677705, 139.7641]);
  const south = toXZ([35.67595, 139.76351]);
  for (let i = 0; i < 5; i++) {
    const t = (i + 0.5) / 5;
    const x = north[0] + (south[0] - north[0]) * t;
    const z = north[1] + (south[1] - north[1]) * t;
    P.white.push(new THREE.BoxGeometry(5, 14, 5).translate(cx + x, HALL_TOP + 3, z));
  }

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes))
        if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as ForumParts;
}

/** ガラス棟の壁：明るいガラスに縦横の桟と、中の骨組みの斜めの白い線（1枚 = 3m × 1階） */
export function createForumGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#a9d4ea');
      grad.addColorStop(1, '#5f9ec2');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(245,248,250,0.55)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, H);
      g.lineTo(W, 0);
      g.stroke();
      g.fillStyle = 'rgba(70,85,95,0.55)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(W / 2, 0, 1, H);
      g.fillRect(0, H - 2, W, 2);
    },
    0.1,
    0.3,
  );
}

/** ガラス棟の屋根：ガラスの細かい格子（1枚 = 3m × 3m） */
export function createForumRoofMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#7d93a3';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(220,228,234,0.7)';
      g.fillRect(0, 0, 3, H);
      g.fillRect(0, 0, W, 3);
    },
    0.2,
    0.4,
  );
}

/** 東の灰色の壁：横の細い線の入った石の板と、上の窓の帯（1枚 = 3m × 1階） */
export function createForumWallMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#b0b3b2';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(80,85,88,0.35)';
      for (let y = 0; y < H; y += H / 4) g.fillRect(0, y, W, 2);
      g.fillStyle = 'rgba(80,85,88,0.25)';
      g.fillRect(W - 2, 0, 2, H);
    },
    0.75,
    0,
  );
}

/** ホール棟：暗い灰色の石の板（1枚 = 3m × 1階） */
export function createForumHallMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#6f7378';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(40,44,48,0.4)';
      g.fillRect(0, H - 2, W, 2);
      g.fillRect(W - 2, 0, 2, H);
    },
    0.7,
    0.05,
  );
}
