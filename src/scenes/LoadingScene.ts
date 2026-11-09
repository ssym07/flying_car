import { CAMERA, TERRAIN, VEHICLE, WORLD } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';
import { peekStartAt } from '../core/startAt';

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

    // Flight 開始時とほぼ同じ視点に置いて、必要なタイルを読ませる（駅を選んで始める時は、その駅の上空）
    const { camera, groundY, terrain } = this.ctx.world;
    const at = peekStartAt();
    const p = at ? terrain.toLocal(at.lat, at.lon, 0) : { x: 0, z: 0 };
    camera.position.set(p.x, groundY + VEHICLE.startAltitude + CAMERA.offset.up, p.z + CAMERA.offset.back);
    camera.lookAt(p.x, groundY + VEHICLE.startAltitude, p.z);
  }

  exit(): void {
    this.el?.remove();
  }

  update(dt: number): void {
    const { layers, terrain } = this.ctx.world;
    this.elapsed += dt;
    const idle = terrain.isLoadedWithin(TERRAIN.initialRadius) && layers.every((l) => l.isIdle);
    this.settled = idle ? this.settled + dt : 0;

    if (this.settled >= SETTLE_SEC || this.elapsed >= WORLD.loadTimeoutSec) {
      if (this.settled < SETTLE_SEC) console.warn('[Loading] timeout: 読込完了を待たずに開始します');
      this.ctx.go.flight();
    }
  }

  render(_alpha: number, frameDt: number): void {
    this.ctx.world.render(frameDt);
    const { layers, terrain } = this.ctx.world;
    const all = [...layers.map((l) => l.progress), terrain.progressWithin(TERRAIN.initialRadius)];
    const pct = Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100);
    this.bar!.style.width = `${pct}%`;
    this.label!.textContent = `${pct}%`;
  }
}
