// Three.js に依存しない純粋関数の物理。
// 座標は y が上、yaw=0 のとき前方は -z（Three.js のカメラと同じ向き）。

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface VehicleState {
  position: Vec3;
  velocity: Vec3;
  /** y軸まわりの向き (rad) */
  yaw: number;
}

export interface ControlInput {
  /** -1(後退)..1(前進) */
  throttle: number;
  /** -1(左)..1(右) */
  turn: number;
  /** -1(下降)..1(上昇) */
  lift: number;
}

export interface PhysicsParams {
  gravity: number;
  hoverRatio: number;
  thrust: number;
  reverseThrust: number;
  liftThrust: number;
  turnRate: number;
  dragForward: number;
  dragLateral: number;
  dragVertical: number;
}

/** yaw から前方ベクトル（水平）を得る */
export function forwardOf(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** 1ステップ進めた新しい状態を返す（入力の state は変更しない） */
export function step(
  state: VehicleState,
  input: ControlInput,
  p: PhysicsParams,
  dt: number,
): VehicleState {
  // 右旋回（turn>0）で yaw は減る（上から見て時計回り）
  const yaw = state.yaw - input.turn * p.turnRate * dt;
  const fwd = forwardOf(yaw);
  const right = { x: -fwd.z, z: fwd.x };

  let { x: vx, y: vy, z: vz } = state.velocity;

  // 推力
  const thrust = input.throttle >= 0 ? input.throttle * p.thrust : input.throttle * p.reverseThrust;
  vx += fwd.x * thrust * dt;
  vz += fwd.z * thrust * dt;

  // 重力 + ホバー推力 + 上昇下降
  vy += (-p.gravity + p.gravity * p.hoverRatio + input.lift * p.liftThrust) * dt;

  // 空気抵抗：機体の前後・左右に分けて減衰させる（左右を強くして横滑りを抑える）
  let vForward = vx * fwd.x + vz * fwd.z;
  let vLateral = vx * right.x + vz * right.z;
  vForward *= Math.exp(-p.dragForward * dt);
  vLateral *= Math.exp(-p.dragLateral * dt);
  vy *= Math.exp(-p.dragVertical * dt);
  vx = fwd.x * vForward + right.x * vLateral;
  vz = fwd.z * vForward + right.z * vLateral;

  return {
    yaw,
    velocity: { x: vx, y: vy, z: vz },
    position: {
      x: state.position.x + vx * dt,
      y: state.position.y + vy * dt,
      z: state.position.z + vz * dt,
    },
  };
}

export function horizontalSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

export function speed(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}
