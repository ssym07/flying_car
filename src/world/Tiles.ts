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

/**
 * 3d-tiles-renderer のラッパ。
 * ECEF（地球中心座標）で届くタイルを、開始地点を原点にした「東・北・上」の
 * ローカル座標（y が上）へ変換して扱う。
 */
export class Tiles {
  readonly renderer: TilesRenderer;
  private loading = false;
  private loadedOnce = false;

  constructor(camera: THREE.Camera, glRenderer: THREE.WebGLRenderer) {
    const tiles = new TilesRenderer(WORLD.tilesetUrl);
    const { latDeg, lonDeg, ellipsoidHeight } = WORLD.origin;
    // PLATEAU のタイルは Draco 圧縮 + CESIUM_RTC 拡張を使っている
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
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
    tiles.errorTarget = WORLD.errorTarget;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, glRenderer);

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

  /**
   * 原点まわりで読み込まれた建物の底面の高さから、地面の高さを推定する。
   * PLATEAU の建物データには地形が含まれないため、地面は平面で代用している。
   */
  estimateGroundHeight(radius = 500): number | null {
    // タイルのメッシュは ECEF の向きのまま回転して置かれているので、
    // バウンディングボックスで測ると大きく膨らむ。頂点を直接見る。
    const v = new THREE.Vector3();
    const heights: number[] = [];
    this.group.updateMatrixWorld(true);
    this.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const pos = (obj.geometry as THREE.BufferGeometry).getAttribute('position');
      if (!pos) return;
      // 全頂点は多いので間引く
      const stride = Math.max(1, Math.floor(pos.count / 5000));
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
        if (Math.hypot(v.x, v.z) < radius) heights.push(v.y);
      }
    });
    if (heights.length === 0) return null;
    // 押し出しの箱なので頂点の約半分は建物の底面。下位側を地面の高さとみなす
    heights.sort((a, b) => a - b);
    return heights[Math.floor(heights.length * 0.25)];
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
