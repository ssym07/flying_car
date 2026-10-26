// 駅の上屋・ホームの高さを、そばを通る線路の高さ（public/rail-tracks）に合わせて public/station-roofs を書き換える。
// 使い方: node scripts/build-platforms.mjs（fetch-station-roofs.mjs と build-rail-heights.mjs の後に実行）
//
// - ホーム（種類 2）：床の高さ = 線路の高さ + PLATFORM_HEIGHT
// - 上屋（種類 1）：屋根の高さ = ホームの床 + CANOPY_HEIGHT
// - 駅舎（種類 0）：そのまま
import { readdir, readFile, writeFile } from 'node:fs/promises';

const ROOF_DIR = new URL('../public/station-roofs/15/', import.meta.url);
const RAIL_DIR = new URL('../public/rail-tracks/15/', import.meta.url);
/** ホームの床の、レール面からの高さ (m) */
const PLATFORM_HEIGHT = 1.1;
/** 上屋の屋根の、ホームの床からの高さ (m) */
const CANOPY_HEIGHT = 4.5;
/** この距離 (m) 以内の線路の高さを見る */
const SEARCH = 12;

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

// 線路の点（高さ付き）を格子に入れる
const CELL = 0.0005;
const grid = new Map();
for (const x of await readdir(RAIL_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, RAIL_DIR))) {
    const { t } = JSON.parse(await readFile(new URL(`${x}/${f}`, RAIL_DIR), 'utf8'));
    for (const [, coords, offsets] of t) {
      const pts = decode(coords);
      for (let i = 0; i < pts.length; i++) {
        // 線分の途中も拾えるよう、点の間を 4m ごとに補う
        const [lat, lon] = pts[i];
        const add = (la, lo, h) => {
          const k = `${Math.floor(la / CELL)},${Math.floor(lo / CELL)}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([la, lo, h]);
        };
        add(lat, lon, offsets[i] / 10);
        if (i === 0) continue;
        const [plat, plon] = pts[i - 1];
        const d = Math.hypot((lat - plat) * 111320, (lon - plon) * 90400);
        const n = Math.floor(d / 4);
        for (let k = 1; k < n; k++) {
          const t = k / n;
          add(plat + (lat - plat) * t, plon + (lon - plon) * t, (offsets[i - 1] + (offsets[i] - offsets[i - 1]) * t) / 10);
        }
      }
    }
  }
}

/** 多角形のまわり SEARCH m 以内の線路の高さの最大（無ければ 0 = 地上） */
function trackHeightNear(ring) {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lat, lon] of ring) {
    s = Math.min(s, lat);
    n = Math.max(n, lat);
    w = Math.min(w, lon);
    e = Math.max(e, lon);
  }
  const dLat = SEARCH / 111320;
  const dLon = SEARCH / 90400;
  let best = null;
  for (let y = Math.floor((s - dLat) / CELL); y <= Math.floor((n + dLat) / CELL); y++) {
    for (let x = Math.floor((w - dLon) / CELL); x <= Math.floor((e + dLon) / CELL); x++) {
      for (const [la, lo, h] of grid.get(`${y},${x}`) ?? []) {
        if (la < s - dLat || la > n + dLat || lo < w - dLon || lo > e + dLon) continue;
        if (best === null || h > best) best = h;
      }
    }
  }
  return best ?? 0;
}

let platforms = 0;
let roofs = 0;
for (const x of await readdir(ROOF_DIR)) {
  for (const f of await readdir(new URL(`${x}/`, ROOF_DIR))) {
    const file = new URL(`${x}/${f}`, ROOF_DIR);
    const data = JSON.parse(await readFile(file, 'utf8'));
    for (const rec of data) {
      const [kind, , , coords] = rec;
      if (kind === 0) continue;
      const floor = trackHeightNear(decode(coords)) + PLATFORM_HEIGHT;
      rec[1] = Math.round((kind === 2 ? floor : floor + CANOPY_HEIGHT) * 10) / 10;
      if (kind === 2) platforms++;
      else roofs++;
    }
    await writeFile(file, JSON.stringify(data));
  }
}
console.log(`${platforms} platforms, ${roofs} canopies adjusted`);
