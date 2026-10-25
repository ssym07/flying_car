import { MINIMAP } from '../core/config';
import roadLabels from '../data/roadLabels.json';
import { lonLatToTile } from '../world/Terrain';

const TILE_PX = 256;

/** 通り名ラベル：地図全体での px 座標と、文字を置く角度（キャンバス上、右向きが 0） */
interface RoadLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

/**
 * 画面右下のミニマップ。北が上で、中心が現在地。自機の向きを矢印で示す。
 * 地図は国土地理院の淡色地図を CSS フィルタで暗くして、街の配色に合わせる。
 * 地図と、通り名・矢印は別のキャンバスに描く（フィルタが文字や矢印にかからないように）
 */
export class Minimap {
  private readonly root: HTMLDivElement;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly markerCtx: CanvasRenderingContext2D;
  /** 読込済み・読込中のタイル（失敗したものは null） */
  private readonly tiles = new Map<string, ImageBitmap | null | 'loading'>();
  private readonly pixelRatio = Math.min(window.devicePixelRatio, 2);
  private readonly labels: RoadLabel[];
  private readonly textWidths = new Map<string, number>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    const size = MINIMAP.size;
    this.root.style.width = this.root.style.height = `${size}px`;
    const map = this.createCanvas('minimap-map');
    const marker = this.createCanvas('minimap-marker');
    this.mapCtx = map.getContext('2d')!;
    this.markerCtx = marker.getContext('2d')!;
    const north = document.createElement('div');
    north.className = 'minimap-north';
    north.textContent = 'N';
    this.root.append(map, marker, north);
    parent.appendChild(this.root);
    this.labels = prepareLabels();
  }

  /**
   * @param lat 現在地の緯度（度）
   * @param lon 現在地の経度（度）
   * @param bearing 進行方向（北から時計回り、ラジアン）
   */
  update(lat: number, lon: number, bearing: number): void {
    const z = MINIMAP.zoom;
    const center = lonLatToTile(lon, lat, z);
    // 現在地を「ズーム z の地図全体での px 座標」にする
    const cx = center.x * TILE_PX;
    const cy = center.y * TILE_PX;
    this.drawMap(cx, cy);
    this.markerCtx.clearRect(0, 0, this.markerCtx.canvas.width, this.markerCtx.canvas.height);
    this.drawLabels(cx, cy);
    this.drawMarker(bearing);
  }

  dispose(): void {
    this.root.remove();
    for (const tile of this.tiles.values()) if (tile instanceof ImageBitmap) tile.close();
    this.tiles.clear();
  }

  private createCanvas(className: string): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.className = className;
    canvas.width = canvas.height = Math.round(MINIMAP.size * this.pixelRatio);
    return canvas;
  }

  private drawMap(cx: number, cy: number): void {
    const ctx = this.mapCtx;
    const size = ctx.canvas.width;
    const z = MINIMAP.zoom;
    // キャンバス1px が地図の何 px か（MINIMAP.scale > 1 で地図を拡大して表示）
    const scale = this.pixelRatio * MINIMAP.scale;
    const half = size / 2 / scale;

    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, size, size);
    const x0 = Math.floor((cx - half) / TILE_PX);
    const x1 = Math.floor((cx + half) / TILE_PX);
    const y0 = Math.floor((cy - half) / TILE_PX);
    const y1 = Math.floor((cy + half) / TILE_PX);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const image = this.getTile(tx, ty, z);
        if (!image) continue;
        const dx = (tx * TILE_PX - cx) * scale + size / 2;
        const dy = (ty * TILE_PX - cy) * scale + size / 2;
        ctx.drawImage(image, dx, dy, TILE_PX * scale, TILE_PX * scale);
      }
    }
  }

  /** 範囲内の通り名を、道に沿った向きで、重ならないように描く */
  private drawLabels(cx: number, cy: number): void {
    const ctx = this.markerCtx;
    const size = ctx.canvas.width;
    const r = this.pixelRatio;
    const scale = r * MINIMAP.scale;
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
    for (const label of this.labels) {
      const sx = (label.x - cx) * scale + size / 2;
      const sy = (label.y - cy) * scale + size / 2;
      if (sx < margin || sy < margin || sx > size - margin || sy > size - margin) continue;
      visible.push({ label, sx, sy, d: Math.hypot(sx - size / 2, sy - size / 2) });
    }
    visible.sort((a, b) => a.d - b.d);

    const placed: Array<[number, number, number, number]> = [];
    const perName = new Map<string, number>();
    // 自機の矢印のまわりは空けておく
    const keepOut = 16 * r;
    placed.push([size / 2 - keepOut, size / 2 - keepOut, size / 2 + keepOut, size / 2 + keepOut]);
    for (const { label, sx, sy } of visible) {
      if ((perName.get(label.name) ?? 0) >= MINIMAP.maxLabelsPerName) continue;
      const w = this.textWidth(ctx, label.name) + 4 * r;
      const h = fontSize + 4 * r;
      // 回転した文字を囲む軸平行の箱
      const c = Math.abs(Math.cos(label.angle));
      const s = Math.abs(Math.sin(label.angle));
      const hw = (w * c + h * s) / 2;
      const hh = (w * s + h * c) / 2;
      const box: [number, number, number, number] = [sx - hw, sy - hh, sx + hw, sy + hh];
      if (box[0] < 0 || box[1] < 0 || box[2] > size || box[3] > size) continue;
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      perName.set(label.name, (perName.get(label.name) ?? 0) + 1);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(label.angle);
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

  private drawMarker(bearing: number): void {
    const ctx = this.markerCtx;
    const size = ctx.canvas.width;
    const r = this.pixelRatio;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(bearing);

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
      this.evictFarTiles(x, y);
    }
    return null;
  }

  /** 遠くのタイルを捨てて、メモリを使い続けないようにする */
  private evictFarTiles(x: number, y: number): void {
    if (this.tiles.size <= MINIMAP.maxCachedTiles) return;
    for (const [key, tile] of this.tiles) {
      const [, tx, ty] = key.split('/').map(Number);
      if (Math.max(Math.abs(tx - x), Math.abs(ty - y)) <= 3) continue;
      if (tile instanceof ImageBitmap) tile.close();
      this.tiles.delete(key);
    }
  }
}

/** 同梱の通り名データを、ミニマップのズームでの px 座標と文字の角度にしておく */
function prepareLabels(): RoadLabel[] {
  return (roadLabels as Array<{ name: string; lat: number; lon: number; b: number }>).map((l) => {
    const t = lonLatToTile(l.lon, l.lat, MINIMAP.zoom);
    // 方位（北から時計回り）→ キャンバス上の角度（右向きが 0、下向きが +）。文字が逆さにならないよう ±90° に収める
    let angle = l.b - Math.PI / 2;
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle <= -Math.PI / 2) angle += Math.PI;
    return { name: l.name, x: t.x * TILE_PX, y: t.y * TILE_PX, angle };
  });
}
