// 調整したい数値はすべてここに集める

export const LOOP = {
  /** 固定時間刻み（秒） */
  fixedDt: 1 / 60,
  /** 1フレームで回す update の最大回数（処理落ち時の暴走防止） */
  maxStepsPerFrame: 5,
};

export const KEYS = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  up: ['Space'],
  down: ['ShiftLeft', 'ShiftRight'],
  pause: ['Escape'],
  start: ['Enter', 'Space'],
};

export const PHYSICS = {
  /** 重力加速度 (m/s^2) */
  gravity: 9.8,
  /** ホバー推力の重力に対する比率（1で無入力時に高度を保つ） */
  hoverRatio: 1.0,
  /** 前進推力 (m/s^2) */
  thrust: 30,
  /** 後退推力 (m/s^2) */
  reverseThrust: 20,
  /** 上昇・下降推力 (m/s^2) */
  liftThrust: 18,
  /** 旋回速度 (rad/s) */
  turnRate: 1.0,
  /** 進行方向の空気抵抗係数 (1/s)。最高速 ≒ thrust / dragForward */
  dragForward: 0.45,
  /** 横滑りを抑える抵抗係数 (1/s) */
  dragLateral: 3.0,
  /** 上下方向の空気抵抗係数 (1/s) */
  dragVertical: 1.5,
};

export const VEHICLE = {
  /** 当たり判定用の半径 (m) */
  radius: 2.0,
  /** 車体中心から底面までの高さ (m) */
  halfHeight: 0.6,
  /** 開始時の地上からの高さ (m) */
  startAltitude: 30,
};

export const CAMERA = {
  fov: 60,
  near: 0.5,
  far: 20000,
  /** 車から見たカメラの位置（後方・上方） */
  offset: { back: 12, up: 4.5 },
  /** 注視点の車からの高さ */
  lookAtHeight: 1.5,
  /** 追従の速さ（大きいほどキビキビ） */
  followRate: 5,
  /** 注視点追従の速さ */
  lookRate: 12,
  /** 壁に当たった時に手前へ寄せる距離 (m) */
  wallPadding: 0.6,
};

export const WORLD = {
  /** PLATEAU 東京都千代田区 (2025) の 3D Tiles */
  layers: {
    /** 建築物 LOD2（テクスチャ付き） */
    buildings: {
      url: 'https://assets.cms.plateau.reearth.io/assets/28/07d0a1-b6be-46ef-bd87-4f0683b5ef6e/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod2/tileset.json',
      /** タイルの詳細度（小さいほど細かい・重い） */
      errorTarget: 20,
      /** マテリアルを上書きする色（null ならデータのまま） */
      color: null,
    },
    /** 交通（道路）LOD3 */
    roads: {
      url: 'https://assets.cms.plateau.reearth.io/assets/c6/9e8877-46d9-45a4-aebf-aa8d6105d698/13101_chiyoda-ku_pref_2025_citygml_1_op_tran_3dtiles_lod3/tileset.json',
      errorTarget: 24,
      /** 配信データは白一色なので、アスファルトの色で塗る */
      color: 0x5a5d61,
    },
  },
  /**
   * タイルのキャッシュ（全レイヤー共有、GPU メモリ換算）。
   * テクスチャ付き建物は1タイルで数MB使うので、既定値（約400MB）では足りず読込が止まる。
   * 満杯になると残りのタイルが読まれず、建物が粗いまま（高層ビルだけ）になる
   */
  cacheBytes: { min: 600 * 1024 ** 2, max: 1000 * 1024 ** 2 },
  /**
   * 建物テクスチャの最大辺 (px)。配信データには 2048px もあり、そのままだと GPU メモリが足りない。
   * 512 で高度60mから街を見渡しても約450MBに収まる（1024 だと 1GB を超える）
   */
  maxTextureSize: 512,
  /** 飛行開始地点（東京駅 丸の内側）。ここがローカル原点になる */
  origin: { latDeg: 35.6812, lonDeg: 139.7671, ellipsoidHeight: 40 },
  /** 初期読込を諦めて先に進むまでの秒数 */
  loadTimeoutSec: 30,
  /** 地形の外側に敷く平面の一辺 (m) */
  groundSize: 20000,
};

/** 国土地理院の標高タイル・航空写真から作る地形 */
export const TERRAIN = {
  /** 標高タイル（5mメッシュ）。無い所は 10m メッシュで補う */
  demUrls: [
    'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png',
    'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png',
  ],
  demZoom: 15,
  /** 地表に貼る航空写真（全国最新写真） */
  photoUrl: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  /** 標高タイル1枚あたり 2^photoZoomOffset 枚四方の写真を貼る */
  photoZoomOffset: 1,
  /** 原点のタイルから上下左右に何枚ぶん読むか */
  radiusTiles: 3,
  /** 標高タイル1枚あたりのメッシュ分割数 */
  segments: 64,
  /** 標高（ジオイド基準）を楕円体高に直すためのジオイド高 (m)。東京駅付近の値 */
  geoidHeight: 36.76,
  /** 同時に取りに行くリクエスト数 */
  concurrency: 8,
};
