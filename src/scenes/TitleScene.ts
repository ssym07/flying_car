import { KEYS } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import type { GameScene } from '../core/SceneManager';

export class TitleScene implements GameScene {
  private el?: HTMLDivElement;

  constructor(private readonly ctx: GameContext) {}

  enter(): void {
    this.ctx.input.clearPresses();
    this.el = mountScreen(
      this.ctx,
      'title',
      `
      <h1>SKY DRIVE</h1>
      <div class="sub">東京・千代田区の上空を、空飛ぶ車で</div>
      <button type="button">START</button>
      <div class="sub">Enter / Space でもスタート</div>
      `,
    );
    this.el.querySelector('button')!.addEventListener('click', () => this.ctx.go.loading());
  }

  exit(): void {
    this.el?.remove();
  }

  update(): void {
    if (this.ctx.input.consumePress(KEYS.start)) this.ctx.go.loading();
  }

  render(): void {
    // タイトルは HTML だけで描く
  }
}
