// SKY DRIVE の Mac アプリ（Electron）。scripts/build-mac-app.mjs が Electron.app に入れて「SKY DRIVE.app」にする。
//
// - ゲームの中身とデータはアプリに入れず、このリポジトリのフォルダ（config.json の root）から読む：
//   プログラムは dist-app（アプリ用のビルド。データはコピーしない）、データは public（建物・道路など 24GB）
// - 開いた時に src などが dist-app より新しければ、先にビルドし直す（Electron に入っている Node で vite build を走らせる）
// - 中で小さな HTTP サーバー（127.0.0.1 の決まったポート）を立てて、窓はそこを開く。
//   ポートを決めておくのは、ピンなどを保存する localStorage が URL ごとに分かれるから（毎回変わると消える）
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = require('./config.json').root;
const WEB = path.join(ROOT, 'dist-app');
const DATA = path.join(ROOT, 'public');
const PORT = 47321;
/** これらが dist-app/index.html より新しければビルドし直す */
const SOURCES = ['src', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.b3dm': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.pbf': 'application/x-protobuf',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** フォルダの中でいちばん新しいファイルの更新時刻 (ms) */
function newest(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let t = 0;
  for (const name of fs.readdirSync(file)) {
    if (name === '.DS_Store') continue;
    t = Math.max(t, newest(path.join(file, name)));
  }
  return t;
}

function needsBuild() {
  const built = newest(path.join(WEB, 'index.html'));
  if (built === 0) return true;
  return SOURCES.some((s) => newest(path.join(ROOT, s)) > built);
}

/** vite build（アプリ用：--mode app はデータを dist-app にコピーしない） */
function build() {
  return new Promise((resolve, reject) => {
    const log = [];
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'app', '--outDir', 'dist-app', '--emptyOutDir'],
      { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );
    child.stdout.on('data', (d) => log.push(String(d)));
    child.stderr.on('data', (d) => log.push(String(d)));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(log.join('').slice(-3000)))));
  });
}

/** URL のパス → ファイル（dist-app を先に、無ければ public）。フォルダの外は見ない */
function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  for (const base of [WEB, DATA]) {
    const file = path.join(base, rel);
    if (!file.startsWith(base + path.sep)) continue;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // 次の場所を見る
    }
  }
  return null;
}

function serve() {
  const server = http.createServer((req, res) => {
    const file = resolveFile(req.url ?? '/');
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const size = fs.statSync(file).size;
    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/** ビルド中に出す小さな窓 */
function splash() {
  const win = new BrowserWindow({
    width: 420,
    height: 200,
    frame: false,
    resizable: false,
    backgroundColor: '#06080d',
    show: false,
  });
  const html = `<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#06080d;color:#fff;font-family:-apple-system,'Hiragino Sans',sans-serif">
    <div style="font-size:28px;font-weight:800;letter-spacing:.1em">SKY DRIVE</div>
    <div style="color:rgba(255,255,255,.7);font-size:14px">新しいプログラムをビルドしています…</div></body>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
  return win;
}

function openMain() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    title: 'SKY DRIVE',
    backgroundColor: '#06080d',
    webPreferences: { backgroundThrottling: false },
  });
  // リンク（出典など）はいつものブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
}

// 2 つ目を開こうとしたら、開いている窓を前に出す（同じポートは使えないので）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.setName('SKY DRIVE');
  app.whenReady().then(async () => {
    if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
      dialog.showErrorBox('SKY DRIVE', `ゲームのフォルダが見つかりません：\n${ROOT}`);
      app.quit();
      return;
    }
    // ビルド中の窓は、ゲームの窓を開いてから閉じる（窓が 1 つも無くなると window-all-closed でアプリが終わるので）
    const wait = needsBuild() ? splash() : null;
    if (wait) {
      try {
        await build();
      } catch (e) {
        const hasOld = fs.existsSync(path.join(WEB, 'index.html'));
        dialog.showErrorBox(
          'SKY DRIVE：ビルドに失敗しました',
          `${hasOld ? '前にビルドしたもので開きます。\n\n' : ''}${e.message}`,
        );
        if (!hasOld) {
          app.quit();
          return;
        }
      }
    }
    try {
      await serve();
    } catch (e) {
      dialog.showErrorBox('SKY DRIVE', `サーバーを立てられませんでした（ポート ${PORT}）：\n${e.message}`);
      app.quit();
      return;
    }
    openMain();
    wait?.destroy();
  });

  app.on('window-all-closed', () => app.quit());
}
