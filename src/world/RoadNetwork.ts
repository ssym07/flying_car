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
import type { ChunkListener, Terrain } from './Terrain';

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
  private readonly roadMaterial = createRoadMaterial();
  private readonly sidewalkMaterial = createSidewalkMaterial();
  private readonly crosswalkMaterial = createCrosswalkMaterial();
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
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    const url = `${import.meta.env.BASE_URL}${ROADS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    fetch(url)
      // 道路の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<RoadTile>) : null,
      )
      .then((data) => {
        // 読んでいる間にチャンクが捨てられていたら何もしない
        if (this.tiles.get(key) !== 'loading') return;
        const group = data ? this.buildTile(data) : new THREE.Group();
        this.tiles.set(key, group);
        this.group.add(group);
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
    if (!tile || tile === 'loading') return;
    this.group.remove(tile);
    tile.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }

  private buildTile(data: RoadTile): THREE.Group {
    const road = new MeshBuilder();
    const sidewalk = new MeshBuilder();
    const crosswalk = new MeshBuilder();
    const bridge: BridgeParts = { body: new MeshBuilder(), railing: new MeshBuilder(), steel: new MeshBuilder() };
    for (const [cls, lanes, oneway, coords, junctions, bridgeInfo] of data.w) {
      this.buildWay(roadLayout(cls, lanes, oneway === 1), decode(coords), junctions, bridgeInfo || null, road, sidewalk, bridge);
    }
    for (const [lat, lon, bearing, cls] of data.c) {
      this.buildCrosswalk(lat / 1e6, lon / 1e6, bearing, roadLayout(cls, 0, false), crosswalk);
    }
    const group = new THREE.Group();
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material) => {
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(road.build('roadAttr'), this.roadMaterial);
    add(sidewalk.build(), this.sidewalkMaterial);
    add(crosswalk.build(), this.crosswalkMaterial);
    add(bridge.body.build(), this.concreteMaterial);
    add(bridge.railing.build(), this.railingMaterial);
    add(bridge.steel.build(), this.steelMaterial);
    return group;
  }

  /** 1本の道（中心線）から車道と歩道のリボンを作る。橋なら地形に沿わせず、橋桁・欄干・橋脚も作る */
  private buildWay(
    layout: RoadLayout,
    points: Array<[number, number]>,
    junctions: number[],
    bridge: BridgeInfo | null,
    road: MeshBuilder,
    sidewalk: MeshBuilder,
    bridgeParts: BridgeParts,
  ): void {
    // 細かく区切った点の緯度経度と、中心線に沿った距離 s
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    const junctionS: number[] = [];
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
      if (junctions.includes(i)) junctionS.push(s[s.length - 1]);
    }

    // 高さ：ふつうの道は地形に沿わせ、橋は両岸の高さを結んだ橋桁にする
    const deck = bridge ? this.bridgeProfile(bridge, samples, s) : null;
    let lastHeight = 0;
    const pts = samples.map(([lat, lon], i) => {
      if (deck) return this.terrain.toLocal(lat, lon, deck(s[i]));
      lastHeight = this.terrain.heightAt(lat, lon) ?? lastHeight;
      return this.terrain.toLocal(lat, lon, lastHeight);
    });
    if (pts.length < 2) return;

    const half = layout.width / 2;
    const clear = Math.max(half, 5) + ROADS.junctionClear;
    const distToJunction = (si: number) => junctionS.reduce((d, j) => Math.min(d, Math.abs(si - j)), Infinity);
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
      const mark = THREE.MathUtils.smoothstep(distToJunction(s[i]), clear - 3, clear);
      side.copy(sides[i]);
      const center = tmp.copy(pts[i]).setY(pts[i].y + layout.lift);
      const v = s[i] / TEMPLATE_LENGTH_M;
      const left = road.vertex(center.clone().addScaledVector(side, half), u0, v, [mark, layout.shade]);
      const right = road.vertex(center.clone().addScaledVector(side, -half), u1, v, [mark, layout.shade]);
      if (prev) road.quad(prev[0], prev[1], left, right);
      prev = [left, right];
    }

    if (deck && bridge) this.buildBridgeParts(bridge, layout, pts, sides, s, samples, bridgeParts);

    // 歩道：交差点のまわりは途切れさせる
    if (layout.sidewalk <= 0) return;
    for (const dir of [1, -1]) {
      let prevSw: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        if (distToJunction(s[i]) < clear) {
          prevSw = null;
          continue;
        }
        side.copy(sides[i]).multiplyScalar(dir);
        const base = tmp.copy(pts[i]).setY(pts[i].y + layout.lift + ROADS.curbHeight);
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
    const hA = this.terrain.heightAt(aLat / 1e6, aLon / 1e6) ?? fallbackA;
    const hB = this.terrain.heightAt(bLat / 1e6, bLon / 1e6) ?? fallbackB;
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

  /** 横断歩道：道の向きに沿った縞を、道幅いっぱいに置く */
  private buildCrosswalk(lat: number, lon: number, bearing: number, layout: RoadLayout, out: MeshBuilder): void {
    const height = this.terrain.heightAt(lat, lon);
    if (height === null) return;
    const center = this.terrain.toLocal(lat, lon, height);
    center.y += layout.lift + 0.02;
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
