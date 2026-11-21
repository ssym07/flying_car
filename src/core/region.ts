/**
 * 遊ぶ地域（ワールド）。URL の ?region=kinki・?region=kyushu・?region=chubu・?region=hokkaido で選ぶ（無ければ関東）。
 * 地域の名前（id）は 関東 kanto・近畿 kinki・九州 kyushu・中部 chubu・北海道 hokkaido。ホームに出す名前（name）は 東京・大阪・福岡・愛知・北海道。
 * 前の名前（?region=osaka・fukuoka・nagoya、保存したピンの tokyo・osaka・fukuoka・nagoya）も読める（OLD_IDS）
 * 地域を変える時はページを読み込み直すので、ここは起動時に一度だけ決まる。
 *
 * 地域で作るデータ（道路・線路・地面の種類などのタイル、路線図・空路・駅の形）は、地域ごとに dataDir の下に置く
 * （関東は public の直下、近畿は public/kinki、九州は public/kyushu、中部は public/chubu、北海道は public/hokkaido）。データを作るスクリプトは出力先を丸ごと作り直すことがあるので、
 * 地域で分けておかないと、片方を作り直した時にもう片方が消える。建物（public/plateau）は区ごとなので共通
 */
export interface Region {
  id: 'kanto' | 'kinki' | 'kyushu' | 'chubu' | 'hokkaido';
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
  kanto: {
    id: 'kanto',
    name: '東京',
    // 東京駅 丸の内側
    origin: { latDeg: 35.6812, lonDeg: 139.7671, ellipsoidHeight: 40 },
    geoidHeight: 36.76,
    dataDir: '',
    prefectures: ['11', '12', '13', '14'],
    searchExample: '品川',
  },
  kinki: {
    id: 'kinki',
    name: '大阪',
    // 大阪駅（うめきた側）
    origin: { latDeg: 34.7025, lonDeg: 135.4959, ellipsoidHeight: 41 },
    geoidHeight: 37.59,
    dataDir: 'kinki/',
    prefectures: ['26', '27', '28'],
    searchExample: '梅田',
  },
  kyushu: {
    id: 'kyushu',
    name: '福岡',
    // 博多駅
    origin: { latDeg: 33.5897, lonDeg: 130.4207, ellipsoidHeight: 38 },
    geoidHeight: 32.61,
    dataDir: 'kyushu/',
    prefectures: ['40', '41'],
    searchExample: '天神',
  },
  chubu: {
    id: 'chubu',
    // 名古屋市と春日井・北名古屋・豊山・東海・大府・知多・常滑、北西の一宮・稲沢・江南・岩倉・小牧・清須、岐阜県の岐阜・各務原・岐南・瑞穂・大垣・安八、南部の豊明・刈谷・東浦・阿久比・半田・高浜・碧南・武豊・美浜・南知多、西部の蟹江・弥富・あま・津島・愛西・大治・飛島、三重県の木曽岬・桑名・朝日・川越・四日市・鈴鹿・津
    name: '愛知',
    // 名古屋駅（桜通口）
    origin: { latDeg: 35.1709, lonDeg: 136.8815, ellipsoidHeight: 40 },
    geoidHeight: 38.07,
    dataDir: 'chubu/',
    prefectures: ['23', '21', '24'],
    searchExample: '栄',
  },
  hokkaido: {
    id: 'hokkaido',
    // 札幌市と石狩市・小樽市・北広島市・恵庭市・千歳市（新千歳空港）・苫小牧市の平野・市街地
    name: '北海道',
    // 札幌駅
    origin: { latDeg: 43.0687, lonDeg: 141.3508, ellipsoidHeight: 50 },
    geoidHeight: 32.2,
    dataDir: 'hokkaido/',
    prefectures: ['01'],
    searchExample: '大通',
  },
};

/** 前の地域の名前 → 今の名前 */
const OLD_IDS: Record<string, Region['id']> = { tokyo: 'kanto', osaka: 'kinki', fukuoka: 'kyushu', nagoya: 'chubu' };

/** 地域の名前を今の名前にそろえる（前の名前も受け付ける。知らない名前は null） */
export function regionId(id: string | null | undefined): Region['id'] | null {
  if (!id) return null;
  if (id in REGIONS) return id as Region['id'];
  return OLD_IDS[id] ?? null;
}

function pick(): Region {
  // Web Worker の中では location が Worker のファイルを指すので、ページの ?region=… を Worker の名前で受け取る（world/water.ts）
  const inWorker = typeof document === 'undefined' && typeof self !== 'undefined' && 'name' in self;
  const search = inWorker ? (self as unknown as { name: string }).name : typeof location === 'undefined' ? null : location.search;
  const id = search === null ? null : new URLSearchParams(search).get('region');
  return REGIONS[regionId(id) ?? 'kanto'];
}

export const REGION: Region = pick();

/**
 * データ（タイル・建物・路線図など、public の下のファイル）を置いた所。
 * ビルドの時に VITE_DATA_URL（例 https://data.example.com/）を渡すと、そこから読む（公開版：データは Cloudflare R2）。
 * 渡さなければ今までどおりページと同じ所（開発サーバー・手元のビルド）
 */
export const DATA_BASE: string = import.meta.env.VITE_DATA_URL || import.meta.env.BASE_URL;

/** データのファイルの URL（path は public からの相対パス。例 'roads/15/1/2.json'） */
export function dataUrl(path: string): string {
  return `${DATA_BASE}${path}`;
}

/** この地域のひとまとまりのファイルの URL */
export function regionUrl(file: string): string {
  return dataUrl(`${REGION.dataDir}${file}`);
}

/**
 * 別の地域でページを読み込み直す（start なら、タイトルを飛ばして読込へ進む。'entrance' なら市町村を選ぶ画面へ）。
 * at を渡すと、そこ（駅の上空）から飛び始める（core/startAt.ts）
 */
export function switchRegion(id: Region['id'], start: boolean | 'entrance', at?: { lat: number; lon: number }): void {
  const params = new URLSearchParams(location.search);
  if (id === 'kanto') params.delete('region');
  else params.set('region', id);
  params.delete('start');
  params.delete('entrance');
  if (start === 'entrance') params.set('entrance', '1');
  else if (start) params.set('start', '1');
  if (at) params.set('at', `${at.lat.toFixed(6)},${at.lon.toFixed(6)}`);
  else params.delete('at');
  const q = params.toString();
  location.search = q ? `?${q}` : '';
}

/** 読み込み直した直後に、タイトルを飛ばして読込へ進むか（一度使ったら URL から消す） */
export function takeAutoStart(): boolean {
  return takeParam('start');
}

/** 読み込み直した直後に、タイトルを飛ばしてエントランス（市町村を選ぶ画面）へ進むか（一度使ったら URL から消す） */
export function takeAutoEntrance(): boolean {
  return takeParam('entrance');
}

function takeParam(name: string): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has(name)) return false;
  params.delete(name);
  const q = params.toString();
  history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}`);
  return true;
}
