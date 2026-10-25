import type { World } from '../world/World';
import type { Input } from './Input';
import type { SceneManager } from './SceneManager';

/** 各シーンに渡す共有オブジェクト */
export interface GameContext {
  world: World;
  input: Input;
  scenes: SceneManager;
  /** HTML オーバーレイの親要素 */
  overlay: HTMLElement;
  /** シーン遷移（循環 import を避けるため main.ts で組み立てる） */
  go: {
    title(): void;
    loading(): void;
    flight(): void;
    pause(): void;
  };
}

/** オーバーレイに画面を1枚追加して返す */
export function mountScreen(ctx: GameContext, className: string, html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `screen ${className}`;
  el.innerHTML = html;
  ctx.overlay.appendChild(el);
  return el;
}
