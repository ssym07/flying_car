import * as THREE from 'three';
import { TERRAIN } from '../../core/config';
import type { ChunkListener, Terrain } from '../Terrain';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildMarunouchiPlaza, createStoneMaterial, type PlazaParts } from './marunouchiPlaza';
import { buildTokyoStation, createBrickMaterial } from './tokyoStation';
import {
  type AzabudaiParts,
  buildAzabudaiResidences,
  buildMoriJpTower,
  createGlassMaterial,
  createLightGlassMaterial,
  createResidenceAMaterial,
  createResidenceMaterial,
} from './azabudaiHills';
import { type RoppongiParts, buildRoppongiMoriTower, createRoppongiGlassMaterial } from './roppongiHills';
import {
  type ScrambleParts,
  buildScrambleSquare,
  createLouverMaterial,
  createScrambleGlassMaterial,
} from './shibuyaScrambleSquare';
import { buildSkytree } from './tokyoSkytree';
import {
  type ToranomonParts,
  buildToranomonBusiness,
  buildToranomonMori,
  buildToranomonResidential,
  buildToranomonStation,
  createBlueGlassMaterial,
  createDarkFacadeMaterial,
  createMoriGlassMaterial,
  createStationGlassMaterial,
} from './toranomonHills';
import { buildTokyoTower } from './tokyoTower';

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

/**
 * 中心 (lat, lon) を通る長い向き（東から北へ deg 度）の両端（±25m）。建物の座標の x がこの向き、中心が x = 25
 */
function around(lat: number, lon: number, deg: number): { from: [number, number]; to: [number, number] } {
  const a = (deg * Math.PI) / 180;
  const dLat = (Math.sin(a) * 25) / 111320;
  const dLon = (Math.cos(a) * 25) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { from: [lat - dLat, lon - dLon], to: [lat + dLat, lon + dLon] };
}

/** 虎ノ門ヒルズの街区の向き（長い向きは北北西） */
const TORANOMON_DEG = 109;

const LANDMARKS: Landmark[] = [
  {
    // 渋谷スクランブルスクエア（PLATEAU の箱を消して置く）。正面（えぐれのある面）は駅側
    gmlId: 'bldg_7b006717-e9e6-4a94-8843-1f4ce13b2509',
    ...around(35.658385, 139.702242, 70),
    front: 1,
    build: (length) => {
      scrambleShared ??= {
        glass: createScrambleGlassMaterial(),
        louver: createLouverMaterial(),
        inner: new THREE.MeshStandardMaterial({ color: 0x9fb4c0, roughness: 0.25, metalness: 0.4, side: THREE.DoubleSide }),
        white: new THREE.MeshStandardMaterial({ color: 0xdfe3e6, roughness: 0.5 }),
        deck: new THREE.MeshStandardMaterial({ color: 0xb48e66, roughness: 0.85 }),
        grass: new THREE.MeshStandardMaterial({ color: 0x74a84f, roughness: 0.95 }),
        fence: new THREE.MeshStandardMaterial({
          color: 0xcfe2ea,
          roughness: 0.1,
          metalness: 0.2,
          transparent: true,
          opacity: 0.45,
        }),
      };
      const parts = buildScrambleSquare(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof ScrambleParts>) {
        group.add(new THREE.Mesh(parts[key], scrambleShared[key]));
      }
      return group;
    },
  },
  {
    // 六本木ヒルズ森タワー（PLATEAU には塔が無く、足元の複合施設だけがあるので、何も消さずに塔を置く）
    gmlId: '',
    ...around(35.66046, 139.7293, 80),
    front: -1,
    build: (length) => {
      roppongiShared ??= {
        glass: createRoppongiGlassMaterial(),
        white: new THREE.MeshStandardMaterial({ color: 0xe4e7ea, roughness: 0.5 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x6a6e73, roughness: 0.6 }),
      };
      const parts = buildRoppongiMoriTower(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof RoppongiParts>) {
        group.add(new THREE.Mesh(parts[key], roppongiShared[key]));
      }
      return group;
    },
  },
  {
    // 虎ノ門ヒルズ森タワー（PLATEAU には塔が無く、広場の平らな板だけなので、それを消して置く）
    gmlId: 'bldg_96c9d242-0fc6-4364-aeae-c21102718c35',
    ...around(35.6669, 139.74935, TORANOMON_DEG),
    front: -1,
    build: (length) => toranomonGroup(buildToranomonMori(length / 2)),
  },
  {
    // 虎ノ門ヒルズ ビジネスタワー
    gmlId: 'bldg_b292bc75-5708-4a3b-a7ba-7166c829d25a',
    ...around(35.66775, 139.75002, TORANOMON_DEG),
    front: -1,
    build: (length) => toranomonGroup(buildToranomonBusiness(length / 2)),
  },
  {
    // 虎ノ門ヒルズ レジデンシャルタワー
    gmlId: 'bldg_70d240ff-cce9-408b-99c4-51c90077e09f',
    ...around(35.66604, 139.7485, TORANOMON_DEG),
    front: -1,
    build: (length) => toranomonGroup(buildToranomonResidential(length / 2)),
  },
  {
    // 虎ノ門ヒルズ ステーションタワー（PLATEAU には建設中の平らな板しか無い）
    gmlId: 'bldg_fbf728df-a130-4f36-88e4-7267715cbf34',
    ...around(35.66754, 139.74691, TORANOMON_DEG),
    front: -1,
    build: (length) => toranomonGroup(buildToranomonStation(length / 2)),
  },
  {
    // 麻布台ヒルズ森JPタワー（PLATEAU の建設中の高さの箱を消して置く）。箱の長い向きの両端で置く
    gmlId: 'bldg_433bc5b3-db73-4644-ac24-a28d51b7ecd5',
    from: [35.660641, 139.739771],
    to: [35.661265, 139.741083],
    front: -1,
    build: (length) => azabudaiGroup(buildMoriJpTower(length / 2)),
  },
  {
    // 麻布台ヒルズ レジデンスA・B（PLATEAU には建設中の高さの平らな板しか無いので、それを消して置く）
    gmlId: 'bldg_af7335da-7542-44dd-964d-8cccd2b046ff',
    from: [35.662195, 139.740951],
    to: [35.662593, 139.739796],
    front: -1,
    build: (length) => azabudaiGroup(buildAzabudaiResidences(length / 2)),
  },
  {
    // 東京スカイツリーとスカイツリータウン（PLATEAU にはソラマチの平らな箱しか無いので、それを消して置く）。
    // タウンの長い向き（東西）にそろえ、塔の中心から ±50m の2点で置く。イーストタワーの箱は別に消す
    gmlId: 'bldg_58ab8c46-8369-49c4-86cf-6912bbc4efe1',
    from: [35.710041, 139.810148],
    to: [35.710085, 139.811252],
    front: -1,
    build: (length) => {
      const parts = buildSkytree(length / 2);
      const m = skytreeMaterials();
      const group = new THREE.Group();
      group.add(new THREE.Mesh(parts.steel, m.steel));
      group.add(new THREE.Mesh(parts.glass, m.glass));
      group.add(new THREE.Mesh(parts.white, m.white));
      group.add(new THREE.Mesh(parts.podium, m.podium));
      group.add(new THREE.Mesh(parts.green, m.green));
      return group;
    },
  },
  {
    // 東京タワー（PLATEAU には足元の建物（フットタウン）の箱しか無いので、それを消して塔と足元の建物を置く）。
    // 長い向きは足元の建物にそろえ、中心から ±50m の2点で置く
    gmlId: 'bldg_7aff4a51-be8b-405b-abe4-ac489697cbc8',
    from: [35.65833, 139.745891],
    to: [35.658832, 139.744975],
    front: -1,
    build: (length) => {
      const parts = buildTokyoTower(length / 2);
      const group = new THREE.Group();
      group.add(new THREE.Mesh(parts.steel, towerMaterials().steel));
      group.add(new THREE.Mesh(parts.glass, towerMaterials().glass));
      group.add(new THREE.Mesh(parts.deck, towerMaterials().deck));
      group.add(new THREE.Mesh(parts.base, towerMaterials().base));
      return group;
    },
  },
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
      // 丸の内駅前広場
      const plaza = buildMarunouchiPlaza(length);
      for (const [name, list] of Object.entries(plaza) as Array<[keyof PlazaParts, THREE.BufferGeometry[]]>) {
        if (list.length === 0) continue;
        const merged = mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)).map(keepPositionUv));
        for (const g of list) g.dispose();
        if (!merged) continue;
        merged.computeVertexNormals();
        group.add(new THREE.Mesh(merged, plazaMaterials()[name]));
      }
      return group;
    },
  },
];

/** 位置と uv だけにそろえる（まとめるため） */
function keepPositionUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'uv') g.deleteAttribute(name);
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

let scrambleShared: Record<keyof ScrambleParts, THREE.Material> | null = null;

let roppongiShared: Record<keyof RoppongiParts, THREE.Material> | null = null;

let toranomonShared: Record<keyof ToranomonParts, THREE.Material> | null = null;
function toranomonGroup(parts: ToranomonParts): THREE.Group {
  toranomonShared ??= {
    mori: createMoriGlassMaterial(),
    glass: createBlueGlassMaterial(),
    dark: createDarkFacadeMaterial(),
    station: createStationGlassMaterial(),
    accent: new THREE.MeshStandardMaterial({ color: 0x7fb3a0, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.9 }),
    white: new THREE.MeshStandardMaterial({ color: 0xe3e6e9, roughness: 0.5 }),
    podium: new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.8 }),
    green: new THREE.MeshStandardMaterial({ color: 0x6c9a4c, roughness: 0.9 }),
  };
  const group = new THREE.Group();
  for (const key of Object.keys(parts) as Array<keyof ToranomonParts>) {
    if (parts[key].getAttribute('position').count > 0) group.add(new THREE.Mesh(parts[key], toranomonShared[key]));
  }
  return group;
}

let azabudaiShared: Record<keyof AzabudaiParts, THREE.Material> | null = null;
function azabudaiGroup(parts: AzabudaiParts): THREE.Group {
  azabudaiShared ??= {
    glass: createGlassMaterial(),
    residence: createResidenceMaterial(),
    residenceA: createResidenceAMaterial(),
    lightGlass: createLightGlassMaterial(),
    white: new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.5 }),
    podium: new THREE.MeshStandardMaterial({ color: 0xa79c8b, roughness: 0.8 }),
    green: new THREE.MeshStandardMaterial({ color: 0x6c9a4c, roughness: 0.9 }),
  };
  const group = new THREE.Group();
  for (const key of Object.keys(parts) as Array<keyof AzabudaiParts>) {
    if (parts[key].getAttribute('position').count > 0) group.add(new THREE.Mesh(parts[key], azabudaiShared[key]));
  }
  return group;
}

let skytreeShared: Record<'steel' | 'glass' | 'white' | 'podium' | 'green', THREE.Material> | null = null;
function skytreeMaterials() {
  skytreeShared ??= {
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x7fa3bf, roughness: 0.12, metalness: 0.6, side: THREE.DoubleSide }),
    white: new THREE.MeshStandardMaterial({ color: 0xe7eaec, roughness: 0.6 }),
    podium: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.7 }),
    green: new THREE.MeshStandardMaterial({ color: 0x6c9a4c, roughness: 0.9 }),
  };
  return skytreeShared;
}

let towerShared: Record<'steel' | 'glass' | 'deck' | 'base', THREE.Material> | null = null;
function towerMaterials() {
  towerShared ??= {
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x8fb6cf, roughness: 0.15, metalness: 0.5, side: THREE.DoubleSide }),
    deck: new THREE.MeshStandardMaterial({ color: 0xe9ecee, roughness: 0.6 }),
    base: new THREE.MeshStandardMaterial({ color: 0x5a5d62, roughness: 0.8 }),
  };
  return towerShared;
}

let plazaShared: Record<keyof PlazaParts, THREE.Material> | null = null;
function plazaMaterials() {
  const flat = (color: number, roughness = 0.9) => new THREE.MeshStandardMaterial({ color, roughness });
  plazaShared ??= {
    stone: createStoneMaterial(),
    lawn: flat(0x6f9e4c),
    asphalt: flat(0x45474c),
    curb: flat(0xc4c2bc),
    marking: flat(0xeeeeea, 0.7),
    glass: new THREE.MeshStandardMaterial({ color: 0xa9bcc8, roughness: 0.2, metalness: 0.3 }),
    trunk: flat(0x6b4b36),
    leaves: flat(0x55893f),
    pine: flat(0x2f5a34),
  };
  return plazaShared;
}

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
export const REPLACED_GML_IDS = LANDMARKS.map((lm) => lm.gmlId).filter((id) => id !== '');
