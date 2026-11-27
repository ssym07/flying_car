import * as THREE from 'three';
import { TRAINS } from '../core/config';
import { regionUrl } from '../core/region';
import type { RailNetwork } from './RailNetwork';
import type { Terrain } from './Terrain';

/** scripts/build-train-routes.mjs の出力の 1 路線（1 つの向き） */
interface RouteData {
  n: string;
  c: string;
  k: string;
  d: 0 | 1;
  loop: 0 | 1;
  p: number[];
  st: Array<[string, number]>;
  g: Array<[number, number]>;
}

type Kind = (typeof TRAINS.kinds)[string];

/**
 * 1 路線の 1 つの向き。道（緯度経度）はローカル座標に直して、道に沿った距離 s で位置を引く。
 * 時刻表：始発の駅を headway 秒ごとに出て、駅の間は加速・最高速度・減速で走り、駅に dwell 秒止まる
 */
class Route {
  readonly color: THREE.Color;
  readonly kind: Kind;
  readonly loop: boolean;
  readonly headway: number;
  readonly offset: number;
  private readonly lat: number[] = [];
  private readonly lon: number[] = [];
  private x: Float64Array | null = null;
  private z: Float64Array | null = null;
  private s: Float64Array | null = null;
  length = 0;
  /** 各駅の s、見えない区間の s の範囲 */
  private stopS: number[] = [];
  private gapS: Array<[number, number]> = [];
  /** 駅の間ごとの：出る時刻・走る時間・長さ・最高速度 */
  private depart: number[] = [];
  private run: number[] = [];
  private segLen: number[] = [];
  private segV: number[] = [];
  /** 始発の駅を出てから、終点に着く（環状なら 1 周して始発の駅を出る）までの時間（秒） */
  journey = 0;

  constructor(
    private readonly data: RouteData,
    kinds: typeof TRAINS.kinds,
  ) {
    this.color = new THREE.Color(data.c);
    this.kind = kinds[data.k] ?? kinds.train;
    this.loop = data.loop === 1;
    const jr = /^JR|山手線|上野東京ライン|湘南新宿ライン/.test(data.n);
    this.headway = this.kind.headway * (jr ? TRAINS.jrHeadway : 1);
    this.offset = hash(`${data.n}/${data.d}`) * this.headway;
    let lat = 0;
    let lon = 0;
    for (let i = 0; i < data.p.length; i += 2) {
      lat += data.p[i];
      lon += data.p[i + 1];
      this.lat.push(lat / 1e6);
      this.lon.push(lon / 1e6);
    }
  }

  /** 道をローカル座標に直し、時刻表を作る（地形の座標変換が決まってから、最初に使う時に1回） */
  prepare(terrain: Terrain): void {
    if (this.s) return;
    const n = this.lat.length;
    const x = new Float64Array(n);
    const z = new Float64Array(n);
    const s = new Float64Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      terrain.toLocal(this.lat[i], this.lon[i], 0, v);
      x[i] = v.x;
      z[i] = v.z;
      if (i > 0) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
    }
    this.x = x;
    this.z = z;
    this.s = s;
    this.length = s[n - 1];
    this.stopS = this.data.st.map(([, i]) => s[i]);
    this.gapS = this.data.g.map(([a, b]) => [s[a], s[b]]);

    // 時刻表
    const a = TRAINS.accel;
    let t = 0;
    for (let i = 1; i < this.stopS.length; i++) {
      const L = Math.max(1, this.stopS[i] - this.stopS[i - 1]);
      const V = this.kind.speed;
      const r = L >= (V * V) / a ? L / V + V / a : 2 * Math.sqrt(L / a);
      this.depart.push(t);
      this.run.push(r);
      this.segLen.push(L);
      this.segV.push(V);
      t += r + TRAINS.dwell;
    }
    this.journey = t;
  }

  /** 始発の駅を出てから tau 秒後の、列車の真ん中の s */
  centerAt(tau: number): number {
    const dep = this.depart;
    if (dep.length === 0) return this.stopS[0] ?? 0;
    // 駅の間を二分探索
    let lo = 0;
    let hi = dep.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (dep[mid] <= tau) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const t = tau - dep[i];
    const L = this.segLen[i];
    const r = this.run[i];
    const s0 = this.stopS[i];
    if (t >= r) return this.stopS[i + 1];
    const a = TRAINS.accel;
    const V = this.segV[i];
    let d: number;
    if (L >= (V * V) / a) {
      const ta = V / a;
      if (t < ta) d = 0.5 * a * t * t;
      else if (t < r - ta) d = 0.5 * a * ta * ta + V * (t - ta);
      else d = L - 0.5 * a * (r - t) * (r - t);
    } else {
      const tp = r / 2;
      d = t < tp ? 0.5 * a * t * t : L - 0.5 * a * (r - t) * (r - t);
    }
    return s0 + Math.min(L, d);
  }

  /** 道に沿った距離 s の位置（環状は 1 周でまわす）。道の外・見えない区間なら false */
  pointAt(s: number, out: THREE.Vector3): boolean {
    const S = this.s!;
    if (this.loop) s = ((s % this.length) + this.length) % this.length;
    else if (s < 0 || s > this.length) return false;
    for (const [a, b] of this.gapS) if (s >= a && s <= b) return false;
    let lo = 0;
    let hi = S.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - S[lo]) / Math.max(1e-6, S[hi] - S[lo]);
    out.set(this.x![lo] + (this.x![hi] - this.x![lo]) * t, 0, this.z![lo] + (this.z![hi] - this.z![lo]) * t);
    return true;
  }
}

/**
 * 線路の上を走る電車。路線ごとの道（public/train-routes.json）に沿って、時刻表どおりの位置に車両を置く。
 * 車両は線路の高さ（RailNetwork.trackHeightAt）に乗せ、線路の無い所（トンネル・地下・まだ読んでいないタイル）は描かない。
 * 描くのはカメラから TRAINS.range m までの電車だけ。夜は窓が光り、夜中（TRAINS.closed）は走らない。
 * 時刻表の時計はゲームの時刻とは別に、実際の時間で進む（時刻を止めていても電車は走る）
 */
export class Trains {
  readonly group = new THREE.Group();
  private routes: Route[] = [];
  private clock = 0;
  private readonly bodies: THREE.InstancedMesh;
  private readonly stripes: THREE.InstancedMesh;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly front = new THREE.Vector3();
  private readonly rear = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(
    private readonly terrain: Terrain,
    private readonly rails: RailNetwork,
  ) {
    const { map, mask } = createCarTextures();
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      map,
      emissiveMap: mask,
      emissive: 0xfff0d6,
      emissiveIntensity: 0,
      roughness: 0.45,
      metalness: 0.25,
    });
    const max = 1500;
    this.bodies = new THREE.InstancedMesh(createCarGeometry(), this.bodyMaterial, max);
    // 帯：車体の横の、窓の下の高さに、少し外へ出して重ねる
    const stripeGeometry = new THREE.BoxGeometry(1, 0.09, 1).translate(0, 0.3, 0);
    this.stripes = new THREE.InstancedMesh(stripeGeometry, new THREE.MeshStandardMaterial({ roughness: 0.5 }), max);
    for (const mesh of [this.bodies, this.stripes]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
    // 色を付ける準備（setColorAt で instanceColor が作られる）
    this.bodies.setColorAt(0, this.color.set(0xffffff));
    this.stripes.setColorAt(0, this.color.set(0xffffff));

    fetch(regionUrl('train-routes.json'))
      .then((res) => (res.ok && res.headers.get('content-type')?.includes('json') ? res.json() : null))
      .then((data: { lines: RouteData[] } | null) => {
        if (data) this.routes = data.lines.map((d) => new Route(d, TRAINS.kinds));
      })
      .catch((e) => console.warn('[Trains] 読込に失敗しました', e));
  }

  /**
   * 毎フレーム呼ぶ
   * @param night 夜の度合い（0..1）。窓の明るさ
   * @param minutes ゲームの時刻（日本時間の 0 時からの分）。夜中は走らない
   */
  update(camera: THREE.Camera, dt: number, night: number, minutes: number): void {
    this.clock += Math.min(dt, 0.25);
    this.bodyMaterial.emissiveIntensity = night * TRAINS.windowGlow;
    const hour = minutes / 60;
    const [c0, c1] = TRAINS.closed;
    let count = 0;
    if (this.routes.length > 0 && !(hour >= c0 && hour < c1)) {
      const cam = camera.position;
      const range2 = TRAINS.range * TRAINS.range;
      for (const route of this.routes) {
        route.prepare(this.terrain);
        if (route.journey <= 0) continue;
        const K = route.kind;
        const trainLength = K.cars * K.length + (K.cars - 1) * TRAINS.gap;
        // いま走っている列車：出た時刻 = offset + k × headway で、終点に着くまで（環状は 1 周して始発の駅に戻るまで。
        // 戻った所で次の列車と入れ替わるので、ずっと回っているように見える）
        const elapsed = this.clock - route.offset;
        const first = Math.ceil((elapsed - route.journey) / route.headway);
        const last = Math.floor(elapsed / route.headway);
        for (let k = Math.max(first, last - 200); k <= last; k++) {
          const tau = elapsed - k * route.headway;
          if (tau < 0 || tau >= route.journey) continue;
          const center = route.centerAt(tau);
          if (!route.pointAt(center, this.front)) continue;
          const dx = this.front.x - cam.x;
          const dz = this.front.z - cam.z;
          if (dx * dx + dz * dz > range2) continue;
          // 車両：列車の真ん中を駅に止める。先頭は s の大きい方
          const head = center + trainLength / 2;
          for (let c = 0; c < K.cars && count < this.bodies.instanceMatrix.count; c++) {
            const f = head - c * (K.length + TRAINS.gap);
            if (this.placeCar(route, f, f - K.length, count)) count++;
          }
        }
      }
    }
    this.bodies.count = count;
    this.stripes.count = count;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.stripes.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.stripes.instanceColor) this.stripes.instanceColor.needsUpdate = true;
  }

  /** 車両を 1 両置く（前の端 sFront・後ろの端 sRear）。置けなければ false */
  private placeCar(route: Route, sFront: number, sRear: number, index: number): boolean {
    if (!route.pointAt(sFront, this.front) || !route.pointAt(sRear, this.rear)) return false;
    const yf = this.rails.trackHeightAt(this.front.x, this.front.z);
    const yr = this.rails.trackHeightAt(this.rear.x, this.rear.z);
    if (yf === null || yr === null) return false;
    this.front.y = yf;
    this.rear.y = yr;
    const K = route.kind;
    this.fwd.subVectors(this.front, this.rear).normalize();
    this.side.crossVectors(this.fwd, UP).normalize();
    this.up.crossVectors(this.side, this.fwd).normalize();
    const cx = (this.front.x + this.rear.x) / 2;
    const cy = (this.front.y + this.rear.y) / 2 + TRAINS.floor;
    const cz = (this.front.z + this.rear.z) / 2;
    const m = this.matrix;
    const f = this.fwd;
    const u = this.up;
    const sd = this.side;
    m.set(
      f.x * K.length, u.x * K.height, sd.x * K.width, cx,
      f.y * K.length, u.y * K.height, sd.y * K.width, cy,
      f.z * K.length, u.z * K.height, sd.z * K.width, cz,
      0, 0, 0, 1,
    );
    this.bodies.setMatrixAt(index, m);
    this.bodies.setColorAt(index, this.color.set(K.body));
    // 帯は車体より少し外へ（幅 +4cm）、長さは少し短く
    const w = K.width + 0.04;
    const l = K.length * 0.985;
    m.set(
      f.x * l, u.x * K.height, sd.x * w, cx,
      f.y * l, u.y * K.height, sd.y * w, cy,
      f.z * l, u.z * K.height, sd.z * w, cz,
      0, 0, 0, 1,
    );
    this.stripes.setMatrixAt(index, m);
    this.stripes.setColorAt(index, route.color);
    return true;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** 0..1 の擬似乱数（文字列から） */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * 車両の形：長さ・高さ・幅 1 の箱（底が 0）。横の面（±z）に車体の画像を貼り、屋根・床・前後の面は画像の左端の
 * 無地の所を使う（屋根に窓が並ばないように）
 */
function createCarGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry の面の順：+x, -x, +y, -y, +z, -z（それぞれ 4 頂点）
  for (const face of [0, 1, 2, 3]) {
    for (let k = 0; k < 4; k++) uv.setXY(face * 4 + k, 0.004, 0.9);
  }
  uv.needsUpdate = true;
  return g;
}

/** 車体の横の画像（灰色の濃淡。色は車両ごとに掛ける）と、夜に光る窓のマスク */
function createCarTextures(): { map: THREE.Texture; mask: THREE.Texture } {
  const W = 512;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = W;
  maskCanvas.height = H;
  const m = maskCanvas.getContext('2d')!;
  m.fillStyle = '#000';
  m.fillRect(0, 0, W, H);
  // y は上が 0（画像の座標）。v = 1 - y / H
  const Y = (v: number) => (1 - v) * H;
  // 車体
  g.fillStyle = '#e6e8ea';
  g.fillRect(0, 0, W, H);
  // 屋根の縁と、床下（台車のまわり）
  g.fillStyle = '#b9bdc2';
  g.fillRect(0, Y(1), W, Y(0.9) - Y(1));
  g.fillStyle = '#3a3d42';
  g.fillRect(8, Y(0.12), W - 8, Y(0) - Y(0.12));
  // 窓と扉（左端の 8px は屋根などに使う無地）
  const doors = [0.12, 0.37, 0.62, 0.87];
  const glass = '#26313d';
  g.fillStyle = glass;
  m.fillStyle = '#fff';
  for (let i = 0; i < doors.length + 1; i++) {
    const x0 = i === 0 ? 0.03 : doors[i - 1] + 0.05;
    const x1 = i === doors.length ? 0.97 : doors[i] - 0.05;
    if (x1 - x0 < 0.02) continue;
    g.fillRect(x0 * W + 8, Y(0.8), (x1 - x0) * W - 4, Y(0.45) - Y(0.8));
    m.fillRect(x0 * W + 8, Y(0.8), (x1 - x0) * W - 4, Y(0.45) - Y(0.8));
  }
  for (const d of doors) {
    // 扉（少し濃い枠）と扉の窓
    g.fillStyle = '#c4c8cc';
    g.fillRect((d - 0.035) * W, Y(0.86), 0.07 * W, Y(0.14) - Y(0.86));
    g.fillStyle = glass;
    g.fillRect((d - 0.025) * W, Y(0.8), 0.05 * W, Y(0.5) - Y(0.8));
    m.fillRect((d - 0.025) * W, Y(0.8), 0.05 * W, Y(0.5) - Y(0.8));
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const mask = new THREE.CanvasTexture(maskCanvas);
  mask.colorSpace = THREE.SRGBColorSpace;
  return { map, mask };
}
