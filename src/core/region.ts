/**
 * 遊ぶ地域（ワールド）。URL の ?region=osaka・?region=fukuoka・?region=nagoya で選ぶ（無ければ東京）。
 * 地域を変える時はページを読み込み直すので、ここは起動時に一度だけ決まる。
 *
 * 地域で作るデータ（道路・線路・地面の種類などのタイル、路線図・空路・駅の形）は、地域ごとに dataDir の下に置く
 * （東京は public の直下、大阪は public/osaka、福岡は public/fukuoka、名古屋は public/nagoya）。データを作るスクリプトは出力先を丸ごと作り直すことがあるので、
 * 地域で分けておかないと、片方を作り直した時にもう片方が消える。建物（public/plateau）は区ごとなので共通
 */
export interface Region {
  id: 'tokyo' | 'osaka' | 'fukuoka' | 'nagoya';
  name: string;
  /** 飛行開始地点。ここがローカル原点になる */
  origin: { latDeg: number; lonDeg: number; ellipsoidHeight: number };
  /** 開始地点まわりのジオイド高 (m)。標高 = 楕円体高 - ジオイド高 */
  geoidHeight: number;
  /** public の下の、この地域のデータの置き場所（タイルと route-map.json・sky-lanes.json・station-footprints.json） */
  dataDir: string;
  /** この地域の建物の区のコードの頭（都道府県コード） */
  prefectures: string[];
  /** 駅名の検索欄の例 */
  searchExample: string;
}

export const REGIONS: Record<Region['id'], Region> = {
  tokyo: {
    id: 'tokyo',
    name: '東京',
    // 東京駅 丸の内側
    origin: { latDeg: 35.6812, lonDeg: 139.7671, ellipsoidHeight: 40 },
    geoidHeight: 36.76,
    dataDir: '',
    prefectures: ['11', '12', '13', '14'],
    searchExample: '品川',
  },
  osaka: {
    id: 'osaka',
    name: '大阪',
    // 大阪駅（うめきた側）
    origin: { latDeg: 34.7025, lonDeg: 135.4959, ellipsoidHeight: 41 },
    geoidHeight: 37.59,
    dataDir: 'osaka/',
    prefectures: ['26', '27', '28'],
    searchExample: '梅田',
  },
  fukuoka: {
    id: 'fukuoka',
    name: '福岡',
    // 博多駅
    origin: { latDeg: 33.5897, lonDeg: 130.4207, ellipsoidHeight: 38 },
    geoidHeight: 32.61,
    dataDir: 'fukuoka/',
    prefectures: ['40', '41'],
    searchExample: '天神',
  },
  nagoya: {
    id: 'nagoya',
    // 名古屋市と春日井・北名古屋・豊山・東海・大府・知多・常滑（データの置き場所と ?region=nagoya はそのまま）
    name: '愛知',
    // 名古屋駅（桜通口）
    origin: { latDeg: 35.1709, lonDeg: 136.8815, ellipsoidHeight: 40 },
    geoidHeight: 38.07,
    dataDir: 'nagoya/',
    prefectures: ['23'],
    searchExample: '栄',
  },
};

function pick(): Region {
  // Web Worker の中では location が Worker のファイルを指すので、ページの ?region=… を Worker の名前で受け取る（world/water.ts）
  const inWorker = typeof document === 'undefined' && typeof self !== 'undefined' && 'name' in self;
  const search = inWorker ? (self as unknown as { name: string }).name : typeof location === 'undefined' ? null : location.search;
  const id = search === null ? null : new URLSearchParams(search).get('region');
  return id === 'osaka' || id === 'fukuoka' || id === 'nagoya' ? REGIONS[id] : REGIONS.tokyo;
}

export const REGION: Region = pick();

/** この地域のひとまとまりのファイルの URL */
export function regionUrl(file: string): string {
  return `${import.meta.env.BASE_URL}${REGION.dataDir}${file}`;
}

/**
 * 別の地域でページを読み込み直す（start なら、タイトルを飛ばして読込へ進む）。
 * at を渡すと、そこ（駅の上空）から飛び始める（core/startAt.ts）
 */
export function switchRegion(id: Region['id'], start: boolean, at?: { lat: number; lon: number }): void {
  const params = new URLSearchParams(location.search);
  if (id === 'tokyo') params.delete('region');
  else params.set('region', id);
  if (start) params.set('start', '1');
  else params.delete('start');
  if (at) params.set('at', `${at.lat.toFixed(6)},${at.lon.toFixed(6)}`);
  else params.delete('at');
  const q = params.toString();
  location.search = q ? `?${q}` : '';
}

/** 読み込み直した直後に、タイトルを飛ばして読込へ進むか（一度使ったら URL から消す） */
export function takeAutoStart(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has('start')) return false;
  params.delete('start');
  const q = params.toString();
  history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
  return true;
}
