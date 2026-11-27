import { formatTime, timeOfDay } from '../core/timeOfDay';

/**
 * 時刻の表示（速度・高度の並びの「TIME」の箱）。押すと上にスライダーが開き、0:00〜24:00 を 5 分刻みで動かせる。
 * 「今」で今の時刻に戻す。キーの , と . で 1 時間ずつ戻す・進める（FlightScene）
 */
export class TimePanel {
  readonly element: HTMLDivElement;
  private readonly value: HTMLSpanElement;
  private readonly pop: HTMLDivElement;
  private readonly slider: HTMLInputElement;
  private readonly unsubscribe: () => void;
  private readonly onDocumentDown = (e: PointerEvent) => {
    if (!this.element.contains(e.target as Node)) this.close();
  };

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hud-item time-panel';
    this.element.innerHTML = `
      <button type="button" class="time-button" title="時刻を変える（, と . で 1 時間ずつ）">
        <span class="hud-label">TIME</span><span class="hud-value time-value"></span>
      </button>
      <div class="time-pop" hidden>
        <div class="time-pop-row">
          <input type="range" min="0" max="1435" step="5" aria-label="時刻" />
          <button type="button" class="time-now">今</button>
        </div>
        <div class="time-pop-ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      </div>
    `;
    this.value = this.element.querySelector('.time-value')!;
    this.pop = this.element.querySelector('.time-pop')!;
    this.slider = this.element.querySelector('input')!;
    this.element.querySelector('.time-button')!.addEventListener('click', () => {
      if (this.pop.hidden) this.open();
      else this.close();
    });
    this.slider.addEventListener('input', () => timeOfDay.set(Number(this.slider.value)));
    // 動かし終えたらフォーカスを外す（入力欄にフォーカスがあると、操作のキーが効かない）
    this.slider.addEventListener('change', () => this.slider.blur());
    this.slider.addEventListener('pointerup', () => this.slider.blur());
    this.element.querySelector('.time-now')!.addEventListener('click', (e) => {
      timeOfDay.reset();
      (e.currentTarget as HTMLButtonElement).blur();
    });
    this.unsubscribe = timeOfDay.onChange(() => this.show());
    this.show();
  }

  private show(): void {
    this.value.textContent = formatTime(timeOfDay.minutes);
    if (document.activeElement !== this.slider) this.slider.value = String(Math.round(timeOfDay.minutes / 5) * 5);
  }

  private open(): void {
    this.pop.hidden = false;
    this.element.classList.add('open');
    document.addEventListener('pointerdown', this.onDocumentDown);
  }

  private close(): void {
    this.pop.hidden = true;
    this.element.classList.remove('open');
    document.removeEventListener('pointerdown', this.onDocumentDown);
  }

  dispose(): void {
    this.close();
    this.unsubscribe();
    this.element.remove();
  }
}
