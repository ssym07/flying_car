import { formatTime, timeOfDay } from '../core/timeOfDay';

/** 流す速さの選択肢（実際の 1 秒あたりのゲームの分） */
const SPEEDS: Array<[number, string]> = [
  [1 / 60, '実時間'],
  [1, '1秒で1分'],
  [10, '1秒で10分'],
  [60, '1秒で1時間'],
];

/**
 * 時刻のバー（画面の上、「地図」のボタンの右）。いつも出しておく。
 * ▶／❚❚ で時間を流す・止める、速さを選ぶ、スライダーで 0:00〜24:00 を動かす、「今」で今の時刻に戻る。
 * キーの , と . で 1 時間ずつ戻す・進める（FlightScene）
 */
export class TimePanel {
  readonly element: HTMLDivElement;
  private readonly value: HTMLSpanElement;
  private readonly play: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly speed: HTMLSelectElement;
  private readonly unsubscribe: () => void;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'time-bar';
    this.element.innerHTML = `
      <button type="button" class="time-play" title="時間を流す・止める"></button>
      <span class="time-value" title=", と . で 1 時間ずつ戻す・進める"></span>
      <div class="time-track">
        <input type="range" min="0" max="1439" step="1" aria-label="時刻" />
        <div class="time-ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      </div>
      <select class="time-speed" aria-label="時間の流れる速さ" title="時間の流れる速さ">
        ${SPEEDS.map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}
      </select>
      <button type="button" class="time-now" title="今の時刻に戻す">今</button>
    `;
    this.value = this.element.querySelector('.time-value')!;
    this.play = this.element.querySelector('.time-play')!;
    this.slider = this.element.querySelector('input')!;
    this.speed = this.element.querySelector('select')!;

    this.play.addEventListener('click', () => {
      timeOfDay.playing = !timeOfDay.playing;
      this.play.blur();
    });
    this.slider.addEventListener('input', () => timeOfDay.set(Number(this.slider.value)));
    // 動かし終えたらフォーカスを外す（入力欄にフォーカスがあると、操作のキーが効かない）
    this.slider.addEventListener('change', () => this.slider.blur());
    this.slider.addEventListener('pointerup', () => this.slider.blur());
    this.speed.addEventListener('change', () => {
      timeOfDay.speed = Number(this.speed.value);
      this.speed.blur();
    });
    this.element.querySelector('.time-now')!.addEventListener('click', (e) => {
      timeOfDay.reset();
      (e.currentTarget as HTMLButtonElement).blur();
    });
    this.unsubscribe = timeOfDay.onChange(() => this.show());
    this.show();
    parent.appendChild(this.element);
  }

  private show(): void {
    this.value.textContent = formatTime(timeOfDay.minutes);
    this.play.textContent = timeOfDay.playing ? '❚❚' : '▶';
    this.play.classList.toggle('active', timeOfDay.playing);
    if (document.activeElement !== this.slider) this.slider.value = String(Math.floor(timeOfDay.minutes));
    const match = SPEEDS.find(([v]) => v === timeOfDay.speed);
    if (match && document.activeElement !== this.speed) this.speed.value = String(match[0]);
  }

  dispose(): void {
    this.unsubscribe();
    this.element.remove();
  }
}
