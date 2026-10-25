/**
 * キー状態を記録するだけ。車を動かすのは update の中。
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      // Space でのページスクロールなどを防ぐ
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    // フォーカスが外れたらキーが押しっぱなしにならないよう全解除
    target.addEventListener('blur', () => {
      this.down.clear();
      this.pressed.clear();
    });
  }

  isDown(codes: readonly string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** 押された瞬間を1回だけ受け取る（受け取ったら消える） */
  consumePress(codes: readonly string[]): boolean {
    const hit = codes.find((c) => this.pressed.has(c));
    if (hit === undefined) return false;
    for (const c of codes) this.pressed.delete(c);
    return true;
  }

  /** シーン切替時などに、溜まった「押された」を捨てる */
  clearPresses(): void {
    this.pressed.clear();
  }

  /** -1..1 の軸入力 */
  axis(negative: readonly string[], positive: readonly string[]): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }
}
