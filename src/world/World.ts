import * as THREE from 'three';
import { CAMERA, TERRAIN, WORLD } from '../core/config';
import { REGION, dataUrl } from '../core/region';
import { WARDS } from '../data/wards';
import { Airports } from './Airports';
import { Atmosphere } from './Atmosphere';
import { setFacadeNight } from './facade';
import { timeOfDay } from '../core/timeOfDay';
import { computeEcefToLocal } from './geoFrame';
import { ExpresswayNetwork } from './ExpresswayNetwork';
import { ExpresswaySigns } from './ExpresswaySigns';
import { Labels } from './Labels';
import { PostFX } from './PostFX';
import { Shadows } from './Shadows';
import { Landmarks } from './landmarks/Landmarks';
import { RailNetwork } from './RailNetwork';
import { RoadNetwork } from './RoadNetwork';
import { SkyTraffic } from './SkyTraffic';
import { StationRoofs } from './StationRoofs';
import { Terrain } from './Terrain';
import { Tiles } from './Tiles';

/** 地形の外側の平面の標高 (m) */
const GROUND_ELEVATION = -30;

/**
 * シーン間で共有する描画まわり（Three.js のシーン・カメラ・タイル・地形）。
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** 区ごとの建物 */
  readonly buildings: Tiles[];
  /** 道路（OpenStreetMap の中心線からテンプレートで作る） */
  readonly roads: RoadNetwork;
  /** 線路 */
  readonly rails: RailNetwork;
  /** 高速道路 */
  readonly expressways: ExpresswayNetwork;
  readonly expresswaySigns: ExpresswaySigns;
  /** 駅の屋根 */
  readonly stationRoofs: StationRoofs;
  /** 作り込んだ建物（東京駅丸の内駅舎など） */
  readonly landmarks: Landmarks;
  /** 空を流れる車の列 */
  readonly skyTraffic: SkyTraffic;
  readonly airports: Airports;
  readonly terrain = new Terrain();
  /** 当たり判定の対象 */
  readonly colliders: THREE.Object3D[];
  private readonly ground: THREE.Group;
  private readonly atmosphere: Atmosphere;
  private readonly labels: Labels;
  private readonly groundPoint = new THREE.Vector3();
  private readonly postFX: PostFX;
  private readonly shadows: Shadows;

  /**
   * @param localWards 手元に加工済みの建物データがある区のコード（scripts/build-local-buildings.mjs で作る）。
   *   その区は public/plateau から読み、無い区は PLATEAU の配信サーバーから読む
   */
  constructor(
    readonly renderer: THREE.WebGLRenderer,
    localWards: ReadonlySet<string> = new Set(),
  ) {
    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / window.innerHeight,
      CAMERA.near,
      WORLD.viewDistance,
    );

    this.atmosphere = new Atmosphere(this.scene, renderer);
    this.postFX = new PostFX(renderer);
    this.shadows = new Shadows(this.scene, renderer, this.atmosphere, () => [
      ...this.buildings.map((b) => b.group),
      this.landmarks.group,
      this.stationRoofs.group,
      this.expressways.group,
      this.rails.group,
    ]);

    this.ground = buildGround();
    this.scene.add(this.ground);

    // 選んだ地域の区だけ。手元のデータが無く配信元も無い区（国土地理院から作る市の作る前）は飛ばす
    const wards = WARDS.filter(
      (w) => REGION.prefectures.some((p) => w.code.startsWith(p)) && (localWards.has(w.code) || w.url !== ''),
    );
    this.buildings = wards.map(
      (ward) =>
        new Tiles(
          localWards.has(ward.code) ? dataUrl(`plateau/${ward.code}/tileset.json`) : ward.url,
          ward.kind === 'lod2-texture' ? WORLD.buildings.errorTarget : WORLD.buildings.plainErrorTarget,
          // テクスチャの無い区には、手続き的に描いた外壁テンプレートを貼る
          ward.kind === 'lod2-texture' ? 'original' : 'facade',
          this.camera,
          renderer,
        ),
    );
    this.roads = new RoadNetwork(this.terrain);
    this.rails = new RailNetwork(this.terrain);
    this.expressways = new ExpresswayNetwork(this.terrain);
    this.expresswaySigns = new ExpresswaySigns(this.terrain, this.expressways.group);
    this.stationRoofs = new StationRoofs(this.terrain);
    this.landmarks = new Landmarks(this.terrain);
    this.skyTraffic = new SkyTraffic(this.terrain);
    this.airports = new Airports(this.terrain);
    this.scene.add(
      ...this.layers.map((l) => l.group),
      this.terrain.group,
      this.terrain.trees,
      this.roads.group,
      this.rails.group,
      this.expressways.group,
      this.expresswaySigns.group,
      this.stationRoofs.group,
      this.landmarks.group,
      this.skyTraffic.group,
      this.airports.group,
    );
    this.colliders = [
      ...this.layers.map((l) => l.group),
      this.terrain.group,
      this.stationRoofs.group,
      this.expressways.group,
      this.landmarks.group,
    ];

    // 地形の外側の平面：標高 GROUND_ELEVATION m（ゼロメートル地帯（標高 -4m 前後）の地形より上に出ないよう、十分低くする）。
    // 地球の丸みで原点から離れるほど地面は下がるので、毎フレーム自機の真下の高さに合わせる（render）
    this.groundY = TERRAIN.geoidHeight - WORLD.origin.ellipsoidHeight + GROUND_ELEVATION;

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
    this.postFX.resize();
    for (const layer of this.layers) layer.setResolution(this.camera, this.renderer);
  }

  get layers(): Tiles[] {
    return this.buildings;
  }

  /** 地形の外側の平面を、カメラの真下へ動かし、その場所の標高 GROUND_ELEVATION m の高さにする */
  private followGround(): void {
    const camera = this.camera.position;
    const latLon = this.terrain.toLatLon(camera);
    if (!latLon) return;
    const y = this.terrain.toLocal(latLon.lat, latLon.lon, GROUND_ELEVATION, this.groundPoint).y;
    // 格子の線が滑って見えないよう、横は格子の間隔に揃えて動かす
    this.ground.position.set(Math.round(camera.x / 50) * 50, y, Math.round(camera.z / 50) * 50);
  }

  /** ローカル座標 → 緯度経度（度）。座標変換が決まる前は null */
  toLatLon(position: THREE.Vector3): { lat: number; lon: number } | null {
    return this.terrain.toLatLon(position);
  }

  /** @param dt 前のフレームからの秒数（雲やラベルの更新に使う） */
  render(dt: number): void {
    this.followGround();
    for (const layer of this.layers) layer.update(this.camera);
    this.terrain.update(this.camera.position);
    this.atmosphere.update(this.camera, dt);
    setFacadeNight(this.atmosphere.night, timeOfDay.minutes);
    this.skyTraffic.update(this.camera.position, dt);
    this.labels.update(this.camera, dt);
    this.expresswaySigns.update(this.camera, dt);
    this.shadows.update(this.camera, this.groundY);
    this.postFX.render(this.scene, this.camera);
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
