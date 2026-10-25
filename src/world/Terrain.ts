import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { TERRAIN, WORLD } from '../core/config';

/** 標高タイルの「データなし」（水面など） */
const NO_DATA = Number.NaN;
const TILE_PX = 256;

/**
 * 国土地理院の標高タイルから地形メッシュを作り、航空写真を貼る。
 * 頂点は 緯度経度+楕円体高 → ECEF → ローカル座標 の順に変換するので、
 * PLATEAU の 3D Tiles とぴったり重なる。
 */
export class Terrain {
  readonly group = new THREE.Group();
  private done = 0;
  private total = 1;
  private finished = false;
  /** 地形の一番低い所（ローカル座標の y） */
  minHeight = 0;

  /** 0..1 */
  get progress(): number {
    return this.finished ? 1 : this.done / this.total;
  }

  get isLoaded(): boolean {
    return this.finished;
  }

  /** @param ecefToLocal タイルと同じ ECEF → ローカル座標の変換 */
  async load(ecefToLocal: THREE.Matrix4): Promise<void> {
    const { demZoom: z, radiusTiles: r, photoZoomOffset } = TERRAIN;
    const center = lonLatToTile(WORLD.origin.lonDeg, WORLD.origin.latDeg, z);
    const x0 = Math.floor(center.x) - r;
    const y0 = Math.floor(center.y) - r;
    const n = r * 2 + 1;
    const photosPerTile = (1 << photoZoomOffset) ** 2;
    this.total = n * n * (1 + photosPerTile);

    try {
      // 1) 標高を1枚の大きな配列に並べる（タイルの継ぎ目で段差が出ないように）
      const size = n * TILE_PX;
      const heights = new Float32Array(size * size).fill(NO_DATA);
      await forEachLimited(grid(n), TERRAIN.concurrency, async ([i, j]) => {
        const tile = await fetchDem(x0 + i, y0 + j, z);
        this.done++;
        if (!tile) return;
        for (let py = 0; py < TILE_PX; py++) {
          heights.set(tile.subarray(py * TILE_PX, (py + 1) * TILE_PX), (j * TILE_PX + py) * size + i * TILE_PX);
        }
      });
      fillNoData(heights, size);

      // 2) 標高タイル1枚ごとにメッシュを作り、航空写真を貼る
      let minY = Infinity;
      await forEachLimited(grid(n), TERRAIN.concurrency, async ([i, j]) => {
        const geometry = buildGeometry(heights, size, i, j, x0, y0, z, ecefToLocal);
        geometry.computeBoundingBox();
        minY = Math.min(minY, geometry.boundingBox!.min.y);
        geometry.computeBoundsTree();

        const map = await fetchPhoto(x0 + i, y0 + j, z, photoZoomOffset, () => this.done++);
        const material = new THREE.MeshStandardMaterial({
          map,
          color: map ? 0xffffff : 0x7d8a72,
          roughness: 1,
          // 道路のポリゴンと同じ高さで重なってもちらつかないよう、地形を奥へずらす
          polygonOffset: true,
          polygonOffsetFactor: 2,
          polygonOffsetUnits: 2,
        });
        this.group.add(new THREE.Mesh(geometry, material));
      });
      this.minHeight = minY;
    } catch (e) {
      console.warn('[Terrain] 地形の読込に失敗しました', e);
    }
    this.finished = true;
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.geometry.disposeBoundsTree();
      obj.geometry.dispose();
      obj.material.map?.dispose();
      obj.material.dispose();
    });
  }
}

/** タイル (i, j) の範囲の地形メッシュを作る */
function buildGeometry(
  heights: Float32Array,
  size: number,
  i: number,
  j: number,
  x0: number,
  y0: number,
  z: number,
  ecefToLocal: THREE.Matrix4,
): THREE.BufferGeometry {
  const seg = TERRAIN.segments;
  const positions = new Float32Array((seg + 1) ** 2 * 3);
  const uvs = new Float32Array((seg + 1) ** 2 * 2);
  const v = new THREE.Vector3();
  const scale = 2 ** z;

  let k = 0;
  for (let row = 0; row <= seg; row++) {
    for (let col = 0; col <= seg; col++) {
      // 大きな配列上のピクセル座標（隣のタイルと端の値を共有する）
      const px = (i + col / seg) * TILE_PX;
      const py = (j + row / seg) * TILE_PX;
      const h = sampleHeight(heights, size, px, py) + TERRAIN.geoidHeight;

      const lon = ((x0 * TILE_PX + px) / TILE_PX / scale) * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y0 * TILE_PX + py)) / TILE_PX / scale)));
      WGS84_ELLIPSOID.getCartographicToPosition(lat, lon * THREE.MathUtils.DEG2RAD, h, v);
      v.applyMatrix4(ecefToLocal);
      positions.set([v.x, v.y, v.z], k * 3);
      // 北が上の写真なので、行が下がるほど v を小さくする
      uvs.set([col / seg, 1 - row / seg], k * 2);
      k++;
    }
  }

  const index: number[] = [];
  for (let row = 0; row < seg; row++) {
    for (let col = 0; col < seg; col++) {
      const a = row * (seg + 1) + col;
      const b = a + seg + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
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

/** データなし（水面など）を周りの値で埋める。最後まで埋まらなければ 0 m */
function fillNoData(heights: Float32Array, size: number): void {
  for (let pass = 0; pass < 64; pass++) {
    let remaining = 0;
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
        if (count > 0) heights[idx] = sum / count;
        else remaining++;
      }
    }
    if (remaining === 0) return;
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
async function fetchPhoto(
  x: number,
  y: number,
  z: number,
  zoomOffset: number,
  onEach: () => void,
): Promise<THREE.Texture | null> {
  const k = 1 << zoomOffset;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE_PX * k;
  const ctx = canvas.getContext('2d')!;
  let any = false;
  await Promise.all(
    grid(k).map(async ([i, j]) => {
      const image = await fetchImage(tileUrl(TERRAIN.photoUrl, x * k + i, y * k + j, z + zoomOffset));
      onEach();
      if (!image) return;
      ctx.drawImage(image, i * TILE_PX, j * TILE_PX);
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

/** 経度緯度 → Web メルカトルのタイル座標（小数） */
export function lonLatToTile(lonDeg: number, latDeg: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = latDeg * THREE.MathUtils.DEG2RAD;
  return {
    x: ((lonDeg + 180) / 360) * n,
    y: ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n,
  };
}

function grid(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push([i, j]);
  return out;
}

/** 同時実行数を limit に抑えて items を処理する */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
