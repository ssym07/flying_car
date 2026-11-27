import type { Route, Trains } from '../world/Trains';

type Line = ReturnType<Trains['lines']>[number];

/** 図の時間の幅（分）の選択肢と、最初の幅 */
const SPANS = [20, 40, 60, 120, 180];
const DEFAULT_SPAN = 40;
/** 今の時刻を、図の幅のこの割合の所に置く（少し先まで見えるように） */
const NOW_AT = 0.3;
const STORAGE_KEY = 'sky-drive.diagram-line';
/** 描き直す間隔（秒） */
const REDRAW = 0.25;

/**
 * ダイヤ：路線図の隣の「ダイヤ」ボタンで開く板。選んだ路線のダイヤグラム（横 = 時刻、縦 = 駅。列車 1 本を 1 本の線）と、
 * 今の時刻の縦線・走っている列車の位置、運行状況（走っている本数・運転間隔・始発と終電）、選んだ駅の次の発車を出す。
 * 時刻表は src/world/Trains.ts（各駅停車だけ）
 */
export class DiagramPanel {
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly select: HTMLSelectElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly status: HTMLDivElement;
  private readonly departures: HTMLDivElement;
  private lines: Line[] = [];
  private line: Line | null = null;
  private span = DEFAULT_SPAN;
  private station: string | null = null;
  private opened = false;
  private wait = 0;
  /** 駅名の縦の位置（図の上の端から、0..1）。押した駅を探すため */
  private rows: Array<{ name: string; y: number }> = [];

  constructor(
    parent: HTMLElement,
    private readonly trains: Trains,
    /** 開いた時（同じ場所に出る路線図・ピンの一覧を閉じる） */
    private readonly onOpen: () => void = () => {},
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'route-map-toggle diagram-toggle';
    this.button.textContent = 'ダイヤ';
    this.button.title = '電車のダイヤと運行状況';
    this.button.addEventListener('click', () => this.toggle());

    this.panel = document.createElement('div');
    this.panel.className = 'diagram';
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="diagram-head">
        <select aria-label="路線"></select>
        <div class="diagram-span">
          <button type="button" data-span="-1" aria-label="時間を短く">−</button>
          <button type="button" data-span="1" aria-label="時間を長く">＋</button>
        </div>
      </div>
      <div class="diagram-body"><canvas></canvas></div>
      <div class="diagram-status"></div>
      <div class="diagram-departures"></div>`;
    this.select = this.panel.querySelector('select')!;
    this.canvas = this.panel.querySelector('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    this.status = this.panel.querySelector('.diagram-status')!;
    this.departures = this.panel.querySelector('.diagram-departures')!;
    this.select.addEventListener('change', () => {
      this.choose(this.select.value);
      this.select.blur();
    });
    this.panel.querySelector('.diagram-span')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const i = SPANS.indexOf(this.span) + Number(b.dataset.span);
      this.span = SPANS[Math.max(0, Math.min(SPANS.length - 1, i))];
      this.draw();
    });
    // 駅名を押すと、その駅の次の発車を出す
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (e.clientX - r.left > LABEL_W + 8) return;
      const y = e.clientY - r.top;
      let best: { name: string; y: number } | null = null;
      for (const row of this.rows) {
        const py = TOP + row.y * (r.height - TOP - BOTTOM);
        if (!best || Math.abs(py - y) < Math.abs(TOP + best.y * (r.height - TOP - BOTTOM) - y)) best = row;
      }
      if (best) {
        this.station = best.name;
        this.draw();
      }
    });
    parent.append(this.button, this.panel);
  }

  dispose(): void {
    this.button.remove();
    this.panel.remove();
  }

  close(): void {
    if (this.opened) this.toggle(false);
  }

  /** 毎フレーム呼ぶ（開いている時だけ、少しずつ描き直す） */
  update(dt: number): void {
    if (!this.opened) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = REDRAW;
    this.draw();
  }

  private toggle(open = !this.opened): void {
    this.opened = open;
    this.panel.hidden = !open;
    this.button.classList.toggle('active', open);
    if (!open) return;
    this.onOpen();
    this.lines = this.trains.lines().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    this.select.innerHTML = this.lines.map((l) => `<option value="${escapeAttr(l.key)}">${escapeHtml(l.name)}</option>`).join('');
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // 保存できない時は覚えない
    }
    const first = this.lines.find((l) => l.key === saved) ?? this.lines.find((l) => l.name === 'JR山手線') ?? this.lines[0];
    if (first) this.choose(first.key);
    this.wait = 0;
  }

  private choose(key: string): void {
    this.line = this.lines.find((l) => l.key === key) ?? null;
    this.select.value = key;
    this.station = null;
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      // 保存できない時は覚えない
    }
    this.draw();
  }

  private draw(): void {
    const line = this.line;
    const canvas = this.canvas;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    const g = this.g;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.fillStyle = '#20252c';
    g.fillRect(0, 0, w, h);
    if (!line) {
      this.status.textContent = '電車のデータがありません';
      this.departures.textContent = '';
      return;
    }
    const now = this.trains.now();
    const t0 = now - this.span * 60 * NOW_AT;
    const t1 = t0 + this.span * 60;
    const go = line.routes.find((r) => r.direction === 0) ?? line.routes[0];
    // 駅の縦の位置：行きの向きの、始発の駅を出てからの時間に比例させる
    const total = go.stops[go.stops.length - 1].arrive || 1;
    const yOf = go.stops.map((s) => s.arrive / total);
    this.rows = go.stops.map((s, i) => ({ name: s.name, y: yOf[i] }));
    const plotX = (t: number) => LABEL_W + ((t - t0) / (t1 - t0)) * (w - LABEL_W - RIGHT);
    const plotY = (y: number) => TOP + y * (h - TOP - BOTTOM);

    // 駅の横線と駅名（多い時は間引く）
    g.font = `11px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
    g.textBaseline = 'middle';
    let lastLabel = -Infinity;
    go.stops.forEach((s, i) => {
      const y = plotY(yOf[i]);
      const selected = s.name === this.station;
      g.strokeStyle = selected ? 'rgba(255,210,120,0.55)' : 'rgba(255,255,255,0.08)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(LABEL_W, y);
      g.lineTo(w - RIGHT, y);
      g.stroke();
      if (y - lastLabel < 12 && !selected) return;
      lastLabel = y;
      g.fillStyle = selected ? '#ffd27a' : 'rgba(255,255,255,0.75)';
      g.textAlign = 'right';
      g.fillText(s.name, LABEL_W - 6, y);
    });

    // 時刻の目盛り
    const step = this.span <= 40 ? 5 : this.span <= 60 ? 10 : this.span <= 120 ? 20 : 30;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let m = Math.ceil(t0 / 60 / step) * step; m * 60 <= t1; m += step) {
      const x = plotX(m * 60);
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.beginPath();
      g.moveTo(x, TOP);
      g.lineTo(x, h - BOTTOM);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(clock(m * 60), x, 4);
    }

    // 列車の線（行きは実線、帰りは少し薄く）。帰りの駅は行きの駅の並びの逆
    g.save();
    g.beginPath();
    g.rect(LABEL_W, TOP - 2, w - LABEL_W - RIGHT, h - TOP - BOTTOM + 4);
    g.clip();
    const n = go.stops.length;
    for (const r of line.routes) {
      const ys = r.direction === 0 ? yOf : r.stops.map((_, k) => yOf[n - 1 - k] ?? 0);
      g.strokeStyle = line.color;
      g.globalAlpha = r.direction === 0 ? 0.95 : 0.6;
      g.lineWidth = 1.4;
      for (const d of r.departures) {
        if (d + r.journey < t0 || d > t1) continue;
        g.beginPath();
        r.stops.forEach((s, k) => {
          const xa = plotX(d + s.arrive);
          const y = plotY(ys[k]);
          if (k === 0) g.moveTo(xa, y);
          else g.lineTo(xa, y);
          if (s.depart > s.arrive) g.lineTo(plotX(d + s.depart), y);
        });
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    // 今の時刻の縦線と、走っている列車の位置
    const xn = plotX(now);
    g.strokeStyle = '#ff5a4a';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(xn, TOP - 2);
    g.lineTo(xn, h - BOTTOM + 2);
    g.stroke();
    const running = line.routes.map(() => 0);
    line.routes.forEach((r, ri) => {
      const ys = r.direction === 0 ? yOf : r.stops.map((_, k) => yOf[n - 1 - k] ?? 0);
      for (const d of r.departures) {
        const tau = now - d;
        if (tau < 0 || tau >= r.journey) continue;
        running[ri]++;
        const y = positionY(r, tau, ys);
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(xn, plotY(y), 3, 0, Math.PI * 2);
        g.fill();
      }
    });
    g.restore();

    this.showStatus(line, now, running);
    this.showDepartures(line, now);
  }

  /** 運行状況：走っている本数・今の運転間隔・始発と終電 */
  private showStatus(line: Line, now: number, running: number[]): void {
    const parts = line.routes.map((r, i) => {
      const deps = r.departures;
      const label = directionLabel(line, r);
      const next = deps.find((d) => d > now);
      const prev = [...deps].reverse().find((d) => d <= now);
      const interval = next !== undefined && prev !== undefined ? Math.round((next - prev) / 6) / 10 : null;
      return `<div><b>${escapeHtml(label)}</b>：運行中 ${running[i]} 本${
        interval !== null ? `・約 ${interval} 分おき` : ''
      }・始発 ${clock(deps[0])}・終電 ${clock(deps[deps.length - 1])}（${escapeHtml(r.stops[0].name)} 発）</div>`;
    });
    const service = line.routes.some((r) => r.departures.some((d) => d <= now && now - d < r.journey));
    this.status.innerHTML = (service ? '' : '<div class="diagram-closed">今は運転していません（始発の前・終電の後）</div>') + parts.join('');
  }

  /** 選んだ駅の次の発車（向きごとに 3 本） */
  private showDepartures(line: Line, now: number): void {
    if (!this.station) {
      this.departures.innerHTML = '<span class="diagram-hint">左の駅名を押すと、その駅の次の発車を出します</span>';
      return;
    }
    const name = this.station;
    const rows = line.routes.map((r) => {
      const k = r.stops.findIndex((s, i) => s.name === name && i < r.stops.length - 1);
      if (k < 0) return null;
      const times: number[] = [];
      for (const d of r.departures) {
        const t = d + r.stops[k].depart;
        if (t >= now) times.push(t);
        if (times.length >= 3) break;
      }
      const label = directionLabel(line, r, k);
      return `<div><b>${escapeHtml(label)}</b>　${times.length ? times.map((t) => `${clock(t)}（${Math.max(0, Math.ceil((t - now) / 60))} 分後）`).join('　') : '今日はもうありません'}</div>`;
    });
    this.departures.innerHTML = `<div class="diagram-station">${escapeHtml(name)} の次の発車</div>${rows.filter(Boolean).join('')}`;
  }
}

/** 図の余白（px） */
const LABEL_W = 104;
const RIGHT = 10;
const TOP = 22;
const BOTTOM = 10;

/** 始発の駅を出てから tau 秒後の、縦の位置（0..1） */
function positionY(r: Route, tau: number, ys: number[]): number {
  const st = r.stops;
  for (let k = 0; k < st.length - 1; k++) {
    if (tau <= st[k].depart) return ys[k];
    if (tau < st[k + 1].arrive) {
      const f = (tau - st[k].depart) / Math.max(1, st[k + 1].arrive - st[k].depart);
      return ys[k] + (ys[k + 1] - ys[k]) * f;
    }
  }
  return ys[st.length - 1];
}

/** 向きの名前：終点の駅（環状は、駅 k の次の駅の向き） */
function directionLabel(line: Line, r: Route, k = 0): string {
  const st = r.stops;
  if (line.loop) return `${r.loopName || '環状'}（${st[Math.min(k + 1, st.length - 1)].name} 方面）`;
  return `${st[st.length - 1].name} 行き`;
}

/** 運行日の秒 → 「8:05」（24 時より後は 0 時台に） */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
const escapeAttr = escapeHtml;
