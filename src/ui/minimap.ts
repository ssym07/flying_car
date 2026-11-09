import { LOCATION, MINIMAP } from '../core/config';
import { describeStation, nearestStation } from '../world/places';
import { reverseGeocode } from './geocode';
import { ROAD_LABELS as roadLabels } from '../data/regionData';
import { lonLatToTile } from '../world/Terrain';

const TILE_PX = 256;

/** 通り名ラベル：ズーム 0 の地図全体での px 座標と、文字を置く角度（キャンバス上、右向きが 0） */
interface RoadLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

/** ズーム 0 での地図全体の px 座標 */
interface WorldPx {
  x: number;
  y: number;
}

/** ミニマップに出す保存したピン */
interface MapPin extends WorldPx {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** ピンの色（#rrggbb） */
  color: string;
  /** 最後に描いたキャンバスの px 座標と、地図の中だったか（縁に寄せていないか） */
  sx: number;
  sy: number;
  inside: boolean;
}

export interface MinimapOptions {
  /** 「ここへ行く」 */
  onVisit: (lat: number, lon: number) => void;
  /** 「この地点を保存」（name は地名。保存した後に名前を入れ直してもらう） */
  onSave: (lat: number, lon: number, name: string) => void;
}

/** ミニマップの大きさと、出しているか（見る人ごとの好み。ブラウザに覚えておく） */
const SETTINGS_KEY = 'sky-drive.minimap';

function loadSettings(): { width: number; height: number; visible: boolean } {
  const fallback = { width: MINIMAP.size, height: MINIMAP.size, visible: true };
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<typeof fallback> | null;
    if (!v) return fallback;
    return {
      width: Number.isFinite(v.width) ? v.width! : fallback.width,
      height: Number.isFinite(v.height) ? v.height! : fallback.height,
      visible: v.visible !== false,
    };
  } catch {
    return fallback;
  }
}

function toWorldPx(lat: number, lon: number): WorldPx {
  const t = lonLatToTile(lon, lat, 0);
  return { x: t.x * TILE_PX, y: t.y * TILE_PX };
}

/** 今の拡大率での地図の描き方 */
interface View {
  /** 読む地図タイルのズーム */
  tileZoom: number;
  /** 現在地の、タイルズームでの地図全体の px 座標 */
  cx: number;
  cy: number;
  /** 地図 1px をキャンバスの何 px で描くか */
  scale: number;
}

/**
 * 画面左上のミニマップ（「地図」のボタンで出す・しまう。右下の角をドラッグで大きさを変える）。進行方向が上で、中心が現在地（地図を回す）。北の向きは縁の「N」で示す。
 * 地図は国土地理院の淡色地図を CSS フィルタで暗くして、街の配色に合わせる。
 * 地図と、通り名・矢印は別のキャンバスに描く（フィルタが文字や矢印にかからないように）。
 * 右上の ＋/− ボタンか、ミニマップの上でのホイールで拡大率を変えられる。
 * ドラッグで地図をずらして探索できる（右上の ◎ で現在地に戻る）。押すと仮のピン、右クリックで「ここへ行く」「この地点を保存」
 */
export class Minimap {
  private readonly root: HTMLDivElement;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly markerCtx: CanvasRenderingContext2D;
  /** 読込済み・読込中のタイル（失敗したものは null） */
  private readonly tiles = new Map<string, ImageBitmap | null | 'loading'>();
  private readonly pixelRatio = Math.min(window.devicePixelRatio, 2);
  private readonly labels: RoadLabel[];
  /** 保存したピン（x, y はズーム 0 での px 座標、sx, sy は最後に描いたキャンバスの px 座標） */
  private pins: MapPin[] = [];
  /** クリックで刺した仮のピン */
  private pick: (WorldPx & { lat: number; lon: number; sx: number; sy: number; name: string; address: string; station: string }) | null =
    null;
  private pickId = 0;
  private hovered: MapPin | null = null;
  /** 画面上の大きさ（CSS px）。MINIMAP.size から路線図の大きさ（MINIMAP.maxWidth × maxHeight）まで */
  private width: number;
  private height: number;
  private readonly canvases: HTMLCanvasElement[];
  private readonly toggleButton: HTMLButtonElement;
  /** ドラッグで探索している時の地図の中心（ズーム 0 での px 座標）。null なら現在地 */
  private panCenter: WorldPx | null = null;
  /** 最後に描いた時の現在地（ズーム 0 での px 座標） */
  private here: WorldPx | null = null;
  private readonly hereButton: HTMLButtonElement;
  /** ドラッグ中（押した位置からの動き。少しでも動いたらクリックにしない） */
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  /** 直前の押して離したのがドラッグだった（その click を無視する） */
  private dragged = false;
  /** 最後に描いた時の地図の描き方と進行方向（クリックの位置を緯度経度にする） */
  private view: View | null = null;
  private bearing = 0;
  /** 仮のピンの地名の吹き出し・保存したピンの名前（カーソルを合わせた時） */
  private readonly placeEl: HTMLDivElement;
  private readonly tipEl: HTMLDivElement;
  private menu: HTMLDivElement | null = null;
  private menuCleanup: (() => void) | null = null;
  private readonly textWidths = new Map<string, number>();
  private readonly scaleLabel: HTMLDivElement;
  private readonly north: HTMLDivElement;
  /** 表示の拡大率（地図タイルのズームと同じ尺度。小数も可） */
  private zoom = MINIMAP.zoom;

  constructor(
    private readonly parent: HTMLElement,
    private readonly options: MinimapOptions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    const saved = loadSettings();
    this.width = saved.width;
    this.height = saved.height;
    const map = this.createCanvas('minimap-map');
    const marker = this.createCanvas('minimap-marker');
    this.mapCtx = map.getContext('2d')!;
    this.markerCtx = marker.getContext('2d')!;
    this.canvases = [map, marker];
    const north = document.createElement('div');
    north.className = 'minimap-north';
    north.textContent = 'N';
    this.north = north;
    const controls = document.createElement('div');
    controls.className = 'minimap-zoom';
    controls.innerHTML = `<button type="button" data-zoom="1" aria-label="拡大">＋</button><button type="button" data-zoom="-1" aria-label="縮小">−</button><button type="button" data-here aria-label="現在地に戻る" title="現在地に戻る" hidden>◎</button>`;
    this.hereButton = controls.querySelector('[data-here]')!;
    controls.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      if (button.dataset.here !== undefined) this.setPan(null);
      else this.changeZoom(Number(button.dataset.zoom) * MINIMAP.zoomStep);
    });
    this.scaleLabel = document.createElement('div');
    this.scaleLabel.className = 'minimap-scale';
    this.placeEl = document.createElement('div');
    this.placeEl.className = 'minimap-place';
    this.placeEl.hidden = true;
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'minimap-tip';
    this.tipEl.hidden = true;
    const grip = document.createElement('div');
    grip.className = 'minimap-resize';
    grip.title = 'ドラッグで大きさを変える';
    this.root.append(map, marker, north, controls, this.scaleLabel, this.placeEl, this.tipEl, grip);
    this.bindPointer();
    this.bindResize(grip);

    // 表示・非表示のボタン（路線図と同じ）
    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'minimap-toggle';
    this.toggleButton.textContent = '地図';
    this.toggleButton.title = 'ミニマップを出す・しまう';
    this.toggleButton.addEventListener('click', () => this.setVisible(this.root.hidden));
    parent.appendChild(this.toggleButton);
    this.setSize(this.width, this.height);
    this.setVisible(saved.visible);
    // ミニマップの上のホイールは拡大率に使う（カメラの距離は変えない）
    this.root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.changeZoom((-e.deltaY / 100) * MINIMAP.zoomStep);
      },
      { passive: false },
    );
    parent.appendChild(this.root);
    this.labels = prepareLabels();
  }

  /**
   * @param lat 現在地の緯度（度）
   * @param lon 現在地の経度（度）
   * @param bearing 進行方向（北から時計回り、ラジアン）
   */
  update(lat: number, lon: number, bearing: number): void {
    if (this.root.hidden) return;
    // 拡大率に近い（少し細かい）ズームのタイルを読み、縮めて描く
    const tileZoom = Math.min(MINIMAP.maxTileZoom, Math.ceil(this.zoom - 1e-6));
    // ドラッグで探索している間は、ずらした場所を中心にする（飛んでも動かない）
    this.here = toWorldPx(lat, lon);
    const center = this.panCenter ?? this.here;
    const view: View = {
      tileZoom,
      cx: center.x * 2 ** tileZoom,
      cy: center.y * 2 ** tileZoom,
      scale: this.pixelRatio * 2 ** (this.zoom - tileZoom),
    };
    this.drawMap(view, bearing);
    this.markerCtx.clearRect(0, 0, this.markerCtx.canvas.width, this.markerCtx.canvas.height);
    if (this.zoom >= MINIMAP.labelMinZoom) this.drawLabels(view, bearing);
    this.view = view;
    this.bearing = bearing;
    this.drawPins();
    this.drawPick();
    this.drawMarker();
    this.updateScaleLabel(lat);
    // 「N」は縁の、北の向きに置く
    // 縁（内側 14px の長方形）と、中心から北への向きの交わる所
    const nx = -Math.sin(bearing);
    const ny = -Math.cos(bearing);
    const t = Math.min((this.width / 2 - 14) / Math.max(Math.abs(nx), 1e-6), (this.height / 2 - 14) / Math.max(Math.abs(ny), 1e-6));
    this.north.style.left = `${this.width / 2 + nx * t}px`;
    this.north.style.top = `${this.height / 2 + ny * t}px`;
  }

  /** 地図に出すピン（今の地域の保存した地点） */
  setPins(pins: ReadonlyArray<{ id: string; name: string; lat: number; lon: number; color: string }>): void {
    this.pins = pins.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, color: p.color, ...toWorldPx(p.lat, p.lon), sx: 0, sy: 0, inside: false }));
  }

  /** ズーム 0 での px 座標 → キャンバスの px 座標（中心が現在地、進行方向が上） */
  private project(x: number, y: number): { x: number; y: number } {
    const { tileZoom, cx, cy, scale } = this.view!;
    const world = 2 ** tileZoom;
    const ux = (x * world - cx) * scale;
    const uy = (y * world - cy) * scale;
    const cos = Math.cos(-this.bearing);
    const sin = Math.sin(-this.bearing);
    const { width: w, height: h } = this.markerCtx.canvas;
    return { x: ux * cos - uy * sin + w / 2, y: ux * sin + uy * cos + h / 2 };
  }

  /** キャンバスの px 座標 → 緯度経度（project の逆） */
  private unproject(sx: number, sy: number): { lat: number; lon: number } {
    const { tileZoom, cx, cy, scale } = this.view!;
    const { width: w, height: h } = this.markerCtx.canvas;
    const dx = sx - w / 2;
    const dy = sy - h / 2;
    const cos = Math.cos(this.bearing);
    const sin = Math.sin(this.bearing);
    const world = 2 ** tileZoom;
    const x = (cx + (dx * cos - dy * sin) / scale) / world / TILE_PX;
    const y = (cy + (dx * sin + dy * cos) / scale) / world / TILE_PX;
    const lon = x * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
    return { lat, lon };
  }

  /** 保存したピン：赤い丸。地図の外のものは縁に寄せて小さく出す（どちらの方にあるか分かるように） */
  private drawPins(): void {
    const ctx = this.markerCtx;
    const { width: w, height: h } = ctx.canvas;
    const r = this.pixelRatio;
    const ex = w / 2 - 8 * r;
    const ey = h / 2 - 8 * r;
    for (const p of this.pins) {
      const q = this.project(p.x, p.y);
      let sx = q.x - w / 2;
      let sy = q.y - h / 2;
      const outside = Math.abs(sx) > ex || Math.abs(sy) > ey;
      if (outside) {
        const k = Math.min(ex / Math.max(Math.abs(sx), 1e-6), ey / Math.max(Math.abs(sy), 1e-6));
        sx *= k;
        sy *= k;
      }
      p.sx = sx + w / 2;
      p.sy = sy + h / 2;
      p.inside = !outside;
      const hovered = p === this.hovered;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, (outside ? 3.5 : hovered ? 8 : 6) * r, 0, Math.PI * 2);
      ctx.globalAlpha = outside ? 0.75 : 1;
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2 * r;
      // 白いピンは縁を濃くする
      ctx.strokeStyle = p.color.toLowerCase() === '#f5f5f5' ? '#1b2430' : '#ffffff';
      ctx.stroke();
    }
  }

  /** クリックで刺した仮のピン：黄色い待ち針（先が地点） */
  private drawPick(): void {
    const pick = this.pick;
    if (!pick) return;
    const ctx = this.markerCtx;
    const r = this.pixelRatio;
    const q = this.project(pick.x, pick.y);
    pick.sx = q.x;
    pick.sy = q.y;
    const visible = q.x >= 0 && q.y >= 0 && q.x <= ctx.canvas.width && q.y <= ctx.canvas.height;
    this.placeEl.hidden = !visible;
    if (!visible) return;
    const len = 18 * r;
    ctx.beginPath();
    ctx.moveTo(q.x, q.y);
    ctx.lineTo(q.x, q.y - len);
    ctx.lineWidth = 2 * r;
    ctx.strokeStyle = '#f5f7fa';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(q.x, q.y - len, 6 * r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb300';
    ctx.fill();
    ctx.lineWidth = 2 * r;
    ctx.strokeStyle = '#1b2430';
    ctx.stroke();
    // 地名の吹き出しはピンの上（CSS の px）。上の縁に近い時はピンの下に出し、左右ははみ出さないよう寄せる
    this.placeBubble(this.placeEl, q.x / r, (q.y - len) / r - 10, q.y / r + 8);
  }

  /** 吹き出しを (x, above) の上に置く。ミニマップの上にはみ出す時は (x, below) の下に置く（CSS の px） */
  private placeBubble(el: HTMLElement, x: number, above: number, below: number): void {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(x - w / 2, 4), this.width - w - 4);
    const top = above - h < 4 ? below : above - h;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** マウスの位置（ミニマップの中の CSS px）→ キャンバスの px */
  private canvasPoint(e: MouseEvent): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * this.pixelRatio, y: (e.clientY - rect.top) * this.pixelRatio };
  }

  /** マウスの近く（9px 以内）の、地図の中の保存したピン */
  private pinAt(x: number, y: number): MapPin | null {
    let best: MapPin | null = null;
    let bestD = 9 * this.pixelRatio;
    for (const p of this.pins) {
      if (!p.inside) continue;
      const d = Math.hypot(p.sx - x, p.sy - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** 仮のピンの頭の近く（10px 以内）か */
  private onPick(x: number, y: number): boolean {
    const pick = this.pick;
    return !!pick && Math.hypot(pick.sx - x, pick.sy - 18 * this.pixelRatio - y) < 10 * this.pixelRatio;
  }

  /** 大きさを変える（CSS px。最小 MINIMAP.size、最大は路線図の大きさと画面に収まる高さ） */
  private setSize(width: number, height: number): void {
    const top = this.root.offsetTop || MINIMAP.top;
    const maxHeight = Math.max(MINIMAP.size, Math.min(MINIMAP.maxHeight, window.innerHeight - top - MINIMAP.bottomMargin));
    this.width = Math.round(Math.min(MINIMAP.maxWidth, Math.max(MINIMAP.size, width)));
    this.height = Math.round(Math.min(maxHeight, Math.max(MINIMAP.size, height)));
    this.root.style.width = `${this.width}px`;
    this.root.style.height = `${this.height}px`;
    for (const c of this.canvases) {
      c.width = Math.round(this.width * this.pixelRatio);
      c.height = Math.round(this.height * this.pixelRatio);
    }
  }

  private setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.toggleButton.classList.toggle('active', visible);
    if (!visible) {
      this.closeMenu();
      this.tipEl.hidden = true;
    }
    this.saveSettings();
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ width: this.width, height: this.height, visible: !this.root.hidden }));
    } catch {
      // 覚えておけなくても使える
    }
  }

  /** 右下の角をドラッグして大きさを変える（左上は動かさない） */
  private bindResize(grip: HTMLElement): void {
    let start: { id: number; x: number; y: number; w: number; h: number } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 地図のドラッグ（探索）にしない
      e.stopPropagation();
      e.preventDefault();
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, w: this.width, h: this.height };
      grip.setPointerCapture(e.pointerId);
      this.root.classList.add('resizing');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start || start.id !== e.pointerId) return;
      this.setSize(start.w + e.clientX - start.x, start.h + e.clientY - start.y);
    });
    const end = (e: PointerEvent) => {
      if (!start || start.id !== e.pointerId) return;
      start = null;
      this.root.classList.remove('resizing');
      this.saveSettings();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
    // 押した後の click で仮のピンを刺さない
    grip.addEventListener('click', (e) => e.stopPropagation());
  }

  private setPan(center: WorldPx | null): void {
    this.panCenter = center;
    this.hereButton.hidden = center === null;
  }

  private bindPointer(): void {
    const isControl = (e: Event) => (e.target as HTMLElement).closest('button') !== null;
    // ドラッグ：地図をずらして探索する（進行方向が上のまま。押して 4px 以上動いたらドラッグ）
    this.root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isControl(e) || !this.view) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      this.dragged = false;
    });
    this.root.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId || !this.view) return;
      if (e.buttons === 0) {
        this.drag = null;
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        this.root.setPointerCapture(e.pointerId);
        this.root.classList.add('dragging');
        this.tipEl.hidden = true;
      }
      d.x = e.clientX;
      d.y = e.clientY;
      // 画面の動き（CSS px）→ 地図の動き（ズーム 0 の px）。地図は -bearing 回して描いているので、bearing 回して戻す
      const { tileZoom, scale } = this.view;
      const k = this.pixelRatio / scale / 2 ** tileZoom;
      const cos = Math.cos(this.bearing);
      const sin = Math.sin(this.bearing);
      const c = this.panCenter ?? this.here!;
      this.setPan({ x: c.x - (dx * cos - dy * sin) * k, y: c.y - (dx * sin + dy * cos) * k });
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.dragged = d.moved;
      this.drag = null;
      this.root.classList.remove('dragging');
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
    this.root.addEventListener('lostpointercapture', end);
    this.root.addEventListener('mousemove', (e) => {
      if (!this.view || this.drag?.moved) return;
      const p = this.canvasPoint(e);
      const pin = isControl(e) ? null : this.pinAt(p.x, p.y);
      this.hovered = pin;
      this.tipEl.hidden = !pin;
      if (pin) {
        this.tipEl.textContent = pin.name;
        this.tipEl.style.borderColor = pin.color;
        this.placeBubble(this.tipEl, pin.sx / this.pixelRatio, pin.sy / this.pixelRatio - 12, pin.sy / this.pixelRatio + 12);
      }
      this.root.style.cursor = pin || this.onPick(p.x, p.y) ? 'pointer' : 'grab';
    });
    this.root.addEventListener('mouseleave', () => {
      this.hovered = null;
      this.tipEl.hidden = true;
    });
    // 左クリック：そこに仮のピンを刺して地名を出す（仮のピンを押すと外す）。保存したピンを押すとメニュー
    this.root.addEventListener('click', (e) => {
      if (this.dragged) {
        this.dragged = false;
        return;
      }
      if (!this.view || isControl(e)) return;
      const p = this.canvasPoint(e);
      const pin = this.pinAt(p.x, p.y);
      if (pin) {
        this.openMenu(e, { lat: pin.lat, lon: pin.lon, title: pin.name, saved: true });
        return;
      }
      if (this.onPick(p.x, p.y)) {
        this.clearPick();
        return;
      }
      this.setPick(this.unproject(p.x, p.y));
    });
    // 右クリック：その地点（保存したピン・仮のピンの上ならそのピン）のメニュー
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.view || isControl(e)) return;
      const p = this.canvasPoint(e);
      const pin = this.pinAt(p.x, p.y);
      if (pin) {
        this.openMenu(e, { lat: pin.lat, lon: pin.lon, title: pin.name, saved: true });
        return;
      }
      if (!this.onPick(p.x, p.y)) this.setPick(this.unproject(p.x, p.y));
      const pick = this.pick!;
      this.openMenu(e, { lat: pick.lat, lon: pick.lon, title: pick.name, saved: false });
    });
  }

  /** 仮のピンを刺し、地名（最寄り駅、届いたら住所）を出す */
  private setPick({ lat, lon }: { lat: number; lon: number }): void {
    const near = nearestStation(lat, lon);
    const station = near ? describeStation(near.station.name, near.distance, LOCATION.nearStation) : '';
    const id = ++this.pickId;
    this.pick = { lat, lon, ...toWorldPx(lat, lon), sx: 0, sy: 0, name: station || '地点', address: '', station };
    this.renderPlace();
    reverseGeocode(lat, lon)
      .then((address) => {
        if (id !== this.pickId || !this.pick) return;
        this.pick.address = address;
        if (address) this.pick.name = address;
        this.renderPlace();
      })
      .catch(() => {});
  }

  private clearPick(): void {
    this.pick = null;
    this.pickId++;
    this.placeEl.hidden = true;
  }

  private renderPlace(): void {
    const pick = this.pick;
    if (!pick) return;
    this.placeEl.innerHTML = '<b></b><small></small>';
    this.placeEl.querySelector('b')!.textContent = pick.address || (pick.station ? pick.station : '地点');
    this.placeEl.querySelector('small')!.textContent = pick.address ? pick.station : '住所を調べています…';
    this.placeEl.hidden = false;
  }

  /** 地点のメニュー（画面の上に出す。ミニマップの外にはみ出してよい） */
  private openMenu(e: MouseEvent, target: { lat: number; lon: number; title: string; saved: boolean }): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'map-menu';
    menu.innerHTML = `<div class="map-menu-title"></div>
      <button type="button" data-visit>ここへ行く</button>
      ${target.saved ? '' : '<button type="button" data-save>この地点を保存</button>'}`;
    menu.querySelector('.map-menu-title')!.textContent = target.title;
    menu.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      if (!b) return;
      this.closeMenu();
      if (b.dataset.visit !== undefined) {
        this.options.onVisit(target.lat, target.lon);
        if (!target.saved) this.clearPick();
      } else if (b.dataset.save !== undefined) {
        this.options.onSave(target.lat, target.lon, target.title);
        this.clearPick();
      }
    });
    this.parent.appendChild(menu);
    // 画面の端ではみ出さないよう、上・左へずらす
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - w - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8))}px`;
    this.menu = menu;
    // メニューの外を押す・Esc で閉じる（Esc でポーズにしない）
    const onDown = (ev: PointerEvent) => {
      if (!menu.contains(ev.target as Node)) this.closeMenu();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopImmediatePropagation();
      this.closeMenu();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    this.menuCleanup = () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    this.menuCleanup?.();
    this.menuCleanup = null;
  }

  private changeZoom(delta: number): void {
    this.zoom = Math.min(MINIMAP.maxZoom, Math.max(MINIMAP.minZoom, this.zoom + delta));
  }

  /** 左下の「幅 ○km」：ミニマップの横幅が表す距離 */
  private updateScaleLabel(lat: number): void {
    const metersPerPx = (40075016 * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * 2 ** this.zoom);
    const width = metersPerPx * this.width;
    const text = width >= 1000 ? `幅 ${(width / 1000).toFixed(1)}km` : `幅 ${Math.round(width / 10) * 10}m`;
    if (this.scaleLabel.textContent !== text) this.scaleLabel.textContent = text;
  }

  dispose(): void {
    this.closeMenu();
    this.root.remove();
    this.toggleButton.remove();
    for (const tile of this.tiles.values()) if (tile instanceof ImageBitmap) tile.close();
    this.tiles.clear();
  }

  private createCanvas(className: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.className = className;
    return canvas;
  }

  /** 地図：進行方向が上になるよう、中心のまわりに -bearing 回して描く */
  private drawMap({ tileZoom: z, cx, cy, scale }: View, bearing: number): void {
    const ctx = this.mapCtx;
    const { width: w, height: h } = ctx.canvas;
    // 回すと四隅まで要るので、対角線の半分まで読む
    const half = Math.hypot(w, h) / 2 / scale;

    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-bearing);
    ctx.translate(-w / 2, -h / 2);
    const x0 = Math.floor((cx - half) / TILE_PX);
    const x1 = Math.floor((cx + half) / TILE_PX);
    const y0 = Math.floor((cy - half) / TILE_PX);
    const y1 = Math.floor((cy + half) / TILE_PX);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const image = this.getTile(tx, ty, z);
        if (!image) continue;
        const dx = (tx * TILE_PX - cx) * scale + w / 2;
        const dy = (ty * TILE_PX - cy) * scale + h / 2;
        ctx.drawImage(image, dx, dy, TILE_PX * scale, TILE_PX * scale);
      }
    }
    ctx.restore();
  }

  /** 範囲内の通り名を、道に沿った向きで、重ならないように描く */
  private drawLabels({ tileZoom, cx, cy, scale }: View, bearing: number): void {
    const ctx = this.markerCtx;
    const { width: w, height: h } = ctx.canvas;
    const r = this.pixelRatio;
    const world = 2 ** tileZoom;
    const fontSize = MINIMAP.labelFontSize * r;
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * r;
    ctx.strokeStyle = 'rgba(10, 18, 30, 0.9)';
    ctx.fillStyle = '#e8eef5';

    // 中心に近いものから置く
    const margin = 4 * r;
    const visible: Array<{ label: RoadLabel; sx: number; sy: number; d: number }> = [];
    // 地図と同じく -bearing 回す
    const cos = Math.cos(-bearing);
    const sin = Math.sin(-bearing);
    for (const label of this.labels) {
      const ux = (label.x * world - cx) * scale;
      const uy = (label.y * world - cy) * scale;
      const sx = ux * cos - uy * sin + w / 2;
      const sy = ux * sin + uy * cos + h / 2;
      if (sx < margin || sy < margin || sx > w - margin || sy > h - margin) continue;
      visible.push({ label, sx, sy, d: Math.hypot(sx - w / 2, sy - h / 2) });
    }
    visible.sort((a, b) => a.d - b.d);

    const placed: Array<[number, number, number, number]> = [];
    const perName = new Map<string, number>();
    // 自機の矢印のまわりは空けておく
    const keepOut = 16 * r;
    placed.push([w / 2 - keepOut, h / 2 - keepOut, w / 2 + keepOut, h / 2 + keepOut]);
    for (const { label, sx, sy } of visible) {
      if ((perName.get(label.name) ?? 0) >= MINIMAP.maxLabelsPerName) continue;
      // 文字が逆さにならないよう ±90° に収める
      let angle = label.angle - bearing;
      while (angle > Math.PI / 2) angle -= Math.PI;
      while (angle <= -Math.PI / 2) angle += Math.PI;
      const w = this.textWidth(ctx, label.name) + 4 * r;
      const h = fontSize + 4 * r;
      // 回転した文字を囲む軸平行の箱
      const c = Math.abs(Math.cos(angle));
      const s = Math.abs(Math.sin(angle));
      const hw = (w * c + h * s) / 2;
      const hh = (w * s + h * c) / 2;
      const box: [number, number, number, number] = [sx - hw, sy - hh, sx + hw, sy + hh];
      if (box[0] < 0 || box[1] < 0 || box[2] > w || box[3] > h) continue;
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      perName.set(label.name, (perName.get(label.name) ?? 0) + 1);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.strokeText(label.name, 0, 0);
      ctx.fillText(label.name, 0, 0);
      ctx.restore();
    }
  }

  private textWidth(ctx: CanvasRenderingContext2D, text: string): number {
    let w = this.textWidths.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(text, w);
    }
    return w;
  }

  /** 自機の矢印と視野の扇形（いつも上向き） */
  private drawMarker(): void {
    const ctx = this.markerCtx;
    const { width: w, height: h } = ctx.canvas;
    const r = this.pixelRatio;
    // 探索中は自機の場所に描く（地図の外なら描かない）
    const at = this.panCenter && this.here ? this.project(this.here.x, this.here.y) : { x: w / 2, y: h / 2 };
    if (at.x < -12 * r || at.y < -12 * r || at.x > w + 12 * r || at.y > h + 12 * r) return;
    ctx.save();
    ctx.translate(at.x, at.y);

    // 視野の扇形
    const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, 60 * r);
    cone.addColorStop(0, 'rgba(102, 204, 255, 0.45)');
    cone.addColorStop(1, 'rgba(102, 204, 255, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 60 * r, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();

    // 自機の矢印
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1a2a40';
    ctx.lineWidth = 2 * r;
    ctx.beginPath();
    ctx.moveTo(0, -10 * r);
    ctx.lineTo(7 * r, 8 * r);
    ctx.lineTo(0, 4 * r);
    ctx.lineTo(-7 * r, 8 * r);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  /** 読込済みならタイル画像を返す。まだなら読み始めて null */
  private getTile(x: number, y: number, z: number): ImageBitmap | null {
    const key = `${z}/${x}/${y}`;
    const cached = this.tiles.get(key);
    if (cached instanceof ImageBitmap) return cached;
    if (cached === undefined) {
      this.tiles.set(key, 'loading');
      const url = MINIMAP.tileUrl.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);
      fetch(url)
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`${res.status}`))))
        .then((blob) => createImageBitmap(blob))
        .then((image) => this.tiles.set(key, image))
        .catch(() => this.tiles.set(key, null));
      this.evictFarTiles(x, y, z);
    }
    return null;
  }

  /** 遠くのタイルを捨てて、メモリを使い続けないようにする */
  private evictFarTiles(x: number, y: number, z: number): void {
    if (this.tiles.size <= MINIMAP.maxCachedTiles) return;
    for (const [key, tile] of this.tiles) {
      const [tz, tx, ty] = key.split('/').map(Number);
      // 今のズームで近いタイルは残す（拡大率を変えたら、前のズームのタイルは捨てる）
      if (tz === z && Math.max(Math.abs(tx - x), Math.abs(ty - y)) <= 3) continue;
      if (tile instanceof ImageBitmap) tile.close();
      this.tiles.delete(key);
    }
  }
}

/** 同梱の通り名データを、ズーム 0 での px 座標と文字の角度にしておく */
function prepareLabels(): RoadLabel[] {
  return (roadLabels as Array<{ name: string; lat: number; lon: number; b: number }>).map((l) => {
    const t = lonLatToTile(l.lon, l.lat, 0);
    // 方位（北から時計回り）→ キャンバス上の角度（右向きが 0、下向きが +）。文字が逆さにならないよう ±90° に収める
    let angle = l.b - Math.PI / 2;
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle <= -Math.PI / 2) angle += Math.PI;
    return { name: l.name, x: t.x * TILE_PX, y: t.y * TILE_PX, angle };
  });
}
