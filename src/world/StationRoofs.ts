import * as THREE from 'three';
import { STATION_ROOFS } from '../core/config';
import { createSidewalkMaterial } from './roadTemplates';
import type { ChunkListener, Terrain } from './Terrain';

/**
 * 屋根データ1件：[種類（0=駅舎, 1=上屋, 2=ホーム）, 地面からの高さ(m), 駅の番号, 座標（1e-6度、先頭以外は差分）]。
 * 高さは駅舎・上屋なら屋根の高さ、ホームなら床の高さ（scripts/build-platforms.mjs が線路に合わせて決める）
 */
type RoofRecord = [0 | 1 | 2, number, number, number[]];

/**
 * 駅の屋根（駅舎・ホームの上屋）とホーム。屋根は写真を参考に、白・銀・薄い緑・青緑の金属の波板屋根にして、
 * 周りの建物（黒・紺）と見分けがつくようにする。上屋は柱で支え、ホームは床・側面・点字ブロックで作る。
 * 地形チャンクが読まれたら同じ範囲の屋根データを読み、形どおりの屋根の板を作る。
 */
export class StationRoofs implements ChunkListener {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, THREE.Group | 'loading'>();
  private readonly roofMaterial = createRoofMaterial();
  private readonly fasciaMaterial = new THREE.MeshStandardMaterial({
    color: STATION_ROOFS.fasciaColor,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });

  private readonly platformMaterial = Object.assign(createSidewalkMaterial(), { side: THREE.DoubleSide });
  private readonly platformSideMaterial = new THREE.MeshStandardMaterial({
    color: STATION_ROOFS.platformSideColor,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  private readonly tactileMaterial = new THREE.MeshStandardMaterial({
    color: STATION_ROOFS.tactileColor,
    roughness: 0.7,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly pillarMaterial = new THREE.MeshStandardMaterial({
    color: STATION_ROOFS.pillarColor,
    roughness: 0.5,
    side: THREE.DoubleSide,
  });

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
  }

  onChunkAdded(x: number, y: number): void {
    const key = `${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    const url = `${import.meta.env.BASE_URL}${STATION_ROOFS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    fetch(url)
      // 屋根の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<RoofRecord[]>) : null,
      )
      .then((data) => {
        if (this.tiles.get(key) !== 'loading') return;
        const group = data ? this.build(data) : new THREE.Group();
        this.tiles.set(key, group);
        this.group.add(group);
      })
      .catch((e) => {
        console.warn('[StationRoofs] 読込に失敗しました', key, e);
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
      if (!(obj instanceof THREE.Mesh)) return;
      obj.geometry.disposeBoundsTree();
      obj.geometry.dispose();
    });
  }

  private build(records: RoofRecord[]): THREE.Group {
    const roof = new Builder();
    const fascia = new Builder();
    const floor = new Builder();
    const side = new Builder();
    const tactile = new Builder();
    const pillar = new Builder();
    for (const [kind, height, station, coords] of records) {
      const latLon = decode(coords);
      // 地面の高さ：形の頂点での地形の面の平均（線路の高さの基準と揃える）
      let sum = 0;
      let n = 0;
      for (const [lat, lon] of latLon) {
        const h = this.terrain.surfaceHeightAt(lat, lon);
        if (h !== null) (sum += h), n++;
      }
      if (n === 0) continue;
      const top = sum / n + height;
      const points = latLon.map(([lat, lon]) => this.terrain.toLocal(lat, lon, top));
      if (kind === 2) this.addPlatform(points, floor, side, tactile);
      else {
        this.addRoof(points, kind, station, roof, fascia);
        if (kind === 1) this.addPillars(points, pillar);
      }
    }
    const group = new THREE.Group();
    const r = roof.build(true);
    if (r) {
      // 当たり判定のレイキャストを速くする
      r.computeBoundsTree();
      group.add(new THREE.Mesh(r, this.roofMaterial));
    }
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material) => {
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(fascia.build(false), this.fasciaMaterial);
    add(floor.build(false), this.platformMaterial);
    add(side.build(false), this.platformSideMaterial);
    add(tactile.build(false), this.tactileMaterial);
    add(pillar.build(false), this.pillarMaterial);
    return group;
  }

  /** ホーム：床（タイル）、線路側に下りる側面、縁から少し内側の黄色い点字ブロック */
  private addPlatform(points: THREE.Vector3[], floor: Builder, side: Builder, tactile: Builder): void {
    if (points.length < 3) return;
    const ccw = toCounterClockwise(points);
    const contour = ccw.map((p) => new THREE.Vector2(p.x, p.z));
    const base = floor.positions.length / 3;
    // 床のタイル：1枚の画像 = 2.4m 四方
    for (const p of ccw) floor.vertex(p, p.x / 2.4, p.z / 2.4);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) floor.indices.push(base + a, base + c, base + b);

    const { platformDepth, tactileInset, tactileWidth } = STATION_ROOFS;
    for (let i = 0; i < ccw.length; i++) {
      const a = ccw[i];
      const b = ccw[(i + 1) % ccw.length];
      // 側面
      const v0 = side.vertex(a, 0, 0);
      const v1 = side.vertex(b, 1, 0);
      const v2 = side.vertex(a.clone().setY(a.y - platformDepth), 0, 1);
      const v3 = side.vertex(b.clone().setY(b.y - platformDepth), 1, 1);
      side.indices.push(v0, v2, v1, v1, v2, v3);
      // 点字ブロック：長い辺（線路に面した辺）だけ。反時計回りなので内側は辺の左
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < STATION_ROOFS.tactileMinEdge) continue;
      const inX = -dz / len;
      const inZ = dx / len;
      const at = (p: THREE.Vector3, d: number) => new THREE.Vector3(p.x + inX * d, p.y + 0.01, p.z + inZ * d);
      const t0 = tactile.vertex(at(a, tactileInset), 0, 0);
      const t1 = tactile.vertex(at(b, tactileInset), 1, 0);
      const t2 = tactile.vertex(at(a, tactileInset + tactileWidth), 0, 1);
      const t3 = tactile.vertex(at(b, tactileInset + tactileWidth), 1, 1);
      tactile.indices.push(t0, t2, t1, t1, t2, t3);
    }
  }

  /** 上屋の柱：屋根の長い向きの中心線に沿って、一定間隔でホームの床まで下ろす */
  private addPillars(points: THREE.Vector3[], out: Builder): void {
    if (points.length < 3) return;
    const axis = longestAxis(points);
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const p of points) {
      const a = p.x * axis.x + p.z * axis.y;
      const b = p.x * -axis.y + p.z * axis.x;
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
      minB = Math.min(minB, b);
      maxB = Math.max(maxB, b);
    }
    const length = maxA - minA;
    const width = maxB - minB;
    // 大きな屋根（駅前広場など）は柱の並びが不自然になるので、細長いものだけ
    if (width > STATION_ROOFS.pillarMaxRoofWidth || length < width) return;
    const top = points[0].y;
    const bottom = top - STATION_ROOFS.canopyHeight;
    const b = (minB + maxB) / 2;
    const count = Math.max(1, Math.floor(length / STATION_ROOFS.pillarSpacing));
    const h = STATION_ROOFS.pillarSize / 2;
    for (let k = 0; k <= count; k++) {
      // 両端は少し内側に
      const a = minA + 2 + ((length - 4) * k) / count;
      const cx = a * axis.x - b * axis.y;
      const cz = a * axis.y + b * axis.x;
      const corners = [
        [h, h],
        [-h, h],
        [-h, -h],
        [h, -h],
      ].map(([u, v]) => [cx + u, cz + v]);
      for (let i = 0; i < 4; i++) {
        const [x0, z0] = corners[i];
        const [x1, z1] = corners[(i + 1) % 4];
        const v0 = out.vertex(new THREE.Vector3(x0, top, z0), 0, 0);
        const v1 = out.vertex(new THREE.Vector3(x1, top, z1), 1, 0);
        const v2 = out.vertex(new THREE.Vector3(x0, bottom, z0), 0, 1);
        const v3 = out.vertex(new THREE.Vector3(x1, bottom, z1), 1, 1);
        out.indices.push(v0, v2, v1, v1, v2, v3);
      }
    }
  }

  /** 屋根の板（上面と、縁の帯） */
  private addRoof(points: THREE.Vector3[], kind: 0 | 1 | 2, station: number, roof: Builder, fascia: Builder): void {
    if (points.length < 3) return;
    // 波板の筋の向き：一番長い辺の向き（ホームの向き）
    let axis = new THREE.Vector2(1, 0);
    let longest = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const d = new THREE.Vector2(b.x - a.x, b.z - a.z);
      if (d.length() > longest) {
        longest = d.length();
        axis = d.normalize();
      }
    }
    // 駅ごとに色を選ぶ（同じ駅の屋根は同じ色）
    const palette = STATION_ROOFS.colors;
    const pick = hash(station) * palette.length;
    const color = new THREE.Color(palette[Math.floor(pick) % palette.length]);

    // 上面：多角形を三角形に分ける
    const contour = points.map((p) => new THREE.Vector2(p.x, p.z));
    if (THREE.ShapeUtils.isClockWise(contour)) {
      contour.reverse();
      points = [...points].reverse();
    }
    const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = roof.positions.length / 3;
    for (const p of points) {
      // u：筋に直交する向き（波板の山の間隔）、v：筋に沿った向き
      roof.vertex(p, (p.x * -axis.y + p.z * axis.x) / STATION_ROOFS.ribSpacing, (p.x * axis.x + p.z * axis.y) / 10, color);
    }
    for (const [a, b, c] of triangles) roof.indices.push(base + a, base + c, base + b);

    // 縁の帯
    const depth = kind === 0 ? STATION_ROOFS.fasciaDepth * 2 : STATION_ROOFS.fasciaDepth;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const v0 = fascia.vertex(a, 0, 0);
      const v1 = fascia.vertex(b, 1, 0);
      const v2 = fascia.vertex(a.clone().setY(a.y - depth), 0, 1);
      const v3 = fascia.vertex(b.clone().setY(b.y - depth), 1, 1);
      fascia.indices.push(v0, v2, v1, v1, v2, v3);
    }
  }
}

class Builder {
  readonly positions: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  vertex(p: THREE.Vector3, u: number, v: number, color?: THREE.Color): number {
    this.positions.push(p.x, p.y, p.z);
    this.uvs.push(u, v);
    if (color) this.colors.push(color.r, color.g, color.b);
    return this.positions.length / 3 - 1;
  }

  build(withColor: boolean): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    return g;
  }
}

/** 金属の波板：細い明暗の筋を繰り返す画像。色は頂点色で付ける */
function createRoofMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  for (let x = 0; x < 64; x++) {
    // 山と谷の明暗
    const v = 200 + 40 * Math.cos((x / 64) * Math.PI * 2);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, 0, 1, 64);
  }
  // 継ぎ目
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 62, 64, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    vertexColors: true,
    metalness: 0.35,
    roughness: 0.45,
    side: THREE.DoubleSide,
    // 下の建物の屋上と重なってもちらつかないよう手前に寄せる
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

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

function hash(n: number): number {
  const x = Math.sin(n * 91.345 + 7.13) * 43758.5453;
  return x - Math.floor(x);
}

/** 多角形を上から見て反時計回り（x, z 平面）にそろえる */
function toCounterClockwise(points: THREE.Vector3[]): THREE.Vector3[] {
  const contour = points.map((p) => new THREE.Vector2(p.x, p.z));
  return THREE.ShapeUtils.isClockWise(contour) ? [...points].reverse() : points;
}

/** 一番長い辺の向き（x, z 平面の単位ベクトル） */
function longestAxis(points: THREE.Vector3[]): THREE.Vector2 {
  let axis = new THREE.Vector2(1, 0);
  let longest = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const d = new THREE.Vector2(b.x - a.x, b.z - a.z);
    if (d.length() > longest) {
      longest = d.length();
      axis = d.normalize();
    }
  }
  return axis;
}
