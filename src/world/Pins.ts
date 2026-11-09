import * as THREE from 'three';
import { PINS } from '../core/config';
import { pinHex, type Pin } from '../data/pins';
import type { Terrain } from './Terrain';

interface Shown {
  pin: Pin;
  object: THREE.Group;
  /** 針と頭（大きさを距離で変える） */
  body: THREE.Group;
  sign: THREE.Sprite;
  texture: THREE.CanvasTexture;
  aspect: number;
  /** 置く場所が決まったか（高さの分からないピンは、地形を読むまで出さない） */
  placed: boolean;
}

/** ピンの形（高さ 1。先が原点で上へ伸びる） */
const NEEDLE = new THREE.CylinderGeometry(0.035, 0.004, 0.68, 10).translate(0, 0.34, 0);
const HEAD = new THREE.SphereGeometry(0.17, 20, 14).translate(0, 0.8, 0);
/** 頭の材質（色ごとに共有） */
const headMaterials = new Map<string, THREE.MeshStandardMaterial>();
function headMaterial(hex: string): THREE.MeshStandardMaterial {
  let m = headMaterials.get(hex);
  if (!m) {
    const color = new THREE.Color(hex);
    // 夕方の暗い街でも色が分かるよう、少し自ら光らせる
    m = new THREE.MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.3), roughness: 0.35, metalness: 0.1 });
    headMaterials.set(hex, m);
  }
  return m;
}
const NEEDLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.3, metalness: 0.8 });

/**
 * 保存した地点に立てるピン（赤い頭の待ち針）と、その上に浮かぶ名前の札（常にカメラを向く）。
 * ピンは実寸 PINS.size（m）で一律。遠くからは名前の札で分かる（札は画面上の大きさをおおよそ一定にする）。
 * 札は建物に隠れても見えるよう最後に重ねて描く。PINS.radius より遠いピンは出さない
 */
export class Pins {
  readonly group = new THREE.Group();
  private readonly shown = new Map<string, Shown>();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly terrain: Terrain) {}

  /** 出すピン（今の地域のもの）。前と同じものは作り直さない */
  set(pins: readonly Pin[]): void {
    const keep = new Set<string>();
    for (const pin of pins) {
      const old = this.shown.get(pin.id);
      if (old && old.pin.name === pin.name && old.pin.color === pin.color) {
        keep.add(pin.id);
        continue;
      }
      if (old) this.remove(old);
      this.create(pin);
      keep.add(pin.id);
    }
    for (const [id, s] of this.shown) if (!keep.has(id)) this.remove(s);
  }

  /** 毎フレーム：大きさと濃さ */
  update(camera: THREE.PerspectiveCamera): void {
    const { radius, size, signSize } = PINS;
    const tanHalf = Math.tan((camera.fov * THREE.MathUtils.DEG2RAD) / 2);
    for (const s of this.shown.values()) {
      if (!s.placed && !this.locate(s)) continue;
      const p = s.object.position;
      const flat = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
      s.object.visible = flat < radius;
      if (!s.object.visible) continue;
      const height = size;
      s.body.scale.setScalar(height);

      const signDistance = camera.position.distanceTo(s.sign.getWorldPosition(this.tmp));
      const h = signSize * signDistance * 2 * tanHalf;
      s.sign.position.y = height * 0.98;
      s.sign.scale.set(h * s.aspect, h, 1);
      const opacity = 1 - THREE.MathUtils.smoothstep(flat, radius * 0.75, radius);
      s.sign.material.opacity = opacity;
    }
  }

  dispose(): void {
    for (const s of [...this.shown.values()]) this.remove(s);
  }

  /** 置く場所を決める。高さの分からないピンは地形の面に立てる（まだ地形が無ければ false） */
  private locate(s: Shown): boolean {
    const { lat, lon, elevation } = s.pin;
    const height = elevation ?? this.terrain.surfaceHeightAt(lat, lon);
    if (height === null) {
      s.object.visible = false;
      return false;
    }
    this.terrain.toLocal(lat, lon, height, s.object.position);
    s.placed = true;
    return true;
  }

  private create(pin: Pin): void {
    const body = new THREE.Group();
    const needle = new THREE.Mesh(NEEDLE, NEEDLE_MATERIAL);
    const head = new THREE.Mesh(HEAD, headMaterial(pinHex(pin)));
    for (const m of [needle, head]) m.userData.noShadow = true;
    body.add(needle, head);

    const canvas = drawPinSign(pin.name, pinHex(pin));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const sign = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, fog: false }),
    );
    // 駅名の看板と同じく、建物に隠れても見えるように最後に重ねて描く
    sign.renderOrder = 11;
    // 札の下の三角の先を、ピンの頭の上に合わせる
    sign.center.set(0.5, 0);

    const object = new THREE.Group();
    object.add(body, sign);
    object.visible = false;
    this.group.add(object);
    this.shown.set(pin.id, { pin, object, body, sign, texture, aspect: canvas.width / canvas.height, placed: false });
  }

  private remove(s: Shown): void {
    this.group.remove(s.object);
    s.texture.dispose();
    s.sign.material.dispose();
    this.shown.delete(s.pin.id);
  }
}

const FONT = `system-ui, -apple-system, 'Hiragino Sans', sans-serif`;

/** 名前の札：白地の角丸に濃い文字、左にピンの色の丸（ピンの頭）、下に小さな三角（ピンを指す） */
function drawPinSign(name: string, hex: string): HTMLCanvasElement {
  const body = 92;
  const tail = 16;
  const pad = 26;
  const dot = 30;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 48px ${FONT}`;
  const w = Math.ceil(pad + dot + 16 + measure.measureText(name).width + pad);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = body + tail;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(255, 255, 255, 0.94)';
  g.beginPath();
  g.roundRect(2, 2, w - 4, body - 4, 22);
  g.moveTo(w / 2 - 14, body - 3);
  g.lineTo(w / 2, body + tail - 2);
  g.lineTo(w / 2 + 14, body - 3);
  g.fill();
  // 白いピンは白地に溶けるので、縁は灰色にする
  const edge = hex.toLowerCase() === '#f5f5f5' ? '#9aa3ad' : hex;
  g.strokeStyle = edge;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(2, 2, w - 4, body - 4, 22);
  g.stroke();
  g.fillStyle = hex;
  g.beginPath();
  g.arc(pad + dot / 2, body / 2, dot / 2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = edge === hex ? 'rgba(0, 0, 0, 0.25)' : edge;
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = '#1b2430';
  g.font = `700 48px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(name, pad + dot + 16, body / 2 + 2);
  return canvas;
}
