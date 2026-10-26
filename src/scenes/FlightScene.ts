import * as THREE from 'three';
import { KEYS, PHYSICS, SEARCH, TERRAIN, VEHICLE, WORLD } from '../core/config';
import type { GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';
import { ChaseCamera } from '../camera/ChaseCamera';
import { Hud } from '../ui/hud';
import { LocationLabel } from '../ui/locationLabel';
import { Minimap } from '../ui/minimap';
import { StationSearch } from '../ui/stationSearch';
import { forwardOf, step, speed, type ControlInput } from '../vehicle/physics';
import { Vehicle } from '../vehicle/Vehicle';
import { Collision } from '../world/Collision';

export class FlightScene implements GameScene {
  private vehicle!: Vehicle;
  private collision!: Collision;
  private chase!: ChaseCamera;
  private hud!: Hud;
  private location!: LocationLabel;
  private minimap!: Minimap;
  private search!: StationSearch;
  private readonly ahead = new THREE.Vector3();
  private sinceLocation = Infinity;
  private groundHeight = 0;
  private readonly control: ControlInput = { throttle: 0, turn: 0, lift: 0 };

  constructor(private readonly ctx: GameContext) {}

  enter(): void {
    const { world, input } = this.ctx;
    input.clearPresses();

    this.collision = new Collision(world.colliders, world.groundY, VEHICLE.radius, VEHICLE.halfHeight);
    this.groundHeight = this.collision.groundHeightAt(0, 0);

    this.vehicle = new Vehicle({
      position: { x: 0, y: this.groundHeight + VEHICLE.halfHeight + VEHICLE.startAltitude, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
    });
    world.scene.add(this.vehicle.mesh);
    // 駅名の看板（建物越しに見えるよう最後に重ねて描く）より、さらに後に自機を描く
    this.vehicle.mesh.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.material.transparent = true;
      obj.renderOrder = 20;
    });

    this.chase = new ChaseCamera(world.camera, this.collision, () => world.groundY);
    this.hud = new Hud(this.ctx.overlay);
    this.location = new LocationLabel(this.ctx.overlay);
    this.minimap = new Minimap(this.ctx.overlay);
    this.search = new StationSearch(
      this.ctx.overlay,
      (station) => this.jumpTo(station.lat, station.lon),
      () => this.ctx.world.toLatLon(this.vehicle.mesh.position),
    );

    // 開発時だけ、コンソールや自動テストから状態を覗けるようにする
    if (import.meta.env.DEV) Object.assign(window, { __flight: this });
  }

  exit(): void {
    this.ctx.world.scene.remove(this.vehicle.mesh);
    this.vehicle.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.hud.dispose();
    this.location.dispose();
    this.minimap.dispose();
    this.search.dispose();
  }

  /** (lat, lon)（度）の上空へジャンプする。向きはそのまま、止まった状態にする */
  private jumpTo(lat: number, lon: number): void {
    const terrain = this.ctx.world.terrain;
    // まだ地形を読んでいない場所なら標高 0m（海面）とみなす。着いてから地形が読まれれば当たり判定で押し上がる
    const ground = terrain.surfaceHeightAt(lat, lon) ?? 0;
    const p = terrain.toLocal(lat, lon, ground + SEARCH.jumpAltitude);
    this.vehicle.reset({
      position: { x: p.x, y: p.y, z: p.z },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: this.vehicle.state.yaw,
    });
    this.chase.snap();
  }

  update(dt: number): void {
    const { input } = this.ctx;
    if (input.consumePress(KEYS.pause)) {
      this.ctx.go.pause();
      return;
    }

    this.control.throttle = input.axis(KEYS.back, KEYS.forward);
    this.control.turn = input.axis(KEYS.left, KEYS.right);
    this.control.lift = input.axis(KEYS.down, KEYS.up);

    const prev = this.vehicle.state;
    const next = step(prev, this.control, PHYSICS, dt);
    const result = this.collision.resolve(prev, next);
    this.vehicle.commit(result.state);
    this.groundHeight = result.groundHeight;
  }

  render(alpha: number, frameDt: number): void {
    const { world } = this.ctx;
    this.vehicle.syncMesh(alpha);
    // マウス操作は受け取って捨てる（ポーズ中＝frameDt 0 の間は視点を動かさない）
    const pointer = this.ctx.input.consumePointer();
    if (frameDt > 0) this.chase.control(pointer.dx, pointer.dy, pointer.wheel, pointer.dragging);
    this.chase.follow(this.vehicle.mesh.position, this.vehicle.mesh.rotation.y, frameDt);

    const s = this.vehicle.state;
    const bottom = s.position.y - VEHICLE.halfHeight;
    // ローカル座標の y=0 は原点の楕円体高。ジオイド高を引くと標高（海抜）になる
    const seaLevel = TERRAIN.geoidHeight - WORLD.origin.ellipsoidHeight;
    this.hud.set(speed(s.velocity), bottom - seaLevel, bottom - this.groundHeight);

    const position = this.vehicle.mesh.position;
    const latLon = world.toLatLon(position);
    if (latLon) {
      // 進行方向の方位：少し前の地点も緯度経度にして、北からの角度を出す
      const fwd = forwardOf(this.vehicle.mesh.rotation.y);
      const ahead = world.toLatLon(this.ahead.set(position.x + fwd.x * 20, position.y, position.z + fwd.z * 20))!;
      const east = (ahead.lon - latLon.lon) * Math.cos(latLon.lat * THREE.MathUtils.DEG2RAD);
      const north = ahead.lat - latLon.lat;
      this.minimap.update(latLon.lat, latLon.lon, Math.atan2(east, north));

      // 現在地の文字表示は 0.5 秒ごとで十分
      this.sinceLocation += frameDt;
      if (this.sinceLocation >= 0.5) {
        this.location.update(latLon.lat, latLon.lon);
        this.sinceLocation = 0;
      }
    }

    world.render(frameDt);
  }
}
