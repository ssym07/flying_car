# Sky Drive（仮）— 空飛ぶ車フライトシミュレーター

実在の都市の3Dデータの上を、空飛ぶ車で三人称視点のまま飛び回るブラウザゲーム。

- **構成**: Vite + TypeScript + Three.js
- **地図**: 3D Tiles（PLATEAU / Google Photorealistic 3D Tiles）を `3d-tiles-renderer` で描画
- **操作**: キーボード（WASD + 上昇/下降）

---

## 1. MVP（最小で「遊べる」もの）

### MVPのゴール
> **実在の街1区画の上を、空飛ぶ車をWASDで飛ばせる。カメラは車の後ろから追従し、建物や地面にはめり込まない。**

### MVPに含めるもの
| 項目 | 内容 |
|---|---|
| ゲームループ | 固定時間刻み（1/60秒）の update と可変の render を分離 |
| 入力 | WASD = 前後・旋回、Space = 上昇、Shift = 下降、Esc = ポーズ |
| 車両 | 箱か簡単なglTFモデル1台。推力・重力・ホバー推力・空気抵抗の簡易物理 |
| カメラ | 三人称追従（後方上空のオフセットへ lerp で寄せる） |
| 地図 | PLATEAU の1区画を3D Tilesで読み込み、開始地点をローカル原点にする |
| 当たり判定 | 下方向・進行方向へのレイキャストで、地面・建物へのめり込みを防ぐ |
| HUD | 速度・高度の数値表示（HTMLオーバーレイ） |
| 画面遷移 | Title → Loading → Flight ⇄ Pause の4シーン |

### MVPに含めないもの（後回し）
- リアルな航空力学（揚力・ピッチ/ロールの慣性）
- 複数地点の選択、ミッション、スコア
- サウンド、パーティクル、天候、昼夜
- ゲームパッド、モバイル対応
- マルチプレイ

### 完了条件
- [ ] 起動 → タイトル → ロード → 飛行まで、操作だけで遷移できる
- [ ] 60fps前後で安定する（M系Macのブラウザで確認）
- [ ] 1分間飛び回っても、地面・建物を貫通しない
- [ ] 遠くまで飛んでも車やカメラが震えない（座標精度の問題が出ない）
- [ ] Esc でポーズと再開ができる

---

## 2. アーキテクチャ

### 全体の流れ
```
requestAnimationFrame
  └─ GameLoop
       ├─ update(dt=1/60) を固定刻みで必要回数呼ぶ
       └─ render() を1回呼ぶ
            └─ SceneManager が「現在のシーン」だけに委譲
```

### シーン（画面）遷移
```
TitleScene ──▶ EntranceScene ──▶ LoadingScene ──▶ FlightScene ⇄ PauseScene
                                     │
                                     ▼
                               （将来）ResultScene
```
各シーンは共通インターフェースを持つ。

```ts
interface GameScene {
  enter(): void;            // 遷移してきた時：初期化・読込
  exit(): void;             // 抜ける時：リソース解放
  update(dt: number): void; // ロジック・物理
  render(): void;           // 描画
}
```
- メニュー系（Title / Pause）は HTML/CSS のオーバーレイで作る
- Pause は「update を止めて render だけ続ける」

### FlightScene の1フレーム
1. `Input` から現在押されているキーを読む
2. `Vehicle` が推力・重力・抵抗から速度と位置を更新する
3. `Collision` がレイキャストでめり込みを検出し、押し戻す
4. `ChaseCamera` が車の後方へ追従する
5. `Tiles` がカメラ位置に応じてタイルを読込・破棄する（`tiles.update()`）
6. 描画する

### 座標系の方針
- 3D Tiles は地球中心座標（ECEF、値が数百万メートル）で届く
- **飛行開始地点を原点にした「東・北・上」のローカル座標**に変換し、ゲームロジックはすべてローカル座標で書く
- float精度不足によるガタつきを避けるため

### ディレクトリ構成
```
src/
├─ main.ts                 # エントリ。renderer/loop/sceneManager を組み立てる
├─ core/
│  ├─ GameLoop.ts          # 固定刻みループ
│  ├─ SceneManager.ts      # シーンの切替
│  ├─ Input.ts             # キー状態をSetで保持
│  └─ config.ts            # 物理パラメータ・キー割当など定数
├─ scenes/
│  ├─ TitleScene.ts
│  ├─ LoadingScene.ts
│  ├─ FlightScene.ts
│  └─ PauseScene.ts
├─ world/
│  ├─ Tiles.ts             # 3d-tiles-renderer のラッパ、原点変換
│  └─ Collision.ts         # レイキャスト判定
├─ vehicle/
│  ├─ Vehicle.ts           # 状態（位置・速度・向き）とメッシュ
│  └─ physics.ts           # 推力・重力・抵抗の計算（純粋関数）
├─ camera/
│  └─ ChaseCamera.ts       # 三人称追従
└─ ui/
   ├─ hud.ts               # 速度・高度表示
   └─ overlay.css
```

設計ルール:
- `physics.ts` は Three.js に依存しない純粋関数にする（テストしやすく、調整しやすい）
- キーイベントの中で直接車を動かさない。イベントは状態を記録するだけで、動かすのは update の中
- 調整したい数値はすべて `config.ts` に集める

---

## 3. ロードマップ

### Phase 0：環境構築（〜半日）
- [ ] `npm create vite@latest` で vanilla-ts テンプレートを作る
- [ ] `three`、`@types/three` を入れる
- [ ] 画面いっぱいの canvas に回転する箱を表示する

### Phase 1：箱を飛ばす（MVP前半、1〜2日）
- [ ] `GameLoop`（固定刻み）を作る
- [ ] `Input` を作り、WASD + Space/Shift で箱を動かす
- [ ] 簡易物理（推力・重力・ホバー・抵抗）を入れる
- [ ] 地面は無限平面で代用する（y=0 で止める）
- **確認**：手を離すと自然に減速し、ふわっと浮いていられるか

### Phase 2：三人称カメラ（MVP前半、半日〜1日）
- [ ] `ChaseCamera` を作る（後方オフセット + lerp）
- [ ] 旋回時にカメラが遅れてついてくる気持ちよさを調整する
- **確認**：ここで「ゲームっぽさ」が出る。操作感をここで詰め切る

### Phase 3：実在の街を表示（MVP後半、2〜4日）
- [ ] `3d-tiles-renderer` を導入する
- [ ] PLATEAU の1区画（3D Tiles）を読み込んで表示する
- [ ] 開始地点を原点にするローカル座標変換を入れる
- [ ] 平面の地面を外し、タイルに置き換える
- **確認**：遠くまで飛んでも車が震えないか、タイルが途切れず読み込まれるか

### Phase 4：当たり判定（MVP後半、1〜3日）
- [ ] 下向きレイで地面・屋上の高さを取得し、着地・接地を判定する
- [ ] 進行方向レイで建物の壁との衝突を判定し、押し戻す
- [ ] 高速移動時のすり抜け対策（移動量に応じてレイを伸ばす）
- **確認**：ビルに突っ込んでも貫通しないか

### Phase 5：画面遷移とHUD（MVP完成、1〜2日）
- [ ] `SceneManager` と Title / Loading / Flight / Pause の4シーンを作る
- [ ] Loading でタイルの初期読込完了を待ってから Flight に入る
- [ ] HUD に速度・高度を表示する
- **🎯 ここで MVP 完成**

---

### Phase 6以降：MVP後の拡張（優先度順の目安）

**6. 操作感の向上**
- ピッチ・ロールの傾き演出（旋回時に機体が傾く）
- カメラの切替（三人称 / コックピット / 俯瞰）
- ゲームパッド対応（Gamepad API）

**7. 見た目**
- 車両を glTF モデルに差し替える
- 空（スカイボックス）、フォグ、時間帯で変わるライティング
- Google Photorealistic 3D Tiles への切替オプション（APIキー・利用規約を確認のうえ）

**8. ゲーム性**
- チェックポイントを通過するタイムアタック
- 地点選択画面（複数都市）
- ResultScene（タイム・ランキングはローカル保存）

**9. 演出**
- エンジン音（速度でピッチが変わる）、風切り音
- 衝突時のカメラシェイク
- HUD に高度・速度の推移グラフ

**10. 技術的な改善**
- 物理を Web Worker に分離する
- タイル読込の先読み（進行方向を優先）
- パフォーマンス計測（stats.js）と品質設定（描画距離・解像度）

---

## 4. 地図データについて

| データ | 特徴 | 注意点 |
|---|---|---|
| PLATEAU（国交省） | 日本の都市の3D都市モデル。無料。建物形状がきれいで当たり判定が素直 | 対応都市・区画を確認。配信APIの仕様変更に注意 |
| Google Photorealistic 3D Tiles | 写真ベースで見た目が最もリアル | APIキーと課金が必要。ゲーム利用の可否と帰属表示を利用規約で要確認 |

MVP は **PLATEAU の1区画**で進める。

### ワールドを足す・広げる手順

データを作るスクリプトは `scripts/` にあり、どれも環境変数 `REGION=`（kanto・kinki・kyushu・chubu・hokkaido。無ければ kanto）で地域を選ぶ。
出力は地域ごとの置き場所（`public/<地域>/`・`data/<地域>/`・`src/data/<地域>/`。関東だけ直下）。建物（`public/plateau/<市区町村コード>/`）は地域に関係なく共通。
取得（Overpass）は混んでいると何時間もかかるので、`caffeinate -i` を付けて裏で流し、区切りごとにデータのフォルダだけコミットする（新しいワールドは `scripts/region-pipeline.sh`、今あるワールドに長方形を足した時は `scripts/region-extend.sh`。使い方は各スクリプトの先頭）。

**1. 設定を足す（新しいワールドの時）**
- `src/core/region.ts`：`REGIONS` に地域（名前・開始地点の駅・ジオイド高（国土地理院のジオイド計算で開始地点を引く）・`dataDir`・都道府県コード・検索欄の例）
- `scripts/lib/region.mjs`：`REGION_ID` の候補、`REGION_AREAS`（取る範囲の長方形 [南, 西, 北, 東]。平野・市街地だけにする）、`REGION_SETTINGS`（開始地点・空路の拠点駅（`fetch-stations` で取った駅の名前と同じにする。無いと空路が NaN になる）・路線図の環状線など。町ごとに飛び飛びの範囲の地域は、路線図の `bridgeGaps`（範囲の外の駅を飛ばして線をつなぐ）と `geoLayout`（中心から離れた所は駅を地理の位置のままにし、駅の間を実際の線路の形に沿わせる。海の上を通らないように））
- `src/data/regionData.ts`・`src/data/allStations.ts` の読み込み先、`.gitignore` の `data/<地域>/cache`
- `scripts/build-municipalities.mjs` の `PREFS`（都道府県コード）、都府県庁（`PREF_OFFICES`）、区ごとに選ぶ政令市（`SPLIT`）
- `src/data/wards.ts`：建物を作る市区町村。PLATEAU があれば配信 URL（データカタログ API `https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets` の bldg・LOD1）、無ければ `url: ''`（国土地理院の建物の形から作る）
- フォルダを作る：`mkdir -p public/<地域> data/<地域>/{osm,stations,airports,cache} src/data/<地域>`

**2. データを作る（この順に。範囲を足す時は、足した長方形だけ取り足す）**

| 順 | スクリプト | 中身 |
|---|---|---|
| 1 | `fetch-stations` → `fetch-roads` | 駅・通りの名前 |
| 2 | `fetch-road-network - 分割数`、2つ目からの長方形は `fetch-road-network 南,西,北,東 分割数` | 道路網。**引数なし（`-`）は 1つ目の長方形だけを丸ごと作り直し、ほかの長方形のタイルを消す**ので、範囲を足す時は必ず長方形を渡す。AREAS の外の山あいで道路だけ描きたい所は、設定の `roadOnlyAreas`（福岡の背振山地など）に書いて同じように長方形を渡して取る（そのあと 4 の `build-rail-heights` から流し直す） |
| 3 | `fetch-railways` → `fetch-expressways` → `fetch-station-roofs` | 鉄道・高速道路・駅の屋根 |
| 4 | `build-rail-heights` → `build-station-footprints` → `build-platforms` → `build-expressways` | 線路の高さ・ホーム・高速道路の形 |
| 5 | `build-local-buildings 市区町村コード... --clip`（PLATEAU）／`build-gsi-buildings コード 名前 都道府県`（国土地理院。線路の上の建物を除くので 4 の後） → `build-building-pads`（引数なしでその地域の全部を作り直す） | 建物と敷地 |
| 6 | `fetch-airports` →（PLATEAU の空港なら `build-airport-fixed-links 区コード`）→ `build-station-cutouts` → `build-sky-lanes` → `fetch-route-map` → `build-route-map-sea` → `build-train-routes` | 空港・駅の切り抜き（5 の後）・空路・路線図・走る電車の道（路線図の駅の並びを線路のキャッシュの上でつなぐ。特急は除くが、路線図に無い列車（北海道の特急など）は `REGION_SETTINGS` の `trainLines` に止まる駅の並びで足す）。電車の塗り分け・編成・ダイヤの型・ダイヤの板のまとめは `src/core/config.ts` の `TRAINS`（行に `region` を付けるとその地域だけ） |
| 7 | `fetch-landuse`・`fetch-parks`（2 と同じく長方形ごと）→ `add-beaches` → `fetch-airports` | 地面の種類・公園・砂浜・空港の地面 |
| 8 | `fetch-station-english` → `build-expressway-signs` → `fetch-expressway-junctions` → `fetch-river-names` | 方面看板・地図の JCT／IC と川の名前 |
| 9 | `fetch-schools` → `fetch-park-names` → `fetch-museums` → `build-municipalities` | 学校・公園・ミュージアムの名前、エントランスの地図と役所 |

**3. 範囲を広げた時に消すキャッシュ**（消さないと前の範囲のまま）
- `data/<地域>/cache/route-map.json`（路線図）、`data/cache/airports-<地域>.json`（空港）
- `data/cache/junctions-<地域>.json`・`data/cache/junctions-gsi-<地域>.json`（JCT・IC）、`data/cache/rivers-<地域>.json`（川）
- 学校・公園・ミュージアムの名前は長方形ごとにキャッシュするので、そのままでよい

**4. 確かめる**：`public/<地域>/` の各フォルダのファイル数を前と比べる（減っていたら、引数なしで流して消した疑い）。ゲームで開始地点・エントランスから飛んで画面を見る。

### 現在使っているデータ（東京23区）
| レイヤー | 出典 | 備考 |
|---|---|---|
| 建物 | PLATEAU 建築物モデル（2025） | 全区とも軽い LOD1（台東区のみテクスチャ無し LOD2）に、手続き的に描いた外壁テンプレート（`src/world/facade.ts`）を貼る。建物の高さで高層／中層／低層のテンプレートを選ぶ。URL は `src/data/wards.ts` |
| 道路 | OpenStreetMap の道路中心線（`public/roads/15/{x}/{y}.json`） | 種別・車線数からテンプレート（路面標示・歩道・横断歩道）で作り、地形に沿わせる（`src/world/RoadNetwork.ts`、`roadTemplates.ts`）。`node scripts/fetch-road-network.mjs` で作り直せる（23区全体で約2時間） |
| 地形 | 国土地理院 標高タイル（5mメッシュ）＋ 全国最新写真 | カメラの周り約3.5kmだけ読み、離れたら捨てる。標高にジオイド高を足して楕円体高に合わせる |
| 海・川 | 国土地理院 淡色地図（水域は #bed2ff の1色） | 水色の画素を水域とし、岸からの距離で浅い青緑〜深い青に塗り分け、さざ波と空の映り込みを付ける（`src/world/water.ts`、設定は `WATER`） |
| 橋 | OpenStreetMap の道路データの橋の区間 | 地形に沿わせず両岸を結ぶ橋桁にし、桁・欄干・橋脚を付ける。「〜橋」や長い橋で水の上のものには鋼のアーチ（`RoadNetwork.ts`、設定は `BRIDGES`）。水域の地形は水面の高さまで下げている |
| 駅の屋根・ホーム | OpenStreetMap の駅舎・上屋・ホーム（`public/station-roofs/15/{x}/{y}.json`） | 屋根は白・銀・薄緑・青緑の金属の波板（しましま）。ホームは床・側面・黄色い点字ブロック、上屋は10mごとの柱で支える。ホームと上屋の高さはそばの線路に合わせる。駅の形の中にある PLATEAU の建物も屋上をしましまにする（`StationRoofs.ts`、設定は `STATION_ROOFS`）。作り直しは `node scripts/fetch-station-roofs.mjs` → `node scripts/build-platforms.mjs` → `node scripts/build-station-footprints.mjs`（線路の高さを作り直した時も build-platforms を再実行） |
| 線路 | OpenStreetMap の線路（元データ `data/osm/railways/`、地下・トンネルは除く） | `node scripts/fetch-railways.mjs` で取得し、`node scripts/build-rail-heights.mjs` で各点の高さを付けて `public/rail-tracks/` に出す。高架は地面から8m（重なる線路は+5mずつ）、地上の道路と交わる所は線路を持ち上げて高架にし、地上との間は3%のスロープ。地上の線路をまたぐ道路の橋は線路の上6.5m以上に上げる（`public/roads/` に印を書き込むので、道路を取り直したら再実行）。掘割（`layer` が負でトンネルでない区間）は地形を削って底に置く。描画は `RailNetwork.ts` |
| 公園 | OpenStreetMap の公園・庭園・林・グラウンド・園路（`public/parks/15/{x}/{y}.json`） | 地形チャンクごとに芝生・土の道の画像を作って地形の色を塗り替え、木（広葉樹・針葉樹・桜）は手続き的に並べる（`src/world/parks.ts`、設定は `PARKS`）。`node scripts/fetch-parks.mjs` で作り直せる（取得済みの区画は `data/cache/parks` に保存され、止まっても続きから再開） |
| 高速道路 | OpenStreetMap の高速道路（元データ `data/osm/expressways.json`、トンネルは除く） | `node scripts/fetch-expressways.mjs` で取得し、`node scripts/build-expressways.mjs` で高さを付けて `public/expressways/` に出す（高架は地面から10m、層ごとに+7m、5%の坂）。白い高架・壁高欄・路面標示・カーブのしましま・街灯・路線名（`ExpresswayNetwork.ts`、設定は `EXPRESSWAYS`） |
| 建物（手元に加工） | PLATEAU の建物タイルから属性（建物IDと名前以外）と外壁の写真を取り除いたもの（`public/plateau/`、git には入れない） | `node scripts/build-local-buildings.mjs [区コード...]` で作る（全区で数時間、止まっても続きから）。作った区は手元から読み、無い区は配信サーバーから読む |
| ミニマップ | 国土地理院 淡色地図（地理院タイル） | CSS フィルタで反転して暗い配色にしている |
| 通り名 | OpenStreetMap（`src/data/roadLabels.json`） | 幹線道路に沿って約350mごとのラベル位置。`node scripts/fetch-roads.mjs` で作り直せる |
| 3D の駅名・通り名 | 上の駅・通り名データ | 駅は上空の看板（近い10駅）、通り名は路面に描く文字。カメラの周りだけ作る（`src/world/Labels.ts`） |
| 空・雲 | アニメ調の夕焼け（`src/world/AnimeSky.ts`）／ three.js の Sky（大気散乱） | `ATMOSPHERE.style` で切り替え。空・雲・光の色や太陽の向きも `ATMOSPHERE`（`src/core/config.ts`） |
| 現在地 | 駅：OpenStreetMap（`src/data/stations.json`）、住所：国土地理院 逆ジオコーダ | 駅一覧は `node scripts/fetch-stations.mjs` で作り直せる |

配信 URL は PLATEAU のデータカタログ API（`https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets`）で探せる。

注意点:
- 建物タイルは粗い階層に高層ビルしか入っておらず、細かいタイルが1枚でも欠けると街全体が粗い表示に戻る。キャッシュ（`WORLD.cacheBytes`）が満杯になると読込が断られるので、テクスチャ上限や詳細度を変えたら必ずメモリ量を確認する
- 区ごとにタイルセットが分かれているので、遠くの区ほど詳細度を下げて（`WORLD.distantLod`）手前の読込を優先している
- ローカル座標は **+x が西、+z が北**、y が上

---

## 5. 開発コマンド

```bash
npm install
npm run dev      # 開発サーバー
npm run build    # 本番ビルド
npm run preview  # ビルド結果の確認
npm run app      # Mac アプリ /Applications/SKY DRIVE.app を作る
```

### Mac アプリ（SKY DRIVE.app）

`npm run app` で Electron のアプリを作る（`scripts/build-mac-app.mjs`。アイコンは `electron/icon.svg`）。
アプリにはゲームの中身もデータも入れず、このフォルダから読む（プログラムは `dist-app`、データは `public`）。そのため、このフォルダがあるこの Mac 専用。

| 変えたもの | すること |
|---|---|
| データ（`public` の下） | 何もしない（次に開いた時から新しくなる） |
| プログラム（`src` の下） | 何もしない（アプリを開いた時に、`src` がビルドより新しければ自動でビルドし直す。十数秒） |
| アプリ（`electron/main.cjs`・アイコン）、このフォルダの場所 | `npm run app` で作り直す |

- Electron の本体は `npm install` の後処理で落ちてくる。止められて殻だけになった時は `node node_modules/electron/install.js`
- アプリの中で `127.0.0.1:47321` にサーバーを立てて開く。ピンは開発サーバー（localhost:5173）とは別に保存される

## 6. 操作方法（MVP）

| キー | 動作 |
|---|---|
| W / S | 前進 / 後退 |
| A / D | 左旋回 / 右旋回 |
| Space | 上昇 |
| Shift | 下降 |
| Esc | ポーズ / 再開 |
| 上の時刻のバー | ▶ で時間を流す・❚❚ で止める、速さ（実時間・1秒で1分・10分・1時間）を選ぶ、スライダーで時刻を変える、「今」で今の時刻に戻る（開いた時は今の時刻で止まっている。太陽は今日の日付・その時刻の高さと方位になり、夜はビルの窓に灯りがつく） |
| , / . | 時刻を 1 時間戻す / 進める |
| 右上の「ダイヤ」 | 電車の運行図（山手線のような環状の路線は円、ほかは縦の線に駅を並べ、走っている列車が外回りは外側・内回りは内側、ふつうの路線は向きごとに右・左を動く）と運行状況（走っている本数・運転間隔・始発と終電）。駅を押すと、その駅の上空へ飛び、次の発車を出す。ダイヤは各駅停車だけで、時間帯で本数が変わる |
| マウスドラッグ | 自機のまわりを見回す（離して1.5秒で後ろへ戻る） |
| マウスホイール | カメラの距離を変える |
| 右上の検索欄 | 駅名を入力して候補を選ぶと、その駅の上空へジャンプ（↑↓・Enter でも選べる） |