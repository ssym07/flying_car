/** 前回受け取ってからのマウス操作 */
export interface PointerState {
  /** ドラッグで動いた量 (px) */
  dx: number;
  dy: number;
  /** ホイールの回転量（deltaY の合計） */
  wheel: number;
  /** いまドラッグ中か */
  dragging: boolean;
}

/**
 * キーとマウスの状態を記録するだけ。車やカメラを動かすのは update / render の中。
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly pointer: PointerState = { dx: 0, dy: 0, wheel: 0, dragging: false };

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
      this.pointer.dragging = false;
    });
  }

  /** element 上のドラッグ・ホイールを記録する（3D の画面に付ける） */
  attachPointer(element: HTMLElement): void {
    element.style.cursor = 'grab';
    element.addEventListener('pointerdown', (e) => {
      this.pointer.dragging = true;
      element.setPointerCapture(e.pointerId);
      element.style.cursor = 'grabbing';
    });
    element.addEventListener('pointermove', (e) => {
      if (!this.pointer.dragging) return;
      this.pointer.dx += e.movementX;
      this.pointer.dy += e.movementY;
    });
    const end = () => {
      this.pointer.dragging = false;
      element.style.cursor = 'grab';
    };
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    element.addEventListener(
      'wheel',
      (e) => {
        this.pointer.wheel += e.deltaY;
        // ページのスクロールやピンチでの拡大を防ぐ
        e.preventDefault();
      },
      { passive: false },
    );
    // 右ドラッグでも回せるように、右クリックメニューを出さない
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 溜まったマウス操作を受け取る（受け取ったら移動量はリセット） */
  consumePointer(): PointerState {
    const state = { ...this.pointer };
    this.pointer.dx = 0;
    this.pointer.dy = 0;
    this.pointer.wheel = 0;
    return state;
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
