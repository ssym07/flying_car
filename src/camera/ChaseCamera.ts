import * as THREE from 'three';
import { CAMERA } from '../core/config';
import type { Collision } from '../world/Collision';

/**
 * 三人称追従カメラ。車の後方上空のオフセットへ指数的に寄せる。
 * 追従を遅らせることで、旋回時にカメラが少し遅れてついてくる。
 * マウスで車のまわりを回したり（orbit）、距離を変えたり（zoom）できる。
 * 回した角度は、操作をやめてしばらくすると車の後ろへ戻る。
 */
export class ChaseCamera {
  private readonly desired = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly lookCurrent = new THREE.Vector3();
  private readonly pivot = new THREE.Vector3();
  private readonly clipped = new THREE.Vector3();
  private initialized = false;
  /** マウスで回した角度（車の真後ろからのずれ） */
  private orbitYaw = 0;
  private orbitPitch = 0;
  /** マウスホイールでの距離の倍率 */
  private zoom = 1;
  private sinceOrbit = Infinity;
  private dragging = false;
  private readonly basePitch = Math.atan2(CAMERA.offset.up, CAMERA.offset.back);
  private readonly baseDistance = Math.hypot(CAMERA.offset.up, CAMERA.offset.back);

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly collision: Collision | null = null,
    private readonly groundY = () => -Infinity,
  ) {}

  /**
   * マウス操作を反映する。
   * @param dx 横のドラッグ量 (px)
   * @param dy 縦のドラッグ量 (px)
   * @param wheel ホイールの回転量（deltaY）
   * @param dragging いまドラッグ中か
   */
  control(dx: number, dy: number, wheel: number, dragging: boolean): void {
    const m = CAMERA.mouse;
    if (dx !== 0 || dy !== 0 || dragging) this.sinceOrbit = 0;
    // 右へドラッグ → カメラが左へ回り込む（掴んで回す感覚）
    this.orbitYaw = wrapAngle(this.orbitYaw - dx * m.sensitivity);
    const pitch = THREE.MathUtils.clamp(
      this.basePitch + this.orbitPitch + dy * m.sensitivity,
      m.minPitchDeg * THREE.MathUtils.DEG2RAD,
      m.maxPitchDeg * THREE.MathUtils.DEG2RAD,
    );
    this.orbitPitch = pitch - this.basePitch;
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp((wheel / 100) * m.zoomStep), m.minZoom, m.maxZoom);
    this.dragging = dragging;
  }

  /** 補間済みの車の位置・向きを渡して毎フレーム呼ぶ */
  follow(target: THREE.Vector3, yaw: number, dt: number): void {
    const m = CAMERA.mouse;
    // 操作をやめてしばらくしたら、車の後ろへ戻す
    this.sinceOrbit += dt;
    if (!this.dragging && this.sinceOrbit > m.returnDelay) {
      const k = Math.exp(-m.returnRate * dt);
      this.orbitYaw *= k;
      this.orbitPitch *= k;
    }
    const orbiting = Math.abs(this.orbitYaw) + Math.abs(this.orbitPitch) > 0.02;

    // 車の後方（+z 側を yaw で回したもの）から、マウスで回した分だけずらした球面上の点
    const camYaw = yaw + this.orbitYaw;
    const pitch = this.basePitch + this.orbitPitch;
    const distance = this.baseDistance * this.zoom;
    this.desired.set(
      target.x + Math.sin(camYaw) * Math.cos(pitch) * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(camYaw) * Math.cos(pitch) * distance,
    );
    this.lookTarget.set(target.x, target.y + CAMERA.lookAtHeight, target.z);

    if (!this.initialized) {
      this.camera.position.copy(this.desired);
      this.lookCurrent.copy(this.lookTarget);
      this.initialized = true;
    } else {
      // フレームレートに依存しない lerp 係数
      // マウスで回している間は素早く追従させる（遅いと補間の途中でカメラが車を突き抜ける）
      const rate = orbiting ? m.followRate : CAMERA.followRate;
      this.camera.position.lerp(this.desired, 1 - Math.exp(-rate * dt));
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

/** 角度を -π..π に収める */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
