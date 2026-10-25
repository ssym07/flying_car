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
  /** 建物（PLATEAU 2025, 23区）。区ごとの URL は src/data/wards.ts */
  buildings: {
    /** タイルの詳細度（小さいほど細かい・重い）。テクスチャ付き LOD2（千代田区） */
    errorTarget: 20,
    /**
     * テクスチャの無い区（LOD1）の詳細度。配信データは粗い階層からいきなり最も細かい階層に切り替わるので、
     * 20 だと半径約6.5kmの細かいタイルを全部読んでしまう。30 で約4.3km（≒霧の終わり）。
     * 粗い階層の建物は大きく簡略化されていて「くさび形」に崩れるので、霧より手前に出さないようにする
     */
    plainErrorTarget: 30,
  },
  /** 道路（PLATEAU 交通モデル LOD3, 千代田区のみ） */
  roads: {
    url: 'https://assets.cms.plateau.reearth.io/assets/c6/9e8877-46d9-45a4-aebf-aa8d6105d698/13101_chiyoda-ku_pref_2025_citygml_1_op_tran_3dtiles_lod3/tileset.json',
    errorTarget: 24,
    /** 配信データは白一色なので、アスファルトの色で塗る */
    color: 0x5a5d61,
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
  /** 地形の外側に敷く平面の一辺 (m)。23区がすっぽり入る大きさ */
  groundSize: 60000,
  /**
   * 描画距離 (m)。霧で見えなくなる距離より少し先まで。
   * これより先のタイルは読まないので、広げると遠くの区の読込に回線を取られて手前が遅くなる
   */
  viewDistance: 5000,
  fog: { near: 1200, far: 4500 },
  /**
   * 遠くのタイルセットほど詳細度を下げる。
   * タイルセットを囲む球までの距離が near を超えたら、errorTarget を距離に比例して最大 maxScale 倍まで上げる
   */
  distantLod: { near: 1500, maxScale: 6 },
};

/** 国土地理院の標高タイル・航空写真から作る地形。カメラの周りだけ読み、離れたら捨てる */
export const TERRAIN = {
  /** 標高タイル（5mメッシュ）。無い所は 10m メッシュで補う */
  demUrls: [
    'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png',
    'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png',
  ],
  /** 地形チャンク（＝標高タイル1枚、約1km四方）のズームレベル */
  demZoom: 15,
  /** 地表に貼る航空写真（全国最新写真） */
  photoUrl: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  /** 標高タイル1枚あたり 2^photoZoomOffset 枚四方の写真を貼る */
  photoZoomOffset: 1,
  /** カメラからこの距離 (m) 以内のチャンクを読む */
  loadRadius: 3500,
  /** ロード画面ではこの距離 (m) 以内が揃うまで待つ（残りは飛びながら読む） */
  initialRadius: 1500,
  /** この距離 (m) より離れたチャンクは捨てる（読込と破棄を繰り返さないよう少し大きく） */
  unloadRadius: 4800,
  /** 同時に作るチャンク数 */
  concurrentChunks: 4,
  /** 標高タイル1枚あたりのメッシュ分割数 */
  segments: 64,
  /** チャンクの継ぎ目の隙間を隠すため、縁から下に垂らす壁の深さ (m) */
  skirtDepth: 8,
  /** 標高（ジオイド基準）を楕円体高に直すためのジオイド高 (m)。東京駅付近の値（23区内の差は1m未満） */
  geoidHeight: 36.76,
};

export const LOCATION = {
  /** この距離 (m) 以内に駅があれば「○○駅付近」と出す */
  nearStation: 700,
  /** 住所の問い合わせ（国土地理院 逆ジオコーダ） */
  reverseGeocoderUrl: 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat={lat}&lon={lon}',
  /** この距離 (m) 動いたら住所を問い合わせ直す */
  geocodeEvery: 200,
  /** 住所を問い合わせる最短間隔 (秒) */
  geocodeMinIntervalSec: 2,
};
