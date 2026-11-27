/**
 * ゲームの中の時刻（日本時間）と、太陽・月の位置。
 *
 * - 開いた時は今の時刻・今日の日付で、時間は止まっている。画面の上の時刻のバー（src/ui/timePanel.ts）で
 *   再生すると speed（実際の 1 秒あたりのゲームの分）の速さで流れる。スライダーやキーでも動かせる
 * - 太陽の高さ・方位は、日付・時刻と地域の開始地点の緯度経度から計算する（NOAA の簡単な式。誤差は 1° 未満）
 * - 月は、太陽のほぼ反対側に置く（満ち欠けや本当の位置は追わない。夜の明かりと空の飾り）
 */

/** 日本時間の 0 時からの分 (0..1440) */
let minutes = nowMinutes();
/** 太陽の計算に使う日付（今日。時刻は minutes で上書きする） */
const today = new Date();
const listeners = new Set<(minutes: number) => void>();
/** 時間を流しているか、流す速さ（実際の 1 秒あたりのゲームの分。1/60 で実時間） */
let playing = false;
let speed = 1;

function notify(): void {
  for (const f of listeners) f(minutes);
}

function nowMinutes(): number {
  const d = new Date();
  // 日本時間（UTC+9）。端末の時間帯に関係なく日本の時刻にする
  return (((d.getUTCHours() + 9) % 24) * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60) % 1440;
}

export const timeOfDay = {
  get minutes(): number {
    return minutes;
  },
  /** 時刻を変える（範囲の外は 1 日でまわす）。onChange は時刻・再生・速さのどれが変わっても呼ぶ */
  set(value: number): void {
    const next = ((value % 1440) + 1440) % 1440;
    if (next === minutes) return;
    minutes = next;
    notify();
  },
  get playing(): boolean {
    return playing;
  },
  set playing(value: boolean) {
    if (value === playing) return;
    playing = value;
    notify();
  },
  get speed(): number {
    return speed;
  },
  set speed(value: number) {
    if (value === speed) return;
    speed = value;
    notify();
  },
  /** 毎フレーム呼ぶ（ポーズ中は呼ばない）。流している時だけ進める */
  tick(dt: number): void {
    if (playing && dt > 0) this.set(minutes + dt * speed);
  },
  /** 今の時刻に戻す */
  reset(): void {
    this.set(nowMinutes());
  },
  onChange(f: (minutes: number) => void): () => void {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

/** 「18:05」の形 */
export function formatTime(value: number): string {
  const m = Math.floor(value) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export interface SunPosition {
  /** 地平線からの高さ（度。負は地平線の下） */
  elevationDeg: number;
  /** 方位（北から時計回り、度） */
  azimuthDeg: number;
}

/**
 * 太陽の高さと方位。
 * @param jstMinutes 日本時間の 0 時からの分
 * @param date 日付（年・月・日だけ使う）
 */
export function sunPosition(jstMinutes: number, date: Date, latDeg: number, lonDeg: number): SunPosition {
  const D = Math.PI / 180;
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);
  const utcHours = jstMinutes / 60 - 9;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  // 均時差（分）と赤緯（ラジアン）
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  // 真太陽時（分）と時角
  const trueSolar = utcHours * 60 + eqTime + 4 * lonDeg;
  const hourAngle = (trueSolar / 4 - 180) * D;
  const lat = latDeg * D;
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / D;
  // 南から西回りの方位 → 北から時計回り
  const azimuth =
    Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / D + 180;
  return { elevationDeg: elevation, azimuthDeg: ((azimuth % 360) + 360) % 360 };
}

/** 今の時刻の太陽（今日の日付） */
export function currentSun(latDeg: number, lonDeg: number): SunPosition {
  return sunPosition(minutes, today, latDeg, lonDeg);
}

// 開発時だけ、コンソールや自動テストから時刻を変えられるようにする（window.__time.set(18 * 60)）
if (import.meta.env?.DEV && typeof window !== 'undefined') Object.assign(window, { __time: timeOfDay });
