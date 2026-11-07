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

const loaders = {
  tokyo: () => Promise.all([import('./stations.json'), import('./roadLabels.json')]),
  osaka: () => Promise.all([import('./osaka/stations.json'), import('./osaka/roadLabels.json')]),
  fukuoka: () => Promise.all([import('./fukuoka/stations.json'), import('./fukuoka/roadLabels.json')]),
  nagoya: () => Promise.all([import('./nagoya/stations.json'), import('./nagoya/roadLabels.json')]),
};
const [stationsModule, roadLabelsModule] = await loaders[REGION.id]();
export const STATIONS: StationEntry[] = stationsModule.default;
export const ROAD_LABELS: RoadLabelEntry[] = roadLabelsModule.default as RoadLabelEntry[];
