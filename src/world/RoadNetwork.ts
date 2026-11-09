import * as THREE from 'three';
import { BRIDGES, ROADS, WATER } from '../core/config';
import {
  columnU,
  createCrosswalkMaterial,
  createRoadMaterial,
  createSidewalkMaterial,
  RoadClass,
  roadLayout,
  TEMPLATE_LENGTH_M,
  type RoadLayout,
} from './roadTemplates';
import { fillGaps, smoothGround } from './groundProfile';
import type { ChunkListener, Terrain } from './Terrain';
import { DATA_BASE } from '../core/region';

/** 道路データ1タイル（scripts/fetch-road-network.mjs の出力） */
interface RoadTile {
  /** [種別, 車線数, 一方通行, 座標（1e-6度、先頭以外は差分）, 交差点の点の番号, 橋（0 か BridgeInfo）] */
  w: Array<[RoadClass, number, 0 | 1, number[], number[], (0 | BridgeInfo)?]>;
  /** [緯度, 経度（1e-6度）, 道の方位(rad), 種別] */
  c: Array<[number, number, number, RoadClass]>;
}

/**
 * 橋：[始点の緯度, 経度, 終点の緯度, 経度（1e-6度）, 橋全体の長さ(m), この区間の始まりまでの長さ(m), 名前,
 *      （跨線橋なら）地面から必要な高さ(m)]。最後の値は scripts/build-rail-heights.mjs が付ける
 */
type BridgeInfo = [number, number, number, number, number, number, string, number?];

/** 頂点を溜めて最後に BufferGeometry にする */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly uvs: number[] = [];
  readonly attrs: number[] = [];
  readonly indices: number[] = [];

  vertex(p: THREE.Vector3, u: number, v: number, attr?: [number, number]): number {
    this.positions.push(p.x, p.y, p.z);
    this.uvs.push(u, v);
    if (attr) this.attrs.push(attr[0], attr[1]);
    return this.positions.length / 3 - 1;
  }

  /** a-b が手前、c-d が奥の四角形（a,c が左）。上から見て表になる向きで張る */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, b, d, c);
  }

  build(attrName?: string): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (attrName) g.setAttribute(attrName, new THREE.Float32BufferAttribute(this.attrs, 2));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    return g;
  }
}

/**
 * 道路網。地形チャンクが読まれたら同じ範囲の道路データを読み、
 * 中心線から車道・歩道・横断歩道のメッシュを作って地形に沿わせる。チャンクが捨てられたら一緒に捨てる。
 */
export class RoadNetwork implements ChunkListener {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, THREE.Group | 'loading'>();
  /** 読んだが、まわりのチャンクの地形がそろうのを待っているタイル → そのデータ */
  private readonly waiting = new Map<string, RoadTile>();
  /** 均した地面（smoothGround）の格子点の平均。タイルを作る間だけ使い回す */
  private smoothCache = new Map<string, number | null>();
  /** 今作っているタイルの、地形を道の高さにそろえる線と幅 */
  private gradeLines: THREE.Vector3[][] = [];
  private gradeWidths: number[] = [];
  private bridgeLines: THREE.Vector3[][] = [];
  private bridgeWidths: number[] = [];
  private readonly roadMaterial = createRoadMaterial();
  private readonly sidewalkMaterial = createSidewalkMaterial();
  private readonly crosswalkMaterial = createCrosswalkMaterial();
  /** 中央分離帯（植え込み） */
  private readonly medianMaterial = new THREE.MeshStandardMaterial({ color: ROADS.medianColor, roughness: 0.9 });
  private readonly concreteMaterial = new THREE.MeshStandardMaterial({
    color: BRIDGES.concreteColor,
    roughness: 0.85,
    // 桁・橋脚は向きの違う面が混ざるので両面にする
    side: THREE.DoubleSide,
  });
  private readonly railingMaterial = new THREE.MeshStandardMaterial({
    color: BRIDGES.railingColor,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
  private readonly steelMaterial = new THREE.MeshStandardMaterial({
    color: BRIDGES.archColor,
    metalness: 0.5,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
  }

  onChunkAdded(x: number, y: number): void {
    const key = `${x}/${y}`;
    // まわりの地形がそろうのを待っていたタイルを作る
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.buildWhenReady(x + dx, y + dy);
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    const url = `${DATA_BASE}${ROADS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    fetch(url)
      // 道路の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<RoadTile>) : null,
      )
      .then((data) => {
        // 読んでいる間にチャンクが捨てられていたら何もしない
        if (this.tiles.get(key) !== 'loading') return;
        if (!data) {
          const empty = new THREE.Group();
          this.tiles.set(key, empty);
          this.group.add(empty);
          return;
        }
        this.waiting.set(key, data);
        this.buildWhenReady(x, y);
      })
      .catch((e) => {
        console.warn('[Roads] 読込に失敗しました', key, e);
        this.tiles.delete(key);
      });
  }

  onChunkRemoved(x: number, y: number): void {
    const key = `${x}/${y}`;
    const tile = this.tiles.get(key);
    this.tiles.delete(key);
    this.waiting.delete(key);
    this.terrain.removeCarve(`road:${key}`);
    this.terrain.removeCarve(`road-bridge:${key}`);
    if (!tile || tile === 'loading') return;
    this.disposeTile(tile);
  }

  /**
   * 待っているタイル (x, y) を、まわり 8 チャンクの地形がそろっていれば作る。道の端は隣のチャンクにはみ出すので、
   * そろう前に作ると高さを近くの値で代用することになり、つなぎ目に段差ができる（作り直すと二度手間でカクつく）
   */
  private buildWhenReady(x: number, y: number): void {
    const key = `${x}/${y}`;
    const data = this.waiting.get(key);
    if (!data) return;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!this.terrain.isChunkReady(x + dx, y + dy)) return;
    this.waiting.delete(key);
    const group = this.buildTile(data, key);
    this.tiles.set(key, group);
    this.group.add(group);
  }

  private disposeTile(tile: THREE.Group): void {
    this.group.remove(tile);
    tile.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }

  private buildTile(data: RoadTile, key: string): THREE.Group {
    this.smoothCache = new Map();
    this.gradeLines = [];
    this.gradeWidths = [];
    this.bridgeLines = [];
    this.bridgeWidths = [];
    const road = new MeshBuilder();
    const sidewalk = new MeshBuilder();
    const crosswalk = new MeshBuilder();
    const bridge: BridgeParts = { body: new MeshBuilder(), railing: new MeshBuilder(), steel: new MeshBuilder() };
    const ways = data.w.map(([cls, lanes, oneway, coords, junctions, bridgeInfo]) => ({
      cls,
      oneway: oneway === 1,
      layout: roadLayout(cls, lanes, oneway === 1),
      points: decode(coords),
      junctions,
      bridge: bridgeInfo || null,
    }));
    const intersections = findIntersections(ways);
    const median = new MeshBuilder();
    // 上下線が別の道になっている大通り（幹線・2車線の一方通行）：相方を探して中央分離帯にするための線（ローカル座標の xz）
    const divided = ways.map((w) =>
      w.oneway && w.cls !== RoadClass.Local && !w.bridge
        ? w.points.map(([lat, lon]) => this.terrain.toLocal(lat, lon, 0))
        : null,
    );
    for (const [index, way] of ways.entries()) {
      const partners = divided[index] ? divided.filter((d, j): d is THREE.Vector3[] => d !== null && j !== index) : [];
      // この道の上の交差点（点の番号と、交差点の半径）
      const stops = way.junctions.flatMap((i) => {
        const j = intersections.get(pointKey(way.points[i]));
        return j ? [{ index: i, radius: j.radius }] : [];
      });
      this.buildWay(way.layout, way.points, stops, way.bridge, road, sidewalk, bridge, partners, median);
    }
    for (const j of intersections.values()) this.buildIntersection(j, road, sidewalk);
    for (const [lat, lon, bearing, cls] of data.c) {
      this.buildCrosswalk(lat / 1e6, lon / 1e6, bearing, roadLayout(cls, 0, false), crosswalk);
    }
    // 道の幅（と歩道・少しの余裕）の地形を道の高さにそろえる（高い所は削り、低い所は盛る）。その外はなだらかに戻す
    if (this.gradeLines.length > 0) {
      this.terrain.addCarve(`road:${key}`, this.gradeLines, 0, ROADS.gradeSlope, {
        widths: this.gradeWidths,
        fill: { reach: ROADS.gradeFillReach, slope: ROADS.gradeSlope },
        slopeReach: ROADS.gradeReach,
      });
    }
    if (this.bridgeLines.length > 0) {
      this.terrain.addCarve(`road-bridge:${key}`, this.bridgeLines, 0, ROADS.bridgeCutSlope, { widths: this.bridgeWidths });
    }
    const group = new THREE.Group();
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material) => {
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(road.build('roadAttr'), this.roadMaterial);
    add(sidewalk.build(), this.sidewalkMaterial);
    add(crosswalk.build(), this.crosswalkMaterial);
    add(median.build(), this.medianMaterial);
    add(bridge.body.build(), this.concreteMaterial);
    add(bridge.railing.build(), this.railingMaterial);
    add(bridge.steel.build(), this.steelMaterial);
    return group;
  }

  /**
   * 道を置く地面の高さ：場所だけで決まる均した地面（道どうし・交差点・横断歩道で同じ値になる）。
   * まだ読んでいないチャンクにかかって取れなければ null
   */
  private groundAt(lat: number, lon: number): number | null {
    return smoothGround(this.terrain, lat, lon, ROADS.smoothRadius, this.smoothCache);
  }

  /** 1本の道（中心線）から車道と歩道のリボンを作る。橋なら地形に沿わせず、橋桁・欄干・橋脚も作る */
  private buildWay(
    layout: RoadLayout,
    points: Array<[number, number]>,
    junctions: Array<{ index: number; radius: number }>,
    bridge: BridgeInfo | null,
    road: MeshBuilder,
    sidewalk: MeshBuilder,
    bridgeParts: BridgeParts,
    partners: THREE.Vector3[][] = [],
    median: MeshBuilder | null = null,
  ): void {
    // 細かく区切った点の緯度経度と、中心線に沿った距離 s
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    const junctionS: Array<{ s: number; radius: number }> = [];
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i];
      if (i > 0) {
        const [plat, plon] = points[i - 1];
        const length = approxMeters(plat, plon, lat, lon);
        const steps = Math.max(1, Math.ceil(length / ROADS.densifyStep));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          samples.push([plat + (lat - plat) * t, plon + (lon - plon) * t]);
          s.push(s[s.length - 1] + length / steps);
        }
      } else {
        samples.push([lat, lon]);
        s.push(0);
      }
      for (const j of junctions) if (j.index === i) junctionS.push({ s: s[s.length - 1], radius: j.radius });
    }

    // 高さ：ふつうの道は均した地面（地形の細かい凸凹を拾わない。交差点・隣のタイルの道とも同じ高さになる）、
    // 橋は両岸の高さを結んだ橋桁にする
    const deck = bridge ? this.bridgeProfile(bridge, samples, s) : null;
    let ground: number[] | null = null;
    if (!deck) {
      const raw = samples.map(([lat, lon]) => this.groundAt(lat, lon));
      ground = fillGaps(raw);
      if (!ground) return;
    }
    const pts = samples.map(([lat, lon], i) => this.terrain.toLocal(lat, lon, deck ? deck(s[i]) : ground![i]));
    if (pts.length < 2) return;
    if (!deck) {
      this.gradeLines.push(simplifyLine(pts, 0.5, 0.25));
      this.gradeWidths.push(layout.width + layout.sidewalk * 2 + ROADS.gradeMargin * 2);
    } else {
      // 橋：橋桁より上に出ている地形（土手・丘）は削る
      this.bridgeLines.push(simplifyLine(pts, 0.5, 0.25).map((p) => p.clone().setY(p.y - BRIDGES.girderDepth)));
      this.bridgeWidths.push(layout.width + layout.sidewalk * 2 + ROADS.gradeMargin * 2);
    }

    const half = layout.width / 2;
    /** 交差点の面の外側までの距離（交差点の中なら負） */
    const outside = (si: number) => junctionS.reduce((d, j) => Math.min(d, Math.abs(si - j.s) - j.radius), Infinity);
    const side = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    // 各点の左右の向き（前後の点から）
    const sides = pts.map((_, i) => {
      tangent.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).setY(0).normalize();
      return new THREE.Vector3().crossVectors(up, tangent).normalize();
    });

    // 車道
    const u0 = columnU(layout.column, 0);
    const u1 = columnU(layout.column, 1);
    let prev: [number, number] | null = null;
    for (let i = 0; i < pts.length; i++) {
      // 車線の線は、交差点の面に入る手前で消す
      const mark = THREE.MathUtils.smoothstep(outside(s[i]), 0, 3);
      side.copy(sides[i]);
      const center = tmp.copy(pts[i]).setY(pts[i].y + layout.lift);
      const v = s[i] / TEMPLATE_LENGTH_M;
      const left = road.vertex(center.clone().addScaledVector(side, half), u0, v, [mark, layout.shade]);
      const right = road.vertex(center.clone().addScaledVector(side, -half), u1, v, [mark, layout.shade]);
      if (prev) road.quad(prev[0], prev[1], left, right);
      prev = [left, right];
    }

    if (deck && bridge) this.buildBridgeParts(bridge, layout, pts, sides, s, samples, bridgeParts);

    // 上下線が別の道の大通り：各点で、反対向きに並ぶ相方の道までの横の距離（左が +、無ければ 0）
    const partnerOffset = partners.length > 0 ? this.partnerOffsets(pts, sides, partners) : null;

    // 歩道：交差点のまわりは途切れさせる。相方の道のある側は、歩道の代わりに中央分離帯（相方との真ん中まで）
    for (const dir of [1, -1]) {
      let prevSw: [number, number] | null = null;
      let prevMd: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        const offset = partnerOffset ? partnerOffset[i] * dir : 0;
        if (outside(s[i]) < 0) {
          prevSw = prevMd = null;
          continue;
        }
        side.copy(sides[i]).multiplyScalar(dir);
        const base = tmp.copy(pts[i]).setY(pts[i].y + layout.lift + ROADS.curbHeight);
        if (offset > 0) {
          prevSw = null;
          // 真ん中まで（相方の道と重なるほど近ければ作らない）
          const reach = offset / 2;
          if (!median || reach < half + 0.3) {
            prevMd = null;
            continue;
          }
          const inner = base.clone().addScaledVector(side, half);
          const outer = base.clone().addScaledVector(side, reach + 0.05);
          const a = median.vertex(dir === 1 ? outer : inner, 0, 0);
          const b = median.vertex(dir === 1 ? inner : outer, 0, 0);
          if (prevMd) median.quad(prevMd[0], prevMd[1], a, b);
          prevMd = [a, b];
          continue;
        }
        prevMd = null;
        if (layout.sidewalk <= 0) continue;
        const inner = base.clone().addScaledVector(side, half);
        const outer = base.clone().addScaledVector(side, half + layout.sidewalk);
        const v = s[i] / 2.4;
        const a = sidewalk.vertex(dir === 1 ? outer : inner, 0, v);
        const b = sidewalk.vertex(dir === 1 ? inner : outer, layout.sidewalk / 2.4, v);
        if (prevSw) sidewalk.quad(prevSw[0], prevSw[1], a, b);
        prevSw = [a, b];
      }
    }
  }

  /**
   * 各点から、反対向きに並んで走る相方の道（中心線）までの横の距離。左（sides の向き）が +、見つからなければ 0。
   * 向きが逆（なす角 135° 以上）で、横に MEDIAN_SEARCH m 以内の一番近いものを選ぶ
   */
  private partnerOffsets(pts: THREE.Vector3[], sides: THREE.Vector3[], partners: THREE.Vector3[][]): Float32Array {
    const out = new Float32Array(pts.length);
    const t = new THREE.Vector3();
    const seg = new THREE.Vector3();
    const w = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      t.subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).setY(0).normalize();
      let best = Infinity;
      let lateral = 0;
      for (const line of partners) {
        for (let k = 1; k < line.length; k++) {
          const a = line[k - 1];
          const b = line[k];
          seg.subVectors(b, a).setY(0);
          const len = seg.length();
          if (len < 0.1) continue;
          seg.divideScalar(len);
          if (seg.dot(t) > -0.7) continue;
          // 線分の上の一番近い点
          w.subVectors(p, a).setY(0);
          const along = THREE.MathUtils.clamp(w.dot(seg), 0, len);
          w.set(a.x + seg.x * along - p.x, 0, a.z + seg.z * along - p.z);
          const d = w.length();
          if (d >= best || d > ROADS.medianSearch) continue;
          // 横に並んでいる（前後にずれていない）ものだけ
          const across = w.dot(sides[i]);
          if (Math.abs(across) < d * 0.9) continue;
          best = d;
          lateral = across;
        }
      }
      out[i] = lateral;
    }
    return out;
  }

  /**
   * 橋桁の高さ（標高, m）を、橋全体の中での距離から求める関数。
   * 両端（岸）の地形の高さを直線で結び、中央を少し持ち上げる（反り）。川や海の上では水面から十分に離す
   */
  private bridgeProfile(
    bridge: BridgeInfo,
    samples: Array<[number, number]>,
    s: number[],
  ): (localS: number) => number {
    const [aLat, aLon, bLat, bLon, total, offset, , overRail = 0] = bridge;
    // 橋全体の両端の高さ。まだ地形が無ければ、この区間の端の高さで代用する
    const first = samples[0];
    const last = samples[samples.length - 1];
    const fallbackA = this.terrain.heightAt(first[0], first[1]) ?? WATER.surfaceHeight;
    const fallbackB = this.terrain.heightAt(last[0], last[1]) ?? fallbackA;
    // 両端は、つながる道と同じ均した地面の高さ（段差を作らない）
    const hA = this.groundAt(aLat / 1e6, aLon / 1e6) ?? this.terrain.heightAt(aLat / 1e6, aLon / 1e6) ?? fallbackA;
    const hB = this.groundAt(bLat / 1e6, bLon / 1e6) ?? this.terrain.heightAt(bLat / 1e6, bLon / 1e6) ?? fallbackB;
    const length = Math.max(total, s[s.length - 1] + offset, 1);
    const rise = Math.min(BRIDGES.maxCamber, length * BRIDGES.camberRatio);
    const clearance = length > BRIDGES.longBridge ? BRIDGES.waterClearance : BRIDGES.waterClearance * 0.4;
    return (localS) => {
      const u = THREE.MathUtils.clamp((localS + offset) / length, 0, 1);
      const arc = Math.sin(Math.PI * u);
      const base = THREE.MathUtils.lerp(hA, hB, u) + rise * arc;
      // 両端は岸の高さに合わせ、中ほどは水面から clearance 以上の高さにする。
      // 跨線橋は、下の線路の上 overRail m 以上（両端の低い方の地面から測る）
      const overWater = WATER.surfaceHeight + clearance * Math.pow(arc, 0.35);
      const overTracks = Math.min(hA, hB) + overRail * Math.pow(arc, 0.35);
      return Math.max(base, overWater, overRail > 0 ? overTracks : -Infinity);
    };
  }

  /** 橋の側面の桁・底面・欄干・橋脚、名前のある長い橋には鋼のアーチを作る */
  private buildBridgeParts(
    bridge: BridgeInfo,
    layout: RoadLayout,
    pts: THREE.Vector3[],
    sides: THREE.Vector3[],
    s: number[],
    samples: Array<[number, number]>,
    parts: BridgeParts,
  ): void {
    const [, , , , total, offset, name] = bridge;
    const edge = layout.width / 2 + layout.sidewalk + 0.3;
    const top = layout.lift + ROADS.curbHeight;
    const depth = total > BRIDGES.longBridge ? BRIDGES.girderDepth : BRIDGES.girderDepth * 0.6;
    const at = (i: number, across: number, dy: number) =>
      pts[i].clone().addScaledVector(sides[i], across).setY(pts[i].y + dy);

    // 側面の桁（左右）と底面
    const strip = (builder: MeshBuilder, a: (i: number) => THREE.Vector3, b: (i: number) => THREE.Vector3) => {
      let prev: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        const va = builder.vertex(a(i), s[i] / 4, 0);
        const vb = builder.vertex(b(i), s[i] / 4, 1);
        if (prev) builder.quad(prev[0], prev[1], va, vb);
        prev = [va, vb];
      }
    };
    strip(parts.body, (i) => at(i, edge, top), (i) => at(i, edge, -depth));
    strip(parts.body, (i) => at(i, -edge, -depth), (i) => at(i, -edge, top));
    strip(parts.body, (i) => at(i, edge, -depth), (i) => at(i, -edge, -depth));
    // 欄干（両面）
    strip(parts.railing, (i) => at(i, edge, top + BRIDGES.railingHeight), (i) => at(i, edge, top));
    strip(parts.railing, (i) => at(i, -edge, top), (i) => at(i, -edge, top + BRIDGES.railingHeight));

    // 橋脚：一定の間隔で、橋桁の下に地面（川底）まで下ろす
    for (let i = 0; i < pts.length; i++) {
      const globalS = s[i] + offset;
      const prevS = i > 0 ? s[i - 1] + offset : -Infinity;
      if (Math.floor(globalS / BRIDGES.pierSpacing) === Math.floor(prevS / BRIDGES.pierSpacing)) continue;
      if (globalS < BRIDGES.pierSpacing * 0.5 || globalS > total - BRIDGES.pierSpacing * 0.5) continue;
      const ground = this.terrain.heightAt(samples[i][0], samples[i][1]);
      if (ground === null) continue;
      const bottomY = this.terrain.toLocal(samples[i][0], samples[i][1], ground - 2).y;
      if (pts[i].y - depth - bottomY < 3) continue;
      const tangent = new THREE.Vector3(-sides[i].z, 0, sides[i].x);
      box(parts.body, pts[i].clone().setY(pts[i].y - depth), bottomY, sides[i], tangent, edge * 0.7, BRIDGES.pierThickness / 2);
    }

    // 名前のある長い橋：左右に鋼のアーチと吊り材
    // 「〜橋」の名前の橋と、大きな橋に付ける（OSM では勝鬨橋の名前が「晴海通り」になっているなど、
    // 橋の名前が入っていないことが多い）。陸の上の高架には付けないよう、橋の中央が水の上のものだけ
    const named = /(橋|ブリッジ)$/.test(name) && total >= BRIDGES.archMinLength;
    const large = total >= BRIDGES.archMinLengthUnnamed;
    if (!named && !large) return;
    const [aLat, aLon, bLat, bLon] = bridge;
    const midHeight = this.terrain.heightAt((aLat + bLat) / 2e6, (aLon + bLon) / 2e6);
    if (midHeight === null || midHeight > WATER.surfaceHeight + 0.5) return;
    const archHeight = Math.min(BRIDGES.archMaxHeight, total * BRIDGES.archRatio);
    const archAt = (i: number) => archHeight * Math.sin(Math.PI * THREE.MathUtils.clamp((s[i] + offset) / total, 0, 1));
    for (const dir of [1, -1]) {
      const across = dir * (edge - 0.2);
      // アーチの帯（幅 BRIDGES.archWidth の縦長の帯）
      strip(
        parts.steel,
        (i) => at(i, across, top + archAt(i)),
        (i) => at(i, across, top + Math.max(0, archAt(i) - BRIDGES.archWidth)),
      );
      // 吊り材
      for (let i = 0; i < pts.length; i++) {
        const globalS = s[i] + offset;
        const prevS = i > 0 ? s[i - 1] + offset : -Infinity;
        if (Math.floor(globalS / BRIDGES.hangerSpacing) === Math.floor(prevS / BRIDGES.hangerSpacing)) continue;
        if (archAt(i) < BRIDGES.archWidth * 1.5) continue;
        const tangent = new THREE.Vector3(-sides[i].z, 0, sides[i].x);
        const base = at(i, across, top);
        box(parts.steel, base.clone().setY(base.y + archAt(i) - BRIDGES.archWidth), base.y, sides[i], tangent, 0.12, 0.12);
      }
    }
  }

  /**
   * 交差点の面：集まる道の歩道の外側の角を結んだ面を歩道で塗り、その内側を車道（線なし）で塗る。
   * 上から見ると、歩道が交差点の角を回り込んでつながり、車道は交差点の中で一続きになる
   */
  private buildIntersection(j: Intersection, road: MeshBuilder, sidewalk: MeshBuilder): void {
    const ground = this.groundAt(j.lat, j.lon);
    if (ground === null) return;
    const center = this.terrain.toLocal(j.lat, j.lon, ground);
    const up = new THREE.Vector3(0, 1, 0);
    const outer: THREE.Vector3[] = [];
    const inner: THREE.Vector3[] = [];
    let lift = 0;
    for (const arm of j.arms) {
      const dir = this.terrain.toLocal(arm.toward[0], arm.toward[1], ground).sub(center).setY(0);
      if (dir.lengthSq() < 1e-6) continue;
      dir.normalize();
      const side = new THREE.Vector3().crossVectors(up, dir);
      const half = arm.layout.width / 2;
      const end = center.clone().addScaledVector(dir, j.radius);
      inner.push(end.clone().addScaledVector(side, half), end.clone().addScaledVector(side, -half));
      const sw = half + arm.layout.sidewalk;
      outer.push(end.clone().addScaledVector(side, sw), end.clone().addScaledVector(side, -sw));
      lift = Math.max(lift, arm.layout.lift);
    }
    if (inner.length < 6) return;
    const walkY = center.y + lift + ROADS.curbHeight;
    fan(sidewalk, center, outer, walkY, (p) => [p.x / 2.4, p.z / 2.4]);
    // アスファルトの明るさは、集まる道のうち一番広い道に合わせる（細い道どうしの交差点が暗く浮かないように）
    const widest = j.arms.reduce((a, b) => (b.layout.width > a.layout.width ? b : a)).layout;
    const roadMark: [number, number] = [0, widest.shade];
    fan(road, center, inner, walkY + 0.03, () => [0.5, 0], roadMark);
  }

  /** 横断歩道：道の向きに沿った縞を、道幅いっぱいに置く */
  private buildCrosswalk(lat: number, lon: number, bearing: number, layout: RoadLayout, out: MeshBuilder): void {
    const height = this.groundAt(lat, lon);
    if (height === null) return;
    const center = this.terrain.toLocal(lat, lon, height);
    // 交差点の面より上に（交差点の面は、集まる道で一番高い道の歩道の高さ＋α）
    center.y += ROADS.classes[0].lift + ROADS.curbHeight + 0.06;
    // 方位（北から時計回り）→ ローカル座標（+x=西, +z=北）
    const along = new THREE.Vector3(-Math.sin(bearing), 0, Math.cos(bearing));
    const across = new THREE.Vector3(-along.z, 0, along.x);
    const half = layout.width / 2;
    const len = ROADS.crosswalkLength / 2;
    const corner = (a: number, l: number) => center.clone().addScaledVector(across, a).addScaledVector(along, l);
    // u は幅方向に 0.9m で縞1周期
    const uMax = layout.width / 0.9;
    const a = out.vertex(corner(-half, -len), 0, 0);
    const b = out.vertex(corner(half, -len), uMax, 0);
    const c = out.vertex(corner(-half, len), 0, 1);
    const d = out.vertex(corner(half, len), uMax, 1);
    out.quad(a, b, c, d);
  }
}

/** 交差点（3方向以上に道が分かれる点） */
interface Intersection {
  lat: number;
  lon: number;
  /** 交差点の面の半径：集まる道で一番広い「車道の半分＋歩道」＋余白 (m) */
  radius: number;
  /** 交差点から出る道：その道と、向かう先の点（緯度経度） */
  arms: Array<{ layout: RoadLayout; toward: [number, number] }>;
}

function pointKey([lat, lon]: [number, number]): string {
  return `${Math.round(lat * 1e6)},${Math.round(lon * 1e6)}`;
}

/** タイルの中の交差点を探す。2本の道がつながっているだけの点（データの区切り目）は交差点にしない */
function findIntersections(
  ways: Array<{ layout: RoadLayout; points: Array<[number, number]>; junctions: number[]; bridge: BridgeInfo | null }>,
): Map<string, Intersection> {
  const all = new Map<string, Intersection & { bridge: boolean }>();
  for (const way of ways) {
    for (const i of way.junctions) {
      const p = way.points[i];
      const key = pointKey(p);
      let j = all.get(key);
      if (!j) all.set(key, (j = { lat: p[0], lon: p[1], radius: 0, arms: [], bridge: false }));
      if (way.bridge) j.bridge = true;
      if (i > 0) j.arms.push({ layout: way.layout, toward: way.points[i - 1] });
      if (i < way.points.length - 1) j.arms.push({ layout: way.layout, toward: way.points[i + 1] });
    }
  }
  const out = new Map<string, Intersection>();
  for (const [key, j] of all) {
    // 橋の上の交差点は高さが合わないので作らない
    if (j.arms.length < 3 || j.bridge) continue;
    j.radius = Math.max(...j.arms.map((a) => a.layout.width / 2 + a.layout.sidewalk)) + ROADS.junctionMargin;
    out.set(key, j);
  }
  return out;
}

/** 中心のまわりの点を角度順に並べ、中心から扇形に三角形を張る（上向きの面にする） */
function fan(
  out: MeshBuilder,
  center: THREE.Vector3,
  points: THREE.Vector3[],
  y: number,
  uv: (p: THREE.Vector3) => [number, number],
  attr?: [number, number],
): void {
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.z - center.z, a.x - center.x) - Math.atan2(b.z - center.z, b.x - center.x),
  );
  const c = center.clone().setY(y);
  const ci = out.vertex(c, ...uv(c), attr);
  const idx = sorted.map((p) => {
    const q = p.clone().setY(y);
    return out.vertex(q, ...uv(q), attr);
  });
  for (let k = 0; k < idx.length; k++) {
    const a = sorted[k];
    const b = sorted[(k + 1) % sorted.length];
    // 上から見て反時計回りなら上向き。逆なら入れ替える
    const ccw = (a.x - c.x) * (b.z - c.z) - (a.z - c.z) * (b.x - c.x) < 0;
    if (ccw) out.indices.push(ci, idx[k], idx[(k + 1) % idx.length]);
    else out.indices.push(ci, idx[(k + 1) % idx.length], idx[k]);
  }
}

interface BridgeParts {
  /** 桁・底面・橋脚（コンクリート） */
  body: MeshBuilder;
  /** 欄干 */
  railing: MeshBuilder;
  /** アーチ・吊り材（鋼） */
  steel: MeshBuilder;
}

/**
 * 上面の中心 topCenter から下端 bottomY までの縦長の箱（側面4枚）。
 * side・tangent は水平の向き、halfSide・halfTangent はそれぞれの向きの半分の大きさ
 */
function box(
  builder: MeshBuilder,
  topCenter: THREE.Vector3,
  bottomY: number,
  side: THREE.Vector3,
  tangent: THREE.Vector3,
  halfSide: number,
  halfTangent: number,
): void {
  const corners = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ].map(([a, b]) => topCenter.clone().addScaledVector(side, a * halfSide).addScaledVector(tangent, b * halfTangent));
  for (let k = 0; k < 4; k++) {
    const p = corners[k];
    const q = corners[(k + 1) % 4];
    const a = builder.vertex(p.clone().setY(bottomY), 0, 0);
    const b = builder.vertex(q.clone().setY(bottomY), 1, 0);
    const c = builder.vertex(p, 0, 1);
    const d = builder.vertex(q, 1, 1);
    builder.quad(a, b, c, d);
  }
}

/** 差分で詰めた 1e-6 度の座標を、緯度経度（度）の組にする */
export function decode(coords: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < coords.length; i += 2) {
    lat += coords[i];
    lon += coords[i + 1];
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}

export function approxMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  return Math.hypot(x, (lat2 - lat1) * k) * 6371000;
}

/**
 * 線の点を、なくしても線が水平に tolXZ m・高さで tolY m 以上ずれない所だけ間引く（Douglas-Peucker）。
 * 地形を道に合わせる計算で、調べる線分を減らす
 */
function simplifyLine(pts: THREE.Vector3[], tolXZ: number, tolY: number): THREE.Vector3[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    const a = pts[i0];
    const b = pts[i1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    let worst = -1;
    let worstScore = 1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      const t = THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / len2, 0, 1);
      const side = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)) / tolXZ;
      const up = Math.abs(p.y - (a.y + (b.y - a.y) * t)) / tolY;
      const score = Math.max(side, up);
      if (score > worstScore) (worstScore = score), (worst = i);
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i0, worst], [worst, i1]);
  }
  return pts.filter((_, i) => keep[i]);
}
