/**
 * 空飛ぶ車の航路を作る → public/sky-lanes.json
 *
 * - 道の上：道路データの幹線（種別 0）と準幹線（種別 1）をつないで長い線にし、短いもの・上下線の重なりを除く。
 *   道の向きで段を分ける（南北寄り = 0・2 段、東西寄り = 1・3 段）
 * - 主要駅のまわり：駅を中心とする円の中に、街の道路の向きに合わせた格子の航路を張る（幹線の航路は円の中では消す）。
 *   格子の片方の向きは 0・2 段、もう片方は 1・3 段
 * - 高さ：段の高さ（地面からの m）を、均した地面の上に置く。高い建物の上では、その段を建物の上まで持ち上げ（ゆるい坂でつなぐ）、
 *   持ち上げる量が大きすぎる所（スカイツリーなど）は線を切る
 *
 * 出力：{ tiers: [段の高さ], lanes: [[段, 種類（0 = 都心の外の道・1 = 駅の格子・2 = 都心の道）, [緯度, 経度（1e-6度）, 標高（ジオイド基準, 0.1m）, ...]]] }
 * 使い方：node scripts/build-sky-lanes.mjs
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { prepareDem, heightAt, smoothGround } from './lib/dem.mjs';
import { REGION_ID, regionPath, SETTINGS } from './lib/region.mjs';

const require = createRequire(import.meta.url);
const draco3d = require('draco3dgltf');

const ROADS = regionPath('public/roads/15/');
const PLATEAU = new URL('../public/plateau/', import.meta.url);
const OUT = regionPath('public/sky-lanes.json');

/** 段の高さ（地面から, m）。src/world/SkyTraffic.ts と同じ順 */
const TIERS = [80, 130, 190, 260];
/**
 * 道の上の航路の最短の長さ (m)：幹線と準幹線。ほかの航路にこの距離 (m) 以内で重なる割合がこれより多ければ捨てる
 */
const MIN_LENGTH = 1000;
const MIN_LENGTH_COLLECTOR = 800;
const OVERLAP_RADIUS = 60;
const OVERLAP_SHARE = 0.4;
/** 道をつなぐ時の、曲がる角度の上限 (度) */
const JOIN_ANGLE = 35;
/** 主要駅（名前は data/stations/structure.json と同じ）と、格子の円の半径・線の間隔 (m) */
const HUBS = SETTINGS.hubs;
const HUB_RADIUS = 750;
/** 都心（東京駅から CENTER_RADIUS m 以内と、駅の格子の円から HUB_MARGIN m 以内） */
const CENTER = SETTINGS.center;
const CENTER_RADIUS = 3000;
const HUB_MARGIN = 750;
const GRID_STEP = 200;
/** 建物の上に空ける高さ (m)、坂の勾配、持ち上げてよい量の上限 (m) */
const CLEARANCE = 25;
const SLOPE = 0.15;
const MAX_RAISE = 90;
/** 建物を見る、航路からの横の距離 (m) */
const SIDE = 20;
/** この高さ (m) より低い建物は無視する */
const TALL = 50;
/** 高さを調べる間隔 (m) */
const STEP = 20;
/**
 * 作り込んだ建物（PLATEAU の箱を消したもの）：[緯度, 経度, 半径 (m), 地面からの高さ (m)]
 */
const LANDMARK_OBSTACLES = {
  tokyo: [
    [35.71010, 139.81070, 40, 634], // 東京スカイツリー
    [35.65858, 139.74543, 45, 333], // 東京タワー
    [35.6896, 139.6917, 60, 243], // 東京都庁 第一本庁舎
    [35.68804, 139.69208, 45, 163], // 東京都庁 第二本庁舎
    [35.6844, 139.70312, 30, 272], // NTTドコモ代々木ビル
    [35.69159, 139.69694, 30, 204], // コクーンタワー
    [35.69269, 139.69612, 40, 187], // 損保ジャパン本社ビル
    [35.66089, 139.74049, 50, 330], // 麻布台ヒルズ森JPタワー
    [35.66221, 139.74037, 35, 240], // 麻布台ヒルズ レジデンス
    [35.6669, 139.74935, 45, 255], // 虎ノ門ヒルズ森タワー
    [35.66775, 139.75002, 40, 185], // 虎ノ門ヒルズ ビジネスタワー
    [35.66604, 139.7485, 35, 221], // 虎ノ門ヒルズ レジデンシャルタワー
    [35.66754, 139.74691, 45, 266], // 虎ノ門ヒルズ ステーションタワー
    [35.66045, 139.72930, 45, 238], // 六本木ヒルズ森タワー
    [35.658385, 139.702242, 40, 230], // 渋谷スクランブルスクエア
    [35.65925, 139.70366, 35, 183], // 渋谷ヒカリエ
    [35.65655, 139.70225, 40, 180], // 渋谷サクラステージ
    [35.65643, 139.69958, 35, 184], // セルリアンタワー
    [35.71025, 139.81383, 30, 160], // 東京スカイツリーイーストタワー
    [35.65909, 139.7046, 40, 182], // 渋谷アクシュ
    [35.68106, 139.76381, 42, 182], // 丸ビル
    [35.6826, 139.7643, 46, 198], // 新丸ビル
    [35.67979, 139.76483, 56, 202], // JPタワー
    [35.67856, 139.76494, 61, 167], // 東京ビル TOKIA
    [35.68433, 139.7649, 44, 159], // 丸の内永楽ビルディング
    [35.67901, 139.76311, 58, 170], // 丸の内パークビルディング
    [35.67932, 139.768977, 46, 240], // 東京ミッドタウン八重洲（塔）
    [35.6766, 139.7643, 105, 58], // 東京国際フォーラム（ガラス棟とホール棟）
  ],
  osaka: [
    [34.703006, 135.49547, 95, 152], // ノースゲートビルディング
    [34.701701, 135.496414, 70, 134], // サウスゲートビルディング
    [34.702408, 135.495914, 105, 50], // 大阪駅の大屋根
    [34.701775, 135.493247, 70, 123], // イノゲート大阪
    [34.70049, 135.494, 60, 188], // JPタワー大阪
  ],
  fukuoka: [
    [33.59328, 130.35152, 30, 234], // 福岡タワー
    [33.6043, 130.39776, 25, 103], // 博多ポートタワー
    [33.5953, 130.3621, 140, 70], // みずほPayPayドーム福岡
  ],
}[REGION_ID] ?? [];

const K = Math.PI / 180;
const MX = 111320 * Math.cos(SETTINGS.lat0 * K);
const MY = 111320;
const xy = ([lat, lon]) => [lon * MX, lat * MY];

const decode = (c) => {
  const out = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < c.length; i += 2) {
    lat += c[i];
    lon += c[i + 1];
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
};
const dist = (a, b) => Math.hypot((a[1] - b[1]) * MX, (a[0] - b[0]) * MY);
/** a → b の向き（東から北へ, rad） */
const bearing = (a, b) => Math.atan2((b[0] - a[0]) * MY, (b[1] - a[1]) * MX);
const polyLength = (pts) => pts.reduce((sum, p, i) => (i > 0 ? sum + dist(pts[i - 1], p) : 0), 0);

// ---- 道路データを読む ----
const majors = [];
const collectors = [];
/** 駅のまわりの道の向きを見るための線分（幹線・準幹線） */
const segments = [];
const demKeys = new Set();
for (const x of await readdir(ROADS)) {
  for (const f of await readdir(new URL(`${x}/`, ROADS))) {
    const y = Number(f.replace('.json', ''));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) demKeys.add(`${Number(x) + dx}/${y + dy}`);
    const tile = JSON.parse(await readFile(new URL(`${x}/${f}`, ROADS), 'utf8'));
    for (const [cls, , , coords] of tile.w) {
      if (cls > 1) continue;
      const pts = decode(coords);
      (cls === 0 ? majors : collectors).push(pts);
      for (let i = 1; i < pts.length; i++) segments.push([pts[i - 1], pts[i]]);
    }
  }
}
console.log(`${majors.length} major / ${collectors.length} collector ways, ${await prepareDem(demKeys)} elevation tiles`);

// ---- 道をつないで長い線にする（種別ごと） ----
const CELL = 8;
const keyOf = ([lat, lon]) => `${Math.round((lon * MX) / CELL)},${Math.round((lat * MY) / CELL)}`;
function chainWays(ways) {
  const ends = new Map();
  const addEnd = (p, i) => {
    const [kx, ky] = keyOf(p).split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = `${kx + dx},${ky + dy}`;
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(i);
      }
    }
  };
  ways.forEach((pts, i) => {
    addEnd(pts[0], i);
    addEnd(pts[pts.length - 1], i);
  });
  const used = new Uint8Array(ways.length);
  const chains = [];
  for (let start = 0; start < ways.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    let chain = ways[start].slice();
    // 末尾の先へ、まっすぐ続く道をつなぐ（両方向）
    for (let pass = 0; pass < 2; pass++) {
      for (;;) {
        const tail = chain[chain.length - 1];
        const dir = bearing(chain[Math.max(0, chain.length - 3)], tail);
        let best = null;
        for (const j of ends.get(keyOf(tail)) ?? []) {
          if (used[j]) continue;
          const w = ways[j];
          for (const pts of [w, w.slice().reverse()]) {
            if (dist(pts[0], tail) > CELL * 1.5) continue;
            let turn = Math.abs(bearing(pts[0], pts[Math.min(2, pts.length - 1)]) - dir);
            turn = Math.min(turn, Math.PI * 2 - turn) / K;
            if (turn < JOIN_ANGLE && (!best || turn < best.turn)) best = { j, pts, turn };
          }
        }
        if (!best) break;
        used[best.j] = 1;
        chain = chain.concat(best.pts.slice(1));
      }
      chain.reverse();
    }
    chains.push(chain);
  }
  return chains;
}
const majorChains = chainWays(majors);
const collectorChains = chainWays(collectors);

/** Douglas-Peucker で点を減らす (m) */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy(pts[a]);
    const [bx, by] = xy(pts[b]);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy(pts[i]);
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > worst) (worst = d), (at = i);
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 線を一定の間隔 (m) の点に区切る */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.ceil(dist(pts[i - 1], pts[i]) / step));
    for (let k = 1; k <= n; k++) {
      out.push([pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / n, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / n]);
    }
  }
  return out;
}

// ---- 主要駅：格子の向き（まわりの道の向きの多い方） ----
const structure = JSON.parse(await readFile(regionPath('data/stations/structure.json'), 'utf8'));
const hubs = HUBS.map((name) => {
  const refs = structure.filter((s) => s.name === name).map((s) => s.ref);
  const center = [refs.reduce((a, r) => a + r[0], 0) / refs.length, refs.reduce((a, r) => a + r[1], 0) / refs.length];
  const bins = new Float64Array(90);
  for (const [a, b] of segments) {
    if (dist(a, center) > HUB_RADIUS) continue;
    const deg = ((((bearing(a, b) / K) % 90) + 90) % 90) | 0;
    bins[deg] += dist(a, b);
  }
  // ±5° をならして一番多い向き
  let best = 0;
  let bestSum = -1;
  for (let d = 0; d < 90; d++) {
    let sum = 0;
    for (let k = -5; k <= 5; k++) sum += bins[(d + k + 90) % 90];
    if (sum > bestSum) (bestSum = sum), (best = d);
  }
  console.log(`${name}: grid ${best}°`);
  return { name, center, angle: best * K };
});
const inHub = (p) => hubs.some((h) => dist(p, h.center) < HUB_RADIUS);

// ---- 道の上の航路：駅の円の中を消し、短いもの・重なるものを捨てる（幹線を先に選び、準幹線はその隙間を埋める） ----
function piecesOf(chains) {
  const pieces = [];
  for (const chain of chains) {
    let cur = [];
    for (const p of densify(chain, STEP)) {
      if (inHub(p)) {
        if (cur.length > 1) pieces.push(cur);
        cur = [];
      } else cur.push(p);
    }
    if (cur.length > 1) pieces.push(cur);
  }
  return pieces.sort((a, b) => polyLength(b) - polyLength(a));
}
const OCELL = OVERLAP_RADIUS;
const occupied = new Map();
const cellOf = ([lat, lon]) => [Math.floor((lon * MX) / OCELL), Math.floor((lat * MY) / OCELL)];
const near = (p) => {
  const [cx, cy] = cellOf(p);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const q of occupied.get(`${cx + dx},${cy + dy}`) ?? []) if (dist(p, q) < OVERLAP_RADIUS) return true;
    }
  }
  return false;
};
const arterials = [];
for (const [pieces, minLength] of [
  [piecesOf(majorChains), MIN_LENGTH],
  [piecesOf(collectorChains), MIN_LENGTH_COLLECTOR],
]) {
  for (const piece of pieces) {
    if (polyLength(piece) < minLength) break;
    const probe = piece.filter((_, i) => i % 2 === 0);
    if (probe.filter(near).length / probe.length > OVERLAP_SHARE) continue;
    for (const p of probe) {
      const k = cellOf(p).join(',');
      if (!occupied.has(k)) occupied.set(k, []);
      occupied.get(k).push(p);
    }
    arterials.push(simplify(piece, 8));
  }
  console.log(`→ ${arterials.length} lanes on roads`);
}

// ---- 格子の航路 ----
const grids = [];
for (const hub of hubs) {
  const [cx, cy] = xy(hub.center);
  for (const [family, angle] of [
    [0, hub.angle],
    [1, hub.angle + Math.PI / 2],
  ]) {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    for (let off = -HUB_RADIUS + GRID_STEP / 2; off < HUB_RADIUS; off += GRID_STEP) {
      const half = Math.sqrt(HUB_RADIUS ** 2 - off ** 2);
      if (half < 150) continue;
      const line = [-half, half].map((t) => {
        const x = cx + ux * t - uy * off;
        const y = cy + uy * t + ux * off;
        return [y / MY, x / MX];
      });
      grids.push({ family, pts: line });
    }
  }
}

// ---- 高い建物（PLATEAU）：中心・半径・てっぺんの標高（ジオイド基準） ----
const decoderModule = await draco3d.createDecoderModule();
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function toGeodetic(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 4; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return [lat / K, lon / K, h];
}
function parseGlb(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen).replace(/[\0 ]+$/, ''));
  const binStart = 20 + jsonLen + 8;
  return { json, bin: glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen)) };
}
function decodeDraco(json, bin, prim, idName) {
  const ext = prim.extensions.KHR_draco_mesh_compression;
  const view = json.bufferViews[ext.bufferView];
  const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const decoder = new decoderModule.Decoder();
  const mesh = new decoderModule.Mesh();
  const status = decoder.DecodeArrayToMesh(new Int8Array(data), data.length, mesh);
  if (!status.ok()) throw new Error(status.error_msg());
  const read = (name, size) => {
    const attr = decoder.GetAttributeByUniqueId(mesh, ext.attributes[name]);
    const n = mesh.num_points() * size;
    const ptr = decoderModule._malloc(n * 4);
    decoder.GetAttributeDataArrayForAllPoints(mesh, attr, decoderModule.DT_FLOAT32, n * 4, ptr);
    const out = new Float32Array(decoderModule.HEAPF32.buffer, ptr, n).slice();
    decoderModule._free(ptr);
    return out;
  };
  const position = read('POSITION', 3);
  const id = read(idName, 1);
  decoderModule.destroy(mesh);
  decoderModule.destroy(decoder);
  return { position, id };
}
/** 圧縮されていない accessor を Float32Array で読む */
function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[acc.componentType];
  const stride = view.byteStride ?? size * Type.BYTES_PER_ELEMENT;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new Float32Array(acc.count * size);
  const dv = new DataView(bin.buffer, bin.byteOffset);
  const get = { 5126: (o) => dv.getFloat32(o, true), 5125: (o) => dv.getUint32(o, true), 5123: (o) => dv.getUint16(o, true), 5121: (o) => dv.getUint8(o) }[acc.componentType];
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < size; k++) out[i * size + k] = get(start + i * stride + k * Type.BYTES_PER_ELEMENT);
  }
  return out;
}
const concat = (list) => {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of list) out.set(a, o), (o += a.length);
  return out;
};
const tall = new Map();
for (const ward of JSON.parse(await readFile(new URL('wards.json', PLATEAU), 'utf8'))) {
  const files = [];
  const walk = async (dir) => {
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (f.isDirectory()) await walk(new URL(`${f.name}/`, dir));
      else if (/\.(b3dm|glb)$/.test(f.name)) files.push(new URL(f.name, dir));
    }
  };
  await walk(new URL(`${ward}/`, PLATEAU));
  for (const file of files) {
    const buf = await readFile(file);
    let glb = buf;
    let rtc = [0, 0, 0];
    let ids = null;
    if (buf.toString('ascii', 0, 4) === 'b3dm') {
      const ftJson = buf.readUInt32LE(12);
      const ftBin = buf.readUInt32LE(16);
      const btJson = buf.readUInt32LE(20);
      const btBin = buf.readUInt32LE(24);
      const ft = JSON.parse(buf.toString('utf8', 28, 28 + ftJson).trim() || '{}');
      const bt = btJson ? JSON.parse(buf.toString('utf8', 28 + ftJson + ftBin, 28 + ftJson + ftBin + btJson).trim() || '{}') : {};
      ids = bt.gml_id ?? null;
      glb = buf.subarray(28 + ftJson + ftBin + btJson + btBin);
      rtc = parseGlb(glb).json.extensions?.CESIUM_RTC?.center ?? ft.RTC_CENTER ?? rtc;
    }
    const { json, bin } = parseGlb(glb);
    // 全部の部品の点と建物の番号（Draco で圧縮されていない部品はそのまま読む）
    const positions = [];
    const idsOf = [];
    json.meshes.forEach((mesh, mi) => {
      const t = (json.nodes.find((n) => n.mesh === mi) ?? {}).translation ?? [0, 0, 0];
      for (const prim of mesh.primitives) {
        const idName = prim.attributes._BATCHID !== undefined ? '_BATCHID' : '_FEATURE_ID_0';
        let position;
        let id;
        if (prim.extensions?.KHR_draco_mesh_compression) ({ position, id } = decodeDraco(json, bin, prim, idName));
        else {
          position = readAccessor(json, bin, prim.attributes.POSITION);
          id = prim.attributes[idName] !== undefined ? readAccessor(json, bin, prim.attributes[idName]) : new Float32Array(position.length / 3);
        }
        for (let i = 0; i < position.length; i += 3) {
          position[i] += t[0];
          position[i + 1] += t[1];
          position[i + 2] += t[2];
        }
        positions.push(position);
        idsOf.push(id);
      }
    });
    const position = concat(positions);
    const id = concat(idsOf);
    const t = [0, 0, 0];
    // まず建物ごとの上下（glTF の y。ECEF の z なので鉛直の 6 割ほど）の範囲だけ見て、高そうな建物の点だけ緯度経度にする
    const range = new Map();
    for (let i = 0; i < id.length; i++) {
      const r = range.get(id[i]) ?? [Infinity, -Infinity];
      const yUp = position[i * 3 + 1];
      r[0] = Math.min(r[0], yUp);
      r[1] = Math.max(r[1], yUp);
      range.set(id[i], r);
    }
    const tallIds = new Set([...range].filter(([, r]) => r[1] - r[0] > TALL * 0.4).map(([b]) => b));
    if (tallIds.size === 0) continue;
    const boxes = new Map();
    for (let i = 0; i < id.length; i++) {
      if (!tallIds.has(id[i])) continue;
      const [lat, lon, h] = toGeodetic(
        rtc[0] + t[0] + position[i * 3],
        rtc[1] - (t[2] + position[i * 3 + 2]),
        rtc[2] + t[1] + position[i * 3 + 1],
      );
      const o = boxes.get(id[i]) ?? { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity, h0: Infinity, h1: -Infinity };
      o.s = Math.min(o.s, lat);
      o.n = Math.max(o.n, lat);
      o.w = Math.min(o.w, lon);
      o.e = Math.max(o.e, lon);
      o.h0 = Math.min(o.h0, h);
      o.h1 = Math.max(o.h1, h);
      boxes.set(id[i], o);
    }
    for (const [b, o] of boxes) {
      if (o.h1 - o.h0 < TALL) continue;
      const key = ids?.[b] ?? `${file.pathname}#${b}`;
      const prev = tall.get(key);
      if (!prev || o.h1 - o.h0 > prev.height) {
        const center = [(o.s + o.n) / 2, (o.w + o.e) / 2];
        tall.set(key, { center, radius: dist([o.s, o.w], [o.n, o.e]) / 2, height: o.h1 - o.h0 });
      }
    }
  }
}
const obstacles = [...tall.values()];
for (const [lat, lon, radius, height] of LANDMARK_OBSTACLES) obstacles.push({ center: [lat, lon], radius, height });
for (const o of obstacles) o.top = (heightAt(o.center[0], o.center[1]) ?? 0) + o.height;
console.log(`${obstacles.length} tall buildings`);
const BCELL = 200;
const obstacleGrid = new Map();
for (const o of obstacles) {
  const [cx, cy] = [Math.floor((o.center[1] * MX) / BCELL), Math.floor((o.center[0] * MY) / BCELL)];
  const k = `${cx},${cy}`;
  if (!obstacleGrid.has(k)) obstacleGrid.set(k, []);
  obstacleGrid.get(k).push(o);
}
/** その点の真上で、航路が越えなければならない標高（無ければ -Infinity） */
function obstacleTop(p) {
  const [cx, cy] = [Math.floor((p[1] * MX) / BCELL), Math.floor((p[0] * MY) / BCELL)];
  let top = -Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const o of obstacleGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (dist(p, o.center) < o.radius + SIDE) top = Math.max(top, o.top + CLEARANCE);
      }
    }
  }
  return top;
}

// ---- 高さを決めて、持ち上げすぎる所で切る ----
const lanes = [];
const ground = new Map();
const groundAt = (p) => {
  const k = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  if (!ground.has(k)) ground.set(k, smoothGround(p[0], p[1], 400) ?? heightAt(p[0], p[1]) ?? 0);
  return ground.get(k);
};
/** 航路の種類：0 = 都心の外の道の上、1 = 駅のまわりの格子、2 = 都心の道の上（車の間隔は src/world/SkyTraffic.ts で決める） */
const isCentral = (p) => dist(p, CENTER) < CENTER_RADIUS || hubs.some((h) => dist(p, h.center) < HUB_RADIUS + HUB_MARGIN);
function addLane(tier, grid, pts) {
  const samples = densify(pts, STEP);
  const base = samples.map((p) => groundAt(p) + TIERS[tier]);
  const need = samples.map((p, i) => Math.max(base[i], obstacleTop(p)));
  const alt = need.slice();
  // ゆるい坂で前後へ広げる
  for (let i = 1; i < alt.length; i++) alt[i] = Math.max(alt[i], alt[i - 1] - SLOPE * STEP);
  for (let i = alt.length - 2; i >= 0; i--) alt[i] = Math.max(alt[i], alt[i + 1] - SLOPE * STEP);
  let cur = [];
  let kind = -1;
  const flush = () => {
    if (cur.length >= 2 && (cur.length - 1) * STEP >= 300) {
      // 高さの変わらない所は点を間引く
      const out = cur.filter((q, i) => i === 0 || i === cur.length - 1 || i % 5 === 0 || Math.abs(q[2] - cur[i - 1][2]) > 0.5);
      lanes.push([tier, kind, out.flatMap(([lat, lon, h]) => [Math.round(lat * 1e6), Math.round(lon * 1e6), Math.round(h * 10)])]);
    }
    cur = [];
  };
  for (let i = 0; i < samples.length; i++) {
    const k = grid ? 1 : isCentral(samples[i]) ? 2 : 0;
    if (need[i] - base[i] > MAX_RAISE) {
      flush();
      continue;
    }
    if (k !== kind && cur.length > 0) {
      // 種類が変わる所で分ける（境目の点は両方に入れて続ける）
      const last = cur[cur.length - 1];
      flush();
      cur.push(last);
    }
    cur.push([samples[i][0], samples[i][1], alt[i]]);
    kind = k;
  }
  flush();
}
let hash = 0;
for (const pts of arterials) {
  // 南北寄りは 0・2 段、東西寄りは 1・3 段。どちらにするかは交互に
  const d = Math.abs(Math.cos(bearing(pts[0], pts[pts.length - 1])));
  const pair = d < Math.SQRT1_2 ? [0, 2] : [1, 3];
  addLane(pair[hash++ % 2], false, pts);
}
for (const g of grids) for (const tier of g.family === 0 ? [0, 2] : [1, 3]) addLane(tier, true, g.pts);
await writeFile(OUT, JSON.stringify({ tiers: TIERS, lanes }));
console.log(`${lanes.length} lanes → ${OUT.pathname}`);
