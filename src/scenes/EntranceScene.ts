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
/**
 * 役所からどれだけ手前 (m) で飛び始めるか。車は北向き（VEHICLE.startYaw）で始まるので、役所の南に置いて正面に役所と看板が見えるようにする
 * （真上だと役所は車の下に隠れ、看板も近すぎて薄くなる）
 */
const START_BACK = 300;
/** 地図の枠 (km)。全部のワールドで同じにして縮尺をそろえる */
const SPAN = { w: 140, h: 130 };
/** 開いた時に見せる枠 (km)。これより引けない。東京・福岡・北海道は全体が入り、大阪・愛知は端がはみ出す（ドラッグで動かして見る） */
const START_SPAN = { w: 90, h: 85 };
/** 縮尺の定規のいちばん長い長さ (px) */
const SCALE_BAR_PX = 160;

/**
 * エントランス：ワールド（地域）の、建物を再現している市町村の地図。
 * 市町村を地図か一覧で押すと、すぐその市役所・町村役場の上空から飛び始める（東京23区と大阪市・京都市・神戸市・名古屋市・福岡市は区ごと、ほかの政令市は市ごと）。
 * 地図はホームと同じ暗い背景に、市町村の境を線で描く。ホイールで拡大、ドラッグで移動
 */
export class EntranceScene implements GameScene {
  private el?: HTMLDivElement;
  private svg?: SVGSVGElement;
  private munis: Muni[] = [];
  /** 地図の表示範囲（km。viewBox） */
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private full = { x: 0, y: 0, w: 1, h: 1 };
  /** いちばん引いた時の幅（km）。ふつうは開いた時の幅、枠より広いワールド（北海道）は全体が入る幅 */
  private maxW = START_SPAN.w;
  private lat0 = 0;
  private lon0 = 0;
  private readonly onResize = (): void => {
    this.layoutLabels();
    this.updateScaleBar();
  };

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
      <div class="entrance-scale" hidden><div class="entrance-scale-bar"></div><span></span></div>
      <div class="entrance-credit">出典：国土数値情報（行政区域データ・市町村役場等及び公的集会施設データ）（国土交通省）を加工</div>
      `,
    );
    this.svg = this.el.querySelector<SVGSVGElement>('.entrance-map')!;
    this.el.querySelector('[data-back]')!.addEventListener('click', () => this.ctx.go.title());
    const filter = this.el.querySelector<HTMLInputElement>('.entrance-filter')!;
    filter.addEventListener('input', () => this.filter(filter.value.trim()));
    // 入力欄の Enter は、絞り込んだ結果が1つならそれで飛ぶ
    filter.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const shown = this.munis.filter((m) => !m.item.hidden);
      if (shown.length === 1) this.go(shown[0]);
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
    // 枠より広いワールド（北海道：石狩〜函館の南北 170km）は、枠を全体＋まわり 10km に広げ、全体が見えるまで引けるようにする
    const fw = Math.max(SPAN.w, x1 - x0 + 20);
    const fh = Math.max(SPAN.h, y1 - y0 + 20);
    this.full = { x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh };
    this.maxW = Math.max(START_SPAN.w, x1 - x0 + 20, ((y1 - y0 + 20) * START_SPAN.w) / START_SPAN.h);
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
      // 押したらすぐ、その役所の上空から飛ぶ（地図はドラッグで動かした時は飛ばない）
      path.addEventListener('click', () => {
        if (!this.dragged) this.go(m);
      });
      item.addEventListener('click', () => this.go(m));
      // 指した時に、どこから飛ぶかを出す（区ごとに選ぶ政令市の区は「京都市中京区役所」と市の名前が入っているので、見出しは付けない）
      const tip = `${d.n}：${d.hn.startsWith(d.p) ? '' : `${d.p}・`}${d.hn}の上空から`;
      item.title = tip;
      const title = document.createElementNS(SVG, 'title');
      title.textContent = tip;
      path.appendChild(title);
    }
    this.applyView();
  }

  /** その市町村の役所の手前（南）の上空から、役所の方を向いて飛ぶ */
  private go(m: Muni): void {
    setStartAt({ lat: m.h[0] - START_BACK / 110950, lon: m.h[1] });
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

  /** 縮尺の定規：1・2・5 × 10 の累乗 km のうち、画面で SCALE_BAR_PX px 以下でいちばん長いもの。間に目盛りを入れる */
  private updateScaleBar(): void {
    const el = this.el?.querySelector<HTMLElement>('.entrance-scale');
    if (!el || !this.svg || this.munis.length === 0) return;
    const pxPerKm = this.scale();
    if (!(pxPerKm > 0)) return;
    let km = 0.1;
    let parts = 5;
    for (const exp of [-1, 0, 1, 2, 3]) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** exp;
        if (v * pxPerKm <= SCALE_BAR_PX) {
          km = v;
          // 目盛り：1・5 は 5 つ（10km なら 2km ごと）、2 は 4 つ（2km なら 500m ごと）に分ける
          parts = m === 2 ? 4 : 5;
        }
      }
    }
    el.hidden = false;
    const bar = el.querySelector<HTMLElement>('.entrance-scale-bar')!;
    bar.style.width = `${(km * pxPerKm).toFixed(1)}px`;
    // 間の目盛り（真ん中は長く）
    bar.replaceChildren(
      ...Array.from({ length: parts - 1 }, (_, i) => {
        const tick = document.createElement('i');
        tick.style.left = `${((i + 1) / parts) * 100}%`;
        if ((i + 1) * 2 === parts) tick.className = 'mid';
        return tick;
      }),
    );
    el.querySelector('span')!.textContent = km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`;
  }

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
    // 開いた時の縮尺（START_SPAN。全体が入らないワールドは全体が入る縮尺）より引かない・幅 2km より寄らない
    const w = Math.min(this.maxW, Math.max(2, this.view.w * k));
    const kk = w / this.view.w;
    this.view = { x: px - (px - this.view.x) * kk, y: py - (py - this.view.y) * kk, w, h: this.view.h * kk };
    // 全体が入る縮尺まで引いた時は、全体のまん中に寄せる（札幌を中心に開く北海道で、函館が下にはみ出さないように）
    if (this.maxW > START_SPAN.w && w >= this.maxW) {
      this.view.x = this.full.x + (this.full.w - this.view.w) / 2;
      this.view.y = this.full.y + (this.full.h - this.view.h) / 2;
    }
    this.applyView();
  }

  private applyView(): void {
    const v = this.view;
    // 全体の外へ出すぎない
    v.x = Math.min(Math.max(v.x, this.full.x - v.w * 0.3), this.full.x + this.full.w - v.w * 0.7);
    v.y = Math.min(Math.max(v.y, this.full.y - v.h * 0.3), this.full.y + this.full.h - v.h * 0.7);
    this.svg!.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.updateScaleBar();
    this.layoutLabels();
  }

  /** 名前の大きさを画面で同じ px にし、市町村に収まらない名前・ほかと重なる名前は出さない（指した市町村は出す） */
  private layoutLabels(): void {
    if (!this.svg || this.munis.length === 0) return;
    const s = this.scale();
    const font = FONT / s;
    this.svg.style.setProperty('--font', `${font}px`);
    this.svg.style.setProperty('--hall', `${3 / s}px`);
    const placed: [number, number, number, number][] = [];
    // 広い市町村から置く
    const order = [...this.munis].sort((a, b) => b.w * b.h2 - a.w * a.h2);
    for (const m of order) {
      const tw = m.n.length * font;
      const x = +m.label.getAttribute('x')!;
      const y = +m.label.getAttribute('y')!;
      const box: [number, number, number, number] = [x - tw / 2, y - font * 0.6, x + tw / 2, y + font * 0.6];
      const fits = tw < m.w * 0.9 && font * 1.2 < m.h2 * 0.8;
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
  }

  render(): void {
    // HTML と SVG だけで描く
  }
}
