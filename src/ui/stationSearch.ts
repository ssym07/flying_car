import { SEARCH } from '../core/config';
import { distanceMeters, type Station } from '../world/places';
import { REGION } from '../core/region';
import { STATIONS as stations } from '../data/regionData';

/** 検索の設定（ホームの全地域の駅検索で使う） */
export interface StationSearchOptions<S extends Station> {
  /** 探す駅（無ければ今の地域の駅）。まだ読めていなければ null */
  stations?: () => readonly S[] | null;
  /** 入力欄が初めて使われた時（駅の一覧を読み始める） */
  onFirstFocus?: () => void;
  placeholder?: string;
  className?: string;
  /** 候補の右に出す文字（無ければ今いる場所からの距離） */
  note?: (station: S) => string;
}

/** 大学の候補か（大学は名前に「駅」を付けず、「大学」の印を付ける） */
const isUniversity = (s: Station): boolean => (s as { kind?: string }).kind === 'university';

/**
 * 画面右上の駅検索。駅名（と大学名）を入力すると候補を下に出し、選ぶと onSelect を呼ぶ。
 * 候補はクリック、または ↑↓ と Enter で選べる。Esc で閉じる。
 */
export class StationSearch<S extends Station = Station> {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private results: S[] = [];
  private active = -1;
  private focused = false;

  /**
   * @param onSelect 駅が選ばれた時
   * @param here 今いる場所（候補を近い順に並べるのに使う）。分からなければ null
   */
  constructor(
    parent: HTMLElement,
    private readonly onSelect: (station: S) => void,
    private readonly here: () => { lat: number; lon: number } | null,
    private readonly options: StationSearchOptions<S> = {},
  ) {
    this.root = document.createElement('div');
    this.root.className = options.className ?? 'search';
    this.root.innerHTML = `
      <input type="search" placeholder="${options.placeholder ?? `駅名・大学名で検索（例：${REGION.searchExample}）`}" autocomplete="off" spellcheck="false" />
      <ul class="search-results" role="listbox"></ul>
    `;
    this.input = this.root.querySelector('input')!;
    this.list = this.root.querySelector('ul')!;
    parent.appendChild(this.root);

    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('focus', () => {
      if (!this.focused) options.onFirstFocus?.();
      this.focused = true;
      this.update();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // 候補のクリックより先に blur で閉じないよう、mousedown で選ぶ
    this.list.addEventListener('mousedown', (e) => {
      const item = (e.target as HTMLElement).closest('li');
      if (!item) return;
      e.preventDefault();
      this.choose(Number(item.dataset.index));
    });
    this.input.addEventListener('blur', () => this.close());
  }

  dispose(): void {
    this.root.remove();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.results.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + step + this.results.length) % this.results.length;
      this.render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.results.length > 0) this.choose(Math.max(0, this.active));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.input.blur();
    }
  }

  private choose(index: number): void {
    const station = this.results[index];
    if (!station) return;
    this.input.value = '';
    this.input.blur();
    this.onSelect(station);
  }

  private close(): void {
    this.results = [];
    this.active = -1;
    this.render();
  }

  /** 入力し直さずに候補を出し直す（駅の一覧を読み終えた時） */
  refresh(): void {
    if (document.activeElement === this.input) this.update();
  }

  private update(): void {
    const list = this.options.stations ? this.options.stations() : (stations as unknown as readonly S[]);
    this.results = list ? searchStations(this.input.value, this.here(), list) : [];
    this.active = this.results.length > 0 ? 0 : -1;
    this.render();
  }

  private render(): void {
    const here = this.here();
    this.list.innerHTML = '';
    this.results.forEach((s, i) => {
      const li = document.createElement('li');
      li.dataset.index = `${i}`;
      li.className = i === this.active ? 'active' : '';
      li.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.className = 'search-name';
      name.textContent = isUniversity(s) ? s.name : `${s.name}駅`;
      if (isUniversity(s)) {
        const badge = document.createElement('span');
        badge.className = 'search-badge';
        badge.textContent = '大学';
        name.prepend(badge);
      }
      li.appendChild(name);
      const note = this.options.note
        ? this.options.note(s)
        : here
          ? `${(distanceMeters(here.lat, here.lon, s.lat, s.lon) / 1000).toFixed(1)}km`
          : '';
      if (note) {
        const d = document.createElement('span');
        d.className = 'search-distance';
        d.textContent = note;
        li.appendChild(d);
      }
      this.list.appendChild(li);
    });
    this.list.hidden = this.results.length === 0;
  }
}

/** 入力の表記ゆれをそろえる（末尾の「駅」、空白、全角英数字、ヶ/ケ など） */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/駅$/, '')
    .replace(/[ヶヵ]/g, 'ケ')
    .toLowerCase();
}

/** 完全一致 → 前方一致 → 部分一致の順、同じ順位なら近い順に SEARCH.maxResults 件 */
export function searchStations<S extends Station = Station>(
  query: string,
  here: { lat: number; lon: number } | null,
  list: readonly S[] = stations as unknown as readonly S[],
): S[] {
  const q = normalize(query);
  if (q === '') return [];
  const scored: Array<{ s: S; rank: number; d: number }> = [];
  for (const s of list) {
    const name = normalize(s.name);
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
    if (rank < 0) continue;
    const d = here ? distanceMeters(here.lat, here.lon, s.lat, s.lon) : 0;
    scored.push({ s, rank, d });
  }
  scored.sort((a, b) => a.rank - b.rank || a.d - b.d);
  return scored.slice(0, SEARCH.maxResults).map((x) => x.s);
}
