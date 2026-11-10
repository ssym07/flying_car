import { REGION, REGIONS, type Region } from '../core/region';
import type { Station } from '../world/places';

/** どの地域の駅か付きの駅（ホームの駅検索） */
export interface RegionStation extends Station {
  region: Region['id'];
}

const loaders: Record<Region['id'], () => Promise<{ default: Station[] }>> = {
  kanto: () => import('./stations.json'),
  kinki: () => import('./kinki/stations.json'),
  kyushu: () => import('./kyushu/stations.json'),
  chubu: () => import('./chubu/stations.json'),
};

let all: Promise<RegionStation[]> | null = null;

/**
 * 全部の地域の駅。初めて呼んだ時に読む（ホームの駅検索を使う時だけ）。
 * 今の地域を先に並べる（同じ名前の駅が別の地域にもある時、今の地域の駅を上に出す）
 */
export function loadAllStations(): Promise<RegionStation[]> {
  all ??= Promise.all(
    (Object.keys(REGIONS) as Region['id'][])
      .sort((a, b) => Number(b === REGION.id) - Number(a === REGION.id))
      .map(async (region) => (await loaders[region]()).default.map((s) => ({ ...s, region }))),
  ).then((lists) => lists.flat());
  return all;
}
