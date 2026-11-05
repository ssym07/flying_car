// ホーム画面の背景の、点で描く日本列島。国土地理院の淡色地図（ズーム 7）の水色でない所を、格子の点にする
// 出力: src/data/japanDots.json  { s, w, e, n, step, cols, rows, dots: [[列, 行], ...] }（行 0 が北）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodePng } from './lib/dem.mjs';

const ZOOM = 7;
const CACHE = new URL('../data/cache/pale/', import.meta.url);
const OUT = new URL('../src/data/japanDots.json', import.meta.url);
// 北海道から屋久島・種子島まで（沖縄は入れない）
const [S, W, N, E] = [30.2, 128.6, 45.7, 146.0];
/** 点の間隔（緯度の度）。経度は cos(36°) で割って、画面で縦横同じ間隔にする */
const STEP = 0.18;
const LAT0 = 36;

const K = Math.PI / 180;
const n = 2 ** ZOOM;
const tileX = (lon) => ((lon + 180) / 360) * n;
const tileY = (lat) => ((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n;

const tiles = new Map();
await mkdir(CACHE, { recursive: true });
for (let x = Math.floor(tileX(W)); x <= Math.floor(tileX(E)); x++) {
  for (let y = Math.floor(tileY(N)); y <= Math.floor(tileY(S)); y++) {
    const file = new URL(`${ZOOM}-${x}-${y}.png`, CACHE);
    let buf = await readFile(file).catch(() => null);
    if (!buf) {
      const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/pale/${ZOOM}/${x}/${y}.png`).catch(() => null);
      if (res?.ok) {
        buf = Buffer.from(await res.arrayBuffer());
        await writeFile(file, buf);
      }
    }
    tiles.set(`${x}/${y}`, buf ? decodePng(buf) : null);
  }
}
// 淡色地図の水色（scripts/build-route-map-sea.mjs と同じ）。タイルの無い所（外国・海）は水
const isWater = (r, g, b) => b > 0xf0 && r < 0xd0 && g < 0xe2 && g > r && b - r > 40;
const landAt = (lat, lon) => {
  const fx = tileX(lon);
  const fy = tileY(lat);
  const t = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
  if (!t) return false;
  const k = (Math.min(255, Math.floor((fy % 1) * 256)) * 256 + Math.min(255, Math.floor((fx % 1) * 256))) * 3;
  return !isWater(t[k], t[k + 1], t[k + 2]) && !abroad(lat, lon);
};
// 淡色地図は外国の陸も白く描くので、朝鮮半島（対馬は残す）と沿海州を外す
const abroad = (lat, lon) => lon < 129.15 || (lat > 34.75 && lon < 129.7) || (lat > 40.5 && lon < 139.3);

const lonStep = STEP / Math.cos(LAT0 * K);
const cols = Math.ceil((E - W) / lonStep);
const rows = Math.ceil((N - S) / STEP);
const dots = [];
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    // 升の中の 3×3 点のうち、陸が 3 つ以上なら点を置く（細い半島・小さな島も少し残す）
    let land = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (landAt(N - (row + (i + 0.5) / 3) * STEP, W + (col + (j + 0.5) / 3) * lonStep)) land++;
      }
    }
    if (land >= 3) dots.push([col, row]);
  }
}
// 周りに点の無い1つだけの点は外す（海の上の地名の文字などを陸と見てしまうため）
const has = new Set(dots.map(([c, r]) => `${c},${r}`));
const lonely = ([c, r]) => ![-1, 0, 1].some((dc) => [-1, 0, 1].some((dr) => (dc || dr) && has.has(`${c + dc},${r + dr}`)));
dots.splice(0, dots.length, ...dots.filter((d) => !lonely(d)));
await writeFile(OUT, JSON.stringify({ s: S, w: W, e: E, n: N, step: STEP, lonStep: +lonStep.toFixed(5), cols, rows, dots }));
console.log(`${cols}×${rows} → ${dots.length} dots → ${OUT.pathname}`);
