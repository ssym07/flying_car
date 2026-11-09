import * as THREE from 'three';
import { EXPRESSWAY_SIGNS as S } from '../core/config';
import { regionUrl } from '../core/region';
import type { Terrain } from './Terrain';

/** [向き（-1 左・0 まっすぐ・1 右）, 路線番号, 方面1, 方面2, 出口(0/1)] */
type Panel = [number, string, string, string, number];
/** [緯度, 経度（1e-6度）, 進む向き（北から時計回り、0.1度）, 路面の地面からの高さ（0.1m）, 路面の半幅（0.1m）, 看板の中身] */
type SignData = [number, number, number, number, number, Panel[]];

interface Sign {
  lat: number;
  lon: number;
  heading: number;
  lift: number;
  half: number;
  panels: Panel[];
  /** 平らな地図上の位置（ローカル座標の x, z） */
  x: number;
  z: number;
  object: THREE.Group | null;
  /** 路面が見つからなかった（まだ高速のタイルを読んでいない）。次の見直しでまた探す */
  waiting: boolean;
}

/**
 * 高速道路の分岐の手前に立つ方面看板（門型の標識）。scripts/build-expressway-signs.mjs の public/expressway-signs.json。
 * 緑の板に白い文字で、分かれる道ごとに「路線番号・方面・矢印」（出口は「出口」）を、運転席から見て左から右へ並べる。
 * 近く（S.radius 以内）だけ作り、離れたら捨てる。高さは高速の路面に上から光線を当てて決める（描いた路面にぴったり立つ）
 */
export class ExpresswaySigns {
  readonly group = new THREE.Group();
  private signs: Sign[] = [];
  private sinceRefresh = Infinity;
  private readonly raycaster = new THREE.Raycaster();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly origin = new THREE.Vector3();
  private readonly metal = new THREE.MeshStandardMaterial({ color: 0x9ea4aa, roughness: 0.5, metalness: 0.6 });
  private readonly back = new THREE.MeshStandardMaterial({ color: 0x6f757b, roughness: 0.7, metalness: 0.3 });
  private readonly post = new THREE.CylinderGeometry(0.22, 0.26, 1, 10).translate(0, 0.5, 0);

  /**
   * @param deck 高速の路面（ExpresswayNetwork.group）。看板を路面の高さに立てるのに使う
   */
  constructor(
    private readonly terrain: Terrain,
    private readonly deck: THREE.Object3D,
  ) {
    fetch(regionUrl('expressway-signs.json'))
      .then((res) => (res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<{ s: SignData[] }>) : null))
      .then((data) => {
        if (!data) return;
        this.signs = data.s.map(([lat, lon, heading, lift, half, panels]) => ({
          lat: lat / 1e6,
          lon: lon / 1e6,
          heading: heading / 10,
          lift: lift / 10,
          half: half / 10,
          panels,
          x: 0,
          z: 0,
          object: null,
          waiting: false,
        }));
        for (const s of this.signs) {
          const p = this.terrain.toLocal(s.lat, s.lon, 0);
          s.x = p.x;
          s.z = p.z;
        }
      })
      .catch((e) => console.warn('[ExpresswaySigns] 読込に失敗しました', e));
  }

  /** 毎フレーム呼ぶ（作る・捨てるの見直しは数回/秒） */
  update(camera: THREE.Camera, dt: number): void {
    this.sinceRefresh += dt;
    if (this.sinceRefresh < 0.5) return;
    this.sinceRefresh = 0;
    const { x, z } = camera.position;
    for (const s of this.signs) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (s.object && d > S.radius * 1.2) this.remove(s);
      else if (!s.object && d < S.radius) this.create(s);
    }
  }

  dispose(): void {
    for (const s of this.signs) if (s.object) this.remove(s);
    this.post.dispose();
  }

  /** 看板の所の高速の路面の高さ。見込み（地面＋路面の地面からの高さ）に一番近い路面。まだ無ければ null */
  private deckHeight(s: Sign): number | null {
    const ground = this.terrain.surfaceHeightAt(s.lat, s.lon);
    if (ground === null) return null;
    const expected = this.terrain.toLocal(s.lat, s.lon, ground + s.lift).y;
    this.origin.set(s.x, expected + 40, s.z);
    this.raycaster.set(this.origin, this.down);
    this.raycaster.far = 80;
    let best: number | null = null;
    for (const hit of this.raycaster.intersectObject(this.deck, true)) {
      // 路面（上を向いた面）だけ
      if (hit.face && hit.face.normal.y < 0.5) continue;
      if (Math.abs(hit.point.y - expected) > S.searchRange) continue;
      if (best === null || Math.abs(hit.point.y - expected) < Math.abs(best - expected)) best = hit.point.y;
    }
    return best;
  }

  private create(s: Sign): void {
    const y = this.deckHeight(s);
    if (y === null) {
      s.waiting = true;
      return;
    }
    s.waiting = false;
    const object = new THREE.Group();
    const n = s.panels.length;
    const panelWidth = THREE.MathUtils.clamp((s.half * 2) / n, S.minPanelWidth, S.maxPanelWidth);
    const boardWidth = panelWidth * n;
    const span = Math.max(s.half, boardWidth / 2) + S.postMargin;
    const top = S.clearance + S.boardHeight + 0.3;

    // 柱（左右）と、板を支える横の梁（上下2本）
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(this.post, this.metal);
      post.scale.set(1, top, 1);
      post.position.x = side * span;
      object.add(post);
    }
    for (const h of [S.clearance + S.boardHeight * 0.2, S.clearance + S.boardHeight * 0.8]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.22, 0.22), this.metal);
      beam.position.set(0, h, -0.25);
      object.add(beam);
    }

    // 板：手前（運転席の側、+z）に方面の絵。横・後ろは灰色
    const canvas = drawBoard(s.panels, panelWidth, S.boardHeight);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const face = new THREE.MeshStandardMaterial({
      map: texture,
      // 夕方でも読めるよう、反射材のように少し明るく
      emissive: 0xffffff,
      emissiveMap: texture,
      emissiveIntensity: S.glow,
      roughness: 0.6,
    });
    const board = new THREE.Mesh(new THREE.BoxGeometry(boardWidth, S.boardHeight, 0.12), [
      this.back,
      this.back,
      this.back,
      this.back,
      face,
      this.back,
    ]);
    board.position.set(0, S.clearance + S.boardHeight / 2, 0);
    object.add(board);

    // 進む向きに向ける：板の +z を手前（上流）へ、+x を運転席から見て右へ（ローカル座標は +x=西, +z=北）
    object.rotation.y = Math.PI - s.heading * THREE.MathUtils.DEG2RAD;
    object.position.set(s.x, y, s.z);
    object.userData.texture = texture;
    object.userData.face = face;
    s.object = object;
    this.group.add(object);
  }

  private remove(s: Sign): void {
    const object = s.object!;
    this.group.remove(object);
    object.traverse((o) => {
      // 柱の形は共有なので捨てない
      if (o instanceof THREE.Mesh && o.geometry !== this.post) o.geometry.dispose();
    });
    (object.userData.texture as THREE.Texture).dispose();
    (object.userData.face as THREE.Material).dispose();
    s.object = null;
  }
}

const FONT = `system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
const GREEN = '#0b7a46';

/** 方面看板の絵。分かれる道ごとの区画を左から右へ。区画の中は、上に路線番号（出口は「出口」）、真ん中に方面、下に矢印 */
function drawBoard(panels: Panel[], panelWidth: number, height: number): HTMLCanvasElement {
  const pxPerM = 96;
  const pw = Math.round(panelWidth * pxPerM);
  const h = Math.round(height * pxPerM);
  const canvas = document.createElement('canvas');
  canvas.width = pw * panels.length;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = GREEN;
  g.fillRect(0, 0, canvas.width, h);
  // 縁と区画の境の白い線
  g.strokeStyle = '#ffffff';
  g.lineWidth = 8;
  g.strokeRect(8, 8, canvas.width - 16, h - 16);
  for (let i = 1; i < panels.length; i++) {
    g.beginPath();
    g.moveTo(i * pw, 16);
    g.lineTo(i * pw, h - 16);
    g.stroke();
  }
  panels.forEach((panel, i) => drawPanel(g, panel, i * pw, pw, h));
  return canvas;
}

function drawPanel(g: CanvasRenderingContext2D, [side, ref, name1, name2, exit]: Panel, x0: number, w: number, h: number): void {
  const cx = x0 + w / 2;
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  // 上：路線番号（白地に緑の文字）、出口は「出口」
  const tagH = h * 0.15;
  const tagY = h * 0.07;
  const tag = exit ? '出口' : ref;
  if (tag) {
    g.font = `800 ${tagH * 0.78}px ${FONT}`;
    const tw = Math.max(tagH * 1.6, g.measureText(tag).width + tagH * 0.7);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(cx - tw / 2, tagY, tw, tagH, tagH * 0.2);
    g.fill();
    g.fillStyle = GREEN;
    g.fillText(tag, cx, tagY + tagH / 2 + 2);
  }

  // 真ん中：方面（1〜2行。幅に収まるよう文字を小さくする）
  const names = [name1, name2].filter(Boolean);
  const lineH = names.length > 1 ? h * 0.25 : h * 0.32;
  const top = h * 0.27;
  names.forEach((name, i) => {
    let size = lineH * 0.9;
    g.font = `800 ${size}px ${FONT}`;
    const max = w * 0.88;
    const width = g.measureText(name).width;
    if (width > max) {
      size *= max / width;
      g.font = `800 ${size}px ${FONT}`;
    }
    g.fillStyle = '#ffffff';
    g.fillText(name, cx, top + lineH * (i + 0.5));
  });

  // 下：矢印（まっすぐ ↑・左 ↖・右 ↗）
  const ay = h * 0.86;
  const len = h * 0.18;
  g.save();
  g.translate(cx, ay);
  g.rotate(side * (Math.PI / 4));
  g.fillStyle = '#ffffff';
  g.beginPath();
  const shaft = len * 0.16;
  const head = len * 0.42;
  g.moveTo(-shaft / 2, len / 2);
  g.lineTo(-shaft / 2, -len / 2 + head);
  g.lineTo(-head * 0.7, -len / 2 + head);
  g.lineTo(0, -len / 2);
  g.lineTo(head * 0.7, -len / 2 + head);
  g.lineTo(shaft / 2, -len / 2 + head);
  g.lineTo(shaft / 2, len / 2);
  g.closePath();
  g.fill();
  g.restore();
}
