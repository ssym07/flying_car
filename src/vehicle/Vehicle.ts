import * as THREE from 'three';
import type { VehicleState } from './physics';

/**
 * 車の状態（位置・速度・向き）とメッシュ。
 * 描画時は前回と今回の状態を alpha で補間して、固定刻みのカクつきを隠す。
 */
export class Vehicle {
  state: VehicleState;
  private prev: VehicleState;
  readonly mesh: THREE.Group;

  constructor(initial: VehicleState) {
    this.state = clone(initial);
    this.prev = clone(initial);
    this.mesh = buildMesh();
  }

  /** 物理の結果を反映する（前回の状態は補間用に保持） */
  commit(next: VehicleState): void {
    this.prev = this.state;
    this.state = next;
  }

  /** ワープ時など、補間せずに置き換える */
  reset(state: VehicleState): void {
    this.state = clone(state);
    this.prev = clone(state);
  }

  /** alpha で補間した位置・向きをメッシュに反映する */
  syncMesh(alpha: number): void {
    const a = this.prev.position;
    const b = this.state.position;
    this.mesh.position.set(lerp(a.x, b.x, alpha), lerp(a.y, b.y, alpha), lerp(a.z, b.z, alpha));
    this.mesh.rotation.y = lerp(this.prev.yaw, this.state.yaw, alpha);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clone(s: VehicleState): VehicleState {
  return { position: { ...s.position }, velocity: { ...s.velocity }, yaw: s.yaw };
}

/** 箱ベースの簡単な空飛ぶ車。前方は -z */
function buildMesh(): THREE.Group {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8453c, metalness: 0.3, roughness: 0.4 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x223344, metalness: 0.6, roughness: 0.1 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x3399ff, emissiveIntensity: 2 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.7, 4.2), bodyMat);
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2), glassMat);
  cabin.position.set(0, 0.6, 0.2);
  group.add(cabin);

  // 四隅のホバーユニット
  const podGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.3, 20);
  const glowGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.05, 20);
  for (const x of [-1.3, 1.3]) {
    for (const z of [-1.6, 1.6]) {
      const pod = new THREE.Mesh(podGeo, darkMat);
      pod.position.set(x, -0.2, z);
      group.add(pod);
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(x, -0.38, z);
      group.add(glow);
    }
  }

  // テールライト（向きが分かるように）
  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.15, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 1.5 }),
  );
  tail.position.set(0, 0.1, 2.12);
  group.add(tail);

  return group;
}
