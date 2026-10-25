import stations from '../data/stations.json';
import { WARDS } from '../data/wards';

export interface Station {
  name: string;
  lat: number;
  lon: number;
}

const EARTH_RADIUS = 6371000;
const WARD_NAMES = new Map(WARDS.map((w) => [w.code, w.name]));

/** 2点間の距離 (m)。数km程度なら正距円筒近似で十分 */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * EARTH_RADIUS;
}

/** 一番近い駅とその距離 (m) */
export function nearestStation(
  lat: number,
  lon: number,
  list: readonly Station[] = stations,
): { station: Station; distance: number } | null {
  let best: { station: Station; distance: number } | null = null;
  for (const station of list) {
    const distance = distanceMeters(lat, lon, station.lat, station.lon);
    if (!best || distance < best.distance) best = { station, distance };
  }
  return best;
}

/** 「東京駅付近」「東京駅から1.2km」のような表示用の文字列 */
export function describeStation(name: string, distance: number, nearThreshold: number): string {
  if (distance <= nearThreshold) return `${name}駅付近`;
  return `${name}駅から${(distance / 1000).toFixed(1)}km`;
}

/** 市区町村コード → 区名（23区以外は null） */
export function wardName(code: string): string | null {
  return WARD_NAMES.get(code) ?? null;
}
