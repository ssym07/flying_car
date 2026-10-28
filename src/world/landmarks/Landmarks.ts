import * as THREE from 'three';
import { TERRAIN } from '../../core/config';
import type { ChunkListener, Terrain } from '../Terrain';
import { buildTokyoStation, createBrickMaterial } from './tokyoStation';

/**
 * 作り込んだ建物（ランドマーク）。PLATEAU の単純な箱の代わりに、写真を参考に手続き的に作った形を置く。
 * 元の PLATEAU の建物は scripts/build-station-cutouts.mjs の REPLACED_BY_LANDMARK で消す（建物の ID で指定）。
 * 置く場所の地形チャンクが読まれたら作り、捨てられたら捨てる。
 */
interface Landmark {
  /** 置き換える PLATEAU の建物の ID（scripts/build-station-cutouts.mjs と同じ） */
  gmlId: string;
  /** 長い向きの両端（緯度経度, 度）：from が建物の座標の x = 0、to が x = 全長 */
  from: [number, number];
  to: [number, number];
  /** 正面の向き：from から to へ向かって左なら 1、右なら -1（形は長い向きに左右対称にする） */
  front: 1 | -1;
  build: (length: number) => THREE.Group;
}

const LANDMARKS: Landmark[] = [
  {
    // 東京駅丸の内駅舎（南の端 → 北の端。正面は西の丸の内側）
    gmlId: 'bldg_6af58cef-669e-4aca-bc01-355e870d1ad5',
    from: [35.67977, 139.765822],
    to: [35.682603, 139.766392],
    front: 1,
    build: (length) => {
      const parts = buildTokyoStation(length);
      const group = new THREE.Group();
      group.add(new THREE.Mesh(parts.brick, materials().brick));
      group.add(new THREE.Mesh(parts.roof, materials().roof));
      group.add(new THREE.Mesh(parts.trim, materials().trim));
      group.add(new THREE.Mesh(parts.canopy, materials().canopy));
      return group;
    },
  },
];

let shared: Record<'brick' | 'roof' | 'trim' | 'canopy', THREE.Material> | null = null;
function materials() {
  shared ??= {
    brick: createBrickMaterial(),
    roof: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ color: 0xd4cdbe, roughness: 0.8, side: THREE.DoubleSide }),
    canopy: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }),
  };
  return shared;
}

export class Landmarks implements ChunkListener {
  readonly group = new THREE.Group();
  private readonly built = new Map<Landmark, { chunk: string; object: THREE.Group }>();

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
  }

  onChunkAdded(x: number, y: number): void {
    for (const lm of LANDMARKS) {
      if (this.built.has(lm) || chunkOf(lm) !== `${x}/${y}`) continue;
      const object = this.place(lm);
      if (!object) continue;
      this.built.set(lm, { chunk: `${x}/${y}`, object });
      this.group.add(object);
    }
  }

  onChunkRemoved(x: number, y: number): void {
    for (const [lm, { chunk, object }] of this.built) {
      if (chunk !== `${x}/${y}`) continue;
      this.group.remove(object);
      object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.built.delete(lm);
    }
  }

  /** 建物の座標（x = 長い向き、y = 上、z = 正面）からローカル座標へ置く。地面は両端と中央の地形の低い所 */
  private place(lm: Landmark): THREE.Group | null {
    const mid: [number, number] = [(lm.from[0] + lm.to[0]) / 2, (lm.from[1] + lm.to[1]) / 2];
    const grounds = [lm.from, mid, lm.to].map(([la, lo]) => this.terrain.surfaceHeightAt(la, lo));
    if (grounds.some((g) => g === null)) return null;
    const ground = Math.min(...(grounds as number[]));
    const a = this.terrain.toLocal(lm.from[0], lm.from[1], ground);
    const b = this.terrain.toLocal(lm.to[0], lm.to[1], ground);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const xAxis = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    // 右手系のまま正面（z）を向けるため、正面が from→to の左なら x を to→from にする（形は長い向きに左右対称）
    const flip = lm.front === 1;
    const x = flip ? xAxis.clone().negate() : xAxis;
    const zAxis = new THREE.Vector3().crossVectors(x, up);
    const origin = flip ? b : a;
    const object = lm.build(length);
    object.matrixAutoUpdate = false;
    object.matrix.makeBasis(x, up, zAxis).setPosition(origin.x, origin.y, origin.z);
    object.matrixWorldNeedsUpdate = true;
    return object;
  }
}

function chunkOf(lm: Landmark): string {
  const lat = (lm.from[0] + lm.to[0]) / 2;
  const lon = (lm.from[1] + lm.to[1]) / 2;
  const n = 2 ** TERRAIN.demZoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return `${x}/${y}`;
}

/** 置き換える PLATEAU の建物の ID（scripts/build-station-cutouts.mjs に同じものを書く） */
export const REPLACED_GML_IDS = LANDMARKS.map((lm) => lm.gmlId);
