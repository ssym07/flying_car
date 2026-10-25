import { CAMERA, VEHICLE, WORLD } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';

/** 読込キューが空の状態がこの秒数続いたら完了とみなす */
const SETTLE_SEC = 1.0;

/**
 * 飛行開始地点まわりのタイルと地形の初期読込を待ってから Flight へ進む。
 */
export class LoadingScene implements GameScene {
  private el?: HTMLDivElement;
  private bar?: HTMLDivElement;
  private label?: HTMLDivElement;
  private elapsed = 0;
  private settled = 0;

  constructor(private readonly ctx: GameContext) {}

  enter(): void {
    this.elapsed = 0;
    this.settled = 0;
    this.el = mountScreen(
      this.ctx,
      'dim',
      `
      <div class="sub">街を読み込み中…</div>
      <div class="progress"><div></div></div>
      <div class="sub" data-label>0%</div>
      `,
    );
    this.bar = this.el.querySelector('.progress > div')!;
    this.label = this.el.querySelector('[data-label]')!;

    // Flight 開始時とほぼ同じ視点に置いて、必要なタイルを読ませる
    const { camera, groundY } = this.ctx.world;
    camera.position.set(0, groundY + VEHICLE.startAltitude + CAMERA.offset.up, CAMERA.offset.back);
    camera.lookAt(0, groundY + VEHICLE.startAltitude, 0);
  }

  exit(): void {
    this.el?.remove();
  }

  update(dt: number): void {
    const { layers, terrain } = this.ctx.world;
    this.elapsed += dt;
    const idle = terrain.isLoaded && layers.every((l) => l.hasLoaded && !l.isLoading);
    this.settled = idle ? this.settled + dt : 0;

    if (this.settled >= SETTLE_SEC || this.elapsed >= WORLD.loadTimeoutSec) {
      if (this.settled < SETTLE_SEC) console.warn('[Loading] timeout: 読込完了を待たずに開始します');
      this.ctx.go.flight();
    }
  }

  render(): void {
    this.ctx.world.render();
    const { layers, terrain } = this.ctx.world;
    const all = [...layers.map((l) => l.progress), terrain.progress];
    const pct = Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100);
    this.bar!.style.width = `${pct}%`;
    this.label!.textContent = `${pct}%`;
  }
}
