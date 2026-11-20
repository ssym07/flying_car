// Mac アプリ「SKY DRIVE.app」を作る（Electron.app を写して、中身・アイコン・名前を入れ替える）。
// 使い方: npm run app   （作る場所を変える時は node scripts/build-mac-app.mjs 置く場所。省略すると /Applications）
//
// アプリに入れるのは electron/main.cjs とアイコンと、このフォルダの場所（config.json）だけ。
// ゲームの中身（dist-app）とデータ（public）はこのフォルダから読むので、作り直すのはアイコンや electron/main.cjs を変えた時だけ
// （src を変えた時は、アプリを開くと自動でビルドし直す）。このフォルダを動かしたら作り直す。
//
// アイコンは electron/icon.svg を、Mac に入っている qlmanage（SVG → PNG）・sips（大きさ）・iconutil（.icns）で作る。
// 署名は自分用の ad-hoc 署名（Apple シリコンの Mac は署名の無いアプリを開けないので）
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const NAME = 'SKY DRIVE';
const DEST_DIR = process.argv[2] ?? '/Applications';
const APP = path.join(DEST_DIR, `${NAME}.app`);
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
const WORK = path.join(ROOT, 'build-app');

if (!existsSync(path.join(ELECTRON, 'Contents/Frameworks'))) {
  throw new Error('Electron が入っていません（npm install のあと node node_modules/electron/install.js）');
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();

// --- アイコン（.icns） ---
rmSync(WORK, { recursive: true, force: true });
mkdirSync(path.join(WORK, 'icon.iconset'), { recursive: true });
run('qlmanage', ['-t', '-s', '1024', '-o', WORK, path.join(ROOT, 'electron/icon.svg')]);
const big = path.join(WORK, 'icon.svg.png');
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    run('sips', ['-z', String(px), String(px), big, '--out', path.join(WORK, 'icon.iconset', name)]);
  }
}
run('iconutil', ['-c', 'icns', path.join(WORK, 'icon.iconset'), '-o', path.join(WORK, 'icon.icns')]);

// --- アプリ（作業フォルダで組み立ててから置き換える） ---
const staged = path.join(WORK, `${NAME}.app`);
run('ditto', [ELECTRON, staged]);
const resources = path.join(staged, 'Contents/Resources');
rmSync(path.join(resources, 'default_app.asar'), { force: true });
mkdirSync(path.join(resources, 'app'));
cpSync(path.join(ROOT, 'electron/main.cjs'), path.join(resources, 'app/main.cjs'));
writeFileSync(
  path.join(resources, 'app/package.json'),
  JSON.stringify({ name: 'sky-drive', productName: NAME, version: '1.0.0', main: 'main.cjs' }, null, 2),
);
writeFileSync(path.join(resources, 'app/config.json'), JSON.stringify({ root: ROOT }, null, 2));
cpSync(path.join(WORK, 'icon.icns'), path.join(resources, 'electron.icns'));

const plist = path.join(staged, 'Contents/Info.plist');
const set = (key, value) => run('plutil', ['-replace', key, '-string', value, plist]);
set('CFBundleName', NAME);
set('CFBundleDisplayName', NAME);
set('CFBundleIdentifier', 'dev.skydrive.app');
set('CFBundleShortVersionString', '1.0.0');
// Electron の中の補助アプリ（GPU・描画など）は名前で探されるので、そのまま
run('codesign', ['--force', '--deep', '--sign', '-', staged]);

rmSync(APP, { recursive: true, force: true });
mkdirSync(DEST_DIR, { recursive: true });
try {
  renameSync(staged, APP);
} catch {
  // 別のディスクへは移せないので写す
  run('ditto', [staged, APP]);
}
// Finder と Dock に新しいアイコンを見せる
run('touch', [APP]);
console.log(`${APP} を作りました（ゲームのフォルダ: ${ROOT}）`);
console.log(readdirSync(path.join(APP, 'Contents/Resources/app')).join(' '));
