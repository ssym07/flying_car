import * as THREE from 'three';
import { CAMERA } from '../core/config';
import type { Collision } from '../world/Collision';

/**
 * 三人称追従カメラ。車の後方上空のオフセットへ指数的に寄せる。
 * 追従を遅らせることで、旋回時にカメラが少し遅れてついてくる。
 */
export class ChaseCamera {
  private readonly desired = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly lookCurrent = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly clipped = new THREE.Vector3();
  private initialized = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly collision: Collision | null = null,
    private readonly groundY = () => -Infinity,
  ) {}

  /** 補間済みの車の位置・向きを渡して毎フレーム呼ぶ */
  follow(target: THREE.Vector3, yaw: number, dt: number): void {
    // 車の後方（+z 側を yaw で回したもの）・上方
    const back = CAMERA.offset.back;
    this.desired.set(
      target.x + Math.sin(yaw) * back,
      target.y + CAMERA.offset.up,
      target.z + Math.cos(yaw) * back,
    );
    this.lookTarget.set(target.x, target.y + CAMERA.lookAtHeight, target.z);

    if (!this.initialized) {
      this.camera.position.copy(this.desired);
      this.lookCurrent.copy(this.lookTarget);
      this.initialized = true;
    } else {
      // フレームレートに依存しない lerp 係数
      this.camera.position.lerp(this.desired, 1 - Math.exp(-CAMERA.followRate * dt));
      this.lookCurrent.lerp(this.lookTarget, 1 - Math.exp(-CAMERA.lookRate * dt));
    }

    // 車とカメラの間に建物があれば、手前に寄せる
    if (this.collision) {
      this.pivot.copy(this.lookTarget);
      if (this.collision.clipSegment(this.pivot, this.camera.position, CAMERA.wallPadding, this.clipped)) {
        this.camera.position.copy(this.clipped);
      }
    }
    const minY = this.groundY() + 0.5;
    if (this.camera.position.y < minY) this.camera.position.y = minY;

    this.camera.lookAt(this.lookCurrent);
  }

  /** 次の follow でオフセット位置へ瞬間移動させる */
  snap(): void {
    this.initialized = false;
  }
}
