import { describe, expect, it } from 'vitest';
import { formatTime, sunPosition } from './timeOfDay';

// 東京駅
const LAT = 35.6812;
const LON = 139.7671;

describe('sunPosition', () => {
  it('夏至の正午ごろは南の高い所（約 78°）', () => {
    const s = sunPosition(11 * 60 + 43, new Date(2026, 5, 21), LAT, LON);
    expect(s.elevationDeg).toBeGreaterThan(76);
    expect(s.elevationDeg).toBeLessThan(79);
    expect(Math.abs(s.azimuthDeg - 180)).toBeLessThan(10);
  });

  it('冬至の正午ごろは低い（約 31°）', () => {
    const s = sunPosition(11 * 60 + 38, new Date(2026, 11, 22), LAT, LON);
    expect(s.elevationDeg).toBeGreaterThan(29.5);
    expect(s.elevationDeg).toBeLessThan(32.5);
  });

  it('春分の朝は東、夕方は西、真夜中は地平線の下', () => {
    const day = new Date(2026, 2, 20);
    const morning = sunPosition(8 * 60, day, LAT, LON);
    const evening = sunPosition(16 * 60, day, LAT, LON);
    const midnight = sunPosition(0, day, LAT, LON);
    expect(morning.azimuthDeg).toBeGreaterThan(90);
    expect(morning.azimuthDeg).toBeLessThan(135);
    expect(evening.azimuthDeg).toBeGreaterThan(225);
    expect(evening.azimuthDeg).toBeLessThan(270);
    expect(midnight.elevationDeg).toBeLessThan(-40);
  });
});

describe('formatTime', () => {
  it('時:分', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(18 * 60 + 5)).toBe('18:05');
    expect(formatTime(1439.9)).toBe('23:59');
  });
});
