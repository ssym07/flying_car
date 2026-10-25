import * as THREE from 'three';
import { CAMERA, WORLD } from '../core/config';
import { Terrain } from './Terrain';
import { Tiles } from './Tiles';

/**
 * シーン間で共有する描画まわり（Three.js のシーン・カメラ・タイル・地形）。
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly buildings: Tiles;
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
      CAMERA.far,
    );

    const sky = new THREE.Color(0x9cc8ee);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 1500, 6000);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b6250, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-0.5, 1, 0.3);
    this.scene.add(sun);

    this.ground = buildGround();
    this.scene.add(this.ground);

    const { buildings, roads } = WORLD.layers;
    this.buildings = new Tiles(buildings.url, buildings.errorTarget, buildings.color, this.camera, renderer);
    this.roads = new Tiles(roads.url, roads.errorTarget, roads.color, this.camera, renderer);
    this.scene.add(this.buildings.group, this.roads.group, this.terrain.group);
    this.colliders = [this.buildings.group, this.roads.group, this.terrain.group];

    // 地形はタイルと同じ座標変換で作るので、建物のルート tileset を待ってから読む
    this.buildings.ready
      .then((ecefToLocal) => this.terrain.load(ecefToLocal))
      .then(() => {
        // 地形の外側の平面は、地形の一番低い所より少し下に置く
        if (this.terrain.group.children.length > 0) this.groundY = this.terrain.minHeight - 1;
      });

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
    return [this.buildings, this.roads];
  }

  render(): void {
    for (const layer of this.layers) layer.update(this.camera);
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
