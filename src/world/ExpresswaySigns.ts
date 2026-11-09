import * as THREE from 'three';
import { EXPRESSWAY_SIGNS as S } from '../core/config';
import { regionUrl } from '../core/region';
import type { Terrain } from './Terrain';

/** [向き（-1 左・0 まっすぐ・1 右）, 出口(0/1), 路線番号, 路線名, 路線名の英語, [[地名, 地名の英語], ...]] */
type Panel = [number, number, string, string, string, [string, string][]];
/** [緯度, 経度（1e-6度）, 進む向き（北から時計回り、0.1度）, 路面の地面からの高さ（0.1m）, 路面の半幅（0.1m）, 看板の中身] */
type SignData = [number, number, number, number, number, Panel[]];

interface Sign {
  lat: number;
  lon: number;
  heading: number;
  lift: number;
  panels: Panel[];
  /** 平らな地図上の位置（ローカル座標の x, z） */
  x: number;
  z: number;
  object: THREE.Group | null;
}

/** 路面を横に測った結果：真ん中からの左右の端までの距離 (m) と、その間の一番高い路面の高さ */
interface Deck {
  y: number;
  left: number;
  right: number;
  top: number;
}

/**
 * 高速道路の分岐の手前に立つ方面看板（門型の標識）。scripts/build-expressway-signs.mjs の public/expressway-signs.json。
 * 実物の方面看板にならって、方面ごとに緑の板を並べる（運転席から見て左から右へ）。板には路線番号と路線名の札、
 * 地名（日本語と英語）、大きな矢印、出口は「出口 EXIT」。
 * 柱は路面の外に立てる：看板を立てる時に、描いた高速の路面を横に測って端を見つける。
 * 板の下は、その間の一番高い路面から S.clearance m 上。近く（S.radius 以内）だけ作り、離れたら捨てる
 */
export class ExpresswaySigns {
  readonly group = new THREE.Group();
  private signs: Sign[] = [];
  private sinceRefresh = Infinity;
  private readonly raycaster = new THREE.Raycaster();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly origin = new THREE.Vector3();
  /** 門型の柱と梁（白い塗装の角柱） */
  private readonly frame = new THREE.MeshStandardMaterial({ color: 0xe9ecee, roughness: 0.55, metalness: 0.1 });
  private readonly back = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.7, metalness: 0.3 });
  private readonly post = new THREE.BoxGeometry(S.postSize, 1, S.postSize).translate(0, 0.5, 0);

  /**
   * @param deck 高速の路面（ExpresswayNetwork.group）。看板を路面の幅と高さに合わせて立てるのに使う
   */
  constructor(
    private readonly terrain: Terrain,
    private readonly deck: THREE.Object3D,
  ) {
    fetch(regionUrl('expressway-signs.json'))
      .then((res) => (res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<{ s: SignData[] }>) : null))
      .then((data) => {
        if (!data) return;
        this.signs = data.s.map(([lat, lon, heading, lift, , panels]) => {
          const p = this.terrain.toLocal(lat / 1e6, lon / 1e6, 0);
          return { lat: lat / 1e6, lon: lon / 1e6, heading: heading / 10, lift: lift / 10, panels, x: p.x, z: p.z, object: null };
        });
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

  /** (x, z) の真上から下ろして、高さ y の近く（±range）の路面（上を向いた面）。無ければ null */
  private surfaceNear(x: number, z: number, y: number, range: number): number | null {
    this.origin.set(x, y + 30, z);
    this.raycaster.set(this.origin, this.down);
    this.raycaster.far = 60;
    let best: number | null = null;
    for (const hit of this.raycaster.intersectObject(this.deck, true)) {
      if (!hit.face || hit.face.normal.y < 0.7) continue;
      const d = Math.abs(hit.point.y - y);
      if (d > range) continue;
      if (best === null || d < Math.abs(best - y)) best = hit.point.y;
    }
    return best;
  }

  /**
   * 横へ測る1点：高さ y の近く（±S.scanRise）の路面と、その上に壁（路面より S.scanRise〜3m 高い上向きの面：
   * 壁高欄・分離帯の上面）があるか。壁の下にも路面が続いていることがあるので、壁があればそこで止める
   */
  private probe(x: number, z: number, y: number): { surface: number | null; wall: boolean } {
    this.origin.set(x, y + 30, z);
    this.raycaster.set(this.origin, this.down);
    this.raycaster.far = 60;
    let surface: number | null = null;
    let wall = false;
    for (const hit of this.raycaster.intersectObject(this.deck, true)) {
      if (!hit.face || hit.face.normal.y < 0.7) continue;
      const d = hit.point.y - y;
      if (d > S.scanRise && d < 3) wall = true;
      else if (Math.abs(d) <= S.scanRise && (surface === null || Math.abs(d) < Math.abs(surface - y))) surface = hit.point.y;
    }
    return { surface, wall };
  }

  /**
   * 看板の所の路面を測る：真ん中の路面の高さ（見込み＝地面＋路面の地面からの高さに一番近い面）と、
   * そこから左右へ S.scanStep m ずつ、同じ高さの路面が続く所までの距離。まだ路面が無ければ null
   */
  private measure(s: Sign, right: THREE.Vector3): Deck | null {
    const ground = this.terrain.surfaceHeightAt(s.lat, s.lon);
    if (ground === null) return null;
    const expected = this.terrain.toLocal(s.lat, s.lon, ground + s.lift).y;
    const y = this.surfaceNear(s.x, s.z, expected, S.searchRange);
    if (y === null) return null;
    let top = y;
    const scan = (dir: number): number => {
      let edge = 0;
      let prev = y;
      for (let d = S.scanStep; d <= S.scanMax; d += S.scanStep) {
        const { surface: h, wall } = this.probe(s.x + right.x * d * dir, s.z + right.z * d * dir, prev);
        // 壁高欄・分離帯に当たった、または同じ高さの路面が途切れた（下の別の道は同じ高さにならない）
        if (wall || h === null) break;
        edge = d;
        prev = h;
        top = Math.max(top, h);
      }
      return edge;
    };
    const left = scan(-1);
    const rightEdge = scan(1);
    return { y, left, right: rightEdge, top };
  }

  private create(s: Sign): void {
    // 運転席から見た右（ローカル座標 +x=西, +z=北。進む向き θ の右は θ+90°）
    const h = s.heading * THREE.MathUtils.DEG2RAD;
    const right = new THREE.Vector3(-Math.cos(h), 0, -Math.sin(h));
    const deck = this.measure(s, right);
    if (!deck) return;

    const object = new THREE.Group();
    const n = s.panels.length;
    // 柱は路面の端（壁高欄）の外。板は路面の上いっぱいに、方面の数で分ける
    const roadWidth = deck.left + deck.right + S.scanStep;
    const panelWidth = THREE.MathUtils.clamp(roadWidth / n, S.minPanelWidth, S.maxPanelWidth);
    const boardsWidth = panelWidth * n;
    const middle = (deck.right - deck.left) / 2;
    const leftPost = Math.min(-deck.left - S.postMargin, middle - boardsWidth / 2 - S.postSize);
    const rightPost = Math.max(deck.right + S.postMargin, middle + boardsWidth / 2 + S.postSize);
    const bottom = deck.top - deck.y + S.clearance;
    const boardTop = bottom + S.boardHeight;
    const top = boardTop + 0.4;

    // 門型：左右の白い角柱と、上の太い梁
    for (const x of [leftPost, rightPost]) {
      const post = new THREE.Mesh(this.post, this.frame);
      post.scale.set(1, top + 1, 1);
      // 柱の足は路面より少し下から（縁の外で浮いて見えないように）
      post.position.set(x, -1, 0);
      object.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(rightPost - leftPost + S.postSize, S.beamHeight, S.postSize * 0.9), this.frame);
    beam.position.set((leftPost + rightPost) / 2, top - S.beamHeight / 2, 0);
    object.add(beam);

    // 方面ごとの緑の板を、梁の手前（運転席の側、+z）に間を空けて並べる。運転席から見て左から右へ（+x が右）
    const textures: THREE.Texture[] = [];
    const faces: THREE.Material[] = [];
    s.panels.forEach((panel, i) => {
      const width = panelWidth - S.boardGap;
      const canvas = drawBoard(panel, width, S.boardHeight);
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
      const board = new THREE.Mesh(new THREE.BoxGeometry(width, S.boardHeight, 0.12), [
        this.back,
        this.back,
        this.back,
        this.back,
        face,
        this.back,
      ]);
      board.position.set(middle + (i - (n - 1) / 2) * panelWidth, bottom + S.boardHeight / 2, S.postSize * 0.45 + 0.08);
      object.add(board);
      textures.push(texture);
      faces.push(face);
    });

    // 進む向きに向ける：板の +z を手前（上流）へ、+x を運転席から見て右へ
    object.rotation.y = Math.PI - h;
    object.position.set(s.x, deck.y, s.z);
    object.userData.textures = textures;
    object.userData.faces = faces;
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
    for (const t of object.userData.textures as THREE.Texture[]) t.dispose();
    for (const m of object.userData.faces as THREE.Material[]) m.dispose();
    s.object = null;
  }
}

const FONT = `system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
const GREEN = '#0b6e3f';
const WHITE = '#ffffff';

/**
 * 方面看板の1枚（1つの方面）の絵。実物の方面看板にならって、
 * - 大きな矢印を端に（左へ分かれる板は右端、右へ分かれる板とまっすぐは左端）
 * - 上の段：路線番号（白い枠に白い文字）と、路線名の札（白地に緑の文字、下に小さく英語）
 * - 真ん中：地名（大きく）と、その下に英語。2つあれば横に並べる
 * - 出口：下に「出口 EXIT」
 */
function drawBoard([side, exit, ref, route, routeEn, places]: Panel, width: number, height: number): HTMLCanvasElement {
  const pxPerM = 150;
  const w = Math.round(width * pxPerM);
  const h = Math.round(height * pxPerM);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = GREEN;
  g.beginPath();
  g.roundRect(0, 0, w, h, h * 0.04);
  g.fill();
  g.strokeStyle = WHITE;
  g.lineWidth = Math.max(4, h * 0.014);
  g.beginPath();
  g.roundRect(h * 0.025, h * 0.025, w - h * 0.05, h - h * 0.05, h * 0.03);
  g.stroke();
  g.textBaseline = 'middle';

  // 矢印（板の端）と、文字の場所（残り）
  const arrowW = h * 0.62;
  const arrowOnRight = side < 0;
  const arrowX = arrowOnRight ? w - arrowW / 2 - h * 0.05 : arrowW / 2 + h * 0.05;
  drawArrow(g, arrowX, h * (exit ? 0.46 : 0.52), h * 0.62, side);
  const left = arrowOnRight ? h * 0.07 : arrowW + h * 0.08;
  const right = arrowOnRight ? w - arrowW - h * 0.07 : w - h * 0.07;
  const cx = (left + right) / 2;
  const maxW = right - left;

  // 上の段：路線番号と路線名の札
  const hasRoute = !!(ref || route);
  if (hasRoute) drawRouteRow(g, ref, route, routeEn, cx, h * 0.19, h * 0.22, maxW);

  // 真ん中：地名（日本語と英語）
  const placeY = hasRoute ? h * 0.56 : exit ? h * 0.36 : h * 0.46;
  drawPlaces(g, places, cx, placeY, h * (hasRoute ? 0.21 : 0.26), maxW);

  // 下：出口
  if (exit) drawExit(g, cx, h * 0.82, h * 0.2);
  return canvas;
}

/** 文字の幅（px）。font を決めてから */
function textWidth(g: CanvasRenderingContext2D, text: string, font: string): number {
  g.font = font;
  return g.measureText(text).width;
}

/** 路線番号（白い枠）と路線名の札（白地に緑の文字、下に小さく英語）を横に並べる。(cx, y) が段の真ん中 */
function drawRouteRow(
  g: CanvasRenderingContext2D,
  ref: string,
  route: string,
  routeEn: string,
  cx: number,
  y: number,
  rowH: number,
  maxW: number,
): void {
  let k = 1;
  const layout = () => {
    const refFont = `800 ${rowH * 0.62 * k}px ${FONT}`;
    const nameFont = `800 ${rowH * (routeEn ? 0.52 : 0.66) * k}px ${FONT}`;
    const enFont = `700 ${rowH * 0.24 * k}px ${FONT}`;
    const refW = ref ? Math.max(rowH * 1.1 * k, textWidth(g, ref, refFont) + rowH * 0.45 * k) : 0;
    const plateW = route
      ? Math.max(textWidth(g, route, nameFont), routeEn ? textWidth(g, routeEn.toUpperCase(), enFont) : 0) + rowH * 0.5 * k
      : 0;
    const gap = ref && route ? rowH * 0.18 * k : 0;
    return { refFont, nameFont, enFont, refW, plateW, gap, total: refW + gap + plateW };
  };
  let l = layout();
  if (l.total > maxW) {
    k = maxW / l.total;
    l = layout();
  }
  const rh = rowH * k;
  let x = cx - l.total / 2;
  if (ref) {
    g.strokeStyle = WHITE;
    g.lineWidth = Math.max(3, rh * 0.08);
    g.beginPath();
    g.roundRect(x, y - rh / 2, l.refW, rh, rh * 0.16);
    g.stroke();
    g.fillStyle = WHITE;
    g.font = l.refFont;
    g.textAlign = 'center';
    g.fillText(ref, x + l.refW / 2, y + rh * 0.04);
    x += l.refW + l.gap;
  }
  if (route) {
    g.fillStyle = WHITE;
    g.beginPath();
    g.roundRect(x, y - rh / 2, l.plateW, rh, rh * 0.12);
    g.fill();
    g.fillStyle = GREEN;
    g.textAlign = 'center';
    g.font = l.nameFont;
    g.fillText(route, x + l.plateW / 2, routeEn ? y - rh * 0.12 : y + rh * 0.04);
    if (routeEn) {
      g.font = l.enFont;
      g.fillText(routeEn.toUpperCase(), x + l.plateW / 2, y + rh * 0.3);
    }
  }
}

/** 地名（大きく）と、その下に英語。2つあれば横に並べる。(cx, y) が日本語の行の真ん中 */
function drawPlaces(g: CanvasRenderingContext2D, places: [string, string][], cx: number, y: number, size: number, maxW: number): void {
  if (places.length === 0) return;
  let k = 1;
  const layout = () => {
    const jaFont = `800 ${size * k}px ${FONT}`;
    const enFont = `600 ${size * 0.4 * k}px ${FONT}`;
    const widths = places.map(([ja, en]) => Math.max(textWidth(g, ja, jaFont), en ? textWidth(g, en, enFont) : 0));
    const gap = size * 0.55 * k;
    return { jaFont, enFont, widths, gap, total: widths.reduce((a, b) => a + b, 0) + gap * (places.length - 1) };
  };
  let l = layout();
  if (l.total > maxW) {
    k = maxW / l.total;
    l = layout();
  }
  let x = cx - l.total / 2;
  g.fillStyle = WHITE;
  g.textAlign = 'center';
  places.forEach(([ja, en], i) => {
    const mid = x + l.widths[i] / 2;
    g.font = l.jaFont;
    g.fillText(ja, mid, y);
    if (en) {
      g.font = l.enFont;
      g.fillText(en, mid, y + size * 0.72 * k);
    }
    x += l.widths[i] + l.gap;
  });
}

/** 「出口 EXIT」（白い枠） */
function drawExit(g: CanvasRenderingContext2D, cx: number, y: number, rowH: number): void {
  const jaFont = `800 ${rowH * 0.62}px ${FONT}`;
  const enFont = `700 ${rowH * 0.3}px ${FONT}`;
  const w = Math.max(textWidth(g, '出口', jaFont), textWidth(g, 'EXIT', enFont)) + rowH * 0.9;
  g.strokeStyle = WHITE;
  g.lineWidth = Math.max(3, rowH * 0.07);
  g.beginPath();
  g.roundRect(cx - w / 2, y - rowH / 2, w, rowH, rowH * 0.14);
  g.stroke();
  g.fillStyle = WHITE;
  g.textAlign = 'center';
  g.font = jaFont;
  g.fillText('出口', cx, y - rowH * 0.12);
  g.font = enFont;
  g.fillText('EXIT', cx, y + rowH * 0.3);
}

/** 太い矢印（まっすぐ ↑・左 ↖・右 ↗）。(x, y) が真ん中、len が長さ */
function drawArrow(g: CanvasRenderingContext2D, x: number, y: number, len: number, side: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(side * (Math.PI / 4));
  g.fillStyle = WHITE;
  const shaft = len * 0.16;
  const head = len * 0.42;
  const headW = len * 0.56;
  g.beginPath();
  g.moveTo(-shaft / 2, len / 2);
  g.lineTo(-shaft / 2, -len / 2 + head);
  g.lineTo(-headW / 2, -len / 2 + head);
  g.lineTo(0, -len / 2);
  g.lineTo(headW / 2, -len / 2 + head);
  g.lineTo(shaft / 2, -len / 2 + head);
  g.lineTo(shaft / 2, len / 2);
  g.closePath();
  g.fill();
  g.restore();
}
