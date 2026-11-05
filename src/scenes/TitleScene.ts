import { KEYS } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import { REGION, REGIONS, type Region, switchRegion } from '../core/region';
import type { GameScene } from '../core/SceneManager';
import japan from '../data/japanDots.json';

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
      ${japanMap()}
      <div class="title-panel">
        <h1>SKY DRIVE</h1>
        <div class="sub">空飛ぶ車で街の上空へ。行き先を選んでください</div>
        <div class="regions">${buttons}</div>
      </div>
      <div class="sub start-hint">Enter / Space で ${REGION.name} へ</div>
      `,
    );
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-region]')) {
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

/** 背景の、点で描いた日本列島（scripts/build-japan-dots.mjs）と、選べる地域の印。印を押してもその地域へ */
function japanMap(): string {
  const r = 0.32;
  const dots = japan.dots.map(([c, row]) => `<circle cx="${c + 0.5}" cy="${row + 0.5}" r="${r}"/>`).join('');
  const pins = Object.values(REGIONS)
    .map((g) => {
      const x = (g.origin.lonDeg - japan.w) / japan.lonStep;
      const y = (japan.n - g.origin.latDeg) / japan.step;
      return `
      <g class="pin${g.id === REGION.id ? ' current' : ''}" data-region="${g.id}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
        <circle class="pulse" r="1.2"/><circle class="dot" r="0.9"/>
        <text x="1.8" y="0.6">${g.name}</text>
      </g>`;
    })
    .join('');
  return `<svg class="japan-map" viewBox="0 0 ${japan.cols} ${japan.rows}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g class="dots">${dots}</g>${pins}
  </svg>`;
}
