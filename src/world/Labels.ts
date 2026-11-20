import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { LABELS, TERRAIN } from '../core/config';
import { regionUrl } from '../core/region';
import { ROAD_LABELS as roadLabels, STATIONS as stations } from '../data/regionData';

interface Place {
  kind: 'station' | 'road' | 'school' | 'park' | 'museum' | 'office';
  name: string;
  /** ローカル座標（高さは地面が分かるまで未定） */
  position: THREE.Vector3;
  /** 学校の種類（0 小学校・1 中学校・2 高校・3 大学など）、美術館などの種類（0 美術館・1 科学館・2 博物館）、役所の種類（0 都府県庁・1 市役所など・2 区役所）。ほかは 0 */
  level?: number;
  /** 通りの向き（ローカル座標の水平な単位ベクトル）。駅は null */
  direction: THREE.Vector3 | null;
  object: THREE.Object3D | null;
}

/**
 * 3D 空間に置く駅名・通り名。
 * - 駅名：駅の上空に浮かぶ看板（常にカメラを向く）。地面まで細い線を下ろす
 * - 通り名：道路の地面に描いた文字（道に沿った向き。読める向きに自動で反転）
 * - 学校名：駅名より小さく低い看板（scripts/fetch-schools.mjs が作る schools.json。読み込めたら足す）
 * - 公園名：大きな公園だけ、学校と同じ形の看板（scripts/fetch-park-names.mjs が作る park-names.json）
 * - 美術館・科学館・博物館：学校と同じ形の紫の看板（scripts/fetch-museums.mjs が作る museums.json）
 * - 都府県庁・市役所・町村役場・区役所：赤茶の看板（scripts/build-municipalities.mjs が作る offices.json）
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

    // 学校名（ファイルが無い地域では出さない）
    fetch(regionUrl('schools.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { s: [string, number, number, number][] } | null) => {
        if (!data) return;
        for (const [name, lat, lon, level] of data.s) {
          this.places.push({ kind: 'school', name, level, position: toLocal(lat, lon), direction: null, object: null });
        }
      })
      .catch(() => {});

    // 美術館・科学館・博物館（ファイルが無い地域では出さない）
    fetch(regionUrl('museums.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { m: [string, number, number, number][] } | null) => {
        if (!data) return;
        for (const [name, lat, lon, level] of data.m) {
          this.places.push({ kind: 'museum', name, level, position: toLocal(lat, lon), direction: null, object: null });
        }
      })
      .catch(() => {});

    // 都府県庁・市役所・区役所（ファイルが無い地域では出さない）
    fetch(regionUrl('offices.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { o: [string, number, number, number][] } | null) => {
        if (!data) return;
        for (const [name, lat, lon, level] of data.o) {
          this.places.push({ kind: 'office', name, level, position: toLocal(lat, lon), direction: null, object: null });
        }
      })
      .catch(() => {});

    // 公園名（広い公園だけ。ファイルが無い地域では出さない）
    fetch(regionUrl('park-names.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { p: [string, number, number, number][] } | null) => {
        if (!data) return;
        for (const [name, lat, lon, area] of data.p) {
          if (area < LABELS.park.minArea) continue;
          this.places.push({ kind: 'park', name, position: toLocal(lat, lon), direction: null, object: null });
        }
      })
      .catch(() => {});
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

    // 駅・学校は近い順に maxCount 件だけ
    const nearest = (kind: 'station' | 'school' | 'park' | 'museum' | 'office', limit?: number) => {
      const { radius } = LABELS[kind];
      const maxCount = limit ?? LABELS[kind].maxCount;
      return this.places
        .filter((p) => p.kind === kind && distanceTo(p) < radius)
        .sort((a, b) => distanceTo(a) - distanceTo(b))
        .slice(0, maxCount);
    };
    // 学校・公園は、選んだ看板どうしが近すぎるもの（同じ敷地の中学校・高校、隣り合う大学など）を飛ばす（看板が重なって読めないので）
    const spaced = (kind: 'school' | 'park' | 'museum' | 'office') => {
      const chosen: Place[] = [];
      for (const p of nearest(kind, Infinity)) {
        if (chosen.length >= LABELS[kind].maxCount) break;
        const tooClose = chosen.some(
          (q) => Math.hypot(p.position.x - q.position.x, p.position.z - q.position.z) < LABELS[kind].spacing,
        );
        if (!tooClose) chosen.push(p);
      }
      return chosen;
    };
    const near = new Set([
      ...nearest('station'),
      ...spaced('school'),
      ...spaced('park'),
      ...spaced('museum'),
      ...spaced('office'),
    ]);
    for (const place of this.places) {
      if (place.kind !== 'road') {
        if (place.object && !near.has(place)) this.remove(place);
        else if (!place.object && near.has(place)) this.create(place);
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
    if (place.kind !== 'road') {
      const { height } = LABELS[place.kind];
      const sign = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex.texture, transparent: true, depthWrite: false, fog: false }),
      );
      sign.userData.aspect = tex.aspect;
      sign.position.y = height;
      // 建物に隠れても見えるように、最後に重ねて描く
      sign.material.depthTest = false;
      // 駅名を学校名より手前に
      sign.renderOrder = place.kind === 'station' ? 11 : 10;
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
    if (place.kind !== 'road') {
      const { radius, screenSize, fadeNear } = LABELS[place.kind];
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
    return `${place.kind}:${place.level ?? 0}:${place.name}`;
  }

  /** 名前ごとに文字の画像を共有する（使う人がいなくなったら捨てる） */
  private acquireTexture(place: Place): { texture: THREE.CanvasTexture; aspect: number } {
    const key = this.textureKey(place);
    let entry = this.textures.get(key);
    if (!entry) {
      const canvas =
        place.kind === 'station'
          ? drawStationSign(place.name)
          : place.kind === 'school'
            ? drawSchoolSign(place.name, place.level ?? 0)
            : place.kind === 'park'
              ? drawParkSign(place.name)
              : place.kind === 'museum'
                ? drawMuseumSign(place.name, place.level ?? 0)
                : place.kind === 'office'
                  ? drawOfficeSign(place.name, place.level ?? 1)
                  : drawRoadName(place.name);
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

/** 学校名の看板：深緑の角丸に白文字、左に種類（小・中・高・大）の丸 */
function drawSchoolSign(name: string, level: number): HTMLCanvasElement {
  const h = 84;
  const pad = 22;
  const icon = 52;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 44px ${FONT}`;
  const w = Math.ceil(pad + icon + 14 + measure.measureText(name).width + pad);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(16, 52, 34, 0.86)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 18);
  g.fill();
  g.strokeStyle = 'rgba(134, 214, 150, 0.9)';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#86d696';
  g.beginPath();
  g.arc(pad + icon / 2, h / 2, icon / 2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(16, 52, 34, 1)';
  g.font = `800 34px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('小中高大'[level] ?? '学', pad + icon / 2, h / 2 + 2);
  g.fillStyle = '#ffffff';
  g.font = `700 44px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(name, pad + icon + 14, h / 2 + 2);
  return canvas;
}

/** 美術館・科学館・博物館の看板：紫の角丸に白文字、左に種類（美・科・博）の丸 */
function drawMuseumSign(name: string, level: number): HTMLCanvasElement {
  const h = 84;
  const pad = 22;
  const icon = 52;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 44px ${FONT}`;
  const w = Math.ceil(pad + icon + 14 + measure.measureText(name).width + pad);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(58, 30, 82, 0.86)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 18);
  g.fill();
  g.strokeStyle = 'rgba(200, 160, 236, 0.9)';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#c8a0ec';
  g.beginPath();
  g.arc(pad + icon / 2, h / 2, icon / 2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(58, 30, 82, 1)';
  g.font = `800 34px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('美科博'[level] ?? '博', pad + icon / 2, h / 2 + 2);
  g.fillStyle = '#ffffff';
  g.font = `700 44px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(name, pad + icon + 14, h / 2 + 2);
  return canvas;
}

/**
 * 役所の看板：赤茶の角丸に白文字、左に印（都府県庁は「庁」、ほかは名前の役所・役場の前の字：市・区・町・村）。
 * 都府県庁は少し大きく
 */
function drawOfficeSign(name: string, level: number): HTMLCanvasElement {
  const big = level === 0;
  const h = big ? 96 : 84;
  const pad = 22;
  const icon = big ? 60 : 52;
  const font = big ? 50 : 44;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 ${font}px ${FONT}`;
  const w = Math.ceil(pad + icon + 14 + measure.measureText(name).width + pad);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(92, 32, 22, 0.88)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 18);
  g.fill();
  g.strokeStyle = big ? 'rgba(255, 214, 140, 0.95)' : 'rgba(240, 168, 140, 0.9)';
  g.lineWidth = 4;
  g.stroke();
  // 四角い印（庁舎）
  g.fillStyle = big ? '#ffd68c' : '#f0a88c';
  g.beginPath();
  g.roundRect(pad, (h - icon) / 2, icon, icon, 10);
  g.fill();
  g.fillStyle = 'rgba(92, 32, 22, 1)';
  g.font = `800 ${Math.round(icon * 0.66)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const mark = big ? '庁' : name.replace(/(役所|役場)$/, '').slice(-1);
  g.fillText(mark, pad + icon / 2, h / 2 + 2);
  g.fillStyle = '#ffffff';
  g.font = `700 ${font}px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(name, pad + icon + 14, h / 2 + 2);
  return canvas;
}

/** 公園名の看板：緑の角丸に白文字、左に木のマーク */
function drawParkSign(name: string): HTMLCanvasElement {
  const h = 84;
  const pad = 22;
  const icon = 52;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 44px ${FONT}`;
  const w = Math.ceil(pad + icon + 14 + measure.measureText(name).width + pad);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(38, 92, 30, 0.86)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 18);
  g.fill();
  g.strokeStyle = 'rgba(200, 232, 120, 0.9)';
  g.lineWidth = 4;
  g.stroke();
  // 木（丸い葉と幹）
  const cx = pad + icon / 2;
  g.fillStyle = '#8a5a2b';
  g.fillRect(cx - 4, h / 2 + 6, 8, 18);
  g.fillStyle = '#c8e878';
  g.beginPath();
  g.arc(cx, h / 2 - 4, 18, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = `700 44px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(name, pad + icon + 14, h / 2 + 2);
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
