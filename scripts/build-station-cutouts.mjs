// 線路・ホームが建物（駅ビルなど）の中を通る所で、列車とホームの通り道を建物から切り抜く。
// 手元に加工済みの PLATEAU の建物（public/plateau、scripts/build-local-buildings.mjs で作る）を書き換える。
// 使い方: node scripts/build-station-cutouts.mjs [区コード...]（build-rail-heights.mjs・build-platforms.mjs の後に実行）
//
// - 通り道：線路の中心から左右 TRACK_HALF m、レール面の CLEAR_BELOW m 下から CLEARANCE m 上まで。
//   ホームの上も、床の CLEAR_BELOW m 下から同じ高さまで
// - 高さは楕円体高（建物の座標と同じ）。線路・ホームの「地面からの高さ」を、ゲームと同じ地形（国土地理院の標高タイル、
//   data/cache/dem に保存）と同じ計算で直す（坂の途中の駅で、建物の地面と線路の地面が違っても高さが合う）
// - 通り道の外にある建物の部分はそのまま残るので、線路の上の建物は両側の本体とつながったままになる
// - 書き換える前の建物のタイルは data/cache/plateau-original に取っておき、2回目からはそこから作り直す
//   （通り道を変えてやり直しても、前に切り抜いた跡が残らない）
// - 切り抜いたタイルは Draco で圧縮せずに書く（属性は建物の番号・ID・名前を含めてそのまま）
// - 切り抜いて宙に浮いた部分：薄い残り（屋根の面だけ）や小さなかけらは消し、線路をまたぐ駅舎などには、
//   列車にぶつからない所（線路の間・ホームの上）に地面から柱を立てる。SHOW_FLOATING=1 で柱を立てられなかった所を表示
// - ホーム・上屋・高架をまとめて1つの細長い箱にした建物（東京駅の JR のホームなど）は、切り抜かずに丸ごと消す
//   （ホームと上屋は station-roofs、高架は線路の方で描く）。ただし大屋根の駅舎（BIG_ROOFS）は、屋根だけ残して柱で支える
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import {
  CUT_RADIUS,
  GEOID,
  SMOOTH_RADIUS,
  WATER_CLEARANCE,
  WATER_SURFACE,
  heightAt,
  prepareDem,
  smoothGround,
  stationGround,
} from './lib/dem.mjs';
import { regionPath, SETTINGS } from './lib/region.mjs';

const require = createRequire(import.meta.url);
const draco3d = require('draco3dgltf');

const PLATEAU = new URL('../public/plateau/', import.meta.url);
const ORIGINAL = new URL('../data/cache/plateau-original/', import.meta.url);
const RAIL_DIR = regionPath('public/rail-tracks/15/');
const ROOF_DIR = regionPath('public/station-roofs/15/');

/** 通り道の半分の幅 (m)：車両の半分の幅 + 余裕 */
const TRACK_HALF = 2.6;
/** レール面・ホームの床より下に切り抜く深さ (m) */
const CLEAR_BELOW = 1.5;
/** レール面から上に切り抜く高さ (m)：架線まで + 余裕 */
const CLEARANCE = 7.5;
/** 道床の上面の、地面からの高さ (m)。src/core/config.ts の RAILWAYS.lift と同じ */
const BALLAST = 0.3;
/** ホームの床の、道床の上面からの高さ (m)。scripts/build-platforms.mjs と同じ */
const PLATFORM_HEIGHT = 1.1;
/** 線路の線分を、向きがこの角度 (度) 以内・高さがこの差 (m) 以内ならつないで1本の通り道にする */
const MERGE_ANGLE = 3;
const MERGE_HEIGHT = 0.3;

const K = Math.PI / 180;
const MX = 111320 * Math.cos(SETTINGS.lat0 * K);
const MY = 111320;

// ---- 座標の変換（WGS84） ----
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function toEcef(lat, lon, h) {
  const p = lat * K;
  const l = lon * K;
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}
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

// ---- 地形（ゲームと同じ国土地理院の標高タイル）：線路・ホームの「地面からの高さ」を楕円体高（建物の座標と同じ基準）に直すのに使う ----
const lerp = (a, b, t) => a + (b - a) * t;

// ---- 通り道（平面の形と、高さの範囲（楕円体高, m）） ----
// 線路：つながった線分ごとの長方形。ホーム：ホームの形
const corridors = []; // { ring: [[x, y] (m)], bottom, top（楕円体高）, box }
function addCorridor(ring, bottom, top) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  corridors.push({ ring, bottom, top, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
}
// 線路のタイルとその周り（均した地面は 60m 先まで見る）の標高を読む
{
  const keys = new Set();
  for (const x of await readdir(RAIL_DIR)) {
    for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
      const y = Number(f.replace('.json', ''));
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.add(`${Number(x) + dx}/${y + dy}`);
    }
  }
  console.log(`${await prepareDem(keys)} elevation tiles`);
}
for (const x of await readdir(RAIL_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
    const { t, s = [] } = JSON.parse(await readFile(new URL(`${x}/${f}`, RAIL_DIR), 'utf8'));
    const stationBase = s.map(([lat, lon, cut]) => stationGround(lat / 1e6, lon / 1e6, cut === 1));
    for (const [, coords, offsets, cut, refs, weights] of t) {
      const geo = decode(coords);
      const pts = geo.map(([lat, lon]) => [lon * MX, lat * MY]);
      // RailNetwork.ts の buildTrack と同じ高さ（レール面の楕円体高）。地上の線路の地面は描いた地形の面の代わりに標高そのもの
      const along = [0];
      for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const dem = geo.map(([lat, lon]) => heightAt(lat, lon) ?? 0);
      const ground = cut
        ? dem.map((_, i) => {
            // 掘割の底：前後 CUT_RADIUS m の一番低い所
            let m = Infinity;
            for (let j = 0; j < dem.length; j++) if (Math.abs(along[j] - along[i]) <= CUT_RADIUS) m = Math.min(m, dem[j]);
            return m;
          })
        : dem;
      const h = geo.map(([lat, lon], i) => {
        const lift = offsets[i] / 10;
        const smooth = smoothGround(lat, lon, SMOOTH_RADIUS) ?? ground[i];
        let base = lerp(ground[i], smooth, Math.min(Math.max(lift / 2, 0), 1));
        const ref = refs?.[i] ?? -1;
        const w = ref >= 0 && stationBase[ref] !== null ? weights[i] / 10 : 0;
        if (w > 0) base = lerp(base, stationBase[ref], w);
        const overWater = Math.max(base + lift, WATER_SURFACE + WATER_CLEARANCE);
        return lerp(overWater, base + lift, w) + BALLAST + GEOID;
      });
      // 向きと高さがほぼ同じ線分をつなぐ
      let start = 0;
      for (let i = 1; i < pts.length; i++) {
        const last = i === pts.length - 1;
        if (!last) {
          const a0 = Math.atan2(pts[i][1] - pts[start][1], pts[i][0] - pts[start][0]);
          const a1 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
          let d = Math.abs(a1 - a0) / K;
          if (d > 180) d = 360 - d;
          if (d <= MERGE_ANGLE && Math.abs(h[i + 1] - h[start]) <= MERGE_HEIGHT) continue;
        }
        const a = pts[start];
        const b = pts[i];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > 0.01) {
          const ux = (b[0] - a[0]) / len;
          const uy = (b[1] - a[1]) / len;
          const nx = -uy * TRACK_HALF;
          const ny = ux * TRACK_HALF;
          // 隣の線分とすき間ができないよう、前後に少し伸ばす
          const a2 = [a[0] - ux, a[1] - uy];
          const b2 = [b[0] + ux, b[1] + uy];
          const seg = h.slice(start, i + 1);
          addCorridor(
            [
              [a2[0] + nx, a2[1] + ny],
              [b2[0] + nx, b2[1] + ny],
              [b2[0] - nx, b2[1] - ny],
              [a2[0] - nx, a2[1] - ny],
            ],
            Math.min(...seg) - CLEAR_BELOW,
            Math.max(...seg) + CLEARANCE,
          );
        }
        start = i;
      }
    }
  }
}
const trackCorridors = corridors.length;
for (const x of await readdir(ROOF_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, ROOF_DIR))) {
    for (const [kind, height, , coords, refLat, refLon, cut] of JSON.parse(
      await readFile(new URL(`${x}/${f}`, ROOF_DIR), 'utf8'),
    )) {
      if (kind !== 2 || height < 0) continue;
      const ring = decode(coords);
      // StationRoofs.ts と同じ地面：駅の基準点の駅の地面、無ければ形の頂点の標高の平均
      let ground = refLat !== undefined ? stationGround(refLat / 1e6, refLon / 1e6, cut === 1) : null;
      if (ground === null) {
        const hs = ring.map(([lat, lon]) => heightAt(lat, lon)).filter((v) => v !== null);
        if (hs.length === 0) continue;
        ground = hs.reduce((a, b) => a + b, 0) / hs.length;
      }
      const floor = ground + height + GEOID;
      addCorridor(
        ring.map(([lat, lon]) => [lon * MX, lat * MY]),
        floor - CLEAR_BELOW,
        floor - PLATFORM_HEIGHT + CLEARANCE,
      );
    }
  }
}
// 空港の搭乗橋（public/airports.json、scripts/fetch-airports.mjs）：PLATEAU では建物と同じ高さの箱になっているので、
// 地面から JET_BRIDGE_TOP m まで丸ごと切り抜く（搭乗橋は src/world/Airports.ts で描く）。ターミナルの側の端は
// 壁を削らないよう JET_BRIDGE_SKIP m 手前から
const JET_BRIDGE_HALF = 3.5;
const JET_BRIDGE_TOP = 30;
const JET_BRIDGE_SKIP = 3;
let jetBridges = 0;
const airports = JSON.parse(await readFile(regionPath('public/airports.json'), 'utf8').catch(() => '{}'));
// 搭乗橋の付け根（ターミナルから突き出た細い通路）：通路の高さ（地面から JET_BRIDGE_FLOOR〜JET_BRIDGE_ROOF m）だけ残し、
// その下と上を切り抜く（scripts/build-airport-fixed-links.mjs が探した、付け根ごとの凸包の形）
const JET_BRIDGE_FLOOR = 5.3;
const JET_BRIDGE_ROOF = 8.6;
for (const coords of JSON.parse(await readFile(regionPath('data/airports/fixed-links.json'), 'utf8').catch(() => '[]'))) {
  const pts = decode(coords);
  const [lat, lon] = pts[0];
  const ground = (heightAt(lat, lon) ?? 3) + GEOID;
  const ring = pts.map(([la, lo]) => [lo * MX, la * MY]);
  addCorridor(ring, ground - 2, ground + JET_BRIDGE_FLOOR);
  addCorridor(ring, ground + JET_BRIDGE_ROOF, ground + JET_BRIDGE_TOP);
  jetBridges += 2;
}
for (const coords of airports.j ?? []) {
  const pts = decode(coords).map(([lat, lon]) => [lon * MX, lat * MY]);
  const ground = (() => {
    const [lat, lon] = decode(coords)[0];
    return heightAt(lat, lon) ?? 3;
  })();
  let skip = JET_BRIDGE_SKIP;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.1) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    if (skip > 0) {
      if (len <= skip) {
        skip -= len;
        continue;
      }
      a = [a[0] + ux * skip, a[1] + uy * skip];
      skip = 0;
    }
    const nx = -uy * JET_BRIDGE_HALF;
    const ny = ux * JET_BRIDGE_HALF;
    // 先の端は少し延ばす（飛行機の側の端の箱も残さない）
    const e = i === pts.length - 1 ? 3 : 0;
    const bb = [b[0] + ux * e, b[1] + uy * e];
    addCorridor(
      [
        [a[0] + nx, a[1] + ny],
        [bb[0] + nx, bb[1] + ny],
        [bb[0] - nx, bb[1] - ny],
        [a[0] - nx, a[1] - ny],
      ],
      ground + GEOID - 2,
      ground + GEOID + JET_BRIDGE_TOP,
    );
    jetBridges++;
  }
}
console.log(`${trackCorridors} track corridors, ${corridors.length - trackCorridors - jetBridges} platforms, ${jetBridges} jet bridge pieces`);
// 探しやすくする格子（50m）
const CELL = 50;
const grid = new Map();
corridors.forEach((c, i) => {
  for (let y = Math.floor(c.box[1] / CELL); y <= Math.floor(c.box[3] / CELL); y++) {
    for (let x = Math.floor(c.box[0] / CELL); x <= Math.floor(c.box[2] / CELL); x++) {
      const k = `${x},${y}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }
});
function corridorsIn(box) {
  const out = new Set();
  for (let y = Math.floor(box[1] / CELL); y <= Math.floor(box[3] / CELL); y++) {
    for (let x = Math.floor(box[0] / CELL); x <= Math.floor(box[2] / CELL); x++) {
      for (const i of grid.get(`${x},${y}`) ?? []) {
        const c = corridors[i];
        if (c.box[0] <= box[2] && c.box[2] >= box[0] && c.box[1] <= box[3] && c.box[3] >= box[1]) out.add(i);
      }
    }
  }
  return [...out];
}

// ---- 平面の図形の判定 ----
const insideRing = (p, ring) => {
  let r = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > p[1] !== by > p[1] && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) r = !r;
  }
  return r;
};
const insideTriangle = (p, a, b, c) => {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
const segmentsCross = (a, b, c, d) => {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
};
/** 通り道の形と、建物の三角形（上から見た形）が重なるか */
function overlaps(ring, tris) {
  for (const [a, b, c] of tris) {
    if (insideRing(a, ring) || insideRing(b, ring) || insideRing(c, ring)) return true;
    for (const p of ring) if (insideTriangle(p, a, b, c)) return true;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      if (segmentsCross(p, q, a, b) || segmentsCross(p, q, b, c) || segmentsCross(p, q, c, a)) return true;
    }
  }
  return false;
}

// ---- glb の読み書き ----
const decoderModule = await draco3d.createDecoderModule();
function parseGlb(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen).replace(/[\0 ]+$/, ''));
  const binStart = 20 + jsonLen + 8;
  const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));
  return { json, bin };
}
function buildGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jpad = (4 - (jsonBuf.length % 4)) % 4;
  if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]);
  const bpad = (4 - (bin.length % 4)) % 4;
  if (bpad) bin = Buffer.concat([bin, Buffer.alloc(bpad)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write('BIN\0', 4, 'latin1');
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
/** Draco で圧縮された三角形を開く：{ position, normal, id（建物の番号）, index } */
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
  const normal = ext.attributes.NORMAL !== undefined ? read('NORMAL', 3) : null;
  const id = read(idName, 1);
  const n = mesh.num_faces() * 3;
  const ptr = decoderModule._malloc(n * 4);
  decoder.GetTrianglesUInt32Array(mesh, n * 4, ptr);
  const index = new Uint32Array(decoderModule.HEAPU32.buffer, ptr, n).slice();
  decoderModule._free(ptr);
  decoderModule.destroy(mesh);
  decoderModule.destroy(decoder);
  return { position, normal, id, index };
}

// three-bvh-csg が内部で使うオプションの古さの警告が建物ごとに出るので、それだけ黙らせる
const warn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('BVH:')) return;
  warn(...args);
};
const evaluator = new Evaluator();
const stats = { removed: 0, supported: 0, unsupported: 0, platformBoxes: 0, bigRoofs: 0, landmarks: 0 };

/**
 * 大屋根の駅舎（PLATEAU では中の詰まった箱になっている）：ホームの箱として消さず、上の ROOF_THICKNESS m だけ残して
 * その下をくり抜き、柱で支えた屋根にする。建物の ID（gml_id）→ 名前
 */
const BIG_ROOFS = {
  'bldg_26d9fc02-3d05-4c22-b1b0-4af3cc17230e': '高輪ゲートウェイ駅',
};
const ROOF_THICKNESS = 2;
/** 置き換える建物のある場所（緯度, 経度）。線路が通らないタイルも調べるため */
const LANDMARK_AREAS = [
  [35.6812, 139.7661], // 東京駅
  [35.65842, 139.7453], // 東京タワー
  [33.59328, 130.35152], // 福岡タワー
  [33.5953, 130.3621], // みずほPayPayドーム福岡
  [34.7024, 135.4959], // 大阪ステーションシティ
  [34.70178, 135.49325], // イノゲート大阪
  [34.70049, 135.494], // JPタワー大阪
  [34.70532, 135.49823], // 阪急大阪梅田駅・阪急ターミナルビル
  [34.704378, 135.496202], // ヨドバシ梅田タワー
  [35.71024, 139.81085], // 東京スカイツリー
  [35.66089, 139.74049], // 麻布台ヒルズ森JPタワー
  [35.658385, 139.702242], // 渋谷スクランブルスクエア
  [35.65925, 139.70366], // 渋谷ヒカリエ
  [35.6844, 139.70312], // NTTドコモ代々木ビル
  [35.69159, 139.69694], // モード学園コクーンタワー
  [35.677837, 139.714508], // 国立競技場
  [35.69336, 139.74987], // 日本武道館
  [35.70559, 139.7519], // 東京ドーム
  [35.68106, 139.76381], // 丸ビル
  [35.6826, 139.7643], // 新丸ビル
  [35.67979, 139.76483], // JPタワー
  [35.67856, 139.76494], // 東京ビル TOKIA
  [35.68433, 139.7649], // 丸の内永楽ビルディング
  [35.67901, 139.76311], // 丸の内パークビルディング
  [35.67847, 139.76318], // 三菱一号館
  [35.6766, 139.7643], // 東京国際フォーラム（ガラス棟）
  [35.63552, 139.78726], // 有明テニスの森 インドアコート
  [35.629785, 139.79407], // 東京ビッグサイト 会議棟
  [35.63542, 139.78894], // 有明テニスの森 ショーコート
  [35.6768, 139.7636], // 東京国際フォーラム（ホール棟）
  // 東京ミッドタウン八重洲（工事中の箱が広いので、四隅のタイルも）
  [35.679417, 139.769533],
  [35.6785, 139.7685],
  [35.6797, 139.7685],
  [35.6785, 139.7699],
  [35.6797, 139.7699],
  [35.69269, 139.69612], // 損保ジャパン本社ビル
  [35.6895, 139.69172], // 東京都庁 第一本庁舎
  [35.68804, 139.69208], // 東京都庁 第二本庁舎
  [35.65643, 139.69958], // セルリアンタワー
  [35.65627, 139.69918], // セルリアンタワーの低層部
  [35.65909, 139.7046], // 渋谷アクシュ
  [35.65655, 139.70225], // 渋谷サクラステージ
  [35.6669, 139.74935], // 虎ノ門ヒルズ森タワー
  [35.66775, 139.75002], // 虎ノ門ヒルズ ビジネスタワー
  [35.66604, 139.7485], // 虎ノ門ヒルズ レジデンシャルタワー
  [35.66754, 139.74691], // 虎ノ門ヒルズ ステーションタワー
  [35.66221, 139.74037], // 麻布台ヒルズ レジデンス
  [35.71025, 139.81383], // 東京スカイツリーイーストタワー
];
const PLAZA_IDS = [
  'bldg_a16cfc59-110f-47f0-b622-2daff1b7c077',
  'bldg_0adb2df8-9ce1-4856-a6cc-0a56a98b1a33',
  'bldg_d789a902-8a89-4c5d-9766-23981f07b436',
  'bldg_3782687d-cc34-4fab-b3f6-728a90e5ac0a',
  'bldg_368795e4-4ea5-4aad-92d8-1524d8463f4a',
  'bldg_194048b0-76a1-4362-af9f-8022455c92f5',
  'bldg_1fcee33e-3608-4265-97b1-120f64967d35',
  'bldg_28d19c58-bee3-47e2-bf73-7e8777e6e915',
  'bldg_2e0506ad-1f0e-4177-8f15-72f634343529',
  'bldg_3b79ea3c-daf4-422a-beb5-20f6b4269d48',
  'bldg_46468e66-bf4d-45ea-8c3f-96a2ad476673',
  'bldg_48fab8e2-9b16-43c2-8f67-4d8c0b64bd63',
  'bldg_4fd39851-e5e6-4e0e-9a32-c2b50b8d96ab',
  'bldg_577c07aa-dd00-4792-b3da-686f72153228',
  'bldg_5fddebc8-9ca4-47d5-a9e0-8f02ab7df171',
  'bldg_5ffc2bd4-bd77-45b9-9c03-08520a0220ae',
  'bldg_6831738f-19f5-4d7b-8cb8-bb132543fd85',
  'bldg_6b06fc06-9eb4-4534-a7b4-792eff042182',
  'bldg_6da3a696-44fd-4b36-bb0b-0b4ea987fdfe',
  'bldg_74f37035-2f67-4adb-bf92-8e44b91988bf',
  'bldg_8ef4229b-0d7e-45a0-b59e-39f1d2c37ede',
  'bldg_9a631ab3-c153-4167-a85a-2c9703ee1169',
  'bldg_a144b000-fa6f-4761-b627-9100c8c978c1',
  'bldg_a167d98a-a942-42f3-9b71-a85483c86a89',
  'bldg_b6493c4f-d0dd-4017-8056-783ec82785df',
  'bldg_c2f71b82-6c33-450c-8be5-78a13b2de3a5',
  'bldg_c4fa981d-b14f-4cb0-821b-a95c0f98447f',
  'bldg_d25d1e98-1372-45fc-ba92-0b44b9d0021f',
  'bldg_d6daf92c-7567-4e57-a191-2f3059213dc8',
  'bldg_dd63f862-3392-481a-b590-7f1b3c1b8591',
  'bldg_f74cea45-e523-47f8-8cb0-afae9cd5497f',
];
/** 作り込んだ形に置き換える建物（src/world/landmarks/Landmarks.ts の gmlId と同じ）。丸ごと消す */
const REPLACED_BY_LANDMARK = new Set([
  // 福岡タワー（足元の低い建物の箱）
  'bldg_478d8445-d980-4744-a2ca-3dbb47074129',
  // 大阪ステーションシティ（大屋根と駅舎、ノースゲートビルディング、サウスゲートビルディング）・イノゲート大阪
  'bldg_9c2c736c-68d2-42b8-837a-dbdf9d7ca1a1',
  'bldg_a7a0f325-c271-44db-bced-7d3066780c65',
  'bldg_bfee20ad-5b64-48bc-8d47-fd764e89b70c',
  'bldg_4fbf020a-6f1c-4298-9136-d881ebd394f0',
  // JPタワー大阪の敷地（PLATEAU は建設前で、工事の低い箱）
  'bldg_ae9d724b-9bc9-4018-8a19-afa0d6c67666',
  'bldg_9b35a998-a8de-4f2d-adc0-319700b9a98d',
  'bldg_06c9047c-0fca-4326-8371-7f5de0a9df23',
  'bldg_190eee97-fae2-486a-b687-585094d8e475',
  'bldg_85df89cc-67ff-4c83-b1bd-ba7af740abf7',
  'bldg_8e9971c3-7dec-4735-a84d-0f6a5441ca7e',
  'bldg_2fafb2dd-f0ca-4482-bbdf-2ca87966ae42',
  'bldg_abe9dd72-62c1-4a8d-adde-ab310a9d04fe',
  'bldg_f440ed45-73ca-4d1b-a604-38256090e608',
  'bldg_e89cdb33-3bbc-44ea-97cf-f4870360a004',
  // 阪急大阪梅田駅（駅の一つの箱）と、南の端の低い屋根
  'bldg_8e4695fb-0c30-41d2-bd5e-37f2b10c467e',
  'bldg_d3da7c2c-766a-4cf1-9466-9b1ca4388465',
  // ヨドバシ梅田タワー（北の段と塔の箱、南の店の箱）
  'bldg_83d21bb8-3fbb-4b8f-b9e2-6385663a9e71',
  'bldg_30063c01-62e8-4b40-aa2d-36c823fdba1b',
  // みずほPayPayドーム福岡（ドームと周りのデッキをまとめた箱）
  'bldg_ec9150b2-0a27-4b64-a8bf-66cb714d46f0',
  // 東京駅丸の内駅舎
  'bldg_6af58cef-669e-4aca-bc01-355e870d1ad5',
  // 東京スカイツリータウン（ソラマチの平らな箱と、イーストタワーの低い箱）
  'bldg_58ab8c46-8369-49c4-86cf-6912bbc4efe1',
  'bldg_88940b1b-bf77-422a-bb1c-4c7379e3b91d',
  // 麻布台ヒルズ（森JPタワーの建設中の箱と、レジデンスの建設中の平らな板）
  'bldg_433bc5b3-db73-4644-ac24-a28d51b7ecd5',
  'bldg_af7335da-7542-44dd-964d-8cccd2b046ff',
  // 虎ノ門ヒルズ（森タワーの広場の板、ビジネスタワー、レジデンシャルタワー、ステーションタワーの建設中の板）
  'bldg_96c9d242-0fc6-4364-aeae-c21102718c35',
  'bldg_b292bc75-5708-4a3b-a7ba-7166c829d25a',
  'bldg_70d240ff-cce9-408b-99c4-51c90077e09f',
  'bldg_fbf728df-a130-4f36-88e4-7267715cbf34',
  // 渋谷スクランブルスクエア
  'bldg_7b006717-e9e6-4a94-8843-1f4ce13b2509',
  // 渋谷ヒカリエ
  'bldg_9ad5b600-360f-4627-8a89-fca39aad5576',
  // 渋谷サクラステージ（建設中の箱）
  'bldg_9442d303-7a48-4f81-aa67-b6ef05dbd43b',
  // 渋谷アクシュ（建設中の箱）
  'bldg_07a23c05-99d6-439c-bd98-f0f873f8a470',
  // セルリアンタワー（塔と西の低層部）
  'bldg_9c42ff7c-c8bf-456a-ada2-4c416a2dc965',
  'bldg_74b85a84-25d2-4a90-9545-c0138d394920',
  // 東京都庁 第一本庁舎・第二本庁舎
  'bldg_94caaf2f-dec2-41a7-8b0f-06ecd0fac6c7',
  'bldg_d0967cf5-1f32-48d1-9dda-11320828a076',
  // NTTドコモ代々木ビル
  'bldg_52945d0d-a897-4d55-b35c-a8bcca773e53',
  // 東京ビッグサイト 会議棟（エントランスプラザを含む箱）
  'bldg_8794832f-3815-445c-85de-dcb96f5ca6ea',
  // 有明テニスの森公園（インドアコートと、ショーコートの観客席）
  'bldg_36f9e4e1-0db4-44fe-9eb4-bb56fccc8468',
  'bldg_8cc798b7-35d6-4db1-b6ee-e8127114edf0',
  // 東京国際フォーラム（ガラス棟とホール棟）
  'bldg_861e9fa3-3ab6-443b-a1b0-6457f4d2e6dd',
  'bldg_8549e3e7-9619-49c2-9d3c-88d63fab4629',
  // 東京ミッドタウン八重洲（工事中の箱と、敷地の中の取り壊された古いビル）
  'bldg_0ea68be0-7326-47f3-9333-0a54da796ee7',
  'bldg_a53e5ff7-927b-407a-a8c8-c3ef361bd3de',
  'bldg_0acb7334-72a0-4d37-9051-728cf8489e20',
  'bldg_af729e27-c3bb-4d1a-b0d9-188b142347fa',
  'bldg_e67119f3-438e-45f9-90ab-d02a39c36605',
  'bldg_25d370de-2c35-457b-b756-3444a3d02eb3',
  // 丸の内ブリックスクエア（パークビルディングと三菱一号館）
  'bldg_66be0e64-a0f8-4974-9b90-cd0da900205d',
  'bldg_eca59423-ac27-46b4-8ccf-451b63652d52',
  // 丸の内永楽ビルディング
  'bldg_32ba8db3-4a5a-4eab-9b6a-a095bcdd165b',
  // 東京ビル TOKIA
  'bldg_5d5dd52d-bfdd-4bb6-9cbf-f865fb6946fb',
  // JPタワー（旧東京中央郵便局を含む）
  'bldg_f0028aa3-e666-4608-8b70-4e981a45d6b5',
  // 丸ビル・新丸ビル
  'bldg_a98349a1-56c0-4ec4-b22c-abe49301bd04',
  'bldg_104b6adf-6a30-41d4-9bdc-dc866513368e',
  // 東京ドーム
  'bldg_369e50ad-eaf1-4484-9d31-9802cc32ab5a',
  // 日本武道館
  'bldg_d4c6fe12-0eeb-4395-aecf-93c9b5a5c6ee',
  // 国立競技場
  'bldg_d840231c-8174-4086-9ca6-6417886b0fda',
  // モード学園コクーンタワー（東の広場まで含んだ箱）
  'bldg_4e9cedb2-e1b8-48f6-9c04-b862aca365f1',
  // 損保ジャパン本社ビル
  'bldg_81cf4164-d885-4134-81f8-5356472517ee',
  // 東京タワーの足元の建物（フットタウン。屋上の設備まで含んだ高い箱なので、作った形に置き換える）
  'bldg_7aff4a51-be8b-405b-abe4-ac489697cbc8',
  // 丸の内駅前広場の低い建物（地下への入口・換気塔など。広場を作り直すので消す）
  ...PLAZA_IDS,
]);

/** 上から見た点の並びを囲む、一番細い向きの長方形：{ ring（平面の m）, length, width } */
function orientedBox(pts) {
  let best = null;
  for (let deg = 0; deg < 180; deg += 5) {
    const c = Math.cos(deg * K);
    const s = Math.sin(deg * K);
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [x, y] of pts) {
      const a = x * c + y * s;
      const b = -x * s + y * c;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    if (!best || b1 - b0 < best.width) best = { c, s, a0, a1, b0, b1, width: b1 - b0, length: a1 - a0 };
  }
  const { c, s, a0, a1, b0, b1 } = best;
  const at = (a, b) => [a * c - b * s, a * s + b * c];
  return { ...best, ring: [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)] };
}

/** ホームの箱とみなす：線路の向きに細長く（長さ BOX_LENGTH m 以上、長さ/幅 BOX_ASPECT 以上）、低く（BOX_HEIGHT m 以下）、
 * 上から見た形のほとんど（BOX_COVERED 以上）が線路・ホームの通り道に入る建物 */
const BOX_LENGTH = 80;
const BOX_ASPECT = 2.5;
const BOX_HEIGHT = 25;
const BOX_COVERED = 0.75;
/** ホームの箱は、上端が一番低いレール面からこの高さ (m) 以上ある（高架下の店は、レール面より低い） */
const BOX_ABOVE_RAIL = 2;
function isPlatformBox(tris, hits, low, high) {
  if (high - low > BOX_HEIGHT) return false;
  // 線路より上まで伸びていないもの（高架下の店など）は違う
  const rail = Math.min(...hits.map((ci) => corridors[ci].bottom + CLEAR_BELOW));
  if (high < rail + BOX_ABOVE_RAIL) return false;
  const pts = tris.flat();
  const { length, width } = orientedBox(pts);
  if (length < BOX_LENGTH || length < width * BOX_ASPECT) return false;
  // 上から見た形のうち、通り道に入る割合（2m おきに調べる）
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const rings = hits.map((ci) => corridors[ci]);
  let inside = 0;
  let covered = 0;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 2) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 2) {
      const p = [x, y];
      if (!tris.some(([a, b, c]) => insideTriangle(p, a, b, c))) continue;
      inside++;
      if (rings.some((c) => p[0] >= c.box[0] && p[0] <= c.box[2] && p[1] >= c.box[1] && p[1] <= c.box[3] && insideRing(p, c.ring))) {
        covered++;
      }
    }
  }
  return inside > 0 && covered / inside >= BOX_COVERED;
}
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

/**
 * glb の中の建物を切り抜く。origin は glTF の座標（y が上）の原点の ECEF。
 * 切り抜いた建物があれば新しい glb を、無ければ null を返す
 */
function cutGlb(glb, origin, gmlIds = null) {
  const { json, bin } = parseGlb(glb);
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) return null;
  const prim = json.meshes[0].primitives[0];
  if (!prim.extensions?.KHR_draco_mesh_compression) return null;
  const idName = prim.attributes._BATCHID !== undefined ? '_BATCHID' : '_FEATURE_ID_0';
  const node = json.nodes.find((n) => n.mesh === 0) ?? {};
  const t = node.translation ?? [0, 0, 0];
  const { position, normal, id, index } = decodeDraco(json, bin, prim, idName);
  // glTF（y が上）→ ECEF
  const ecef = (i) => [
    origin[0] + t[0] + position[i * 3],
    origin[1] - (t[2] + position[i * 3 + 2]),
    origin[2] + t[1] + position[i * 3 + 1],
  ];
  // ECEF → glTF（y が上）のこのメッシュの座標
  const local = (e) => [e[0] - origin[0] - t[0], e[2] - origin[2] - t[1], -(e[1] - origin[1]) - t[2]];
  const ecefOf = (v) => [origin[0] + t[0] + v[0], origin[1] - (t[2] + v[2]), origin[2] + t[1] + v[1]];
  const nPoints = position.length / 3;
  const geo = new Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    const [lat, lon, h] = toGeodetic(...ecef(i));
    geo[i] = [lon * MX, lat * MY, h];
  }
  // 建物ごとの三角形
  const buildings = new Map();
  for (let f = 0; f < index.length; f += 3) {
    const b = id[index[f]];
    if (!buildings.has(b)) buildings.set(b, []);
    buildings.get(b).push(f);
  }
  const replaced = new Map(); // 建物の番号 → 切り抜いた後の BufferGeometry
  for (const [b, faces] of buildings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let low = Infinity;
    let high = -Infinity;
    const tris = faces.map((f) => [0, 1, 2].map((k) => geo[index[f + k]]));
    for (const tri of tris) {
      for (const [x, y, h] of tri) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    // 作り込んだ形に置き換える建物は、丸ごと消す
    if (REPLACED_BY_LANDMARK.has(gmlIds?.[b])) {
      const empty = new THREE.BufferGeometry();
      empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      empty.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
      replaced.set(b, empty);
      stats.landmarks++;
      continue;
    }
    // 建物に重なる通り道（高さも建物の範囲にかかるもの）
    const hits = corridorsIn([minX, minY, maxX, maxY]).filter((ci) => {
      const c = corridors[ci];
      return c.bottom < high && c.top > low && overlaps(c.ring, tris);
    });
    if (hits.length === 0) continue;
    // 大屋根の駅舎：上の ROOF_THICKNESS m を残して、その下を形ごとくり抜く（線路・ホームの通り道もその中に入る）
    const bigRoof = BIG_ROOFS[gmlIds?.[b]];
    let cutters = hits.map((ci) => corridors[ci]);
    if (bigRoof) {
      const box = orientedBox(tris.flat());
      const grow = (p) => {
        const cx = (box.ring[0][0] + box.ring[2][0]) / 2;
        const cy = (box.ring[0][1] + box.ring[2][1]) / 2;
        const d = Math.hypot(p[0] - cx, p[1] - cy) || 1;
        return [p[0] + ((p[0] - cx) / d) * 2, p[1] + ((p[1] - cy) / d) * 2];
      };
      cutters = [{ ring: box.ring.map(grow), bottom: low - 1, top: high - ROOF_THICKNESS }];
      stats.bigRoofs++;
    }
    // ホームと線路をまとめて1つの箱にした建物（東京駅の JR のホームなど）は、丸ごと消す
    // （ホーム・上屋は station-roofs、高架は線路の方で描く）
    if (!bigRoof && isPlatformBox(tris, hits, low, high)) {
      replaced.set(b, new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([], 3)));
      replaced.get(b).setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
      stats.platformBoxes++;
      if (process.env.SHOW_BOXES) {
        const c = tris[0][0];
        console.log(`  box ${(c[1] / MY).toFixed(5)},${(c[0] / MX).toFixed(5)} h ${(high - low).toFixed(1)}`);
      }
      continue;
    }
    // 建物の三角形を three の形に
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(faces.length * 9);
    const nor = new Float32Array(faces.length * 9);
    faces.forEach((f, j) => {
      for (let k = 0; k < 3; k++) {
        const v = index[f + k];
        pos.set(position.subarray(v * 3, v * 3 + 3), j * 9 + k * 3);
        if (normal) nor.set(normal.subarray(v * 3, v * 3 + 3), j * 9 + k * 3);
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (!normal) g.computeVertexNormals();
    let brush = new Brush(g);
    brush.updateMatrixWorld();
    for (const c of cutters) {
      const prism = prismGeometry(c, local);
      const cutter = new Brush(prism);
      cutter.updateMatrixWorld();
      try {
        const result = evaluator.evaluate(brush, cutter, SUBTRACTION);
        result.updateMatrixWorld();
        brush = result;
      } catch (e) {
        console.warn(`  切り抜きに失敗（建物 ${b}）: ${e.message}`);
      }
    }
    // 宙に浮いた部分を直す（薄い残りは消し、厚い部分には柱を立てる）
    const pg = brush.geometry.getAttribute('position');
    const geoOf = (v) => {
      const [lat, lon, h] = toGeodetic(...ecefOf([pg.getX(v), pg.getY(v), pg.getZ(v)]));
      return [lon * MX, lat * MY, h - low];
    };
    const pillarAt = (x, y, top) => pillarTriangles(x, y, low, top, local);
    const fixed = fixFloating(brush.geometry, geoOf, pillarAt);
    for (const k of Object.keys(fixed.result)) stats[k] += fixed.result[k];
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(fixed.pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(fixed.nor, 3));
    replaced.set(b, out);
  }
  if (replaced.size === 0) return null;

  // 新しい三角形の並び：切り抜かなかった建物はそのまま、切り抜いた建物は結果に差し替え
  const outPos = [];
  const outNor = [];
  const outId = [];
  for (const [b, faces] of buildings) {
    const g = replaced.get(b);
    if (g) {
      const p = g.getAttribute('position');
      const nm = g.getAttribute('normal');
      const idx = g.index;
      const count = idx ? idx.count : p.count;
      for (let i = 0; i < count; i++) {
        const v = idx ? idx.getX(i) : i;
        outPos.push(p.getX(v), p.getY(v), p.getZ(v));
        outNor.push(nm.getX(v), nm.getY(v), nm.getZ(v));
        outId.push(b);
      }
    } else {
      for (const f of faces) {
        for (let k = 0; k < 3; k++) {
          const v = index[f + k];
          outPos.push(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]);
          if (normal) outNor.push(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]);
          else outNor.push(0, 1, 0);
          outId.push(b);
        }
      }
    }
  }
  // 圧縮していない形で bin の後ろに足し、アクセサを付け替える
  const pieces = [bin];
  let offset = bin.length;
  const addView = (array) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) pieces.push(Buffer.alloc(pad));
    offset += pad;
    const buf = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    pieces.push(buf);
    offset += buf.length;
    return json.bufferViews.length - 1;
  };
  const vCount = outPos.length / 3;
  const posArray = new Float32Array(outPos);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vCount; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], posArray[i * 3 + k]);
      max[k] = Math.max(max[k], posArray[i * 3 + k]);
    }
  }
  const setAccessor = (accIndex, view, componentType, type, extra = {}) => {
    const acc = json.accessors[accIndex];
    acc.bufferView = view;
    acc.byteOffset = 0;
    acc.componentType = componentType;
    acc.count = vCount;
    acc.type = type;
    delete acc.min;
    delete acc.max;
    Object.assign(acc, extra);
  };
  setAccessor(prim.attributes.POSITION, addView(posArray), 5126, 'VEC3', { min, max });
  if (prim.attributes.NORMAL !== undefined) setAccessor(prim.attributes.NORMAL, addView(new Float32Array(outNor)), 5126, 'VEC3');
  const idAcc = json.accessors[prim.attributes[idName]];
  if (idAcc.componentType === 5126) setAccessor(prim.attributes[idName], addView(new Float32Array(outId)), 5126, 'SCALAR');
  else setAccessor(prim.attributes[idName], addView(new Uint32Array(outId)), 5125, 'SCALAR');
  // 三角形はそのまま並べたので、番号の並びは要らない
  if (prim.indices !== undefined) delete prim.indices;
  delete prim.extensions.KHR_draco_mesh_compression;
  if (Object.keys(prim.extensions).length === 0) delete prim.extensions;
  const stillDraco = json.meshes.some((m) => m.primitives.some((p) => p.extensions?.KHR_draco_mesh_compression));
  if (!stillDraco) {
    json.extensionsUsed = (json.extensionsUsed ?? []).filter((e) => e !== 'KHR_draco_mesh_compression');
    if (json.extensionsRequired) {
      json.extensionsRequired = json.extensionsRequired.filter((e) => e !== 'KHR_draco_mesh_compression');
      if (json.extensionsRequired.length === 0) delete json.extensionsRequired;
    }
  }
  const newBin = Buffer.concat(pieces);
  json.buffers = [{ byteLength: newBin.length + ((4 - (newBin.length % 4)) % 4) }];
  return { glb: buildGlb(json, newBin), buildings: replaced.size };
}

/** 通り道の柱（底 bottom から上 top まで、楕円体高）を、メッシュの座標で */
function prismGeometry(c, local) {
  // 反時計回りにそろえる
  let ring = c.ring;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (area < 0) ring = [...ring].reverse();
  const at = ([x, y], h) => local(toEcef(y / MY, x / MX, h));
  const bottom = ring.map((p) => at(p, c.bottom));
  const top = ring.map((p) => at(p, c.top));
  const pos = [];
  const tri = (a, b, d) => pos.push(...a, ...b, ...d);
  // 側面
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    tri(bottom[i], bottom[j], top[j]);
    tri(bottom[i], top[j], top[i]);
  }
  // 上と下（凹んだ形もあるので三角形に分ける）
  const contour = ring.map(([x, y]) => new THREE.Vector2(x, y));
  for (const [a, b, d] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    tri(top[a], top[b], top[d]);
    tri(bottom[a], bottom[d], bottom[b]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // 側面と上下の向きが外向きになっているか（体積が正か）を確かめ、逆なら面を裏返す
  let volume = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9);
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (volume < 0) {
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
  }
  // CSG は uv があるとそれも使う。法線だけにそろえる
  return g;
}


/**
 * 切り抜いた建物を、つながった部分ごとに分ける。geoOf(頂点) は [x, y（平面の m）, 建物の地面からの高さ]。
 * 返すのは部分ごとの { faces（三角形の先頭の番号）, low, high（高さの範囲） }
 */
function splitParts(geometry, geoOf) {
  const p = geometry.getAttribute('position');
  const count = geometry.index ? geometry.index.count : p.count;
  const vi = (i) => (geometry.index ? geometry.index.getX(i) : i);
  // 同じ位置の頂点を1つにまとめて、三角形のつながりをたどる
  const key = (v) => `${Math.round(p.getX(v) * 50)},${Math.round(p.getY(v) * 50)},${Math.round(p.getZ(v) * 50)}`;
  const ids = new Map();
  const parent = [];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const corner = (i) => {
    const k = key(vi(i));
    if (!ids.has(k)) {
      ids.set(k, parent.length);
      parent.push(parent.length);
    }
    return ids.get(k);
  };
  for (let i = 0; i < count; i += 3) {
    const a = corner(i);
    parent[find(corner(i + 1))] = find(a);
    parent[find(corner(i + 2))] = find(a);
  }
  // 切り抜いた面は元の面と頂点を共有しない（辺の途中に接する）ことがあるので、
  // 範囲（箱）が接している部分どうしもつながっているとみなす
  const boxes = new Map();
  for (let i = 0; i < count; i += 3) {
    const r = find(ids.get(key(vi(i))));
    if (!boxes.has(r)) boxes.set(r, [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    const b = boxes.get(r);
    for (let k = 0; k < 3; k++) {
      const v = vi(i + k);
      const q = [p.getX(v), p.getY(v), p.getZ(v)];
      for (let d = 0; d < 3; d++) {
        b[d] = Math.min(b[d], q[d]);
        b[d + 3] = Math.max(b[d + 3], q[d]);
      }
    }
  }
  const roots = [...boxes.keys()];
  const touch = (a, b) => [0, 1, 2].every((d) => a[d] <= b[d + 3] + 0.05 && b[d] <= a[d + 3] + 0.05);
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (find(roots[i]) !== find(roots[j]) && touch(boxes.get(roots[i]), boxes.get(roots[j]))) {
        parent[find(roots[j])] = find(roots[i]);
      }
    }
  }
  const parts = new Map();
  for (let i = 0; i < count; i += 3) {
    const r = find(ids.get(key(vi(i))));
    if (!parts.has(r)) parts.set(r, { faces: [], low: Infinity, high: -Infinity });
    const part = parts.get(r);
    part.faces.push(i);
    for (let k = 0; k < 3; k++) {
      const h = geoOf(vi(i + k))[2];
      part.low = Math.min(part.low, h);
      part.high = Math.max(part.high, h);
    }
  }
  return [...parts.values()];
}

/** 柱の立て方：太さ (m)、間隔 (m)、1つの部分あたりの最大の本数 */
const PILLAR_SIZE = 0.9;
const PILLAR_SPACING = 10;
/** 柱の候補を探す格子の細かさ (m)。線路の間のすき間を見つけられるよう細かめ */
const PILLAR_PROBE = 1;
const PILLAR_MAX = 30;
/** 柱は線路の中心からこれ以上離す (m)：車両の半分の幅 + 柱の半分の太さ + 余裕 */
const PILLAR_CLEAR = 1.5 + PILLAR_SIZE / 2 + 0.2;
/** これより低い所から始まる部分は地面に建っているとみなす (m) */
const GROUNDED = 1;
/** これより薄い浮いた部分は、切り抜きの残り（屋根の面だけ）として消す (m) */
const THIN = 1;
/** 柱を立てられない浮いた部分のうち、これより小さいもの (m) は切り抜きのかけらとして消す */
const SMALL = 8;

/**
 * 宙に浮いた部分を直す：薄いもの（屋根の面だけ残ったもの）は消し、厚いもの（線路をまたぐ駅舎など）には
 * 線路の通り道を避けて地面から柱を立てる。geoOf(頂点) は [x, y（平面の m）, 地面からの高さ]、
 * pillarAt(x, y, top) は柱の三角形（位置の配列）を返す。直した三角形の位置の配列と、数えた結果を返す
 */
function fixFloating(geometry, geoOf, pillarAt) {
  const p = geometry.getAttribute('position');
  const nm = geometry.getAttribute('normal');
  const vi = (i) => (geometry.index ? geometry.index.getX(i) : i);
  const pos = [];
  const nor = [];
  const result = { removed: 0, supported: 0, unsupported: 0 };
  for (const part of splitParts(geometry, geoOf)) {
    const floating = part.low > GROUNDED;
    if (floating && part.high - part.low < THIN) {
      result.removed++;
      continue;
    }
    const keep = () => {
      for (const i of part.faces) {
        for (let k = 0; k < 3; k++) {
          const v = vi(i + k);
          pos.push(p.getX(v), p.getY(v), p.getZ(v));
          nor.push(nm.getX(v), nm.getY(v), nm.getZ(v));
        }
      }
    };
    if (!floating) {
      keep();
      continue;
    }
    // 下向きの面（部分の底）の上から見た形の中に、格子状に柱の候補を置く
    const tris = part.faces.map((i) => [0, 1, 2].map((k) => geoOf(vi(i + k))));
    let bottoms = tris.filter((tri) => tri.every((q) => q[2] < part.low + 0.5));
    // 底の水平な面が無い（壁や斜めの屋根のかけら）なら、部分全体の上から見た形で探す
    if (bottoms.length === 0) bottoms = tris;
    const xs = bottoms.flat().map((q) => q[0]);
    const ys = bottoms.flat().map((q) => q[1]);
    let pillars = 0;
    const placed = [];
    for (let x = Math.min(...xs) + PILLAR_SIZE; x < Math.max(...xs) && pillars < PILLAR_MAX; x += PILLAR_PROBE) {
      for (let y = Math.min(...ys) + PILLAR_SIZE; y < Math.max(...ys) && pillars < PILLAR_MAX; y += PILLAR_PROBE) {
        // 立てた柱どうしは PILLAR_SPACING m 以上離す
        if (placed.some(([px, py]) => Math.hypot(px - x, py - y) < PILLAR_SPACING)) continue;
        if (!bottoms.some(([a, b, c]) => insideTriangle([x, y], a, b, c))) continue;
        // 列車にぶつからない所だけ（線路の中心から PILLAR_CLEAR m 以上。線路の間に立ててもよい）
        const blocked = corridorsIn([x - 3, y - 3, x + 3, y + 3]).some((ci) => {
          if (ci >= trackCorridors) return false;
          const [a, b, c, d] = corridors[ci].ring;
          const m1 = [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2];
          const m2 = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
          return segmentDistance([x, y], m1, m2) < PILLAR_CLEAR;
        });
        if (blocked) continue;
        for (const [px, py, pz, qx, qy, qz] of pillarAt(x, y, part.low + 0.2)) {
          pos.push(px, py, pz);
          nor.push(qx, qy, qz);
        }
        placed.push([x, y]);
        pillars++;
      }
    }
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (pillars > 0) {
      result.supported++;
      keep();
    } else if (size < SMALL) {
      // 柱を立てられない小さなかけらは消す
      result.removed++;
    } else {
      keep();
      result.unsupported++;
      if (process.env.SHOW_FLOATING) {
        const [x, y] = [xs.reduce((a, v) => a + v, 0) / xs.length, ys.reduce((a, v) => a + v, 0) / ys.length];
        console.log(
          `  no room: ${(y / MY).toFixed(5)},${(x / MX).toFixed(5)} bottom ${part.low.toFixed(1)} top ${part.high.toFixed(1)} ` +
            `size ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)}x${(Math.max(...ys) - Math.min(...ys)).toFixed(0)}m`,
        );
      }
    }
  }
  return { pos, nor, result };
}

/** 柱（四角柱）の三角形：(x, y) を中心に、建物の地面 ground から高さ top まで。[位置, 法線] の配列 */
function pillarTriangles(x, y, ground, top, local) {
  const h = PILLAR_SIZE / 2;
  const corners = [
    [x - h, y - h],
    [x + h, y - h],
    [x + h, y + h],
    [x - h, y + h],
  ];
  const at = ([cx, cy], z) => local(toEcef(cy / MY, cx / MX, ground + z));
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const quad = [at(a, -0.5), at(b, -0.5), at(b, top), at(a, top)];
    // 外向きの法線（メッシュの座標で）
    const e1 = quad[1].map((v, k) => v - quad[0][k]);
    const e2 = quad[3].map((v, k) => v - quad[0][k]);
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((v) => v / len);
    for (const [u, v, w] of [
      [0, 1, 2],
      [0, 2, 3],
    ]) {
      for (const q of [quad[u], quad[v], quad[w]]) out.push([...q, ...n]);
    }
  }
  return out;
}

// ---- タイルごとに処理する ----
/** タイルの中身を切り抜く。切り抜いたら新しい中身、そうでなければ null */
function cutContent(buf) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic === 'b3dm') {
    const ftJson = buf.readUInt32LE(12);
    const ftBin = buf.readUInt32LE(16);
    const btJson = buf.readUInt32LE(20);
    const btBin = buf.readUInt32LE(24);
    const ft = JSON.parse(buf.toString('utf8', 28, 28 + ftJson).trim() || '{}');
    const glbStart = 28 + ftJson + ftBin + btJson + btBin;
    const { json } = parseGlb(buf.subarray(glbStart));
    const rtc = json.extensions?.CESIUM_RTC?.center ?? ft.RTC_CENTER ?? [0, 0, 0];
    // 建物の ID（バッチテーブルの gml_id）
    const bt = btJson > 0 ? JSON.parse(buf.toString('utf8', 28 + ftJson + ftBin, 28 + ftJson + ftBin + btJson).trim() || '{}') : {};
    const result = cutGlb(buf.subarray(glbStart), rtc, Array.isArray(bt.gml_id) ? bt.gml_id : null);
    if (!result) return null;
    const head = buf.subarray(0, glbStart);
    const out = Buffer.concat([head, result.glb]);
    out.writeUInt32LE(out.length, 8);
    return { buf: out, buildings: result.buildings };
  }
  if (magic === 'glTF') {
    const result = cutGlb(buf, [0, 0, 0]);
    return result ? { buf: result.glb, buildings: result.buildings } : null;
  }
  return null;
}

/** tileset の中の、通り道にかかるかもしれないタイル（範囲が region のもの） */
function candidateUris(tileset) {
  const out = [];
  const walk = (node) => {
    const uri = node.content?.uri ?? node.content?.url;
    const region = node.content?.boundingVolume?.region ?? node.boundingVolume?.region;
    if (uri && region) {
      const [w, s, e, n] = region;
      const box = [(w / K) * MX, (s / K) * MY, (e / K) * MX, (n / K) * MY];
      const landmark = LANDMARK_AREAS.some(([lat, lon]) => lat >= s / K && lat <= n / K && lon >= w / K && lon <= e / K);
      if (landmark || corridorsIn(box).length > 0) out.push(uri);
    } else if (uri) out.push(uri);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tileset.root);
  return out;
}

const exists = (url) => stat(url).then(() => true, () => false);
const wards = JSON.parse(await readFile(new URL('wards.json', PLATEAU), 'utf8'));
// 区を指定しない時は、この地域の区だけ（別の地域の区を、この地域の線路で作り直すと、切り抜きが消える）
const only = process.argv.slice(2);
const inRegion = (w) => SETTINGS.prefectures.some((p) => w.startsWith(p));
let totalTiles = 0;
let totalBuildings = 0;
for (const ward of only.length > 0 ? wards.filter((w) => only.includes(w)) : wards.filter(inRegion)) {
  const tileset = JSON.parse(await readFile(new URL(`${ward}/tileset.json`, PLATEAU), 'utf8'));
  const uris = candidateUris(tileset);
  let tiles = 0;
  let buildings = 0;
  const started = Date.now();
  for (const uri of uris) {
    const file = new URL(`${ward}/${uri}`, PLATEAU);
    const original = new URL(`${ward}/${uri}`, ORIGINAL);
    // 元のタイル（前に書き換えていれば取っておいたもの）から作る
    const source = (await exists(original)) ? original : file;
    const result = cutContent(await readFile(source));
    if (!result) {
      // 前に切り抜いたが、今回は切り抜く所が無くなったタイルは元に戻す
      if (source === original) await copyFile(original, file);
      continue;
    }
    if (source === file) {
      await mkdir(new URL('./', original), { recursive: true });
      await copyFile(file, original);
    }
    await writeFile(file, result.buf);
    tiles++;
    buildings += result.buildings;
  }
  totalTiles += tiles;
  totalBuildings += buildings;
  console.log(
    `${ward}: ${uris.length} candidate tiles → ${tiles} tiles / ${buildings} buildings cut (${((Date.now() - started) / 1000).toFixed(0)}s)`,
  );
}
console.log(
  `total: ${totalTiles} tiles, ${totalBuildings} buildings (${stats.platformBoxes} platform boxes removed, ` +
    `${stats.bigRoofs} big station roofs, ${stats.landmarks} replaced by landmarks)`,
);
console.log(
  `floating parts: ${stats.removed} thin leftovers removed, ${stats.supported} supported by pillars, ` +
    `${stats.unsupported} without room for pillars`,
);
