// 空港の搭乗橋の付け根（ターミナルから細く突き出た通路）を、PLATEAU の建物の形から探し、
// data/airports/fixed-links.json（大阪は data/kinki/airports/fixed-links.json）に書き出す。
// PLATEAU ではこの部分がターミナルと同じ高さの箱になっているので、scripts/build-station-cutouts.mjs が通路の高さだけ残して切り抜く。
// 使い方: node scripts/build-airport-fixed-links.mjs 区コード...（fetch-airports.mjs の後、build-station-cutouts.mjs の前に実行）
//   例: node scripts/build-airport-fixed-links.mjs 13111 / REGION=kinki node scripts/build-airport-fixed-links.mjs 27203
//
// 探し方：搭乗橋の根元のまわりの建物の三角形を上から見た格子（GRID m）に塗り、「開く」（OPEN m 縮めてから広げる）と
// 消える細い所のうち、根元から REACH m 以内のひとかたまりを、凸包の形にする。
// 建物は書き換える前の data/cache/plateau-original から読む（build-station-cutouts.mjs が作る）
//
// 出力の形式: [[緯度, 経度, ...（1e-6度、先頭以外は差分）], ...]
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { regionPath, SETTINGS } from './lib/region.mjs';

const require = createRequire(import.meta.url);
const draco3d = require('draco3dgltf');
const ORIGINAL = new URL('../data/cache/plateau-original/', import.meta.url);
const OUT = regionPath('data/airports/fixed-links.json');
const GRID = 1.5;
const OPEN = 8;
const REACH = 45;
/** 根元からこの距離 (m) までの三角形を見る（開く処理が端で狂わないよう、REACH より十分広く） */
const AROUND = 130;

const K = Math.PI / 180;
const MX = 111320 * Math.cos(SETTINGS.lat0 * K);
const MY = 111320;
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function toGeodetic(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 4; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    const h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [lat / K, lon / K];
}
const decoderModule = await draco3d.createDecoderModule();
function parseGlb(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen).replace(/[\0 ]+$/, ''));
  const binStart = 20 + jsonLen + 8;
  return { json, bin: glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen)) };
}
function decodeDraco(json, bin, prim) {
  const ext = prim.extensions.KHR_draco_mesh_compression;
  const view = json.bufferViews[ext.bufferView];
  const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const decoder = new decoderModule.Decoder();
  const mesh = new decoderModule.Mesh();
  const status = decoder.DecodeArrayToMesh(new Int8Array(data), data.length, mesh);
  if (!status.ok()) throw new Error(status.error_msg());
  const attr = decoder.GetAttributeByUniqueId(mesh, ext.attributes.POSITION);
  const n = mesh.num_points() * 3;
  let ptr = decoderModule._malloc(n * 4);
  decoder.GetAttributeDataArrayForAllPoints(mesh, attr, decoderModule.DT_FLOAT32, n * 4, ptr);
  const position = new Float32Array(decoderModule.HEAPF32.buffer, ptr, n).slice();
  decoderModule._free(ptr);
  const m = mesh.num_faces() * 3;
  ptr = decoderModule._malloc(m * 4);
  decoder.GetTrianglesUInt32Array(mesh, m * 4, ptr);
  const index = new Uint32Array(decoderModule.HEAPU32.buffer, ptr, m).slice();
  decoderModule._free(ptr);
  decoderModule.destroy(mesh);
  decoderModule.destroy(decoder);
  return { position, index };
}
const decode = (c) => {
  const out = [];
  let a = 0;
  let b = 0;
  for (let i = 0; i < c.length; i += 2) (a += c[i]), (b += c[i + 1]), out.push([a / 1e6, b / 1e6]);
  return out;
};
const q = (v) => Math.round(v * 1e6);
const encode = (pts) => {
  const out = [];
  let plat = 0;
  let plon = 0;
  for (const [lat, lon] of pts) out.push(q(lat) - plat, q(lon) - plon), (plat = q(lat)), (plon = q(lon));
  return out;
};
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  return half(pts).concat(half([...pts].reverse()));
}

const airports = JSON.parse(await readFile(regionPath('public/airports.json'), 'utf8'));
const roots = (airports.j ?? []).map((c) => decode(c)[0]).map(([lat, lon]) => [lon * MX, lat * MY]);
if (roots.length === 0) throw new Error('搭乗橋がありません（先に fetch-airports.mjs）');
const near = (x, y, r) => roots.some(([rx, ry]) => Math.hypot(x - rx, y - ry) < r);

// ---- 根元のまわりの三角形（上から見た 2D） ----
const tris = [];
const files = [];
async function walk(d) {
  for (const f of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (f.isDirectory()) await walk(new URL(`${f.name}/`, d));
    else if (/\.(b3dm|glb)$/.test(f.name)) files.push(new URL(f.name, d));
  }
}
for (const ward of process.argv.slice(2)) await walk(new URL(`${ward}/`, ORIGINAL));
for (const file of files) {
  const buf = await readFile(file);
  let glb = buf;
  let origin = [0, 0, 0];
  if (buf.toString('ascii', 0, 4) === 'b3dm') {
    const ftJson = buf.readUInt32LE(12);
    const ftBin = buf.readUInt32LE(16);
    const btJson = buf.readUInt32LE(20);
    const btBin = buf.readUInt32LE(24);
    const ft = JSON.parse(buf.toString('utf8', 28, 28 + ftJson).trim() || '{}');
    glb = buf.subarray(28 + ftJson + ftBin + btJson + btBin);
    origin = parseGlb(glb).json.extensions?.CESIUM_RTC?.center ?? ft.RTC_CENTER ?? [0, 0, 0];
  }
  const { json, bin } = parseGlb(glb);
  const prim = json.meshes[0].primitives[0];
  if (!prim.extensions?.KHR_draco_mesh_compression) continue;
  const t = (json.nodes.find((x) => x.mesh === 0) ?? {}).translation ?? [0, 0, 0];
  const { position, index } = decodeDraco(json, bin, prim);
  const xy = new Float64Array((position.length / 3) * 2);
  for (let i = 0; i < position.length / 3; i++) {
    const [lat, lon] = toGeodetic(
      origin[0] + t[0] + position[i * 3],
      origin[1] - (t[2] + position[i * 3 + 2]),
      origin[2] + t[1] + position[i * 3 + 1],
    );
    xy[i * 2] = lon * MX;
    xy[i * 2 + 1] = lat * MY;
  }
  for (let k = 0; k < index.length; k += 3) {
    const [a, b, c] = [index[k], index[k + 1], index[k + 2]];
    const cx = (xy[a * 2] + xy[b * 2] + xy[c * 2]) / 3;
    const cy = (xy[a * 2 + 1] + xy[b * 2 + 1] + xy[c * 2 + 1]) / 3;
    if (!near(cx, cy, AROUND)) continue;
    tris.push([xy[a * 2], xy[a * 2 + 1], xy[b * 2], xy[b * 2 + 1], xy[c * 2], xy[c * 2 + 1]]);
  }
}
console.log(`${files.length} tiles, ${tris.length} triangles near ${roots.length} jet bridges`);

// ---- 格子に塗る（根元ごとの正方形の範囲だけ。まとめて1枚の格子） ----
const xs = roots.map((r) => r[0]);
const ys = roots.map((r) => r[1]);
const x0 = Math.min(...xs) - AROUND;
const y0 = Math.min(...ys) - AROUND;
const W = Math.ceil((Math.max(...xs) + AROUND - x0) / GRID);
const H = Math.ceil((Math.max(...ys) + AROUND - y0) / GRID);
const inside = new Uint8Array(W * H);
for (const [ax, ay, bx, by, cx, cy] of tris) {
  const minC = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / GRID));
  const maxC = Math.min(W - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / GRID));
  const minR = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / GRID));
  const maxR = Math.min(H - 1, Math.ceil((Math.max(ay, by, cy) - y0) / GRID));
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-6) continue; // 壁（真横から見た三角形）は上から見ると線
  for (let r = minR; r <= maxR; r++) {
    const py = y0 + (r + 0.5) * GRID;
    for (let c = minC; c <= maxC; c++) {
      const px = x0 + (c + 0.5) * GRID;
      const w0 = (bx - px) * (cy - py) - (by - py) * (cx - px);
      const w1 = (cx - px) * (ay - py) - (cy - py) * (ax - px);
      const w2 = (ax - px) * (by - py) - (ay - py) * (bx - px);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) inside[r * W + c] = 1;
    }
  }
}
// ---- 開く：細い所が消える ----
const n = Math.round(OPEN / GRID);
const pass = (src, horizontal, max) => {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let v = max ? 0 : 1;
      for (let d = -n; d <= n && v === (max ? 0 : 1); d++) {
        const rr = horizontal ? r : r + d;
        const cc = horizontal ? c + d : c;
        const s = rr < 0 || cc < 0 || rr >= H || cc >= W ? 0 : src[rr * W + cc];
        if (max ? s : !s) v = max ? 1 : 0;
      }
      out[r * W + c] = v;
    }
  }
  return out;
};
const opened = pass(pass(pass(pass(inside, true, false), false, false), true, true), false, true);
const keep = new Uint8Array(W * H);
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    if (inside[r * W + c] && !opened[r * W + c] && near(x0 + (c + 0.5) * GRID, y0 + (r + 0.5) * GRID, REACH)) keep[r * W + c] = 1;
  }
}
// ---- ひとかたまり（斜めもつながり）ごとの凸包 ----
const out = [];
const seen = new Uint8Array(W * H);
for (let start = 0; start < W * H; start++) {
  if (!keep[start] || seen[start]) continue;
  const corners = [];
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  while (stack.length > 0) {
    const p = stack.pop();
    count++;
    const r = Math.floor(p / W);
    const c = p % W;
    for (const [dr, dc] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      corners.push([x0 + (c + dc) * GRID, y0 + (r + dr) * GRID]);
    }
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const qq = rr * W + cc;
        if (keep[qq] && !seen[qq]) (seen[qq] = 1), stack.push(qq);
      }
    }
  }
  if (count < 4) continue; // 小さなかけら（角の凹凸）は無視
  out.push(encode(convexHull(corners).map(([x, y]) => [y / MY, x / MX])));
}
await mkdir(new URL('./', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`${out.length} fixed links → ${OUT.pathname}`);
