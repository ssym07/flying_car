import * as THREE from 'three';
import { buildTrafficCarGeometry } from '../vehicle/Vehicle';
import type { Terrain } from './Terrain';

/**
 * 空を流れる車の列。航路（scripts/build-sky-lanes.mjs の public/sky-lanes.json）の上を、
 * 段ごとに決まった速さ・決まった間隔で隊列を組んで飛ぶ。航路1本につき上り・下りの2車線（左側通行）。
 *
 * - 車は自機のまわり VIEW m 以内だけ置く。車体・窓・ライトはそれぞれ InstancedMesh で一度に描く
 * - 尾の光：車の後ろに航路に沿った光の帯（カメラを向いた細い板の列）。細く明るい芯と、太く淡い外側の2層。
 *   色は段ごと（下から赤・緑・青・赤）。全部の車の帯を1つのジオメトリにまとめ、毎フレーム書き換える
 * - 当たり判定は無し
 */

/** 段ごとの尾の光の色（下の段から） */
const TIER_COLORS = [0xff3348, 0x34ff7a, 0x3a86ff, 0xff3348];
/** 段ごとの速さ (m/s)：100・140・180・220 km/h */
const TIER_SPEED = [28, 39, 50, 61];
/** 航路の種類ごとの車の間隔 (m)：都心の外の道の上、駅のまわりの格子、都心の道の上 */
const GAPS = [90, 170, 150];
/** 車を置く範囲 (m) と、置く車の上限 */
const VIEW = 1800;
const MAX_CARS = 1500;
const MAX_CANDIDATES = 8000;
/** 範囲の中かどうかを調べる、車線の区間の長さ (m) */
const SPAN = 600;
/** 上り・下りの車線の、航路の中心からのずれ (m) */
const LATERAL = 10;
/** 航路の端で車を小さくして出し入れする長さ (m) */
const FADE = 40;
/** 尾の光の長さ (m)・点の数・芯と外側の太さ (m) */
const TRAIL = 70;
const TRAIL_POINTS = 8;
const CORE_WIDTH = 0.35;
const GLOW_WIDTH = 1.6;
/** 遠くの尾の光が細くなりすぎないよう、距離に比例して太らせる割合 */
const GLOW_PER_METER = 0.0022;
/** 車体の色 */
const PAINTS = [0xd9dde4, 0x2b2f36, 0x9aa3ae, 0xf2f2f0, 0x5a6472, 0x8a1f2b, 0x1f3d6b];

interface LaneFile {
  tiers: number[];
  lanes: Array<[number, 0 | 1 | 2, number[]]>;
}

/** 1車線：ローカル座標の点の列と、先頭からの距離 */
interface Lane {
  tier: number;
  points: Float32Array;
  s: Float32Array;
  length: number;
  /** xz の範囲 */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** SPAN m ごとの区間：[始まりの s, 終わりの s, xz の範囲（minX, minZ, maxX, maxZ）] × 区間の数 */
  spans: Float32Array;
  speed: number;
  gap: number;
  phase: number;
  id: number;
}

export class SkyTraffic {
  readonly group = new THREE.Group();
  private lanes: Lane[] = [];
  private time = 0;
  private readonly bodies: THREE.InstancedMesh[];
  private readonly trail: THREE.Mesh;
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly tierColors = TIER_COLORS.map((c) => new THREE.Color(c));
  private readonly paints = PAINTS.map((c) => new THREE.Color(c));
  // 使い回す計算用
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Vector3();
  private readonly f = new THREE.Vector3();
  private readonly x = new THREE.Vector3();
  private readonly y = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  /** 範囲の中の車の候補：車線の番号・車の番号・自機からの距離の2乗 */
  private readonly candLane = new Uint32Array(MAX_CANDIDATES);
  private readonly candN = new Float64Array(MAX_CANDIDATES);
  private readonly candDistance = new Float32Array(MAX_CANDIDATES);
  private readonly order = new Uint32Array(MAX_CANDIDATES);
  private readonly trailPoint = Array.from({ length: TRAIL_POINTS }, () => new THREE.Vector3());

  constructor(private readonly terrain: Terrain) {
    const geo = buildTrafficCarGeometry();
    const paint = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.6,
      roughness: 0.35,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x23344a,
      metalness: 0.8,
      roughness: 0.08,
    });
    const lights = new THREE.MeshBasicMaterial({
      vertexColors: true,
      toneMapped: false,
    });
    this.bodies = [
      new THREE.InstancedMesh(geo.paint, paint, MAX_CARS),
      new THREE.InstancedMesh(geo.glass, glass, MAX_CARS),
      new THREE.InstancedMesh(geo.lights, lights, MAX_CARS),
    ];
    for (const mesh of this.bodies) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.bodies[0].instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 3), 3);

    // 尾の光：車1台につき 2層 × 点の数 × 2頂点。色は rgba（a = 薄れ具合）
    const verts = MAX_CARS * 2 * TRAIL_POINTS * 2;
    this.trailPositions = new Float32Array(verts * 3);
    this.trailColors = new Float32Array(verts * 4);
    const index = new Uint32Array(MAX_CARS * 2 * (TRAIL_POINTS - 1) * 6);
    let k = 0;
    for (let strip = 0; strip < MAX_CARS * 2; strip++) {
      const base = strip * TRAIL_POINTS * 2;
      for (let i = 0; i < TRAIL_POINTS - 1; i++) {
        const a = base + i * 2;
        index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k);
        k += 6;
      }
    }
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    trailGeo.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 4).setUsage(THREE.DynamicDrawUsage));
    trailGeo.setIndex(new THREE.BufferAttribute(index, 1));
    // 芯は色がはっきり出るよう普通の半透明、外側は加算でにじませる（帯の番号：芯 0〜MAX_CARS-1、外側はその後ろ）
    const perStrip = (TRAIL_POINTS - 1) * 6;
    trailGeo.addGroup(0, 0, 0);
    trailGeo.addGroup(MAX_CARS * perStrip, 0, 1);
    const trailMaterial = (blending: THREE.Blending) =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    this.trail = new THREE.Mesh(trailGeo, [trailMaterial(THREE.NormalBlending), trailMaterial(THREE.AdditiveBlending)]);
    this.trail.frustumCulled = false;
    this.group.add(this.trail);

    fetch(`${import.meta.env.BASE_URL}sky-lanes.json`)
      .then((res) => (res.ok ? (res.json() as Promise<LaneFile>) : null))
      .then((data) => {
        if (data) this.lanes = this.buildLanes(data);
      })
      .catch((e) => console.warn('[SkyTraffic] 航路の読込に失敗しました', e));
  }

  /** 航路1本 → 上り・下りの2車線（進む向きの左へずらす） */
  private buildLanes(data: LaneFile): Lane[] {
    const lanes: Lane[] = [];
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [tier, kind, flat] of data.lanes) {
      const center: THREE.Vector3[] = [];
      for (let i = 0; i < flat.length; i += 3) {
        center.push(this.terrain.toLocal(flat[i] / 1e6, flat[i + 1] / 1e6, flat[i + 2] / 10));
      }
      for (const dir of [1, -1]) {
        const pts = dir === 1 ? center : center.slice().reverse();
        const n = pts.length;
        const points = new Float32Array(n * 3);
        const s = new Float32Array(n);
        let minX = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
          const a = pts[Math.max(0, i - 1)];
          const b = pts[Math.min(n - 1, i + 1)];
          const fx = b.x - a.x;
          const fz = b.z - a.z;
          const len = Math.hypot(fx, fz) || 1;
          // 左 = 上 × 前 = (fz, 0, -fx)
          const x = pts[i].x + (fz / len) * LATERAL;
          const z = pts[i].z - (fx / len) * LATERAL;
          points.set([x, pts[i].y, z], i * 3);
          if (i > 0)
            s[i] = s[i - 1] + Math.hypot(x - points[i * 3 - 3], pts[i].y - points[i * 3 - 2], z - points[i * 3 - 1]);
          minX = Math.min(minX, x);
          minZ = Math.min(minZ, z);
          maxX = Math.max(maxX, x);
          maxZ = Math.max(maxZ, z);
        }
        // 区間：始まりの点から SPAN m を超えるまでの点の範囲
        const spans: number[] = [];
        for (let i = 0; i < n - 1;) {
          let j = i + 1;
          while (j < n - 1 && s[j] - s[i] < SPAN) j++;
          let x0 = Infinity;
          let z0 = Infinity;
          let x1 = -Infinity;
          let z1 = -Infinity;
          for (let k = i; k <= j; k++) {
            x0 = Math.min(x0, points[k * 3]);
            z0 = Math.min(z0, points[k * 3 + 2]);
            x1 = Math.max(x1, points[k * 3]);
            z1 = Math.max(z1, points[k * 3 + 2]);
          }
          spans.push(s[i], j === n - 1 ? Infinity : s[j], x0, z0, x1, z1);
          i = j;
        }
        const gap = GAPS[kind];
        lanes.push({
          tier,
          points,
          s,
          length: s[n - 1],
          minX,
          minZ,
          maxX,
          maxZ,
          spans: new Float32Array(spans),
          speed: TIER_SPEED[tier] * (0.95 + rand() * 0.1),
          gap: gap * (0.85 + rand() * 0.3),
          phase: rand() * gap,
          id: lanes.length,
        });
      }
    }
    return lanes;
  }

  /** 車線の上の距離 s の点と、進む向き */
  private at(lane: Lane, s: number, point: THREE.Vector3, forward?: THREE.Vector3): void {
    const S = lane.s;
    let lo = 0;
    let hi = S.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = THREE.MathUtils.clamp((s - S[lo]) / (S[hi] - S[lo] || 1), 0, 1);
    const P = lane.points;
    const ax = P[lo * 3];
    const ay = P[lo * 3 + 1];
    const az = P[lo * 3 + 2];
    point.set(ax + (P[hi * 3] - ax) * t, ay + (P[hi * 3 + 1] - ay) * t, az + (P[hi * 3 + 2] - az) * t);
    forward?.set(P[hi * 3] - ax, P[hi * 3 + 1] - ay, P[hi * 3 + 2] - az).normalize();
  }

  /** @param dt 前のフレームからの秒数（ポーズ中は 0 で止まる） */
  update(camera: THREE.Vector3, dt: number): void {
    this.time += dt;
    let cars = 0;
    const view2 = VIEW * VIEW;
    const pos = this.trailPositions;
    const col = this.trailColors;
    // 範囲の中の車を集め、上限より多ければ自機に近い順に選ぶ
    let found = 0;
    for (const lane of this.lanes) {
      // 範囲の外の車線は飛ばす
      const dx = Math.max(lane.minX - camera.x, 0, camera.x - lane.maxX);
      const dz = Math.max(lane.minZ - camera.z, 0, camera.z - lane.maxZ);
      if (dx * dx + dz * dz > view2) continue;
      // 先頭の車の位置 O から、間隔 gap ごとに後ろへ並ぶ（番号 n の車は s = O - n × gap）。範囲にかかる区間の車だけ見る
      const O = lane.phase + lane.speed * this.time;
      const sp = lane.spans;
      for (let k = 0; k < sp.length; k += 6) {
        const ex = Math.max(sp[k + 2] - camera.x, 0, camera.x - sp[k + 4]);
        const ez = Math.max(sp[k + 3] - camera.z, 0, camera.z - sp[k + 5]);
        if (ex * ex + ez * ez > view2) continue;
        // 区間 [s0, s1) に入る車の番号
        const first = Math.max(0, Math.floor((O - Math.min(sp[k + 1], lane.length)) / lane.gap) + 1);
        const last = Math.min(Math.floor(O / lane.gap), Math.floor((O - sp[k]) / lane.gap));
        for (let n = first; n <= last && found < MAX_CANDIDATES; n++) {
          const s = O - n * lane.gap;
          // 航路の端では小さくして出し入れする
          if (Math.min(s, lane.length - s) < FADE * 0.05) continue;
          this.at(lane, s, this.p);
          const d2 = this.p.distanceToSquared(camera);
          if (d2 > view2) continue;
          this.candLane[found] = lane.id;
          this.candN[found] = n;
          this.candDistance[found] = d2;
          this.order[found] = found;
          found++;
        }
      }
    }
    let chosen = this.order.subarray(0, found);
    if (found > MAX_CARS) {
      const d = this.candDistance;
      chosen = chosen.sort((a, b) => d[a] - d[b]).subarray(0, MAX_CARS);
    }
    for (const c of chosen) {
      const lane = this.lanes[this.candLane[c]];
      const n = this.candN[c];
      const s = lane.phase + lane.speed * this.time - n * lane.gap;
      this.at(lane, s, this.p, this.f);
      const scale = THREE.MathUtils.smoothstep(Math.min(s, lane.length - s), 0, FADE);
      // 車体：前 = -z
      this.q.copy(this.f).negate();
      this.x.set(0, 1, 0).cross(this.q).normalize();
      this.y.copy(this.q).cross(this.x);
      this.m.makeBasis(this.x, this.y, this.q).scale(this.side.setScalar(scale)).setPosition(this.p);
      for (const mesh of this.bodies) mesh.setMatrixAt(cars, this.m);
      const paint = this.paints[(lane.id * 31 + n * 17) % this.paints.length];
      this.bodies[0].setColorAt(cars, paint);

      // 尾の光：車の後ろから航路に沿って TRAIL m
      const color = this.tierColors[lane.tier];
      const distance = Math.sqrt(this.p.distanceToSquared(camera));
      for (let i = 0; i < TRAIL_POINTS; i++) {
        this.at(lane, Math.max(0, s - 2.2 - (TRAIL * i) / (TRAIL_POINTS - 1)), this.trailPoint[i]);
      }
      for (let layer = 0; layer < 2; layer++) {
        const width = (layer === 0 ? CORE_WIDTH : Math.max(GLOW_WIDTH, distance * GLOW_PER_METER)) * scale;
        const strength = layer === 0 ? 0.95 : 0.4;
        const base = (layer * MAX_CARS + cars) * TRAIL_POINTS * 2;
        for (let i = 0; i < TRAIL_POINTS; i++) {
          const a = this.trailPoint[i];
          const b = this.trailPoint[Math.min(i + 1, TRAIL_POINTS - 1)];
          const c = this.trailPoint[Math.max(i - 1, 0)];
          // 帯の向き：航路の向きとカメラへの向きに直角
          this.q.subVectors(c, b);
          this.side
            .subVectors(camera, a)
            .cross(this.q)
            .normalize()
            .multiplyScalar(width / 2);
          const fade = (1 - i / (TRAIL_POINTS - 1)) ** 1.5 * strength;
          const v = (base + i * 2) * 3;
          pos[v] = a.x + this.side.x;
          pos[v + 1] = a.y + this.side.y;
          pos[v + 2] = a.z + this.side.z;
          pos[v + 3] = a.x - this.side.x;
          pos[v + 4] = a.y - this.side.y;
          pos[v + 5] = a.z - this.side.z;
          const c4 = (base + i * 2) * 4;
          for (const o of [c4, c4 + 4]) {
            col[o] = color.r;
            col[o + 1] = color.g;
            col[o + 2] = color.b;
            col[o + 3] = fade;
          }
        }
      }
      cars++;
    }
    for (const mesh of this.bodies) {
      mesh.count = cars;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.bodies[0].instanceColor!.needsUpdate = true;
    const geo = this.trail.geometry;
    geo.groups[0].count = geo.groups[1].count = cars * (TRAIL_POINTS - 1) * 6;
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('color').needsUpdate = true;
  }
}
