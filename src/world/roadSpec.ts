import { ROADS } from '../core/config';

/**
 * 道の種別・車線数・一方通行から、車線数と車道・歩道の幅を決める（DOM を使わないので Web Worker からも使える）。
 * cls は roadTemplates.ts の RoadClass（0 = 幹線、1 = 2車線、2 = 生活道路）
 */
export function roadWidths(cls: number, taggedLanes: number, oneway: boolean): { lanes: number; width: number; sidewalk: number } {
  const spec = ROADS.classes[cls as 0 | 1 | 2];
  const local = cls === 2;
  const lanes = local ? 0 : Math.min(6, Math.max(1, taggedLanes || (oneway ? spec.lanes / 2 : spec.lanes)));
  const width = local ? spec.width : lanes * spec.laneWidth + spec.shoulder * 2;
  return { lanes, width, sidewalk: spec.sidewalk };
}
