import * as THREE from 'three';
import './ui/overlay.css';
import type { GameContext } from './core/context';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
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
attribution.textContent = '出典：国土交通省 Project PLATEAU（3D都市モデル）';
overlay.appendChild(attribution);

const scenes = new SceneManager();
const ctx: GameContext = {
  world: new World(renderer),
  input: new Input(),
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
if (import.meta.env.DEV) Object.assign(window, { __ctx: ctx });

ctx.go.title();
new GameLoop(
  (dt) => scenes.update(dt),
  (alpha, frameDt) => scenes.render(alpha, frameDt),
).start();
