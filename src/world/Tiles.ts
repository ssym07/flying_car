import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { WORLD } from '../core/config';
import { assignFacadeAttributes, createFacadeMaterial } from './facade';

// 当たり判定のレイキャストを BVH で高速化する
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// PLATEAU のタイルは Draco 圧縮 + CESIUM_RTC 拡張を使っている。デコーダは全レイヤーで共有する
const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

/**
 * 3d-tiles-renderer のラッパ。
 * ECEF（地球中心座標）で届くタイルを、開始地点を原点にした「東・北・上」の
 * ローカル座標（y が上）へ変換して扱う。
 */
export class Tiles {
  readonly renderer: TilesRenderer;
  private rootLoaded = false;
  private readonly baseErrorTarget: number;
  /** タイルセット全体を囲む球（ローカル座標）。ルートを読むまでは null */
  private bounds: THREE.Sphere | null = null;

  /**
   * @param appearance 見た目。データのまま / 外壁テンプレートを貼る / 単色で塗る
   */
  constructor(
    url: string,
    errorTarget: number,
    appearance: TileAppearance,
    camera: THREE.Camera,
    glRenderer: THREE.WebGLRenderer,
  ) {
    const tiles = new TilesRenderer(url);
    const { latDeg, lonDeg, ellipsoidHeight } = WORLD.origin;
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco, rtc: true }));
    tiles.registerPlugin(
      new ReorientationPlugin({
        lat: latDeg * THREE.MathUtils.DEG2RAD,
        lon: lonDeg * THREE.MathUtils.DEG2RAD,
        height: ellipsoidHeight,
        up: '+y',
        recenter: true,
      }),
    );
    this.baseErrorTarget = errorTarget;
    tiles.errorTarget = errorTarget;
    tiles.lruCache.minBytesSize = WORLD.cacheBytes.min;
    tiles.lruCache.maxBytesSize = WORLD.cacheBytes.max;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, glRenderer);

    const modelPlugin = new TileModelPlugin(appearance, WORLD.maxTextureSize);
    tiles.registerPlugin(modelPlugin);
    tiles.addEventListener('load-model', ({ scene, tile }) => {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.computeBoundsTree();
      });
      // 共有マテリアルはタイルを捨てる時に一緒に破棄されないよう、破棄リストから外す
      // （破棄されるとシェーダーの作り直しでカクつく）
      const engineData = (tile as unknown as { engineData: { materials: THREE.Material[] | null } }).engineData;
      if (modelPlugin.material && engineData.materials) {
        engineData.materials = engineData.materials.filter((m) => m !== modelPlugin.material);
      }
    });
    tiles.addEventListener('dispose-model', ({ scene }) => {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.disposeBoundsTree();
      });
    });
    tiles.addEventListener('load-error', ({ url, error }) => {
      console.warn('[Tiles] load error', url, error);
    });

    tiles.addEventListener('load-root-tileset', () => {
      this.rootLoaded = true;
    });

    this.renderer = tiles;
  }

  get group(): THREE.Group {
    return this.renderer.group;
  }

  /** 0..1 */
  get progress(): number {
    return this.renderer.loadProgress;
  }

  /**
   * ルートの tileset を読み終え、いま必要なタイルの取得・解析待ちが無いか。
   * 視界に入らないタイルセットはルートだけ読んで待ちが無くなるので、すぐ true になる
   */
  get isIdle(): boolean {
    // stats は実装にはあるが型定義に無い
    const { downloading, parsing, queued } = (this.renderer as unknown as { stats: TileStats }).stats;
    return this.rootLoaded && downloading === 0 && parsing === 0 && queued === 0;
  }

  /** カメラ位置に応じてタイルを読込・破棄する。毎フレーム呼ぶ */
  update(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.adjustErrorTarget(camera.position);
    this.renderer.update();
  }

  /**
   * カメラから離れたタイルセット（遠くの区）ほど粗く読む。
   * 霧の向こうの区の細かいタイルに回線を取られて、手前の読込が遅れるのを防ぐ
   */
  private adjustErrorTarget(cameraPosition: THREE.Vector3): void {
    if (!this.bounds) {
      const sphere = new THREE.Sphere();
      if (!this.renderer.getBoundingSphere(sphere)) return;
      this.renderer.group.updateMatrixWorld();
      this.bounds = sphere.applyMatrix4(this.renderer.group.matrixWorld);
    }
    const { near, maxScale } = WORLD.distantLod;
    const distance = Math.max(0, cameraPosition.distanceTo(this.bounds.center) - this.bounds.radius);
    this.renderer.errorTarget = this.baseErrorTarget * THREE.MathUtils.clamp(distance / near, 1, maxScale);
  }

  setResolution(camera: THREE.Camera, glRenderer: THREE.WebGLRenderer): void {
    this.renderer.setResolutionFromRenderer(camera, glRenderer);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

interface TileStats {
  downloading: number;
  parsing: number;
  queued: number;
}

/** タイルの見た目 */
export type TileAppearance = 'original' | 'facade' | { color: number };

/** 外壁テンプレートのマテリアル（全タイルで共有） */
let facadeMaterial: THREE.Material | null = null;

/**
 * タイルのモデルを読み込んだ直後（キャッシュのメモリ計算より前）に手を加えるプラグイン。
 * - 大きすぎるテクスチャを縮小して GPU メモリを抑える
 * - テクスチャの無いデータには外壁テンプレートを貼るか、単色で塗る
 */
class TileModelPlugin {
  /** 上書きに使う共有マテリアル（データのままなら null） */
  readonly material: THREE.Material | null;

  constructor(
    private readonly appearance: TileAppearance,
    private readonly maxTextureSize: number,
  ) {
    if (appearance === 'facade') this.material = facadeMaterial ??= createFacadeMaterial();
    else if (appearance === 'original') this.material = null;
    else this.material = new THREE.MeshStandardMaterial({ color: appearance.color, roughness: 0.9 });
  }

  async processTileModel(scene: THREE.Object3D): Promise<void> {
    if (this.appearance === 'facade') assignFacadeAttributes(scene);
    const textures = new Set<THREE.Texture>();
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (this.material) {
        obj.material.dispose();
        obj.material = this.material;
      } else if (obj.material.map) {
        textures.add(obj.material.map);
      }
    });
    await Promise.all([...textures].map((t) => shrinkTexture(t, this.maxTextureSize)));
  }
}

/** メインスレッドを止めないよう createImageBitmap で縮小する */
async function shrinkTexture(texture: THREE.Texture, maxSize: number): Promise<void> {
  const image = texture.image as ImageBitmap | HTMLImageElement | undefined;
  if (!image) return;
  const scale = maxSize / Math.max(image.width, image.height);
  if (scale >= 1) return;
  const resized = await createImageBitmap(image, {
    resizeWidth: Math.round(image.width * scale),
    resizeHeight: Math.round(image.height * scale),
    resizeQuality: 'medium',
    // 元画像の向きをそのまま保つ（GLTFLoader の ImageBitmap は flipY 済みではない）
    imageOrientation: 'none',
  });
  if ('close' in image) image.close();
  texture.image = resized;
  texture.needsUpdate = true;
}
