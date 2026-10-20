# Mouse on Rails 🚃

マウスでGO！ — デスクトップのマウスカーソルを**電車に乗せて運ぶ**ジョークアプリです。

ウルトラワイドモニターの端から端までカーソルを動かすのが面倒？ それなら山手線に乗せればいいじゃない。
ただし鉄道なので、**駅以外では下車できません**。ときどき遅延もします。

## ダウンロード（Windows）

[Releases](https://github.com/noppe18/mouse-on-rails/releases/latest) から以下のいずれかを取得してください。

| ファイル | 内容 |
|---------|------|
| `Mouse.on.Rails_x.y.z_x64-setup.exe` | インストーラー（おすすめ） |
| `Mouse.on.Rails_x.y.z_x64_ja-JP.msi` | MSI インストーラー |
| `mouse-on-rails-portable.exe` | インストール不要の単体実行ファイル |

※ 署名していないため、初回起動時に SmartScreen の警告が出ることがあります（「詳細情報」→「実行」）。
※ WebView2 ランタイムが必要です（Windows 10/11 には通常インストール済み）。

## 遊び方

1. 起動するとタスクトレイに常駐し、路線図が表示されます。以降は **`Ctrl+Alt+M`** で表示／非表示を切り替えます。
2. カーソルの近くの駅にマウスを合わせ、**時計回り（外回り）／反時計回り（内回り）** を選ぶと乗車します。
3. 電車が走り出すと、**本物のマウスカーソル**が電車と一緒に運ばれます。走行中にマウスを動かしても無駄です。
4. 駅に停車している間だけカーソルを動かせます。**列車からカーソルを離すと下車**、そのままにしておくと次の駅へ進みます。
5. 累計 10 回乗車するごとに新しい路線が開業（予定）します。

### 困ったときは

- 走行中でも **`Ctrl+Alt+M`** または **`Esc`** で緊急停止して、すぐにマウス操作を取り戻せます。
- アプリが応答しなくなった場合も、1.5 秒で自動的にカーソルの拘束が解除されます。
- 完全に終了するにはタスクトレイのアイコンを右クリック →「終了」。

## 設定

トレイメニューの「設定ファイルの場所を表示」で開く `settings.json` を編集し、アプリを再起動すると反映されます。

| キー | 既定値 | 内容 |
|------|--------|------|
| `hotkey` | `Ctrl+Alt+M` | 路線図表示のホットキー |
| `dwellSec` | `2.5` | 各駅の停車時間（秒） |
| `boardingSec` | `1.5` | 乗車から発車までの時間（秒） |
| `delayProbability` | `0.15` | 発車前に遅延が起きる確率（0〜1） |
| `delayMinSec` / `delayMaxSec` | `4` / `10` | 遅延時間の範囲（秒、上限 60） |
| `speedPxPerSec` | `600` | 走行速度 |
| `minSegmentSec` / `maxSegmentSec` | `1` / `3.5` | 1 駅間の所要時間の範囲（秒） |
| `volume` | `0.9` | 音量 |
| `speechFallback` | `true` | 音声ファイルが無いとき Windows の音声合成で読み上げるか |

乗車回数は同じフォルダの `progress.json` に保存されます。

## 開発

必要なもの: Node.js 22、Rust（stable）、[Tauri 2 の前提環境](https://tauri.app/start/prerequisites/)

```sh
npm install
npm run tauri dev     # 開発起動
npm test              # ドメインロジックのテスト
npm run tauri build   # インストーラー作成
```

`npm run dev` だけでもブラウザで路線図の見た目を確認できます（カーソル移動などの OS 操作は行いません）。

### 構成

```
src/
  domain/      路線形状・駅配置・乗車の状態機械・路線解放（UI/OS に依存しない純粋なロジック）
  data/        路線データ（lines/*.json）、路線カタログ、アナウンス文言
  ui/          SVG 描画、音声アナウンス、効果音
  native.ts    Rust 側コマンドとのブリッジ
  main.ts      画面とドメインをつなぐコントローラー
src-tauri/src/
  overlay.rs   オーバーレイ表示、座標変換、カーソル監視、拘束のウォッチドッグ
  storage.rs   設定と乗車記録の永続化
  platform/    OS 依存処理（win32.rs: SetCursorPos と低レベルマウスフック）
```

- **カーソルの拘束**: 走行中だけ `WH_MOUSE_LL` フックを設置し、物理マウス入力（`LLMHF_INJECTED` でないもの）を破棄します。カーソルは `SetCursorPos` で車両に追従させます。停車・下車・緊急停止・タイムアウトでフックを外します。
- **クリック透過**: 路線図表示中も、駅とポップアップの上以外ではクリックが背後のアプリに届きます。
- **路線の追加**: `src/data/lines/` に JSON を追加し、`catalog.json` の `available` を `true` にします。形状は `roundedRect` か正規化座標の `polyline` で記述できます。
- **音声**: `src/assets/audio/` に音声ファイルを置くと同梱されます。Gemini TTS で生成するには `GEMINI_API_KEY=... npm run voices`。

### リリース

`v` で始まるタグを push すると GitHub Actions が Windows 版をビルドし、Release に公開します。

```sh
git tag v0.1.0 && git push origin v0.1.0
```
