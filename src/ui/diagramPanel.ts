import type { DiagramLine as Line, Route, Trains } from '../world/Trains';

/** 図の上の駅（画面の位置と緯度経度） */
interface StationRow {
  name: string;
  x: number;
  y: number;
  lat: number;
  lon: number;
}

/** 一覧の見出しの順 */
const GROUPS = ['JR', '地下鉄', '私鉄', 'モノレール・新交通・路面電車'];

const STORAGE_KEY = 'sky-drive.diagram-line';
/** 描き直す間隔（秒） */
const REDRAW = 0.25;

/**
 * ダイヤ：路線図の隣の「ダイヤ」ボタンで開く板。選んだ路線の運行図（環状の路線は円、ほかは縦の線に駅を並べ、
 * 走っている列車を向きごとに外側・内側（右・左）の三角で動かす）と、運行状況（走っている本数・運転間隔・始発と終電）、
 * 選んだ駅の次の発車を出す。
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
  private station: string | null = null;
  private opened = false;
  private wait = 0;
  /** 駅の画面の位置（押した駅を探すため） */
  private rows: StationRow[] = [];

  constructor(
    parent: HTMLElement,
    private readonly trains: Trains,
    /** 開いた時（同じ場所に出る路線図・ピンの一覧を閉じる） */
    private readonly onOpen: () => void = () => {},
    /** 駅を押した時（その駅の上空へ飛ぶ） */
    private readonly onStation: (station: { name: string; lat: number; lon: number }) => void = () => {},
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
    // 駅（丸・名前のあたり）を押すと、その駅の次の発車を出す
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      let best: { row: StationRow; d: number } | null = null;
      for (const row of this.rows) {
        const d = Math.hypot(row.x - x, row.y - y);
        if (!best || d < best.d) best = { row, d };
      }
      if (best && best.d < 60) {
        this.station = best.row.name;
        this.draw();
        this.onStation({ name: best.row.name, lat: best.row.lat, lon: best.row.lon });
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
    // 一覧は見出し（JR・地下鉄・私鉄・モノレールなど）ごとにまとめる
    this.select.innerHTML = GROUPS.map((group) => {
      const items = this.lines.filter((l) => l.group === group);
      if (items.length === 0) return '';
      return `<optgroup label="${escapeAttr(group)}">${items
        .map((l) => `<option value="${escapeAttr(l.key)}">${escapeHtml(l.name)}</option>`)
        .join('')}</optgroup>`;
    }).join('');
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
    // 本（範囲の都合で分かれた区間）ごとに、縦の線の上の範囲を割り当てる（間を少し空ける）。駅の位置は始発の駅からの時間に比例
    const P = line.pieces;
    const GAP = P.length > 1 ? 0.06 : 0;
    const totals = P.map((p) => p.go.stops[p.go.stops.length - 1].arrive || 1);
    const sum = totals.reduce((a, b) => a + b, 0);
    let acc = 0;
    const ranges = P.map((_, i) => {
      const a = acc;
      const b = a + ((1 - GAP * (P.length - 1)) * totals[i]) / sum;
      acc = b + GAP;
      return [a, b] as [number, number];
    });
    const pieceFrac = P.map((p, i) => p.go.stops.map((st) => ranges[i][0] + (st.arrive / totals[i]) * (ranges[i][1] - ranges[i][0])));
    const names = P.flatMap((p) => p.go.stops.map((st) => st.name));
    const where = P.flatMap((p) => p.go.stops.map((_, k) => p.go.stopLatLon(k)));
    const frac = pieceFrac.flat();
    const n = frac.length;
    const go = P[0].go;
    const layout = line.loop ? loopLayout(go, frac, w, h) : straightLayout(frac, w, h, ranges);
    this.rows = names.map((name, i) => ({ name, x: layout.station(i).x, y: layout.station(i).y, lat: where[i][0], lon: where[i][1] }));

    // 路線（円か縦の線）
    g.strokeStyle = line.color;
    g.lineWidth = 6;
    g.lineCap = 'round';
    g.beginPath();
    layout.path(g);
    g.stroke();

    // 駅：白い丸と名前（近すぎる名前は間引く。選んだ駅は必ず出す）
    g.font = `11px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
    const placed: Array<[number, number, number, number]> = [];
    const order = names.map((_, i) => i).sort((a, b) => Number(names[b] === this.station) - Number(names[a] === this.station));
    for (const i of order) {
      // 環状の終点（始発の駅と同じ）は描かない
      if (line.loop && i === n - 1) continue;
      const p = layout.station(i);
      const selected = names[i] === this.station;
      g.fillStyle = selected ? '#ffd27a' : '#f4f1ea';
      g.beginPath();
      g.arc(p.x, p.y, selected ? 4.5 : 3, 0, Math.PI * 2);
      g.fill();
      const label = layout.label(i);
      const tw = g.measureText(names[i]).width;
      const x0 = label.align === 'right' ? label.x - tw : label.align === 'center' ? label.x - tw / 2 : label.x;
      const box: [number, number, number, number] = [x0 - 1, label.y - 7, x0 + tw + 1, label.y + 7];
      if (!selected && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      g.textAlign = label.align;
      g.textBaseline = 'middle';
      g.fillStyle = selected ? '#ffd27a' : 'rgba(255,255,255,0.8)';
      g.fillText(names[i], label.x, label.y);
    }

    // 列車：行きは外側（縦の線なら右）、帰りは内側（左）。走っている列車はオレンジの三角（進む向き）、駅に止まっている列車は水色の丸
    const running = [0, 0];
    P.forEach((piece, pi) => {
      for (const r of [piece.go, piece.back]) {
        if (!r) continue;
        const pf = pieceFrac[pi];
        const ys = r.direction === 0 ? pf : r.stops.map((_, k) => pf[pf.length - 1 - k] ?? 0);
        const side = r.direction === 0 ? 1 : -1;
        for (const d of r.departures) {
          const tau = now - d;
          if (tau < 0 || tau >= r.journey) continue;
          running[r.direction]++;
          const { f, stopped } = positionY(r, tau, ys);
          const p = layout.at(f, side * 11);
          g.strokeStyle = 'rgba(0,0,0,0.7)';
          g.lineWidth = 1.2;
          if (stopped) {
            g.fillStyle = STOPPED;
            g.beginPath();
            g.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
            g.fill();
            g.stroke();
            continue;
          }
          // 進む向き：少し先の位置との差
          const q = layout.at(f + (r.direction === 0 ? 0.004 : -0.004), side * 11);
          const a = Math.atan2(q.y - p.y, q.x - p.x);
          g.save();
          g.translate(p.x, p.y);
          g.rotate(a);
          g.fillStyle = MOVING;
          g.beginPath();
          g.moveTo(7, 0);
          g.lineTo(-4.5, -5);
          g.lineTo(-4.5, 5);
          g.closePath();
          g.fill();
          g.stroke();
          g.restore();
        }
      }
    });

    // 急行：各停の区間の駅の位置に合わせ、白い縁で描く
    for (const r of line.extras) {
      const pi = P.findIndex((p) => {
        const names = p.go.stops.map((st) => st.name);
        return names.includes(r.stops[0].name) && names.includes(r.stops[r.stops.length - 1].name);
      });
      if (pi < 0) continue;
      const goNames = P[pi].go.stops.map((st) => st.name);
      const ys = r.stops.map((st) => pieceFrac[pi][goNames.indexOf(st.name)] ?? 0);
      const side = r.direction === 0 ? 1 : -1;
      for (const d of r.departures) {
        const tau = now - d;
        if (tau < 0 || tau >= r.journey) continue;
        running[r.direction]++;
        const { f, stopped } = positionY(r, tau, ys);
        const p = layout.at(f, side * 11);
        g.strokeStyle = '#ffffff';
        g.lineWidth = 1.6;
        if (stopped) {
          g.fillStyle = STOPPED;
          g.beginPath();
          g.arc(p.x, p.y, 5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          continue;
        }
        const q = layout.at(f + (r.direction === 0 ? 0.004 : -0.004), side * 11);
        g.save();
        g.translate(p.x, p.y);
        g.rotate(Math.atan2(q.y - p.y, q.x - p.x));
        g.fillStyle = MOVING;
        g.beginPath();
        g.moveTo(8, 0);
        g.lineTo(-5, -5.5);
        g.lineTo(-5, 5.5);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();
      }
    }

    // 凡例：色（走っている・止まっている）と、向き（外側・内側、右・左）
    g.font = `11px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = MOVING;
    g.beginPath();
    g.moveTo(17, 14);
    g.lineTo(8, 9);
    g.lineTo(8, 19);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText('走っている', 22, 8);
    g.fillStyle = STOPPED;
    g.beginPath();
    g.arc(92, 14, 4.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText('駅に止まっている', 100, 8);
    if (line.extras.length > 0) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.6;
      g.strokeRect(196, 9, 10, 10);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText('白い縁：急行', 212, 8);
    }
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(`${line.loop ? '外側' : '右'}：${directionName(line, 0)}`, 8, 26);
    if (P.some((p) => p.back)) g.fillText(`${line.loop ? '内側' : '左'}：${directionName(line, 1)}`, 8, 41);

    this.showStatus(line, now, running);
    this.showDepartures(line, now);
  }

  /** 運行状況：向きごとの、走っている本数・今の運転間隔・始発と終電 */
  private showStatus(line: Line, now: number, running: number[]): void {
    const parts = [0, 1].map((dir) => {
      const rs = line.pieces.map((p) => (dir === 0 ? p.go : p.back)).filter((r): r is Route => r !== null);
      if (rs.length === 0) return '';
      const deps = rs[0].departures;
      const next = deps.find((d) => d > now);
      const prev = [...deps].reverse().find((d) => d <= now);
      const interval = next !== undefined && prev !== undefined ? Math.round((next - prev) / 6) / 10 : null;
      const first = Math.min(...rs.map((r) => r.departures[0]));
      const last = Math.max(...rs.map((r) => r.departures[r.departures.length - 1]));
      return `<div><b>${escapeHtml(directionName(line, dir))}</b>：運行中 ${running[dir]} 本${
        interval !== null ? `・約 ${interval} 分おき` : ''
      }・始発 ${clock(first)}・終電 ${clock(last)}</div>`;
    });
    const service = line.routes.some((r) => r.departures.some((d) => d <= now && now - d < r.journey));
    this.status.innerHTML = (service ? '' : '<div class="diagram-closed">今は運転していません（始発の前・終電の後）</div>') + parts.join('');
  }

  /** 選んだ駅の次の発車（向きごとに 3 本） */
  private showDepartures(line: Line, now: number): void {
    if (!this.station) {
      this.departures.innerHTML = '<span class="diagram-hint">駅を押すと、その駅の上空へ飛び、次の発車を出します</span>';
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
      const label = `${r.express ? '急行 ' : ''}${directionLabel(line, r, k)}`;
      return `<div><b>${escapeHtml(label)}</b>　${times.length ? times.map((t) => `${clock(t)}（${Math.max(0, Math.ceil((t - now) / 60))} 分後）`).join('　') : '今日はもうありません'}</div>`;
    });
    this.departures.innerHTML = `<div class="diagram-station">${escapeHtml(name)} の次の発車</div>${rows.filter(Boolean).join('')}`;
  }
}

/** 図の形：駅 i の位置・名前の位置、道に沿った位置 f（0..1）から横へ offset px ずらした点、路線を描く */
interface Layout {
  station(i: number): { x: number; y: number };
  label(i: number): { x: number; y: number; align: CanvasTextAlign };
  at(f: number, offset: number): { x: number; y: number };
  path(g: CanvasRenderingContext2D): void;
}

/**
 * 環状の路線：円。駅の角度は始発の駅からの時間に比例させ、回る向き（外回りは時計回り）と、始発の駅の角度は地図にそろえる。
 * offset が正なら円の外側
 */
function loopLayout(go: Route, frac: number[], w: number, h: number): Layout {
  const cx = w / 2;
  const cy = h / 2 + 14;
  // 駅名が板からはみ出さないよう、横は名前の幅（約 70px）を空ける
  const R = Math.max(40, Math.min(w / 2 - 78, h / 2 - 60));
  // 地図の中心から見た始発の駅の向き（画面は上が北）
  const pts = frac.map((_, i) => go.stopLatLon(i));
  const clat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const clon = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const start = Math.atan2(-(pts[0][0] - clat), (pts[0][1] - clon) * Math.cos((clat * Math.PI) / 180));
  // 外回り（時計回り）の路線は、画面でも時計回り（角度が増える向き）
  const dir = go.loopName === '内回り' ? -1 : 1;
  const angle = (f: number) => start + dir * f * Math.PI * 2;
  const point = (f: number, r: number) => ({ x: cx + Math.cos(angle(f)) * r, y: cy + Math.sin(angle(f)) * r });
  return {
    station: (i) => point(frac[i], R),
    label: (i) => {
      const a = angle(frac[i]);
      const p = point(frac[i], R + 24);
      const c = Math.cos(a);
      return { x: p.x, y: p.y, align: c > 0.3 ? 'left' : c < -0.3 ? 'right' : 'center' };
    },
    at: (f, offset) => point(f, R + offset),
    path: (g) => g.arc(cx, cy, R, 0, Math.PI * 2),
  };
}

/** ふつうの路線：縦の線（上が行きの始発の駅）。offset が正なら線の右 */
function straightLayout(frac: number[], w: number, h: number, ranges: Array<[number, number]>): Layout {
  const x = Math.round(w * 0.38);
  const top = 60;
  const bottom = h - 16;
  const y = (f: number) => top + Math.min(1, Math.max(0, f)) * (bottom - top);
  return {
    station: (i) => ({ x, y: y(frac[i]) }),
    label: (i) => ({ x: x + 22, y: y(frac[i]), align: 'left' }),
    at: (f, offset) => ({ x: x + offset, y: y(f) }),
    // 分かれた区間ごとに線を引く（間は空ける）
    path: (g) => {
      for (const [a, b] of ranges) {
        g.moveTo(x, y(a));
        g.lineTo(x, y(b));
      }
    },
  };
}

/** 走っている列車の色（三角）と、駅に止まっている列車の色（丸） */
const MOVING = '#ffa23a';
const STOPPED = '#4fd1ff';

/** 始発の駅を出てから tau 秒後の、行きの向きの駅の並びでの位置（0..1）と、駅に止まっているか */
function positionY(r: Route, tau: number, ys: number[]): { f: number; stopped: boolean } {
  const st = r.stops;
  for (let k = 0; k < st.length - 1; k++) {
    if (tau <= st[k].depart) return { f: ys[k], stopped: true };
    if (tau < st[k + 1].arrive) {
      const f = (tau - st[k].depart) / Math.max(1, st[k + 1].arrive - st[k].depart);
      return { f: ys[k] + (ys[k + 1] - ys[k]) * f, stopped: false };
    }
  }
  return { f: ys[st.length - 1], stopped: true };
}

/** 向き（0 = 行き、1 = 帰り）の名前。分かれた区間がある路線は「上から下へ」「下から上へ」 */
function directionName(line: Line, dir: number): string {
  const p = line.pieces[0];
  const r = dir === 0 ? p.go : p.back;
  if (!r) return '';
  if (line.pieces.length > 1) return dir === 0 ? '上から下へ' : '下から上へ';
  return directionLabel(line, r);
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
