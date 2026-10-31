<p align="center">
  <img src="docs/assets/cover.png" alt="FrameVelo：Code the motion. Speed the render." width="100%">
</p>

<p align="center">
  <a href="https://github.com/gnipbao/framevelo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/gnipbao/framevelo/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
  <img alt="macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-555">
  <a href="#ai-エージェントから使う"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-7c5cff"></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>日本語</b></p>

**FrameVelo** は、コードで作る動画のためのレンダリング高速化ツールです。[HyperFrames](https://github.com/heygen-com/hyperframes) プロジェクト、[Remotion](https://www.remotion.dev) プロジェクト、時間の純粋関数として描かれる HTML/CSS/GSAP・Canvas/WebGL ページを MP4 にレンダリングし、時間・CPU・メモリをハードウェアが許す限り抑えます。

多くのコード動画レンダラーは、フレームごとにスクリーンショットを撮り、base64 で Node に送り、FFmpeg で再デコードし、CPU で YUV に変換してから x264 でエンコードします。FrameVelo はフレームを GPU 上に置いたまま処理します。

```
seek(t) ─► drawElementImage（DOM）/ canvas ─► VideoFrame ─► WebCodecs VideoEncoder（ハードウェア）
        ─► H.264 / HEVC ─► ストリームコピーで多重化 + 音声 ─► 検証済み MP4
```

## 特長

- 10 秒の GSAP コンポジションで、**`hyperframes render` より 4K で 3.8 倍、1080p で 2.0 倍高速**。4K では CPU 時間が 19 分の 1、ピークメモリが 76% 少なくなります。
- **同じフレーム。** HyperFrames 公式の回帰テスト用プロジェクト 24 件のうち 23 件が、公式レンダリングと 40 dB 以上の PSNR で一致します。合計で 1.6 倍高速、CPU は 2.1 分の 1、ピークメモリは 49% 少なくなります。
- **HyperFrames は公式パイプラインで処理。** フォント、サブコンポジション、クリップの表示区間、`<video>` フレーム、シェーダートランジション、音声ミックスは `@hyperframes/producer` が担当し、FrameVelo はキャプチャとエンコードだけを置き換えます。
- **Remotion プロジェクトにも対応。** 同じプロジェクトで `remotion render` と比べると、CPU 時間は 2.6〜7 分の 1、ピークメモリは 69〜84% 少なく、所要時間はほぼ同じです（0.9〜1.3 倍）。Remotion は多数のタブで JPEG のスクリーンショットを並列に撮って CPU を使い切り、FrameVelo は CPU を空けておきます。バンドル、`<OffthreadVideo>` のフレーム、音声ミックスは Remotion 自身が担当し、音声はサンプル単位で一致します。
- **確かな出力。** エンコード前に区間ごとにネイティブのスクリーンショットと照合し、差がある区間は自動的にスクリーンショットでキャプチャします。出力は ffprobe で検証してからアトミックに書き出します。
- **エージェント対応。** MCP サーバー（`framevelo mcp`）、Claude Code プラグインとスキル、シェルだけのエージェント向けの `--json` 出力を備えています。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/bench-gsap-dark.svg">
  <img alt="10 秒の GSAP コンポジションを 1080p と 4K でレンダリングしたときの実時間、CPU 時間、ピークメモリ：hyperframes render、hyperframes render --gpu、FrameVelo" src="docs/assets/bench-gsap-light.svg" width="100%">
</picture>

測定環境：Apple M3 Pro（11 コア、18 GB）、macOS 27.0.1、chrome-headless-shell 154、HyperFrames 0.8.186、3 回の中央値。全表、プロジェクトごとのグラフ、測定方法は [docs/benchmarks.md](docs/benchmarks.md)（英語）にあります。

## クイックスタート

```bash
npm install -g github:gnipbao/framevelo @hyperframes/producer@0.8 @hyperframes/engine@0.8
```

```bash
framevelo browser install
```

```bash
framevelo render my-hyperframes-project/ -o film.mp4
```

FrameVelo はまだ npm に公開していないため、GitHub からインストールします。HyperFrames パッケージは HyperFrames プロジェクトをレンダリングするときだけ必要です。`framevelo browser install` は `chrome-headless-shell` をダウンロードします。通常の Chrome に比べて CPU とメモリはおよそ半分です。`framevelo doctor` はブラウザ、`drawElementImage`、ハードウェアエンコーダー、FFmpeg、HyperFrames を確認します。

ほかの例（入力は `.html` ファイル、または `index.html` を含むディレクトリ）：

```bash
framevelo render examples/dom-cards -o dom-cards.mp4 --scale 2
```

```bash
framevelo render examples/canvas-particles -o particles.mp4 --codec hevc --subframes 3
```

**動作環境：** macOS または Windows、Node.js 22.18 以上、`PATH` 上の FFmpeg と FFprobe、Chrome 151 以上（`chrome-headless-shell` 推奨）。上の数値はすべて Apple シリコンの macOS で測定しています。Windows では CI で同じ統合テストを実行しています。GPU にエンコーダーがあれば H.264 をハードウェアで、なければ Chrome のソフトウェアエンコーダーでエンコードします。HEVC にはハードウェアエンコーダーが必要です。Linux ではユニットテストのみ実行しています。Remotion プロジェクトは、プロジェクト自身の依存関係をインストールしておく必要があります（`npm install`）。

## レンダリングできるもの

### HyperFrames プロジェクト

ルート要素に `data-composition-id` があるページは公式の HyperFrames パイプラインでコンパイル・配信されるため、`hyperframes render` と同じ結果になります。普通のページとしてレンダリングするには `--no-hyperframes` を付けます。

### Remotion プロジェクト

Remotion プロジェクト（ディレクトリまたはエントリファイル）を指定し、コンポジションを選びます。

```bash
framevelo render my-remotion-project/ --composition MyComp -o out.mp4 --props '{"title":"Hello"}'
```

Remotion に関わる部分はプロジェクト自身の Remotion が担当します。CLI がプロジェクトをバンドルし（`remotion.config.ts` も適用されます）、レンダラーがバンドルと `<OffthreadVideo>` のフレームを配信し、ミキサーが各フレームで再生されるものから音声を作ります。FrameVelo はコンポジションをマウントし（`calculateMetadata()` と解決済みの props を含む）、1 フレームずつ駆動して、キャプチャとエンコードだけを置き換えます。プロジェクトの依存関係はあらかじめインストールしておいてください。対応は Remotion 4 です（4.0.539 で検証）。Remotion はフレーム単位でレンダリングするため `--subframes` は効きません。モーションブラーはコンポジション内の `<CameraMotionBlur>` を使ってください。FrameVelo は HD 映像の色規格である BT.709 で出力してタグも付けます。`remotion render` は既定で BT.601 で変換するため、`--color-space=bt709` を付けると両者の色が一致します。プロジェクトには通常どおり Remotion のライセンスが適用されます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/bench-remotion-dark.svg">
  <img alt="Remotion プロジェクトを remotion render と FrameVelo でレンダリングしたときの実時間、CPU 時間、ピークメモリ" src="docs/assets/bench-remotion-light.svg" width="100%">
</picture>

### シーク可能な任意のページ

すべてのフレームが時間の純粋関数である必要があります。FrameVelo は次の順に時間の駆動方法を探します。

1. `window.__framevelo = { seek(t), duration, fps, audio }`（`seek` は Promise を返してもかまいません。`audio` は多重化するサウンドトラックの URL です）
2. `window.__seek(t)`（`window.__duration` は任意）
3. `window.__timelines.main`（または最初のキー）に登録された一時停止中の GSAP タイムライン

```html
<canvas id="scene" width="1920" height="1080"></canvas>
<script>
  const g = document.getElementById("scene").getContext("2d");
  function draw(t) {
    g.fillStyle = "#05060a";
    g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = "#6cf";
    g.fillRect(200 + 300 * t, 500, 120, 120);
  }
  window.__framevelo = { duration: 4, seek: draw };
</script>
```

動画素材は `<video data-start="0.5">` でコンポジションの時間軸に置けます（`data-media-start`、`data-duration`、`data-playback-rate` は任意）。FrameVelo はフレーム単位で正確にシークし、キーフレーム間隔が長いソースにはキャッシュされる全フレームイントラのプロキシを作るので、シークごとに 1 フレームだけデコードします。`Math.random` は固定シードなので、レンダリング結果は再現します。`requestAnimationFrame` のループ、CSS トランジション、実時間に依存するアニメーションはシークできません。上の[カバー画像](docs/assets/cover.html)もこうしたページで、`framevelo render docs/assets/cover.html` で 4 秒のクリップになります。

## AI エージェントから使う

`framevelo mcp` は `render`、`doctor`、`install_browser` の 3 つのツールを持つ MCP サーバーです。[スキル](plugin/skills/framevelo/SKILL.md)がエージェントに手順を教えます：まず短い区間をプレビューし、本番をレンダリングし、結果を確認し、失敗を種類ごとに直す。

**Claude Code** — プラグインにサーバーとスキルが含まれます。

```
/plugin marketplace add gnipbao/framevelo
/plugin install framevelo@framevelo
```

インストール済みの `framevelo` があればそれを使い、なければ初回起動時に `~/.cache/framevelo` へインストールします（約 1 分。以降の起動は 1 秒未満）。インストール中に Claude Code が待ちきれなかった場合は、完了後に `/mcp` で再接続してください。

**Codex、Cursor、Claude Desktop などの MCP クライアント** — クイックスタートの手順で一度インストールしてから、サーバーを登録します。

```json
{ "mcpServers": { "framevelo": { "command": "framevelo", "args": ["mcp"] } } }
```

```toml
# ~/.codex/config.toml
[mcp_servers.framevelo]
command = "framevelo"
args = ["mcp"]
```

`render` は CLI と同じオプションを JSON で受け取り（`input`、`output`、`frames`、`start`、`quality`、`scale`、Remotion 用の `composition` と `props` など）、進捗を通知し、キャンセルでき、一度に 1 件ずつ実行して、出力パス、フレーム数、サイズ、所要時間、警告を返します。**シェルだけのエージェント：** `framevelo render <input> -o out.mp4 --json -q` は結果を JSON で出力し、失敗時は `{"error": "..."}` を出力して終了コード 1 で終わります。

## 仕組み

- **Canvas ページ**：`<canvas>` そのものがフレームです。
- **DOM ページ**：キャプチャ対象の要素を `<canvas layoutsubtree>` に移し、`drawElementImage` で描画します。キャンバスのバッキングストアは出力サイズなので、`--scale 2` は 1080p のレイアウトを 4K で再ラスタライズします。
- **検証**：エンコード前に、各区間（クリップの境界で区切る）のサンプルフレームを両方の方法で描き、ネイティブのスクリーンショットと比べます。`--verify-threshold`（30 dB）を下回る区間はスクリーンショットでキャプチャし、同じエンコーダーに渡します。
- **描画の再利用**：見た目が何も変わらないフレームは前の描画を再利用します。有効・無効で出力はバイト単位で一致します。
- **ページの並列化**：Node が 1 フレームずつ駆動するフレーム（HyperFrames の動画フレーム、スクリーンショット区間）は往復の待ち時間で律速されるため、長い区間を複数のページに分け、それぞれのエンコーダーで処理してから連結します。
- **出力**：WebCodecs がハードウェアエンコーダーでエンコードし、FFmpeg はストリームと音声を MP4 にコピーして BT.709 のタグを付けるだけです。一時ファイルに書き出して ffprobe で検証してから名前を変えるので、失敗したレンダリングは何も残しません。

設計の詳細と、測定したうえで採用しなかった案：[docs/architecture.md](docs/architecture.md)（英語）。

## CLI

```
framevelo render <input> [options]
framevelo doctor
framevelo browser install [version] | framevelo browser path
framevelo mcp
```

| オプション | 既定値 | 説明 |
|---|---|---|
| `-o, --output <file>` | `<入力名>.mp4` | 出力 MP4 |
| `--fps <n>` | ページの fps、なければ 30 | フレームレート。整数と NTSC レート（29.97、59.94） |
| `--duration <s>`、`--frames <n>` | ページの長さ | レンダリングする長さ |
| `--start <s>` | 0 | 最初のフレームの時刻。音声もこれに合わせてずらします |
| `--width`、`--height <px>`、`--scale <n>` | キャプチャしたサイズ | 出力サイズ |
| `--viewport <WxH>` | ページの指定、なければ 1920x1080 | CSS ビューポート |
| `--mode <m>` | `auto` | `auto`、`canvas`、`dom` |
| `--selector <css>` | | キャプチャする要素または canvas |
| `--capture <c>` | `auto` | DOM ページ：`auto`（検証して区間ごとにフォールバック）、`dom`、`screenshot` |
| `--verify-threshold <dB>` | 30 | 区間をスクリーンショットに切り替える検証 PSNR |
| `--codec <c>` | `h264` | `h264` または `hevc` |
| `--quality <q>` | `standard` | `draft`、`standard`（x264 CRF 18 相当）、`high` |
| `--bitrate <b>` | サイズ・fps・画質から算出 | 目標ビットレート（例：`12M`） |
| `--audio <file>` | コンポジションの音声 | 音声トラック |
| `--subframes <n>`、`--shutter <f>` | 1、0.5 | GPU 上でサブフレームを平均してモーションブラー |
| `--background <css>` | ページの背景 | 透明な DOM の背後の色 |
| `--mount <prefix>=<dir>` | | 別のディレクトリを配信（例：`/vendor/=./vendor`） |
| `--workers <n>` | CPU コア数から決定 | Node 駆動のフレームに使う最大ページ数。`1` で並列化を無効化 |
| `--no-hyperframes` | | HyperFrames プロジェクトを普通のページとしてレンダリング |
| `--composition <id>` | 唯一のもの | Remotion プロジェクト：レンダリングするコンポジション |
| `--props <json\|file>` | 既定の props | Remotion プロジェクト：入力 props（インライン JSON または `.json` ファイル） |
| `--no-paint-reuse` | | 毎フレーム描き直す |
| `--no-video-proxy` | | 動画ソースをそのままシーク |
| `--chrome <path>` | headless shell、次に Chrome | ブラウザの実行ファイル |
| `--json`、`-q, --quiet` | | 結果を JSON で出力。進捗を表示しない |

## API

```js
import { render } from "framevelo";

const result = await render({ input: "examples/dom-cards", output: "dom-cards.mp4", scale: 2 });
console.log(result.wallMs, result.stages, result.warnings);
```

`onProgress(done, total)` がフレームの進捗を報告し、`signal` に渡した `AbortSignal` でファイルを残さずに中止できます。

## 制限事項

- `drawElementImage` は Origin Trial の API（Chrome 160 まで）で、Chrome 155 で形が変わりました。検証で退行は防げますが、Chrome を更新したら `node bench/parity.ts` で確認してください。
- 動画中心の HyperFrames プロジェクトは、モーショングラフィックスほど速くなりません。新しい動画フレームごとにレンダリング更新が 1 回かかり、ページの並列化はその待ち時間を重ねる代わりにメモリを多く使います。
- Remotion 対応は、Remotion 内部の Remotion 4 レンダリングページのプロトコルに従っています。別のバージョンのプロトコルを話すバンドルは、誤った映像を出す代わりに明確なエラーで拒否します。`<OffthreadVideo>` のフレームは、引き続き 1 フレームごとに Remotion のフレームサーバーから取得します。
- ハードウェアエンコーダーはほかのアプリと共有されるため、画面収録やビデオ通話があるとエンコードが遅くなります。また同じ画質で x264 より多くのビットを必要とするため、ファイルは大きくなります。

## 開発

```bash
npm install
npm test
npm run test:integration
```

`npm test` はユニットテストと MCP プロトコルのテスト、`npm run test:integration` は Chrome と FFmpeg でサンプルをレンダリングします。`node bench/run.ts` と `node bench/report.ts` でベンチマークを再現できます（[bench/README.md](bench/README.md)）。ソースは Node の TypeScript 型ストリッピングでそのまま動き、`npm run build` で `dist/` を生成します。コーディングエージェントは [AGENTS.md](AGENTS.md) を参照してください。最初の実現可能性調査（中国語）は [docs/research-render-acceleration.md](docs/research-render-acceleration.md) にあります。

## ライセンス

[Apache-2.0](LICENSE)。一部は HyperFrames から移植しています。[NOTICE](NOTICE) を参照してください。
