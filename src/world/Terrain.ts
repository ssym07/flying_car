import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { PARKS, RAILWAYS, TERRAIN } from '../core/config';
import { addLanduse, fetchLanduse } from './landuse';
import { addParks, buildTrees, fetchParks } from './parks';
import { addWater, fetchWaterMask, flattenWater, waterTime } from './water';

/** 標高タイルの「データなし」（水面など） */
const NO_DATA = Number.NaN;
const TILE_PX = 256;

interface Chunk {
  x: number;
  y: number;
  /** チャンク中心のローカル座標 */
  center: THREE.Vector3;
  mesh: THREE.Mesh | null;
  /** 公園の木 */
  trees: THREE.Group | null;
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
  /** 公園の木（当たり判定の対象にしないよう、地形とは別のグループ） */
  readonly trees = new THREE.Group();
  private ecefToLocal: THREE.Matrix4 | null = null;
  private localToEcef = new THREE.Matrix4();
  private readonly chunks = new Map<string, Chunk>();
  private loadingCount = 0;
  /** 直近の update でカメラの読込範囲にあったチャンク */
  private wanted: Chunk[] = [];
  private readonly lastCamera = new THREE.Vector3();
  private readonly listeners: ChunkListener[] = [];
  /** 地形を削る線（掘割の線路など）。キーごとに登録し、今あるチャンクとこれから作るチャンクに当てる */
  private readonly carves = new Map<string, Carve>();
  /** 写真が取れなかったチャンク用（[本体, 縁の壁]） */
  private readonly materials: THREE.Material[];

  constructor() {
    this.materials = createMaterials(null);
  }

  /**
   * 線に沿って地形を削る（掘割）。points はローカル座標で、y は削った底の高さ。
   * 線から width/2 までは底の高さ、その外は slope の傾き（高さ/水平距離）で元の地面へ戻る
   */
  addCarve(key: string, lines: THREE.Vector3[][], width: number, slope: number): void {
    const box = new THREE.Box3();
    for (const line of lines) for (const p of line) box.expandByPoint(p);
    const carve: Carve = { lines, half: width / 2, slope, box };
    this.carves.set(key, carve);
    for (const chunk of this.chunks.values()) if (chunk.mesh) applyCarves(chunk.mesh, [carve]);
  }

  removeCarve(key: string): void {
    this.carves.delete(key);
  }

  /**
   * チャンク (x, y) の「描かない所」の画像を差し替える（トンネルの入口へ下りる掘割の内側。地形の頂点の間隔では
   * 深く細い掘割を削れないので、内側の地形は描かずに、線路側で底と擁壁を描く）。画像の形式は addTrenchMask を参照。
   * null で元に戻す。チャンクが無ければ画像を捨てる
   */
  setTrenchMask(x: number, y: number, mask: THREE.Texture | null): void {
    const chunk = this.chunks.get(`${x}/${y}`);
    const uniform = (chunk?.mesh?.material as THREE.Material[] | undefined)?.[0]?.userData.trench as
      | { value: THREE.Texture }
      | undefined;
    if (!uniform) {
      mask?.dispose();
      return;
    }
    if (uniform.value !== noTrench) uniform.value.dispose();
    uniform.value = mask ?? noTrench;
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

  /**
   * 画面に描いている地形の面の標高（ジオイド基準, m）。heightAt は5mメッシュの標高そのものだが、
   * 地形のメッシュはそれより粗い三角形なので、線路や道路をその上に置く時はこちらを使う
   * （heightAt に置くと、掘割や斜面でメッシュの面に埋もれる）。読込前なら null
   */
  surfaceHeightAt(latDeg: number, lonDeg: number): number | null {
    const t = lonLatToTile(lonDeg, latDeg, TERRAIN.demZoom);
    const chunk = this.chunks.get(`${Math.floor(t.x)}/${Math.floor(t.y)}`);
    if (!chunk?.heights) return null;
    const seg = TERRAIN.segments;
    const gx = (t.x - chunk.x) * seg;
    const gy = (t.y - chunk.y) * seg;
    const col = Math.min(Math.floor(gx), seg - 1);
    const row = Math.min(Math.floor(gy), seg - 1);
    const fu = gx - col;
    const fv = gy - row;
    // buildGeometry と同じ頂点の高さ
    const h = (c: number, r: number) => sampleHeight(chunk.heights!, TILE_PX, (c / seg) * TILE_PX, (r / seg) * TILE_PX);
    // buildGeometry と同じ三角形の分け方：(左上, 左下, 右上) と (右上, 左下, 右下)
    if (fu + fv <= 1) return h(col, row) + (h(col + 1, row) - h(col, row)) * fu + (h(col, row + 1) - h(col, row)) * fv;
    return (
      h(col + 1, row + 1) +
      (h(col, row + 1) - h(col + 1, row + 1)) * (1 - fu) +
      (h(col + 1, row) - h(col + 1, row + 1)) * (1 - fv)
    );
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

    // 木は近くのチャンクだけ描く
    for (const chunk of this.chunks.values()) {
      if (chunk.trees) chunk.trees.visible = distanceTo(chunk) < PARKS.treeRadius;
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
    return { x, y, center, mesh: null, trees: null, heights: null, dead: false };
  }

  private async loadChunk(chunk: Chunk): Promise<void> {
    const z = TERRAIN.demZoom;
    try {
      const [dem, map, waterData] = await Promise.all([
        fetchDem(chunk.x, chunk.y, z),
        fetchPhoto(chunk.x, chunk.y, z, TERRAIN.photoZoomOffset),
        fetchWaterMask(chunk.x, chunk.y, z),
      ]);
      const heights = dem ?? new Float32Array(TILE_PX * TILE_PX).fill(NO_DATA);
      fillNoData(heights, TILE_PX);
      if (waterData) flattenWater(heights, waterData.mask, waterData.size);
      const water = waterData?.texture ?? null;
      const [parks, landuse] = await Promise.all([
        fetchParks(chunk.x, chunk.y, z, waterData?.mask ?? null),
        fetchLanduse(chunk.x, chunk.y, z),
      ]);
      const geometry = buildGeometry(heights, chunk.x, chunk.y, z, this.ecefToLocal!);
      if (chunk.dead) {
        geometry.dispose();
        map?.dispose();
        water?.dispose();
        parks?.texture.dispose();
        landuse?.dispose();
        this.chunks.delete(key(chunk));
        return;
      }
      // 地面の種類（データが無くても住宅地の敷地のテンプレートで塗る）があるので、チャンクごとに材質を作る
      chunk.mesh = new THREE.Mesh(geometry, createMaterials(map, water, parks?.texture ?? null, landuse));
      applyCarves(chunk.mesh, [...this.carves.values()], false);
      geometry.computeBoundsTree();
      chunk.heights = heights;
      this.group.add(chunk.mesh);
      if (parks && parks.trees.length > 0) {
        chunk.trees = buildTrees(parks.trees, (u, v) => {
          const lonLat = tileToLonLat(chunk.x + u, chunk.y + v, z);
          const lat = lonLat.lat * THREE.MathUtils.RAD2DEG;
          const lon = lonLat.lon * THREE.MathUtils.RAD2DEG;
          const h = this.surfaceHeightAt(lat, lon);
          return h === null ? null : this.toLocal(lat, lon, h - 0.2);
        });
        this.trees.add(chunk.trees);
      }
      for (const l of this.listeners) l.onChunkAdded(chunk.x, chunk.y);
    } catch (e) {
      console.warn('[Terrain] チャンクの読込に失敗しました', chunk.x, chunk.y, e);
      this.chunks.delete(key(chunk));
    }
  }

  private removeChunk(chunk: Chunk): void {
    const mesh = chunk.mesh!;
    this.group.remove(mesh);
    if (chunk.trees) {
      this.trees.remove(chunk.trees);
      for (const m of chunk.trees.children) (m as THREE.InstancedMesh).dispose();
      chunk.trees = null;
    }
    mesh.geometry.disposeBoundsTree();
    mesh.geometry.dispose();
    if (mesh.material !== this.materials) {
      const materials = mesh.material as THREE.MeshStandardMaterial[];
      if (materials[0].map !== whitePixel) materials[0].map?.dispose();
      (materials[0].userData.waterMap as THREE.Texture | undefined)?.dispose();
      (materials[0].userData.parkMap as THREE.Texture | undefined)?.dispose();
      (materials[0].userData.landuseMap as THREE.Texture | null | undefined)?.dispose();
      const trench = materials[0].userData.trench as { value: THREE.Texture } | undefined;
      if (trench && trench.value !== noTrench) trench.value.dispose();
      for (const m of materials) m.dispose();
    }
    chunk.mesh = null;
    chunk.heights = null;
    this.chunks.delete(key(chunk));
    for (const l of this.listeners) l.onChunkRemoved(chunk.x, chunk.y);
  }
}

interface Carve {
  lines: THREE.Vector3[][];
  half: number;
  slope: number;
  /** 線の範囲（ローカル座標） */
  box: THREE.Box3;
}

/** 地形メッシュの頂点を、削る線の底の高さ（と、その外の斜面）より上に出ないよう下げる */
function applyCarves(mesh: THREE.Mesh, carves: Carve[], refit = true): void {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  let changed = false;
  for (const carve of carves) {
    const reach = carve.half + 40;
    if (
      carve.box.max.x + reach < bounds.min.x ||
      carve.box.min.x - reach > bounds.max.x ||
      carve.box.max.z + reach < bounds.min.z ||
      carve.box.min.z - reach > bounds.max.z
    ) {
      continue;
    }
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      let limit = Infinity;
      for (const line of carve.lines) {
        for (let k = 1; k < line.length; k++) {
          const a = line[k - 1];
          const b = line[k];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len2 = dx * dx + dz * dz || 1;
          const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
          const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
          if (d > reach) continue;
          const floor = a.y + (b.y - a.y) * t;
          limit = Math.min(limit, floor + Math.max(0, d - carve.half) * carve.slope);
        }
      }
      if (position.getY(i) > limit) {
        position.setY(i, limit);
        changed = true;
      }
    }
  }
  if (!changed) return;
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (refit) geometry.boundsTree?.refit();
}

function key(chunk: { x: number; y: number }): string {
  return `${chunk.x}/${chunk.y}`;
}

/** 掘割の無いチャンクの「描かない所」の画像（どこも遠い） */
const noTrench = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
noTrench.needsUpdate = true;

/**
 * 地形の材質に「描かない所」を足す。画像（写真と同じ uv）の赤は、掘割の中心線からの距離を RAILWAYS.portal.maskRange m で
 * 0〜1 にしたもの。擁壁の内側（RAILWAYS.portal.retainOffset m より近い所）は描かない。画像は setTrenchMask で後から差し替える
 */
function addTrenchMask(material: THREE.MeshStandardMaterial): void {
  const uniform = { value: noTrench as THREE.Texture };
  material.userData.trench = uniform;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.trenchMap = uniform;
    shader.uniforms.trenchCut = { value: (RAILWAYS.portal.retainOffset - 0.05) / RAILWAYS.portal.maskRange };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D trenchMap;\nuniform float trenchCut;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>\nif (texture2D(trenchMap, vMapUv).r < trenchCut) discard;`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}+trench`;
}

/** [本体, 縁の壁] のマテリアル */
const whitePixel = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
whitePixel.needsUpdate = true;

function createMaterials(
  map: THREE.Texture | null,
  water: THREE.Texture | null = null,
  park: THREE.Texture | null = null,
  landuse: THREE.Texture | null = null,
): THREE.Material[] {
  const color = map ? 0xffffff : 0x7d8a72;
  // 道路のポリゴンと同じ高さで重なってもちらつかないよう、地形を奥へずらす
  const ground = new THREE.MeshStandardMaterial({
    // 写真が無くても水面は描けるよう、白1画素の画像を貼っておく（水面のシェーダーは写真と同じ uv を使う）
    map: map ?? whitePixel,
    color,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  if (water) addWater(ground, water);
  // 水面の処理より先に芝生を塗る（池の上は水面になる）。addParks は前の処理に続けてつなぐので、水面の後に呼ぶ
  if (park) addParks(ground, park);
  // 地面の種類は公園・水面より先に塗る（公園の芝生・水面が上になる）。同じ理由で最後に呼ぶ
  addLanduse(ground, landuse);
  addTrenchMask(ground);
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
