import { CAMERA, VEHICLE, WORLD } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';

/** 読込キューが空の状態がこの秒数続いたら完了とみなす */
const SETTLE_SEC = 0.5;

/**
 * 飛行開始地点まわりのタイルの初期読込を待つ。
 * 完了したら建物の底面から地面の高さを推定して Flight へ進む。
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
    const { tiles } = this.ctx.world;
    this.elapsed += dt;
    this.settled = tiles.hasLoaded && !tiles.isLoading ? this.settled + dt : 0;

    if (this.settled >= SETTLE_SEC || this.elapsed >= WORLD.loadTimeoutSec) {
      if (this.settled < SETTLE_SEC) console.warn('[Loading] timeout: 読込完了を待たずに開始します');
      const ground = tiles.estimateGroundHeight();
      if (ground !== null) this.ctx.world.groundY = ground;
      this.ctx.go.flight();
    }
  }

  render(): void {
    this.ctx.world.render();
    const pct = Math.round(this.ctx.world.tiles.progress * 100);
    this.bar!.style.width = `${pct}%`;
    this.label!.textContent = `${pct}%`;
  }
}
