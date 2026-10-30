import { distanceMeters } from '../world/places';

/** 路線図のデータ（scripts/fetch-route-map.mjs の public/route-map.json） */
interface RouteMapData {
  /** [名前, 緯度, 経度, 模式図の x, y（km、路線がまっすぐになるよう動かした位置）] */
  stations: Array<[string, number, number, number, number]>;
  /** [路線名, 色, 駅の番号の並び] */
  lines: Array<[string, string, number[]]>;
  /** 円で描く路線（山手線）：[路線の番号, 中心 x, y, 半径] */
  rings?: Array<[number, number, number, number]>;
}

interface Stop {
  name: string;
  lat: number;
  lon: number;
  /** 模式図の座標（東へ +x、北へ -y、単位は km） */
  x: number;
  y: number;
  /** 地理の座標（同じ単位）：現在地を模式図に置くのに使う */
  gx: number;
  gy: number;
  /** 通る路線の番号 */
  lines: number[];
}

/** 拡大率（1km あたりの px）の範囲と、駅名を出し始める拡大率（乗換駅・すべての駅） */
const MIN_SCALE = 14;
const MAX_SCALE = 120;
const LABEL_TRANSFER = 9;
const LABEL_ALL = 22;
/** 背景（焦げ茶） */
const BG = '#2a211c';
/** 普通の駅の丸を出し始める拡大率と、はっきり出す拡大率 */
const DOTS_FROM = 20;
const DOTS_FULL = 34;
const THREE_CLAMP = (v: number) => Math.min(1, Math.max(0, v));
/** これより動いたらクリックではなくドラッグ (px) */
const DRAG_THRESHOLD = 5;

/**
 * 画面右の路線図（スマホくらいの大きさ）。路線を色の線、駅を白い丸、乗換駅を黒い縁の丸で描く。
 * ドラッグで動かし、ホイール（ピンチ）で拡大・縮小する。駅を押すと onSelect を呼ぶ（その駅へ移る）。
 * 右上の駅検索の左の「路線図」ボタンで開け閉めする
 */
export class RouteMap {
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tip: HTMLDivElement;
  private stops: Stop[] = [];
  private lines: Array<{ name: string; color: string; ids: number[]; ring: [number, number, number] | null }> = [];
  /** 表示：地図の中心（km）と拡大率 */
  private cx = 0;
  private cy = 0;
  private scale = 20;
  private hover = -1;
  private here: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; scale: number } | null = null;
  private lat0 = 35.68;
  private dirty = true;
  private opened = false;

  /**
   * @param onSelect 駅が選ばれた時（緯度経度）
   * @param here 今いる場所（開いた時の中心と、現在地の印）
   */
  constructor(
    parent: HTMLElement,
    private readonly onSelect: (station: { name: string; lat: number; lon: number }) => void,
    private readonly hereFn: () => { lat: number; lon: number } | null,
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'route-map-toggle';
    this.button.textContent = '路線図';
    this.button.addEventListener('click', () => this.toggle());

    this.panel = document.createElement('div');
    this.panel.className = 'route-map';
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="route-map-body"><canvas></canvas><div class="route-map-tip" hidden></div>
        <div class="route-map-zoom"><button type="button" data-zoom="1" aria-label="拡大">＋</button><button type="button" data-zoom="-1" aria-label="縮小">−</button><button type="button" data-here aria-label="現在地">◎</button></div>
      </div>`;
    this.canvas = this.panel.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = this.panel.querySelector('.route-map-tip')!;
    this.panel.querySelector('.route-map-zoom')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.here !== undefined) this.centerOnHere();
      else this.zoomAt(Number(b.dataset.zoom) > 0 ? 1.5 : 1 / 1.5);
    });
    parent.append(this.button, this.panel);
    this.bindPointer();

    fetch(`${import.meta.env.BASE_URL}route-map.json`)
      .then((res) => (res.ok ? (res.json() as Promise<RouteMapData>) : null))
      .then((data) => data && this.setData(data))
      .catch((e) => console.warn('[RouteMap] 読込に失敗しました', e));
  }

  dispose(): void {
    this.button.remove();
    this.panel.remove();
  }

  /** 毎フレーム呼ぶ（開いている時だけ描く） */
  update(): void {
    if (!this.opened) return;
    const p = this.hereFn();
    if (p) {
      const h = this.toSchematic(p.lat, p.lon);
      if (!this.here || Math.hypot(h.x - this.here.x, h.y - this.here.y) > 0.01) {
        this.here = h;
        this.dirty = true;
      }
    }
    if (this.dirty) this.draw();
  }

  private toggle(open = !this.opened): void {
    this.opened = open;
    this.panel.hidden = !open;
    this.button.classList.toggle('active', open);
    if (open) this.centerOnHere();
  }

  private setData(data: RouteMapData): void {
    this.lat0 = 35.68;
    this.stops = data.stations.map(([name, lat, lon, x, y]) => {
      const g = this.project(lat, lon);
      return { name, lat, lon, x, y, gx: g.x, gy: g.y, lines: [] };
    });
    this.lines = data.lines.map(([name, color, ids], i) => {
      for (const id of ids) if (!this.stops[id].lines.includes(i)) this.stops[id].lines.push(i);
      const ring = data.rings?.find((r) => r[0] === i);
      return { name, color, ids, ring: ring ? ([ring[1], ring[2], ring[3]] as [number, number, number]) : null };
    });
    this.dirty = true;
  }

  private project(lat: number, lon: number): { x: number; y: number } {
    return { x: lon * 111.32 * Math.cos((this.lat0 * Math.PI) / 180), y: -lat * 110.95 };
  }

  /** 緯度経度 → 模式図の座標：近い駅4つの「地理の位置からのずれ」を、距離で重みを付けて足す */
  private toSchematic(lat: number, lon: number): { x: number; y: number } {
    const g = this.project(lat, lon);
    const near: Array<[number, Stop]> = [];
    for (const s of this.stops) {
      const d = Math.hypot(s.gx - g.x, s.gy - g.y);
      if (near.length < 4 || d < near[near.length - 1][0]) {
        near.push([d, s]);
        near.sort((a, b) => a[0] - b[0]);
        if (near.length > 4) near.pop();
      }
    }
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (const [d, s] of near) {
      const w = 1 / (d * d + 0.01);
      wx += (s.x - s.gx) * w;
      wy += (s.y - s.gy) * w;
      wsum += w;
    }
    return wsum > 0 ? { x: g.x + wx / wsum, y: g.y + wy / wsum } : g;
  }

  private centerOnHere(): void {
    const p = this.hereFn();
    if (p) {
      const h = this.toSchematic(p.lat, p.lon);
      this.cx = h.x;
      this.cy = h.y;
    }
    this.dirty = true;
  }

  private zoomAt(factor: number, px?: number, py?: number): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const sx = px ?? w / 2;
    const sy = py ?? h / 2;
    // 指している点が動かないように中心をずらす
    const before = this.toMap(sx, sy);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const after = this.toMap(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.dirty = true;
  }

  private toScreen(x: number, y: number): [number, number] {
    return [
      (x - this.cx) * this.scale + this.canvas.clientWidth / 2,
      (y - this.cy) * this.scale + this.canvas.clientHeight / 2,
    ];
  }

  private toMap(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.canvas.clientWidth / 2) / this.scale + this.cx,
      y: (sy - this.canvas.clientHeight / 2) / this.scale + this.cy,
    };
  }

  /** 画面の点に一番近い駅（指で押しやすいよう 14px 以内） */
  private pick(sx: number, sy: number): number {
    let best = -1;
    let bestD = 14;
    this.stops.forEach((s, i) => {
      const [x, y] = this.toScreen(s.x, s.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bestD) ((bestD = d), (best = i));
    });
    return best;
  }

  private bindPointer(): void {
    const c = this.canvas;
    // 地図の上の操作は、ゲームの視点操作に渡さない
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'mousedown', 'contextmenu'])
      this.panel.addEventListener(type, stop);
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
        this.drag = null;
      } else {
        this.drag = { x: p.x, y: p.y, cx: this.cx, cy: this.cy, moved: false };
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const target = this.pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.distance);
        this.zoomAt(target / this.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (this.drag) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) this.drag.moved = true;
        if (this.drag.moved) {
          this.cx = this.drag.cx - dx / this.scale;
          this.cy = this.drag.cy - dy / this.scale;
          this.dirty = true;
        }
        return;
      }
      const hover = this.pick(p.x, p.y);
      if (hover !== this.hover) {
        this.hover = hover;
        c.style.cursor = hover >= 0 ? 'pointer' : 'grab';
        this.showTip(hover, p);
        this.dirty = true;
      }
    });
    const end = (e: PointerEvent) => {
      const p = local(e);
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        return;
      }
      const drag = this.drag;
      this.drag = null;
      if (!drag || drag.moved || e.type === 'pointercancel') return;
      const i = this.pick(p.x, p.y);
      if (i >= 0) {
        const s = this.stops[i];
        this.onSelect({ name: s.name, lat: s.lat, lon: s.lon });
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hover >= 0) {
        this.hover = -1;
        this.tip.hidden = true;
        this.dirty = true;
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.zoomAt(Math.exp(-e.deltaY / 400), p.x, p.y);
      },
      { passive: false },
    );
  }

  private showTip(i: number, p: { x: number; y: number }): void {
    if (i < 0) {
      this.tip.hidden = true;
      return;
    }
    const s = this.stops[i];
    const here = this.hereFn();
    const far = here ? distanceMeters(here.lat, here.lon, s.lat, s.lon) : null;
    const names = [...new Set(s.lines.map((l) => this.lines[l].name))];
    this.tip.innerHTML = `<b>${s.name}駅</b>${far !== null ? `<span>${(far / 1000).toFixed(1)}km</span>` : ''}<div>${names
      .slice(0, 6)
      .map((n) => `<i style="background:${this.lines[this.lines.findIndex((l) => l.name === n)].color}"></i>${n}`)
      .join('<br>')}${names.length > 6 ? `<br>ほか${names.length - 6}路線` : ''}</div>`;
    this.tip.hidden = false;
    const w = this.canvas.clientWidth;
    this.tip.style.left = `${Math.min(p.x + 12, w - 190)}px`;
    this.tip.style.top = `${p.y + 14}px`;
  }

  private draw(): void {
    this.dirty = false;
    const c = this.canvas;
    const ratio = Math.min(window.devicePixelRatio, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) {
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
    }
    const g = this.ctx;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, w, h);
    const margin = 40;
    const visible = (x: number, y: number) => x > -margin && y > -margin && x < w + margin && y < h + margin;

    // 路線（同じ駅の間を何本も通る時は、上に描いた路線の色が見える）
    const width = Math.max(2, Math.min(5, this.scale / 6));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // 円で描く路線（山手線）はほかの路線に隠れないよう最後に、少し太く
    for (const line of [...this.lines.filter((l) => !l.ring), ...this.lines.filter((l) => l.ring)]) {
      g.strokeStyle = line.color;
      g.lineWidth = line.ring ? width * 1.4 : width;
      g.beginPath();
      if (line.ring) {
        const [x, y] = this.toScreen(line.ring[0], line.ring[1]);
        g.arc(x, y, line.ring[2] * this.scale, 0, Math.PI * 2);
        g.stroke();
        continue;
      }
      line.ids.forEach((id, k) => {
        const [x, y] = this.toScreen(this.stops[id].x, this.stops[id].y);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    }

    // 駅：乗換駅（2路線以上）は黒い縁の大きな丸。引いて見ている時は目立たせない
    // （普通の駅は描かず、乗換駅だけ小さく。寄るにつれて普通の駅も出す）
    const near = THREE_CLAMP((this.scale - DOTS_FROM) / (DOTS_FULL - DOTS_FROM));
    const r = Math.max(1.6, Math.min(6, this.scale / 4));
    this.stops.forEach((s, i) => {
      const [x, y] = this.toScreen(s.x, s.y);
      if (!visible(x, y)) return;
      const transfer = s.lines.length >= 2;
      if (!transfer && near <= 0 && i !== this.hover) return;
      g.globalAlpha = transfer || i === this.hover ? 1 : near;
      g.beginPath();
      g.arc(x, y, transfer ? r * (1 + 0.35 * near) : r, 0, Math.PI * 2);
      g.fillStyle = transfer ? BG : '#f4ead8';
      g.fill();
      g.lineWidth = transfer ? 1.2 + 1.3 * near : 1.6;
      g.strokeStyle = i === this.hover ? '#ff9a3c' : transfer ? '#f4ead8' : (this.lines[s.lines[0]]?.color ?? '#999');
      g.stroke();
    });
    g.globalAlpha = 1;

    // 駅名
    g.font = `600 ${this.scale >= LABEL_ALL ? 11 : 10}px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(38, 30, 25, 0.95)';
    g.fillStyle = '#f1e6d2';
    const placed: Array<[number, number, number, number]> = [];
    const order = this.stops.map((_, i) => i).sort((a, b) => this.stops[b].lines.length - this.stops[a].lines.length);
    for (const i of order) {
      const s = this.stops[i];
      const transfer = s.lines.length >= 2;
      if (i !== this.hover && !(this.scale >= LABEL_ALL || (transfer && this.scale >= LABEL_TRANSFER))) continue;
      const [x, y] = this.toScreen(s.x, s.y);
      if (!visible(x, y)) continue;
      const tw = g.measureText(s.name).width;
      const box: [number, number, number, number] = [x + r + 3, y - 7, x + r + 3 + tw, y + 7];
      if (i !== this.hover && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]))
        continue;
      placed.push(box);
      g.strokeText(s.name, box[0], y);
      g.fillText(s.name, box[0], y);
    }

    // 現在地
    if (this.here) {
      const [x, y] = this.toScreen(this.here.x, this.here.y);
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0, 140, 255, 0.25)';
      g.fill();
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = '#0a84ff';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = '#fff';
      g.stroke();
    }
  }
}
