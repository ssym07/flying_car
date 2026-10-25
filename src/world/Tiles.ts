import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { WORLD } from '../core/config';

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
  private loading = false;
  private loadedOnce = false;
  /** ECEF → ローカル座標の変換行列。ルートの tileset を読んだ時点で決まる */
  readonly ready: Promise<THREE.Matrix4>;

  /**
   * @param color 指定するとマテリアルをこの色で上書きする（テクスチャの無いデータ向け）
   */
  constructor(
    url: string,
    errorTarget: number,
    color: number | null,
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
    tiles.errorTarget = errorTarget;
    tiles.lruCache.minBytesSize = WORLD.cacheBytes.min;
    tiles.lruCache.maxBytesSize = WORLD.cacheBytes.max;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, glRenderer);

    tiles.registerPlugin(new TileModelPlugin(color, WORLD.maxTextureSize));
    tiles.addEventListener('load-model', ({ scene }) => {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.computeBoundsTree();
      });
    });
    tiles.addEventListener('dispose-model', ({ scene }) => {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.disposeBoundsTree();
      });
    });
    tiles.addEventListener('tiles-load-start', () => {
      this.loading = true;
    });
    tiles.addEventListener('tiles-load-end', () => {
      this.loading = false;
      this.loadedOnce = true;
    });
    tiles.addEventListener('load-error', ({ url, error }) => {
      console.warn('[Tiles] load error', url, error);
    });

    // ReorientationPlugin が同じイベントで group の変換を設定するので、それより後に読む
    this.ready = new Promise((resolve) => {
      tiles.addEventListener('load-root-tileset', () => {
        queueMicrotask(() => {
          tiles.group.updateMatrixWorld();
          resolve(tiles.group.matrixWorld.clone());
        });
      });
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

  get isLoading(): boolean {
    return this.loading;
  }

  /** 一度でも読込キューが空になったか */
  get hasLoaded(): boolean {
    return this.loadedOnce;
  }

  /** カメラ位置に応じてタイルを読込・破棄する。毎フレーム呼ぶ */
  update(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.renderer.update();
  }

  setResolution(camera: THREE.Camera, glRenderer: THREE.WebGLRenderer): void {
    this.renderer.setResolutionFromRenderer(camera, glRenderer);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

/**
 * タイルのモデルを読み込んだ直後（キャッシュのメモリ計算より前）に手を加えるプラグイン。
 * - 大きすぎるテクスチャを縮小して GPU メモリを抑える
 * - 色の指定があればマテリアルを上書きする
 */
class TileModelPlugin {
  private readonly material: THREE.Material | null;

  constructor(
    color: number | null,
    private readonly maxTextureSize: number,
  ) {
    this.material = color === null ? null : new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  }

  async processTileModel(scene: THREE.Object3D): Promise<void> {
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
