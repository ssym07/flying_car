import * as THREE from 'three';
import { KEYS, PHYSICS, SEARCH, TERRAIN, VEHICLE, WORLD } from '../core/config';
import type { GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';
import { ChaseCamera } from '../camera/ChaseCamera';
import { Hud } from '../ui/hud';
import { Instruments } from '../ui/instruments';
import { LocationLabel } from '../ui/locationLabel';
import { Minimap } from '../ui/minimap';
import { RouteMap } from '../ui/routeMap';
import { StationSearch } from '../ui/stationSearch';
import { forwardOf, step, speed, type ControlInput } from '../vehicle/physics';
import { Vehicle } from '../vehicle/Vehicle';
import { Collision } from '../world/Collision';

export class FlightScene implements GameScene {
  private vehicle!: Vehicle;
  private collision!: Collision;
  private chase!: ChaseCamera;
  private hud!: Hud;
  private instruments!: Instruments;
  /** 計器に出す機首の上下・傾き (rad)。急に動かないよう、なめらかに追わせる */
  private pitch = 0;
  private roll = 0;
  private lastYaw = 0;
  private location!: LocationLabel;
  private minimap!: Minimap;
  private search!: StationSearch;
  private routeMap!: RouteMap;
  /** ホーム（行き先を選ぶタイトル）へ戻るボタン */
  private homeButton!: HTMLButtonElement;
  /** 地形の読込を待っているジャンプ先 */
  private pendingJump: { lat: number; lon: number } | null = null;
  private readonly ahead = new THREE.Vector3();
  private readonly seaPoint = new THREE.Vector3();
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
    this.instruments = new Instruments(this.ctx.overlay);
    this.lastYaw = this.vehicle.state.yaw;
    this.location = new LocationLabel(this.ctx.overlay);
    this.minimap = new Minimap(this.ctx.overlay);
    this.search = new StationSearch(
      this.ctx.overlay,
      (station) => this.jumpTo(station.lat, station.lon),
      () => this.ctx.world.toLatLon(this.vehicle.mesh.position),
    );
    this.routeMap = new RouteMap(
      this.ctx.overlay,
      (station) => this.jumpTo(station.lat, station.lon),
      () => this.ctx.world.toLatLon(this.vehicle.mesh.position),
    );

    this.homeButton = document.createElement('button');
    this.homeButton.type = 'button';
    this.homeButton.className = 'home-button';
    this.homeButton.textContent = 'ホーム';
    this.homeButton.title = '行き先（東京・大阪）を選ぶ画面へ戻る';
    this.homeButton.addEventListener('click', () => this.ctx.go.title());
    this.ctx.overlay.appendChild(this.homeButton);

    // 開発時だけ、コンソールや自動テストから状態を覗けるようにする
    if (import.meta.env.DEV) Object.assign(window, { __flight: this });
  }

  exit(): void {
    this.ctx.world.scene.remove(this.vehicle.mesh);
    this.vehicle.mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.hud.dispose();
    this.instruments.dispose();
    this.location.dispose();
    this.minimap.dispose();
    this.search.dispose();
    this.routeMap.dispose();
    this.homeButton.remove();
  }

  /**
   * (lat, lon)（度）の上空へジャンプする。向きはそのまま、止まった状態にする。
   * まだ地形を読んでいない場所なら、いったん十分高い所で待ち、地形が読めたら地面から jumpAltitude の高さに置き直す
   * （地面の高さが分からないまま置くと、高台で地形の下に入ってしまう）
   */
  private jumpTo(lat: number, lon: number): void {
    this.pendingJump = { lat, lon };
    this.place(lat, lon, this.ctx.world.terrain.surfaceHeightAt(lat, lon));
  }

  private place(lat: number, lon: number, ground: number | null): void {
    const height = ground === null ? SEARCH.waitAltitude : ground + SEARCH.jumpAltitude;
    const p = this.ctx.world.terrain.toLocal(lat, lon, height);
    this.vehicle.reset({
      position: { x: p.x, y: p.y, z: p.z },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: this.vehicle.state.yaw,
    });
    this.chase.snap();
    if (ground !== null) this.pendingJump = null;
  }

  update(dt: number): void {
    const { input } = this.ctx;
    if (input.consumePress(KEYS.pause)) {
      this.ctx.go.pause();
      return;
    }

    if (this.pendingJump) {
      const { lat, lon } = this.pendingJump;
      const ground = this.ctx.world.terrain.surfaceHeightAt(lat, lon);
      if (ground !== null) this.place(lat, lon, ground);
      // 地形が読めるまでは、待つ高さに止めておく
      else return;
    }

    this.control.throttle = input.axis(KEYS.back, KEYS.forward);
    this.control.turn = input.axis(KEYS.left, KEYS.right);
    this.control.lift = input.axis(KEYS.down, KEYS.up);

    // 地形の外側の平面は、地球の丸みに合わせて高さが変わる
    this.collision.groundY = this.ctx.world.groundY;
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
    const position = this.vehicle.mesh.position;
    const latLon = world.toLatLon(position);
    // 標高（海抜）：真下の海面（標高 0m）の高さから測る（地球の丸みで、原点から離れるほど海面は下がる）
    const seaLevel = latLon
      ? world.terrain.toLocal(latLon.lat, latLon.lon, 0, this.seaPoint).y
      : TERRAIN.geoidHeight - WORLD.origin.ellipsoidHeight;
    this.hud.set(speed(s.velocity), bottom - seaLevel, bottom - this.groundHeight);
    if (latLon) {
      // 進行方向の方位：少し前の地点も緯度経度にして、北からの角度を出す
      const fwd = forwardOf(this.vehicle.mesh.rotation.y);
      const ahead = world.toLatLon(this.ahead.set(position.x + fwd.x * 20, position.y, position.z + fwd.z * 20))!;
      const east = (ahead.lon - latLon.lon) * Math.cos(latLon.lat * THREE.MathUtils.DEG2RAD);
      const north = ahead.lat - latLon.lat;
      const heading = Math.atan2(east, north);
      this.minimap.update(latLon.lat, latLon.lon, heading);
      this.updateInstruments(heading, bottom - seaLevel, frameDt);

      // 現在地の文字表示は 0.5 秒ごとで十分
      this.sinceLocation += frameDt;
      if (this.sinceLocation >= 0.5) {
        this.location.update(latLon.lat, latLon.lon);
        this.sinceLocation = 0;
      }
    }

    this.routeMap.update();
    world.render(frameDt);
  }

  /**
   * 計器盤：機首の上下は進む向きの上り・下りの角度、傾きは旋回の速さと速度から（旋回で外へ振られないように傾ける角度の半分）
   */
  private updateInstruments(heading: number, altitude: number, frameDt: number): void {
    const s = this.vehicle.state;
    const yaw = this.vehicle.mesh.rotation.y;
    if (frameDt > 0) {
      const horizontal = Math.hypot(s.velocity.x, s.velocity.z);
      const pitch = horizontal + Math.abs(s.velocity.y) > 1 ? Math.atan2(s.velocity.y, Math.max(horizontal, 1)) : 0;
      // 右旋回で yaw は減る
      const rate = -Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / frameDt;
      const roll = THREE.MathUtils.clamp(Math.atan((horizontal * rate) / PHYSICS.gravity) * 0.5, -0.8, 0.8);
      const k = Math.min(1, frameDt * 4);
      this.pitch += (THREE.MathUtils.clamp(pitch, -0.6, 0.6) - this.pitch) * k;
      this.roll += (roll - this.roll) * k;
    }
    this.lastYaw = yaw;
    this.instruments.update({
      speed: speed(s.velocity) * 3.6,
      altitude,
      pitch: this.pitch,
      roll: this.roll,
      heading,
    });
  }
}
