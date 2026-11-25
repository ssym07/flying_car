// 地形（ゲームと同じ国土地理院の標高タイル。data/cache/dem に保存する）。
// 線路・ホームの高さは「地面からの高さ」なので、ゲーム（Terrain.ts・groundProfile.ts）と同じ計算で地面の標高を求める。
// 使い方: await prepareDem(タイルのキー 'x/y' の集合) で読んでから heightAt などを使う
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { SETTINGS } from './region.mjs';

const K = Math.PI / 180;
const CACHE = new URL('../../data/cache/', import.meta.url);
export const DEM_ZOOM = 15;
const DEM_PX = 256;
const DEM_URLS = [
  'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png',
  'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png',
];
/** src/core/config.ts の TERRAIN.geoidHeight（地域ごと）・RAILWAYS（smoothRadius・cutFloorRadius・waterClearance）・WATER.surfaceHeight と同じ */
export const GEOID = SETTINGS.geoid;
export const SMOOTH_RADIUS = 60;
export const CUT_RADIUS = 20;
export const WATER_SURFACE = 0.8;
export const WATER_CLEARANCE = 2.5;

/** PNG（8bit の RGB・RGBA、1〜8bit のパレット）を RGB の配列にする */
export function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let depth = 8;
  let palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  // パレットで 1 画素が 8bit より小さい時（淡色地図の海だけのタイルなど）は、1 行のバイト数が少ない
  const stride = bpp === 1 ? Math.ceil((width * depth) / 8) : width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let k = 0; k < width * height; k++) {
    if (bpp === 1) {
      const x = k % width;
      const byte = out[Math.floor(k / width) * stride + Math.floor(x / perByte)];
      const index = (byte >> ((perByte - 1 - (x % perByte)) * depth)) & mask;
      rgb.set(palette.subarray(index * 3, index * 3 + 3), k * 3);
    }
    else rgb.set(out.subarray(k * bpp, k * bpp + 3), k * 3);
  }
  return rgb;
}
/** 標高タイル i（DEM_URLS の何番目か）を RGB に。data/cache/dem/{i}/{z}/{x}/{y}.png に保存する。タイルが無ければ null */
async function loadTile(i, z, x, y) {
  const file = new URL(`dem/${i}/${z}/${x}/${y}.png`, CACHE);
  let buf = await readFile(file).catch(() => null);
  if (!buf) {
    const res = await fetch(DEM_URLS[i].replace('{z}', z).replace('{x}', x).replace('{y}', y));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`標高タイルを取得できませんでした: ${res.status} ${z}/${x}/${y}`);
    buf = Buffer.from(await res.arrayBuffer());
    await mkdir(new URL('./', file), { recursive: true });
    await writeFile(file, buf);
  }
  const rgb = decodePng(buf);
  const h = new Float32Array(DEM_PX * DEM_PX);
  for (let k = 0; k < h.length; k++) {
    const v = rgb[k * 3] * 65536 + rgb[k * 3 + 1] * 256 + rgb[k * 3 + 2];
    h[k] = v === 2 ** 23 ? NaN : (v < 2 ** 23 ? v : v - 2 ** 24) * 0.01;
  }
  return h;
}
/**
 * 標高タイルを標高の配列に。Terrain.ts の fetchDem と同じく、5m メッシュの無い所（タイルごと無い・穴がある）は
 * 10m メッシュ（ズーム 14 までしか無いので、1つ粗いタイルの 1/4 を引き伸ばす）で補い、残りは周りの値で埋める
 */
async function loadDem(x, y) {
  const fine = await loadTile(0, DEM_ZOOM, x, y);
  if (fine && !fine.some(Number.isNaN)) return fine;
  const h = fine ?? new Float32Array(DEM_PX * DEM_PX).fill(NaN);
  const coarse = await loadTile(1, DEM_ZOOM - 1, x >> 1, y >> 1);
  if (coarse) {
    const ox = (x & 1) * (DEM_PX / 2);
    const oy = (y & 1) * (DEM_PX / 2);
    const at = (i, j) => coarse[Math.min(j, DEM_PX - 1) * DEM_PX + Math.min(i, DEM_PX - 1)];
    for (let j = 0; j < DEM_PX; j++) {
      for (let i = 0; i < DEM_PX; i++) {
        if (!Number.isNaN(h[j * DEM_PX + i])) continue;
        const u = ox + i / 2;
        const v = oy + j / 2;
        const i0 = Math.floor(u);
        const j0 = Math.floor(v);
        const fu = u - i0;
        const fv = v - j0;
        h[j * DEM_PX + i] =
          (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
      }
    }
  }
  // Terrain.ts の fillNoData と同じ
  for (let pass = 0; pass < 64; pass++) {
    let remaining = 0;
    let filled = 0;
    const src = h.slice();
    for (let py = 0; py < DEM_PX; py++) {
      for (let px = 0; px < DEM_PX; px++) {
        const idx = py * DEM_PX + px;
        if (!Number.isNaN(src[idx])) continue;
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= DEM_PX || ny >= DEM_PX) continue;
          const v = src[ny * DEM_PX + nx];
          if (!Number.isNaN(v)) (sum += v), count++;
        }
        if (count > 0) (h[idx] = sum / count), filled++;
        else remaining++;
      }
    }
    if (remaining === 0 || filled === 0) break;
  }
  for (let k = 0; k < h.length; k++) if (Number.isNaN(h[k])) h[k] = 0;
  return h;
}
const tileXY = (lat, lon) => {
  const n = 2 ** DEM_ZOOM;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n];
};
const dems = new Map();
/** 必要なタイル（'x/y' の集合）を先に読んでおく。読んだタイルの数を返す */
export async function prepareDem(keys) {
  const list = [...keys].filter((k) => !dems.has(k));
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < list.length) {
        const key = list[next++];
        const [x, y] = key.split('/').map(Number);
        dems.set(key, await loadDem(x, y));
      }
    }),
  );
  return dems.size;
}
/** 標高（ジオイド基準, m）。Terrain.heightAt と同じ補間 */
export function heightAt(lat, lon) {
  const [tx, ty] = tileXY(lat, lon);
  const heights = dems.get(`${Math.floor(tx)}/${Math.floor(ty)}`);
  if (!heights) return null;
  const x = Math.min(Math.max((tx - Math.floor(tx)) * DEM_PX - 0.5, 0), DEM_PX - 1);
  const y = Math.min(Math.max((ty - Math.floor(ty)) * DEM_PX - 0.5, 0), DEM_PX - 1);
  const xi = Math.min(Math.floor(x), DEM_PX - 2);
  const yi = Math.min(Math.floor(y), DEM_PX - 2);
  const fx = x - xi;
  const fy = y - yi;
  const at = (xx, yy) => heights[yy * DEM_PX + xx];
  return (at(xi, yi) * (1 - fx) + at(xi + 1, yi) * fx) * (1 - fy) + (at(xi, yi + 1) * (1 - fx) + at(xi + 1, yi + 1) * fx) * fy;
}
/** groundProfile.ts の smoothGround と同じ */
export function smoothGround(lat, lon, radius) {
  const step = radius / 2;
  const dLat = step / 111320;
  const dLon = step / (111320 * Math.cos(lat * K));
  const gy = lat / dLat;
  const gx = lon / dLon;
  const y0 = Math.floor(gy);
  const x0 = Math.floor(gx);
  const at = (iy, ix) => {
    let sum = 0;
    let n = 0;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        const h = heightAt((iy + a) * dLat, (ix + b) * dLon);
        if (h !== null) (sum += h), n++;
      }
    }
    return n > 0 ? sum / n : null;
  };
  const c = [at(y0, x0), at(y0, x0 + 1), at(y0 + 1, x0), at(y0 + 1, x0 + 1)];
  if (c.includes(null)) return null;
  const fy = gy - y0;
  const fx = gx - x0;
  return (c[0] * (1 - fx) + c[1] * fx) * (1 - fy) + (c[2] * (1 - fx) + c[3] * fx) * fy;
}
/** groundProfile.ts の stationGround と同じ */
export function stationGround(lat, lon, cut) {
  if (!cut) return smoothGround(lat, lon, SMOOTH_RADIUS);
  let low = null;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const h = heightAt(lat + (a * CUT_RADIUS) / 2 / 111320, lon + (b * CUT_RADIUS) / 2 / (111320 * Math.cos(lat * K)));
      if (h !== null) low = low === null ? h : Math.min(low, h);
    }
  }
  return low;
}
