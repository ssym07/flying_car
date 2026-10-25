import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { WORLD } from '../core/config';

/** 3d-tiles-renderer の OBJECT_FRAME（実装にはあるが型定義から export されていない） */
const OBJECT_FRAME = 2;

/**
 * ECEF → ローカル座標（開始地点が原点、y が上）の変換行列。
 * ReorientationPlugin が tiles.group に設定するものと同じなので、タイルの読込を待たずに使える
 */
export function computeEcefToLocal(): THREE.Matrix4 {
  const { latDeg, lonDeg, ellipsoidHeight } = WORLD.origin;
  const frame = new THREE.Matrix4();
  WGS84_ELLIPSOID.getObjectFrame(
    latDeg * THREE.MathUtils.DEG2RAD,
    lonDeg * THREE.MathUtils.DEG2RAD,
    ellipsoidHeight,
    0,
    0,
    0,
    frame,
    OBJECT_FRAME as Parameters<typeof WGS84_ELLIPSOID.getObjectFrame>[7],
  );
  return frame.invert();
}
