import * as THREE from 'three';
import type { VehicleState } from './physics';

/**
 * 車の状態（位置・速度・向き）とメッシュ。
 * 描画時は前回と今回の状態を alpha で補間して、固定刻みのカクつきを隠す。
 */
export class Vehicle {
  state: VehicleState;
  private prev: VehicleState;
  readonly mesh: THREE.Group;

  constructor(initial: VehicleState) {
    this.state = clone(initial);
    this.prev = clone(initial);
    this.mesh = buildMesh();
  }

  /** 物理の結果を反映する（前回の状態は補間用に保持） */
  commit(next: VehicleState): void {
    this.prev = this.state;
    this.state = next;
  }

  /** ワープ時など、補間せずに置き換える */
  reset(state: VehicleState): void {
    this.state = clone(state);
    this.prev = clone(state);
  }

  /** alpha で補間した位置・向きをメッシュに反映する */
  syncMesh(alpha: number): void {
    const a = this.prev.position;
    const b = this.state.position;
    this.mesh.position.set(lerp(a.x, b.x, alpha), lerp(a.y, b.y, alpha), lerp(a.z, b.z, alpha));
    this.mesh.rotation.y = lerp(this.prev.yaw, this.state.yaw, alpha);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clone(s: VehicleState): VehicleState {
  return { position: { ...s.position }, velocity: { ...s.velocity }, yaw: s.yaw };
}

/** 車体の大きさ (m) */
const LENGTH = 4.8;
const WIDTH = 2.05;
/** 車体の底の高さ（自機の中心から。当たり判定の halfHeight に合わせる） */
const FLOOR = -0.6;
/** 断面の片側の点数：下半身（底の中央→肩）とキャビン（肩→屋根の中央） */
const LOWER_POINTS = 20;
const CABIN_POINTS = 16;
const HALF_RING = LOWER_POINTS + CABIN_POINTS;
/** 断面1周の点数と、前後方向の分割数 */
const RING = HALF_RING * 2;
const SECTIONS = 110;

/**
 * 空飛ぶ車（タイヤ類は無し）。前方は -z。
 * ボディとキャビンを1枚の面で作る：前から後ろまで断面を並べてつなぐ。
 * 断面は「下半身（角の丸い四角形）」と「肩から少し内側に立ち上がるキャビン」を点の数を固定してつないだもの。
 * キャビンの無い前後ではキャビンの高さが 0 になり、なめらかにボンネット・トランクへつながる。
 * 窓は別の部品にせず、同じ面の上で窓の部分だけガラスの材質にする。
 */
function buildMesh(): THREE.Group {
  const group = new THREE.Group();

  const paintMat = new THREE.MeshStandardMaterial({
    color: 0xc9ced8,
    metalness: 0.6,
    roughness: 0.3,
    envMapIntensity: 1.8,
  });
  // 窓：濃い青のガラス。車内のメーターの光がほんのり透ける
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x3a5578,
    emissive: 0x0b2a4a,
    metalness: 0.75,
    roughness: 0.06,
    envMapIntensity: 2.5,
  });
  // 光るライン：トーンマッピングをかけず、明るい色のまま出す
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x8eeaff, toneMapped: false });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff4a5a, toneMapped: false });

  // ---- ボディ（1枚の面）----
  const positions: number[] = [];
  const glassFlags: boolean[] = [];
  for (let j = 0; j <= SECTIONS; j++) {
    const t = -1 + (2 * j) / SECTIONS;
    const section = sectionPoints(t);
    for (let i = 0; i < RING; i++) {
      const { point, glass } = section[i];
      positions.push(point.x, point.y, point.z);
      glassFlags.push(glass);
    }
  }
  // 窓の面とボディの面を分けて、同じ頂点を共有したまま材質だけ変える
  const paintIndex: number[] = [];
  const glassIndex: number[] = [];
  for (let j = 0; j < SECTIONS; j++) {
    for (let i = 0; i < RING; i++) {
      const a = j * RING + i;
      const b = j * RING + ((i + 1) % RING);
      const c = a + RING;
      const d = b + RING;
      const glass = glassFlags[a] && glassFlags[b] && glassFlags[c] && glassFlags[d];
      // 断面の点は右側面を下から上へ回るので、この順で張ると面が外を向く
      (glass ? glassIndex : paintIndex).push(a, b, c, b, d, c);
    }
  }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  bodyGeo.setIndex([...paintIndex, ...glassIndex]);
  bodyGeo.addGroup(0, paintIndex.length, 0);
  bodyGeo.addGroup(paintIndex.length, glassIndex.length, 1);
  bodyGeo.computeVertexNormals();
  group.add(new THREE.Mesh(bodyGeo, [paintMat, glassMat]));

  // ---- 光るライン（ボディ表面に沿わせる）----
  const line = (points: THREE.Vector3[], material: THREE.Material, radius = 0.022) => {
    const curve = new THREE.CatmullRomCurve3(points);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, points.length * 3, radius, 6, false), material));
  };
  /** 下半身の断面の角度 angle（-90°=底, 0°=側面, 90°=上）を、前後 t の範囲でなぞる。side=-1 で左側 */
  const trace = (from: number, to: number, angle: number, side: 1 | -1, n = 48) =>
    Array.from({ length: n }, (_, k) => {
      const p = lowerPoint(from + ((to - from) * k) / (n - 1), angle, 0.012);
      return p.setX(p.x * side);
    });
  const deg = THREE.MathUtils.DEG2RAD;
  // 肩のライン（ボディの上の角）と、下回りのライン
  for (const side of [1, -1] as const) {
    line(trace(-0.93, 0.95, 40 * deg, side), glowMat);
    line(trace(-0.85, 0.88, -40 * deg, side), glowMat, 0.018);
  }
  // ピラーの線：屋根の四隅から、窓の下の四隅へ（A ピラー2本・C ピラー2本）。光らせない白い線
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.5 });
  const windowBottom = THREE.MathUtils.DEG2RAD * 11;
  const glassStart = findGlassEdge(GLASS_FROM, 1);
  const glassEnd = findGlassEdge(GLASS_TO, -1);
  for (const [roofT, baseT] of [
    [ROOF_FROM, glassStart],
    [ROOF_TO, glassEnd],
  ]) {
    for (const side of [1, -1]) {
      const points = Array.from({ length: 24 }, (_, k) => {
        const f = k / 23;
        const p = cabinPoint(
          THREE.MathUtils.lerp(roofT, baseT, f),
          THREE.MathUtils.lerp(ROOF_ANGLE, windowBottom, f),
          0.012,
        );
        return p.setX(p.x * side);
      });
      line(points, pillarMat, 0.016);
    }
  }
  // フロントの横一文字のライトバーと、リアの赤いテールバー
  line(endBar(-1, 10 * deg), glowMat, 0.03);
  line(endBar(1, 15 * deg), tailMat, 0.035);

  // ---- 底面のホバー：車体の下に沿った2本の光の帯と、その下のぼんやりした光 ----
  const stripGeo = new THREE.PlaneGeometry(0.16, LENGTH * 0.7);
  const haloMat = new THREE.MeshBasicMaterial({
    map: createGlowTexture(),
    color: 0x5fd8ff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const haloGeo = new THREE.PlaneGeometry(1.4, LENGTH);
  for (const x of [-0.6, 0.6]) {
    const strip = new THREE.Mesh(stripGeo, glowMat);
    // 下から見える向きにする
    strip.rotation.x = Math.PI / 2;
    strip.position.set(x, FLOOR - 0.005, 0);
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(x, FLOOR - 0.15, 0);
    group.add(strip, halo);
  }

  return group;
}

/** 前後 t（-1=鼻先, 1=テール）での肩（ボンネット・トランクの面）の高さ */
function shoulderY(t: number): number {
  return interpolate(
    [
      [-1.0, -0.12],
      [-0.85, 0.1],
      [-0.45, 0.24],
      [0.0, 0.28],
      [0.75, 0.32],
      [0.92, 0.28],
      [1.0, 0.12],
    ],
    t,
  );
}

/** 屋根の高さ：フロントガラス→屋根→リアガラス。キャビンの無い所は肩と同じ */
function roofY(t: number): number {
  const roof = interpolate(
    [
      [-0.46, 0.2],
      [-0.06, 0.84],
      [0.36, 0.86],
      [0.78, 0.26],
    ],
    t,
  );
  return t < -0.46 || t > 0.78 ? shoulderY(t) : Math.max(shoulderY(t), roof);
}

/** 平面図・側面図で両端を丸めて閉じるための縮み（端で 0） */
function endTaper(t: number, power: number): number {
  return Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), power)), 1 / power);
}

/** 下半身の断面の形（角の丸い四角形＝超楕円）の指数 */
const LOWER_N = 4.4;

/**
 * 下半身の断面上の点（右側）。angle は -90°=底の中央、0°=側面、90°=上の中央。
 * offset を渡すと断面の中心から外へ少し出す（ラインを表面に埋もれさせないため）
 */
function lowerPoint(t: number, angle: number, offset = 0): THREE.Vector3 {
  const bottom = FLOOR + 0.5 * Math.max(0, Math.abs(t) - 0.8);
  const top = shoulderY(t);
  const center = (bottom + top) / 2;
  const halfH = ((top - bottom) / 2) * endTaper(t, 10);
  const halfW = (WIDTH / 2) * endTaper(t, 6);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = Math.pow(Math.abs(c), 2 / LOWER_N) * halfW;
  const y = center + Math.sign(s) * Math.pow(Math.abs(s), 2 / LOWER_N) * halfH;
  const p = new THREE.Vector3(x, y, t * (LENGTH / 2));
  if (offset > 0) p.add(new THREE.Vector3(x, y - center, 0).normalize().multiplyScalar(offset));
  return p;
}

/** 窓にする範囲（前後） */
const GLASS_FROM = -0.44;
const GLASS_TO = 0.76;

/** 平らな屋根（ボディ色）の前後の範囲と、屋根の端の角度（キャビンの断面上） */
const ROOF_FROM = -0.04;
const ROOF_TO = 0.38;
const ROOF_ANGLE = 1.1;
/** キャビンの付け根：下半身の超楕円の上で、幅が 84% になる角度 */
const CABIN_BASE_ANGLE = Math.acos(Math.pow(0.84, LOWER_N / 2));
/** キャビンの断面の形（超楕円）の指数 */
const CABIN_M = 3.2;

/** キャビンの高さの割合（0 = キャビン無し） */
function cabinAmount(t: number): number {
  return THREE.MathUtils.smoothstep(roofY(t) - shoulderY(t), 0, 0.14);
}

/**
 * キャビンの断面上の点（右側）。a は 0=付け根（窓の下端）、π/2=屋根の中央。
 * 上に行くほど内側にすぼめる（タンブルホーム）。offset で外側へ少し出す
 */
function cabinPoint(t: number, a: number, offset = 0): THREE.Vector3 {
  const base = lowerPoint(t, THREE.MathUtils.lerp(Math.PI / 2, CABIN_BASE_ANGLE, cabinAmount(t)));
  const rise = Math.pow(Math.sin(a), 2 / CABIN_M);
  const y = base.y + (roofY(t) - base.y) * rise;
  const x = base.x * THREE.MathUtils.lerp(1, 0.84, rise) * Math.pow(Math.cos(a), 2 / CABIN_M);
  const p = new THREE.Vector3(x, y, base.z);
  if (offset > 0) p.add(new THREE.Vector3(x, y - base.y * 0.5, 0).normalize().multiplyScalar(offset));
  return p;
}

/**
 * 断面1周の点（右側面を底から屋根の中央まで上り、左側面を下る）と、その点が窓かどうか。
 * 下半身は肩の手前（キャビンの付け根）で止め、そこからキャビンが内側に少しすぼまりながら屋根まで上がる
 */
function sectionPoints(t: number): Array<{ point: THREE.Vector3; glass: boolean }> {
  const cabin = cabinAmount(t);
  const endAngle = THREE.MathUtils.lerp(Math.PI / 2, CABIN_BASE_ANGLE, cabin);

  const half: Array<{ point: THREE.Vector3; glass: boolean }> = [];
  for (let k = 0; k <= LOWER_POINTS; k++) {
    const angle = -Math.PI / 2 + ((endAngle + Math.PI / 2) * k) / LOWER_POINTS;
    half.push({ point: lowerPoint(t, angle), glass: false });
  }
  for (let k = 1; k <= CABIN_POINTS; k++) {
    const a = ((Math.PI / 2) * k) / CABIN_POINTS;
    const roofTop = t > ROOF_FROM && t < ROOF_TO && a > ROOF_ANGLE;
    const pillar = t > 0.1 && t < 0.16 && a < ROOF_ANGLE;
    const glass = cabin > 0.6 && t > GLASS_FROM && t < GLASS_TO && k >= 2 && !roofTop && !pillar;
    half.push({ point: cabinPoint(t, a), glass });
  }
  // 左側：屋根の中央を除いて、右側を逆順に鏡写し
  const ring = [...half];
  for (let k = HALF_RING - 1; k >= 1; k--) {
    const { point, glass } = half[k];
    ring.push({ point: point.clone().setX(-point.x), glass });
  }
  return ring;
}

/** 窓が始まる（step=1）・終わる（step=-1）前後位置：キャビンが十分に立ち上がる所 */
function findGlassEdge(from: number, step: 1 | -1): number {
  let t = from;
  while (cabinAmount(t) <= 0.6 && Math.abs(t) < 1) t += step * 0.005;
  return t;
}

/**
 * 鼻先（end=-1）またはテール（end=1）の面を、下半身の断面の角度 angle の高さで左右に横切るライン。
 * 左右の各位置について、その高さで車体が始まる前後位置を探して点を並べる
 */
function endBar(end: -1 | 1, angle: number, n = 32): THREE.Vector3[] {
  const reach = WIDTH / 2 - 0.3;
  return Array.from({ length: n }, (_, k) => {
    const x = -reach + (2 * reach * k) / (n - 1);
    // 端から内側へ二分探索：その断面の幅が |x| を超える最初の t
    let lo: number = end;
    let hi = end * 0.6;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (lowerPoint(mid, angle).x >= Math.abs(x)) hi = mid;
      else lo = mid;
    }
    const p = lowerPoint(hi, angle);
    return new THREE.Vector3(x, p.y, p.z + end * 0.02);
  });
}

/** (t, 値) の点の間をなめらかにつなぐ */
function interpolate(keys: Array<[number, number]>, t: number): number {
  for (let k = 1; k < keys.length; k++) {
    const [t0, v0] = keys[k - 1];
    const [t1, v1] = keys[k];
    if (t <= t1) return THREE.MathUtils.lerp(v0, v1, THREE.MathUtils.smoothstep(t, t0, t1));
  }
  return keys[keys.length - 1][1];
}

/** ホバーの光：中心が明るく外へ消えていく円 */
function createGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
