import { describe, expect, it } from 'vitest';
import { searchStations } from './stationSearch';

const list = [
  { name: '品川', lat: 35.6285, lon: 139.7387 },
  { name: '北品川', lat: 35.6225, lon: 139.7393 },
  { name: '品川シーサイド', lat: 35.6085, lon: 139.7495 },
  { name: '新宿', lat: 35.6896, lon: 139.7006 },
  { name: '霞ケ関', lat: 35.6733, lon: 139.7507 },
];

describe('searchStations', () => {
  it('完全一致 → 前方一致 → 部分一致の順に並ぶ', () => {
    expect(searchStations('品川', null, list).map((s) => s.name)).toEqual(['品川', '品川シーサイド', '北品川']);
  });

  it('末尾の「駅」や空白は無視する', () => {
    expect(searchStations(' 新宿駅 ', null, list).map((s) => s.name)).toEqual(['新宿']);
  });

  it('ヶ と ケ を区別しない', () => {
    expect(searchStations('霞ヶ関', null, list).map((s) => s.name)).toEqual(['霞ケ関']);
  });

  it('同じ順位なら近い順', () => {
    const here = { lat: 35.6085, lon: 139.7495 };
    expect(searchStations('川', here, list).map((s) => s.name)).toEqual(['品川', '北品川', '品川シーサイド'].sort(
      (a, b) =>
        Math.hypot(list.find((s) => s.name === a)!.lat - here.lat, list.find((s) => s.name === a)!.lon - here.lon) -
        Math.hypot(list.find((s) => s.name === b)!.lat - here.lat, list.find((s) => s.name === b)!.lon - here.lon),
    ));
  });

  it('空の入力では何も出さない', () => {
    expect(searchStations('', null, list)).toEqual([]);
  });
});
