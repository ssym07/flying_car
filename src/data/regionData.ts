import { REGION } from '../core/region';

/**
 * 地域ごとの駅と道路名（scripts/fetch-stations.mjs・fetch-roads.mjs が作る）。
 * 関東は src/data の直下、近畿は src/data/kinki。選んだ地域の分だけ読む
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
  kanto: () => Promise.all([import('./stations.json'), import('./roadLabels.json')]),
  kinki: () => Promise.all([import('./kinki/stations.json'), import('./kinki/roadLabels.json')]),
  kyushu: () => Promise.all([import('./kyushu/stations.json'), import('./kyushu/roadLabels.json')]),
  chubu: () => Promise.all([import('./chubu/stations.json'), import('./chubu/roadLabels.json')]),
  hokkaido: () => Promise.all([import('./hokkaido/stations.json'), import('./hokkaido/roadLabels.json')]),
};
const [stationsModule, roadLabelsModule] = await loaders[REGION.id]();
export const STATIONS: StationEntry[] = stationsModule.default;
export const ROAD_LABELS: RoadLabelEntry[] = roadLabelsModule.default as RoadLabelEntry[];
