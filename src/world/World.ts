import * as THREE from 'three';
import { CAMERA, TERRAIN, WORLD } from '../core/config';
import { WARDS } from '../data/wards';
import { Atmosphere } from './Atmosphere';
import { computeEcefToLocal } from './geoFrame';
import { Labels } from './Labels';
import { Terrain } from './Terrain';
import { Tiles } from './Tiles';

/**
 * シーン間で共有する描画まわり（Three.js のシーン・カメラ・タイル・地形）。
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** 区ごとの建物 */
  readonly buildings: Tiles[];
  readonly roads: Tiles;
  readonly terrain = new Terrain();
  /** 当たり判定の対象 */
  readonly colliders: THREE.Object3D[];
  private readonly ground: THREE.Group;
  private readonly atmosphere: Atmosphere;
  private readonly labels: Labels;

  constructor(readonly renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / window.innerHeight,
      CAMERA.near,
      WORLD.viewDistance,
    );

    this.atmosphere = new Atmosphere(this.scene, renderer);

    this.ground = buildGround();
    this.scene.add(this.ground);

    this.buildings = WARDS.map(
      (ward) =>
        new Tiles(
          ward.url,
          ward.kind === 'lod2-texture' ? WORLD.buildings.errorTarget : WORLD.buildings.plainErrorTarget,
          // テクスチャの無い区には、手続き的に描いた外壁テンプレートを貼る
          ward.kind === 'lod2-texture' ? 'original' : 'facade',
          this.camera,
          renderer,
        ),
    );
    const { roads } = WORLD;
    this.roads = new Tiles(roads.url, roads.errorTarget, { color: roads.color }, this.camera, renderer);
    this.scene.add(...this.layers.map((l) => l.group), this.terrain.group);
    this.colliders = [...this.layers.map((l) => l.group), this.terrain.group];

    // 地形の外側の平面は海面より少し下に置く（ローカル座標の y=0 は原点の楕円体高）
    this.groundY = TERRAIN.geoidHeight - WORLD.origin.ellipsoidHeight - 5;

    // 地形・ラベルはタイルと同じ座標変換で作る
    const ecefToLocal = computeEcefToLocal();
    this.terrain.setFrame(ecefToLocal);
    this.labels = new Labels(ecefToLocal, [this.terrain.group, this.roads.group]);
    this.scene.add(this.labels.group);

    window.addEventListener('resize', () => this.resize());
  }

  get groundY(): number {
    return this.ground.position.y;
  }

  set groundY(y: number) {
    this.ground.position.y = y;
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    for (const layer of this.layers) layer.setResolution(this.camera, this.renderer);
  }

  get layers(): Tiles[] {
    return [...this.buildings, this.roads];
  }

  /** ローカル座標 → 緯度経度（度）。座標変換が決まる前は null */
  toLatLon(position: THREE.Vector3): { lat: number; lon: number } | null {
    return this.terrain.toLatLon(position);
  }

  /** @param dt 前のフレームからの秒数（雲やラベルの更新に使う） */
  render(dt: number): void {
    for (const layer of this.layers) layer.update(this.camera);
    this.terrain.update(this.camera.position);
    this.atmosphere.update(this.camera, dt);
    this.labels.update(this.camera, dt);
    this.renderer.render(this.scene, this.camera);
  }
}

/** 地形の外側に敷く平面。速度感が出るようにグリッドを重ねる */
function buildGround(): THREE.Group {
  const group = new THREE.Group();
  const size = WORLD.groundSize;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0x7d8a72, roughness: 1 }),
  );
  plane.rotation.x = -Math.PI / 2;
  group.add(plane);

  const grid = new THREE.GridHelper(size, size / 50, 0x5d6a55, 0x6d7a63);
  grid.position.y = 0.05;
  group.add(grid);
  return group;
}
