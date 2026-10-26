import { SEARCH } from '../core/config';
import { distanceMeters, type Station } from '../world/places';
import stations from '../data/stations.json';

/**
 * 画面右上の駅検索。駅名を入力すると候補を下に出し、選ぶと onSelect を呼ぶ。
 * 候補はクリック、または ↑↓ と Enter で選べる。Esc で閉じる。
 */
export class StationSearch {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private results: Station[] = [];
  private active = -1;

  /**
   * @param onSelect 駅が選ばれた時
   * @param here 今いる場所（候補を近い順に並べるのに使う）。分からなければ null
   */
  constructor(
    parent: HTMLElement,
    private readonly onSelect: (station: Station) => void,
    private readonly here: () => { lat: number; lon: number } | null,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'search';
    this.root.innerHTML = `
      <input type="search" placeholder="駅名で検索（例：品川）" autocomplete="off" spellcheck="false" />
      <ul class="search-results" role="listbox"></ul>
    `;
    this.input = this.root.querySelector('input')!;
    this.list = this.root.querySelector('ul')!;
    parent.appendChild(this.root);

    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('focus', () => this.update());
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

  private update(): void {
    this.results = searchStations(this.input.value, this.here());
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
      name.textContent = `${s.name}駅`;
      li.appendChild(name);
      if (here) {
        const d = document.createElement('span');
        d.className = 'search-distance';
        d.textContent = `${(distanceMeters(here.lat, here.lon, s.lat, s.lon) / 1000).toFixed(1)}km`;
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
export function searchStations(
  query: string,
  here: { lat: number; lon: number } | null,
  list: readonly Station[] = stations,
): Station[] {
  const q = normalize(query);
  if (q === '') return [];
  const scored: Array<{ s: Station; rank: number; d: number }> = [];
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
