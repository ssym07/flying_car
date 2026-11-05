import { KEYS } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import { REGION, REGIONS, type Region, switchRegion } from '../core/region';
import type { GameScene } from '../core/SceneManager';

export class TitleScene implements GameScene {
  private el?: HTMLDivElement;

  constructor(private readonly ctx: GameContext) {}

  enter(): void {
    this.ctx.input.clearPresses();
    const buttons = Object.values(REGIONS)
      .map(
        (r) => `
        <button type="button" class="region${r.id === REGION.id ? ' current' : ''}" data-region="${r.id}">
          <span class="name">${r.name}</span>
        </button>`,
      )
      .join('');
    this.el = mountScreen(
      this.ctx,
      'title',
      `
      <h1>SKY DRIVE</h1>
      <div class="sub">空飛ぶ車で街の上空へ。行き先を選んでください</div>
      <div class="regions">${buttons}</div>
      <div class="sub">Enter / Space で ${REGION.name} へ</div>
      `,
    );
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-region]')) {
      b.addEventListener('click', () => this.start(b.dataset.region as Region['id']));
    }
  }

  /** 今の地域ならそのまま読込へ、違う地域ならその地域で読み込み直してから読込へ */
  private start(id: Region['id']): void {
    if (id === REGION.id) this.ctx.go.loading();
    else switchRegion(id, true);
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
