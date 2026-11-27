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
  /** 帯（色・下の端・高さ。車体の高さに対する割合） */
  readonly bands: Array<{ color: THREE.Color; at: number; h: number }>;
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
    const style = TRAINS.styles.find((st) => new RegExp(st.match).test(data.n)) ?? TRAINS.styles[TRAINS.styles.length - 1];
    this.bands = style.bands.slice(0, BAND_SLOTS).map(([c, at, h]) => ({ color: c === null ? this.color : new THREE.Color(c), at, h }));
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
 *
 * 見た目は首都圏の JR の通勤電車（E233・E231・E235 系）に寄せる：ステンレスの銀色の車体（屋根の肩が丸い）、
 * 黒い枠の窓と 4 つの扉、路線ごとの色の帯（TRAINS.styles）、屋根の冷房装置と床下の機器。先頭車の前面は大きな黒いガラスと
 * 行き先表示・前照灯・白いスカート。前照灯はいつも点いていて（夜は明るく、前へ光がにじむ）、最後尾は赤い尾灯
 */
export class Trains {
  readonly group = new THREE.Group();
  private routes: Route[] = [];
  private clock = 0;
  /** 車両の部品：車体・床下の機器・屋根の冷房装置・帯（BAND_SLOTS 本）・前面（先頭）・後面（最後尾）・前照灯のにじみ */
  private readonly bodies: THREE.InstancedMesh;
  private readonly unders: THREE.InstancedMesh;
  private readonly roofUnits: THREE.InstancedMesh;
  private readonly bands: THREE.InstancedMesh[] = [];
  private readonly fronts: THREE.InstancedMesh;
  private readonly rears: THREE.InstancedMesh;
  private readonly glows: THREE.InstancedMesh;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly frontMaterial: THREE.MeshStandardMaterial;
  private readonly rearMaterial: THREE.MeshStandardMaterial;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private readonly counts = { car: 0, band: [0, 0, 0], front: 0, rear: 0 };
  private readonly front = new THREE.Vector3();
  private readonly rear = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(
    private readonly terrain: Terrain,
    private readonly rails: RailNetwork,
  ) {
    const tex = createCarTextures();
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      map: tex.side,
      emissiveMap: tex.sideMask,
      emissive: 0xfff0d6,
      emissiveIntensity: 0,
      roughness: 0.38,
      metalness: 0.35,
    });
    this.frontMaterial = new THREE.MeshStandardMaterial({
      map: tex.face,
      emissiveMap: tex.headMask,
      emissive: 0xfff6e8,
      roughness: 0.3,
      metalness: 0.3,
    });
    this.rearMaterial = new THREE.MeshStandardMaterial({
      map: tex.face,
      emissiveMap: tex.tailMask,
      emissive: 0xff2a1a,
      roughness: 0.3,
      metalness: 0.3,
    });
    this.glowMaterial = new THREE.MeshBasicMaterial({
      map: tex.glow,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const max = 1600;
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number, colored: boolean) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (colored) mesh.setColorAt(0, this.color.set(0xffffff));
      this.group.add(mesh);
      return mesh;
    };
    this.bodies = make(createBodyGeometry(), this.bodyMaterial, max, true);
    this.unders = make(unitBox(), new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.8 }), max, false);
    this.roofUnits = make(unitBox(), new THREE.MeshStandardMaterial({ color: 0x9da3aa, roughness: 0.6, metalness: 0.3 }), max, false);
    for (let i = 0; i < BAND_SLOTS; i++) {
      this.bands.push(make(unitBox(), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }), max, true));
    }
    this.fronts = make(unitBox(), this.frontMaterial, 200, false);
    this.rears = make(unitBox(), this.rearMaterial, 200, false);
    // 前照灯のにじみ：前面の少し前に立てた、前を向いた板（加算で重ねる）
    this.glows = make(new THREE.PlaneGeometry(1, 1).rotateY(Math.PI / 2), this.glowMaterial, 200, false);
    // 影を落とさない・受けない（数が多く、動くので）
    for (const mesh of this.group.children) mesh.userData.noShadow = true;

    fetch(regionUrl('train-routes.json'))
      .then((res) => (res.ok && res.headers.get('content-type')?.includes('json') ? res.json() : null))
      .then((data: { lines: RouteData[] } | null) => {
        if (data) this.routes = data.lines.map((d) => new Route(d, TRAINS.kinds));
      })
      .catch((e) => console.warn('[Trains] 読込に失敗しました', e));
  }

  /**
   * 毎フレーム呼ぶ
   * @param night 夜の度合い（0..1）。窓・前照灯の明るさ
   * @param minutes ゲームの時刻（日本時間の 0 時からの分）。夜中は走らない
   */
  update(camera: THREE.Camera, dt: number, night: number, minutes: number): void {
    this.clock += Math.min(dt, 0.25);
    this.bodyMaterial.emissiveIntensity = night * TRAINS.windowGlow;
    const lamp = THREE.MathUtils.lerp(TRAINS.headlightDay, TRAINS.headlightNight, night);
    this.frontMaterial.emissiveIntensity = lamp;
    this.rearMaterial.emissiveIntensity = lamp * 0.8;
    this.glowMaterial.opacity = TRAINS.glow * night;
    const c = this.counts;
    c.car = 0;
    c.band.fill(0);
    c.front = 0;
    c.rear = 0;
    const hour = minutes / 60;
    const [c0, c1] = TRAINS.closed;
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
          for (let n = 0; n < K.cars && c.car < this.bodies.instanceMatrix.count; n++) {
            const f = head - n * (K.length + TRAINS.gap);
            this.placeCar(route, f, f - K.length, n === 0, n === K.cars - 1);
          }
        }
      }
    }
    const finish = (mesh: THREE.InstancedMesh, count: number) => {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    finish(this.bodies, c.car);
    finish(this.unders, c.car);
    finish(this.roofUnits, c.car);
    this.bands.forEach((m, i) => finish(m, c.band[i]));
    finish(this.fronts, c.front);
    finish(this.rears, c.rear);
    finish(this.glows, night > 0.01 ? c.front : 0);
  }

  /** 車両を 1 両置く（前の端 sFront・後ろの端 sRear。先頭車なら前面、最後尾なら後面も） */
  private placeCar(route: Route, sFront: number, sRear: number, isHead: boolean, isTail: boolean): void {
    if (!route.pointAt(sFront, this.front) || !route.pointAt(sRear, this.rear)) return;
    const yf = this.rails.trackHeightAt(this.front.x, this.front.z);
    const yr = this.rails.trackHeightAt(this.rear.x, this.rear.z);
    if (yf === null || yr === null) return;
    this.front.y = yf;
    this.rear.y = yr;
    const K = route.kind;
    this.fwd.subVectors(this.front, this.rear).normalize();
    this.side.crossVectors(this.fwd, UP).normalize();
    this.up.crossVectors(this.side, this.fwd).normalize();
    this.center.addVectors(this.front, this.rear).multiplyScalar(0.5);
    const c = this.counts;
    const i = c.car++;
    const L = K.length;
    const H = K.height;
    const W = K.width;
    const floor = TRAINS.floor;
    // 車体
    this.part(this.bodies, i, L, H, W, floor, 0);
    this.bodies.setColorAt(i, this.color.set(K.body));
    // 床下の機器（台車のあたりは空ける代わりに少し短く・細く）
    this.part(this.unders, i, L * 0.86, floor - 0.2, W * 0.82, 0.2, 0);
    // 屋根の冷房装置
    this.part(this.roofUnits, i, L * 0.18, 0.32, W * 0.55, floor + H - 0.02, 0);
    // 帯：車体より少し外へ出し、前後の面にも回す
    route.bands.forEach((b, k) => {
      const j = c.band[k]++;
      // 窓より上の帯（中央線の屋根の下の帯）は前面の黒いガラスにかからないよう、前後の面には回さない
      this.part(this.bands[k], j, b.at > 0.6 ? L - 0.1 : L + 0.09, H * b.h, W + 0.04, floor + H * b.at, 0);
      this.bands[k].setColorAt(j, b.color);
    });
    // 前面（先頭）・後面（最後尾）：車体の端の少し外に貼る
    if (isHead && c.front < this.fronts.instanceMatrix.count) {
      const j = c.front++;
      this.part(this.fronts, j, 0.05, H, W + 0.01, floor, L / 2 + 0.01);
      // 前照灯のにじみ：前面の少し前
      this.part(this.glows, j, 1, H * 0.7, W * 2.2, floor + H * 0.895, L / 2 + 0.4);
    }
    if (isTail && c.rear < this.rears.instanceMatrix.count) {
      this.fwd.negate();
      this.side.negate();
      this.part(this.rears, c.rear++, 0.05, H, W + 0.01, floor, L / 2 + 0.01);
    }
  }

  /**
   * 部品を置く。部品の形は長さ・高さ・幅 1 の箱（底が 0）。車両の真ん中から、上へ upOffset m・前へ along m の所に、
   * 長さ l・高さ h・幅 w にして、車両の向き（fwd・up・side）にそろえる
   */
  private part(mesh: THREE.InstancedMesh, index: number, l: number, h: number, w: number, upOffset: number, along: number): void {
    const f = this.fwd;
    const u = this.up;
    const sd = this.side;
    const x = this.center.x + u.x * upOffset + f.x * along;
    const y = this.center.y + u.y * upOffset + f.y * along;
    const z = this.center.z + u.z * upOffset + f.z * along;
    this.matrix.set(
      f.x * l, u.x * h, sd.x * w, x,
      f.y * l, u.y * h, sd.y * w, y,
      f.z * l, u.z * h, sd.z * w, z,
      0, 0, 0, 1,
    );
    mesh.setMatrixAt(index, this.matrix);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
/** 帯の本数の上限 */
const BAND_SLOTS = 3;

/** 0..1 の擬似乱数（文字列から） */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/** 長さ・高さ・幅 1 の箱（底が 0）。前の面（+x）は画像全体、ほかの面も画像全体を貼る */
function unitBox(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

/**
 * 車体の形：長さ・高さ・幅 1、底が 0。横の断面は、縦の側面から屋根の肩が丸くなって平らな屋根へ。
 * 横の面には車体の画像（u = 前後、v = 高さ）を貼り、屋根と前後の端の面は画像の左端の無地の所を使う
 */
export function createBodyGeometry(): THREE.BufferGeometry {
  // 断面（片側、下から）：[横の位置（中心から、幅に対する割合）, 高さ]
  const half: Array<[number, number]> = [
    [0.5, 0],
    [0.5, 0.84],
    [0.485, 0.91],
    [0.45, 0.96],
    [0.38, 0.99],
    [0.25, 1],
    [0, 1],
  ];
  const ring: Array<[number, number]> = [...half, ...[...half].reverse().slice(1).map(([z, y]) => [-z, y] as [number, number])];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const plain = [0.004, 0.95];
  // 側面と屋根：断面の点ごとに、前後 2 点
  for (let k = 0; k < ring.length; k++) {
    const [z, y] = ring[k];
    const roof = y > 0.88;
    for (const x of [-0.5, 0.5]) {
      pos.push(x, y, z);
      uv.push(...(roof ? plain : [x + 0.5, y / 0.88]));
    }
  }
  for (let k = 0; k + 1 < ring.length; k++) {
    const a = k * 2;
    const b = (k + 1) * 2;
    // 外を向く面にする（反時計回り）
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  // 前後の端の面（扇形）
  for (const x of [-0.5, 0.5]) {
    const base = pos.length / 3;
    pos.push(x, 0.5, 0);
    uv.push(...plain);
    for (const [z, y] of ring) {
      pos.push(x, y, z);
      uv.push(...plain);
    }
    for (let k = 0; k + 1 < ring.length; k++) {
      if (x > 0) idx.push(base, base + 2 + k, base + 1 + k);
      else idx.push(base, base + 1 + k, base + 2 + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 画像：車体の横（銀色のステンレス・黒い枠の窓・4 つの扉。色は車両ごとに掛ける）と夜に光る窓、
 * 前面（黒いガラス・行き先表示・前照灯・白いスカート）と、前照灯・尾灯の光る所、前照灯のにじみ
 */
function createCarTextures(): Record<'side' | 'sideMask' | 'face' | 'headMask' | 'tailMask' | 'glow', THREE.Texture> {
  const canvas = (w: number, h: number, fill: string) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = fill;
    g.fillRect(0, 0, w, h);
    return { c, g };
  };
  const texture = (c: HTMLCanvasElement, color = true) => {
    const t = new THREE.CanvasTexture(c);
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };

  // ---- 横（幅 1024 = 長さ、高さ 128 = 車体の床から屋根の肩まで。v = 0 が床） ----
  const W = 1024;
  const H = 128;
  const side = canvas(W, H, '#d9dde1');
  const mask = canvas(W, H, '#000');
  const g = side.g;
  const m = mask.g;
  const Y = (v: number) => (1 - v) * H;
  // ステンレスのビード（細い縦の筋）と、下の縁
  for (let x = 12; x < W; x += 6) {
    g.fillStyle = x % 12 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.06)';
    g.fillRect(x, Y(0.42), 2, Y(0.06) - Y(0.42));
  }
  g.fillStyle = '#9aa0a6';
  g.fillRect(12, Y(0.06), W, Y(0) - Y(0.06));
  // 窓と扉（左端の 12px は屋根・端の面に使う無地）
  const doors = [0.125, 0.375, 0.625, 0.875];
  const doorW = 0.065;
  const frame = '#2a2e33';
  const glass = '#1b232c';
  const win = (x0: number, x1: number, v0: number, v1: number) => {
    g.fillStyle = frame;
    g.fillRect(x0 * W + 12 - 2, Y(v1) - 2, (x1 - x0) * W + 4, Y(v0) - Y(v1) + 4);
    g.fillStyle = glass;
    g.fillRect(x0 * W + 12, Y(v1), (x1 - x0) * W, Y(v0) - Y(v1));
    // 空の映り込み
    g.fillStyle = 'rgba(160,190,220,0.18)';
    g.fillRect(x0 * W + 12, Y(v1), (x1 - x0) * W, (Y(v0) - Y(v1)) * 0.35);
    m.fillStyle = '#fff';
    m.fillRect(x0 * W + 12, Y(v1), (x1 - x0) * W, Y(v0) - Y(v1));
  };
  const edges = [0.02, ...doors.flatMap((d) => [d - doorW / 2 - 0.02, d + doorW / 2 + 0.02]), 0.98];
  for (let i = 0; i < edges.length; i += 2) {
    const x0 = edges[i];
    const x1 = edges[i + 1];
    // 扉の間は大きな窓を 2 枚
    const mid = (x0 + x1) / 2;
    if (x1 - x0 > 0.12) {
      win(x0, mid - 0.006, 0.47, 0.8);
      win(mid + 0.006, x1, 0.47, 0.8);
    } else win(x0, x1, 0.47, 0.8);
  }
  for (const d of doors) {
    // 扉：少し濃い板と、縦長の窓
    g.fillStyle = '#c3c8cd';
    g.fillRect((d - doorW / 2) * W + 12, Y(0.9), doorW * W, Y(0.07) - Y(0.9));
    g.fillStyle = '#8d939a';
    g.fillRect(d * W + 11, Y(0.9), 2, Y(0.07) - Y(0.9));
    win(d - doorW / 2 + 0.008, d - 0.004, 0.43, 0.83);
    win(d + 0.004, d + doorW / 2 - 0.008, 0.43, 0.83);
  }

  // ---- 前面（幅 256 = 車体の幅、高さ 256 = 車体の高さ。v = 0 が床） ----
  const F = 256;
  const face = canvas(F, F, '#dfe3e6');
  const head = canvas(F, F, '#000');
  const tail = canvas(F, F, '#000');
  const fg = face.g;
  const FY = (v: number) => (1 - v) * F;
  const rect = (c: CanvasRenderingContext2D, x0: number, v0: number, x1: number, v1: number, r: number) => {
    c.beginPath();
    c.roundRect(x0 * F, FY(v1), (x1 - x0) * F, FY(v0) - FY(v1), r);
    c.fill();
  };
  // 大きな黒いガラス（窓・行き先表示・灯りをまとめた黒い面）
  fg.fillStyle = '#11161b';
  rect(fg, 0.07, 0.46, 0.93, 0.95, 18);
  // 運転席の窓の映り込み
  fg.fillStyle = 'rgba(120,150,185,0.25)';
  rect(fg, 0.1, 0.6, 0.9, 0.82, 10);
  // 行き先表示（橙色の LED）
  fg.fillStyle = '#2a1a0a';
  rect(fg, 0.33, 0.86, 0.67, 0.92, 3);
  fg.fillStyle = '#ff9a2a';
  for (let x = 0.36; x < 0.64; x += 0.035) fg.fillRect(x * F, FY(0.905), 0.022 * F, FY(0.875) - FY(0.905));
  // 前照灯（上の両角）
  fg.fillStyle = '#f5f2e8';
  rect(fg, 0.11, 0.87, 0.2, 0.92, 6);
  rect(fg, 0.8, 0.87, 0.89, 0.92, 6);
  // 下の銀の部分と、連結器のまわり・白いスカート
  fg.fillStyle = '#3a3f45';
  rect(fg, 0.3, 0.02, 0.7, 0.2, 4);
  fg.fillStyle = '#eef0f1';
  fg.beginPath();
  fg.moveTo(0.06 * F, FY(0.14));
  fg.lineTo(0.94 * F, FY(0.14));
  fg.lineTo(0.86 * F, FY(0.0));
  fg.lineTo(0.14 * F, FY(0.0));
  fg.closePath();
  fg.fill();
  // 光る所：前照灯と行き先表示（前）、尾灯（後ろ。同じ上の両角）
  head.g.fillStyle = '#fff';
  rect(head.g, 0.11, 0.87, 0.2, 0.92, 6);
  rect(head.g, 0.8, 0.87, 0.89, 0.92, 6);
  head.g.fillStyle = '#ffae5a';
  rect(head.g, 0.33, 0.86, 0.67, 0.92, 3);
  tail.g.fillStyle = '#fff';
  rect(tail.g, 0.11, 0.86, 0.2, 0.9, 6);
  rect(tail.g, 0.8, 0.86, 0.89, 0.9, 6);

  // ---- 前照灯のにじみ（2 つのぼんやりした光） ----
  const glow = canvas(128, 64, 'rgba(0,0,0,0)');
  glow.g.clearRect(0, 0, 128, 64);
  for (const cx of [26, 102]) {
    const grad = glow.g.createRadialGradient(cx, 32, 0, cx, 32, 26);
    grad.addColorStop(0, 'rgba(255,248,230,0.9)');
    grad.addColorStop(1, 'rgba(255,248,230,0)');
    glow.g.fillStyle = grad;
    glow.g.fillRect(0, 0, 128, 64);
  }
  return {
    side: texture(side.c),
    sideMask: texture(mask.c),
    face: texture(face.c),
    headMask: texture(head.c),
    tailMask: texture(tail.c),
    glow: texture(glow.c),
  };
}
