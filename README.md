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
TitleScene ──▶ LoadingScene ──▶ FlightScene ⇄ PauseScene
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

### 現在使っているデータ（東京23区）
| レイヤー | 出典 | 備考 |
|---|---|---|
| 建物 | PLATEAU 建築物モデル（2025） | 全区とも軽い LOD1（台東区のみテクスチャ無し LOD2）に、手続き的に描いた外壁テンプレート（`src/world/facade.ts`）を貼る。建物の高さで高層／中層／低層のテンプレートを選ぶ。URL は `src/data/wards.ts` |
| 道路 | OpenStreetMap の道路中心線（`public/roads/15/{x}/{y}.json`） | 種別・車線数からテンプレート（路面標示・歩道・横断歩道）で作り、地形に沿わせる（`src/world/RoadNetwork.ts`、`roadTemplates.ts`）。`node scripts/fetch-road-network.mjs` で作り直せる（23区全体で約2時間） |
| 地形 | 国土地理院 標高タイル（5mメッシュ）＋ 全国最新写真 | カメラの周り約3.5kmだけ読み、離れたら捨てる。標高にジオイド高を足して楕円体高に合わせる |
| 海・川 | 国土地理院 淡色地図（水域は #bed2ff の1色） | 水色の画素を水域とし、岸からの距離で浅い青緑〜深い青に塗り分け、さざ波と空の映り込みを付ける（`src/world/water.ts`、設定は `WATER`） |
| 橋 | OpenStreetMap の道路データの橋の区間 | 地形に沿わせず両岸を結ぶ橋桁にし、桁・欄干・橋脚を付ける。「〜橋」や長い橋で水の上のものには鋼のアーチ（`RoadNetwork.ts`、設定は `BRIDGES`）。水域の地形は水面の高さまで下げている |
| 駅の屋根 | OpenStreetMap の駅舎・上屋（`public/station-roofs/15/{x}/{y}.json`） | 駅から300m以内の屋根を、白・銀・薄緑・青緑の金属の波板屋根で描く（`StationRoofs.ts`、設定は `STATION_ROOFS`）。`node scripts/fetch-station-roofs.mjs` で作り直せる |
| 線路 | OpenStreetMap の線路（`public/railways/15/{x}/{y}.json`、地下・トンネルは除く） | 茶色い砂利の道床・枕木・2本のレールの画像を中心線に沿って貼る。高架はコンクリートの桁・低い側壁・橋脚（`RailNetwork.ts`、設定は `RAILWAYS`）。`node scripts/fetch-railways.mjs` で作り直せる |
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
```

## 6. 操作方法（MVP）

| キー | 動作 |
|---|---|
| W / S | 前進 / 後退 |
| A / D | 左旋回 / 右旋回 |
| Space | 上昇 |
| Shift | 下降 |
| Esc | ポーズ / 再開 |
| マウスドラッグ | 自機のまわりを見回す（離して1.5秒で後ろへ戻る） |
| マウスホイール | カメラの距離を変える |