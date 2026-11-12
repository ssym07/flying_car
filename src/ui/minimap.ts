import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre の裏で働く処理（タイルの読み取り）。Vite に1つのファイルにまとめさせ、その URL を渡す
// （MapLibre が自分で探す場所は、Vite の事前のまとめ・本番のビルドで変わって見つからなくなる）
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { LOCATION, MINIMAP } from '../core/config';
import { REGION, regionUrl } from '../core/region';
import { STATIONS } from '../data/regionData';
import { describeStation, nearestStation } from '../world/places';
import { reverseGeocode } from './geocode';
import { COLORS, FONT, minimapStyle } from './minimapStyle';

/** ミニマップに出す保存したピン */
interface MapPin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** ピンの色（#rrggbb） */
  color: string;
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

/** 白いピンは白地に溶けるので縁を濃くする */
const isWhite = (hex: string) => hex.toLowerCase() === '#f5f5f5';

/**
 * ドラッグで地図の中心を動かせる範囲 [南, 西, 北, 東]（度）：この地域の駅のある範囲に MINIMAP.panMargin を足したもの。
 * 自機に合わせて動く時はこの範囲に縛らない（範囲の外へ飛んでも地図は付いてくる）
 */
const PAN_BOUNDS = (() => {
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;
  for (const st of STATIONS) {
    s = Math.min(s, st.lat);
    n = Math.max(n, st.lat);
    w = Math.min(w, st.lon);
    e = Math.max(e, st.lon);
  }
  const m = MINIMAP.panMargin;
  const mLon = m / Math.cos((((s + n) / 2) * Math.PI) / 180);
  return [s - m, w - mLon, n + m, e + mLon] as const;
})();

/**
 * 一番引いた時のミニマップの横幅 (m)：地域の広さ（駅のある範囲の長い方の辺）の MINIMAP.maxViewPerRegion 倍。
 * 福岡（約60km）で約40km、東京で約59km、大阪で約77km
 */
const MAX_VIEW_METERS = (() => {
  const [s, w, n, e] = PAN_BOUNDS;
  const m = MINIMAP.panMargin;
  const ns = (n - s - 2 * m) * 111320;
  const ew = (e - w) * 111320 * Math.cos((((s + n) / 2) * Math.PI) / 180) - 2 * m * 111320;
  return Math.max(MINIMAP.minMaxView, Math.max(ns, ew) * MINIMAP.maxViewPerRegion);
})();

/** 幅 width (px) のミニマップの横幅が MAX_VIEW_METERS になるズーム（MapLibre のズーム、512px のタイルが基準） */
function minZoomFor(width: number): number {
  const metersPerPx = MAX_VIEW_METERS / width;
  const equator = 40075016 * Math.cos((REGION.origin.latDeg * Math.PI) / 180);
  // ズーム 8 より引くと、国土地理院のタイルに水域が無く海が描けない
  return Math.max(MINIMAP.lowestZoom, Math.log2(equator / (512 * metersPerPx)));
}

/** pmtiles:// の読み方を MapLibre に登録したか（ページで一度だけ） */
let protocolAdded = false;

/**
 * 画面左上のミニマップ（「地図」のボタンで出す・しまう。右下の角をドラッグで大きさを変える）。
 * 地図は MapLibre GL JS で、国土地理院のベクトルタイルを白地の簡略図として描く（見た目は minimapStyle.ts）。
 * 進行方向が上で、中心が現在地（地図を回す。文字は回っても正立のまま）。北の向きは縁の「N」で示す。
 * 駅名はゲームの駅データを重ねる。右上の ＋/− か、ホイールで拡大率を変えられる。
 * ドラッグで地図をずらして探索できる（右上の ◎ で現在地に戻る）。押すと仮のピン、右クリックで「ここへ行く」「この地点を保存」。
 * 保存したピンは色付きの丸（カーソルを合わせると名前）。地図の外のものは縁に小さく出す
 */
export class Minimap {
  private readonly root: HTMLDivElement;
  private readonly mapEl: HTMLDivElement;
  private map: MapLibreMap | null = null;
  /** MapLibre（地図を描く部品）は大きいので、初めて使う時に読む */
  private maplibre: typeof import('maplibre-gl') | null = null;
  private loading = false;
  private disposed = false;
  private pins: MapPin[] = [];
  /** クリックで刺した仮のピン */
  private pick: { lat: number; lon: number; name: string; address: string; station: string; marker: Marker } | null = null;
  private pickId = 0;
  /** 画面上の大きさ（CSS px）。MINIMAP.size から路線図の大きさ（MINIMAP.maxWidth × maxHeight）まで */
  private width: number;
  private height: number;
  /** ドラッグで探索している（現在地に合わせて動かさない） */
  private panned = false;
  /** 最後に受け取った現在地と進行方向（度） */
  private here: { lat: number; lon: number } | null = null;
  private bearingDeg = 0;
  private readonly toggleButton: HTMLButtonElement;
  private readonly hereButton: HTMLButtonElement;
  private readonly scaleLabel: HTMLDivElement;
  private readonly north: HTMLDivElement;
  private readonly self: HTMLDivElement;
  private readonly tipEl: HTMLDivElement;
  /** 地図の外のピンを縁に出す丸（使い回す） */
  private readonly edgeDots: HTMLDivElement[] = [];
  private readonly edgeLayer: HTMLDivElement;
  /** 地図の上でボタンを押している（ドラッグになるかもしれない） */
  private pressing = false;
  private readonly release = () => {
    this.pressing = false;
  };
  private menu: HTMLDivElement | null = null;
  private menuCleanup: (() => void) | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly options: MinimapOptions,
  ) {
    const saved = loadSettings();
    this.width = saved.width;
    this.height = saved.height;

    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.mapEl = document.createElement('div');
    this.mapEl.className = 'minimap-map';
    this.edgeLayer = document.createElement('div');
    this.edgeLayer.className = 'minimap-edges';
    this.self = document.createElement('div');
    this.self.className = 'minimap-self';
    this.north = document.createElement('div');
    this.north.className = 'minimap-north';
    this.north.textContent = 'N';
    const controls = document.createElement('div');
    controls.className = 'minimap-zoom';
    controls.innerHTML = `<button type="button" data-zoom="1" aria-label="拡大">＋</button><button type="button" data-zoom="-1" aria-label="縮小">−</button><button type="button" data-here aria-label="現在地に戻る" title="現在地に戻る" hidden>◎</button>`;
    this.hereButton = controls.querySelector('[data-here]')!;
    controls.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button || !this.map) return;
      if (button.dataset.here !== undefined) this.setPanned(false);
      else this.changeZoom(Number(button.dataset.zoom) * MINIMAP.zoomStep);
    });
    this.scaleLabel = document.createElement('div');
    this.scaleLabel.className = 'minimap-scale';
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'minimap-tip';
    this.tipEl.hidden = true;
    const grip = document.createElement('div');
    grip.className = 'minimap-resize';
    grip.title = 'ドラッグで大きさを変える';
    this.root.append(this.mapEl, this.edgeLayer, this.self, this.north, controls, this.scaleLabel, this.tipEl, grip);
    // ホイールで拡大・縮小（後ろの 3D の画面（カメラ）には渡さない）
    this.root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 行単位（マウスのホイールの一部）は px に直す
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.changeZoom((-dy / 100) * MINIMAP.wheelZoom);
      },
      { passive: false },
    );
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    parent.appendChild(this.root);
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
  }

  /** 地図を作る（初めて出す時。MapLibre を読み込んでから） */
  private async createMap(): Promise<void> {
    if (this.map || this.loading) return;
    this.loading = true;
    const [maplibre, { Protocol }] = await Promise.all([import('maplibre-gl'), import('pmtiles')]);
    if (this.disposed) return;
    this.maplibre = maplibre;
    if (!maplibre.getWorkerUrl() || maplibre.getWorkerUrl() !== maplibreWorkerUrl) maplibre.setWorkerUrl(maplibreWorkerUrl);
    // 国土地理院のベクトルタイルは1つの大きなファイル（PMTiles）から必要な所だけ読む
    if (!protocolAdded) {
      maplibre.addProtocol('pmtiles', new Protocol().tile);
      protocolAdded = true;
    }
    const here = this.here ?? { lat: 0, lon: 0 };
    const map = new maplibre.Map({
      container: this.mapEl,
      style: minimapStyle(),
      center: [here.lon, here.lat],
      zoom: MINIMAP.zoom,
      minZoom: minZoomFor(this.width),
      maxZoom: MINIMAP.maxZoom,
      bearing: this.bearingDeg,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      keyboard: false,
      boxZoom: false,
      renderWorldCopies: false,
      fadeDuration: 0,
      // ドラッグで探索できるのは、この地域の範囲（駅のある範囲＋まわり）の中だけ。
      // 中心を範囲に収めるのは MapLibre の中で（ドラッグの途中で中心を置き直すとドラッグが止まる）。
      // 現在地に合わせて動く時は縛らない（範囲の外へ飛んでも地図は付いてくる）
      transformConstrain: (lngLat, zoom) => {
        if (!this.panned) return { center: lngLat, zoom };
        const [s, w, n, e] = PAN_BOUNDS;
        lngLat.lat = Math.min(n, Math.max(s, lngLat.lat));
        lngLat.lng = Math.min(e, Math.max(w, lngLat.lng));
        return { center: lngLat, zoom };
      },
      // 漢字・かなは手元の文字で描く（地図の文字の配信からは英数字だけ読む）
      localIdeographFontFamily: "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif",
    });
    map.touchZoomRotate.disableRotation();
    // ホイールの拡大・縮小は自前で、すぐに変える（MapLibre のなめらかな拡大は、毎フレーム現在地に合わせ直すと途中で止まって鈍くなる）
    map.scrollZoom.disable();
    this.map = map;
    map.on('load', () => {
      // 駅名より下に置く（重なったら駅名・JCT・IC・川の名前の順に残す）
      this.addRivers(map);
      this.addJunctions(map);
      this.addStations(map);
      this.addPinLayer(map);
      this.renderPins();
    });
    map.on('dragstart', () => {
      this.setPanned(true);
      this.closeMenu();
    });
    // ボタンを押している間は、現在地に合わせ直さない（押してから動かし始めるまでの間に合わせ直すと、
    // MapLibre のドラッグの受け付けが取り消されて、ドラッグが始まらない）
    map.getCanvasContainer().addEventListener('pointerdown', () => {
      this.pressing = true;
    });
    window.addEventListener('pointerup', this.release);
    window.addEventListener('pointercancel', this.release);
    map.on('click', (e) => {
      const pin = this.pinAt(e.point);
      if (pin) this.openMenu(e.originalEvent, { lat: pin.lat, lon: pin.lon, title: pin.name, saved: true });
      else this.setPick(e.lngLat.lat, e.lngLat.lng);
    });
    map.on('contextmenu', (e) => {
      e.preventDefault();
      const pin = this.pinAt(e.point);
      if (pin) {
        this.openMenu(e.originalEvent, { lat: pin.lat, lon: pin.lon, title: pin.name, saved: true });
        return;
      }
      this.setPick(e.lngLat.lat, e.lngLat.lng);
      const pick = this.pick!;
      this.openMenu(e.originalEvent, { lat: pick.lat, lon: pick.lon, title: pick.name, saved: false });
    });
    map.on('mousemove', (e) => {
      const pin = this.pinAt(e.point);
      this.tipEl.hidden = !pin;
      map.getCanvas().style.cursor = pin ? 'pointer' : '';
      if (pin) {
        this.tipEl.textContent = pin.name;
        this.tipEl.style.borderColor = isWhite(pin.color) ? '#9aa3ad' : pin.color;
        const p = map.project([pin.lon, pin.lat]);
        this.placeBubble(this.tipEl, p.x, p.y - 12, p.y + 12);
      }
    });
    map.on('mouseout', () => {
      this.tipEl.hidden = true;
    });
  }

  /**
   * 川の名前（scripts/fetch-river-names.mjs が作る rivers.json）。線は描かず、川の線に沿って水の色の文字で書く。
   * 国土地理院の地図の注記には川の名前がほとんど無いので、OpenStreetMap の川の線を使う。ファイルが無い地域では出さない
   */
  private addRivers(map: MapLibreMap): void {
    map.addSource('rivers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'river-name',
      type: 'symbol',
      source: 'rivers',
      minzoom: 11,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 150,
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 13],
        'text-letter-spacing': 0.15,
        'text-max-angle': 60,
        'text-padding': 2,
      },
      paint: { 'text-color': COLORS.waterText, 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 },
    });
    fetch(regionUrl('rivers.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { r: [string, number[]][] } | null) => {
        if (!data) return;
        (map.getSource('rivers') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: data.r.map(([name, flat]) => ({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]),
            },
            properties: { name },
          })),
        });
      })
      .catch(() => {});
  }

  /**
   * 高速道路の JCT・IC の名前（scripts/fetch-expressway-junctions.mjs が作る junctions.json）。
   * 高速道路の色の文字で、JCT は駅名より引いた所から、IC は駅名と同じくらいから出す。ファイルが無い地域では出さない
   */
  private addJunctions(map: MapLibreMap): void {
    map.addSource('junctions', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'junction-name',
      type: 'symbol',
      source: 'junctions',
      filter: ['any', ['==', ['get', 'kind'], 1], ['>=', ['zoom'], 11.5]],
      minzoom: 10,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 12],
        'text-max-width': 9,
        'text-padding': 4,
        // JCT を先に置く（重なったら IC を消す）
        'symbol-sort-key': ['-', 1, ['get', 'kind']],
      },
      paint: { 'text-color': COLORS.junction, 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
    });
    fetch(regionUrl('junctions.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { j: [string, number, number, number][] } | null) => {
        if (!data) return;
        (map.getSource('junctions') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: data.j.map(([name, lat, lon, kind]) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { name, kind },
          })),
        });
      })
      .catch(() => {});
  }

  /** ゲームの駅データの駅名（白い丸と、白い縁取りの文字） */
  private addStations(map: MapLibreMap): void {
    map.addSource('stations', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: STATIONS.map((s) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { name: s.name },
        })),
      },
    });
    map.addLayer({
      id: 'station-dot',
      type: 'circle',
      source: 'stations',
      minzoom: 11,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 4.5],
        'circle-color': '#ffffff',
        'circle-stroke-color': COLORS.station,
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'station-name',
      type: 'symbol',
      source: 'stations',
      minzoom: 11,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 13.5],
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.7,
        'text-justify': 'auto',
        'text-padding': 3,
      },
      paint: { 'text-color': COLORS.station, 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
  }

  private addPinLayer(map: MapLibreMap): void {
    map.addSource('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'pins',
      type: 'circle',
      source: 'pins',
      paint: {
        'circle-radius': 6.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['case', ['get', 'white'], '#1b2430', '#ffffff'],
        'circle-stroke-width': 2,
      },
    });
  }

  /** 地図に出すピン（今の地域の保存した地点） */
  setPins(pins: ReadonlyArray<MapPin>): void {
    this.pins = pins.map(({ id, name, lat, lon, color }) => ({ id, name, lat, lon, color }));
    this.renderPins();
  }

  private renderPins(): void {
    const source = this.map?.getSource('pins') as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: this.pins.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.id, color: p.color, white: isWhite(p.color) },
      })),
    });
  }

  /** 画面上の点（地図の中の px）の近く（9px 以内）の保存したピン */
  private pinAt(point: { x: number; y: number }): MapPin | null {
    const map = this.map;
    if (!map?.getLayer('pins')) return null;
    const hit = map.queryRenderedFeatures(
      [
        [point.x - 9, point.y - 9],
        [point.x + 9, point.y + 9],
      ],
      { layers: ['pins'] },
    )[0];
    const id = hit?.properties?.id as string | undefined;
    return id ? (this.pins.find((p) => p.id === id) ?? null) : null;
  }

  /**
   * @param lat 現在地の緯度（度）
   * @param lon 現在地の経度（度）
   * @param bearing 進行方向（北から時計回り、ラジアン）
   */
  update(lat: number, lon: number, bearing: number): void {
    this.here = { lat, lon };
    this.bearingDeg = (bearing * 180) / Math.PI;
    if (this.root.hidden) return;
    if (!this.map) {
      void this.createMap();
      return;
    }
    const map = this.map;
    // 進行方向が上。探索中は地図の中心は動かさず、向きだけ合わせる
    // （ドラッグ中・その後の惰性の間は触らない。触るとドラッグが止まる）
    if (!this.pressing && !map.isMoving()) {
      if (!this.panned) map.jumpTo({ center: [lon, lat], bearing: this.bearingDeg });
      else if (Math.abs(map.getBearing() - this.bearingDeg) > 0.1) map.setBearing(this.bearingDeg);
    }

    // 自機の矢印（探索中は自機の場所。地図の外なら出さない）
    const p = this.panned ? map.project([lon, lat]) : { x: this.width / 2, y: this.height / 2 };
    const inside = p.x > -12 && p.y > -12 && p.x < this.width + 12 && p.y < this.height + 12;
    this.self.hidden = !inside;
    if (inside) this.self.style.transform = `translate(${p.x}px, ${p.y}px)`;

    // 「N」は縁（内側 14px の長方形）の、北の向き
    const nx = -Math.sin(bearing);
    const ny = -Math.cos(bearing);
    const t = Math.min((this.width / 2 - 14) / Math.max(Math.abs(nx), 1e-6), (this.height / 2 - 14) / Math.max(Math.abs(ny), 1e-6));
    this.north.style.left = `${this.width / 2 + nx * t}px`;
    this.north.style.top = `${this.height / 2 + ny * t}px`;

    this.updateEdgeDots(map);
    this.updatePickBubble(map);
    this.updateScaleLabel(map);
  }

  /** 地図の外の保存したピンを、その向きの縁に小さな丸で出す */
  private updateEdgeDots(map: MapLibreMap): void {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const ex = cx - 8;
    const ey = cy - 8;
    let used = 0;
    for (const pin of this.pins) {
      const p = map.project([pin.lon, pin.lat]);
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (Math.abs(dx) <= ex && Math.abs(dy) <= ey) continue;
      const k = Math.min(ex / Math.max(Math.abs(dx), 1e-6), ey / Math.max(Math.abs(dy), 1e-6));
      let dot = this.edgeDots[used];
      if (!dot) {
        dot = document.createElement('div');
        dot.className = 'minimap-edge-dot';
        this.edgeLayer.appendChild(dot);
        this.edgeDots.push(dot);
      }
      dot.hidden = false;
      dot.style.background = pin.color;
      dot.style.borderColor = isWhite(pin.color) ? '#1b2430' : '#ffffff';
      dot.style.transform = `translate(${cx + dx * k}px, ${cy + dy * k}px)`;
      used++;
    }
    for (let i = used; i < this.edgeDots.length; i++) this.edgeDots[i].hidden = true;
  }

  private changeZoom(delta: number): void {
    const map = this.map;
    if (!map) return;
    map.setZoom(Math.min(MINIMAP.maxZoom, Math.max(map.getMinZoom(), map.getZoom() + delta)));
  }

  /** 左下の「幅 ○km」：ミニマップの横幅が表す距離 */
  private updateScaleLabel(map: MapLibreMap): void {
    const lat = map.getCenter().lat;
    // MapLibre のズームは 512px のタイルが基準
    const metersPerPx = (40075016 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    const width = metersPerPx * this.width;
    const text = width >= 1000 ? `幅 ${(width / 1000).toFixed(1)}km` : `幅 ${Math.round(width / 10) * 10}m`;
    if (this.scaleLabel.textContent !== text) this.scaleLabel.textContent = text;
  }

  private setPanned(panned: boolean): void {
    this.panned = panned;
    this.hereButton.hidden = !panned;
    if (!panned && this.map && this.here) this.map.jumpTo({ center: [this.here.lon, this.here.lat], bearing: this.bearingDeg });
  }

  /** 仮のピン（黄色の待ち針）を刺し、地名（最寄り駅、届いたら住所）を出す */
  private setPick(lat: number, lon: number): void {
    if (!this.map || !this.maplibre) return;
    this.clearPick();
    const near = nearestStation(lat, lon);
    const station = near ? describeStation(near.station.name, near.distance, LOCATION.nearStation) : '';
    const id = ++this.pickId;
    const el = document.createElement('div');
    el.className = 'minimap-pick';
    el.innerHTML = '<div class="minimap-place"><b></b><small></small></div><i></i>';
    // 仮のピンを押すと外す（地図の click にしない）
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearPick();
    });
    const marker = new this.maplibre.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(this.map);
    this.pick = { lat, lon, name: station || '地点', address: '', station, marker };
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
    this.pick?.marker.remove();
    this.pick = null;
    this.pickId++;
  }

  private renderPlace(): void {
    const pick = this.pick;
    if (!pick) return;
    const el = pick.marker.getElement();
    el.querySelector('b')!.textContent = pick.address || pick.station || '地点';
    el.querySelector('small')!.textContent = pick.address ? pick.station : '住所を調べています…';
  }

  /** 地名の吹き出しが地図の上・左右にはみ出す時は、ピンの下に出す・内側へ寄せる */
  private updatePickBubble(map: MapLibreMap): void {
    const pick = this.pick;
    if (!pick) return;
    const bubble = pick.marker.getElement().querySelector<HTMLElement>('.minimap-place')!;
    const p = map.project([pick.lon, pick.lat]);
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    bubble.classList.toggle('below', p.y - 26 - h < 4);
    const shift = Math.min(0, this.width - 4 - (p.x + w / 2)) + Math.max(0, 4 - (p.x - w / 2));
    bubble.style.marginLeft = `${shift}px`;
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
        this.setPanned(false);
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

  /** 大きさを変える（CSS px。最小 MINIMAP.size、最大は路線図の大きさと画面に収まる高さ） */
  private setSize(width: number, height: number): void {
    const top = this.root.offsetTop || MINIMAP.top;
    const maxHeight = Math.max(MINIMAP.size, Math.min(MINIMAP.maxHeight, window.innerHeight - top - MINIMAP.bottomMargin));
    this.width = Math.round(Math.min(MINIMAP.maxWidth, Math.max(MINIMAP.size, width)));
    this.height = Math.round(Math.min(maxHeight, Math.max(MINIMAP.size, height)));
    this.root.style.width = `${this.width}px`;
    this.root.style.height = `${this.height}px`;
    this.map?.resize();
    // 一番引いた時の幅が MINIMAP.maxViewMeters になるよう、地図の幅に合わせて引ける限度を変える
    this.map?.setMinZoom(minZoomFor(this.width));
  }

  private setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.toggleButton.classList.toggle('active', visible);
    if (!visible) {
      this.closeMenu();
      this.tipEl.hidden = true;
    } else {
      // しまっている間に大きさが変わっていても合わせる
      this.map?.resize();
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
    // MapLibre の地図のドラッグ・クリックにしない
    grip.addEventListener('mousedown', (e) => e.stopPropagation());
    grip.addEventListener('click', (e) => e.stopPropagation());
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('pointerup', this.release);
    window.removeEventListener('pointercancel', this.release);
    this.closeMenu();
    this.clearPick();
    this.map?.remove();
    this.map = null;
    this.root.remove();
    this.toggleButton.remove();
  }
}
