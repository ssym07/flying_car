/** 速度・高度を表示する HTML オーバーレイ */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly speedEl: HTMLSpanElement;
  private readonly altEl: HTMLSpanElement;
  private readonly aglEl: HTMLSpanElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-item"><span class="hud-label">SPEED</span><span class="hud-value" data-speed>0</span><span class="hud-unit">km/h</span></div>
      <div class="hud-item"><span class="hud-label">ALT</span><span class="hud-value" data-alt>0</span><span class="hud-unit">m</span></div>
      <div class="hud-item"><span class="hud-label">AGL</span><span class="hud-value" data-agl>0</span><span class="hud-unit">m</span></div>
      <div class="hud-help">WASD 移動・旋回 / Space 上昇 / Shift 下降 / Esc ポーズ</div>
    `;
    this.speedEl = this.root.querySelector('[data-speed]')!;
    this.altEl = this.root.querySelector('[data-alt]')!;
    this.aglEl = this.root.querySelector('[data-agl]')!;
    parent.appendChild(this.root);
  }

  /**
   * @param speedMs 速度 (m/s)
   * @param altitude 標高（海抜） (m)
   * @param agl 真下の地面・屋上からの高さ (m)
   */
  set(speedMs: number, altitude: number, agl: number): void {
    this.speedEl.textContent = Math.round(speedMs * 3.6).toString();
    this.altEl.textContent = Math.round(altitude).toString();
    this.aglEl.textContent = Math.round(agl).toString();
  }

  dispose(): void {
    this.root.remove();
  }
}
