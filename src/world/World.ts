import * as THREE from 'three';
import { CAMERA, TERRAIN, WORLD } from '../core/config';
import { WARDS } from '../data/wards';
import { computeEcefToLocal } from './geoFrame';
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

  constructor(readonly renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / window.innerHeight,
      CAMERA.near,
      WORLD.viewDistance,
    );

    const sky = new THREE.Color(0x9cc8ee);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, WORLD.fog.near, WORLD.fog.far);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b6250, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-0.5, 1, 0.3);
    this.scene.add(sun);

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

    // 地形はタイルと同じ座標変換で作る
    this.terrain.setFrame(computeEcefToLocal());

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

  render(): void {
    for (const layer of this.layers) layer.update(this.camera);
    this.terrain.update(this.camera.position);
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
