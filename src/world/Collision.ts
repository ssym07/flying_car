import * as THREE from 'three';
import type { VehicleState } from '../vehicle/physics';

export interface CollisionResult {
  state: VehicleState;
  /** 真下の地面（建物の屋上を含む）の高さ */
  groundHeight: number;
  grounded: boolean;
}

const DOWN = new THREE.Vector3(0, -1, 0);
/** 真下の地面を探す最大距離 (m) */
const GROUND_PROBE = 2000;
/** 押し出し判定に使うレイの本数 */
const PUSH_RAYS = 8;
/** すり抜け防止で止める時に壁から離しておく距離 (m) */
const TUNNEL_MARGIN = 0.1;

/**
 * レイキャストで地面・建物へのめり込みを防ぐ。
 * - 壁：移動線のレイですり抜けを防ぎ、周囲のレイで半径ぶん押し出す
 * - 下方向：真下の地面・屋上の高さを取って接地させる
 */
export class Collision {
  private readonly raycaster = new THREE.Raycaster();
  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly hits: THREE.Intersection[] = [];

  /**
   * @param targets 当たり判定の対象（タイル・地形の group など）
   * @param groundY 平面で代用している地面の高さ
   */
  constructor(
    private readonly targets: THREE.Object3D[],
    public groundY: number,
    private readonly radius: number,
    private readonly halfHeight: number,
  ) {
    this.raycaster.firstHitOnly = true;
  }

  resolve(prev: VehicleState, next: VehicleState): CollisionResult {
    const position = { ...next.position };
    const velocity = { ...next.velocity };

    // --- 壁：水平方向だけを見る。上下は下方向レイで扱う ---
    // 1) すり抜け防止：前回位置から今回位置へ中心のレイを飛ばす（移動量ぶん伸ばすので高速でも抜けない）
    const dx = position.x - prev.position.x;
    const dz = position.z - prev.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-6) {
      this.dir.set(dx / dist, 0, dz / dist);
      this.origin.set(prev.position.x, prev.position.y, prev.position.z);
      const hit = this.castHorizontal(dist);
      if (hit) {
        const allowed = Math.max(0, hit.distance - TUNNEL_MARGIN);
        position.x = prev.position.x + this.dir.x * allowed;
        position.z = prev.position.z + this.dir.z * allowed;
      }
    }

    // 2) 押し出し：周囲にレイを飛ばし、半径より近い壁から法線方向に押し戻す。
    //    壁に向かう速度成分だけ消すので、壁沿いに滑る
    for (let i = 0; i < PUSH_RAYS; i++) {
      const a = (i / PUSH_RAYS) * Math.PI * 2;
      this.dir.set(Math.cos(a), 0, Math.sin(a));
      this.origin.set(position.x, position.y, position.z);
      const hit = this.castHorizontal(this.radius);
      if (!hit) continue;
      const n = this.normal;
      // 壁までの垂直距離（斜めに当たったレイは距離が長めに出るため補正）
      const perpendicular = hit.distance * Math.abs(this.dir.dot(n));
      const push = this.radius - perpendicular;
      if (push <= 0) continue;
      position.x += n.x * push;
      position.z += n.z * push;
      const into = velocity.x * n.x + velocity.z * n.z;
      if (into < 0) {
        velocity.x -= n.x * into;
        velocity.z -= n.z * into;
      }
    }

    // --- 下方向（地面・屋上） ---
    // 1ステップで屋上を通り抜けないよう、前回と今回の高い方からレイを出す
    const top = Math.max(prev.position.y, position.y) + this.halfHeight;
    this.origin.set(position.x, top, position.z);
    this.raycaster.set(this.origin, DOWN);
    this.raycaster.far = GROUND_PROBE;
    const groundHit = this.cast();
    const groundHeight = Math.max(this.groundY, groundHit ? groundHit.point.y : -Infinity);

    let grounded = false;
    if (position.y - this.halfHeight <= groundHeight) {
      position.y = groundHeight + this.halfHeight;
      if (velocity.y < 0) velocity.y = 0;
      grounded = true;
    }

    return { state: { position, velocity, yaw: next.yaw }, groundHeight, grounded };
  }

  /**
   * this.origin から this.dir（水平）へレイを飛ばす。
   * 当たったら、その面の水平な法線（車の側を向く）を this.normal に入れる。
   */
  private castHorizontal(far: number): THREE.Intersection | null {
    this.raycaster.set(this.origin, this.dir);
    this.raycaster.far = far;
    const hit = this.cast();
    if (!hit) return null;
    const n = this.normal;
    if (hit.face) n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    else n.copy(this.dir).negate();
    n.y = 0;
    if (n.lengthSq() < 1e-6) n.copy(this.dir).negate();
    n.normalize();
    if (n.dot(this.dir) > 0) n.negate();
    return hit;
  }

  private cast(): THREE.Intersection | null {
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.targets, true, this.hits);
    return this.hits[0] ?? null;
  }

  /** (x, z) の真下の地面（屋上を含む）の高さ。上空 fromY から探す */
  groundHeightAt(x: number, z: number, fromY = 1000): number {
    this.origin.set(x, fromY, z);
    this.raycaster.set(this.origin, DOWN);
    this.raycaster.far = GROUND_PROBE;
    const hit = this.cast();
    return Math.max(this.groundY, hit ? hit.point.y : -Infinity);
  }

  /**
   * from から to への線分が建物に遮られるなら、遮られた地点（padding 手前）を返す。
   * カメラのめり込み防止に使う。
   */
  clipSegment(from: THREE.Vector3, to: THREE.Vector3, padding: number, out: THREE.Vector3): boolean {
    this.dir.subVectors(to, from);
    const len = this.dir.length();
    if (len < 1e-6) return false;
    this.dir.divideScalar(len);
    this.raycaster.set(from, this.dir);
    this.raycaster.far = len + padding;
    const hit = this.cast();
    if (!hit) return false;
    out.copy(from).addScaledVector(this.dir, Math.max(0, hit.distance - padding));
    return true;
  }
}
