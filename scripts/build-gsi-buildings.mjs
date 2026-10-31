// PLATEAU の建物データが無い市の建物を、国土地理院のベクトルタイル（建物の形）から作る。
// public/plateau/{市区町村コード}/ に PLATEAU と同じ形式（3D Tiles 1.0 の b3dm、ズーム15のタイルごと）で書き出し、
// public/plateau/wards.json に足す（アプリはほかの区と同じように読み、外壁のテンプレートを貼る）。
// 使い方: node scripts/build-gsi-buildings.mjs 市区町村コード 市の名前 都道府県名   例: node scripts/build-gsi-buildings.mjs 12207 松戸市 千葉県
// データ: 国土地理院 ベクトルタイル「建築物の外周線」、市の境界は OpenStreetMap（Nominatim）
//
// 高さはデータに無いので、建物の種類と大きさから決める（同じ建物はいつも同じ高さ）：
// - 普通建物（3101）：2階建て前後、6〜9m
// - 堅ろう建物（3102）：鉄筋のビル・マンション。建物の面積が大きいほど高くし、10〜40m
// - 高層建物（3103）：45〜90m
// - 普通無壁舎（3111）：屋根だけの小屋・車庫、3.5m
// 線路と重なる建物（駅舎など）は除く（線路・ホームの上に建物が出ないように）
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import Pbf from 'pbf';
import { GEOID, heightAt, prepareDem } from './lib/dem.mjs';
import { regionPath } from './lib/region.mjs';

const [CODE, NAME, PREF] = process.argv.slice(2);
if (!CODE || !NAME) throw new Error('使い方: node scripts/build-gsi-buildings.mjs 市区町村コード 市の名前 都道府県名');

const PLATEAU = new URL('../public/plateau/', import.meta.url);
const OUT = new URL(`${CODE}/`, PLATEAU);
const RAIL_DIR = regionPath('public/rail-tracks/15/');
const CACHE = new URL('../data/cache/gsi-buildings/', import.meta.url);
const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/16/{x}/{y}.pbf';
/** 書き出すタイルのズーム（地形チャンクと同じ）と、読む地理院タイルのズーム */
const OUT_ZOOM = 15;
const SRC_ZOOM = 16;
/** 線路の中心線からこの距離 (m) 以内にかかる建物は除く */
const RAIL_CLEAR = 3;
/** 作り込んだ建物（src/world/landmarks）に置き換える所：[緯度, 経度, 半径 (m)]。中心がこの円に入る建物は作らない */
const LANDMARKS = [
  [35.63208, 139.88084, 30], // シンデレラ城
  [34.78555, 135.43785, 15], // 大阪国際空港の管制塔（src/world/Airports.ts）
];
/** 建物の底を地面からこれだけ沈める (m)（斜面で浮かないように） */
const SINK = 1.5;

const K = Math.PI / 180;
const MY = 111320;

// ---- 座標の変換（WGS84、scripts/build-station-cutouts.mjs と同じ） ----
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function toEcef(lat, lon, h) {
  const p = lat * K;
  const l = lon * K;
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => ((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * 2 ** z;
const lonOf = (x, z) => (x / 2 ** z) * 360 - 180;
const latOf = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / K;

// ---- 市の境界（Nominatim） ----
async function boundary() {
  const file = new URL(`boundary-${CODE}.json`, CACHE);
  let geo = await readFile(file, 'utf8').then(JSON.parse, () => null);
  if (!geo) {
    const q = encodeURIComponent(`${NAME},${PREF ?? ''}`);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&polygon_geojson=1&limit=5`, {
      headers: { 'User-Agent': 'sky-drive-dev/0.1 (gsi building script)' },
    });
    const list = await res.json();
    const hit = list.find((r) => r.class === 'boundary' && /Polygon/.test(r.geojson?.type));
    if (!hit) throw new Error(`${NAME} の境界が見つかりません`);
    geo = hit.geojson;
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(geo));
  }
  // [[lon, lat], ...] の外周のならび（穴は使わない）
  return geo.type === 'Polygon' ? [geo.coordinates[0]] : geo.coordinates.map((p) => p[0]);
}
function inside(rings, lon, lat) {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

// ---- 地理院のベクトルタイル ----
async function fetchTile(x, y) {
  const file = new URL(`${SRC_ZOOM}/${x}/${y}.pbf`, CACHE);
  let buf = await readFile(file).catch(() => null);
  if (!buf) {
    for (let attempt = 0; attempt < 4 && !buf; attempt++) {
      const res = await fetch(TILE_URL.replace('{x}', x).replace('{y}', y)).catch(() => null);
      if (res?.ok) buf = Buffer.from(await res.arrayBuffer());
      else if (res?.status === 404) buf = Buffer.alloc(0);
      else await new Promise((r) => setTimeout(r, 2000));
    }
    if (!buf) throw new Error(`タイル ${x}/${y} を取れませんでした`);
    await mkdir(new URL(`${SRC_ZOOM}/${x}/`, CACHE), { recursive: true });
    await writeFile(file, buf);
  }
  return buf;
}
/** タイルの建物：[{ code, rings: [[[lat, lon], ...], ...] }]（外周と穴） */
function decodeBuildings(buf, tx, ty) {
  if (buf.length === 0) return [];
  const pbf = new Pbf(buf);
  const layers = pbf.readFields((tag, out, p) => {
    if (tag !== 3) return;
    out.push(
      p.readMessage(
        (t, L, p) => {
          if (t === 1) L.name = p.readString();
          else if (t === 2) {
            L.features.push(
              p.readMessage(
                (ft, f, p) => {
                  if (ft === 2) f.tags = p.readPackedVarint();
                  else if (ft === 3) f.type = p.readVarint();
                  else if (ft === 4) f.geom = p.readPackedVarint();
                },
                { tags: [], type: 0, geom: [] },
              ),
            );
          } else if (t === 3) L.keys.push(p.readString());
          else if (t === 4) {
            L.values.push(
              p.readMessage((vt, v, p) => {
                v.v = vt === 1 ? p.readString() : vt === 2 ? p.readFloat() : vt === 3 ? p.readDouble() : vt === 6 ? p.readSVarint() : vt === 7 ? p.readBoolean() : p.readVarint();
              }, {}).v,
            );
          } else if (t === 5) L.extent = p.readVarint();
        },
        { name: '', features: [], keys: [], values: [], extent: 4096 },
      ),
    );
  }, []);
  const layer = layers.find((l) => l.name === 'building');
  if (!layer) return [];
  const out = [];
  for (const f of layer.features) {
    if (f.type !== 3) continue;
    let code = 0;
    for (let i = 0; i < f.tags.length; i += 2) if (layer.keys[f.tags[i]] === 'ftCode') code = layer.values[f.tags[i + 1]];
    // 図形のコマンド（MoveTo / LineTo / ClosePath）を輪に
    const rings = [];
    let x = 0;
    let y = 0;
    let ring = null;
    for (let i = 0; i < f.geom.length; ) {
      const cmd = f.geom[i] & 7;
      const count = f.geom[i] >> 3;
      i++;
      if (cmd === 7) {
        if (ring && ring.length >= 3) rings.push(ring);
        ring = null;
        continue;
      }
      for (let c = 0; c < count; c++) {
        x += (f.geom[i] >>> 1) ^ -(f.geom[i] & 1);
        y += (f.geom[i + 1] >>> 1) ^ -(f.geom[i + 1] & 1);
        i += 2;
        if (cmd === 1) ring = [];
        ring.push([latOf(ty + y / layer.extent, SRC_ZOOM), lonOf(tx + x / layer.extent, SRC_ZOOM)]);
      }
    }
    if (rings.length > 0) out.push({ code, rings });
  }
  return out;
}

// ---- 線路（建物を除くのに使う） ----
const railGrid = new Map();
const RCELL = 0.001;
for (const x of await readdir(RAIL_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
    const tile = JSON.parse(await readFile(new URL(`${x}/${f}`, RAIL_DIR), 'utf8'));
    for (const r of tile.t ?? tile) {
      const coords = Array.isArray(r[1]) ? r[1] : r[3];
      if (!Array.isArray(coords)) continue;
      let lat = 0;
      let lon = 0;
      let prev = null;
      for (let i = 0; i < coords.length; i += 2) {
        lat += coords[i];
        lon += coords[i + 1];
        const p = [lat / 1e6, lon / 1e6];
        if (prev) {
          const key = `${Math.floor(p[0] / RCELL)},${Math.floor(p[1] / RCELL)}`;
          if (!railGrid.has(key)) railGrid.set(key, []);
          railGrid.get(key).push([prev, p]);
        }
        prev = p;
      }
    }
  }
}
function nearRail(rings) {
  const MX = MY * Math.cos(rings[0][0][0] * K);
  const seen = new Set();
  const dist = ([plat, plon], [alat, alon], [blat, blon]) => {
    const ax = (alon - plon) * MX;
    const ay = (alat - plat) * MY;
    const bx = (blon - plon) * MX;
    const by = (blat - plat) * MY;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(ax + dx * t, ay + dy * t);
  };
  const outer = rings[0];
  for (const p of outer) {
    const cy = Math.floor(p[0] / RCELL);
    const cx = Math.floor(p[1] / RCELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const seg of railGrid.get(`${cy + dy},${cx + dx}`) ?? []) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          // 線路が建物の中を通る（輪の中に線路の点がある）か、建物の角が線路に近い
          if (dist(p, seg[0], seg[1]) < RAIL_CLEAR) return true;
          for (const q of seg) {
            let hit = false;
            for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
              const [yi, xi] = outer[i];
              const [yj, xj] = outer[j];
              if (yi > q[0] !== yj > q[0] && q[1] < ((xj - xi) * (q[0] - yi)) / (yj - yi) + xi) hit = !hit;
            }
            if (hit) return true;
          }
        }
      }
    }
  }
  return false;
}

// ---- 高さ ----
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
};
function areaOf(ring) {
  const MX = MY * Math.cos(ring[0][0] * K);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][1] * MX) * (ring[i][0] * MY) - (ring[i][1] * MX) * (ring[j][0] * MY);
  }
  return Math.abs(a) / 2;
}
function heightOf(code, area, seed) {
  const r = hash(seed);
  if (code === 3111) return 3.5;
  if (code === 3103) return 45 + r * 45;
  if (code === 3102) {
    // 面積が大きいほど高い（小さなビルは 3〜5 階、大きなマンションは 8〜13 階）
    const floors = Math.min(13, 3 + Math.sqrt(area) / 6 + r * 4);
    return Math.max(10, floors * 3.1);
  }
  return 6 + r * 3;
}

// ---- 三角形分割（耳切り。輪は小さいので単純な方法で足りる） ----
function triangulate(pts) {
  // pts: [[x, y], ...]（反時計回りにそろえて渡す）
  const idx = pts.map((_, i) => i);
  const tris = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (cross(pts[a], pts[b], pts[c]) <= 0) continue;
      let ear = true;
      for (const o of idx) {
        if (o === a || o === b || o === c) continue;
        if (cross(pts[a], pts[b], pts[o]) >= 0 && cross(pts[b], pts[c], pts[o]) >= 0 && cross(pts[c], pts[a], pts[o]) >= 0) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push([a, b, c]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) tris.push(idx.slice());
  return tris;
}

// ---- b3dm（glTF：位置・法線・建物の番号、圧縮なし） ----
function buildB3dm(buildings, rtc) {
  const pos = [];
  const nor = [];
  const ids = [];
  const index = [];
  // ECEF → glTF（y が上）：(x, y, z)_glTF = (X, Z, -Y)
  const toGltf = ([X, Y, Z]) => [X - rtc[0], Z - rtc[2], -(Y - rtc[1])];
  const push = (p, n, id) => {
    pos.push(...p);
    nor.push(...n);
    ids.push(id);
    return ids.length - 1;
  };
  buildings.forEach((b, id) => {
    let ring = b.ring;
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
    if (ring.length < 3) return;
    const MX = MY * Math.cos(ring[0][0] * K);
    let flat = ring.map(([lat, lon]) => [lon * MX, lat * MY]);
    // 反時計回りにそろえる
    let s = 0;
    for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) s += flat[j][0] * flat[i][1] - flat[i][0] * flat[j][1];
    if (s < 0) {
      ring = ring.slice().reverse();
      flat = flat.slice().reverse();
    }
    const top = ring.map(([lat, lon]) => toGltf(toEcef(lat, lon, b.base + b.height)));
    const bottom = ring.map(([lat, lon]) => toGltf(toEcef(lat, lon, b.base)));
    // 上方向（地球の外向き）
    const c = ring[0];
    const up = toGltf(toEcef(c[0], c[1], 1)).map((v, k) => v - toGltf(toEcef(c[0], c[1], 0))[k]);
    // 屋上
    const ti = top.map((p) => push(p, up, id));
    for (const [a, bb, cc] of triangulate(flat)) index.push(ti[a], ti[bb], ti[cc]);
    // 壁（面ごとに頂点を分けて、角をくっきりさせる）
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const e = [top[j][0] - top[i][0], top[j][1] - top[i][1], top[j][2] - top[i][2]];
      // 外向き = 辺 × 上
      let n = [e[1] * up[2] - e[2] * up[1], e[2] * up[0] - e[0] * up[2], e[0] * up[1] - e[1] * up[0]];
      const l = Math.hypot(...n) || 1;
      n = n.map((v) => v / l);
      const a = push(bottom[i], n, id);
      const bb = push(bottom[j], n, id);
      const cc = push(top[j], n, id);
      const d = push(top[i], n, id);
      index.push(a, bb, cc, a, cc, d);
    }
  });
  if (index.length === 0) return null;
  const P = new Float32Array(pos);
  const N = new Float32Array(nor);
  const I = new Float32Array(ids);
  const X = ids.length > 65535 ? new Uint32Array(index) : new Uint16Array(index);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  }
  const parts = [Buffer.from(X.buffer), Buffer.from(P.buffer), Buffer.from(N.buffer), Buffer.from(I.buffer)];
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const views = [];
  let offset = 0;
  for (const [i, p] of parts.entries()) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: p.length, target: i === 0 ? 34963 : 34962 });
    offset += pad(p).length;
  }
  const bin = Buffer.concat(parts.map(pad));
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['CESIUM_RTC'],
    extensions: { CESIUM_RTC: { center: rtc } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2, _BATCHID: 3 }, indices: 0, material: 0, mode: 4 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [
      { bufferView: 0, componentType: X instanceof Uint32Array ? 5125 : 5123, count: X.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: ids.length, type: 'VEC3', min, max },
      { bufferView: 2, componentType: 5126, count: ids.length, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: ids.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const glbHead = Buffer.alloc(12);
  glbHead.write('glTF', 0);
  glbHead.writeUInt32LE(2, 4);
  glbHead.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write('JSON', 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write('BIN\0', 4, 'latin1');
  const glb = Buffer.concat([glbHead, jh, jsonBuf, bh, bin]);
  // b3dm：フィーチャーテーブル（BATCH_LENGTH）とバッチテーブル（gml_id）
  const padJson = (o) => {
    let b = Buffer.from(JSON.stringify(o));
    const r = (28 + b.length) % 8;
    if (r) b = Buffer.concat([b, Buffer.alloc(8 - r, 0x20)]);
    return b;
  };
  const ft = padJson({ BATCH_LENGTH: buildings.length });
  let bt = Buffer.from(JSON.stringify({ gml_id: buildings.map((b) => b.id) }));
  if ((28 + ft.length + bt.length) % 8) bt = Buffer.concat([bt, Buffer.alloc(8 - ((28 + ft.length + bt.length) % 8), 0x20)]);
  const head = Buffer.alloc(28);
  head.write('b3dm', 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(28 + ft.length + bt.length + glb.length, 8);
  head.writeUInt32LE(ft.length, 12);
  head.writeUInt32LE(0, 16);
  head.writeUInt32LE(bt.length, 20);
  head.writeUInt32LE(0, 24);
  return Buffer.concat([head, ft, bt, glb]);
}

// ---- 実行 ----
const rings = await boundary();
let s = Infinity;
let w = Infinity;
let n = -Infinity;
let e = -Infinity;
for (const ring of rings) {
  for (const [lon, lat] of ring) {
    s = Math.min(s, lat);
    n = Math.max(n, lat);
    w = Math.min(w, lon);
    e = Math.max(e, lon);
  }
}
const x0 = Math.floor(tileX(w, SRC_ZOOM));
const x1 = Math.floor(tileX(e, SRC_ZOOM));
const y0 = Math.floor(tileY(n, SRC_ZOOM));
const y1 = Math.floor(tileY(s, SRC_ZOOM));
console.log(`${NAME}: ${(x1 - x0 + 1) * (y1 - y0 + 1)} source tiles`);
// 標高
{
  const keys = new Set();
  for (let x = Math.floor(tileX(w, 15)) - 1; x <= Math.floor(tileX(e, 15)) + 1; x++) {
    for (let y = Math.floor(tileY(n, 15)) - 1; y <= Math.floor(tileY(s, 15)) + 1; y++) keys.add(`${x}/${y}`);
  }
  await prepareDem(keys);
}
// 建物を集めて、書き出すタイル（ズーム15）ごとに分ける
const outTiles = new Map();
const seen = new Set();
let total = 0;
let dropped = 0;
const jobs = [];
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      const list = decodeBuildings(await fetchTile(x, y), x, y);
      for (const { code, rings: br } of list) {
        const outer = br[0];
        let clat = 0;
        let clon = 0;
        for (const [lat, lon] of outer) (clat += lat), (clon += lon);
        clat /= outer.length;
        clon /= outer.length;
        if (!inside(rings, clon, clat)) continue;
        if (LANDMARKS.some(([la, lo, r]) => Math.hypot((la - clat) * MY, (lo - clon) * MY * Math.cos(clat * K)) < r)) continue;
        // タイルの境目で切れた建物が重ならないよう、同じ形は1回だけ
        const key = outer.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join(';');
        if (seen.has(key)) continue;
        seen.add(key);
        if (nearRail(br)) {
          dropped++;
          continue;
        }
        const area = areaOf(outer);
        if (area < 4) continue;
        // 底の高さ：標高（ジオイド基準）の一番低い所。建物の座標は楕円体高なのでジオイド高を足す（PLATEAU と同じ基準）
        let base = Infinity;
        for (const [lat, lon] of outer) base = Math.min(base, heightAt(lat, lon) ?? Infinity);
        if (!Number.isFinite(base)) continue;
        base += GEOID;
        const id = `gsi_${CODE}_${clat.toFixed(6)}_${clon.toFixed(6)}`;
        const tile = `${Math.floor(tileX(clon, OUT_ZOOM))}/${Math.floor(tileY(clat, OUT_ZOOM))}`;
        if (!outTiles.has(tile)) outTiles.set(tile, []);
        outTiles.get(tile).push({ id, ring: outer, base: base - SINK, height: heightOf(code, area, id) + SINK, code });
        total++;
      }
      if (++done % 50 === 0) console.log(`  ${done}/${jobs.length} source tiles, ${total} buildings`);
    }
  }),
);
console.log(`${total} buildings (${dropped} on the tracks dropped) → ${outTiles.size} tiles`);

// 書き出す：tileset.json（ズーム13 ごとのまとまりの下に、ズーム15 のタイル）
await rm(OUT, { recursive: true, force: true });
await mkdir(new URL('data/', OUT), { recursive: true });
const groups = new Map();
let bytes = 0;
let n3d = 0;
for (const [key, list] of outTiles) {
  const [x, y] = key.split('/').map(Number);
  const south = latOf(y + 1, OUT_ZOOM);
  const north = latOf(y, OUT_ZOOM);
  const west = lonOf(x, OUT_ZOOM);
  const east = lonOf(x + 1, OUT_ZOOM);
  const rtc = toEcef((south + north) / 2, (west + east) / 2, 0);
  const b3dm = buildB3dm(list, rtc);
  if (!b3dm) continue;
  const uri = `data/${x}_${y}.b3dm`;
  await writeFile(new URL(uri, OUT), b3dm);
  bytes += b3dm.length;
  n3d++;
  let low = Infinity;
  let high = -Infinity;
  for (const b of list) (low = Math.min(low, b.base)), (high = Math.max(high, b.base + b.height));
  const g = `${x >> 2}/${y >> 2}`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({
    boundingVolume: { region: [west * K, south * K, east * K, north * K, low, high] },
    geometricError: 0,
    refine: 'REPLACE',
    content: { uri },
  });
}
const union = (list) => {
  const r = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
  for (const c of list) {
    const b = c.boundingVolume.region;
    r[0] = Math.min(r[0], b[0]);
    r[1] = Math.min(r[1], b[1]);
    r[2] = Math.max(r[2], b[2]);
    r[3] = Math.max(r[3], b[3]);
    r[4] = Math.min(r[4], b[4]);
    r[5] = Math.max(r[5], b[5]);
  }
  return r;
};
const children = [...groups.values()].map((list) => ({
  boundingVolume: { region: union(list) },
  // この誤差より近づいたら中のタイル（建物）を読む（PLATEAU の中ほどの段と同じくらい）
  geometricError: 120,
  refine: 'REPLACE',
  children: list,
}));
const tileset = {
  asset: { version: '1.0' },
  geometricError: 500,
  root: { boundingVolume: { region: union(children) }, geometricError: 500, refine: 'REPLACE', children },
};
await writeFile(new URL('tileset.json', OUT), JSON.stringify(tileset));
// アプリが手元から読む区の一覧に足す
const wardsFile = new URL('wards.json', PLATEAU);
const wards = JSON.parse(await readFile(wardsFile, 'utf8'));
if (!wards.includes(CODE)) {
  wards.push(CODE);
  await writeFile(wardsFile, JSON.stringify(wards.sort()));
}
console.log(`${NAME} (${CODE}): ${n3d} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
