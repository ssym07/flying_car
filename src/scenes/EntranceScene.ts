import { KEYS } from '../core/config';
import { mountScreen, type GameContext } from '../core/context';
import { REGION, regionUrl } from '../core/region';
import type { GameScene } from '../core/SceneManager';
import { setStartAt } from '../core/startAt';

/** public/municipalities.json の1件（scripts/build-municipalities.mjs） */
interface MuniData {
  /** 名前 */
  n: string;
  /** 一覧の見出し（都府県。区ごとに選ぶ政令市は市の名前） */
  p: string;
  /** 役所 [緯度, 経度] */
  h: [number, number];
  /** 役所の名前 */
  hn: string;
  /** 名前を置く点 [緯度, 経度] */
  l: [number, number];
  /** 輪 [経度, 緯度, 経度, 緯度, ...] */
  r: number[][];
}

interface Muni extends MuniData {
  path: SVGPathElement;
  label: SVGTextElement;
  item: HTMLLIElement;
  /** 地図の上の広さ（km、外接長方形の幅と高さ） */
  w: number;
  h2: number;
}

const SVG = 'http://www.w3.org/2000/svg';
/** 名前の文字の大きさ (px) */
const FONT = 12;
/** 地図の枠 (km)。全部のワールドで同じにして縮尺をそろえる */
const SPAN = { w: 140, h: 130 };
/** 開いた時に見せる枠 (km)。東京・福岡は全体が入り、大阪・愛知は端がはみ出す（ドラッグで動かすか、引いて SPAN まで見られる） */
const START_SPAN = { w: 90, h: 85 };

/**
 * エントランス：ワールド（地域）の、建物を再現している市町村の地図。
 * 市町村を地図か一覧で選び、その市役所・町村役場の上空から飛び始める（東京23区と大阪市・京都市・神戸市・名古屋市・福岡市は区ごと、ほかの政令市は市ごと）。
 * 地図はホームと同じ暗い背景に、市町村の境を線で描く。ホイールで拡大、ドラッグで移動
 */
export class EntranceScene implements GameScene {
  private el?: HTMLDivElement;
  private svg?: SVGSVGElement;
  private munis: Muni[] = [];
  private selected: Muni | null = null;
  /** 地図の表示範囲（km。viewBox） */
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private full = { x: 0, y: 0, w: 1, h: 1 };
  private lat0 = 0;
  private lon0 = 0;
  private readonly onResize = (): void => this.layoutLabels();

  constructor(private readonly ctx: GameContext) {}

  enter(): void {
    this.ctx.input.clearPresses();
    this.el = mountScreen(
      this.ctx,
      'title entrance',
      `
      <svg class="entrance-map" xmlns="${SVG}">
        <g class="munis"></g><g class="halls"></g><g class="labels"></g>
      </svg>
      <div class="entrance-head">
        <button type="button" class="entrance-back" data-back>‹ ホーム</button>
        <h2>${REGION.name}</h2>
        <div class="sub">市町村を選ぶと、その役所の上空から飛び始めます</div>
      </div>
      <div class="entrance-side">
        <input type="search" class="entrance-filter" placeholder="市区町村名で絞り込む" autocomplete="off" />
        <ul class="entrance-list"><li class="entrance-loading">読み込み中…</li></ul>
      </div>
      <div class="entrance-credit">出典：国土数値情報（行政区域データ・市町村役場等及び公的集会施設データ）（国土交通省）を加工</div>
      <div class="entrance-card" hidden>
        <div class="entrance-card-text"><b></b><span></span></div>
        <button type="button" data-go>ここから飛ぶ</button>
      </div>
      `,
    );
    this.svg = this.el.querySelector<SVGSVGElement>('.entrance-map')!;
    this.el.querySelector('[data-back]')!.addEventListener('click', () => this.ctx.go.title());
    this.el.querySelector('[data-go]')!.addEventListener('click', () => this.go());
    const filter = this.el.querySelector<HTMLInputElement>('.entrance-filter')!;
    filter.addEventListener('input', () => this.filter(filter.value.trim()));
    // 入力欄の Enter は、絞り込んだ結果が1つならそれで飛ぶ
    filter.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const shown = this.munis.filter((m) => !m.item.hidden);
      if (shown.length === 1) this.select(shown[0], true);
    });
    this.attachZoom(this.svg);
    window.addEventListener('resize', this.onResize);

    void fetch(regionUrl('municipalities.json'))
      .then((res) => res.json() as Promise<{ m: MuniData[] }>)
      .then((data) => this.build(data.m))
      .catch(() => {
        this.el!.querySelector('.entrance-list')!.innerHTML = '<li class="entrance-loading">地図を読み込めませんでした</li>';
      });
  }

  /** 経度・緯度 → 地図の座標 (km) */
  private project(lon: number, lat: number): [number, number] {
    return [(lon - this.lon0) * Math.cos((this.lat0 * Math.PI) / 180) * 111.32, (this.lat0 - lat) * 110.95];
  }

  private build(data: MuniData[]): void {
    if (!this.el || !this.svg) return;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const m of data) {
      for (const r of m.r) {
        for (let i = 0; i < r.length; i += 2) {
          w = Math.min(w, r[i]);
          e = Math.max(e, r[i]);
          s = Math.min(s, r[i + 1]);
          n = Math.max(n, r[i + 1]);
        }
      }
    }
    this.lat0 = (s + n) / 2;
    this.lon0 = (w + e) / 2;
    const [x0, y0] = this.project(w, n);
    const [x1, y1] = this.project(e, s);
    // どのワールドも同じ縮尺（いちばん広い大阪の東西 132km・愛知の南北 122km が入る枠）。狭いワールドはまわりが空く
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    this.full = { x: cx - SPAN.w / 2, y: cy - SPAN.h / 2, w: SPAN.w, h: SPAN.h };
    // 開いた時の中心はワールドの中心（梅田・名古屋など）。全体が枠に入る向きは全体のまん中、入らない向きは全体の外を見せすぎない
    const [ox, oy] = this.project(REGION.origin.lonDeg, REGION.origin.latDeg);
    const center = (o: number, a: number, b: number, span: number): number =>
      b - a <= span ? (a + b) / 2 : Math.min(Math.max(o, a + span / 2), b - span / 2);
    const sx = center(ox, x0, x1, START_SPAN.w);
    const sy = center(oy, y0, y1, START_SPAN.h);
    this.view = { x: sx - START_SPAN.w / 2, y: sy - START_SPAN.h / 2, w: START_SPAN.w, h: START_SPAN.h };

    const gMunis = this.svg.querySelector('.munis')!;
    const gHalls = this.svg.querySelector('.halls')!;
    const gLabels = this.svg.querySelector('.labels')!;
    const list = this.el.querySelector('.entrance-list')!;
    list.innerHTML = '';
    let pref = '';
    for (const d of data) {
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      const dPath = d.r
        .map((r) => {
          let out = '';
          for (let i = 0; i < r.length; i += 2) {
            const [x, y] = this.project(r[i], r[i + 1]);
            bx0 = Math.min(bx0, x);
            bx1 = Math.max(bx1, x);
            by0 = Math.min(by0, y);
            by1 = Math.max(by1, y);
            out += `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${y.toFixed(3)}`;
          }
          return `${out}Z`;
        })
        .join('');
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', dPath);
      path.setAttribute('class', 'muni');
      gMunis.appendChild(path);

      const [hx, hy] = this.project(d.h[1], d.h[0]);
      const hall = document.createElementNS(SVG, 'circle');
      hall.setAttribute('cx', hx.toFixed(3));
      hall.setAttribute('cy', hy.toFixed(3));
      hall.setAttribute('class', 'hall');
      gHalls.appendChild(hall);

      const [lx, ly] = this.project(d.l[1], d.l[0]);
      const label = document.createElementNS(SVG, 'text');
      label.setAttribute('x', lx.toFixed(3));
      label.setAttribute('y', ly.toFixed(3));
      label.textContent = d.n;
      gLabels.appendChild(label);

      if (d.p !== pref) {
        pref = d.p;
        const head = document.createElement('li');
        head.className = 'entrance-pref';
        head.textContent = pref;
        list.appendChild(head);
      }
      const item = document.createElement('li');
      item.className = 'entrance-item';
      item.textContent = d.n;
      list.appendChild(item);

      const m: Muni = { ...d, path, label, item, w: bx1 - bx0, h2: by1 - by0 };
      this.munis.push(m);
      const hover = (on: boolean): void => {
        path.classList.toggle('hover', on);
        label.classList.toggle('hover', on);
        item.classList.toggle('hover', on);
      };
      for (const target of [path, item]) {
        target.addEventListener('pointerenter', () => hover(true));
        target.addEventListener('pointerleave', () => hover(false));
      }
      path.addEventListener('click', () => {
        if (!this.dragged) this.select(m, this.selected === m);
      });
      path.addEventListener('dblclick', () => this.select(m, true));
      item.addEventListener('click', () => this.select(m, this.selected === m));
    }
    this.applyView();
  }

  /** 選ぶ（go なら、そのまま飛ぶ） */
  private select(m: Muni, go = false): void {
    if (this.selected) {
      this.selected.path.classList.remove('selected');
      this.selected.label.classList.remove('selected');
      this.selected.item.classList.remove('selected');
    }
    this.selected = m;
    m.path.classList.add('selected');
    m.label.classList.add('selected');
    m.item.classList.add('selected');
    // 選んだ市町村を前に（境の線が隣の下に隠れないように）
    m.path.parentNode!.appendChild(m.path);
    m.item.scrollIntoView({ block: 'nearest' });
    const card = this.el!.querySelector<HTMLElement>('.entrance-card')!;
    card.hidden = false;
    card.querySelector('b')!.textContent = m.n;
    // 区ごとに選ぶ政令市の区は「京都市中京区役所」と市の名前が入っているので、見出し（京都市）は付けない
    card.querySelector('span')!.textContent = `${m.hn.startsWith(m.p) ? '' : `${m.p}・`}${m.hn}の上空から`;
    this.layoutLabels();
    if (go) this.go();
  }

  private go(): void {
    if (!this.selected) return;
    setStartAt({ lat: this.selected.h[0], lon: this.selected.h[1] });
    this.ctx.go.loading();
  }

  private filter(q: string): void {
    for (const m of this.munis) {
      const hit = q === '' || m.n.includes(q) || m.p.includes(q);
      m.item.hidden = !hit;
      m.path.classList.toggle('dim', !hit);
    }
    for (const head of this.el!.querySelectorAll<HTMLElement>('.entrance-pref')) {
      let next = head.nextElementSibling as HTMLElement | null;
      let any = false;
      while (next && !next.classList.contains('entrance-pref')) {
        any ||= !next.hidden;
        next = next.nextElementSibling as HTMLElement | null;
      }
      head.hidden = !any;
    }
  }

  // --- 拡大・移動 ---
  private dragged = false;

  private attachZoom(svg: SVGSVGElement): void {
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [px, py] = this.toMap(svg, e.clientX, e.clientY);
        const k = Math.exp(e.deltaY * 0.0015);
        this.zoomAt(px, py, k);
      },
      { passive: false },
    );
    let start: { x: number; y: number; vx: number; vy: number } | null = null;
    svg.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.dragged = false;
    });
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.onMoveImpl = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!this.dragged && Math.hypot(dx, dy) < 5) return;
      this.dragged = true;
      const scale = this.scale();
      this.view.x = start.vx - dx / scale;
      this.view.y = start.vy - dy / scale;
      this.applyView();
    };
    this.onUpImpl = () => {
      start = null;
    };
  }

  private onMoveImpl: (e: PointerEvent) => void = () => {};
  private onUpImpl: () => void = () => {};
  private readonly onMove = (e: PointerEvent): void => this.onMoveImpl(e);
  private readonly onUp = (): void => this.onUpImpl();

  /** 画面の 1km が何 px か */
  private scale(): number {
    const r = this.svg!.getBoundingClientRect();
    return Math.min(r.width / this.view.w, r.height / this.view.h);
  }

  private toMap(svg: SVGSVGElement, cx: number, cy: number): [number, number] {
    const r = svg.getBoundingClientRect();
    const s = this.scale();
    // preserveAspectRatio="xMidYMid meet" の余白
    const ox = (r.width - this.view.w * s) / 2;
    const oy = (r.height - this.view.h * s) / 2;
    return [this.view.x + (cx - r.left - ox) / s, this.view.y + (cy - r.top - oy) / s];
  }

  private zoomAt(px: number, py: number, k: number): void {
    // 全体より引かない・幅 2km より寄らない
    const w = Math.min(this.full.w, Math.max(2, this.view.w * k));
    const kk = w / this.view.w;
    this.view = { x: px - (px - this.view.x) * kk, y: py - (py - this.view.y) * kk, w, h: this.view.h * kk };
    this.applyView();
  }

  private applyView(): void {
    const v = this.view;
    // 全体の外へ出すぎない
    v.x = Math.min(Math.max(v.x, this.full.x - v.w * 0.3), this.full.x + this.full.w - v.w * 0.7);
    v.y = Math.min(Math.max(v.y, this.full.y - v.h * 0.3), this.full.y + this.full.h - v.h * 0.7);
    this.svg!.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.layoutLabels();
  }

  /** 名前の大きさを画面で同じ px にし、市町村に収まらない名前・ほかと重なる名前は出さない（選んだ・指した市町村は出す） */
  private layoutLabels(): void {
    if (!this.svg || this.munis.length === 0) return;
    const s = this.scale();
    const font = FONT / s;
    this.svg.style.setProperty('--font', `${font}px`);
    this.svg.style.setProperty('--hall', `${3 / s}px`);
    const placed: [number, number, number, number][] = [];
    // 広い市町村から置く
    const order = [...this.munis].sort((a, b) => Number(b === this.selected) - Number(a === this.selected) || b.w * b.h2 - a.w * a.h2);
    for (const m of order) {
      const tw = m.n.length * font;
      const x = +m.label.getAttribute('x')!;
      const y = +m.label.getAttribute('y')!;
      const box: [number, number, number, number] = [x - tw / 2, y - font * 0.6, x + tw / 2, y + font * 0.6];
      const fits = m === this.selected || (tw < m.w * 0.9 && font * 1.2 < m.h2 * 0.8);
      const free = !placed.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3]);
      const show = fits && free;
      m.label.classList.toggle('hidden', !show);
      if (show) placed.push(box);
    }
  }

  exit(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el?.remove();
  }

  update(): void {
    if (this.ctx.input.consumePress(KEYS.pause)) this.ctx.go.title();
    else if (this.ctx.input.consumePress(KEYS.start)) this.go();
  }

  render(): void {
    // HTML と SVG だけで描く
  }
}
