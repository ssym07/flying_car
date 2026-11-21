import { KEYS } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import { dataUrl, REGION, REGIONS, type Region, switchRegion } from '../core/region';
import type { GameScene } from '../core/SceneManager';
import { setStartAt } from '../core/startAt';
import { loadAllPlaces, type RegionStation } from '../data/allStations';
import japan from '../data/japanDots.json';
import { StationSearch } from '../ui/stationSearch';

export class TitleScene implements GameScene {
  private el?: HTMLDivElement;
  private search?: StationSearch<RegionStation>;

  constructor(private readonly ctx: GameContext) {}

  enter(): void {
    this.ctx.input.clearPresses();
    // 西から東の順（福岡・大阪・愛知・東京・北海道）
    const buttons = Object.values(REGIONS)
      .sort((a, b) => a.origin.lonDeg - b.origin.lonDeg)
      .map(
        (r) => `
        <button type="button" class="region${r.id === REGION.id ? ' current' : ''}" data-region="${r.id}" style="--c: ${WORLD_COLORS[r.id]}">
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
    void showCoverage(this.el.querySelector<SVGSVGElement>('.japan-map')!);
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-region]')) {
      b.addEventListener('click', () => this.start(b.dataset.region as Region['id']));
    }

    // 全部の地域の駅から探して、その駅の上空から飛び始める。駅の一覧は入力欄を使い始めた時に読む
    let stations: RegionStation[] | null = null;
    this.search = new StationSearch<RegionStation>(
      // 飛行中の駅検索と同じ右上
      this.el,
      (s) => this.startAt(s),
      () => null,
      {
        className: 'search title-search',
        placeholder: '駅名・大学名で探して、そこから始める（例：博多・栄・梅田）',
        stations: () => stations,
        onFirstFocus: () => {
          void loadAllPlaces().then((list) => {
            stations = list;
            this.search?.refresh();
          });
        },
        note: (s) => REGIONS[s.region].name,
      },
    );
  }

  /** 選んだ駅の上空から始める。別の地域の駅なら、その地域で読み込み直す */
  private startAt(s: RegionStation): void {
    const at = { lat: s.lat, lon: s.lon };
    if (s.region === REGION.id) {
      setStartAt(at);
      this.ctx.go.loading();
    } else {
      switchRegion(s.region, true, at);
    }
  }

  /** 今の地域ならそのままエントランス（市町村を選ぶ画面）へ、違う地域ならその地域で読み込み直してからエントランスへ */
  private start(id: Region['id']): void {
    if (id === REGION.id) this.ctx.go.entrance();
    else switchRegion(id, 'entrance');
  }

  exit(): void {
    this.search?.dispose();
    this.el?.remove();
  }

  update(): void {
    if (this.ctx.input.consumePress(KEYS.start)) this.ctx.go.entrance();
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
      <g class="pin${g.id === REGION.id ? ' current' : ''}" data-region="${g.id}" style="--c: ${WORLD_COLORS[g.id]}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
        <circle class="pulse" r="1.2"/><circle class="dot" r="0.9"/>
        <text x="1.8" y="0.6">${g.name}</text>
      </g>`;
    })
    .join('');
  return `<svg class="japan-map" viewBox="0 0 ${japan.cols} ${japan.rows}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g class="coverage"></g><g class="dots">${dots}</g>${pins}
  </svg>`;
}

/** ワールドごとの色（ホームの範囲・印・ボタンの縁）。暗い背景で見分けやすい 5 色 */
const WORLD_COLORS: Record<Region['id'], string> = {
  kyushu: '#ff7d93',
  kinki: '#ffa94d',
  chubu: '#f2dd55',
  kanto: '#66ccff',
  hokkaido: '#7fe08a',
};

/**
 * 再現している範囲（各ワールドのエントランスの地図 municipalities.json の市区町村の形）を、点の日本列島の上にワールドの色で描く。
 * 市区町村の形をまとめて 1 つの面として半透明で塗り、縁を線で囲み、中の点をその色にする。読めなかった地域は描かない
 */
async function showCoverage(svg: SVGSVGElement): Promise<void> {
  // 経度・緯度 → 点の格子の座標
  const gx = (lon: number) => (lon - japan.w) / japan.lonStep;
  const gy = (lat: number) => (japan.n - lat) / japan.step;
  const worlds = await Promise.all(
    Object.values(REGIONS).map(async (r) => {
      const rings: Array<Array<[number, number]>> = [];
      try {
        const res = await fetch(dataUrl(`${r.dataDir}municipalities.json`));
        if (res.ok) {
          const data = (await res.json()) as { m: Array<{ r: number[][] }> };
          for (const m of data.m) {
            for (const flat of m.r) {
              const ring: Array<[number, number]> = [];
              for (let i = 0; i < flat.length; i += 2) ring.push([gx(flat[i]), gy(flat[i + 1])]);
              rings.push(ring);
            }
          }
        }
      } catch {
        // この地域は描かない
      }
      return { id: r.id, rings };
    }),
  );
  if (!svg.isConnected) return;
  const group = svg.querySelector('.coverage')!;
  const circles = svg.querySelectorAll<SVGCircleElement>('.dots circle');
  for (const { id, rings } of worlds) {
    if (rings.length === 0) continue;
    const color = WORLD_COLORS[id];
    const svgNs = 'http://www.w3.org/2000/svg';
    const fill = document.createElementNS(svgNs, 'path');
    fill.setAttribute('class', 'fill');
    fill.setAttribute('d', rings.map((ring) => `M${ring.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L')}Z`).join(''));
    fill.style.setProperty('--c', color);
    group.appendChild(fill);
    // 縁：隣の市区町村と共有する辺（2 回出てくる辺）を消し、外側の辺だけを線にする（市区町村の境は描かない）
    const key = ([x, y]: [number, number]) => `${x.toFixed(4)},${y.toFixed(4)}`;
    const count = new Map<string, number>();
    const edges: Array<[[number, number], [number, number], string]> = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const ka = key(a);
        const kb = key(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        count.set(k, (count.get(k) ?? 0) + 1);
        edges.push([a, b, k]);
      }
    }
    const outline = document.createElementNS(svgNs, 'path');
    outline.setAttribute('class', 'edge');
    outline.setAttribute(
      'd',
      edges
        .filter(([, , k]) => count.get(k) === 1)
        .map(([a, b]) => `M${a[0].toFixed(3)} ${a[1].toFixed(3)}L${b[0].toFixed(3)} ${b[1].toFixed(3)}`)
        .join(''),
    );
    outline.style.setProperty('--c', color);
    group.appendChild(outline);

    // 点の中心が形の中（輪をまたいだ回数が奇数）ならその色にする
    const inside = (x: number, y: number) => {
      let hit = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
        }
      }
      return hit;
    };
    japan.dots.forEach(([c, row], i) => {
      if (inside(c + 0.5, row + 0.5) && circles[i]) {
        circles[i].classList.add('lit');
        circles[i].style.setProperty('--c', color);
      }
    });
  }
}
