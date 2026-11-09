import { PINS } from '../core/config';
import { REGION, REGIONS, switchRegion } from '../core/region';
import { allPins, onPinsChange, removePin, renamePin, type Pin } from '../data/pins';
import { distanceMeters } from '../world/places';

/**
 * 保存した地点（ピン）の一覧。路線図のボタンの左の「ピン」で開く、画面右の板。
 * - 「ここにピンを立てる」（P キーでも）：自機の真下に立て、名前を入れる欄を開く
 * - 名前を押すとその上空へ（別の地域のピンなら、その地域で読み込み直す）
 * - ✎ で名前を変え、× で消す
 */
export class PinPanel {
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly unsubscribe: () => void;
  private opened = false;
  /** 名前を変えている途中のピン */
  private editing: string | null = null;

  /**
   * @param onPlace 「ここにピンを立てる」が押された時（立てたピンを返す。立てられなければ null）
   * @param onJump 今の地域のピンが選ばれた時
   * @param here 今いる場所（近い順に並べる）
   * @param onOpen 板を開いた時（路線図を閉じる）
   */
  constructor(
    parent: HTMLElement,
    private readonly onPlace: () => Pin | null,
    private readonly onJump: (pin: Pin) => void,
    private readonly here: () => { lat: number; lon: number } | null,
    private readonly onOpen: () => void,
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'pin-toggle';
    this.button.textContent = 'ピン';
    this.button.title = '保存した地点（P キーで自機の真下にピンを立てる）';
    this.button.addEventListener('click', () => this.toggle());

    this.panel = document.createElement('div');
    this.panel.className = 'pin-panel';
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="pin-panel-head">
        <span class="pin-panel-title">保存した地点</span>
        <button type="button" class="pin-add">＋ ここにピン <kbd>P</kbd></button>
      </div>
      <ul class="pin-list"></ul>`;
    this.list = this.panel.querySelector('.pin-list')!;
    this.panel.querySelector('.pin-add')!.addEventListener('click', () => this.place());
    this.list.addEventListener('click', (e) => this.onClick(e));
    parent.append(this.button, this.panel);
    this.unsubscribe = onPinsChange(() => this.render());
  }

  dispose(): void {
    this.unsubscribe();
    this.button.remove();
    this.panel.remove();
  }

  close(): void {
    if (this.opened) this.toggle(false);
  }

  /** 自機の真下にピンを立て、板を開いて名前を入れてもらう */
  place(): void {
    const pin = this.onPlace();
    if (!pin) return;
    this.editing = pin.id;
    if (!this.opened) this.toggle(true);
    else this.render();
  }

  private toggle(open = !this.opened): void {
    this.opened = open;
    this.panel.hidden = !open;
    this.button.classList.toggle('active', open);
    if (open) {
      this.onOpen();
      this.render();
    } else {
      this.editing = null;
    }
  }

  /** 開いている間、今の地域のピンまでの距離を出し直す（数回/秒で十分。一覧は作り直さない） */
  updateDistances(): void {
    if (!this.opened) return;
    const here = this.here();
    if (!here) return;
    for (const li of this.list.querySelectorAll<HTMLLIElement>('li[data-local]')) {
      const pin = allPins().find((p) => p.id === li.dataset.id);
      const small = li.querySelector('small');
      if (pin && small) small.textContent = formatDistance(distanceMeters(here.lat, here.lon, pin.lat, pin.lon));
    }
  }

  private onClick(e: Event): void {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLLIElement>('li[data-id]');
    if (!item) return;
    const pin = allPins().find((p) => p.id === item.dataset.id);
    if (!pin) return;
    if (target.closest('[data-remove]')) {
      if (confirm(`「${pin.name}」を消しますか？`)) removePin(pin.id);
    } else if (target.closest('[data-edit]')) {
      this.editing = pin.id;
      this.render();
    } else if (target.closest('[data-jump]')) {
      if (pin.region === REGION.id) this.onJump(pin);
      else switchRegion(pin.region, true, { lat: pin.lat, lon: pin.lon });
    }
  }

  /** 一覧を作り直す（板を開いた時・ピンが変わった時）。今の地域は近い順、ほかの地域は地域ごとに新しい順 */
  private render(): void {
    if (!this.opened) return;
    const here = this.here();
    const pins = allPins();
    const local = pins
      .filter((p) => p.region === REGION.id)
      .map((p) => ({ p, d: here ? distanceMeters(here.lat, here.lon, p.lat, p.lon) : null }))
      .sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || b.p.created - a.p.created);
    const others = pins.filter((p) => p.region !== REGION.id).sort((a, b) => b.created - a.created);

    this.list.innerHTML = '';
    if (pins.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'pin-empty';
      empty.textContent = 'まだピンがありません。気に入った場所の上で P キーを押すと、そこにピンを立てて名前を付けられます。';
      this.list.appendChild(empty);
      return;
    }
    for (const { p, d } of local) this.list.appendChild(this.item(p, d === null ? '' : formatDistance(d)));
    if (others.length > 0) {
      const head = document.createElement('li');
      head.className = 'pin-section';
      head.textContent = 'ほかの地域';
      this.list.appendChild(head);
      for (const p of others) this.list.appendChild(this.item(p, REGIONS[p.region]?.name ?? ''));
    }
  }

  private item(pin: Pin, note: string): HTMLLIElement {
    const li = document.createElement('li');
    li.dataset.id = pin.id;
    if (pin.region === REGION.id) li.dataset.local = '';
    if (pin.id === this.editing) {
      li.className = 'editing';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = pin.name;
      input.maxLength = PINS.maxNameLength;
      input.placeholder = 'ピンの名前';
      input.spellcheck = false;
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        this.editing = null;
        if (save) renamePin(pin.id, input.value);
        else this.render();
        input.blur();
      };
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true));
      li.appendChild(input);
      // 板に足してから入力欄へ移る
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return li;
    }
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'pin-name';
    jump.dataset.jump = '';
    jump.title = pin.region === REGION.id ? 'ここへ飛ぶ' : `${REGIONS[pin.region]?.name ?? ''}で読み込み直して、ここへ飛ぶ`;
    jump.innerHTML = '<i></i><span></span><small></small>';
    jump.querySelector('span')!.textContent = pin.name;
    jump.querySelector('small')!.textContent = note;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'pin-icon';
    edit.dataset.edit = '';
    edit.title = '名前を変える';
    edit.textContent = '✎';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pin-icon';
    remove.dataset.remove = '';
    remove.title = '消す';
    remove.textContent = '×';
    li.append(jump, edit, remove);
    return li;
  }
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 10) * 10}m`;
}
