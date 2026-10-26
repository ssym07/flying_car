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
     * 20 だと半径約6.5kmの細かいタイルを全部読んでしまう。30 で約4.3km（≒霧の終わり）。
     * 粗い階層の建物は大きく簡略化されていて「くさび形」に崩れるので、霧より手前に出さないようにする
     */
    plainErrorTarget: 30,
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

export const MINIMAP = {
  /** 画面上の大きさ (px) */
  size: 250,
  /** 表示の拡大率（地図タイルのズームレベルと同じ尺度）。15 で 1px ≒ 4m、250px で約1km 四方。小数も可 */
  zoom: 15,
  /** 拡大率を変えられる範囲（13 で約4km 四方、17.5 で約180m 四方） */
  minZoom: 12,
  maxZoom: 17.5,
  /** ボタン1回・ホイール1目盛り（deltaY 100）で変わる量 */
  zoomStep: 0.5,
  /** 地図タイルの最大ズーム（淡色地図は 18 まで） */
  maxTileZoom: 18,
  /** 国土地理院 淡色地図 */
  tileUrl: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  /** 手元に残しておくタイル数の上限 */
  maxCachedTiles: 64,
  /** 通り名の文字の大きさ (px) */
  labelFontSize: 11,
  /** 同じ通り名を同時に出す最大数 */
  maxLabelsPerName: 1,
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
    fog: { near: 700, far: 4200 },
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
    fog: { near: 1200, far: 4500 },
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
  tilePath: 'roads/15/{x}/{y}.json',
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
  /** 交差点の中心から（道幅の半分＋この距離 m）までは、車線の線と歩道を出さない */
  junctionClear: 4,
  /** 歩道の高さ（車道より上, m） */
  curbHeight: 0.15,
  /** 横断歩道の長さ（道に沿った方向, m） */
  crosswalkLength: 4,
};

/** 海・川（国土地理院 淡色地図の水色の画素から水域を作り、地形の上で水面として描く） */
export const WATER = {
  /** 水域を判定する地図（淡色地図は水域を #bed2ff の1色で塗っている） */
  mapUrl: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  /** 地形チャンクより何段細かいズームで判定するか（1 で約2m/画素） */
  zoomOffset: 1,
  /** 文字ラベルなどの小さな穴を埋める大きさ（画素） */
  closeRadius: 3,
  /** 水面の標高 (m)。都内の川は海とつながっていて、ほぼ海面の高さ */
  surfaceHeight: 0.8,
  /** 岸の線をなめらかにするぼかしの半径（画素） */
  edgeBlur: 3,
  /** 岸からこの距離（画素）で一番深い色になる。約2m/画素なので 120 ≒ 240m */
  deepDistancePx: 120,
  /** 岸辺・浅い所の色（川） */
  shallowColor: 0x4fb3d9,
  /** 沖・深い所の色（海） */
  deepColor: 0x1f5fa8,
  /** 水面のなめらかさ（小さいほど空がくっきり映る） */
  roughness: 0.12,
  /** さざ波の強さ */
  waveStrength: 0.09,
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
  tilePath: 'station-roofs/15/{x}/{y}.json',
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
  /** ホームの側面の高さ（床からレール面まで, m）と色 */
  platformDepth: 1.1,
  platformSideColor: 0x9c9fa4,
  /** 点字ブロック：縁からの距離・幅 (m)、色。この長さ (m) より短い辺には付けない */
  tactileInset: 0.8,
  tactileWidth: 0.3,
  tactileColor: 0xe8c02a,
  tactileMinEdge: 15,
};

/** 線路（OpenStreetMap の線路。scripts/fetch-railways.mjs → build-rail-heights.mjs で作る） */
export const RAILWAYS = {
  tilePath: 'rail-tracks/15/{x}/{y}.json',
  /** 道床（砂利を敷いた部分）の幅 (m) */
  ballastWidth: 3.4,
  /** 地面から浮かせる高さ (m) */
  lift: 0.3,
  /** 高架の上面をなだらかにするため、地面を均す範囲（±m） */
  smoothRadius: 60,
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
