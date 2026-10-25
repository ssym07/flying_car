import { LOOP } from './config';

/**
 * 固定時間刻みの update と可変の render を分離したループ。
 * render には「前回の update から次の update までの進み具合」alpha (0..1) を渡す。
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;

  constructor(
    private readonly update: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
  ) {}

  start(): void {
    this.lastTime = performance.now();
    const tick = (now: number) => {
      // タブ復帰時などの巨大な dt で物理が暴走しないよう上限を設ける
      const frameDt = Math.min((now - this.lastTime) / 1000, 0.25);
      this.lastTime = now;
      this.accumulator += frameDt;

      let steps = 0;
      while (this.accumulator >= LOOP.fixedDt && steps < LOOP.maxStepsPerFrame) {
        this.update(LOOP.fixedDt);
        this.accumulator -= LOOP.fixedDt;
        steps++;
      }
      if (steps === LOOP.maxStepsPerFrame) this.accumulator = 0;

      this.render(this.accumulator / LOOP.fixedDt, frameDt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }
}
