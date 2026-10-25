import * as THREE from 'three';
import { CAMERA, WORLD } from '../core/config';
import { Tiles } from './Tiles';

/**
 * シーン間で共有する描画まわり（Three.js のシーン・カメラ・タイル・地面）。
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly tiles: Tiles;
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

    this.tiles = new Tiles(this.camera, renderer);
    this.scene.add(this.tiles.group);

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
    this.tiles.setResolution(this.camera, this.renderer);
  }

  render(): void {
    this.tiles.update(this.camera);
    this.renderer.render(this.scene, this.camera);
  }
}

/** 地形データの代わりの平面。速度感が出るようにグリッドを重ねる */
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
