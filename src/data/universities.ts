import { dataUrl, REGIONS, type Region } from '../core/region';
import type { Station } from '../world/places';

/** 駅検索で探せる大学・短大（scripts/fetch-schools.mjs が作る schools.json の、検索に出す名前のあるもの） */
export interface University extends Station {
  kind: 'university';
}

const cache = new Map<Region['id'], Promise<University[]>>();

/**
 * その地域の大学・短大。初めて呼んだ時に読む。ファイルが無い・読めない時は空。
 * 名前は検索に出す名前（キャンパスの名前、または同じ名前の大学を分ける「（〇〇駅付近）」付き）
 */
export function loadUniversities(region: Region['id']): Promise<University[]> {
  let list = cache.get(region);
  if (!list) {
    list = fetch(dataUrl(`${REGIONS[region].dataDir}schools.json`))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { s: [string, number, number, number, string?][] } | null) =>
        (data?.s ?? [])
          .filter((r) => r[4])
          .map(([, lat, lon, , label]) => ({ name: label!, lat, lon, kind: 'university' as const })),
      )
      .catch(() => []);
    cache.set(region, list);
  }
  return list;
}
