import { LOCATION } from '../core/config';
import { describeStation, distanceMeters, nearestStation } from '../world/places';
import { reverseGeocode } from './geocode';

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
  /** 返事を待っている問い合わせがある */
  private pending = false;

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
    // 問い合わせは一度に1つだけ。逆ジオコーダの返事が遅い時（十数秒かかることがある）に、
    // 新しい問い合わせを次々に出すと、届いた返事が毎回「古い」として捨てられ、住所がずっと出なくなる
    if (this.pending) return;
    const now = performance.now() / 1000;
    const last = this.lastGeocode;
    if (last) {
      if (now - last.time < LOCATION.geocodeMinIntervalSec) return;
      if (distanceMeters(lat, lon, last.lat, last.lon) < LOCATION.geocodeEvery) return;
    }
    this.lastGeocode = { lat, lon, time: now };
    this.pending = true;

    const id = this.requestId;
    reverseGeocode(lat, lon)
      .then((address) => {
        // 片付けた後に届いた返事は捨てる。海の上など住所の無い所は空にする（取れなかった時は catch で前の住所を残す）
        if (id === this.requestId) this.addressEl.textContent = address;
      })
      .catch(() => {
        // 住所が取れなくても駅名だけ出しておけばよい。すぐに問い合わせ直せるよう、前に問い合わせた場所を忘れる
        this.lastGeocode = null;
      })
      .finally(() => {
        this.pending = false;
      });
  }
}
