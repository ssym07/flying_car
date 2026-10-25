export interface GameScene {
  enter(): void; // 遷移してきた時：初期化・読込
  exit(): void; // 抜ける時：リソース解放
  update(dt: number): void; // ロジック・物理
  render(alpha: number, frameDt: number): void; // 描画
}

/**
 * シーンをスタックで管理する。update/render は一番上のシーンだけに委譲する。
 * Pause のように下のシーンを残したまま重ねたい時は push / pop を使う。
 */
export class SceneManager {
  private stack: GameScene[] = [];

  get current(): GameScene | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** スタックを全部抜けて、新しいシーンに切り替える */
  change(scene: GameScene): void {
    while (this.stack.length > 0) this.stack.pop()!.exit();
    this.push(scene);
  }

  push(scene: GameScene): void {
    this.stack.push(scene);
    scene.enter();
  }

  pop(): void {
    this.stack.pop()?.exit();
  }

  update(dt: number): void {
    this.current?.update(dt);
  }

  render(alpha: number, frameDt: number): void {
    this.current?.render(alpha, frameDt);
  }
}
