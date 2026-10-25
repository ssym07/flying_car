import { describe, expect, it } from 'vitest';
import { describeStation, distanceMeters, nearestStation, wardName } from './places';

describe('places', () => {
  it('東京駅の前なら一番近いのは東京駅', () => {
    const r = nearestStation(35.6812, 139.7671);
    expect(r?.station.name).toBe('東京');
    expect(r!.distance).toBeLessThan(300);
  });

  it('新宿の都庁あたりなら新宿系の駅が近い', () => {
    const r = nearestStation(35.6896, 139.6917);
    expect(r?.station.name).toMatch(/新宿|都庁前/);
  });

  it('距離はおおよそ正しい（東京〜新宿 約6km）', () => {
    const d = distanceMeters(35.6812, 139.7671, 35.6896, 139.7006);
    expect(d).toBeGreaterThan(5500);
    expect(d).toBeLessThan(6500);
  });

  it('近ければ「付近」、遠ければ距離を出す', () => {
    expect(describeStation('東京', 300, 700)).toBe('東京駅付近');
    expect(describeStation('東京', 1234, 700)).toBe('東京駅から1.2km');
  });

  it('区コードから区名を引ける', () => {
    expect(wardName('13101')).toBe('千代田区');
    expect(wardName('14100')).toBeNull();
  });
});
