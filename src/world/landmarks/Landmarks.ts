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
import {
  type HikarieParts,
  buildHikarie,
  createHikarieGlassMaterial,
  createHikarieTowerMaterial,
} from './shibuyaHikarie';
import {
  type SakuraParts,
  buildSakuraStage,
  createSakuraGlassMaterial,
  createSakuraPinkMaterial,
  createSakuraResidenceMaterial,
} from './shibuyaSakuraStage';
import { type AxshParts, buildShibuyaAxsh, createAxshLowerMaterial, createAxshUpperMaterial } from './shibuyaAxsh';
import { type CeruleanParts, buildCeruleanTower, createCeruleanStoneMaterial } from './ceruleanTower';
import { type MetroGovParts, buildMetroGov, createMetroGovStoneMaterial } from './tokyoMetroGov';
import {
  type DocomoParts,
  buildDocomoYoyogi,
  createDocomoShaftMaterial,
  createDocomoTierMaterial,
} from './docomoYoyogi';
import { type DomeParts, buildTokyoDome, createDomeGlassMaterial, createDomeMembraneMaterial } from './tokyoDome';
import {
  type ForumParts,
  buildInternationalForum,
  createForumGlassMaterial,
  createForumHallMaterial,
  createForumRoofMaterial,
  createForumWallMaterial,
} from './internationalForum';
import {
  type MidtownYaesuParts,
  buildMidtownYaesu,
  createYaesuGlassMaterial,
  createYaesuLouverMaterial,
  createYaesuPodiumMaterial,
} from './midtownYaesu';
import {
  type IchigokanParts,
  type ParkBuildingParts,
  buildIchigokan,
  buildParkBuilding,
  createBrickWallMaterial,
  createParkGlassMaterial,
  createParkPodiumMaterial,
  createParkStoneMaterial,
} from './brickSquare';
import {
  type EirakuParts,
  buildEiraku,
  createEirakuGlassMaterial,
  createEirakuGridMaterial,
  createEirakuPodiumMaterial,
} from './eirakuBuilding';
import {
  type TokiaParts,
  buildTokyoBuilding,
  createTokiaFinMaterial,
  createTokiaGlassMaterial,
  createTokiaPodiumMaterial,
  createTokiaStoneMaterial,
} from './tokyoBuilding';
import {
  type JpTowerParts,
  buildJpTower,
  createJpBandMaterial,
  createJpGlassMaterial,
  createPostOfficeMaterial,
} from './jpTower';
import {
  type MarunouchiParts,
  buildMaruBuilding,
  buildShinMarunouchi,
  createMaruPodiumMaterial,
  createMaruTowerMaterial,
  createMarunouchiGlassMaterial,
  createShinMaruPodiumMaterial,
  createShinMaruTowerMaterial,
} from './marunouchiTowers';
import { type BudokanParts, buildBudokan, createBudokanLouverMaterial } from './budokan';
import {
  type StadiumParts,
  buildNationalStadium,
  createStadiumSeatMaterial,
  createStadiumWoodMaterial,
} from './nationalStadium';
import { type CastleParts, buildCinderellaCastle } from './cinderellaCastle';
import { type SompoParts, buildSompoJapan, createSompoCoreMaterial, createSompoFinMaterial } from './sompoJapan';
import { type CocoonParts, buildCocoonTower, createCocoonGlassMaterial } from './cocoonTower';
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
    // 東京国際フォーラム（ガラス棟とホール棟の PLATEAU の箱を消して置く）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_861e9fa3-3ab6-443b-a1b0-6457f4d2e6dd',
    ...around(35.6766, 139.7643, 0),
    front: -1,
    build: (length) => {
      const double = (m: THREE.MeshStandardMaterial) => ((m.side = THREE.DoubleSide), m);
      forumShared ??= {
        glass: createForumGlassMaterial(),
        roofGlass: createForumRoofMaterial(),
        wall: createForumWallMaterial(),
        terrace: double(new THREE.MeshStandardMaterial({ color: 0xb4b14e, roughness: 0.9 })),
        hall: createForumHallMaterial(),
        white: double(new THREE.MeshStandardMaterial({ color: 0xe8eaeb, roughness: 0.5 })),
        roof: double(new THREE.MeshStandardMaterial({ color: 0x5e6266, roughness: 0.8 })),
      };
      const parts = buildInternationalForum(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof ForumParts>)
        group.add(new THREE.Mesh(parts[key], forumShared[key]));
      return group;
    },
  },
  {
    // 東京ミッドタウン八重洲（PLATEAU の工事中の箱を消して置く。取り壊された古いビルの箱も build-station-cutouts で消す）
    gmlId: 'bldg_25d370de-2c35-457b-b756-3444a3d02eb3',
    ...around(35.679417, 139.769533, 65),
    front: -1,
    build: (length) => {
      yaesuShared ??= {
        louver: createYaesuLouverMaterial(),
        glass: createYaesuGlassMaterial(),
        podium: createYaesuPodiumMaterial(),
        dark: new THREE.MeshStandardMaterial({ color: 0x2f3a45, roughness: 0.4, metalness: 0.3 }),
        frame: new THREE.MeshStandardMaterial({
          color: 0xc9d0d6,
          roughness: 0.4,
          metalness: 0.4,
          side: THREE.DoubleSide,
        }),
        green: new THREE.MeshStandardMaterial({ color: 0x5a8a40, roughness: 0.9, side: THREE.DoubleSide }),
        roof: new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.8, side: THREE.DoubleSide }),
      };
      const parts = buildMidtownYaesu(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof MidtownYaesuParts>) {
        group.add(new THREE.Mesh(parts[key], yaesuShared[key]));
      }
      return group;
    },
  },
  {
    // 丸の内パークビルディング（PLATEAU の箱を消して置く）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_66be0e64-a0f8-4974-9b90-cd0da900205d',
    ...around(35.67901, 139.76311, 0),
    front: -1,
    build: (length) => {
      parkShared ??= {
        stone: createParkStoneMaterial(),
        glass: createParkGlassMaterial(),
        crown: new THREE.MeshStandardMaterial({
          color: 0xc9ced3,
          roughness: 0.3,
          metalness: 0.6,
          side: THREE.DoubleSide,
        }),
        podium: createParkPodiumMaterial(),
        green: new THREE.MeshStandardMaterial({ color: 0x55843d, roughness: 0.9, side: THREE.DoubleSide }),
        roof: new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.8, side: THREE.DoubleSide }),
      };
      const parts = buildParkBuilding(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof ParkBuildingParts>) {
        group.add(new THREE.Mesh(parts[key], parkShared[key]));
      }
      return group;
    },
  },
  {
    // 三菱一号館（PLATEAU の箱を消して置く）。x = 北北東、z = 通りの側（東南東）
    gmlId: 'bldg_eca59423-ac27-46b4-8ccf-451b63652d52',
    ...around(35.67847, 139.76318, 75),
    front: -1,
    build: (length) => {
      ichigokanShared ??= {
        brick: createBrickWallMaterial(),
        trim: new THREE.MeshStandardMaterial({ color: 0xe9e3d5, roughness: 0.7 }),
        slate: new THREE.MeshStandardMaterial({ color: 0x4f5760, roughness: 0.7, side: THREE.DoubleSide }),
        base: new THREE.MeshStandardMaterial({ color: 0x8d8d88, roughness: 0.85 }),
      };
      const parts = buildIchigokan(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof IchigokanParts>) {
        group.add(new THREE.Mesh(parts[key], ichigokanShared[key]));
      }
      return group;
    },
  },
  {
    // 丸の内永楽ビルディング（PLATEAU の低い箱を消して置く）。x = 北北東、z = 東京駅の側
    gmlId: 'bldg_32ba8db3-4a5a-4eab-9b6a-a095bcdd165b',
    ...around(35.68433, 139.7649, 75),
    front: -1,
    build: (length) => {
      eirakuShared ??= {
        podium: createEirakuPodiumMaterial(),
        glass: createEirakuGlassMaterial(),
        grid: createEirakuGridMaterial(),
        stone: new THREE.MeshStandardMaterial({ color: 0xd0c3a8, roughness: 0.75 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x2c3034, roughness: 0.5, metalness: 0.2 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.8 }),
      };
      const parts = buildEiraku(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof EirakuParts>)
        group.add(new THREE.Mesh(parts[key], eirakuShared[key]));
      return group;
    },
  },
  {
    // 東京ビル TOKIA（PLATEAU の低い箱を消して置く）。x = 線路に沿って北北東、z = 線路の側
    gmlId: 'bldg_5d5dd52d-bfdd-4bb6-9cbf-f865fb6946fb',
    ...around(35.67856, 139.76494, 73),
    front: -1,
    build: (length) => {
      tokiaShared ??= {
        glass: createTokiaGlassMaterial(),
        fins: createTokiaFinMaterial(),
        stone: createTokiaStoneMaterial(),
        podium: createTokiaPodiumMaterial(),
        dark: new THREE.MeshStandardMaterial({
          color: 0x2f363d,
          roughness: 0.4,
          metalness: 0.3,
          side: THREE.DoubleSide,
        }),
        white: new THREE.MeshStandardMaterial({ color: 0xe4e4e0, roughness: 0.6, side: THREE.DoubleSide }),
        green: new THREE.MeshStandardMaterial({ color: 0x55843d, roughness: 0.9 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.8 }),
      };
      const parts = buildTokyoBuilding(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof TokiaParts>)
        group.add(new THREE.Mesh(parts[key], tokiaShared[key]));
      return group;
    },
  },
  {
    // JPタワーと旧東京中央郵便局（KITTE）（PLATEAU の箱を消して置く）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_f0028aa3-e666-4608-8b70-4e981a45d6b5',
    ...around(35.67979, 139.76483, 0),
    front: -1,
    build: (length) => {
      jpShared ??= {
        podium: createPostOfficeMaterial(),
        glass: createJpGlassMaterial(),
        band: createJpBandMaterial(),
        frame: new THREE.MeshStandardMaterial({
          color: 0x6d7378,
          roughness: 0.5,
          metalness: 0.4,
          side: THREE.DoubleSide,
        }),
        roof: new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.8 }),
        green: new THREE.MeshStandardMaterial({ color: 0x5a8a40, roughness: 0.9 }),
        clock: new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.6, side: THREE.DoubleSide }),
      };
      const parts = buildJpTower(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof JpTowerParts>)
        group.add(new THREE.Mesh(parts[key], jpShared[key]));
      return group;
    },
  },
  {
    // 丸ビル（PLATEAU の低い箱を消して置く）。x = 北北東、z = 東京駅の側
    gmlId: 'bldg_a98349a1-56c0-4ec4-b22c-abe49301bd04',
    ...around(35.68106, 139.76381, 75),
    front: -1,
    build: (length) => {
      maruShared ??= {
        podium: createMaruPodiumMaterial(),
        tower: createMaruTowerMaterial(),
        glass: createMarunouchiGlassMaterial('#8ea7bb'),
        dark: new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.4, metalness: 0.3 }),
        trim: new THREE.MeshStandardMaterial({ color: 0xd3c6ad, roughness: 0.75 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.8 }),
        green: new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.9 }),
      };
      return marunouchiGroup(buildMaruBuilding(length / 2), maruShared);
    },
  },
  {
    // 新丸ビル（PLATEAU の低い箱を消して置く）
    gmlId: 'bldg_104b6adf-6a30-41d4-9bdc-dc866513368e',
    ...around(35.6826, 139.7643, 75),
    front: -1,
    build: (length) => {
      shinMaruShared ??= {
        podium: createShinMaruPodiumMaterial(),
        tower: createShinMaruTowerMaterial(),
        glass: createMarunouchiGlassMaterial('#a3bccf'),
        dark: new THREE.MeshStandardMaterial({ color: 0x2e353c, roughness: 0.35, metalness: 0.3 }),
        trim: new THREE.MeshStandardMaterial({ color: 0x5a5753, roughness: 0.6 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x7a7c7e, roughness: 0.8 }),
        green: new THREE.MeshStandardMaterial({ color: 0x4a7536, roughness: 0.9 }),
      };
      return marunouchiGroup(buildShinMarunouchi(length / 2), shinMaruShared);
    },
  },
  {
    // 東京ドーム（PLATEAU の箱を消して置く。ドームシティは作らない）。x・z = 角の丸い四角の辺の向き
    gmlId: 'bldg_369e50ad-eaf1-4484-9d31-9802cc32ab5a',
    ...around(35.70559, 139.7519, 84),
    front: 1,
    build: (length) => {
      domeShared ??= {
        glass: createDomeGlassMaterial(),
        concrete: new THREE.MeshStandardMaterial({ color: 0xbdbab3, roughness: 0.85, side: THREE.DoubleSide }),
        rim: new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.5, side: THREE.DoubleSide }),
        membrane: createDomeMembraneMaterial(),
      };
      const parts = buildTokyoDome(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof DomeParts>) {
        group.add(new THREE.Mesh(parts[key], domeShared[key]));
      }
      return group;
    },
  },
  {
    // 日本武道館（PLATEAU の低い箱を消して置く）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_d4c6fe12-0eeb-4395-aecf-93c9b5a5c6ee',
    ...around(35.69336, 139.74987, 0),
    front: -1,
    build: (length) => {
      const flat = (color: number, roughness = 0.7, extra: THREE.MeshStandardMaterialParameters = {}) =>
        new THREE.MeshStandardMaterial({ color, roughness, side: THREE.DoubleSide, ...extra });
      budokanShared ??= {
        concrete: flat(0xb3ada2, 0.85),
        louver: createBudokanLouverMaterial(),
        glass: flat(0x3c4b57, 0.2, { metalness: 0.4 }),
        eave: flat(0xb8893a, 0.45, { metalness: 0.5 }),
        roof: flat(0x8fb7a2, 0.6, { metalness: 0.1 }),
        ridge: flat(0x5e7f70, 0.6),
        gold: flat(0xe2b64a, 0.3, { metalness: 0.85 }),
      };
      const parts = buildBudokan(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof BudokanParts>) {
        group.add(new THREE.Mesh(parts[key], budokanShared[key]));
      }
      return group;
    },
  },
  {
    // 国立競技場（PLATEAU の楕円の箱を消して置く）。x = 楕円の長い向き（北北東）
    gmlId: 'bldg_d840231c-8174-4086-9ca6-6417886b0fda',
    ...around(35.677837, 139.714508, 68),
    front: 1,
    build: (length) => {
      const flat = (color: number, roughness = 0.7, extra: THREE.MeshStandardMaterialParameters = {}) =>
        new THREE.MeshStandardMaterial({ color, roughness, side: THREE.DoubleSide, ...extra });
      stadiumShared ??= {
        wood: createStadiumWoodMaterial(),
        roof: flat(0xeceef0, 0.5),
        roofGlass: flat(0x8fb6d6, 0.15, { metalness: 0.4 }),
        white: flat(0xf3f3f1, 0.5),
        glass: flat(0x3f4c58, 0.2, { metalness: 0.4 }),
        green: flat(0x4f7d3a, 0.9),
        seats: createStadiumSeatMaterial(),
        track: flat(0x8a5546, 0.9),
        field: flat(0x4a8a42, 0.95),
      };
      const parts = buildNationalStadium(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof StadiumParts>) {
        group.add(new THREE.Mesh(parts[key], stadiumShared[key]));
      }
      return group;
    },
  },
  {
    // シンデレラ城（浦安市は国土地理院の建物の形から作っていて、城の場所の建物は作らない）。建物の座標は x = 東、z = 南
    gmlId: '',
    ...around(35.63208, 139.88084, 0),
    front: -1,
    build: (length) => {
      castleShared ??= {
        base: new THREE.MeshStandardMaterial({ color: 0xb9b0a0, roughness: 0.9 }),
        wall: new THREE.MeshStandardMaterial({ color: 0xece5d8, roughness: 0.7 }),
        roof: new THREE.MeshStandardMaterial({ color: 0x2f62b5, roughness: 0.45, metalness: 0.15 }),
        gold: new THREE.MeshStandardMaterial({ color: 0xe0b44a, roughness: 0.3, metalness: 0.8 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x343846, roughness: 0.8, side: THREE.DoubleSide }),
      };
      const parts = buildCinderellaCastle(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof CastleParts>) {
        group.add(new THREE.Mesh(parts[key], castleShared[key]));
      }
      return group;
    },
  },
  {
    // 損保ジャパン本社ビル（PLATEAU の箱を消して置く）。長い向きは北北東
    gmlId: 'bldg_81cf4164-d885-4134-81f8-5356472517ee',
    ...around(35.69269, 139.69612, 70),
    front: 1,
    build: (length) => {
      sompoShared ??= {
        fin: createSompoFinMaterial(),
        core: createSompoCoreMaterial(),
        dark: new THREE.MeshStandardMaterial({ color: 0x3b3331, roughness: 0.6, side: THREE.DoubleSide }),
        glass: new THREE.MeshStandardMaterial({ color: 0x5f7684, roughness: 0.2, metalness: 0.4 }),
      };
      const parts = buildSompoJapan(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof SompoParts>) {
        group.add(new THREE.Mesh(parts[key], sompoShared[key]));
      }
      return group;
    },
  },
  {
    // モード学園コクーンタワー（PLATEAU の、東の広場まで含んだ箱を消して置く）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_4e9cedb2-e1b8-48f6-9c04-b862aca365f1',
    ...around(35.69159, 139.69694, 0),
    front: -1,
    build: (length) => {
      cocoonShared ??= {
        glass: createCocoonGlassMaterial(),
        lattice: new THREE.MeshStandardMaterial({ color: 0xf1f1ee, roughness: 0.45, side: THREE.DoubleSide }),
        dark: new THREE.MeshStandardMaterial({ color: 0x5a5e63, roughness: 0.6 }),
      };
      const parts = buildCocoonTower(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof CocoonParts>) {
        group.add(new THREE.Mesh(parts[key], cocoonShared[key]));
      }
      return group;
    },
  },
  {
    // NTTドコモ代々木ビル（PLATEAU の箱を消して置く）
    gmlId: 'bldg_52945d0d-a897-4d55-b35c-a8bcca773e53',
    ...around(35.6844, 139.70312, 100),
    front: -1,
    build: (length) => {
      docomoShared ??= {
        shaft: createDocomoShaftMaterial(),
        tier: createDocomoTierMaterial(),
        glass: new THREE.MeshStandardMaterial({ color: 0x7fb4cc, roughness: 0.15, metalness: 0.4 }),
        fin: new THREE.MeshStandardMaterial({ color: 0x7a6a62, roughness: 0.5, metalness: 0.3 }),
        clock: new THREE.MeshStandardMaterial({ color: 0x5f524c, roughness: 0.5, side: THREE.DoubleSide }),
        hands: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4 }),
        red: new THREE.MeshStandardMaterial({ color: 0xd8433a, roughness: 0.6 }),
        white: new THREE.MeshStandardMaterial({ color: 0xeeeeec, roughness: 0.5 }),
      };
      const parts = buildDocomoYoyogi(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof DocomoParts>) {
        group.add(new THREE.Mesh(parts[key], docomoShared[key]));
      }
      return group;
    },
  },
  {
    // 東京都庁舎（第一本庁舎・第二本庁舎・都議会議事堂と都民広場）。PLATEAU の2つの庁舎の箱を消して置く
    // （第二本庁舎の箱は別に消す）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_94caaf2f-dec2-41a7-8b0f-06ecd0fac6c7',
    ...around(35.6896, 139.6917, 0),
    front: -1,
    build: (length) => {
      metroGovShared ??= {
        stone: createMetroGovStoneMaterial(),
        dark: new THREE.MeshStandardMaterial({ color: 0x3e4349, roughness: 0.7 }),
        glass: new THREE.MeshStandardMaterial({ color: 0x8fa9b8, roughness: 0.2, metalness: 0.4 }),
        paving: new THREE.MeshStandardMaterial({ color: 0xa8a6a2, roughness: 0.85 }),
        antenna: new THREE.MeshStandardMaterial({ color: 0xd8433a, roughness: 0.6 }),
      };
      const parts = buildMetroGov(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof MetroGovParts>) {
        group.add(new THREE.Mesh(parts[key], metroGovShared[key]));
      }
      return group;
    },
  },
  {
    // セルリアンタワー（PLATEAU の塔の箱を消して置く。西の低層部の箱は別に消す）
    gmlId: 'bldg_9c42ff7c-c8bf-456a-ada2-4c416a2dc965',
    ...around(35.65643, 139.69958, 22),
    front: -1,
    build: (length) => {
      ceruleanShared ??= {
        stone: createCeruleanStoneMaterial(),
        glass: new THREE.MeshStandardMaterial({ color: 0x3e5f86, roughness: 0.15, metalness: 0.5 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.6 }),
        podium: new THREE.MeshStandardMaterial({ color: 0xb3a897, roughness: 0.8 }),
      };
      const parts = buildCeruleanTower(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof CeruleanParts>) {
        group.add(new THREE.Mesh(parts[key], ceruleanShared[key]));
      }
      return group;
    },
  },
  {
    // 渋谷アクシュ（PLATEAU の建設中の箱を消して置く）。建物の座標は x = 東、z = 南
    gmlId: 'bldg_07a23c05-99d6-439c-bd98-f0f873f8a470',
    ...around(35.6591, 139.7045, 0),
    front: -1,
    build: (length) => {
      axshShared ??= {
        upper: createAxshUpperMaterial(),
        lower: createAxshLowerMaterial(),
        white: new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.5 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.6 }),
        plant: new THREE.MeshStandardMaterial({ color: 0x5f9444, roughness: 0.95 }),
        leaves: new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.9 }),
        trunk: new THREE.MeshStandardMaterial({ color: 0x6b4b36, roughness: 0.9 }),
        wood: new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.8 }),
        paving: new THREE.MeshStandardMaterial({ color: 0xb9b4ab, roughness: 0.85 }),
        bridge: new THREE.MeshStandardMaterial({ color: 0x8a5a40, roughness: 0.8, side: THREE.DoubleSide }),
        bridgeRoof: new THREE.MeshStandardMaterial({ color: 0x4e3a2e, roughness: 0.7, side: THREE.DoubleSide }),
      };
      const parts = buildShibuyaAxsh(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof AxshParts>) {
        group.add(new THREE.Mesh(parts[key], axshShared[key]));
      }
      return group;
    },
  },
  {
    // 渋谷サクラステージ（PLATEAU には建設中の大きな箱しか無いので、それを消して4つの棟を置く）。
    // 長い向きは線路に沿って、駅の側（北西）から南東へ
    gmlId: 'bldg_9442d303-7a48-4f81-aa67-b6ef05dbd43b',
    ...around(35.656425, 139.702265, -41),
    front: -1,
    build: (length) => {
      sakuraShared ??= {
        glass: createSakuraGlassMaterial(),
        pink: createSakuraPinkMaterial(),
        green: new THREE.MeshStandardMaterial({
          color: 0x7fb8a8,
          roughness: 0.15,
          metalness: 0.4,
          side: THREE.DoubleSide,
        }),
        residence: createSakuraResidenceMaterial(),
        white: new THREE.MeshStandardMaterial({ color: 0xe2e5e7, roughness: 0.5 }),
        podium: new THREE.MeshStandardMaterial({ color: 0xcfc6b6, roughness: 0.8 }),
        plant: new THREE.MeshStandardMaterial({ color: 0x6c9a4c, roughness: 0.9 }),
      };
      const parts = buildSakuraStage(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof SakuraParts>) {
        if (parts[key].getAttribute('position').count > 0) group.add(new THREE.Mesh(parts[key], sakuraShared[key]));
      }
      return group;
    },
  },
  {
    // 渋谷ヒカリエ（PLATEAU の箱を消して置く）。長い向きは東西、正面は西（駅側）
    gmlId: 'bldg_9ad5b600-360f-4627-8a89-fca39aad5576',
    ...around(35.65925, 139.70366, 15),
    front: -1,
    build: (length) => {
      hikarieShared ??= {
        glass: createHikarieGlassMaterial(),
        tower: createHikarieTowerMaterial(),
        white: new THREE.MeshStandardMaterial({ color: 0xe2e5e7, roughness: 0.5 }),
        dark: new THREE.MeshStandardMaterial({ color: 0x3f454d, roughness: 0.6 }),
      };
      const parts = buildHikarie(length / 2);
      const group = new THREE.Group();
      for (const key of Object.keys(parts) as Array<keyof HikarieParts>) {
        group.add(new THREE.Mesh(parts[key], hikarieShared[key]));
      }
      return group;
    },
  },
  {
    // 渋谷スクランブルスクエア（PLATEAU の箱を消して置く）。正面（えぐれのある面）は駅側
    gmlId: 'bldg_7b006717-e9e6-4a94-8843-1f4ce13b2509',
    ...around(35.658385, 139.702242, 70),
    front: 1,
    build: (length) => {
      scrambleShared ??= {
        glass: createScrambleGlassMaterial(),
        louver: createLouverMaterial(),
        inner: new THREE.MeshStandardMaterial({
          color: 0x9fb4c0,
          roughness: 0.25,
          metalness: 0.4,
          side: THREE.DoubleSide,
        }),
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
  if (!g.getAttribute('uv'))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

let forumShared: Record<keyof ForumParts, THREE.Material> | null = null;
let yaesuShared: Record<keyof MidtownYaesuParts, THREE.Material> | null = null;
let parkShared: Record<keyof ParkBuildingParts, THREE.Material> | null = null;
let ichigokanShared: Record<keyof IchigokanParts, THREE.Material> | null = null;
let eirakuShared: Record<keyof EirakuParts, THREE.Material> | null = null;
let tokiaShared: Record<keyof TokiaParts, THREE.Material> | null = null;
let jpShared: Record<keyof JpTowerParts, THREE.Material> | null = null;
let maruShared: Record<keyof MarunouchiParts, THREE.Material> | null = null;
let shinMaruShared: Record<keyof MarunouchiParts, THREE.Material> | null = null;

function marunouchiGroup(parts: MarunouchiParts, shared: Record<keyof MarunouchiParts, THREE.Material>): THREE.Group {
  const group = new THREE.Group();
  for (const key of Object.keys(parts) as Array<keyof MarunouchiParts>) {
    if (parts[key].getAttribute('position').count > 0) group.add(new THREE.Mesh(parts[key], shared[key]));
  }
  return group;
}

let domeShared: Record<keyof DomeParts, THREE.Material> | null = null;
let budokanShared: Record<keyof BudokanParts, THREE.Material> | null = null;
let stadiumShared: Record<keyof StadiumParts, THREE.Material> | null = null;
let castleShared: Record<keyof CastleParts, THREE.Material> | null = null;
let sompoShared: Record<keyof SompoParts, THREE.Material> | null = null;
let cocoonShared: Record<keyof CocoonParts, THREE.Material> | null = null;
let docomoShared: Record<keyof DocomoParts, THREE.Material> | null = null;

let metroGovShared: Record<keyof MetroGovParts, THREE.Material> | null = null;

let ceruleanShared: Record<keyof CeruleanParts, THREE.Material> | null = null;

let axshShared: Record<keyof AxshParts, THREE.Material> | null = null;

let sakuraShared: Record<keyof SakuraParts, THREE.Material> | null = null;

let hikarieShared: Record<keyof HikarieParts, THREE.Material> | null = null;

let scrambleShared: Record<keyof ScrambleParts, THREE.Material> | null = null;

let roppongiShared: Record<keyof RoppongiParts, THREE.Material> | null = null;

let toranomonShared: Record<keyof ToranomonParts, THREE.Material> | null = null;
function toranomonGroup(parts: ToranomonParts): THREE.Group {
  toranomonShared ??= {
    mori: createMoriGlassMaterial(),
    glass: createBlueGlassMaterial(),
    dark: createDarkFacadeMaterial(),
    station: createStationGlassMaterial(),
    accent: new THREE.MeshStandardMaterial({
      color: 0x7fb3a0,
      roughness: 0.15,
      metalness: 0.4,
      transparent: true,
      opacity: 0.9,
    }),
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

  /** 両端が隣のチャンクにかかると、隣が読まれるまで置けないので、どのチャンクが読まれても置けていないものを試す */
  onChunkAdded(): void {
    for (const lm of LANDMARKS) {
      if (this.built.has(lm)) continue;
      // 作るのに失敗しても、地形のチャンクの読込（この呼び出し元）を巻き込まない
      let object: THREE.Group | null = null;
      try {
        object = this.place(lm);
      } catch (e) {
        console.warn('[Landmarks] 作れませんでした', lm.gmlId, e);
        this.built.set(lm, { chunk: '', object: new THREE.Group() });
        continue;
      }
      if (!object) continue;
      this.built.set(lm, { chunk: chunkOf(lm), object });
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
