import * as THREE from 'three';
import { ROADS } from '../core/config';
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
  /** [種別, 車線数, 一方通行, 座標（1e-6度、先頭以外は差分）, 交差点の点の番号] */
  w: Array<[RoadClass, number, 0 | 1, number[], number[]]>;
  /** [緯度, 経度（1e-6度）, 道の方位(rad), 種別] */
  c: Array<[number, number, number, RoadClass]>;
}

/** 頂点を溜めて最後に BufferGeometry にする */
class MeshBuilder {
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
    for (const [cls, lanes, oneway, coords, junctions] of data.w) {
      this.buildWay(roadLayout(cls, lanes, oneway === 1), decode(coords), junctions, road, sidewalk);
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
    return group;
  }

  /** 1本の道（中心線）から車道と歩道のリボンを作る */
  private buildWay(
    layout: RoadLayout,
    points: Array<[number, number]>,
    junctions: number[],
    road: MeshBuilder,
    sidewalk: MeshBuilder,
  ): void {
    // 地形に沿うよう細かく区切り、ローカル座標にする。s は中心線に沿った距離
    const pts: THREE.Vector3[] = [];
    const s: number[] = [];
    const junctionS: number[] = [];
    let lastHeight = 0;
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i];
      if (i > 0) {
        const [plat, plon] = points[i - 1];
        const length = approxMeters(plat, plon, lat, lon);
        const steps = Math.max(1, Math.ceil(length / ROADS.densifyStep));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const la = plat + (lat - plat) * t;
          const lo = plon + (lon - plon) * t;
          lastHeight = this.terrain.heightAt(la, lo) ?? lastHeight;
          pts.push(this.terrain.toLocal(la, lo, lastHeight));
          s.push(s[s.length - 1] + length / steps);
        }
      } else {
        lastHeight = this.terrain.heightAt(lat, lon) ?? lastHeight;
        pts.push(this.terrain.toLocal(lat, lon, lastHeight));
        s.push(0);
      }
      if (junctions.includes(i)) junctionS.push(s[s.length - 1]);
    }
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

/** 差分で詰めた 1e-6 度の座標を、緯度経度（度）の組にする */
function decode(coords: number[]): Array<[number, number]> {
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

function approxMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  return Math.hypot(x, (lat2 - lat1) * k) * 6371000;
}
