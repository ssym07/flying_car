import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AIRPORTS } from '../core/config';
import { regionUrl } from '../core/region';
import { approxMeters, decode, MeshBuilder } from './RoadNetwork';
import type { ChunkListener, Terrain } from './Terrain';

/**
 * 空港の滑走路・誘導路と、駐機している飛行機（public/airports.json。scripts/fetch-airports.mjs で作る）。
 * 空港の芝地と駐機場は地面の種類（landuse.ts）で塗る。
 *
 * - 滑走路：暗いアスファルトに、端の白線と中心線の破線。端（進入端）には縞模様（ピアノキー）と滑走路の番号
 * - 誘導路：少し明るいアスファルトに、黄色の中心線
 * - 飛行機：駐機位置に、白い胴体・翼・エンジンと、色の付いた尾翼の旅客機
 * - 管制塔：白い細い塔の上に、外へ傾いた暗いガラスの管制室と屋根・アンテナ
 * - 搭乗橋：ターミナルの側の丸い柱（回転台）から、ガラスの帯の入った灰色の通路が飛行機の扉の高さへ下がり、
 *   先に箱形の乗降口。先の近くを、車輪の付いた2本の脚で支える（PLATEAU の箱は scripts/build-station-cutouts.mjs で消す）
 * 地形に沿わせて置くので、置く所の地形が読まれてから作る（作ったものは捨てない）
 */
interface AirportFile {
  r: Array<[number, number[], string, string, 0 | 1, 0 | 1]>;
  t: Array<[number, number[]]>;
  s: Array<[number, number, number]>;
  c: Array<[number, number, number]>;
  j?: number[][];
}

interface Pending {
  /** 地形の高さを調べる点（全部読まれていたら作る） */
  probe: Array<[number, number]>;
  build: () => void;
}

export class Airports implements ChunkListener {
  readonly group = new THREE.Group();
  private pending: Pending[] = [];
  private readonly runwayMaterial = createRunwayMaterial();
  private readonly taxiwayMaterial = createTaxiwayMaterial();
  private readonly towerMaterials = {
    white: new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.55 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x2c4a5c, roughness: 0.12, metalness: 0.6 }),
  };
  private readonly bridgeMaterials = {
    metal: new THREE.MeshStandardMaterial({ color: 0xb7bcc2, roughness: 0.45, metalness: 0.35 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x3c5260, roughness: 0.15, metalness: 0.5 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.7 }),
  };
  private readonly aircraft: AircraftFleet;

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
    this.aircraft = new AircraftFleet();
    this.group.add(this.aircraft.body, this.aircraft.tail);
    fetch(regionUrl('airports.json'))
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<AirportFile>) : null,
      )
      .then((data) => data && this.prepare(data))
      .catch((e) => console.warn('[Airports] 読込に失敗しました', e));
  }

  private prepare(data: AirportFile): void {
    this.aircraft.reserve(data.s.length);
    for (const [width, coords, startLabel, endLabel, startEnd, endEnd] of data.r) {
      const pts = decode(coords);
      this.pending.push({
        probe: pts,
        build: () => this.buildRunway(pts, width, [startEnd ? startLabel : null, endEnd ? endLabel : null]),
      });
    }
    for (const [width, coords] of data.t) {
      const pts = decode(coords);
      this.pending.push({ probe: pts, build: () => this.buildTaxiway(pts, width) });
    }
    for (const coords of data.j ?? []) {
      const pts = decode(coords);
      this.pending.push({ probe: pts, build: () => this.buildJetBridge(pts) });
    }
    for (const [lat, lon, height] of data.c) {
      const p: [number, number] = [lat / 1e6, lon / 1e6];
      this.pending.push({ probe: [p], build: () => this.buildTower(p, height) });
    }
    for (const [lat, lon, heading] of data.s) {
      const p: [number, number] = [lat / 1e6, lon / 1e6];
      this.pending.push({ probe: [p], build: () => this.placeAircraft(p, heading / 10) });
    }
    this.tryBuild();
  }

  onChunkAdded(): void {
    this.tryBuild();
  }

  onChunkRemoved(): void {
    // 作ったものは捨てない（空港は小さい）
  }

  private tryBuild(): void {
    if (this.pending.length === 0) return;
    this.pending = this.pending.filter((p) => {
      if (p.probe.some(([lat, lon]) => this.terrain.surfaceHeightAt(lat, lon) === null)) return true;
      p.build();
      return false;
    });
  }

  /** 中心線に沿った帯（幅 width、地面から lift m）。u：左端 0〜右端 1、v：中心線に沿った長さ (m) */
  private strip(points: Array<[number, number]>, width: number, lift: number) {
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i === 0) {
        samples.push(points[0]);
        s.push(0);
        continue;
      }
      const [plat, plon] = points[i - 1];
      const [lat, lon] = points[i];
      const len = approxMeters(plat, plon, lat, lon);
      const steps = Math.max(1, Math.ceil(len / AIRPORTS.densifyStep));
      for (let k = 1; k <= steps; k++) {
        samples.push([plat + ((lat - plat) * k) / steps, plon + ((lon - plon) * k) / steps]);
        s.push(s[s.length - 1] + len / steps);
      }
    }
    const pts = samples.map(([lat, lon]) =>
      this.terrain.toLocal(lat, lon, (this.terrain.surfaceHeightAt(lat, lon) ?? 0) + lift),
    );
    const up = new THREE.Vector3(0, 1, 0);
    const sides = pts.map((_, i) => {
      const t = new THREE.Vector3()
        .subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)])
        .setY(0)
        .normalize();
      return new THREE.Vector3().crossVectors(up, t).normalize();
    });
    const at = (i: number, across: number) => pts[i].clone().addScaledVector(sides[i], across);
    return { pts, sides, s, at, half: width / 2 };
  }

  private buildRunway(points: Array<[number, number]>, width: number, labels: [string | null, string | null]): void {
    const { pts, sides, s, at, half } = this.strip(points, width, AIRPORTS.runwayLift);
    const b = new MeshBuilder();
    let prev: [number, number] | null = null;
    for (let i = 0; i < pts.length; i++) {
      const v = s[i] / AIRPORTS.dashPeriod;
      const l = b.vertex(at(i, half), 0, v);
      const r = b.vertex(at(i, -half), 1, v);
      if (prev) b.quad(prev[0], prev[1], l, r);
      prev = [l, r];
    }
    const g = b.build();
    if (g) this.group.add(new THREE.Mesh(g, this.runwayMaterial));
    // 進入端：端から滑走路の中へ AIRPORTS.thresholdLength m の板に、縞模様と番号の画像を貼る
    const total = s[s.length - 1];
    for (const [end, label] of labels.entries()) {
      if (label === null || total < AIRPORTS.thresholdLength * 2) continue;
      const tb = new MeshBuilder();
      let p: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        // 端からの距離（端 = 0 から中へ増える）
        const d = end === 0 ? s[i] : total - s[i];
        if (d > AIRPORTS.thresholdLength + AIRPORTS.densifyStep) continue;
        const v = Math.min(d, AIRPORTS.thresholdLength) / AIRPORTS.thresholdLength;
        // 中へ向かって左が u = 0（終点の端は向きが逆なので、左右も入れ替える）
        const sgn = end === 0 ? 1 : -1;
        const lift = new THREE.Vector3(0, AIRPORTS.markingLift, 0);
        const l = tb.vertex(
          pts[i]
            .clone()
            .addScaledVector(sides[i], half * sgn)
            .add(lift),
          0,
          v,
        );
        const r = tb.vertex(
          pts[i]
            .clone()
            .addScaledVector(sides[i], -half * sgn)
            .add(lift),
          1,
          v,
        );
        if (p) tb.quad(p[0], p[1], l, r);
        p = [l, r];
      }
      const tg = tb.build();
      if (tg) this.group.add(new THREE.Mesh(tg, createThresholdMaterial(label, width)));
    }
  }

  private buildTaxiway(points: Array<[number, number]>, width: number): void {
    const { pts, s, at, half } = this.strip(points, width, AIRPORTS.taxiwayLift);
    const b = new MeshBuilder();
    let prev: [number, number] | null = null;
    for (let i = 0; i < pts.length; i++) {
      const l = b.vertex(at(i, half), 0, s[i] / 8);
      const r = b.vertex(at(i, -half), 1, s[i] / 8);
      if (prev) b.quad(prev[0], prev[1], l, r);
      prev = [l, r];
    }
    const g = b.build();
    if (g) {
      const mesh = new THREE.Mesh(g, this.taxiwayMaterial);
      // 誘導路どうし・滑走路との重なりは、滑走路を上に
      mesh.renderOrder = -1;
      this.group.add(mesh);
    }
  }

  /** 搭乗橋：points はターミナルの側から飛行機の側へ */
  private buildJetBridge(points: Array<[number, number]>): void {
    const B = AIRPORTS.jetBridge;
    const ground = points.map(([lat, lon]) => this.terrain.surfaceHeightAt(lat, lon) ?? 0);
    const base = Math.min(...ground);
    const pts = points.map(([lat, lon]) => this.terrain.toLocal(lat, lon, base));
    const total = pts.slice(1).reduce((s, p, i) => s + p.distanceTo(pts[i]), 0);
    const metal: THREE.BufferGeometry[] = [];
    const glass: THREE.BufferGeometry[] = [];
    const dark: THREE.BufferGeometry[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    /** a から b（地面の高さの点）への、床の高さ ya〜yb の箱（幅 w、高さ h） */
    const beam = (
      list: THREE.BufferGeometry[],
      a: THREE.Vector3,
      b: THREE.Vector3,
      ya: number,
      yb: number,
      w: number,
      h: number,
      dy = 0,
    ) => {
      const from = a.clone().setY(a.y + ya + dy);
      const to = b.clone().setY(b.y + yb + dy);
      const d = new THREE.Vector3().subVectors(to, from);
      const len = d.length();
      if (len < 0.1) return;
      const g = new THREE.BoxGeometry(w, h, len).translate(0, h / 2, len / 2);
      const forward = d.clone().normalize();
      const side = new THREE.Vector3().crossVectors(up, forward).normalize();
      const upright = new THREE.Vector3().crossVectors(forward, side).normalize();
      g.applyMatrix4(new THREE.Matrix4().makeBasis(side, upright, forward).setPosition(from));
      list.push(g);
    };
    // 床の高さ：ターミナルの側 B.floorStart から、飛行機の側 B.floorEnd へ一様に下がる
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = pts[i].distanceTo(pts[i - 1]);
      const ya = THREE.MathUtils.lerp(B.floorStart, B.floorEnd, run / total);
      const yb = THREE.MathUtils.lerp(B.floorStart, B.floorEnd, (run + len) / total);
      run += len;
      // 通路：灰色の箱と、両側の窓の帯（少し外へ出す）
      beam(metal, pts[i - 1], pts[i], ya, yb, B.width, B.height);
      beam(glass, pts[i - 1], pts[i], ya, yb, B.width + 0.1, B.height * 0.35, B.height * 0.4);
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dir = new THREE.Vector3()
      .subVectors(last, pts[pts.length - 2])
      .setY(0)
      .normalize();
    // ターミナルの側の回転台（丸い柱と、上の丸い箱）
    metal.push(
      new THREE.CylinderGeometry(1.1, 1.3, B.floorStart, 10).translate(first.x, first.y + B.floorStart / 2, first.z),
    );
    metal.push(
      new THREE.CylinderGeometry(2.4, 2.4, B.height + 0.4, 12).translate(
        first.x,
        first.y + B.floorStart + B.height / 2,
        first.z,
      ),
    );
    // 飛行機の側の乗降口（少し広い箱）と、黒いゴムの幌
    const cabFrom = last.clone().addScaledVector(dir, -2.5);
    beam(metal, cabFrom, last, B.floorEnd, B.floorEnd, B.width + 1.2, B.height + 0.4, -0.2);
    beam(dark, last, last.clone().addScaledVector(dir, 0.8), B.floorEnd, B.floorEnd, B.width + 0.6, B.height, -0.1);
    // 脚と車輪：先から B.legFromEnd m 手前の、通路の左右
    const legAt = last.clone().addScaledVector(dir, -B.legFromEnd);
    const side = new THREE.Vector3().crossVectors(up, dir).normalize();
    const legY = B.floorEnd + (B.floorStart - B.floorEnd) * Math.min(1, B.legFromEnd / total);
    for (const s of [-1, 1]) {
      const p = legAt.clone().addScaledVector(side, s * 1.1);
      metal.push(new THREE.BoxGeometry(0.35, legY, 0.35).translate(p.x, p.y + legY / 2, p.z));
    }
    const axle = legAt.clone();
    dark.push(new THREE.BoxGeometry(3.2, 0.5, 1.2).translate(axle.x, axle.y + 0.5, axle.z));
    for (const s of [-1, 1]) {
      const w = axle.clone().addScaledVector(side, s * 1.3);
      dark.push(new THREE.CylinderGeometry(0.45, 0.45, 0.4, 10).rotateZ(Math.PI / 2).translate(w.x, w.y + 0.45, w.z));
    }
    for (const [list, material] of [
      [metal, this.bridgeMaterials.metal],
      [glass, this.bridgeMaterials.glass],
      [dark, this.bridgeMaterials.dark],
    ] as const) {
      const g = mergeGeometries(
        list.map((x) => {
          const out = x.index ? x.toNonIndexed() : x;
          for (const name of Object.keys(out.attributes)) if (name !== 'position') out.deleteAttribute(name);
          return out;
        }),
      )!;
      g.computeVertexNormals();
      this.group.add(new THREE.Mesh(g, material));
    }
  }

  /** 管制塔（高さ height m、てっぺんのアンテナを含む） */
  private buildTower([lat, lon]: [number, number], height: number): void {
    const ground = this.terrain.surfaceHeightAt(lat, lon) ?? 0;
    const p = this.terrain.toLocal(lat, lon, ground);
    const cab = height - 14;
    const white: THREE.BufferGeometry[] = [];
    const glass: THREE.BufferGeometry[] = [];
    // 塔（下が太い）、管制室の下の張り出し、外へ傾いたガラスの管制室、屋根、アンテナ
    white.push(new THREE.CylinderGeometry(4.2, 6, cab - 4, 12).translate(0, (cab - 4) / 2, 0));
    white.push(new THREE.CylinderGeometry(9.5, 5, 4, 8).translate(0, cab - 2, 0));
    glass.push(new THREE.CylinderGeometry(10.5, 9, 5.5, 8, 1, true).translate(0, cab + 2.75, 0));
    white.push(new THREE.CylinderGeometry(11, 11, 1.2, 8).translate(0, cab + 6.1, 0));
    white.push(new THREE.CylinderGeometry(6, 8, 2.5, 8).translate(0, cab + 7.9, 0));
    white.push(
      new THREE.CylinderGeometry(0.3, 0.5, height - cab - 9, 6).translate(0, cab + 9 + (height - cab - 9) / 2, 0),
    );
    for (const [list, material] of [
      [white, this.towerMaterials.white],
      [glass, this.towerMaterials.glass],
    ] as const) {
      const g = mergeGeometries(list.map((x) => (x.index ? x.toNonIndexed() : x)))!;
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, material);
      mesh.position.copy(p);
      this.group.add(mesh);
    }
  }

  /** 機首の先 nose（緯度経度）、機首の向き（度、東が 0 で北へ回る） */
  private placeAircraft(nose: [number, number], heading: number): void {
    const ground = this.terrain.surfaceHeightAt(nose[0], nose[1]) ?? 0;
    const p = this.terrain.toLocal(nose[0], nose[1], ground);
    // 東・北の向きをローカル座標で求める（+x が西、+z が北の地形と同じ変換）
    const east = this.terrain
      .toLocal(nose[0], nose[1] + 1e-4, ground)
      .sub(p)
      .setY(0)
      .normalize();
    const north = this.terrain
      .toLocal(nose[0] + 1e-4, nose[1], ground)
      .sub(p)
      .setY(0)
      .normalize();
    const a = (heading * Math.PI) / 180;
    const forward = east
      .multiplyScalar(Math.cos(a))
      .add(north.multiplyScalar(Math.sin(a)))
      .normalize();
    this.aircraft.add(p, forward, hashOf(nose[0] * 1e6 + nose[1]));
  }
}

function hashOf(n: number): number {
  const h = Math.sin(n * 12.9898) * 43758.5453;
  return h - Math.floor(h);
}

/** 駐機している旅客機（胴体・翼・エンジンは白と灰色の頂点色、尾翼は航空会社の色）。大きさは3種類 */
class AircraftFleet {
  body: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  private count = 0;
  private capacity = 0;
  private readonly bodyGeometry: THREE.BufferGeometry;
  private readonly tailGeometry: THREE.BufferGeometry;
  private readonly bodyMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.15,
  });
  private readonly tailMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5 });

  constructor() {
    const { body, tail } = buildAirliner();
    this.bodyGeometry = body;
    this.tailGeometry = tail;
    this.body = new THREE.InstancedMesh(body, this.bodyMaterial, 1);
    this.tail = new THREE.InstancedMesh(tail, this.tailMaterial, 1);
    this.body.count = this.tail.count = 0;
  }

  reserve(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = n;
    const body = new THREE.InstancedMesh(this.bodyGeometry, this.bodyMaterial, n);
    const tail = new THREE.InstancedMesh(this.tailGeometry, this.tailMaterial, n);
    body.count = tail.count = 0;
    body.frustumCulled = tail.frustumCulled = false;
    const parent = this.body.parent;
    parent?.remove(this.body, this.tail);
    this.body = body;
    this.tail = tail;
    parent?.add(body, tail);
  }

  /** 機首の先 nose、機首の向き forward（水平の単位ベクトル）、r：大きさと色を決める 0〜1 の値 */
  add(nose: THREE.Vector3, forward: THREE.Vector3, r: number): void {
    if (this.count >= this.capacity) return;
    // 大きさ：小型機（B737 くらい）・中型機（B767）・大型機（B777）。形は長さ 1 の機体を伸ばす
    const length = r < 0.45 ? 38 : r < 0.75 ? 55 : 70;
    const scale = length;
    // 機体の中心（形の原点）は機首から長さの半分だけ後ろ
    const center = nose.clone().addScaledVector(forward, -length / 2);
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize(),
      new THREE.Vector3(0, 1, 0),
      forward,
    );
    m.scale(new THREE.Vector3(scale, scale, scale)).setPosition(center);
    this.body.setMatrixAt(this.count, m);
    this.tail.setMatrixAt(this.count, m);
    this.tail.setColorAt(
      this.count,
      new THREE.Color(AIRPORTS.tailColors[Math.floor(r * 997) % AIRPORTS.tailColors.length]),
    );
    this.count++;
    this.body.count = this.tail.count = this.count;
    this.body.instanceMatrix.needsUpdate = true;
    this.tail.instanceMatrix.needsUpdate = true;
    if (this.tail.instanceColor) this.tail.instanceColor.needsUpdate = true;
  }
}

/**
 * 長さ 1 の旅客機（z = 前、x = 左、y = 上。原点は機体の真ん中の地面）。
 * 胴体の直径は長さの 0.1、翼の幅は長さとほぼ同じ。尾翼（垂直尾翼）だけ別の形
 */
function buildAirliner(): { body: THREE.BufferGeometry; tail: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const white = new THREE.Color(0xf1f3f5);
  const grey = new THREE.Color(0x8c939b);
  const dark = new THREE.Color(0x2b3138);
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  };
  const R = 0.05;
  const Y = 0.075;
  // 胴体と、丸い機首・細くなる尾部
  parts.push(paint(new THREE.CylinderGeometry(R, R, 0.7, 16).rotateX(Math.PI / 2).translate(0, Y, 0.02), white));
  parts.push(
    paint(
      new THREE.SphereGeometry(R, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
        .rotateX(Math.PI / 2)
        .scale(1, 1, 2.2)
        .translate(0, Y, 0.37),
      white,
    ),
  );
  // 尾部：前（+z）が太く、後ろへ細くなる
  parts.push(
    paint(new THREE.CylinderGeometry(R, R * 0.25, 0.26, 16).rotateX(Math.PI / 2).translate(0, Y + 0.012, -0.46), white),
  );
  // 操縦席の窓（機首の上の暗い帯）
  parts.push(paint(new THREE.BoxGeometry(R * 1.2, R * 0.25, 0.03).translate(0, Y + R * 0.55, 0.43), dark));
  // 主翼（後ろへ傾いた台形の板）と水平尾翼
  const wing = (span: number, root: number, tip: number, sweep: number, z: number, y: number) => {
    const shape = new THREE.Shape();
    shape.moveTo(0, root / 2);
    shape.lineTo(span, root / 2 - sweep);
    shape.lineTo(span, root / 2 - sweep - tip);
    shape.lineTo(0, -root / 2);
    shape.closePath();
    for (const side of [1, -1]) {
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.008, bevelEnabled: false })
        .rotateX(Math.PI / 2)
        .scale(side, 1, 1)
        .translate(0, y, z);
      parts.push(paint(g, white));
    }
  };
  wing(0.48, 0.2, 0.05, 0.17, 0.02, Y - 0.025);
  wing(0.17, 0.09, 0.035, 0.07, -0.45, Y + 0.015);
  // エンジン（翼の下の2つ）
  for (const side of [1, -1]) {
    parts.push(
      paint(
        new THREE.CylinderGeometry(0.028, 0.024, 0.1, 12).rotateX(Math.PI / 2).translate(side * 0.16, Y - 0.05, 0.08),
        grey,
      ),
    );
  }
  // 脚
  for (const [x, z] of [
    [0, 0.33],
    [0.05, -0.02],
    [-0.05, -0.02],
  ]) {
    parts.push(paint(new THREE.BoxGeometry(0.012, Y - R, 0.012).translate(x, (Y - R) / 2, z), dark));
  }
  const prepared = parts.map((g) => {
    const out = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(out.attributes))
      if (name !== 'position' && name !== 'color') out.deleteAttribute(name);
    return out;
  });
  const body = mergeGeometries(prepared)!;
  body.computeVertexNormals();
  // 垂直尾翼（後ろへ傾いた台形）
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(0.13, 0);
  fin.lineTo(0.14, 0.17);
  fin.lineTo(0.08, 0.17);
  fin.closePath();
  const tail = new THREE.ExtrudeGeometry(fin, { depth: 0.008, bevelEnabled: false })
    .rotateY(Math.PI / 2)
    .translate(-0.004, Y + R * 0.6, -0.47);
  for (const name of Object.keys(tail.attributes)) if (name !== 'position') tail.deleteAttribute(name);
  tail.computeVertexNormals();
  return { body, tail };
}

/** 滑走路：暗いアスファルトのむらに、両端の白線と中心線の破線（1枚 = 幅いっぱい × 長さ AIRPORTS.dashPeriod m） */
function createRunwayMaterial(): THREE.MeshStandardMaterial {
  const W = 256;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  // 幅 60m として：端の白線 1.5m、中心線 0.9m・長さ 30m（周期 50m）
  const px = W / 60;
  g.fillStyle = '#e9ebec';
  g.fillRect(px * 1, 0, px * 1.5, H);
  g.fillRect(W - px * 2.5, 0, px * 1.5, H);
  g.fillRect(W / 2 - px * 0.45, 0, px * 0.9, H * (30 / AIRPORTS.dashPeriod));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

/** 誘導路：少し明るいアスファルトに、黄色の中心線（1枚 = 幅いっぱい × 長さ 8m） */
function createTaxiwayMaterial(): THREE.MeshStandardMaterial {
  const W = 128;
  const H = 32;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#4a4c50';
  g.fillRect(0, 0, W, H);
  // 幅 23m として：黄色の中心線 0.5m、端の黄色の線 0.3m
  const px = W / 23;
  g.fillStyle = '#e2b43c';
  g.fillRect(W / 2 - px * 0.25, 0, px * 0.5, H);
  g.fillStyle = 'rgba(226,180,60,0.7)';
  g.fillRect(px * 0.3, 0, px * 0.3, H);
  g.fillRect(W - px * 0.6, 0, px * 0.3, H);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/**
 * 進入端の印（端から AIRPORTS.thresholdLength m）：縞模様（ピアノキー）と滑走路の番号。
 * 画像の下 = 端、上 = 滑走路の中。降りてくる飛行機から読める向き
 */
function createThresholdMaterial(label: string, width: number): THREE.MeshStandardMaterial {
  const L = AIRPORTS.thresholdLength;
  const pxPerM = 6;
  const W = Math.round(width * pxPerM);
  const H = Math.round(L * pxPerM);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, W, H);
  const y = (m: number) => H - m * pxPerM; // 端から m の位置（画像の y）
  g.fillStyle = '#eceeef';
  // 端の横線（3m）
  g.fillRect(0, y(3), W, 3 * pxPerM);
  // 縞模様：端から 6〜36m、幅 1.8m の縞を中心線の両側に
  const stripes = Math.max(4, Math.floor(width / 3.6 / 2) * 2);
  const gap = (width - 6) / stripes;
  for (let k = 0; k < stripes; k++) {
    const cx = 3 + gap * (k + 0.5) + (k >= stripes / 2 ? 0 : 0);
    if (Math.abs(cx - width / 2) < 2) continue;
    g.fillRect((cx - 0.9) * pxPerM, y(36), 1.8 * pxPerM, 30 * pxPerM);
  }
  // 番号（端から 42m より先）。L・R・C は数字の手前（端の側）
  const digits = label.replace(/[^0-9]/g, '');
  const side = label.replace(/[0-9]/g, '');
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = `bold ${17 * pxPerM}px sans-serif`;
  g.fillText(digits, W / 2, y(side ? 62 : 44));
  if (side) g.fillText(side, W / 2, y(42));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}
