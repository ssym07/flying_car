import { KEYS } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';

/** Flight の上に重ねるシーン。update を止めて、下のシーンの render だけ続ける */
export class PauseScene implements GameScene {
  private el?: HTMLDivElement;

  constructor(
    private readonly ctx: GameContext,
    private readonly below: GameScene,
  ) {}

  enter(): void {
    this.ctx.input.clearPresses();
    this.el = mountScreen(
      this.ctx,
      'dim',
      `
      <h1>PAUSE</h1>
      <button type="button" data-resume>再開（Esc）</button>
      <button type="button" data-title>タイトルへ</button>
      `,
    );
    this.el.querySelector('[data-resume]')!.addEventListener('click', () => this.resume());
    this.el.querySelector('[data-title]')!.addEventListener('click', () => this.ctx.go.title());
  }

  exit(): void {
    this.el?.remove();
  }

  update(): void {
    if (this.ctx.input.consumePress(KEYS.pause)) this.resume();
  }

  render(): void {
    // frameDt=0 なのでカメラは動かない
    this.below.render(1, 0);
  }

  private resume(): void {
    this.ctx.input.clearPresses();
    this.ctx.scenes.pop();
  }
}
