import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createBodyGeometry } from './Trains';

describe('createBodyGeometry', () => {
  it('どの三角形も外を向いている（裏返った面が無い）', () => {
    const g = createBodyGeometry();
    const pos = g.getAttribute('position');
    const idx = g.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const center = new THREE.Vector3();
    let inward = 0;
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      center.copy(a).add(b).add(c).divideScalar(3).sub(new THREE.Vector3(0, 0.5, 0));
      if (n.dot(center) <= 0) inward++;
    }
    expect(inward).toBe(0);
  });
});
