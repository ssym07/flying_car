import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { TERRAIN } from '../core/config';
import { addWater, fetchWaterMask, waterTime } from './water';

/** 標高タイルの「データなし」（水面など） */
const NO_DATA = Number.NaN;
const TILE_PX = 256;

interface Chunk {
  x: number;
  y: number;
  /** チャンク中心のローカル座標 */
  center: THREE.Vector3;
  mesh: THREE.Mesh | null;
  /** 標高（ジオイド基準, m）。256×256、データなしは埋め済み */
  heights: Float32Array | null;
  /** 読込中に範囲外になったら true（読み終わったら捨てる） */
  dead: boolean;
}

/** 地形チャンクの読込・破棄を知らせる相手（道路など、チャンクごとに作るもの） */
export interface ChunkListener {
  onChunkAdded(x: number, y: number): void;
  onChunkRemoved(x: number, y: number): void;
}

/**
 * 国土地理院の標高タイルから地形メッシュを作り、航空写真を貼る。
 * 標高タイル1枚（約1km四方）を1チャンクとし、カメラの周りだけ読んで離れたら捨てる。
 * 頂点は 緯度経度+楕円体高 → ECEF → ローカル座標 の順に変換するので、
 * PLATEAU の 3D Tiles とぴったり重なる。
 */
export class Terrain {
  readonly group = new THREE.Group();
  private ecefToLocal: THREE.Matrix4 | null = null;
  private localToEcef = new THREE.Matrix4();
  private readonly chunks = new Map<string, Chunk>();
  private loadingCount = 0;
  /** 直近の update でカメラの読込範囲にあったチャンク */
  private wanted: Chunk[] = [];
  private readonly lastCamera = new THREE.Vector3();
  private readonly listeners: ChunkListener[] = [];
  /** 写真が取れなかったチャンク用（[本体, 縁の壁]） */
  private readonly materials: THREE.Material[];

  constructor() {
    this.materials = createMaterials(null);
  }

  addListener(listener: ChunkListener): void {
    this.listeners.push(listener);
  }

  /** 読込済みのチャンクから、緯度経度（度）の標高（ジオイド基準, m）を引く。無ければ null */
  heightAt(latDeg: number, lonDeg: number): number | null {
    const t = lonLatToTile(lonDeg, latDeg, TERRAIN.demZoom);
    const chunk = this.chunks.get(`${Math.floor(t.x)}/${Math.floor(t.y)}`);
    if (!chunk?.heights) return null;
    return sampleHeight(chunk.heights, TILE_PX, (t.x - chunk.x) * TILE_PX, (t.y - chunk.y) * TILE_PX);
  }

  /** 緯度経度（度）と標高（ジオイド基準, m）→ ローカル座標 */
  toLocal(latDeg: number, lonDeg: number, height: number, target = new THREE.Vector3()): THREE.Vector3 {
    WGS84_ELLIPSOID.getCartographicToPosition(
      latDeg * THREE.MathUtils.DEG2RAD,
      lonDeg * THREE.MathUtils.DEG2RAD,
      height + TERRAIN.geoidHeight,
      target,
    );
    return target.applyMatrix4(this.ecefToLocal!);
  }

  /** タイルと同じ ECEF → ローカル座標 の変換を渡す。これ以降 update で読み始める */
  setFrame(ecefToLocal: THREE.Matrix4): void {
    this.ecefToLocal = ecefToLocal.clone();
    this.localToEcef.copy(ecefToLocal).invert();
  }

  /** カメラから radius (m) 以内のチャンクのうち、読み終わった割合 (0..1) */
  progressWithin(radius: number): number {
    if (!this.ecefToLocal) return 0;
    const near = this.wantedWithin(radius);
    if (near.length === 0) return 0;
    return near.filter((c) => c.mesh).length / near.length;
  }

  /** カメラから radius (m) 以内のチャンクがすべて読み終わっているか */
  isLoadedWithin(radius: number): boolean {
    return this.progressWithin(radius) === 1;
  }

  private wantedWithin(radius: number): Chunk[] {
    const cam = this.lastCamera;
    return this.wanted.filter((c) => Math.hypot(c.center.x - cam.x, c.center.z - cam.z) < radius);
  }

  /** ローカル座標 → 緯度経度（度） */
  toLatLon(position: THREE.Vector3): { lat: number; lon: number } | null {
    if (!this.ecefToLocal) return null;
    const ecef = position.clone().applyMatrix4(this.localToEcef);
    const carto = WGS84_ELLIPSOID.getPositionToCartographic(ecef, {}) as { lat: number; lon: number };
    return { lat: carto.lat * THREE.MathUtils.RAD2DEG, lon: carto.lon * THREE.MathUtils.RAD2DEG };
  }

  /** カメラ位置に応じてチャンクを読込・破棄する。毎フレーム呼ぶ */
  update(cameraPosition: THREE.Vector3): void {
    const latLon = this.toLatLon(cameraPosition);
    if (!latLon) return;
    this.lastCamera.copy(cameraPosition);
    waterTime.value = performance.now() / 1000;
    const z = TERRAIN.demZoom;
    const tile = lonLatToTile(latLon.lon, latLon.lat, z);
    const tileMeters = (40075016 * Math.cos(latLon.lat * THREE.MathUtils.DEG2RAD)) / 2 ** z;
    const reach = Math.ceil(TERRAIN.loadRadius / tileMeters) + 1;
    const distanceTo = (c: Chunk) => Math.hypot(c.center.x - cameraPosition.x, c.center.z - cameraPosition.z);

    // 読込範囲のチャンクを集める
    const wanted: Chunk[] = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = Math.floor(tile.x) + dx;
        const y = Math.floor(tile.y) + dy;
        const chunk = this.chunks.get(`${x}/${y}`) ?? this.createChunk(x, y);
        if (distanceTo(chunk) < TERRAIN.loadRadius + tileMeters / 2) {
          chunk.dead = false;
          wanted.push(chunk);
        }
      }
    }
    this.wanted = wanted;

    // 近い順に読み始める
    const pending = wanted.filter((c) => !c.mesh && !this.chunks.has(key(c)));
    pending.sort((a, b) => distanceTo(a) - distanceTo(b));
    for (const chunk of pending) {
      if (this.loadingCount >= TERRAIN.concurrentChunks) break;
      this.chunks.set(key(chunk), chunk);
      this.loadingCount++;
      void this.loadChunk(chunk).finally(() => this.loadingCount--);
    }

    // 遠くなったチャンクを捨てる
    for (const chunk of this.chunks.values()) {
      if (distanceTo(chunk) <= TERRAIN.unloadRadius) continue;
      chunk.dead = true;
      if (chunk.mesh) this.removeChunk(chunk);
    }
  }

  dispose(): void {
    for (const chunk of [...this.chunks.values()]) {
      chunk.dead = true;
      if (chunk.mesh) this.removeChunk(chunk);
    }
    for (const m of this.materials) m.dispose();
  }

  private createChunk(x: number, y: number): Chunk {
    const z = TERRAIN.demZoom;
    const { lon, lat } = tileToLonLat(x + 0.5, y + 0.5, z);
    const center = new THREE.Vector3();
    WGS84_ELLIPSOID.getCartographicToPosition(lat, lon, TERRAIN.geoidHeight, center);
    center.applyMatrix4(this.ecefToLocal!);
    return { x, y, center, mesh: null, heights: null, dead: false };
  }

  private async loadChunk(chunk: Chunk): Promise<void> {
    const z = TERRAIN.demZoom;
    try {
      const heights = (await fetchDem(chunk.x, chunk.y, z)) ?? new Float32Array(TILE_PX * TILE_PX).fill(NO_DATA);
      fillNoData(heights, TILE_PX);
      const geometry = buildGeometry(heights, chunk.x, chunk.y, z, this.ecefToLocal!);
      const [map, water] = await Promise.all([
        fetchPhoto(chunk.x, chunk.y, z, TERRAIN.photoZoomOffset),
        fetchWaterMask(chunk.x, chunk.y, z),
      ]);
      if (chunk.dead) {
        geometry.dispose();
        map?.dispose();
        water?.dispose();
        this.chunks.delete(key(chunk));
        return;
      }
      geometry.computeBoundsTree();
      chunk.mesh = new THREE.Mesh(geometry, map || water ? createMaterials(map, water) : this.materials);
      chunk.heights = heights;
      this.group.add(chunk.mesh);
      for (const l of this.listeners) l.onChunkAdded(chunk.x, chunk.y);
    } catch (e) {
      console.warn('[Terrain] チャンクの読込に失敗しました', chunk.x, chunk.y, e);
      this.chunks.delete(key(chunk));
    }
  }

  private removeChunk(chunk: Chunk): void {
    const mesh = chunk.mesh!;
    this.group.remove(mesh);
    mesh.geometry.disposeBoundsTree();
    mesh.geometry.dispose();
    if (mesh.material !== this.materials) {
      const materials = mesh.material as THREE.MeshStandardMaterial[];
      materials[0].map?.dispose();
      (materials[0].userData.waterMap as THREE.Texture | undefined)?.dispose();
      for (const m of materials) m.dispose();
    }
    chunk.mesh = null;
    chunk.heights = null;
    this.chunks.delete(key(chunk));
    for (const l of this.listeners) l.onChunkRemoved(chunk.x, chunk.y);
  }
}

function key(chunk: { x: number; y: number }): string {
  return `${chunk.x}/${chunk.y}`;
}

/** [本体, 縁の壁] のマテリアル */
function createMaterials(map: THREE.Texture | null, water: THREE.Texture | null = null): THREE.Material[] {
  const color = map ? 0xffffff : 0x7d8a72;
  // 道路のポリゴンと同じ高さで重なってもちらつかないよう、地形を奥へずらす
  const ground = new THREE.MeshStandardMaterial({
    map,
    color,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  if (water) addWater(ground, water);
  return [
    ground,
    // 縁の壁はずらさない（垂直な面は大きく奥へずれて、隠したい隙間が見えてしまう）。
    // 裏から見ても消えないよう両面にし、裏面が暗く照らされて黒い線に見えないようライティングもしない
    new THREE.MeshBasicMaterial({ map, color, side: THREE.DoubleSide }),
  ];
}

/** チャンク (x, y) の地形メッシュを作る。縁には隙間隠しの壁を付ける */
function buildGeometry(
  heights: Float32Array,
  x: number,
  y: number,
  z: number,
  ecefToLocal: THREE.Matrix4,
): THREE.BufferGeometry {
  const seg = TERRAIN.segments;
  const gridCount = (seg + 1) ** 2;
  const perimeter = seg * 4;
  const positions = new Float32Array((gridCount + perimeter * 2) * 3);
  const uvs = new Float32Array((gridCount + perimeter * 2) * 2);
  const v = new THREE.Vector3();
  const index: number[] = [];

  const place = (k: number, col: number, row: number, heightOffset: number) => {
    const h = sampleHeight(heights, TILE_PX, (col / seg) * TILE_PX, (row / seg) * TILE_PX);
    const { lon, lat } = tileToLonLat(x + col / seg, y + row / seg, z);
    WGS84_ELLIPSOID.getCartographicToPosition(lat, lon, h + TERRAIN.geoidHeight + heightOffset, v);
    v.applyMatrix4(ecefToLocal);
    positions.set([v.x, v.y, v.z], k * 3);
    // 北が上の写真なので、行が下がるほど v を小さくする
    uvs.set([col / seg, 1 - row / seg], k * 2);
  };

  // 本体のグリッド
  for (let row = 0; row <= seg; row++) {
    for (let col = 0; col <= seg; col++) place(row * (seg + 1) + col, col, row, 0);
  }
  for (let row = 0; row < seg; row++) {
    for (let col = 0; col < seg; col++) {
      const a = row * (seg + 1) + col;
      const b = a + seg + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // 縁を一周する点（col, row）
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < seg; i++) ring.push([i, 0]);
  for (let i = 0; i < seg; i++) ring.push([seg, i]);
  for (let i = seg; i > 0; i--) ring.push([i, seg]);
  for (let i = seg; i > 0; i--) ring.push([0, i]);

  const mainIndexCount = index.length;

  // 縁から下に垂らす壁。法線が本体に影響しないよう、頂点は本体と共有しない
  ring.forEach(([col, row], i) => {
    place(gridCount + i * 2, col, row, 0);
    place(gridCount + i * 2 + 1, col, row, -TERRAIN.skirtDepth);
  });
  for (let i = 0; i < perimeter; i++) {
    const top = gridCount + i * 2;
    const nextTop = gridCount + ((i + 1) % perimeter) * 2;
    index.push(top, top + 1, nextTop, nextTop, top + 1, nextTop + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.addGroup(0, mainIndexCount, 0);
  geometry.addGroup(mainIndexCount, index.length - mainIndexCount, 1);
  geometry.computeVertexNormals();
  // 壁の法線は上向きにして、本体と同じ明るさにする
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let k = gridCount; k < normals.count; k++) normals.setXYZ(k, 0, 1, 0);
  return geometry;
}

/** ピクセル中心を基準に双線形補間する */
function sampleHeight(heights: Float32Array, size: number, px: number, py: number): number {
  const x = THREE.MathUtils.clamp(px - 0.5, 0, size - 1);
  const y = THREE.MathUtils.clamp(py - 0.5, 0, size - 1);
  const xi = Math.min(Math.floor(x), size - 2);
  const yi = Math.min(Math.floor(y), size - 2);
  const fx = x - xi;
  const fy = y - yi;
  const at = (xx: number, yy: number) => heights[yy * size + xx];
  const top = at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx;
  const bottom = at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** データなし（水面など）を周りの値で埋める。最後まで埋まらなければ 0 m（海面） */
function fillNoData(heights: Float32Array, size: number): void {
  for (let pass = 0; pass < 64; pass++) {
    let remaining = 0;
    let filled = 0;
    const src = heights.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (!Number.isNaN(src[idx])) continue;
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const h = src[ny * size + nx];
          if (!Number.isNaN(h)) {
            sum += h;
            count++;
          }
        }
        if (count > 0) {
          heights[idx] = sum / count;
          filled++;
        } else {
          remaining++;
        }
      }
    }
    if (remaining === 0 || filled === 0) break;
  }
  for (let k = 0; k < heights.length; k++) if (Number.isNaN(heights[k])) heights[k] = 0;
}

/** 標高タイルを取得して標高 (m, ジオイド基準) の配列にする。無ければ次の URL を試す */
async function fetchDem(x: number, y: number, z: number): Promise<Float32Array | null> {
  for (const template of TERRAIN.demUrls) {
    const image = await fetchImage(tileUrl(template, x, y, z));
    if (!image) continue;
    const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    image.close();
    const { data } = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
    const out = new Float32Array(TILE_PX * TILE_PX);
    for (let k = 0; k < out.length; k++) {
      out[k] = decodeDem(data[k * 4], data[k * 4 + 1], data[k * 4 + 2]);
    }
    return out;
  }
  return null;
}

/** 国土地理院 標高PNG の RGB → 標高 (m) */
export function decodeDem(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  if (x === 2 ** 23) return NO_DATA;
  return (x < 2 ** 23 ? x : x - 2 ** 24) * 0.01;
}

/** 標高タイル1枚の範囲の航空写真を、細かいズームのタイルを並べて1枚にする */
async function fetchPhoto(x: number, y: number, z: number, zoomOffset: number): Promise<THREE.Texture | null> {
  const k = 1 << zoomOffset;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE_PX * k;
  const ctx = canvas.getContext('2d')!;
  let any = false;
  await Promise.all(
    grid(k).map(async ([i, j]) => {
      const image = await fetchImage(tileUrl(TERRAIN.photoUrl, x * k + i, y * k + j, z + zoomOffset));
      if (!image) return;
      ctx.drawImage(image, i * TILE_PX, j * TILE_PX);
      image.close();
      any = true;
    }),
  );
  if (!any) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

async function fetchImage(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

function tileUrl(template: string, x: number, y: number, z: number): string {
  return template.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);
}

/** 経度緯度（度） → Web メルカトルのタイル座標（小数） */
export function lonLatToTile(lonDeg: number, latDeg: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = latDeg * THREE.MathUtils.DEG2RAD;
  return {
    x: ((lonDeg + 180) / 360) * n,
    y: ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n,
  };
}

/** タイル座標（小数） → 経度緯度（ラジアン） */
function tileToLonLat(tx: number, ty: number, z: number): { lon: number; lat: number } {
  const n = 2 ** z;
  return {
    lon: (tx / n) * Math.PI * 2 - Math.PI,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))),
  };
}

function grid(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push([i, j]);
  return out;
}
