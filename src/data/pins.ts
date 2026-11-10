import { PINS } from '../core/config';
import { regionId, type Region } from '../core/region';

/** ピンの色（選べる色。既定は赤） */
export const PIN_COLORS = {
  red: { label: '赤', hex: '#e53935' },
  blue: { label: '青', hex: '#1e88e5' },
  green: { label: '緑', hex: '#43a047' },
  yellow: { label: '黄', hex: '#fdd835' },
  black: { label: '黒', hex: '#26282c' },
  white: { label: '白', hex: '#f5f5f5' },
} as const;
export type PinColor = keyof typeof PIN_COLORS;
export const DEFAULT_PIN_COLOR: PinColor = 'red';

/** ピンの色（前に保存した、色の無いピンは赤） */
export function pinHex(pin: Pick<Pin, 'color'>): string {
  return PIN_COLORS[pin.color ?? DEFAULT_PIN_COLOR]?.hex ?? PIN_COLORS.red.hex;
}

/** 保存した地点（ピン）。全部の地域のものをまとめてブラウザ（localStorage）に保存する */
export interface Pin {
  id: string;
  region: Region['id'];
  name: string;
  lat: number;
  lon: number;
  /**
   * ピンを立てた面（地面・屋上）の標高（ジオイド基準, m）。
   * ミニマップから保存した地点は高さが分からないので null（地形を読んだら地面に立てる）
   */
  elevation: number | null;
  /** 色（無ければ赤） */
  color?: PinColor;
  /** 立てた時刻（ミリ秒） */
  created: number;
}

type Listener = (pins: readonly Pin[]) => void;

let pins: Pin[] = [];
pins = load();
const listeners = new Set<Listener>();

function load(): Pin[] {
  try {
    const raw = localStorage.getItem(PINS.storageKey);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    // 前の地域の名前（tokyo・osaka・fukuoka・nagoya）で保存したピンは、今の名前（kanto・kinki・kyushu・chubu）にする
    return Array.isArray(list)
      ? list.filter(isPin).flatMap((p) => {
          const region = regionId(p.region);
          return region ? [{ ...p, region }] : [];
        })
      : [];
  } catch {
    // 保存できない環境（プライベートウィンドウ・サイトのデータを消した時など）でも、遊んでいる間は使える
    return pins;
  }
}

function isPin(p: unknown): p is Pin {
  const x = p as Pin;
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    typeof x.region === 'string' &&
    Number.isFinite(x.lat) &&
    Number.isFinite(x.lon) &&
    (x.elevation === null || Number.isFinite(x.elevation))
  );
}

/** 変える時は保存し直された分（別のタブで足したピン）を読み直してから変える */
function save(next: Pin[]): void {
  pins = next;
  try {
    localStorage.setItem(PINS.storageKey, JSON.stringify(pins));
  } catch {
    // 保存できなくても、この画面の間は使える
  }
  for (const l of listeners) l(pins);
}

/** 名前の前後の空白を除き、長さを抑える。空なら fallback */
function cleanName(name: string, fallback: string): string {
  const n = name.trim().slice(0, PINS.maxNameLength);
  return n === '' ? fallback : n;
}

export function allPins(): readonly Pin[] {
  return pins;
}

/** ピンが増えた・減った・名前が変わった時に呼ぶ。外す関数を返す */
export function onPinsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addPin(pin: Omit<Pin, 'id' | 'created'>): Pin {
  const created = Date.now();
  const id = `${created.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const p: Pin = { ...pin, name: cleanName(pin.name, 'ピン'), id, created };
  save([...load(), p]);
  return p;
}

/** 名前と色を変える */
export function updatePin(id: string, name: string, color: PinColor): void {
  save(load().map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name), color } : p)));
}

export function removePin(id: string): void {
  save(load().filter((p) => p.id !== id));
}
