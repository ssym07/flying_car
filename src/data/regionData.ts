import { REGION } from '../core/region';

/**
 * 地域ごとの駅と道路名（scripts/fetch-stations.mjs・fetch-roads.mjs が作る）。
 * 東京は src/data の直下、大阪は src/data/osaka。選んだ地域の分だけ読む
 */
export interface StationEntry {
  name: string;
  lat: number;
  lon: number;
}
export interface RoadLabelEntry {
  name: string;
  lat: number;
  lon: number;
  /** 道の向き (rad) */
  b: number;
}

const osaka = REGION.id === 'osaka';
export const STATIONS: StationEntry[] = (
  osaka ? await import('./osaka/stations.json') : await import('./stations.json')
).default;
export const ROAD_LABELS: RoadLabelEntry[] = (
  osaka ? await import('./osaka/roadLabels.json') : await import('./roadLabels.json')
).default as RoadLabelEntry[];
