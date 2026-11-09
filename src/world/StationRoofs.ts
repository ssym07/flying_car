import * as THREE from 'three';
import { RAILWAYS, STATION_ROOFS } from '../core/config';
import { stationGround } from './groundProfile';
import { createSidewalkMaterial } from './roadTemplates';
import type { ChunkListener, Terrain } from './Terrain';
import { DATA_BASE } from '../core/region';

/**
 * 屋根データ1件：[種類（0=駅舎, 1=上屋, 2=ホーム）, 地面からの高さ(m), 駅の番号, 座標（1e-6度、先頭以外は差分）,
 * 駅の基準点の緯度, 経度（1e-6度）, 掘割(0/1)]。
 * 高さは上屋なら屋根の高さ、ホームなら床の高さ（scripts/build-platforms.mjs が線路に合わせて決める。-1 は描かない）。
 * 基準点は駅にまとまったものだけにあり、線路と同じく駅の地面を基準にする
 */
type RoofRecord = [0 | 1 | 2, number, number, number[], number?, number?, (0 | 1)?];

/**
 * 駅のホームの上屋とホーム（駅舎は PLATEAU の建物に任せて描かない）。屋根は写真を参考に、白・銀・薄い緑・青緑の金属の波板屋根にして、
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
  private readonly platformEdgeMaterial = new THREE.MeshStandardMaterial({
    color: STATION_ROOFS.platformEdgeColor,
    roughness: 0.8,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  private readonly tactileMaterial = createTactileMaterial();
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
    const url = `${DATA_BASE}${STATION_ROOFS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
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
    const pillar = new Builder();
    const parts: PlatformParts = {
      floor: new Builder(),
      edge: new Builder(),
      side: new Builder(),
      tactile: new Builder(),
      pillar,
    };
    for (const [kind, height, station, coords, refLat, refLon, cut] of records) {
      // 駅舎は描かない（形は PLATEAU の建物に任せる。屋根の板だけ置くと、建物と合わない所で宙に浮く）
      if (kind === 0 || height < 0) continue;
      const latLon = decode(coords);
      // 地面の高さ：駅にまとまったものは駅の地面（線路と同じ基準）、それ以外は形の頂点での地形の面の平均
      let ground =
        refLat !== undefined && refLon !== undefined
          ? stationGround(
              this.terrain,
              refLat / 1e6,
              refLon / 1e6,
              cut === 1,
              RAILWAYS.smoothRadius,
              RAILWAYS.cutFloorRadius,
            )
          : null;
      if (ground === null) {
        let sum = 0;
        let n = 0;
        for (const [lat, lon] of latLon) {
          const h = this.terrain.surfaceHeightAt(lat, lon);
          if (h !== null) (sum += h), n++;
        }
        if (n === 0) continue;
        ground = sum / n;
      }
      const top = ground + height;
      const points = latLon.map(([lat, lon]) => this.terrain.toLocal(lat, lon, top));
      if (kind === 2) this.addPlatform(points, height, parts);
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
      if (!g) return;
      // 当たり判定のレイキャストを速くする（BVH の無いメッシュはレイ1本ごとに全部の三角形を調べる）
      g.computeBoundsTree();
      group.add(new THREE.Mesh(g, m));
    };
    add(fascia.build(false), this.fasciaMaterial);
    add(parts.floor.build(false), this.platformMaterial);
    add(parts.edge.build(false), this.platformEdgeMaterial);
    add(parts.side.build(false), this.platformSideMaterial);
    add(parts.tactile.build(false), this.tactileMaterial);
    add(pillar.build(false), this.pillarMaterial);
    return group;
  }

  /**
   * ホーム：床（タイル）、線路側の縁（白い縁石・その下に引っ込んだ暗い壁）、縁から少し内側の白線と黄色い点字ブロック。
   * height は床の地面からの高さ。高架のホームは、線路の高架の下面の高さまで側面を下ろし、その下は柱で支える
   */
  private addPlatform(points: THREE.Vector3[], height: number, parts: PlatformParts): void {
    if (points.length < 3) return;
    const ccw = toCounterClockwise(points);
    const contour = ccw.map((p) => new THREE.Vector2(p.x, p.z));
    const { floor, edge, side, tactile, pillar } = parts;
    const base = floor.positions.length / 3;
    // 床のタイル：1枚の画像 = 2.4m 四方
    for (const p of ccw) floor.vertex(p, p.x / 2.4, p.z / 2.4);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) floor.indices.push(base + a, base + c, base + b);

    const S = STATION_ROOFS;
    const top = ccw[0].y;
    const depth = Math.min(height, S.platformDepth + RAILWAYS.lift + RAILWAYS.viaductDepth);
    const bottom = top - depth;
    const axis = principalAxis(ccw);
    const n = ccw.length;
    // 線路に面した辺：ホームの長い向きに沿った辺（端の短い辺には縁石・点字ブロックを付けない）
    const facing = ccw.map((a, i) => {
      const b = ccw[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      return len > 0 && Math.abs(((b.x - a.x) * axis.x + (b.z - a.z) * axis.y) / len) > 0.5;
    });
    // 頂点 i を内側へ d m 寄せた点（線路に面した辺どうしの角は、両方の辺から d m になるように）
    const inward = (i: number, d: number, y: number) => {
      const normalOf = (k: number) => {
        const a = ccw[(k + n) % n];
        const b = ccw[(k + 1) % n];
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        return new THREE.Vector2(-(b.z - a.z) / len, (b.x - a.x) / len);
      };
      const prev = facing[(i - 1 + n) % n] ? normalOf(i - 1) : null;
      const next = facing[i] ? normalOf(i) : null;
      let m = prev && next ? prev.clone().add(next).normalize() : (prev ?? next ?? new THREE.Vector2());
      const along = prev && next ? Math.min(2, 1 / Math.max(0.5, m.dot(next))) : 1;
      m = m.multiplyScalar(d * along);
      return new THREE.Vector3(ccw[i].x + m.x, y, ccw[i].z + m.y);
    };
    let u = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = ccw[i];
      const b = ccw[j];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const u0 = u;
      const u1 = (u += len);
      const wall = (out: Builder, p: THREE.Vector3, q: THREE.Vector3, y0: number, y1: number) => {
        const v0 = out.vertex(p.clone().setY(y0), u0, 0);
        const v1 = out.vertex(q.clone().setY(y0), u1, 0);
        const v2 = out.vertex(p.clone().setY(y1), u0, 1);
        const v3 = out.vertex(q.clone().setY(y1), u1, 1);
        out.indices.push(v0, v2, v1, v1, v2, v3);
      };
      const band = (out: Builder, d0: number, d1: number, y: number) => {
        const v0 = out.vertex(inward(i, d0, y), u0 / S.tactileTile, 0);
        const v1 = out.vertex(inward(j, d0, y), u1 / S.tactileTile, 0);
        const v2 = out.vertex(inward(i, d1, y), u0 / S.tactileTile, 1);
        const v3 = out.vertex(inward(j, d1, y), u1 / S.tactileTile, 1);
        out.indices.push(v0, v2, v1, v1, v2, v3);
      };
      if (!facing[i]) {
        wall(side, a, b, top, bottom);
        continue;
      }
      // 縁石の前面と、その下の引っ込み（列車とホームの間に落ちた人が逃げ込む所）の天井・奥の壁
      wall(edge, a, b, top, top - S.edgeDepth);
      const lip = top - S.edgeDepth;
      const ia = inward(i, S.recess, lip);
      const ib = inward(j, S.recess, lip);
      const v0 = side.vertex(a.clone().setY(lip), u0, 0);
      const v1 = side.vertex(b.clone().setY(lip), u1, 0);
      const v2 = side.vertex(ia, u0, 1);
      const v3 = side.vertex(ib, u1, 1);
      side.indices.push(v0, v2, v1, v1, v2, v3);
      wall(side, ia, ib, lip, bottom);
      // 床の上：縁の白い帯と、黄色い点字ブロック
      band(edge, 0, S.edgeWidth, top + 0.005);
      band(tactile, S.tactileInset, S.tactileInset + S.tactileWidth, top + 0.01);
    }

    // 高架のホームは、側面の下に柱を立てる（ホームの中心線に沿って）
    const ground = top - height;
    if (bottom - ground < S.platformPillarFrom) return;
    let minA = Infinity;
    let maxA = -Infinity;
    for (const p of ccw) {
      const a = p.x * axis.x + p.z * axis.y;
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
    }
    const count = Math.max(1, Math.round((maxA - minA - 6) / S.platformPillarSpacing));
    for (let k = 0; k <= count; k++) {
      const a = minA + 3 + ((maxA - minA - 6) * k) / count;
      // その位置でのホームの幅の中央：辺がこの位置を横切る所の真ん中
      const cross: THREE.Vector2[] = [];
      for (let i = 0; i < n; i++) {
        const p = ccw[i];
        const q = ccw[(i + 1) % n];
        const ap = p.x * axis.x + p.z * axis.y;
        const aq = q.x * axis.x + q.z * axis.y;
        if ((ap - a) * (aq - a) > 0 || ap === aq) continue;
        const t = (a - ap) / (aq - ap);
        cross.push(new THREE.Vector2(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t));
      }
      if (cross.length < 2) continue;
      const c = cross.reduce((s, v) => s.add(v), new THREE.Vector2()).divideScalar(cross.length);
      addBox(pillar, c.x, c.y, S.platformPillarSize, ground, bottom);
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

/** ホームを作る部品ごとの形 */
interface PlatformParts {
  floor: Builder;
  edge: Builder;
  side: Builder;
  tactile: Builder;
  pillar: Builder;
}

/** 四角い柱（中心 x, z・太さ size・高さ y0〜y1）の側面 */
function addBox(out: Builder, x: number, z: number, size: number, y0: number, y1: number): void {
  const h = size / 2;
  const corners = [
    [h, h],
    [-h, h],
    [-h, -h],
    [h, -h],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    const v0 = out.vertex(new THREE.Vector3(x + x0, y1, z + z0), 0, 0);
    const v1 = out.vertex(new THREE.Vector3(x + x1, y1, z + z1), 1, 0);
    const v2 = out.vertex(new THREE.Vector3(x + x0, y0, z + z0), 0, 1);
    const v3 = out.vertex(new THREE.Vector3(x + x1, y0, z + z1), 1, 1);
    out.indices.push(v0, v2, v1, v1, v2, v3);
  }
}

/** 点字ブロック：黄色の地に、丸い突起の列（1枚 = 0.3m 四方）と、線状の突起の向き */
function createTactileMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#e9c22c';
  g.fillRect(0, 0, 64, 64);
  // ブロックの継ぎ目
  g.fillStyle = 'rgba(120, 90, 0, 0.45)';
  g.fillRect(0, 0, 64, 1);
  g.fillRect(0, 0, 1, 64);
  // 突起：明るい上面と、下の影
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const cx = 7 + x * 12.5;
      const cy = 7 + y * 12.5;
      g.fillStyle = 'rgba(110, 80, 0, 0.5)';
      g.beginPath();
      g.arc(cx + 1, cy + 1.5, 3.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#f7d850';
      g.beginPath();
      g.arc(cx, cy, 3.4, 0, Math.PI * 2);
      g.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.75,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
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

/** 点の並びの一番広がった向き（x, z 平面の単位ベクトル）。細かく区切った曲がったホームでも、長い向きが分かる */
function principalAxis(points: THREE.Vector3[]): THREE.Vector2 {
  let cx = 0;
  let cz = 0;
  for (const p of points) (cx += p.x), (cz += p.z);
  cx /= points.length;
  cz /= points.length;
  let xx = 0;
  let xz = 0;
  let zz = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    xx += dx * dx;
    xz += dx * dz;
    zz += dz * dz;
  }
  const angle = Math.atan2(2 * xz, xx - zz) / 2;
  return new THREE.Vector2(Math.cos(angle), Math.sin(angle));
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
