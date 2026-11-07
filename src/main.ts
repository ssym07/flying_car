import * as THREE from 'three';
import './ui/overlay.css';
import type { GameContext } from './core/context';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
import { takeAutoStart } from './core/region';
import { SceneManager } from './core/SceneManager';
import { FlightScene } from './scenes/FlightScene';
import { LoadingScene } from './scenes/LoadingScene';
import { PauseScene } from './scenes/PauseScene';
import { TitleScene } from './scenes/TitleScene';
import { World } from './world/World';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.querySelector('#app')!.appendChild(renderer.domElement);

const overlay = document.querySelector<HTMLElement>('#overlay')!;
const attribution = document.createElement('div');
attribution.className = 'attribution';
attribution.textContent =
  '出典：国土交通省 Project PLATEAU（3D都市モデル）／国土地理院（地理院タイル・標高タイル・全国最新写真・逆ジオコーダ）／駅：© OpenStreetMap contributors';
overlay.appendChild(attribution);

/** 手元に加工済みの建物データがある区（public/plateau/wards.json。無ければ空） */
async function loadLocalWards(): Promise<Set<string>> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}plateau/wards.json`);
    // ファイルが無いと開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return new Set();
    return new Set((await res.json()) as string[]);
  } catch {
    return new Set();
  }
}

const scenes = new SceneManager();
const input = new Input();
input.attachPointer(renderer.domElement);
const ctx: GameContext = {
  world: new World(renderer, await loadLocalWards()),
  input,
  scenes,
  overlay,
  go: {
    title: () => scenes.change(new TitleScene(ctx)),
    loading: () => scenes.change(new LoadingScene(ctx)),
    flight: () => scenes.change(new FlightScene(ctx)),
    pause: () => {
      if (scenes.current) scenes.push(new PauseScene(ctx, scenes.current));
    },
  },
};

// 開発時だけ、コンソールや自動テストから状態を覗けるようにする
if (import.meta.env.DEV) Object.assign(window, { __ctx: ctx, __THREE: THREE });

// 地域を選んで読み込み直した直後は、タイトルを飛ばして読込へ
if (takeAutoStart()) ctx.go.loading();
else ctx.go.title();
new GameLoop(
  (dt) => scenes.update(dt),
  (alpha, frameDt) => scenes.render(alpha, frameDt),
).start();
