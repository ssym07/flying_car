// 調整したい数値はすべてここに集める
import { REGION } from './region';

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
  /** 自機の真下にピンを立てる */
  pin: ['KeyP'],
  start: ['Enter', 'Space'],
};

export const PHYSICS = {
  /** 重力加速度 (m/s^2) */
  gravity: 9.8,
  /** ホバー推力の重力に対する比率（1で無入力時に高度を保つ） */
  hoverRatio: 1.0,
  /** 前進推力 (m/s^2)。最高速 = thrust / dragForward ≒ 83 m/s（300 km/h） */
  thrust: 37.5,
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
  /** 飛び始めの向き（rad。0 で南、π で北を向く。+x=西, +z=北, 前は (-sin, -cos)） */
  startYaw: Math.PI,
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
  /** マウスでの視点操作 */
  mouse: {
    /** ドラッグ 1px あたりの回転 (rad) */
    sensitivity: 0.005,
    /** 見上げ・見下ろしの範囲（水平からの角度） */
    minPitchDeg: -5,
    maxPitchDeg: 85,
    /** ホイールでの距離の倍率の範囲 */
    minZoom: 0.5,
    maxZoom: 4,
    /** ホイール 1 目盛り（deltaY 100）あたりの距離の変化率 */
    zoomStep: 0.12,
    /** ドラッグをやめてから自機の後ろへ戻り始めるまでの秒数 */
    returnDelay: 1.5,
    /** 後ろへ戻る速さ */
    returnRate: 2.5,
    /** マウスで回している間の追従の速さ（遅いとカメラが自機を突き抜ける） */
    followRate: 18,
  },
};

export const WORLD = {
  /** 建物（PLATEAU 2025, 23区）。区ごとの URL は src/data/wards.ts */
  buildings: {
    /** タイルの詳細度（小さいほど細かい・重い）。テクスチャ付き LOD2（千代田区） */
    errorTarget: 20,
    /**
     * テクスチャの無い区（LOD1）の詳細度。配信データは粗い階層からいきなり最も細かい階層に切り替わるので、
     * 20 だと半径約6.5km、30 で約4.3km、50 で約2.6km の細かいタイルを全部読む。
     * 粗い階層の建物は大きく簡略化されていて「くさび形」に崩れるので、霧の終わり（ATMOSPHERE の fog.far）と
     * 同じくらいにして、くさび形を霧に隠す。広げるほど読み込む量が増える（半径の2乗に比例）
     */
    plainErrorTarget: 50,
    /** 外壁テンプレートの明るさの倍率（色味は保ったまま全体を明るく・暗くする） */
    facadeBrightness: 1.8,
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
  /** 飛行開始地点（地域ごと：東京は東京駅 丸の内側、大阪は大阪駅）。ここがローカル原点になる */
  origin: REGION.origin,
  /** 建物タイルの同時ダウンロード数・同時解析数（3d-tiles-renderer の既定は 25・5） */
  downloadConcurrency: 6,
  parseConcurrency: 2,
  /** 初期読込を諦めて先に進むまでの秒数 */
  loadTimeoutSec: 30,
  /** 地形の外側に敷く平面の一辺 (m)。23区がすっぽり入る大きさ */
  groundSize: 60000,
  /**
   * 描画距離 (m)。霧で見えなくなる距離より少し先まで。
   * これより先のタイルは読まないので、広げると遠くの区の読込に回線を取られて手前が遅くなる
   */
  viewDistance: 3200,
  /**
   * 遠くのタイルセットほど詳細度を下げる。
   * タイルセットを囲む球までの距離が near を超えたら、errorTarget を距離に比例して最大 maxScale 倍まで上げる
   */
  distantLod: { near: 1500, maxScale: 6 },
};

/** 画面全体にかける後処理（src/world/PostFX.ts） */
export const GRAPHICS = {
  /** 後処理を使う時の画面外の絵のマルチサンプル数（後処理を使うとキャンバスのアンチエイリアスが効かないので、こちらで） */
  msaa: 4,
  /**
   * SSAO：建物の足元・壁の隅・狭い通りに落ちる柔らかい影。URL の ?ao=1 で入れる・?ao=0 で切る・?ao=debug で AO だけを映す。
   * 今は切っている：空から見る距離では違いが小さく、遠くの平らな地面で深度の精度が足りずに縞が出て、飛ぶと地面が波打って見える
   * radius は近くの半径 (m)、radiusFar は遠く（fadeFar の近く）の半径。fadeNear〜fadeFar (m) で薄くして消す
   */
  ao: {
    enabled: false,
    /** AO を求める解像度（画面に対する割合） */
    resolution: 0.5,
    samples: 12,
    radius: 10,
    radiusFar: 45,
    /** 平らな面が自分を遮らないよう、半径に対するこの割合だけ手前のものだけを遮りとする */
    bias: 0.03,
    /** 濃さの指数（大きいほど隅が濃くなる） */
    power: 2.5,
    /** 色に掛ける強さ（0 で無し、1 で AO のまま） */
    intensity: 0.85,
    fadeNear: 600,
    fadeFar: 2400,
  },
  /**
   * 太陽の影（src/world/Shadows.ts）。URL の ?shadows=0 で切れる（見比べ用）。
   * 空の太陽は低い（夕焼け）ので、影は同じ方角から elevationDeg の高さで照らす光（強さ intensity）で落とす。
   * 影の中と外の差が出るよう、空からの環境光を ambientScale 倍に下げる
   */
  shadows: {
    enabled: true,
    elevationDeg: 32,
    intensity: 2.6,
    ambientScale: 0.6,
    /** 影の地図の画素数（縦横） */
    mapSize: 2048,
    /** 影を落とす範囲の半分の幅 (m)。高く飛ぶほど growWithAltitude × 高さだけ広げ、maxHalfSize まで */
    halfSize: 700,
    growWithAltitude: 1.2,
    maxHalfSize: 1400,
    /** 範囲の中心を、カメラの前へ halfSize のこの割合だけずらす */
    ahead: 0.55,
    /** 光を置く距離 (m)。範囲の外から影を落とす高いビルも入るように */
    distance: 1500,
    bias: -0.0004,
    normalBias: 0.6,
    /** 影の縁のぼかし（PCF の半径） */
    blur: 1.5,
    /** 影を落とす・受けるの印を、新しく足された物に付ける間隔（フレーム） */
    tagEvery: 20,
    /** 影の地図を描き直す間隔（フレーム）。2 なら1コマおき（影の描画の重さが半分） */
    updateEvery: 2,
  },
};

/** 国土地理院の標高タイル・航空写真から作る地形。カメラの周りだけ読み、離れたら捨てる */
export const TERRAIN = {
  /** 標高タイル（5mメッシュ）。山などで無い所（タイルごと無い・穴がある）は 10m メッシュで補う */
  demUrl: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png',
  /** 10m メッシュはズーム 14 までしか無いので、1つ粗いタイルの 1/4 を引き伸ばして使う */
  demFallbackUrl: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png',
  /** 地形チャンク（＝標高タイル1枚、約1km四方）のズームレベル */
  demZoom: 15,
  /** 地表に貼る航空写真（全国最新写真） */
  photoUrl: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
  /** 標高タイル1枚あたり 2^photoZoomOffset 枚四方の写真を貼る */
  photoZoomOffset: 1,
  /** カメラからこの距離 (m) 以内のチャンクを読む */
  loadRadius: 2800,
  /** 道路・線路に合わせて地形を削る・盛る処理に、1フレームで使う時間 (ms)。残りは次のフレームへ */
  carveBudgetMs: 3,
  /** ロード画面ではこの距離 (m) 以内が揃うまで待つ（残りは飛びながら読む） */
  initialRadius: 1500,
  /** この距離 (m) より離れたチャンクは捨てる（読込と破棄を繰り返さないよう少し大きく） */
  unloadRadius: 3600,
  /** 読込に失敗したチャンクを読み直すまでの秒数 */
  retryDelay: 10,
  /** 同時に作るチャンク数 */
  concurrentChunks: 4,
  /** 標高タイル1枚あたりのメッシュ分割数（約8m 間隔。建物の敷地の段を出せる細かさ） */
  segments: 128,
  /**
   * 建物の敷地の地図（scripts/build-building-pads.mjs）。坂では建物の底が敷地の一番低い地面の高さなので、
   * 敷地とその周り（頂点の間隔ぶん）の地面を底 + clearance m より上に出さない。敷地の中で地面が底より低ければ、底まで上げる。
   * 底が地面より maxDig m 以上低い所（地下のある建物など）は下げず、maxFill m 以上高い所（高架の上の建物など）は上げない。
   * 地面の種類の無い所は、建物から nearRange m までを住宅地の敷地として塗り分ける（LANDUSE.natural）。
   * 地面の高さを走る線路の中心線から railRange m までは、線路わきの砂利として塗る（LANDUSE.railSide）
   */
  pads: { path: `${REGION.dataDir}pads/15/{x}/{y}.png`, clearance: 0.15, maxDig: 12, maxFill: 4, nearRange: 48, railRange: 16 },
  /** チャンクの継ぎ目の隙間を隠すため、縁から下に垂らす壁の深さ (m) */
  skirtDepth: 8,
  /** 標高（ジオイド基準）を楕円体高に直すためのジオイド高 (m)。開始地点付近の値（地域の中の差は1m前後） */
  geoidHeight: REGION.geoidHeight,
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
  /** 返事をこの秒数まで待つ（逆ジオコーダは混むと十数秒かかる） */
  geocodeTimeoutSec: 20,
};

export const MINIMAP = {
  /** 画面上の大きさ (px)。これが最小で、右下の角をドラッグで路線図の大きさ（maxWidth × maxHeight）まで広げられる */
  size: 250,
  maxWidth: 360,
  maxHeight: 640,
  /** 画面の上からの位置 (px)（overlay.css の .minimap の top と同じ） */
  top: 92,
  /** 画面の下に空けておく高さ (px)（左下の速度・高度の表示にかからないように） */
  bottomMargin: 130,
  /**
   * 表示の拡大率（MapLibre のズーム。512px のタイルが基準なので、地図タイルのズームより 1 小さい）。
   * 14 で 250px が約1km
   */
  zoom: 14,
  /**
   * 一番引いた時のミニマップの横幅：地域の広さ（駅のある範囲の長い方の辺）のこの倍（福岡 約60km で 約40km）。
   * 引ける限度のズームは、この横幅とミニマップの幅 (px) から決める
   */
  maxViewPerRegion: 0.67,
  /** 一番引いた時の横幅の下限 (m)（狭い地域でも、これだけは引ける） */
  minMaxView: 30000,
  /** これより引かない（ズーム 8 より下の国土地理院のタイルには水域が無い。幅 250px で 約63km） */
  lowestZoom: 8,
  /** 一番寄った時（16.5 で 250px が約180m） */
  maxZoom: 16.5,
  /** ボタン1回で変わる量 */
  zoomStep: 0.5,
  /** ホイール1目盛り（deltaY 100）で変わる量 */
  wheelZoom: 0.6,
  /** ドラッグで探索できる範囲：地域の駅のある範囲から、さらにこれだけ外まで（度。0.03 で約3km） */
  panMargin: 0.03,
};

/** 空・太陽・雲・光。style で空の描き方を切り替える */
export const ATMOSPHERE = {
  /** 'anime'：アニメ調の夕焼け空 / 'physical'：物理ベースの昼の空 */
  style: 'anime' as 'anime' | 'physical',

  /** アニメ調の夕焼け（紫〜ピンクの空、夕日に縁が光る雲） */
  anime: {
    /** 太陽の高さ（地平線からの角度）と方位（北から時計回り）。255 で西南西 */
    sunElevationDeg: 4,
    sunAzimuthDeg: 255,
    colors: {
      /** 天頂 */
      zenith: 0x5c58b0,
      /** 空の中ほど */
      upper: 0xa28ad6,
      /** 地平線 */
      horizon: 0xf2aac0,
      /** 夕日のまわりの暖色 */
      glow: 0xffc59c,
      /** 雲の影・中間・日の当たる面・縁の光 */
      cloudShadow: 0x8676bf,
      cloudMid: 0xcfa2c9,
      cloudLit: 0xffbfa6,
      cloudRim: 0xfff0d8,
    },
    clouds: {
      /** 雲の出る量（小さいほど多い。0..1） */
      coverage: 0.5,
      /** 雲の縁のくっきりさ（小さいほどくっきり） */
      sharpness: 0.1,
      /** 雲の模様の大きさ（小さいほど大きな雲） */
      scale: 0.85,
      /** 雲が流れる速さ */
      speed: 0.003,
    },
    /** 画面全体の明るさ（トーンマッピングの露出） */
    exposure: 1.3,
    /** 夕日の光の色と強さ（建物の日の当たる面） */
    sunColor: 0xffa77a,
    sunIntensity: 3.5,
    /** 空からの光（建物の影の面は紫がかる）と地面からの照り返し */
    skyLight: 0xc4b6ee,
    groundLight: 0x7c6c90,
    ambientIntensity: 3.2,
    environmentIntensity: 0.5,
    /** 霧の色。空の地平線の色（colors.horizon）と同じにして、遠くの街を空に溶け込ませる */
    fogColor: 0xf2aac0,
    /** 霧のかかり始めと、完全に霞む距離 (m) */
    fog: { near: 500, far: 2600 },
  },

  /** 物理ベースの昼の空（three.js の Sky） */
  physical: {
    sunElevationDeg: 38,
    /** 200 で南南西 */
    sunAzimuthDeg: 200,
    /** 大気の濁り（大きいほど白っぽく霞む） */
    turbidity: 6,
    /** 空の青さ */
    rayleigh: 1.6,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.82,
    exposure: 0.45,
    sunColor: 0xfff4e5,
    sunIntensity: 2.6,
    skyLight: 0xe6eef8,
    groundLight: 0x4d4a44,
    ambientIntensity: 1.0,
    environmentIntensity: 0.3,
    fogColor: 0xb4c9de,
    fog: { near: 800, far: 2600 },
    clouds: {
      /** 空のどれくらいを雲が覆うか (0..1) */
      coverage: 0.45,
      /** 雲の濃さ */
      density: 0.5,
      /** 雲の模様の細かさ */
      scale: 0.0002,
      /** 雲が流れる速さ */
      speed: 0.00003,
      /** 雲の高さの見え方（大きいほど低く・近く見える） */
      elevation: 0.5,
    },
  },
};

/** 保存した地点のピン */
export const PINS = {
  /** ブラウザに保存する時の名前 */
  storageKey: 'sky-drive.pins',
  /** この距離 (m) 以内のピンを出す（radius の 0.75 倍から薄くする） */
  radius: 8000,
  /** ピンの高さ (m)。どの距離でも実寸で一律 */
  size: 20,
  /** 名前の札の画面上の縦の大きさ（画面の高さに対する割合） */
  signSize: 0.04,
  /** 名前の長さの上限（文字） */
  maxNameLength: 40,
};

/** 3D 空間に置く駅名・通り名 */
export const LABELS = {
  station: {
    /** この距離 (m) 以内の駅に看板を出す */
    radius: 2500,
    /** 看板の地面からの高さ (m) */
    height: 70,
    /** 同時に出す看板の数（近い順）。多いと建物越しに重なって見づらい */
    maxCount: 10,
    /**
     * 看板の画面上の縦の大きさ（画面の高さに対する割合）。近くは near、radius では far。
     * 距離で実寸を変えて、近くの看板が巨大にならないようにする
     */
    screenSize: { near: 0.038, far: 0.022 },
    /** この距離 (m) より近い看板は薄くする（自機に重ならないように） */
    fadeNear: 250,
  },
  road: {
    /** この距離 (m) 以内の通りに名前を描く */
    radius: 1200,
    /** 文字の高さ (m) */
    textHeight: 14,
    /** 地面から浮かせる高さ (m) */
    lift: 0.5,
    opacity: 0.85,
  },
};

/** 道路（OpenStreetMap の中心線から、テンプレートで車道・歩道・横断歩道を作る） */
export const ROADS = {
  /** 道路データ（scripts/fetch-road-network.mjs で作る。地形チャンクと同じズーム15のタイル） */
  tilePath: `${REGION.dataDir}roads/15/{x}/{y}.json`,
  /** アスファルトの色（生活道路は shade 倍で明るくする） */
  asphaltColor: 0x55585f,
  /** 歩道のタイルに掛ける色 */
  sidewalkColor: 0xffffff,
  /**
   * 種別ごとの寸法。[幹線, 2車線, 生活道路]
   * lanes：車線数の既定値（データに無い時）、laneWidth：1車線の幅、shoulder：外側線の外の幅、
   * width：生活道路の幅、sidewalk：片側の歩道の幅、lift：地面から浮かせる高さ（交差点で太い道を上に）、
   * shade：アスファルトの明るさ
   */
  classes: [
    { lanes: 4, laneWidth: 3.25, shoulder: 0.75, width: 0, sidewalk: 4, lift: 0.45, shade: 1.0 },
    { lanes: 2, laneWidth: 3.0, shoulder: 0.5, width: 0, sidewalk: 2.5, lift: 0.35, shade: 1.08 },
    { lanes: 0, laneWidth: 0, shoulder: 0, width: 4.5, sidewalk: 0, lift: 0.25, shade: 1.4 },
  ],
  /** 地形に沿わせるため、中心線をこの間隔 (m) で細かく区切る */
  densifyStep: 5,
  /** 道を置く地面を均す範囲（±m）。地形の細かい凸凹を拾わず、まっすぐな道にする */
  smoothRadius: 24,
  /**
   * 道のまわりの地形：道の幅（車道・歩道）の外に足す余裕 (m)。この幅は地形を道の高さにそろえ、その外は
   * gradeSlope の傾き（高さ/水平）で元の地面へ戻る。低い地面は幅の外 gradeFillReach m まで盛る
   */
  gradeMargin: 1.5,
  gradeSlope: 0.6,
  gradeFillReach: 2,
  /** 道の幅の外の斜面で地形を削る範囲 (m)。道の高さとのずれは均す範囲でおさまるので、遠くまでは見ない */
  gradeReach: 12,
  /** 橋のまわりの、橋桁より上に出ている地形を削る斜面の傾き（高さ/水平） */
  bridgeCutSlope: 1.6,
  /**
   * 交差点の面の半径の余白 (m)。交差点の面の半径＝集まる道で一番広い「車道の半分＋歩道」＋これ。
   * 面の中は歩道が角を回り込み、車道は線なしの一続きになる
   */
  junctionMargin: 1.5,
  /** 歩道の高さ（車道より上, m） */
  curbHeight: 0.15,
  /** 上下線が別の道の大通りで、相方の道を探す横の距離 (m) と、中央分離帯（植え込み）の色 */
  medianSearch: 45,
  medianColor: 0x6f8a5a,
  /** 横断歩道の長さ（道に沿った方向, m） */
  crosswalkLength: 4,
};

/** 海・川（国土地理院 淡色地図の水色の画素から水域を作り、地形の上で水面として描く） */
export const WATER = {
  /** 水域を判定する地図（淡色地図は水域を #bed2ff の1色で塗っている） */
  mapUrl: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  /**
   * 水域の面（国土地理院のベクトルタイルの waterarea）。淡色地図で高架・幅の広い橋に隠れた川の下も水にする。
   * ベクトルタイルはズーム 16 まで
   */
  areaUrl: 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf',
  areaZoom: 16,
  /** 地形チャンクより何段細かいズームで判定するか（1 で約2m/画素） */
  zoomOffset: 1,
  /** 文字ラベルなどの小さな穴を埋める大きさ（画素） */
  closeRadius: 3,
  /** 橋の下の途切れを埋める大きさ（画素）。約2m/画素なので 18 ≒ 幅 70m の橋まで */
  bridgeCloseRadius: 18,
  /** 水面の標高 (m)。都内の川は海とつながっていて、ほぼ海面の高さ */
  surfaceHeight: 0.8,
  /** 岸の線をなめらかにするぼかしの半径（画素）。護岸の帯・波打ち際の線の太さにもなる */
  edgeBlur: 4,
  /** 護岸（陸側の縁）の色と、波打ち際の泡の色・強さ */
  bankColor: 0xd9d4c8,
  foamColor: 0xf2f8ff,
  foamStrength: 0.75,
  /** 岸からこの距離（画素）で一番深い色になる。約2m/画素なので 120 ≒ 240m */
  deepDistancePx: 120,
  /** 砂浜の前の浅瀬の色（明るい青緑） */
  beachShallowColor: 0x5cc4c2,
  /** 砂浜へ寄せる波：波の間隔 (m)、沖へ見える範囲 (m)、寄せる速さ (m/秒) */
  surfSpacing: 24,
  surfReach: 90,
  surfSpeed: 2.2,
  /** 岸辺・浅い所の色（川） */
  shallowColor: 0x4fb3d9,
  /** 沖・深い所の色（海） */
  deepColor: 0x1f5fa8,
  /** 水面のなめらかさ（小さいほど空がくっきり映る） */
  roughness: 0.06,
  /** 水の地の色の明るさ（shallowColor・deepColor に掛ける）。本物の水は暗く、見える色の大部分は空の映り込み */
  albedo: 0.9,
  /** 空の映り込みの強さ（浅い角度ほど強く映るのは、材質の計算のまま） */
  reflection: 6,
  /** さざ波の強さ・一番大きい波の大きさ (m) */
  waveStrength: 0.35,
  waveScale: 9,
  /** さざ波を waveFadeNear〜waveFadeFar (m) で waveFarFlatten の割合だけ弱める（遠くの水面は鏡のように空を映す） */
  waveFadeNear: 120,
  waveFadeFar: 1200,
  waveFarFlatten: 0.85,
};

/** 橋（道路データの橋の区間を、地形に沿わせず橋桁として作る） */
export const BRIDGES = {
  /** これより長い橋 (m) は「大きな橋」として、水面から高く・桁を厚くする */
  longBridge: 60,
  /** 大きな橋の、水面から橋桁までの高さ (m) */
  waterClearance: 7,
  /** 橋の反り：長さに対する割合と、最大の高さ (m) */
  camberRatio: 0.03,
  maxCamber: 5,
  /** 桁の厚さ (m) */
  girderDepth: 1.8,
  /** 欄干の高さ (m) */
  railingHeight: 1.1,
  /** 橋脚の間隔と厚さ (m) */
  pierSpacing: 40,
  pierThickness: 2.4,
  /** 名前のある、これより長い橋 (m) にはアーチを付ける（OSM では大きな橋も数本に分かれていることが多い） */
  archMinLength: 70,
  /** 名前が「〜橋」でない橋は、これより長い (m) ものだけにアーチを付ける */
  archMinLengthUnnamed: 150,
  /** アーチの高さ：長さに対する割合と最大 (m)、帯の幅 (m) */
  archRatio: 0.12,
  archMaxHeight: 22,
  archWidth: 1.4,
  /** 吊り材の間隔 (m) */
  hangerSpacing: 8,
  concreteColor: 0xb9bcc2,
  railingColor: 0xe6e8ec,
  archColor: 0x9fb0c2,
};

/** 駅の屋根（OpenStreetMap の駅舎・上屋の形。scripts/fetch-station-roofs.mjs で作る） */
export const STATION_ROOFS = {
  tilePath: `${REGION.dataDir}station-roofs/15/{x}/{y}.json`,
  /**
   * 屋根の色（駅ごとにこの中から選ぶ）。
   * 航空写真の主要駅（東京・秋葉原・新橋・原宿）を参考に、白・銀・薄い緑・青緑
   */
  colors: [0xf2f4f6, 0xcfd5db, 0xa9cbbd, 0x6fa79a, 0xe3e8e4],
  /** 波板の山の間隔 (m) */
  ribSpacing: 0.9,
  /** 縁の帯の高さ (m) */
  fasciaDepth: 0.8,
  fasciaColor: 0xd9dde2,
  /** 上屋の屋根の、ホームの床からの高さ (m)。scripts/build-platforms.mjs と同じ値 */
  canopyHeight: 4.5,
  /** 上屋の柱の間隔・太さ (m)。幅がこれ (m) より広い屋根には柱を立てない */
  pillarSpacing: 10,
  pillarSize: 0.35,
  pillarMaxRoofWidth: 16,
  pillarColor: 0xd5d8dc,
  /** ホームの側面の高さ（床からレール面まで, m）と、引っ込んだ壁の色 */
  platformDepth: 1.1,
  platformSideColor: 0x4a4d52,
  /** 線路側の縁：白い縁石の色・前面の高さ (m)・床の上の帯の幅 (m)、その下の壁の引っ込み (m) */
  platformEdgeColor: 0xe4e4df,
  edgeDepth: 0.25,
  edgeWidth: 0.3,
  recess: 0.5,
  /** 点字ブロック：縁からの距離・幅 (m)、模様1枚の長さ (m) */
  tactileInset: 0.8,
  tactileWidth: 0.3,
  tactileTile: 0.3,
  /** 高架のホームの下の柱：側面の下端が地面からこの高さ (m) 以上なら立てる。間隔・太さ (m) */
  platformPillarFrom: 2,
  platformPillarSpacing: 15,
  platformPillarSize: 1.2,
};

/** 線路（OpenStreetMap の線路。scripts/fetch-railways.mjs → build-rail-heights.mjs で作る） */
export const RAILWAYS = {
  tilePath: `${REGION.dataDir}rail-tracks/15/{x}/{y}.json`,
  /** 道床（砂利を敷いた部分）の幅 (m) */
  ballastWidth: 3.4,
  /**
   * 地上の線路の両側の金網の柵：中心線から offset m、高さ height m、支柱の間隔 postSpacing m。
   * ほかの線路の中心線が offset + gap m より近い所（並んだ線路の間）と、踏切の周り（交わる道の半径 + crossingClear m）には立てない
   */
  fence: { offset: 3.0, height: 1.5, postSpacing: 2.0, gap: 0.6, crossingClear: 3 },
  /** 地面から浮かせる高さ (m) */
  lift: 0.3,
  /** 高架の上面をなだらかにするため、地面を均す範囲（±m） */
  smoothRadius: 60,
  /** 掘割：底を探す範囲（前後, m）、削る幅（底の平らな部分, m）、両側の斜面の傾き（高さ/水平）、底を線路より下げる量 (m) */
  cutFloorRadius: 20,
  cutWidth: 10,
  cutSlope: 1.6,
  cutDepthBelow: 0.15,
  /**
   * 地面の高さを走る線路のまわりの地形：道床のすぐ下にそろえる幅 (m)、その外の斜面の傾き（高さ/水平）、
   * 低い地面を盛る範囲（幅の外, m）。地形の頂点は約 8m おきなので、道床より少し広く取る
   */
  gradeWidth: 6,
  gradeSlope: 0.6,
  gradeFillReach: 3,
  /** 川の上を渡る線路の、水面からの高さ (m) */
  waterClearance: 2.5,
  /** 地面からこの高さ (m) を超えた所に高架の桁・側壁を付ける */
  elevatedFrom: 1.5,
  /** 地面からこの高さ (m) を超えた所に橋脚を立てる */
  pierFrom: 3,
  /** 高架の桁の厚さ (m) と、側面の壁の高さ (m) */
  viaductDepth: 1.6,
  /** 道床の外側の、高架の平らな部分の幅 (m)。隣の線路の高架とつながって1枚の高架に見える */
  viaductShoulder: 1.0,
  /** 高架の橋脚の間隔 (m) と太さ (m) */
  pierSpacing: 45,
  pierThickness: 1.6,
  /** 中心線を区切る間隔 (m)。地形のメッシュ（約19m）の折れ目に沿えるよう細かめ */
  densifyStep: 4,
  concreteColor: 0xb4b6ba,
  /**
   * 跨座式のモノレール（軌間 0）：コンクリートの桁の幅・高さ (m)、橋脚の間隔 (m)・太さ (m)・色。
   * 桁の上面が走る面（線路の高さ）。低い所（地上の区間）は桁の下を地面まで壁にする
   */
  monorail: {
    beamWidth: 0.85,
    beamDepth: 1.5,
    pierSpacing: 30,
    pierThickness: 1.3,
    wallBelow: 4,
    color: 0xc8c9c6,
  },
  /** トンネルの奥へ描く長さ (m)、入口の壁の上端を決める時に見る入口から奥への距離 (m)、
   * トンネルの内壁の入口近くの色と、奥の暗がりの色 */
  portalDepth: 25,
  portalCover: 8,
  tunnelLiningColor: 0x6a6c70,
  tunnelColor: 0x0d0e12,
  /** トンネルの入口（坑口）と、入口へ下りる掘割の擁壁 (m) */
  portal: {
    /** 開口部：線路1本ぶんの幅、レール面からの高さ、開口部の上に残す梁の高さ、開口部の間の柱の最小の幅 */
    openingWidth: 4.6,
    height: 6.3,
    beam: 1.2,
    minPier: 0.8,
    /** 地下鉄の複線を1つの開口部にまとめる線路の間隔の上限 */
    subwayMerge: 5.5,
    /** 外側の開口部と正面の壁の端の間、正面の壁の厚み、袖の壁の長さ、壁の上端の地面からの高さ（笠石・柵の代わり） */
    side: 1.4,
    thickness: 1.2,
    wing: 8,
    parapet: 0.9,
    /** 擁壁：線路の中心から内側の面まで、厚み、柵の代わりに上端を地面より高くする深さ（地面からこれ以上低い所） */
    retainOffset: 3.1,
    retainThickness: 0.6,
    minDepth: 0.8,
    /** 掘割の地形を削るのを、入口の手前で止める距離（地形が開口部の中へ垂れ下がらないように） */
    carveStop: 12,
    /** 掘割の底の、レール面からの深さ */
    floorDepth: 0.35,
    /** 掘割の内側の地形を描かないための画像：1辺の画素数、中心線からの距離を入れる範囲 */
    maskSize: 1024,
    maskRange: 8,
    /** 内壁が入口から奥へ暗くなる長さ */
    fade: 12,
  },
};

/** 駅検索 */
export const SEARCH = {
  /** 候補の最大数 */
  maxResults: 8,
  /** ジャンプした時の、地面からの高さ (m)。駅前の高層ビルより上 */
  jumpAltitude: 100,
  /** 着いた所の地形がまだ読めていない間、待つ高さ（標高, m）。23区で一番高い所より十分上 */
  waitAltitude: 250,
};

/** 公園（OpenStreetMap の公園・林・グラウンド・園路。scripts/fetch-parks.mjs で作る） */
export const PARKS = {
  tilePath: `${REGION.dataDir}parks/15/{x}/{y}.json`,
  /** 芝生の色（2色の間でむらを付ける）と、園路・グラウンドの土の色 */
  grassColor: 0x6fae4a,
  grassColor2: 0x8cc35a,
  dirtColor: 0xc9ab84,
  /** 木：格子の間隔 (m)、芝生の真ん中・縁（edgeWidth m 以内）・林での密度（0..1）、桜の割合 */
  treeSpacing: 9,
  edgeWidth: 14,
  lawnDensity: 0.12,
  edgeDensity: 0.75,
  woodDensity: 0.85,
  sakuraRatio: 0.12,
  /**
   * 森のような公園：[緯度, 経度, 半径 (m)]。地図では芝生の公園でも、実際は木の茂った所。
   * 中は林と同じ密度で植え、水辺から bankWidth m 以内は桜並木にする
   */
  groves: [
    [35.6915, 139.751, 480], // 北の丸公園（日本武道館のまわり）と千鳥ヶ淵
  ] as Array<[number, number, number]>,
  bankWidth: 22,
  maxTreesPerChunk: 4000,
  /** カメラからこの距離 (m) 以内のチャンクだけ木を描く */
  treeRadius: 1600,
  leafColor: 0x4f8f3c,
  coniferColor: 0x2f6b3a,
  sakuraColor: 0xf3b6cc,
};

/** 道路・公園・水以外の地面（scripts/fetch-landuse.mjs で作る）。種類ごとのテンプレートの色 */
export const LANDUSE = {
  tilePath: `${REGION.dataDir}landuse/15/{x}/{y}.json`,
  /** 航空写真の色を混ぜる割合（種類の分かる所・データの無い住宅地の敷地） */
  photoMix: 0.15,
  defaultPhotoMix: 0.3,
  /**
   * 種類の無い地面の塗り分け。建物から lotNear m までは住宅地の敷地、lotFar m より先は自然の地面（間はなめらかに）。
   * 傾きが bankSlope（1 - 法線の上向き成分）を超える斜面は、建物の近くでも草の法面にする。自然の地面は写真を naturalPhotoMix 混ぜる
   */
  /** 線路わきの砂利：線路の中心線から inner m までは焦げ茶の砂利、outer m で周りの地面に戻る */
  railSide: { inner: 3.5, outer: 5.5 },
  natural: { lotNear: 30, lotFar: 60, bankSlope: [0.06, 0.14], naturalPhotoMix: 0.12 },
  colors: {
    /**
     * 市街地の敷地（データの無い所）：区画ごとに色の違うつぎはぎ。白っぽい灰色（コンクリート・屋根の照り返し）が主で、
     * 暗い灰色（アスファルト）・明るい灰色・薄いベージュ（土・砂利の空き地）が混ざる
     */
    lot: 0xbdbbb6,
    lot2: 0x8e8d8b,
    lotLight: 0xd2d0cb,
    lotSoil: 0xb9ad99,
    /** 駐車場のアスファルトと白線 */
    parking: 0x4b4d52,
    marking: 0xe8e8e2,
    /** 線路の敷地の砂利：灰色がかった薄茶と、少し錆びた茶 */
    ballast: 0x887c70,
    ballast2: 0x8f7967,
    /** 墓地の石畳と墓石 */
    stone: 0xb9b5ad,
    grave: 0x6f6e6c,
    /** 寺社の境内の白い玉砂利 */
    gravel: 0xd8d3c6,
    /** 学校の校庭の土 */
    schoolyard: 0xc4a47c,
    /** 工事現場・空き地の土（2色のむら） */
    bare: 0x9a7d5c,
    bare2: 0x7f6a52,
    /** 工場・倉庫・港のコンクリート */
    concrete: 0xa4a49e,
    /** 草地（2色のむら） */
    grass: 0x78a556,
    grass2: 0x93b863,
    /** 建物から離れた、種類の無い地面：野の草・枯れ草・林の下草・斜面の法面 */
    wild: 0x84a656,
    wild2: 0x9db66a,
    dryGrass: 0xaaa36c,
    forestFloor: 0x67874a,
    bank: 0x86a05a,
    /** 畑の土と作物 */
    soil: 0x86684a,
    crop: 0x6f9a45,
    /** 広場・商業地のタイル舗装 */
    paving: 0xc9c3b8,
    /** 砂浜の乾いた砂（2色のむら）と、波打ち際の湿った砂 */
    sand: 0xe6d6b0,
    sand2: 0xd6c39a,
    wetSand: 0xa48c68,
    /** 空港の芝地（刈り込んだ明るい緑の2色の縞）と、駐機場の明るいコンクリート */
    airfield: 0x86ad5c,
    airfield2: 0x9bbd6c,
    apron: 0xb9bab6,
  },
  /** 砂浜から海側へ「砂浜の前の海」とみなす距離 (m)。浅瀬の色と寄せる波を描く範囲 */
  beachReach: 100,
};

/** 空港の滑走路・誘導路・駐機している飛行機（src/world/Airports.ts） */
export const AIRPORTS = {
  /** 中心線を区切る間隔 (m) */
  densifyStep: 12,
  /** 地面から浮かせる高さ (m)：誘導路・滑走路・滑走路の印（重なった時に上に来る順） */
  taxiwayLift: 0.3,
  runwayLift: 0.4,
  markingLift: 0.05,
  /** 滑走路の中心線の破線の周期 (m)（30m の線と 20m のすき間） */
  dashPeriod: 50,
  /** 進入端の印（縞模様と番号）を描く、端からの長さ (m) */
  thresholdLength: 84,
  /** 搭乗橋：通路の幅・高さ (m)、床の高さ（ターミナルの側・飛行機の扉の側, m）、脚を立てる先からの距離 (m) */
  jetBridge: { width: 2.8, height: 2.9, floorStart: 5.5, floorEnd: 4.2, legFromEnd: 6 },
  /** 尾翼の色（白・赤・紺・水色・黄緑など） */
  tailColors: [0xf4f5f6, 0xd7262e, 0x14336e, 0x2f8fd5, 0x7cc04b, 0xf5a623, 0x1b4f9c],
};

/** 高速道路（首都高・湾岸線・外環道など。scripts/fetch-expressways.mjs → build-expressways.mjs で作る） */
export const EXPRESSWAYS = {
  tilePath: `${REGION.dataDir}expressways/15/{x}/{y}.json`,
  /** 車線幅・路肩の幅 (m) */
  laneWidth: 3.5,
  shoulder: 1.0,
  /** 地面から浮かせる高さ (m) */
  lift: 0.35,
  /** 地面からこの高さ (m) を超えた所を高架とし、桁の裏側を付ける。この高さ (m) を超えた所に橋脚を立てる */
  elevatedFrom: 2,
  pierFrom: 4,
  /** 中心線を区切る間隔 (m) */
  densifyStep: 5,
  /** 高架の上面をなだらかにするため、地面を均す範囲（±m） */
  smoothRadius: 80,
  /** 掘割：底を探す範囲（前後, m）、削る幅（底の平らな部分, m）、両側の斜面の傾き */
  cutFloorRadius: 20,
  cutWidth: 14,
  cutSlope: 1.6,
  /**
   * 地面の高さの区間のまわりの地形：路面の幅の外に足す余裕 (m)、その外の斜面の傾き（高さ/水平）、
   * 低い地面を盛る範囲（幅の外, m）
   */
  gradeMargin: 2,
  gradeSlope: 0.6,
  gradeFillReach: 3,
  /** 壁高欄：高さ・厚さ (m)、上の手すりの壁からの高さ (m) */
  barrierHeight: 1.0,
  barrierThickness: 0.45,
  railHeight: 0.15,
  /** 桁の厚さ (m) */
  girderDepth: 2.2,
  /** 橋脚：間隔・柱の半径・梁の厚さ (m) */
  pierSpacing: 35,
  pierRadius: 1.1,
  beamDepth: 1.6,
  /** カーブの外側のしましま：これより急なカーブ（半径 m）に、この幅 (m) で */
  zebraRadius: 180,
  zebraWidth: 2.4,
  /** 街灯：間隔・高さ・腕の長さ (m) */
  lampSpacing: 45,
  lampHeight: 9,
  lampArm: 2.2,
  /** 路線名：間隔・文字の高さ (m) */
  nameSpacing: 500,
  nameHeight: 5,
  concreteColor: 0xeceef0,
  undersideColor: 0xb3b8bf,
  railColor: 0xc8ccd2,
  lampPoleColor: 0x9aa0a8,
  lampColor: 0xffd9a0,
};

/** 建物タイルのブラウザ内キャッシュ（Cache Storage） */
export const TILE_CACHE = {
  /** キャッシュの名前。中身の形式を変えた時は名前を変える（古いものは自動で消える） */
  name: 'sky-drive-tiles-v1',
  /** この日数より古いものは取り直す */
  maxAgeDays: 30,
};
