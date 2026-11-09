import { PINS } from '../core/config';
import type { Region } from '../core/region';

/** 保存した地点（ピン）。全部の地域のものをまとめてブラウザ（localStorage）に保存する */
export interface Pin {
  id: string;
  region: Region['id'];
  name: string;
  lat: number;
  lon: number;
  /** ピンを立てた面（地面・屋上）の標高（ジオイド基準, m） */
  elevation: number;
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
    return Array.isArray(list) ? list.filter(isPin) : [];
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
    Number.isFinite(x.elevation)
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

export function renamePin(id: string, name: string): void {
  save(load().map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name) } : p)));
}

export function removePin(id: string): void {
  save(load().filter((p) => p.id !== id));
}
