/**
 * 飛び始める場所（駅の上空）。ホームの駅検索で選んだ駅。
 * - 今の地域の駅：setStartAt で渡してから読込へ
 * - 別の地域の駅：その地域で読み込み直す URL に ?at=緯度,経度 を付ける（switchRegion）。読み込んだら URL から消す
 * 読込（LoadingScene）はその場所のまわりを読み、飛行（FlightScene）はそこへジャンプして始める
 */
export interface StartAt {
  lat: number;
  lon: number;
}

let start: StartAt | null = fromUrl();

function fromUrl(): StartAt | null {
  if (typeof location === 'undefined' || typeof document === 'undefined') return null;
  const params = new URLSearchParams(location.search);
  const at = params.get('at');
  if (at === null) return null;
  params.delete('at');
  const q = params.toString();
  history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
  const [lat, lon] = at.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export function setStartAt(at: StartAt | null): void {
  start = at;
}

/** 飛び始める場所（取り出さない。読込が使う） */
export function peekStartAt(): StartAt | null {
  return start;
}

/** 飛び始める場所を取り出す（一度だけ。飛行が使う） */
export function takeStartAt(): StartAt | null {
  const s = start;
  start = null;
  return s;
}
