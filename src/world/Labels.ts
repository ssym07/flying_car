import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { LABELS, TERRAIN } from '../core/config';
import roadLabels from '../data/roadLabels.json';
import stations from '../data/stations.json';

interface Place {
  kind: 'station' | 'road';
  name: string;
  /** ローカル座標（高さは地面が分かるまで未定） */
  position: THREE.Vector3;
  /** 通りの向き（ローカル座標の水平な単位ベクトル）。駅は null */
  direction: THREE.Vector3 | null;
  object: THREE.Object3D | null;
}

/**
 * 3D 空間に置く駅名・通り名。
 * - 駅名：駅の上空に浮かぶ看板（常にカメラを向く）。地面まで細い線を下ろす
 * - 通り名：道路の地面に描いた文字（道に沿った向き。読める向きに自動で反転）
 * カメラの近くだけ作り、離れたら捨てる。地面の高さは地形が読めてから決める
 */
export class Labels {
  readonly group = new THREE.Group();
  private readonly places: Place[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly textures = new Map<string, { texture: THREE.CanvasTexture; aspect: number; users: number }>();
  private sinceRefresh = Infinity;
  private readonly tmp = new THREE.Vector3();

  /**
   * @param ecefToLocal ECEF → ローカル座標
   * @param ground 地面の高さを測る対象（地形・道路。建物は含めない）
   */
  constructor(
    ecefToLocal: THREE.Matrix4,
    private readonly ground: THREE.Object3D[],
  ) {
    this.raycaster.firstHitOnly = true;
    const toLocal = (lat: number, lon: number) =>
      WGS84_ELLIPSOID.getCartographicToPosition(
        lat * THREE.MathUtils.DEG2RAD,
        lon * THREE.MathUtils.DEG2RAD,
        TERRAIN.geoidHeight,
        new THREE.Vector3(),
      ).applyMatrix4(ecefToLocal);

    const stationPlaces: Place[] = stations.map((s) => ({
      kind: 'station',
      name: `${s.name}駅`,
      position: toLocal(s.lat, s.lon),
      direction: null,
      object: null,
    }));
    const roadPlaces: Place[] = (roadLabels as Array<{ name: string; lat: number; lon: number; b: number }>).map(
      (r) => {
        // 方位（北から時計回り）→ ローカル座標の向き（+x=西, +z=北）
        const direction = new THREE.Vector3(-Math.sin(r.b), 0, Math.cos(r.b));
        return { kind: 'road', name: r.name, position: toLocal(r.lat, r.lon), direction, object: null };
      },
    );
    this.places = [...stationPlaces, ...roadPlaces];
  }

  /** 毎フレーム呼ぶ。作る・捨てるの判定は数回/秒、向きと濃さは毎フレーム */
  update(camera: THREE.Camera, dt: number): void {
    this.sinceRefresh += dt;
    if (this.sinceRefresh >= 0.5) {
      this.sinceRefresh = 0;
      this.refresh(camera.position);
    }
    for (const place of this.places) {
      if (place.object) this.updateObject(place, camera);
    }
  }

  dispose(): void {
    for (const place of this.places) if (place.object) this.remove(place);
  }

  /** 近くの場所はラベルを作り、遠くなったものは捨てる */
  private refresh(cameraPosition: THREE.Vector3): void {
    const distanceTo = (p: Place) => Math.hypot(p.position.x - cameraPosition.x, p.position.z - cameraPosition.z);

    // 駅は近い順に maxCount 件だけ
    const { radius, maxCount } = LABELS.station;
    const nearStations = new Set(
      this.places
        .filter((p) => p.kind === 'station' && distanceTo(p) < radius)
        .sort((a, b) => distanceTo(a) - distanceTo(b))
        .slice(0, maxCount),
    );
    for (const place of this.places) {
      if (place.kind === 'station') {
        if (place.object && !nearStations.has(place)) this.remove(place);
        else if (!place.object && nearStations.has(place)) this.create(place);
        continue;
      }
      const d = distanceTo(place);
      if (place.object && d > LABELS.road.radius * 1.2) this.remove(place);
      else if (!place.object && d < LABELS.road.radius) this.create(place);
    }
  }

  private create(place: Place): void {
    const groundY = this.groundHeightAt(place.position.x, place.position.z);
    // 地形がまだ無い所は、次の機会に作る
    if (groundY === null) return;

    const tex = this.acquireTexture(place);
    if (place.kind === 'station') {
      const { height } = LABELS.station;
      const sign = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex.texture, transparent: true, depthWrite: false, fog: false }),
      );
      sign.userData.aspect = tex.aspect;
      sign.position.y = height;
      // 建物に隠れても見えるように、最後に重ねて描く
      sign.material.depthTest = false;
      sign.renderOrder = 10;
      const pole = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, height, 0)]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
      );
      const object = new THREE.Group();
      object.add(pole, sign);
      object.position.set(place.position.x, groundY, place.position.z);
      place.object = object;
    } else {
      const { textHeight, lift } = LABELS.road;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(textHeight * tex.aspect, textHeight),
        new THREE.MeshBasicMaterial({
          map: tex.texture,
          transparent: true,
          depthWrite: false,
          // 地面とちらつかないよう手前に寄せる
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      );
      // 文字を地面に寝かせる
      mesh.rotation.x = -Math.PI / 2;
      const object = new THREE.Group();
      object.add(mesh);
      object.position.set(place.position.x, groundY + lift, place.position.z);
      place.object = object;
    }
    this.group.add(place.object);
  }

  private updateObject(place: Place, camera: THREE.Camera): void {
    const object = place.object!;
    const d = Math.hypot(object.position.x - camera.position.x, object.position.z - camera.position.z);
    if (place.kind === 'station') {
      const { radius, screenSize, fadeNear } = LABELS.station;
      // 画面上の大きさを距離で緩やかに小さくする（実寸 = 画面の割合 × 距離 × 視野の高さ）
      const sign = object.children[1] as THREE.Sprite;
      const distance = camera.position.distanceTo(sign.getWorldPosition(this.tmp));
      const fraction = THREE.MathUtils.lerp(screenSize.near, screenSize.far, THREE.MathUtils.smoothstep(d, 300, radius));
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
      const size = fraction * distance * 2 * Math.tan((fov * THREE.MathUtils.DEG2RAD) / 2);
      sign.scale.set(size * sign.userData.aspect, size, 1);
      const opacity =
        (1 - THREE.MathUtils.smoothstep(d, radius * 0.6, radius)) * THREE.MathUtils.smoothstep(d, fadeNear * 0.5, fadeNear);
      for (const child of object.children) {
        const material = (child as THREE.Sprite | THREE.Line).material as THREE.Material;
        material.opacity = child instanceof THREE.Line ? opacity * 0.6 : opacity;
      }
      return;
    }

    // 通り名：道に沿った向きにし、カメラから読める向き（文字の上がカメラの奥）になるよう反転する
    const dir = place.direction!;
    const toCamera = new THREE.Vector2(camera.position.x - object.position.x, camera.position.z - object.position.z);
    // 文字の上方向（道の向きを左に90°回したもの）がカメラ側を向いていたら、裏返す
    const up = new THREE.Vector2(dir.z, -dir.x);
    const flip = up.dot(toCamera) > 0 ? Math.PI : 0;
    object.rotation.y = Math.atan2(-dir.z, dir.x) + flip;
    const radius = LABELS.road.radius;
    const mesh = object.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    mesh.material.opacity = (1 - THREE.MathUtils.smoothstep(d, radius * 0.6, radius)) * LABELS.road.opacity;
  }

  private remove(place: Place): void {
    const object = place.object!;
    this.group.remove(object);
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Sprite || child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
    place.object = null;
    this.releaseTexture(place);
  }

  /** (x, z) の地形・道路の高さ。まだ地形が無ければ null */
  private groundHeightAt(x: number, z: number): number | null {
    this.raycaster.set(new THREE.Vector3(x, 3000, z), new THREE.Vector3(0, -1, 0));
    const hit = this.raycaster.intersectObjects(this.ground, true)[0];
    return hit ? hit.point.y : null;
  }

  private textureKey(place: Place): string {
    return `${place.kind}:${place.name}`;
  }

  /** 名前ごとに文字の画像を共有する（使う人がいなくなったら捨てる） */
  private acquireTexture(place: Place): { texture: THREE.CanvasTexture; aspect: number } {
    const key = this.textureKey(place);
    let entry = this.textures.get(key);
    if (!entry) {
      const canvas = place.kind === 'station' ? drawStationSign(place.name) : drawRoadName(place.name);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      entry = { texture, aspect: canvas.width / canvas.height, users: 0 };
      this.textures.set(key, entry);
    }
    entry.users++;
    return entry;
  }

  private releaseTexture(place: Place): void {
    const key = this.textureKey(place);
    const entry = this.textures.get(key);
    if (!entry) return;
    entry.users--;
    if (entry.users <= 0) {
      entry.texture.dispose();
      this.textures.delete(key);
    }
  }
}

const FONT = `system-ui, -apple-system, 'Hiragino Sans', sans-serif`;

/** 駅名の看板：濃紺の角丸に白文字、左に駅マーク */
function drawStationSign(name: string): HTMLCanvasElement {
  const h = 96;
  const pad = 28;
  const icon = 56;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 52px ${FONT}`;
  const w = Math.ceil(pad + icon + 16 + measure.measureText(name).width + pad);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(14, 26, 44, 0.88)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 22);
  g.fill();
  g.strokeStyle = 'rgba(102, 204, 255, 0.9)';
  g.lineWidth = 4;
  g.stroke();
  // 駅マーク（電車の正面っぽい丸角四角）
  g.fillStyle = '#66ccff';
  g.beginPath();
  g.roundRect(pad, (h - icon) / 2, icon, icon, 12);
  g.fill();
  g.fillStyle = 'rgba(14, 26, 44, 1)';
  g.fillRect(pad + 10, (h - icon) / 2 + 10, icon - 20, 18);
  g.beginPath();
  g.arc(pad + 16, (h - icon) / 2 + 40, 5, 0, Math.PI * 2);
  g.arc(pad + icon - 16, (h - icon) / 2 + 40, 5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = `700 52px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(name, pad + icon + 16, h / 2 + 2);
  return canvas;
}

/** 通り名：路面に描く白い文字（縁取り付き） */
function drawRoadName(name: string): HTMLCanvasElement {
  const h = 80;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `800 60px ${FONT}`;
  const w = Math.ceil(measure.measureText(name).width + 24);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.font = `800 60px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(10, 18, 30, 0.75)';
  g.strokeText(name, w / 2, h / 2);
  g.fillStyle = '#f2f5f8';
  g.fillText(name, w / 2, h / 2);
  return canvas;
}
