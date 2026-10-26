import * as THREE from 'three';
import { STATION_ROOFS } from '../core/config';
import type { ChunkListener, Terrain } from './Terrain';

/** 屋根データ1件：[種類（0=駅舎, 1=上屋）, 地面からの高さ(m), 駅の番号, 座標（1e-6度、先頭以外は差分）] */
type RoofRecord = [0 | 1, number, number, number[]];

/**
 * 駅の屋根（駅舎・ホームの上屋）。写真を参考に、白・銀・薄い緑・青緑の金属の波板屋根にして、
 * 周りの建物（黒・紺）と見分けがつくようにする。
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
    for (const [kind, height, station, coords] of records) {
      const latLon = decode(coords);
      // 地面の高さ：形の中で一番低い所（高架の駅でも地面から測る）
      let ground = Infinity;
      for (const [lat, lon] of latLon) ground = Math.min(ground, this.terrain.heightAt(lat, lon) ?? Infinity);
      if (!Number.isFinite(ground)) continue;
      const top = ground + height;
      const points = latLon.map(([lat, lon]) => this.terrain.toLocal(lat, lon, top));
      this.addRoof(points, kind, station, roof, fascia);
    }
    const group = new THREE.Group();
    const r = roof.build(true);
    const f = fascia.build(false);
    if (r) {
      // 当たり判定のレイキャストを速くする
      r.computeBoundsTree();
      group.add(new THREE.Mesh(r, this.roofMaterial));
    }
    if (f) group.add(new THREE.Mesh(f, this.fasciaMaterial));
    return group;
  }

  /** 屋根の板（上面と、縁の帯） */
  private addRoof(points: THREE.Vector3[], kind: 0 | 1, station: number, roof: Builder, fascia: Builder): void {
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
    // 駅ごとに色を選ぶ（同じ駅の屋根は同じ色）。駅舎は白・銀に寄せる
    const palette = STATION_ROOFS.colors;
    const pick = kind === 0 ? hash(station) * 2 : hash(station) * palette.length;
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
