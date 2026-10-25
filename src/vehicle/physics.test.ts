import { describe, expect, it } from 'vitest';
import { step, speed, type ControlInput, type VehicleState } from './physics';
import { PHYSICS } from '../core/config';

const idle: ControlInput = { throttle: 0, turn: 0, lift: 0 };
const rest = (): VehicleState => ({
  position: { x: 0, y: 10, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  yaw: 0,
});

function run(s: VehicleState, input: ControlInput, seconds: number): VehicleState {
  for (let i = 0; i < seconds * 60; i++) s = step(s, input, PHYSICS, 1 / 60);
  return s;
}

describe('physics.step', () => {
  it('無入力ならホバーで高度を保つ', () => {
    const s = run(rest(), idle, 5);
    expect(s.position.y).toBeCloseTo(10, 5);
  });

  it('yaw=0 で前進すると -z に進む', () => {
    const s = run(rest(), { ...idle, throttle: 1 }, 1);
    expect(s.position.z).toBeLessThan(-1);
    expect(Math.abs(s.position.x)).toBeLessThan(1e-9);
  });

  it('前進し続けると最高速 thrust/drag に近づく', () => {
    const s = run(rest(), { ...idle, throttle: 1 }, 30);
    expect(speed(s.velocity)).toBeCloseTo(PHYSICS.thrust / PHYSICS.dragForward, 0);
  });

  it('手を離すと自然に減速する', () => {
    const moving = run(rest(), { ...idle, throttle: 1 }, 5);
    const after = run(moving, idle, 5);
    expect(speed(after.velocity)).toBeLessThan(speed(moving.velocity) * 0.2);
  });

  it('右旋回で yaw が減る', () => {
    const s = step(rest(), { ...idle, turn: 1 }, PHYSICS, 1 / 60);
    expect(s.yaw).toBeLessThan(0);
  });

  it('上昇・下降ができる', () => {
    expect(run(rest(), { ...idle, lift: 1 }, 1).position.y).toBeGreaterThan(15);
    expect(run(rest(), { ...idle, lift: -1 }, 1).position.y).toBeLessThan(5);
  });

  it('入力の state を書き換えない', () => {
    const s = rest();
    step(s, { throttle: 1, turn: 1, lift: 1 }, PHYSICS, 1 / 60);
    expect(s).toEqual(rest());
  });
});
