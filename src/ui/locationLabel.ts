import { LOCATION } from '../core/config';
import { describeStation, distanceMeters, nearestStation, wardName } from '../world/places';

/**
 * 画面右上の現在地表示。
 * 1行目：最寄り駅（同梱の駅データから計算）、2行目：区・町名（国土地理院の逆ジオコーダに問い合わせ）
 */
export class LocationLabel {
  private readonly root: HTMLDivElement;
  private readonly stationEl: HTMLDivElement;
  private readonly addressEl: HTMLDivElement;
  private lastGeocode: { lat: number; lon: number; time: number } | null = null;
  private requestId = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'location';
    this.root.innerHTML = `<div class="location-station"></div><div class="location-address"></div>`;
    this.stationEl = this.root.querySelector('.location-station')!;
    this.addressEl = this.root.querySelector('.location-address')!;
    parent.appendChild(this.root);
  }

  /** 現在地（度）を渡す。重い処理ではないが、毎フレームでなく数回/秒で十分 */
  update(lat: number, lon: number): void {
    const near = nearestStation(lat, lon);
    this.stationEl.textContent = near ? describeStation(near.station.name, near.distance, LOCATION.nearStation) : '';
    this.maybeGeocode(lat, lon);
  }

  dispose(): void {
    this.requestId++;
    this.root.remove();
  }

  private maybeGeocode(lat: number, lon: number): void {
    const now = performance.now() / 1000;
    const last = this.lastGeocode;
    if (last) {
      if (now - last.time < LOCATION.geocodeMinIntervalSec) return;
      if (distanceMeters(lat, lon, last.lat, last.lon) < LOCATION.geocodeEvery) return;
    }
    this.lastGeocode = { lat, lon, time: now };

    const id = ++this.requestId;
    const url = LOCATION.reverseGeocoderUrl.replace('{lat}', lat.toFixed(6)).replace('{lon}', lon.toFixed(6));
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { results?: { muniCd: string; lv01Nm: string } } | null) => {
        // 遅れて届いた古い応答は捨てる
        if (id !== this.requestId) return;
        const r = json?.results;
        if (!r) {
          this.addressEl.textContent = '';
          return;
        }
        const town = r.lv01Nm === '－' ? '' : r.lv01Nm;
        this.addressEl.textContent = [wardName(r.muniCd), town].filter(Boolean).join(' ');
      })
      .catch(() => {
        // 住所が取れなくても駅名だけ出しておけばよい
      });
  }
}
