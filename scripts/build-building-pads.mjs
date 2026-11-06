// 建物の敷地の地図（地形チャンクごとの PNG）を作る。
// 坂では PLATEAU の建物（LOD1）の底が敷地のいちばん低い地面の高さで平らなので、なめらかな地形の斜面が坂の上側の1階を覆う。
// アプリは地形を作る時、この地図の建物の底より上に地面が出ないよう下げ、実際の造成地のように家ごとの平らな段にする。
//
// 使い方: REGION=fukuoka node scripts/build-building-pads.mjs [市区町村コード ...]   （省略するとその地域の手元にある区すべて）
// 入力: public/plateau/{市区町村コード}/（build-local-buildings・build-gsi-buildings が書いたもの）の末端のタイル
// 出力: public/{地域}/pads/15/{x}/{y}.png。国土地理院の標高 PNG と同じ形式（標高 = RGB の 24bit × 0.01m、建物の無い所は (128,0,0)）
//
// 建物の形：建物の各三角形（壁以外）を真上から見た形を塗る（屋根も底も足元の形の中にある）。値はその建物の一番低い点の高さ。
// 国土地理院から作った建物は、斜面で浮かないよう底を SINK m 沈めてあるので、その分を戻す。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { GEOID } from './lib/dem.mjs';
import { SETTINGS, regionPath } from './lib/region.mjs';

const require = createRequire(import.meta.url);
const draco = await require('draco3dgltf').createDecoderModule();

const PLATEAU = new URL('../public/plateau/', import.meta.url);
const OUT = regionPath('public/pads/15/');
const ZOOM = 15;
const PX = 256;
/** build-gsi-buildings.mjs の SINK と同じ */
const GSI_SINK = 1.5;

const local = JSON.parse(await readFile(new URL('wards.json', PLATEAU), 'utf8'));
const wardsTs = await readFile(new URL('../src/data/wards.ts', import.meta.url), 'utf8');
/** 国土地理院から作った市（wards.ts で url が空） */
const gsi = new Set([...wardsTs.matchAll(/code: '(\d+)'[^\n]*url: ''/g)].map((m) => m[1]));
const codes = process.argv.length > 2 ? process.argv.slice(2) : local.filter((c) => SETTINGS.prefectures.some((p) => c.startsWith(p)));

const K = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
/** ECEF → [緯度, 経度, 楕円体高] */
function toLatLonH(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let n = A;
  for (let i = 0; i < 6; i++) {
    n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + E2 * n * Math.sin(lat), p);
  }
  return [lat / K, lon / K, p / Math.cos(lat) - n];
}

/** 緯度経度 → ズーム15のタイルの中のピクセル（全体の通し番号） */
const N = 2 ** ZOOM * PX;
const toPx = (lat, lon) => [
  ((lon + 180) / 360) * N,
  ((1 - Math.log(Math.tan(lat * K) + 1 / Math.cos(lat * K)) / Math.PI) / 2) * N,
];

/** タイル "x/y" → 各ピクセルの建物の底の一番低い高さ（ジオイド基準。無い所は Infinity） */
const tiles = new Map();
function plot(gx, gy, h) {
  const tx = Math.floor(gx / PX);
  const ty = Math.floor(gy / PX);
  const k = `${tx}/${ty}`;
  let t = tiles.get(k);
  if (!t) tiles.set(k, (t = new Float32Array(PX * PX).fill(Infinity)));
  const i = (gy - ty * PX) * PX + (gx - tx * PX);
  if (h < t[i]) t[i] = h;
}

/** 三角形（ピクセル座標）の中にピクセルの中心が入るピクセルと、頂点のピクセルを塗る */
function fillTriangle(a, b, c, h) {
  for (const p of [a, b, c]) plot(Math.floor(p[0]), Math.floor(p[1]), h);
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area) < 1e-6) return;
  const x0 = Math.floor(Math.min(a[0], b[0], c[0]));
  const x1 = Math.ceil(Math.max(a[0], b[0], c[0]));
  const y0 = Math.floor(Math.min(a[1], b[1], c[1]));
  const y1 = Math.ceil(Math.max(a[1], b[1], c[1]));
  const edge = (p, q, x, y) => ((q[0] - p[0]) * (y - p[1]) - (x - p[0]) * (q[1] - p[1])) * Math.sign(area);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      if (edge(a, b, cx, cy) >= 0 && edge(b, c, cx, cy) >= 0 && edge(c, a, cx, cy) >= 0) plot(x, y, h);
    }
  }
}

/** b3dm 1つの建物の三角形を塗る */
function readB3dm(buf, sink) {
  // 3D Tiles 1.1 の区（台東区など）はタイルが b3dm ではなく glb そのもの
  const isGlb = buf.toString('ascii', 0, 4) === 'glTF';
  const ftj = isGlb ? 0 : buf.readUInt32LE(12);
  const ftb = isGlb ? 0 : buf.readUInt32LE(16);
  const btj = isGlb ? 0 : buf.readUInt32LE(20);
  const btb = isGlb ? 0 : buf.readUInt32LE(24);
  const ft = ftj > 0 ? JSON.parse(buf.toString('utf8', 28, 28 + ftj)) : {};
  const glb = isGlb ? buf : buf.subarray(28 + ftj + ftb + btj + btb);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  const bin = glb.subarray(20 + jsonLength + 8);
  const rtc = json.extensions?.CESIUM_RTC?.center ?? ft.RTC_CENTER ?? [0, 0, 0];
  const t = json.nodes?.[0]?.translation ?? [0, 0, 0];

  const accessor = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const n = a.count * size;
    const b = Buffer.from(bin.subarray(off, off + n * T.BYTES_PER_ELEMENT));
    return new T(b.buffer, b.byteOffset, n);
  };

  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      let pos;
      let ids;
      let index;
      const ext = prim.extensions?.KHR_draco_mesh_compression;
      if (ext) {
        const v = json.bufferViews[ext.bufferView];
        const data = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
        const decoder = new draco.Decoder();
        const dm = new draco.Mesh();
        decoder.DecodeArrayToMesh(new Int8Array(data), data.length, dm);
        const read = (name, size) => {
          const att = decoder.GetAttributeByUniqueId(dm, ext.attributes[name]);
          const n = dm.num_points() * size;
          const p = draco._malloc(n * 4);
          decoder.GetAttributeDataArrayForAllPoints(dm, att, draco.DT_FLOAT32, n * 4, p);
          const out = new Float32Array(draco.HEAPF32.buffer, p, n).slice();
          draco._free(p);
          return out;
        };
        pos = read('POSITION', 3);
        ids = read(ext.attributes._BATCHID !== undefined ? '_BATCHID' : '_FEATURE_ID_0', 1);
        const faces = dm.num_faces() * 3;
        const p = draco._malloc(faces * 4);
        decoder.GetTrianglesUInt32Array(dm, faces * 4, p);
        index = new Uint32Array(draco.HEAPU32.buffer, p, faces).slice();
        draco._free(p);
        draco.destroy(dm);
        draco.destroy(decoder);
      } else {
        pos = accessor(prim.attributes.POSITION);
        ids = accessor(prim.attributes._BATCHID ?? prim.attributes._FEATURE_ID_0);
        index = prim.indices !== undefined ? accessor(prim.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      }

      const count = pos.length / 3;
      const px = new Float64Array(count * 2);
      const hs = new Float64Array(count);
      /** 建物ごとの一番低い点 */
      const low = new Map();
      for (let i = 0; i < count; i++) {
        const [lat, lon, h] = toLatLonH(
          rtc[0] + t[0] + pos[i * 3],
          rtc[1] - (t[2] + pos[i * 3 + 2]),
          rtc[2] + t[1] + pos[i * 3 + 1],
        );
        const [x, y] = toPx(lat, lon);
        px[i * 2] = x;
        px[i * 2 + 1] = y;
        hs[i] = h;
        const id = ids[i];
        if (!(low.get(id) <= h)) low.set(id, h);
      }
      for (let i = 0; i < index.length; i += 3) {
        const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
        const base = low.get(ids[a]) - GEOID + sink;
        fillTriangle([px[a * 2], px[a * 2 + 1]], [px[b * 2], px[b * 2 + 1]], [px[c * 2], px[c * 2 + 1]], base);
      }
    }
  }
}

/** タイルセットの末端（子の無い）コンテンツの URI */
function leaves(node, out = []) {
  const kids = (node.children ?? []).filter((c) => c.content || c.children);
  if (kids.length === 0) {
    if (node.content?.uri) out.push(node.content.uri);
  } else kids.forEach((c) => leaves(c, out));
  return out;
}

for (const code of codes) {
  const dir = new URL(`${code}/`, PLATEAU);
  const tileset = JSON.parse(await readFile(new URL('tileset.json', dir), 'utf8'));
  const uris = leaves(tileset.root);
  const sink = gsi.has(code) ? GSI_SINK : 0;
  for (const uri of uris) readB3dm(await readFile(new URL(uri, dir)), sink);
  console.log(code, `${uris.length} tiles`, gsi.has(code) ? '(国土地理院)' : '', `→ ${tiles.size} chunks`);
}

/** RGB の PNG（フィルタなし） */
function encodePng(rgb) {
  const raw = Buffer.alloc((PX * 3 + 1) * PX);
  for (let y = 0; y < PX; y++) rgb.copy(raw, y * (PX * 3 + 1) + 1, y * PX * 3, (y + 1) * PX * 3);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PX, 0);
  ihdr.writeUInt32BE(PX, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await rm(OUT, { recursive: true, force: true });
let bytes = 0;
for (const [k, t] of tiles) {
  const rgb = Buffer.alloc(PX * PX * 3);
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(t[i])) {
      rgb[i * 3] = 128;
      continue;
    }
    let v = Math.round(t[i] * 100);
    if (v < 0) v += 2 ** 24;
    rgb[i * 3] = (v >> 16) & 255;
    rgb[i * 3 + 1] = (v >> 8) & 255;
    rgb[i * 3 + 2] = v & 255;
  }
  const [x, y] = k.split('/');
  await mkdir(new URL(`${x}/`, OUT), { recursive: true });
  const png = encodePng(rgb);
  bytes += png.length;
  await writeFile(new URL(`${x}/${y}.png`, OUT), png);
}
console.log(`${tiles.size} chunks, ${(bytes / 1e6).toFixed(1)} MB`);
