import type { Terrain } from './Terrain';

/**
 * 線路・高速道路を置く高さを決めるための、地形の高さの取り方。
 * - smoothGround：場所だけで決まる均した地面（並んで走る線どうしが同じ高さになる）
 * - cutFloor：掘割の底（細かい標高の一番低い所）
 */

/** 掘割の底の高さ：各点の前後 radius m の細かい標高の最小を、さらに前後で均したもの */
export function cutFloor(
  terrain: Terrain,
  samples: Array<[number, number]>,
  s: number[],
  radius: number,
): Array<number | null> {
  const dem = samples.map(([lat, lon]) => terrain.heightAt(lat, lon));
  const r = radius;
  const low = dem.map((_, i) => {
    let m: number | null = null;
    for (let j = 0; j < dem.length; j++) {
      if (Math.abs(s[j] - s[i]) > r || dem[j] === null) continue;
      m = m === null ? dem[j] : Math.min(m, dem[j]!);
    }
    return m;
  });
  return low.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < low.length; j++) {
      if (Math.abs(s[j] - s[i]) > r || low[j] === null) continue;
      sum += low[j]!;
      n++;
    }
    return n > 0 ? sum / n : null;
  });
}

/**
 * 線に沿った高さの、取れなかった所（null：まだ読んでいないチャンク）を、線の上で一番近い取れた値で埋める。
 * どこも取れなければ null
 */
export function fillGaps(values: Array<number | null>): number[] | null {
  const n = values.length;
  // 前から見た一番近い取れた点と、後ろから見た一番近い取れた点（番号）
  const before = new Int32Array(n).fill(-1);
  const after = new Int32Array(n).fill(-1);
  for (let i = 0, k = -1; i < n; i++) before[i] = k = values[i] !== null ? i : k;
  for (let i = n - 1, k = -1; i >= 0; i--) after[i] = k = values[i] !== null ? i : k;
  if (before[n - 1] < 0) return null;
  return values.map((v, i) => {
    if (v !== null) return v;
    const a = before[i];
    const b = after[i];
    return values[a < 0 || (b >= 0 && b - i < i - a) ? b : a]!;
  });
}

/**
 * (lat, lon) のまわり ±radius m の格子点（固定の格子に揃える）の地形の平均。
 * cache を渡すと、格子点ごとの平均を使い回す（同じ半径の呼び出しだけで共有する）
 */
export function smoothGround(
  terrain: Terrain,
  lat: number,
  lon: number,
  radius: number,
  cache: Map<string, number | null> | null = null,
): number | null {
  const step = radius / 2;
  const dLat = step / 111320;
  const dLon = step / (111320 * Math.cos((lat * Math.PI) / 180));
  // 格子を固定して、近くの点どうしは同じ格子点を使うようにする（その間は線形に補間）
  const gy = lat / dLat;
  const gx = lon / dLon;
  const y0 = Math.floor(gy);
  const x0 = Math.floor(gx);
  const at = (iy: number, ix: number) => {
    if (!cache) return average(iy, ix);
    const k = `${iy},${ix}`;
    let v = cache.get(k);
    if (v === undefined) cache.set(k, (v = average(iy, ix)));
    return v;
  };
  const average = (iy: number, ix: number) => {
    let sum = 0;
    let n = 0;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        const h = terrain.heightAt((iy + a) * dLat, (ix + b) * dLon);
        if (h !== null) (sum += h), n++;
      }
    }
    return n > 0 ? sum / n : null;
  };
  const c00 = at(y0, x0);
  const c01 = at(y0, x0 + 1);
  const c10 = at(y0 + 1, x0);
  const c11 = at(y0 + 1, x0 + 1);
  if (c00 === null || c01 === null || c10 === null || c11 === null) return null;
  const fy = gy - y0;
  const fx = gx - x0;
  return (c00 * (1 - fx) + c01 * fx) * (1 - fy) + (c10 * (1 - fx) + c11 * fx) * fy;
}

/**
 * 駅の地面の高さ：駅の基準点 (lat, lon) で決まる1つの値。駅の線路とホームはどちらもこれを基準にして、高さをそろえる。
 * 掘割の駅は、基準点のまわり ±radius m の細かい標高の一番低い所（掘割の底）
 */
export function stationGround(
  terrain: Terrain,
  lat: number,
  lon: number,
  cut: boolean,
  smoothRadius: number,
  cutRadius: number,
): number | null {
  if (!cut) return smoothGround(terrain, lat, lon, smoothRadius);
  const dLat = cutRadius / 2 / 111320;
  const dLon = cutRadius / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  let low: number | null = null;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const h = terrain.heightAt(lat + a * dLat, lon + b * dLon);
      if (h !== null) low = low === null ? h : Math.min(low, h);
    }
  }
  return low;
}
