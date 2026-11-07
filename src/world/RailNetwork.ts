import * as THREE from 'three';
import { RAILWAYS, WATER } from '../core/config';
import { approxMeters, decode, MeshBuilder } from './RoadNetwork';
import { cutFloor, fillGaps, smoothGround, stationGround } from './groundProfile';
import type { ChunkListener, Terrain } from './Terrain';
import { type Approach, type PortalRecord, TunnelPortalBuilder } from './tunnelPortals';

/**
 * 線路データ1タイル（scripts/build-rail-heights.mjs の出力）。
 * t：[軌間(mm), 座標（1e-6度、先頭以外は差分）, 各点の地面からの高さ（0.1m 単位）, 掘割(0/1),
 *     各点の駅（s の番号、駅の外は -1）, 各点の駅の地面に合わせる割合（0〜10）]（駅の2つは駅の近くの線路だけ）
 * x：[緯度, 経度（1e-6度）, 半径(m)] 線路が道路と交わる所（橋脚を立てない）
 * s：[緯度, 経度（1e-6度）, 掘割(0/1)] 駅の地面の基準点（ホームも同じ点を基準にする）
 * p：トンネルの入口（坑口）。形式は tunnelPortals.ts の PortalRecord
 * 高さが負の所は、トンネルの入口へ下りる坂（地形を削って掘割にする）
 */
interface RailTile {
  t: Array<[number, number[], number[], (0 | 1)?, number[]?, number[]?]>;
  x: Array<[number, number, number]>;
  s?: Array<[number, number, 0 | 1]>;
  p?: PortalRecord[];
}

/** 道床の画像1枚が表す長さ (m)。枕木 4 本ぶん */
const TEXTURE_LENGTH_M = 2.4;

/**
 * 線路。航空写真を参考に、茶色い砂利の道床・枕木・2本のレールを1枚の画像にして、線路の中心線に沿って貼る。
 * 高架の線路は地面から持ち上げ、コンクリートの桁・側壁・橋脚を付ける。トンネルの入口には、コンクリートの壁と暗い開口部を付ける。
 * 地形チャンクが読まれたら同じ範囲の線路データを読み、捨てられたら一緒に捨てる。
 */
export class RailNetwork implements ChunkListener {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, THREE.Group | 'loading'>();
  /** 均した地面（smoothGround）の格子点の平均。タイルを作る間だけ使い回す（読込前のチャンクの値を残さないよう、毎回作り直す） */
  private smoothCache = new Map<string, number | null>();
  private readonly trackMaterials: Record<'narrow' | 'standard', THREE.MeshStandardMaterial> = {
    narrow: createTrackMaterial(1.067),
    standard: createTrackMaterial(1.435),
  };
  private readonly concreteMaterial = new THREE.MeshStandardMaterial({
    color: RAILWAYS.concreteColor,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  /** 跨座式のモノレールの桁と橋脚 */
  private readonly monorailMaterial = new THREE.MeshStandardMaterial({
    color: RAILWAYS.monorail.color,
    roughness: 0.8,
    side: THREE.DoubleSide,
  });
  /** トンネルの入口・擁壁のコンクリート（型枠の継ぎ目と雨だれの汚れ） */
  private readonly portalMaterial = createPortalConcreteMaterial();
  /** トンネルの内壁（頂点色で、入口から奥へ暗くする。光の届かない所なのでライティングしない） */
  private readonly liningMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  /** 線路わきの金網の柵 */
  private readonly fenceMaterial = createFenceMaterial();

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
  }

  onChunkAdded(x: number, y: number): void {
    const key = `${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    const url = `${import.meta.env.BASE_URL}${RAILWAYS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    fetch(url)
      // 線路の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<RailTile>) : null,
      )
      .then((data) => {
        if (this.tiles.get(key) !== 'loading') return;
        const group = data ? this.build(data, key) : new THREE.Group();
        this.tiles.set(key, group);
        this.group.add(group);
      })
      .catch((e) => {
        console.warn('[Rails] 読込に失敗しました', key, e);
        this.tiles.delete(key);
      });
  }

  onChunkRemoved(x: number, y: number): void {
    const key = `${x}/${y}`;
    const tile = this.tiles.get(key);
    this.tiles.delete(key);
    this.terrain.removeCarve(`rail:${key}`);
    this.terrain.removeCarve(`rail-portal:${key}`);
    this.terrain.removeCarve(`rail-grade:${key}`);
    this.terrain.removeTrench(`rail:${key}`);
    if (!tile || tile === 'loading') return;
    this.group.remove(tile);
    tile.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }

  private build(data: RailTile, key: string): THREE.Group {
    this.smoothCache = new Map();
    const narrow = new MeshBuilder();
    const standard = new MeshBuilder();
    const viaduct = new MeshBuilder();
    const monorail = new MeshBuilder();
    const noPier = data.x.map(([lat, lon, r]) => [lat / 1e6, lon / 1e6, r] as const);
    const cuts: THREE.Vector3[][] = [];
    // 地面の高さを走る線路（まわりの地形を道床の高さにそろえる）
    const grades: THREE.Vector3[][] = [];
    // トンネルの入口へ下りる掘割（両側に擁壁を立てる）
    const approachCuts: THREE.Vector3[][] = [];
    const approaches: Approach[] = [];
    const fenceTracks: Array<{ pts: THREE.Vector3[]; lift: number[]; sides: THREE.Vector3[]; inStation: boolean[] }> = [];
    // 駅の地面の高さ（駅の中の線路はこれを基準にして、ホームと高さをそろえる）
    const stationBase = (data.s ?? []).map(([lat, lon, cut]) =>
      stationGround(this.terrain, lat / 1e6, lon / 1e6, cut === 1, RAILWAYS.smoothRadius, RAILWAYS.cutFloorRadius),
    );
    for (const [gauge, coords, offsets, cut, stations, weights] of data.t) {
      const station = stations && weights ? { stations, weights, base: stationBase } : null;
      const built = this.buildTrack(
        decode(coords),
        offsets,
        cut === 1,
        station,
        noPier,
        gauge >= 1400 ? standard : narrow,
        viaduct,
        // 軌間 0 は跨座式のモノレール（レールの無いコンクリートの桁）
        gauge === 0 ? monorail : null,
      );
      if (!built) continue;
      // 柵は地上の線路（掘割・モノレールを除く）の外側に立てる
      if (cut !== 1 && gauge > 0) fenceTracks.push(built);
      const floor = (p: THREE.Vector3) => p.clone().setY(p.y - RAILWAYS.lift - RAILWAYS.cutDepthBelow);
      if (cut === 1) cuts.push(built.pts.map(floor));
      else {
        // 地面より下の所（トンネルの入口へ下りる坂）だけ削る。前後に1点ずつ足して、地面との境目までつなぐ
        let run: number[] = [];
        const flush = () => {
          if (run.length > 1) {
            // 削るのは当たり判定のため（見た目は Terrain.addTrench と擁壁）。入口の側は手前で止める
            // （削った影響がトンネルの上の地形まで届くと、地形が開口部の中へ垂れ下がる）
            const deep = built.lift[run[0]] < built.lift[run[run.length - 1]] ? 0 : run.length - 1;
            const end = built.pts[run[deep]];
            const kept = run.filter((i) => built.pts[i].distanceTo(end) > RAILWAYS.portal.carveStop);
            if (kept.length > 1) approachCuts.push(kept.map((i) => floor(built.pts[i])));
            approaches.push({
              pts: run.map((i) => built.pts[i]),
              sides: run.map((i) => built.sides[i]),
              lift: run.map((i) => built.lift[i]),
            });
          }
          run = [];
        };
        built.lift.forEach((l, i) => {
          if (l < -0.3) {
            if (run.length === 0 && i > 0) run.push(i - 1);
            run.push(i);
          } else if (run.length > 0) {
            run.push(i);
            flush();
          }
        });
        flush();
        // 地面の高さの区間（高架・トンネルへ下りる坂とその手前を除く）は、まわりの地形を道床の高さにそろえる
        const portalNear = built.lift.map(() => false);
        built.lift.forEach((l, i) => {
          if (l >= -0.3) return;
          for (let j = 0; j < built.pts.length; j++) {
            if (built.pts[j].distanceTo(built.pts[i]) < RAILWAYS.portal.carveStop * 2) portalNear[j] = true;
          }
        });
        let grade: THREE.Vector3[] = [];
        built.lift.forEach((l, i) => {
          if (Math.abs(l) < 0.3 && !portalNear[i] && gauge > 0) grade.push(floor(built.pts[i]));
          else {
            if (grade.length > 1) grades.push(grade);
            grade = [];
          }
        });
        if (grade.length > 1) grades.push(grade);
        // 高架（橋へ上がる坂を含む）は、桁より上に出ている地形（土手・丘）を掘割と同じように削る
        let high: THREE.Vector3[] = [];
        built.lift.forEach((l, i) => {
          if (l >= 0.3 && !portalNear[i]) {
            high.push(built.pts[i].clone().setY(built.pts[i].y - RAILWAYS.lift - RAILWAYS.viaductDepth));
          } else {
            if (high.length > 1) cuts.push(high);
            high = [];
          }
        });
        if (high.length > 1) cuts.push(high);
      }
    }
    // トンネルの入口と、入口へ下りる掘割の擁壁
    const portals = new TunnelPortalBuilder(this.terrain, narrow);
    for (const p of data.p ?? []) portals.addPortal(p);
    portals.addRetainingWalls(approaches);
    // 掘割の内側の地形は描かない（地形の頂点の間隔では、深く細い掘割を削りきれない）
    if (approaches.length > 0)
      this.terrain.addTrench(
        `rail:${key}`,
        approaches.map((ap) => ap.pts),
      );
    // 掘割の線路のまわりの地形を削る
    if (cuts.length > 0) this.terrain.addCarve(`rail:${key}`, cuts, RAILWAYS.cutWidth, RAILWAYS.cutSlope);
    // 地面の高さの線路：道床の幅は地形を道床のすぐ下にそろえ（高い所は削り、低い所は盛る）、その外はなだらかに戻す
    if (grades.length > 0) {
      this.terrain.addCarve(`rail-grade:${key}`, grades, RAILWAYS.gradeWidth, RAILWAYS.gradeSlope, {
        fill: { reach: RAILWAYS.gradeFillReach, slope: RAILWAYS.gradeSlope },
      });
    }
    // 入口へ下りる掘割も同じく削る（地形の頂点の間隔が広いので、擁壁の幅では削りきれない。壁の外は斜面になる）
    if (approachCuts.length > 0) {
      this.terrain.addCarve(`rail-portal:${key}`, approachCuts, RAILWAYS.cutWidth, RAILWAYS.cutSlope);
    }
    const fence = this.buildFences(fenceTracks, noPier);
    const group = new THREE.Group();
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material) => {
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(narrow.build(), this.trackMaterials.narrow);
    add(standard.build(), this.trackMaterials.standard);
    add(viaduct.build(), this.concreteMaterial);
    add(monorail.build(), this.monorailMaterial);
    const { concrete, lining } = portals.build();
    add(concrete, this.portalMaterial);
    add(lining, this.liningMaterial);
    add(fence, this.fenceMaterial);
    return group;
  }

  /**
   * 地上の線路の両側の金網の柵。中心線から RAILWAYS.fence.offset m の所に、地面から height m。
   * 並んで走る線路の間（ほかの線路の中心線が近い所）・駅の中・踏切・高架・トンネルへ下りる坂には立てない
   */
  private buildFences(
    tracks: Array<{ pts: THREE.Vector3[]; lift: number[]; sides: THREE.Vector3[]; inStation: boolean[] }>,
    noPier: ReadonlyArray<readonly [number, number, number]>,
  ): THREE.BufferGeometry | null {
    const F = RAILWAYS.fence;
    // 線路の中心線の点を 5m 四方の升目に分けて、近くの線路を速く探す
    const CELL = 5;
    const cells = new Map<string, Array<{ track: number; p: THREE.Vector3 }>>();
    const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    tracks.forEach((t, track) => {
      for (const p of t.pts) {
        const k = cellKey(p.x, p.z);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push({ track, p });
      }
    });
    const nearOther = (q: THREE.Vector3, self: number) => {
      const cx = Math.floor(q.x / CELL);
      const cz = Math.floor(q.z / CELL);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const { track, p } of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
            if (track !== self && Math.hypot(p.x - q.x, p.z - q.z) < F.offset + F.gap) return true;
          }
        }
      }
      return false;
    };
    const crossings = noPier.map(([lat, lon, r]) => ({ p: this.terrain.toLocal(lat, lon, 0), r: r + F.crossingClear }));
    const nearCrossing = (q: THREE.Vector3) => crossings.some(({ p, r }) => Math.hypot(p.x - q.x, p.z - q.z) < r);
    const groundAt = (q: THREE.Vector3, fallback: number) => {
      const ll = this.terrain.toLatLon(q);
      const h = ll ? this.terrain.surfaceHeightAt(ll.lat, ll.lon) : null;
      return h === null || !ll ? fallback : this.terrain.toLocal(ll.lat, ll.lon, h).y;
    };

    const pos: number[] = [];
    const uv: number[] = [];
    tracks.forEach((t, track) => {
      for (const sign of [-1, 1]) {
        let prev: { q: THREE.Vector3; y: number; u: number } | null = null;
        for (let i = 0; i < t.pts.length; i++) {
          const q = t.pts[i].clone().addScaledVector(t.sides[i], sign * F.offset);
          const ok =
            t.lift[i] > -0.3 && t.lift[i] < RAILWAYS.elevatedFrom && !t.inStation[i] && !nearOther(q, track) && !nearCrossing(q);
          if (!ok) {
            prev = null;
            continue;
          }
          const y = groundAt(q, t.pts[i].y - RAILWAYS.lift - t.lift[i]);
          const u: number = prev ? prev.u + Math.hypot(q.x - prev.q.x, q.z - prev.q.z) / F.postSpacing : 0;
          if (prev) {
            const a = prev;
            pos.push(
              a.q.x, a.y, a.q.z, q.x, y, q.z, q.x, y + F.height, q.z,
              a.q.x, a.y, a.q.z, q.x, y + F.height, q.z, a.q.x, a.y + F.height, a.q.z,
            );
            uv.push(a.u, 0, u, 0, u, 1, a.u, 0, u, 1, a.u, 1);
          }
          prev = { q, y, u };
        }
      }
    });
    if (pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }

  /**
   * 1本の線路を作り、中心線の点（ローカル座標）を返す。offsets は各点の地面からの高さ（0.1m 単位、スロープ込みで計算済み）。
   * 高架の所は、地形の細かい凹凸を均した地面を基準にして、上面をなだらかにする。
   * 駅の中は駅の地面（station.base）を基準にし、駅の外へは station.weights の割合で地形に戻す
   */
  private buildTrack(
    points: Array<[number, number]>,
    offsets: number[],
    cut: boolean,
    station: { stations: number[]; weights: number[]; base: Array<number | null> } | null,
    noPier: ReadonlyArray<readonly [number, number, number]>,
    track: MeshBuilder,
    viaduct: MeshBuilder,
    monorail: MeshBuilder | null,
  ): { pts: THREE.Vector3[]; lift: number[]; sides: THREE.Vector3[]; inStation: boolean[] } | null {
    // 細かく区切った点と、中心線に沿った距離 s、地面からの高さ
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    const lift: number[] = [];
    // 駅の地面の高さと、それに合わせる割合（駅の近くでなければ null / 0）
    const stationAt = (i: number): [number | null, number] => {
      const ref = station?.stations[i] ?? -1;
      return ref < 0 ? [null, 0] : [station!.base[ref] ?? null, station!.weights[i] / 10];
    };
    const stationBase: Array<number | null> = [];
    const stationWeight: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i];
      const off = offsets[i] / 10;
      const [base, weight] = stationAt(i);
      if (i === 0) {
        samples.push([lat, lon]);
        s.push(0);
        lift.push(off);
        stationBase.push(base);
        stationWeight.push(base === null ? 0 : weight);
        continue;
      }
      const [plat, plon] = points[i - 1];
      const poff = offsets[i - 1] / 10;
      const [pbase, pweight] = stationAt(i - 1);
      const length = approxMeters(plat, plon, lat, lon);
      const steps = Math.max(1, Math.ceil(length / RAILWAYS.densifyStep));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        samples.push([plat + (lat - plat) * t, plon + (lon - plon) * t]);
        s.push(s[s.length - 1] + length / steps);
        lift.push(poff + (off - poff) * t);
        // 割合は前後の点の間で補間し、地面の高さは割合の大きい方の駅のもの
        const b = weight >= pweight ? (base ?? pbase) : (pbase ?? base);
        stationBase.push(b);
        stationWeight.push(
          b === null ? 0 : (base === null ? 0 : weight) * t + (pbase === null ? 0 : pweight) * (1 - t),
        );
      }
    }
    if (samples.length < 2) return null;

    // 掘割は、細かい標高（5m メッシュ）の前後 cutFloorRadius m の一番低い所＝掘割の底に置く（あとで地形を削る）
    const raw = cut
      ? cutFloor(this.terrain, samples, s, RAILWAYS.cutFloorRadius)
      : samples.map(([lat, lon]) => this.terrain.surfaceHeightAt(lat, lon));
    // 高さの取れない所（まだ読んでいない隣のチャンク）は、線の上の近い所の高さ
    const ground = fillGaps(raw) ?? raw.map(() => 0);
    // 均した地面：場所だけで決まる平均（周りの格子点の地形の平均）にして、隣を並んで走る線路と同じ高さにする。
    // 地上の線路もこの高さに置き、地形の細かい凸凹を拾わないようにする（まわりの地形は Terrain.addCarve で線路に合わせる）
    const smooth =
      fillGaps(samples.map(([lat, lon]) => smoothGround(this.terrain, lat, lon, RAILWAYS.smoothRadius, this.smoothCache))) ??
      ground;
    const heights = ground.map((g, i) => {
      // 掘割は掘割の底、それ以外は均した地面（掘割でも高架ほど均した地面に寄せる）
      let base = cut ? THREE.MathUtils.lerp(g, smooth[i], THREE.MathUtils.clamp(lift[i] / 2, 0, 1)) : smooth[i];
      // 駅の近くは駅の地面に寄せる
      if (stationWeight[i] > 0) base = THREE.MathUtils.lerp(base, stationBase[i]!, stationWeight[i]);
      // 川の上（地面が水面）では水面から少し上に（駅の中はホームと高さをそろえるので上げない。
      // 地面より下（トンネルの入口へ下りる坂）も上げない）
      const overWater =
        lift[i] < 0 ? base + lift[i] : Math.max(base + lift[i], WATER.surfaceHeight + RAILWAYS.waterClearance);
      return THREE.MathUtils.lerp(overWater, base + lift[i], stationWeight[i]) + RAILWAYS.lift;
    });
    const pts = samples.map(([lat, lon], i) => this.terrain.toLocal(lat, lon, heights[i]));
    const inStation = stationWeight.map((w) => w > 0);
    const elevated = lift.map((l) => l > RAILWAYS.elevatedFrom);
    // 各点の左右の向き
    const up = new THREE.Vector3(0, 1, 0);
    const sides = pts.map((_, i) => {
      const tangent = new THREE.Vector3()
        .subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)])
        .setY(0)
        .normalize();
      return new THREE.Vector3().crossVectors(up, tangent).normalize();
    });
    const half = RAILWAYS.ballastWidth / 2;
    const at = (i: number, across: number, dy: number) =>
      pts[i]
        .clone()
        .addScaledVector(sides[i], across)
        .setY(pts[i].y + dy);
    if (monorail) {
      this.buildMonorailBeam(monorail, samples, s, lift, ground, pts, sides, at, noPier);
      return { pts, lift, sides, inStation };
    }

    // 道床（u：幅方向 0..1、v：枕木の繰り返し）
    let prev: [number, number] | null = null;
    for (let i = 0; i < pts.length; i++) {
      const v = s[i] / TEXTURE_LENGTH_M;
      const a = track.vertex(at(i, half, 0), 0, v);
      const b = track.vertex(at(i, -half, 0), 1, v);
      if (prev) track.quad(prev[0], prev[1], a, b);
      prev = [a, b];
    }
    if (!elevated.some(Boolean)) return { pts, lift, sides, inStation };

    // 高架：側壁・桁の側面・底面（高架の所だけ）
    const edge = half + RAILWAYS.viaductShoulder;
    const strip = (fa: (i: number) => THREE.Vector3, fb: (i: number) => THREE.Vector3) => {
      let p: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        if (!elevated[i]) {
          p = null;
          continue;
        }
        const va = viaduct.vertex(fa(i), s[i] / 4, 0);
        const vb = viaduct.vertex(fb(i), s[i] / 4, 1);
        if (p) viaduct.quad(p[0], p[1], va, vb);
        p = [va, vb];
      }
    };
    // 側壁は立てない（並んだ線路それぞれに立つと、線路の間が壁だらけになる）。桁の側面だけ
    strip(
      (i) => at(i, edge, -0.05),
      (i) => at(i, edge, -RAILWAYS.viaductDepth),
    );
    strip(
      (i) => at(i, -edge, -RAILWAYS.viaductDepth),
      (i) => at(i, -edge, -0.05),
    );
    strip(
      (i) => at(i, edge, -RAILWAYS.viaductDepth),
      (i) => at(i, -edge, -RAILWAYS.viaductDepth),
    );
    // 道床の脇の平らな部分（道床と側壁の間）
    strip(
      (i) => at(i, edge, -0.05),
      (i) => at(i, half, -0.05),
    );
    strip(
      (i) => at(i, -half, -0.05),
      (i) => at(i, -edge, -0.05),
    );

    // 橋脚
    for (let i = 1; i < pts.length; i++) {
      if (Math.floor(s[i] / RAILWAYS.pierSpacing) === Math.floor(s[i - 1] / RAILWAYS.pierSpacing)) continue;
      if (lift[i] < RAILWAYS.pierFrom) continue;
      // 下を通る道路の上には立てない
      const [plat, plon] = samples[i];
      if (noPier.some(([lat, lon, r]) => approxMeters(lat, lon, plat, plon) < r + RAILWAYS.pierThickness)) continue;
      const bottom = this.terrain.toLocal(samples[i][0], samples[i][1], ground[i] - 1).y;
      const top = pts[i].y - RAILWAYS.viaductDepth;
      if (top - bottom < 2) continue;
      const tangent = new THREE.Vector3(-sides[i].z, 0, sides[i].x);
      const t = RAILWAYS.pierThickness / 2;
      const corners = [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ].map(([a, b]) =>
        pts[i]
          .clone()
          .addScaledVector(sides[i], a * t)
          .addScaledVector(tangent, b * t),
      );
      for (let k = 0; k < 4; k++) {
        const p = corners[k];
        const q = corners[(k + 1) % 4];
        const a = viaduct.vertex(p.clone().setY(bottom), 0, 0);
        const b = viaduct.vertex(q.clone().setY(bottom), 1, 0);
        const c = viaduct.vertex(p.clone().setY(top), 0, 1);
        const d = viaduct.vertex(q.clone().setY(top), 1, 1);
        viaduct.quad(a, b, c, d);
      }
    }
    return { pts, lift, sides, inStation };
  }

  /**
   * 跨座式のモノレールの桁（上面が走る面）と橋脚。低い所は桁の下を地面まで壁にする。
   * トンネルの入口へ下りる所（地面より下）は桁だけ
   */
  private buildMonorailBeam(
    b: MeshBuilder,
    samples: Array<[number, number]>,
    s: number[],
    lift: number[],
    ground: number[],
    pts: THREE.Vector3[],
    sides: THREE.Vector3[],
    at: (i: number, across: number, dy: number) => THREE.Vector3,
    noPier: ReadonlyArray<readonly [number, number, number]>,
  ): void {
    const M = RAILWAYS.monorail;
    const w = M.beamWidth / 2;
    const groundY = (i: number) => this.terrain.toLocal(samples[i][0], samples[i][1], ground[i] - 0.5).y;
    // 桁：上面・両側面・底面。低い所は側面を地面まで下ろす
    const low = (i: number) => lift[i] < M.wallBelow && lift[i] >= 0;
    const strip = (fa: (i: number) => THREE.Vector3, fb: (i: number) => THREE.Vector3) => {
      let p: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        const va = b.vertex(fa(i), s[i] / 4, 0);
        const vb = b.vertex(fb(i), s[i] / 4, 1);
        if (p) b.quad(p[0], p[1], va, vb);
        p = [va, vb];
      }
    };
    const bottom = (i: number) => (low(i) ? groundY(i) - pts[i].y : -M.beamDepth);
    strip(
      (i) => at(i, w, 0),
      (i) => at(i, -w, 0),
    );
    strip(
      (i) => at(i, w, bottom(i)),
      (i) => at(i, w, 0),
    );
    strip(
      (i) => at(i, -w, 0),
      (i) => at(i, -w, bottom(i)),
    );
    strip(
      (i) => at(i, -w, bottom(i)),
      (i) => at(i, w, bottom(i)),
    );
    // 橋脚：桁の下の四角い柱（下を通る道路の上には立てない）
    for (let i = 1; i < pts.length; i++) {
      if (Math.floor(s[i] / M.pierSpacing) === Math.floor(s[i - 1] / M.pierSpacing)) continue;
      if (lift[i] < M.wallBelow) continue;
      const [plat, plon] = samples[i];
      if (noPier.some(([lat, lon, r]) => approxMeters(lat, lon, plat, plon) < r + M.pierThickness)) continue;
      const top = pts[i].y - M.beamDepth;
      const base = groundY(i);
      if (top - base < 1) continue;
      const tangent = new THREE.Vector3(-sides[i].z, 0, sides[i].x);
      const t = M.pierThickness / 2;
      const corners = [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ].map(([a, c]) =>
        pts[i]
          .clone()
          .addScaledVector(sides[i], a * t)
          .addScaledVector(tangent, c * t),
      );
      for (let k = 0; k < 4; k++) {
        const p = corners[k];
        const q = corners[(k + 1) % 4];
        b.quad(
          b.vertex(p.clone().setY(base), 0, 0),
          b.vertex(q.clone().setY(base), 1, 0),
          b.vertex(p.clone().setY(top), 0, 1),
          b.vertex(q.clone().setY(top), 1, 1),
        );
      }
    }
  }
}

/** 金網の柵の画像（横 = 支柱1本ぶんの間隔、縦 = 柵の高さ）：灰色の支柱・上下の横棒と、ひし形の金網。網の隙間は透明 */
function createFenceMaterial(): THREE.MeshStandardMaterial {
  const w = 64;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  // ひし形の金網
  g.strokeStyle = 'rgba(150,156,152,0.85)';
  g.lineWidth = 1.2;
  for (let k = -h; k < w + h; k += 8) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + h, h);
    g.moveTo(k, h);
    g.lineTo(k + h, 0);
    g.stroke();
  }
  // 支柱と、上下の横棒
  g.fillStyle = '#8d928f';
  g.fillRect(0, 0, 4, h);
  g.fillRect(0, 0, w, 3);
  g.fillRect(0, h - 3, w, 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 });
}

/**
 * 道床の画像（幅 = 道床の幅、長さ 2.4m）：茶色い砂利、コンクリートの枕木、2本のレール。
 * gauge はレールの間隔 (m)
 */
function createTrackMaterial(gauge: number): THREE.MeshStandardMaterial {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const pxPerM = w / RAILWAYS.ballastWidth;

  // 砂利：灰色がかった薄茶色の濃淡の粒。両端は少し暗くして溝のように
  g.fillStyle = '#7f7164';
  g.fillRect(0, 0, w, h);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2200; i++) {
    const v = 85 + rand() * 70;
    g.fillStyle = `rgb(${v + 14},${v + 5},${v - 4})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
  const edge = g.createLinearGradient(0, 0, w, 0);
  edge.addColorStop(0, 'rgba(30,20,15,0.45)');
  edge.addColorStop(0.12, 'rgba(30,20,15,0)');
  edge.addColorStop(0.88, 'rgba(30,20,15,0)');
  edge.addColorStop(1, 'rgba(30,20,15,0.45)');
  g.fillStyle = edge;
  g.fillRect(0, 0, w, h);

  // 枕木（長さ 2.0m × 幅 0.24m、0.6m 間隔）
  const sleeperLen = 2.0 * pxPerM;
  const sleeperW = 0.24 * (h / 2.4);
  for (let k = 0; k < 4; k++) {
    const y = (k + 0.5) * (h / 4) - sleeperW / 2;
    g.fillStyle = '#8f8a82';
    g.fillRect((w - sleeperLen) / 2, y, sleeperLen, sleeperW);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect((w - sleeperLen) / 2, y + sleeperW - 1.5, sleeperLen, 1.5);
  }

  // レール：鈍い鋼色に、上面の光った筋
  const railW = Math.max(2, 0.07 * pxPerM);
  for (const sign of [-1, 1]) {
    const x = w / 2 + (sign * gauge * pxPerM) / 2 - railW / 2;
    g.fillStyle = '#3d3a38';
    g.fillRect(x - 1, 0, railW + 2, h);
    g.fillStyle = '#c9c6c0';
    g.fillRect(x + railW * 0.3, 0, railW * 0.4, h);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.95,
    // 地形・道路とちらつかないよう手前に寄せる
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

/** トンネルの入口・擁壁のコンクリート：型枠の縦の継ぎ目と、上からの雨だれの汚れ（1枚 = 4m 四方） */
function createPortalConcreteMaterial(): THREE.MeshStandardMaterial {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#b3b1aa';
  g.fillRect(0, 0, size, size);
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // ざらつき
  for (let i = 0; i < 3000; i++) {
    const v = 150 + rand() * 50;
    g.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`;
    g.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
  }
  // 雨だれ（上から下へ細く暗い筋）
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const len = size * (0.2 + rand() * 0.6);
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, 'rgba(60,58,52,0.35)');
    grad.addColorStop(1, 'rgba(60,58,52,0)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 1 + rand() * 4, len);
  }
  // 型枠の継ぎ目（縦 0.9m おき、横 1.8m おき）
  g.fillStyle = 'rgba(70,68,64,0.5)';
  for (let k = 0; k <= 4; k++) g.fillRect((k * size) / 4.44 - 1, 0, 2, size);
  for (let k = 0; k <= 2; k++) g.fillRect(0, (k * size) / 2.22 - 1, size, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.25, 0.25);
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, side: THREE.DoubleSide });
}
