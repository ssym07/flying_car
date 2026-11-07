import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { PARKS, RAILWAYS, TERRAIN } from '../core/config';
import { addLanduse, buildGraves, fetchLanduse, isBeachAt } from './landuse';
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
  /** 読込に失敗したチャンク → 読み直してよい時刻（performance.now） */
  private readonly retryAt = new Map<string, number>();
  /** 地形を削る線（掘割の線路など）。キーごとに登録し、今あるチャンクとこれから作るチャンクに当てる */
  private readonly carves = new Map<string, Carve>();
  /** まだ地形に当てていない線（addCarve の後、毎フレーム少しずつ当てる）。next は次に調べる頂点の番号 */
  private readonly carveJobs: Array<{ chunk: Chunk; focus: Carve; next: number }> = [];
  /** 線を当てて頂点が動いた、法線を作り直していないチャンク */
  private readonly carveDirty = new Set<Chunk>();
  /** 地形を描かない掘割（addTrench）。キーごとに登録する */
  private readonly trenches = new Map<string, { lines: THREE.Vector3[][]; box: THREE.Box3 }>();
  /** 写真が取れなかったチャンク用（[本体, 縁の壁]） */
  private readonly materials: THREE.Material[];

  constructor() {
    this.materials = createMaterials(null);
  }

  /**
   * 線に沿って地形を削る（掘割）。points はローカル座標で、y は削った底の高さ。
   * 線から width/2 までは底の高さ、その外は slope の傾き（高さ/水平距離）で元の地面へ戻る。
   * widths を渡すと線ごとの幅（width の代わり）。fill を渡すと、線から fill.reach m までの低い地面を
   * 底の高さ（その外は fill.slope の傾きで下がる）まで盛る（道路・線路の路盤）。slopeReach は斜面で削る範囲（幅の外, m）
   */
  addCarve(
    key: string,
    lines: THREE.Vector3[][],
    width: number,
    slope: number,
    {
      widths,
      fill,
      slopeReach = CARVE_SLOPE_REACH,
    }: { widths?: number[]; fill?: { reach: number; slope: number }; slopeReach?: number } = {},
  ): void {
    const carve = createCarve(lines, (k) => (widths?.[k] ?? width) / 2, slope, fill ?? null, slopeReach);
    this.dropCarveJobs(key);
    if (!carve) return;
    this.carves.set(key, carve);
    // 今あるチャンクには、すぐには当てずに順番待ちにして、毎フレーム少しずつ当てる（飛行中にカクつかないように）
    for (const chunk of this.chunks.values()) {
      if (chunk.mesh && carveTouches(carve, chunk.mesh)) this.carveJobs.push({ chunk, focus: carve, next: 0 });
    }
  }

  /**
   * 順番待ちの削る・盛る線を、budgetMs ミリ秒まで地形に当てる。チャンクの線を全部当て終えたら、法線と当たり判定を作り直す
   */
  private runCarveJobs(budgetMs: number): void {
    const until = performance.now() + budgetMs;
    while (this.carveJobs.length > 0 && performance.now() < until) {
      const job = this.carveJobs[0];
      const mesh = job.chunk.mesh;
      if (!mesh) {
        this.carveJobs.shift();
        continue;
      }
      const end = Math.min(job.next + CARVE_SLICE, mesh.geometry.getAttribute('position').count);
      if (applyCarves(mesh, [...this.carves.values()], job.focus, job.next, end)) this.carveDirty.add(job.chunk);
      job.next = end;
      if (end < mesh.geometry.getAttribute('position').count) continue;
      this.carveJobs.shift();
      // このチャンクの順番待ちが無くなったら、法線と当たり判定を作り直す
      if (this.carveDirty.has(job.chunk) && !this.carveJobs.some((j) => j.chunk === job.chunk)) {
        this.carveDirty.delete(job.chunk);
        finishCarves(mesh, true);
      }
    }
    // 順番待ちを捨てて残った、頂点を動かしたままのチャンク
    for (const chunk of this.carveDirty) {
      if (this.carveJobs.some((j) => j.chunk === chunk)) continue;
      this.carveDirty.delete(chunk);
      if (chunk.mesh) finishCarves(chunk.mesh, true);
    }
  }

  removeCarve(key: string): void {
    this.dropCarveJobs(key);
    this.carves.delete(key);
  }

  /** キーの線の、まだ当てていない順番待ちを捨てる */
  private dropCarveJobs(key: string): void {
    const carve = this.carves.get(key);
    if (!carve) return;
    for (let i = this.carveJobs.length - 1; i >= 0; i--) if (this.carveJobs[i].focus === carve) this.carveJobs.splice(i, 1);
  }

  /**
   * 「描かない所」：トンネルの入口へ下りる掘割の中心線（ローカル座標）。地形の頂点の間隔では深く細い掘割を削りきれないので、
   * 中心線から RAILWAYS.portal.retainOffset m 以内の地形は描かず、線路側で底と擁壁を描く。
   * 掘割はチャンクの境目をまたぐので、かかるチャンクすべての画像を作り直す
   */
  addTrench(key: string, lines: THREE.Vector3[][]): void {
    const box = new THREE.Box3();
    for (const line of lines) for (const p of line) box.expandByPoint(p);
    this.trenches.set(key, { lines, box });
    for (const chunk of this.chunks.values())
      if (chunk.mesh && this.trenchTouches(chunk, box)) this.updateTrenchMask(chunk);
  }

  removeTrench(key: string): void {
    const trench = this.trenches.get(key);
    if (!trench) return;
    this.trenches.delete(key);
    for (const chunk of this.chunks.values()) {
      if (chunk.mesh && this.trenchTouches(chunk, trench.box)) this.updateTrenchMask(chunk);
    }
  }

  private trenchTouches(chunk: Chunk, box: THREE.Box3): boolean {
    const bounds = (chunk.mesh!.geometry as THREE.BufferGeometry).boundingBox;
    if (!bounds) return true;
    const r = RAILWAYS.portal.maskRange;
    return !(
      box.max.x + r < bounds.min.x ||
      box.min.x - r > bounds.max.x ||
      box.max.z + r < bounds.min.z ||
      box.min.z - r > bounds.max.z
    );
  }

  /** チャンクの「描かない所」の画像を、かかる掘割すべてから作り直す（赤 = 中心線からの距離 / maskRange） */
  private updateTrenchMask(chunk: Chunk): void {
    const uniform = (chunk.mesh?.material as THREE.Material[] | undefined)?.[0]?.userData.trench as
      { value: THREE.Texture } | undefined;
    if (!uniform) return;
    const { maskSize: S, maskRange } = RAILWAYS.portal;
    const n = 2 ** TERRAIN.demZoom;
    const segments: Array<[[number, number], [number, number]]> = [];
    let metersPerPx = 0;
    for (const { lines, box } of this.trenches.values()) {
      if (!this.trenchTouches(chunk, box)) continue;
      for (const line of lines) {
        const px = line.map((p) => {
          const ll = this.toLatLon(p);
          if (!ll) return null;
          metersPerPx ||= (40075016 * Math.cos(THREE.MathUtils.degToRad(ll.lat))) / n / S;
          const tx = ((ll.lon + 180) / 360) * n;
          const ty = ((1 - Math.asinh(Math.tan(THREE.MathUtils.degToRad(ll.lat))) / Math.PI) / 2) * n;
          return [(tx - chunk.x) * S, (ty - chunk.y) * S] as [number, number];
        });
        for (let i = 1; i < px.length; i++) if (px[i - 1] && px[i]) segments.push([px[i - 1]!, px[i]!]);
      }
    }
    if (uniform.value !== noTrench) uniform.value.dispose();
    if (segments.length === 0) {
      uniform.value = noTrench;
      return;
    }
    const reach = maskRange / metersPerPx;
    const data = new Uint8Array(S * S).fill(255);
    for (const [a, b] of segments) {
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - reach));
      const x1 = Math.min(S - 1, Math.ceil(Math.max(a[0], b[0]) + reach));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - reach));
      const y1 = Math.min(S - 1, Math.ceil(Math.max(a[1], b[1]) + reach));
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      for (let row = y0; row <= y1; row++) {
        for (let col = x0; col <= x1; col++) {
          const cx = col + 0.5;
          const cy = row + 0.5;
          const t = Math.min(1, Math.max(0, ((cx - a[0]) * dx + (cy - a[1]) * dy) / len2));
          const d = Math.hypot(cx - a[0] - dx * t, cy - a[1] - dy * t) * metersPerPx;
          const v = Math.min(255, Math.round((d / maskRange) * 255));
          // 画像の行 0 が v = 0（南）。写真（北が上）と同じ uv で貼るので上下を入れ替える
          const k = (S - 1 - row) * S + col;
          if (v < data[k]) data[k] = v;
        }
      }
    }
    const texture = new THREE.DataTexture(data, S, S, THREE.RedFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    uniform.value = texture;
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
   * （heightAt に置くと、掘割や斜面でメッシュの面に埋もれる）。読込前なら null。
   * 建物の敷地の段（TERRAIN.pads）は含まない（道は敷地を下げる前の地面に沿わせる）
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

  /** チャンク (x, y) の標高が読み込み済みか */
  isChunkReady(x: number, y: number): boolean {
    return this.chunks.get(`${x}/${y}`)?.heights != null;
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
    this.runCarveJobs(TERRAIN.carveBudgetMs);

    // 近い順に読み始める
    const now = performance.now();
    const pending = wanted.filter((c) => !c.mesh && !this.chunks.has(key(c)) && !((this.retryAt.get(key(c)) ?? 0) > now));
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
      const [dem, map, waterData, pads] = await Promise.all([
        fetchDem(chunk.x, chunk.y, z),
        fetchPhoto(chunk.x, chunk.y, z, TERRAIN.photoZoomOffset),
        fetchWaterMask(chunk.x, chunk.y, z),
        fetchPads(chunk.x, chunk.y),
      ]);
      const near = await fetchBuildingNear(chunk.x, chunk.y, z);
      const heights = dem ?? new Float32Array(TILE_PX * TILE_PX).fill(NO_DATA);
      fillNoData(heights, TILE_PX);
      if (waterData) flattenWater(heights, waterData.mask, waterData.size);
      const water = waterData?.texture ?? null;
      const [parks, landuse] = await Promise.all([
        fetchParks(chunk.x, chunk.y, z, waterData?.mask ?? null),
        fetchLanduse(chunk.x, chunk.y, z),
      ]);
      const geometry = buildGeometry(heights, pads, chunk.x, chunk.y, z, this.ecefToLocal!);
      if (chunk.dead) {
        geometry.dispose();
        map?.dispose();
        water?.dispose();
        parks?.texture.dispose();
        landuse?.texture.dispose();
        near.dispose();
        this.chunks.delete(key(chunk));
        return;
      }
      // 地面の種類（データが無くても住宅地の敷地のテンプレートで塗る）があるので、チャンクごとに材質を作る
      chunk.mesh = new THREE.Mesh(
        geometry,
        createMaterials(map, water, parks?.texture ?? null, landuse?.texture ?? null, near),
      );
      if (applyCarves(chunk.mesh, [...this.carves.values()])) finishCarves(chunk.mesh, false);
      geometry.computeBoundingBox();
      this.updateTrenchMask(chunk);
      geometry.computeBoundsTree();
      chunk.heights = heights;
      this.group.add(chunk.mesh);
      // 木と墓石（近くのチャンクだけ描く）
      const groundAt = (u: number, v: number) => {
        const lonLat = tileToLonLat(chunk.x + u, chunk.y + v, z);
        const lat = lonLat.lat * THREE.MathUtils.RAD2DEG;
        const lon = lonLat.lon * THREE.MathUtils.RAD2DEG;
        const h = this.surfaceHeightAt(lat, lon);
        return h === null ? null : this.toLocal(lat, lon, h - 0.2);
      };
      // 砂浜には木を植えない
      const trees = parks && landuse ? parks.trees.filter((t) => !isBeachAt(landuse, t.u, t.v)) : (parks?.trees ?? []);
      const props = trees.length > 0 ? buildTrees(trees, groundAt) : new THREE.Group();
      const graves = landuse
        ? buildGraves(landuse.graves, groundAt, (u, v, angle) => {
            // 区画の並ぶ向き（東が 0、北へ回る）の 1m 先の点との差
            const lonLat = tileToLonLat(chunk.x + u, chunk.y + v, z);
            const lat = lonLat.lat * THREE.MathUtils.RAD2DEG;
            const lon = lonLat.lon * THREE.MathUtils.RAD2DEG;
            const a = angle * THREE.MathUtils.DEG2RAD;
            const p0 = this.toLocal(lat, lon, 0);
            const p1 = this.toLocal(lat + Math.sin(a) / 111320, lon + Math.cos(a) / (111320 * Math.cos(lonLat.lat)), 0);
            return p1.sub(p0);
          })
        : null;
      if (graves) props.add(graves);
      if (props.children.length > 0) {
        chunk.trees = props;
        this.trees.add(props);
      }
      for (const l of this.listeners) l.onChunkAdded(chunk.x, chunk.y);
    } catch (e) {
      console.warn('[Terrain] チャンクの読込に失敗しました（少し待って読み直す）', chunk.x, chunk.y, e);
      this.chunks.delete(key(chunk));
      this.retryAt.set(key(chunk), performance.now() + TERRAIN.retryDelay * 1000);
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
      (materials[0].userData.nearMap as THREE.Texture | null | undefined)?.dispose();
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
  /** 線分：[ax, ay, az, bx, by, bz, 半分の幅] */
  segments: Float64Array;
  slope: number;
  fill: { reach: number; slope: number } | null;
  /** 線分の格子（CARVE_CELL m 四方（cellKey）→ 線分の番号）。頂点の近くの線分だけを調べる */
  grid: Map<number, number[]>;
  /** 一番広い半分の幅 + 斜面の届く距離 */
  reach: number;
  /** 線の範囲（ローカル座標） */
  box: THREE.Box3;
}

const CARVE_CELL = 32;
/** 順番待ちの線を当てる時、一度に調べる頂点の数（時間を見ながら、これを単位に進める） */
const CARVE_SLICE = 2048;
/** 格子のマスの番号（文字列のキーを作らないよう、数にする） */
const cellKey = (gx: number, gz: number) => (gx + 0x8000) * 0x10000 + (gz + 0x8000);
/** 削る斜面・盛る斜面が届く距離 (m) の既定値 */
const CARVE_SLOPE_REACH = 40;

function createCarve(
  lines: THREE.Vector3[][],
  halfOf: (line: number) => number,
  slope: number,
  fill: Carve['fill'],
  slopeReach: number,
): Carve | null {
  const list: number[] = [];
  const box = new THREE.Box3();
  let maxHalf = 0;
  lines.forEach((line, k) => {
    const half = halfOf(k);
    maxHalf = Math.max(maxHalf, half);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      list.push(a.x, a.y, a.z, b.x, b.y, b.z, half);
      box.expandByPoint(a).expandByPoint(b);
    }
  });
  if (list.length === 0) return null;
  const segments = Float64Array.from(list);
  const reach = maxHalf + Math.max(slopeReach, fill?.reach ?? 0);
  const grid = new Map<number, number[]>();
  for (let n = 0; n < segments.length / 7; n++) {
    const o = n * 7;
    const x0 = Math.floor((Math.min(segments[o], segments[o + 3]) - reach) / CARVE_CELL);
    const x1 = Math.floor((Math.max(segments[o], segments[o + 3]) + reach) / CARVE_CELL);
    const z0 = Math.floor((Math.min(segments[o + 2], segments[o + 5]) - reach) / CARVE_CELL);
    const z1 = Math.floor((Math.max(segments[o + 2], segments[o + 5]) + reach) / CARVE_CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = cellKey(gx, gz);
        const cell = grid.get(k);
        if (cell) cell.push(n);
        else grid.set(k, [n]);
      }
    }
  }
  return { segments, slope, fill, grid, reach, box };
}

/** (x, z) での1つの線の、削る上限と盛る下限（out[0] は小さく、out[1] は大きくする） */
function carveLimits(carve: Carve, key: number, x: number, z: number, out: [number, number]): void {
  const { box, reach } = carve;
  if (x < box.min.x - reach || x > box.max.x + reach || z < box.min.z - reach || z > box.max.z + reach) return;
  const cell = carve.grid.get(key);
  if (!cell) return;
  const { segments: seg, fill, slope } = carve;
  for (const n of cell) {
    const o = n * 7;
    const ax = seg[o];
    const az = seg[o + 2];
    const dx = seg[o + 3] - ax;
    const dz = seg[o + 5] - az;
    const len2 = dx * dx + dz * dz || 1;
    const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1);
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d > reach) continue;
    const half = seg[o + 6];
    const floor = seg[o + 1] + (seg[o + 4] - seg[o + 1]) * t;
    out[0] = Math.min(out[0], floor + Math.max(0, d - half) * slope);
    if (fill && d <= half + fill.reach) out[1] = Math.max(out[1], floor - Math.max(0, d - half) * fill.slope);
  }
}

/**
 * 地形メッシュの頂点を、削る線の底の高さ（と、その外の斜面）より上に出ないよう下げ、盛る線の近くの低い地面は上げる。
 * focus を渡すと、その線で動く頂点だけを、全部の線から高さを決め直す（後から足した線。
 * 削る線のすぐ脇に盛る線があっても、掘割を埋めないように）
 */
function applyCarves(
  mesh: THREE.Mesh,
  carves: Carve[],
  focus: Carve | null = null,
  start = 0,
  end = Infinity,
): boolean {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (focus && !carveTouches(focus, mesh)) return false;
  const touching = carves.filter((c) => carveTouches(c, mesh));
  if (touching.length === 0) return false;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const xyz = position.array as Float32Array;
  let changed = false;
  const limits: [number, number] = [Infinity, -Infinity];
  for (let i = start; i < Math.min(end, position.count); i++) {
    const x = xyz[i * 3];
    const y = xyz[i * 3 + 1];
    const z = xyz[i * 3 + 2];
    const key = cellKey(Math.floor(x / CARVE_CELL), Math.floor(z / CARVE_CELL));
    if (focus) {
      // 後から足した線で動かない頂点は、ほかの線も調べない
      limits[0] = Infinity;
      limits[1] = -Infinity;
      carveLimits(focus, key, x, z, limits);
      if (!(y > limits[0] || y < limits[1])) continue;
    }
    // 削る上限（これより上の地面は下げる）と、盛る下限（これより下の地面は上げる）
    limits[0] = Infinity;
    limits[1] = -Infinity;
    for (const carve of touching) carveLimits(carve, key, x, z, limits);
    const [limit, raise] = limits;
    if (y > limit) {
      position.setY(i, limit);
      changed = true;
    } else if (y < raise && y < limit) {
      position.setY(i, Math.min(raise, limit));
      changed = true;
    }
  }
  if (changed) position.needsUpdate = true;
  return changed;
}

/** 線を当てて頂点を動かしたメッシュの、法線・範囲（と refit なら当たり判定の木）を作り直す */
function finishCarves(mesh: THREE.Mesh, refit: boolean): void {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (refit) geometry.boundsTree?.refit();
}

/** 線がメッシュの範囲（と斜面の届く距離）にかかるか */
function carveTouches(c: Carve, mesh: THREE.Mesh): boolean {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return (
    c.box.max.x + c.reach >= b.min.x &&
    c.box.min.x - c.reach <= b.max.x &&
    c.box.max.z + c.reach >= b.min.z &&
    c.box.min.z - c.reach <= b.max.z
  );
}

function key(chunk: { x: number; y: number }): string {
  return `${chunk.x}/${chunk.y}`;
}

/** 掘割の無いチャンクの「描かない所」の画像（どこも遠い） */
const noTrench = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
noTrench.needsUpdate = true;

/**
 * 地形の材質に「描かない所」を足す。画像（写真と同じ uv）の赤は、掘割の中心線からの距離を RAILWAYS.portal.maskRange m で
 * 0〜1 にしたもの。擁壁の内側（RAILWAYS.portal.retainOffset m より近い所）は描かない。画像は Terrain.addTrench で後から作り直す
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
  near: THREE.Texture | null = null,
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
  addLanduse(ground, landuse, near);
  addTrenchMask(ground);
  return [
    // 縁の壁も本体と同じ材質で描く（別の材質だと、本体だけ奥へずらすので壁の上の縁が手前に出て、
    // 区画の境目が細い線に見える。同じ材質なら海の上でも水面の色になる）
    ground,
  ];
}

/** チャンク (x, y) の地形メッシュを作る。縁には隙間隠しの壁を付ける */
function buildGeometry(
  heights: Float32Array,
  pads: Float32Array | null,
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
  /** 頂点の周り（前後の頂点まで）の建物の底の一番低い高さ。無ければ Infinity */
  const reach = TILE_PX / seg;
  const padAt = (col: number, row: number) => {
    let low = Infinity;
    if (!pads) return low;
    const cx = (col / seg) * TILE_PX;
    const cy = (row / seg) * TILE_PX;
    const i0 = Math.max(0, Math.floor(cx - reach));
    const i1 = Math.min(TILE_PX - 1, Math.ceil(cx + reach) - 1);
    const j0 = Math.max(0, Math.floor(cy - reach));
    const j1 = Math.min(TILE_PX - 1, Math.ceil(cy + reach) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) low = Math.min(low, pads[j * TILE_PX + i]);
    return low;
  };
  /** 頂点が建物の中（頂点を囲む 4 ピクセルがすべて建物）なら、その底の一番低い高さ。でなければ null */
  const insideAt = (col: number, row: number) => {
    if (!pads) return null;
    const i = Math.round((col / seg) * TILE_PX);
    const j = Math.round((row / seg) * TILE_PX);
    if (i < 1 || j < 1 || i >= TILE_PX || j >= TILE_PX) return null;
    const v = Math.min(pads[(j - 1) * TILE_PX + i - 1], pads[(j - 1) * TILE_PX + i], pads[j * TILE_PX + i - 1], pads[j * TILE_PX + i]);
    return Number.isFinite(v) ? v : null;
  };

  const place = (k: number, col: number, row: number, heightOffset: number) => {
    let h = sampleHeight(heights, TILE_PX, (col / seg) * TILE_PX, (row / seg) * TILE_PX);
    // 建物の敷地：中は底の高さに平らにならし（坂の下側で浮かない）、周りは底より上に地面を出さない
    // （坂の上側の1階を覆わないよう、家ごとの平らな段にする）
    const inside = insideAt(col, row);
    const pad = padAt(col, row) + TERRAIN.pads.clearance;
    if (inside !== null && inside > h && inside - h < TERRAIN.pads.maxFill) h = inside;
    else if (pad < h && h - pad < TERRAIN.pads.maxDig) h = pad;
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
  geometry.addGroup(0, index.length, 0);
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
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
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

/** 標高タイルを取得して標高 (m, ジオイド基準) の配列にする。5m メッシュの無い所・穴は 10m メッシュで埋める */
async function fetchDem(x: number, y: number, z: number): Promise<Float32Array | null> {
  const fine = await fetchDemImage(tileUrl(TERRAIN.demUrl, x, y, z));
  if (fine && !fine.some(Number.isNaN)) return fine;
  // 10m メッシュ：1つ粗いタイルのうち、このタイルにあたる 1/4 を線形補間で引き伸ばす
  const coarse = await fetchDemImage(tileUrl(TERRAIN.demFallbackUrl, x >> 1, y >> 1, z - 1));
  if (!coarse) return fine;
  const out = fine ?? new Float32Array(TILE_PX * TILE_PX).fill(NO_DATA);
  const ox = (x & 1) * (TILE_PX / 2);
  const oy = (y & 1) * (TILE_PX / 2);
  const at = (i: number, j: number) => coarse[Math.min(j, TILE_PX - 1) * TILE_PX + Math.min(i, TILE_PX - 1)];
  for (let j = 0; j < TILE_PX; j++) {
    for (let i = 0; i < TILE_PX; i++) {
      if (!Number.isNaN(out[j * TILE_PX + i])) continue;
      const u = ox + i / 2;
      const v = oy + j / 2;
      const i0 = Math.floor(u);
      const j0 = Math.floor(v);
      const fu = u - i0;
      const fv = v - j0;
      out[j * TILE_PX + i] =
        (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
    }
  }
  return out;
}

async function fetchDemImage(url: string): Promise<Float32Array | null> {
  const image = await fetchImage(url);
  return image ? decodeDemImage(image) : null;
}

/** 読んだ建物の敷地の地図（隣のチャンクの建物までの距離を測るのにも使うので、しばらく取っておく） */
const padCache = new Map<string, Promise<Float32Array | null>>();
const PAD_CACHE_SIZE = 128;

/** 建物の敷地の地図（標高 PNG と同じ形式）。建物の無い所は Infinity。地図の無いチャンク（建物が無い）は null */
function fetchPads(x: number, y: number): Promise<Float32Array | null> {
  const k = `${x}/${y}`;
  let pads = padCache.get(k);
  if (pads) {
    // 使った物を後ろへ（古い物から捨てる）
    padCache.delete(k);
  } else {
    pads = loadPads(x, y);
    while (padCache.size >= PAD_CACHE_SIZE) padCache.delete(padCache.keys().next().value!);
  }
  padCache.set(k, pads);
  return pads;
}

async function loadPads(x: number, y: number): Promise<Float32Array | null> {
  try {
    const url = `${import.meta.env.BASE_URL}${TERRAIN.pads.path.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    // 開発サーバーは無いファイルの代わりに HTML を返すので、PNG かどうかで見分ける
    if (!res.ok || !res.headers.get('content-type')?.includes('png')) return null;
    const pads = decodeDemImage(await createImageBitmap(await res.blob()));
    for (let k = 0; k < pads.length; k++) if (Number.isNaN(pads[k])) pads[k] = Infinity;
    return pads;
  } catch {
    return null;
  }
}

/**
 * 地面の高さを走る線路（高架・トンネルの外）の中心線までの距離 (m) を、チャンクのピクセルごとに。TERRAIN.pads.railRange で打ち切り。
 * 線路わきの地面を道床と同じ焦げ茶の砂利にするのに使う。チャンクの縁の線路も拾うよう、周りのチャンクの線路も見る
 */
async function railDistance(x: number, y: number, z: number, pxMeters: number): Promise<Float32Array> {
  const range = TERRAIN.pads.railRange;
  const out = new Float32Array(TILE_PX * TILE_PX).fill(range);
  const n = 2 ** z;
  const toPx = (latE6: number, lonE6: number): [number, number] => {
    const lat = (latE6 / 1e6) * THREE.MathUtils.DEG2RAD;
    return [
      (((lonE6 / 1e6 + 180) / 360) * n - x) * TILE_PX,
      (((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n - y) * TILE_PX,
    ];
  };
  const reach = range / pxMeters;
  const tiles = await Promise.all(
    grid(3).map(async ([i, j]) => {
      try {
        const url = `${import.meta.env.BASE_URL}${RAILWAYS.tilePath.replace('{x}', `${x + i - 1}`).replace('{y}', `${y + j - 1}`)}`;
        const res = await fetch(url);
        if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
        return (await res.json()) as { t: Array<[number, number[], number[]]> };
      } catch {
        return null;
      }
    }),
  );
  for (const tile of tiles) {
    for (const [, coords, heights] of tile?.t ?? []) {
      let lat = 0;
      let lon = 0;
      let prev: [number, number] | null = null;
      for (let k = 0; k < coords.length / 2; k++) {
        lat += coords[k * 2];
        lon += coords[k * 2 + 1];
        const p = toPx(lat, lon);
        // 高架（地面から 2.5m 以上）の区間は、下の地面を塗らない
        const ground = Math.abs(heights[k] ?? 0) < 25 && Math.abs(heights[k - 1] ?? 0) < 25;
        if (prev && ground) {
          const [ax, ay] = prev;
          const [bx, by] = p;
          const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
          const x1 = Math.min(TILE_PX - 1, Math.ceil(Math.max(ax, bx) + reach));
          const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
          const y1 = Math.min(TILE_PX - 1, Math.ceil(Math.max(ay, by) + reach));
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy || 1;
          for (let py = y0; py <= y1; py++) {
            for (let px = x0; px <= x1; px++) {
              const cx = px + 0.5;
              const cy = py + 0.5;
              const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2));
              const m = Math.hypot(cx - ax - dx * t, cy - ay - dy * t) * pxMeters;
              const i = py * TILE_PX + px;
              if (m < out[i]) out[i] = m;
            }
          }
        }
        prev = p;
      }
    }
  }
  return out;
}

/**
 * 一番近い建物までの距離の画像（R = 距離 / TERRAIN.pads.nearRange、1 で打ち切り）。地面の種類の塗り分け（家の周りは敷地、
 * 離れた所は草地・土）に使う。チャンクの縁で途切れないよう、周りのチャンクの建物も数える
 */
async function fetchBuildingNear(x: number, y: number, z: number): Promise<THREE.DataTexture> {
  const range = TERRAIN.pads.nearRange;
  const { lat } = tileToLonLat(x + 0.5, y + 0.5, z);
  const pxMeters = (40075016 * Math.cos(lat)) / 2 ** z / TILE_PX;
  const margin = Math.ceil(range / pxMeters);
  const size = TILE_PX + margin * 2;
  const around = await Promise.all(grid(3).map(([i, j]) => fetchPads(x + i - 1, y + j - 1)));
  // 建物のピクセルを 0、ほかを遠くにして、2回なぞる距離変換（斜めは √2）
  const far = range / pxMeters + 1;
  const d = new Float32Array(size * size).fill(far);
  grid(3).forEach(([i, j], n) => {
    const pads = around[n];
    if (!pads) return;
    for (let py = 0; py < TILE_PX; py++) {
      const gy = (j - 1) * TILE_PX + py + margin;
      if (gy < 0 || gy >= size) continue;
      for (let px = 0; px < TILE_PX; px++) {
        const gx = (i - 1) * TILE_PX + px + margin;
        if (gx >= 0 && gx < size && Number.isFinite(pads[py * TILE_PX + px])) d[gy * size + gx] = 0;
      }
    }
  });
  const D = Math.SQRT2;
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      const k = gy * size + gx;
      let v = d[k];
      if (gx > 0) v = Math.min(v, d[k - 1] + 1);
      if (gy > 0) {
        v = Math.min(v, d[k - size] + 1);
        if (gx > 0) v = Math.min(v, d[k - size - 1] + D);
        if (gx < size - 1) v = Math.min(v, d[k - size + 1] + D);
      }
      d[k] = v;
    }
  }
  for (let gy = size - 1; gy >= 0; gy--) {
    for (let gx = size - 1; gx >= 0; gx--) {
      const k = gy * size + gx;
      let v = d[k];
      if (gx < size - 1) v = Math.min(v, d[k + 1] + 1);
      if (gy < size - 1) {
        v = Math.min(v, d[k + size] + 1);
        if (gx < size - 1) v = Math.min(v, d[k + size + 1] + D);
        if (gx > 0) v = Math.min(v, d[k + size - 1] + D);
      }
      d[k] = v;
    }
  }
  const rail = await railDistance(x, y, z, pxMeters);
  // 北が上の写真と同じ uv にするので、行を上下逆に入れる（R = 建物まで、G = 線路まで）
  const railRange = TERRAIN.pads.railRange;
  const data = new Uint8Array(TILE_PX * TILE_PX * 2);
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      const m = d[(py + margin) * size + px + margin] * pxMeters;
      const k = ((TILE_PX - 1 - py) * TILE_PX + px) * 2;
      data[k] = Math.round(Math.min(1, m / range) * 255);
      data[k + 1] = Math.round(Math.min(1, rail[py * TILE_PX + px] / railRange) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, TILE_PX, TILE_PX, THREE.RGFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function decodeDemImage(image: ImageBitmap): Float32Array {
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

/**
 * 国土地理院の通信は時々返事が来ないまま止まるので、15秒で打ち切ってもう1回だけ取り直す（止まるとチャンクがずっと読めない）。
 * タイルが無い（404 など）なら null。打ち切り・通信の失敗・混雑（5xx・429）が続いたら投げる
 * （「データなし」と同じに扱うと、高さ 0 の地形のまま読み直さない）
 */
async function fetchImage(url: string): Promise<ImageBitmap | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status >= 500 || res.status === 429) continue;
      if (!res.ok) return null;
      return await createImageBitmap(await res.blob());
    } catch {
      // 打ち切り・通信の失敗はもう1回
    }
  }
  throw new Error(`取得に失敗しました: ${url}`);
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
