/**
 * 飛行機のような計器盤（画面の下中央）。Canvas に毎フレーム描く。
 *
 * - 上の段：左 = 速度計（km/h、最高速 300 から先は赤い帯）、中央 = 姿勢指示器（上が空・下が地面、傾きの目盛りと機体の印）、右 = 高度計（m）
 * - 下の段：姿勢指示器の下に方位計（回る方位盤と、固定した機体の印・現在の方位の数字）
 * 表示はクリーム色の目盛りに黒い文字盤、まわりに暗い灰色の枠とねじ
 */
export interface InstrumentValues {
  /** 速度 (km/h) */
  speed: number;
  /** 標高 (m) */
  altitude: number;
  /** 機首の上下 (rad、上が +) */
  pitch: number;
  /** 傾き (rad、右に傾くと +) */
  roll: number;
  /** 方位 (rad、北 = 0・東 = π/2) */
  heading: number;
}

const INK = '#f1e6cf';
const INK_DIM = 'rgba(241, 230, 207, 0.55)';
const FACE = '#0e0f11';
const BEZEL = '#2b2e33';
const ACCENT = '#f29a3a';
/** 速度計の目盛りの上限 (km/h) と、目盛りの角度の範囲 */
const SPEED_MAX = 350;
const SPEED_SWEEP = (320 / 180) * Math.PI;

export class Instruments {
  private readonly root: HTMLDivElement;
  private readonly gauges: Record<'speed' | 'attitude' | 'altitude' | 'heading', CanvasRenderingContext2D>;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'instruments';
    const make = (name: string) => {
      const canvas = document.createElement('canvas');
      canvas.className = `instrument instrument-${name}`;
      this.root.appendChild(canvas);
      return canvas.getContext('2d')!;
    };
    this.gauges = {
      speed: make('speed'),
      attitude: make('attitude'),
      altitude: make('altitude'),
      heading: make('heading'),
    };
    parent.appendChild(this.root);
  }

  update(v: InstrumentValues): void {
    for (const [name, g] of Object.entries(this.gauges)) {
      // 表示の大きさ（CSS）に合わせて描く面の解像度を決める
      const canvas = g.canvas;
      const size = Math.round(canvas.clientWidth * window.devicePixelRatio);
      if (size === 0) continue;
      if (canvas.width !== size) canvas.width = canvas.height = size;
      g.setTransform(size / 200, 0, 0, size / 200, 0, 0);
      g.clearRect(0, 0, 200, 200);
      bezel(g);
      if (name === 'speed') drawSpeed(g, v.speed);
      else if (name === 'attitude') drawAttitude(g, v.pitch, v.roll);
      else if (name === 'altitude') drawAltitude(g, v.altitude);
      else drawHeading(g, v.heading);
      screws(g);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

// ---- 共通：座標は 200 × 200、中心 (100, 100) ----

/** 四角い枠と、丸い文字盤（ふちに橙色の照明のにじみ） */
function bezel(g: CanvasRenderingContext2D): void {
  g.fillStyle = BEZEL;
  roundRect(g, 4, 4, 192, 192, 18);
  g.fill();
  g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  g.lineWidth = 2;
  g.stroke();
  const glow = g.createRadialGradient(100, 100, 70, 100, 100, 88);
  glow.addColorStop(0, FACE);
  glow.addColorStop(0.85, '#191513');
  glow.addColorStop(1, 'rgba(242, 154, 58, 0.55)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(100, 100, 86, 0, Math.PI * 2);
  g.fill();
}

/** 枠の四隅のねじ */
function screws(g: CanvasRenderingContext2D): void {
  for (const [x, y] of [
    [16, 16],
    [184, 16],
    [16, 184],
    [184, 184],
  ]) {
    g.fillStyle = '#1a1c1f';
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#4a4e55';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x - 3.5, y);
    g.lineTo(x + 3.5, y);
    g.stroke();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 中心から角度 a（真上 = 0、時計回り）の向きに、半径 r0〜r1 の線 */
function tick(g: CanvasRenderingContext2D, a: number, r0: number, r1: number, width: number, color = INK): void {
  const s = Math.sin(a);
  const c = -Math.cos(a);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(100 + s * r0, 100 + c * r0);
  g.lineTo(100 + s * r1, 100 + c * r1);
  g.stroke();
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color = INK): void {
  g.fillStyle = color;
  g.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

/** 細長い針（中心から角度 a、長さ len、太さ w） */
function needle(g: CanvasRenderingContext2D, a: number, len: number, w: number, tail = 14): void {
  g.save();
  g.translate(100, 100);
  g.rotate(a);
  g.fillStyle = INK;
  g.beginPath();
  g.moveTo(-w / 2, tail);
  g.lineTo(-w / 2, -len + w * 1.5);
  g.lineTo(0, -len);
  g.lineTo(w / 2, -len + w * 1.5);
  g.lineTo(w / 2, tail);
  g.closePath();
  g.fill();
  g.restore();
}

function hub(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#3a3d42';
  g.beginPath();
  g.arc(100, 100, 6, 0, Math.PI * 2);
  g.fill();
}

// ---- 速度計：0〜350 km/h を、真上から時計回りに 320° で ----
function drawSpeed(g: CanvasRenderingContext2D, speed: number): void {
  // 0 が真上、時計回りに増える
  const angle = (kmh: number) => (Math.min(kmh, SPEED_MAX) / SPEED_MAX) * SPEED_SWEEP;
  // 巡航域の緑と、高速域の赤い帯
  const arc = (from: number, to: number, color: string) => {
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(100, 100, 74, angle(from) - Math.PI / 2, angle(to) - Math.PI / 2);
    g.stroke();
  };
  arc(60, 240, '#3fae5a');
  arc(240, 300, '#e0b23a');
  arc(300, 350, '#d8433a');
  for (let k = 0; k <= SPEED_MAX; k += 10) {
    const major = k % 50 === 0;
    tick(g, angle(k), major ? 64 : 70, 78, major ? 2.6 : 1.4);
    if (major) {
      const a = angle(k);
      label(g, `${k}`, 100 + Math.sin(a) * 50, 100 - Math.cos(a) * 50, 14);
    }
  }
  label(g, 'AIRSPEED', 100, 66, 9, INK_DIM);
  label(g, 'km/h', 100, 77, 9, INK_DIM);
  // 数字の窓
  g.fillStyle = '#050505';
  roundRect(g, 74, 124, 52, 20, 3);
  g.fill();
  label(g, `${Math.round(speed)}`.padStart(3, '0'), 100, 135, 15, ACCENT);
  needle(g, angle(Math.max(0, speed)), 72, 5);
  hub(g);
}

// ---- 姿勢指示器 ----
function drawAttitude(g: CanvasRenderingContext2D, pitch: number, roll: number): void {
  /** 1° あたりの上下のずれ */
  const PX = 2.4;
  const deg = (r: number) => (r * 180) / Math.PI;
  g.save();
  g.beginPath();
  g.arc(100, 100, 82, 0, Math.PI * 2);
  g.clip();
  // 空と地面：傾きで回し、機首の上下でずらす
  g.translate(100, 100);
  g.rotate(-roll);
  const shift = deg(pitch) * PX;
  g.fillStyle = '#9bb4c4';
  g.fillRect(-200, -400 + shift, 400, 400);
  g.fillStyle = '#7a5532';
  g.fillRect(-200, shift, 400, 400);
  g.strokeStyle = '#f4efe2';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-200, shift);
  g.lineTo(200, shift);
  g.stroke();
  // ピッチの目盛り（5° ごと、10° ごとに数字）
  for (let p = -30; p <= 30; p += 5) {
    if (p === 0) continue;
    const y = shift - p * PX;
    const w = p % 10 === 0 ? 26 : 12;
    g.strokeStyle = '#f4efe2';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(-w, y);
    g.lineTo(w, y);
    g.stroke();
    if (p % 10 === 0) {
      g.fillStyle = '#f4efe2';
      g.font = '700 10px "Helvetica Neue", Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`${Math.abs(p)}`, -w - 10, y);
      g.fillText(`${Math.abs(p)}`, w + 10, y);
    }
  }
  g.restore();

  // 傾きの目盛り（上の弧、10・20・30・45・60°）と、今の傾きを指す三角
  for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const a = (b * Math.PI) / 180;
    if (b === 0) {
      triangle(g, 0, 70, 82, INK);
      continue;
    }
    tick(g, a, 72, Math.abs(b) % 30 === 0 ? 84 : 79, 2.2, '#f4efe2');
  }
  triangle(g, -roll, 68, 58, ACCENT);
  // 機体の印（固定）
  g.strokeStyle = ACCENT;
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(58, 100);
  g.lineTo(84, 100);
  g.lineTo(92, 108);
  g.lineTo(100, 100);
  g.lineTo(108, 108);
  g.lineTo(116, 100);
  g.lineTo(142, 100);
  g.stroke();
  g.lineCap = 'butt';
  g.fillStyle = ACCENT;
  g.beginPath();
  g.arc(100, 100, 2.5, 0, Math.PI * 2);
  g.fill();
}

/** 角度 a の向きの、半径 tip を先端・base を底辺とする三角 */
function triangle(g: CanvasRenderingContext2D, a: number, tip: number, base: number, color: string): void {
  g.save();
  g.translate(100, 100);
  g.rotate(a);
  g.fillStyle = color;
  g.beginPath();
  const dir = tip < base ? 1 : -1;
  g.moveTo(0, -tip);
  g.lineTo(-6 * dir, -base);
  g.lineTo(6 * dir, -base);
  g.closePath();
  g.fill();
  g.restore();
}

// ---- 高度計：長い針 = 1周 1000m（目盛り 0〜9 = ×100m）、短い針 = 1周 10000m、窓に数字 ----
function drawAltitude(g: CanvasRenderingContext2D, altitude: number): void {
  for (let k = 0; k < 50; k++) {
    const a = (k / 50) * Math.PI * 2;
    const major = k % 5 === 0;
    tick(g, a, major ? 66 : 72, 78, major ? 2.6 : 1.3);
    if (major) label(g, `${k / 5}`, 100 + Math.sin(a) * 54, 100 - Math.cos(a) * 54, 16);
  }
  label(g, 'ALT', 100, 68, 11, INK_DIM);
  label(g, '×100 m', 100, 79, 8, INK_DIM);
  g.fillStyle = '#050505';
  roundRect(g, 73, 124, 54, 20, 3);
  g.fill();
  label(g, `${Math.round(altitude)}`.padStart(4, '0'), 100, 135, 15, ACCENT);
  const a = Math.max(0, altitude);
  needle(g, ((a % 10000) / 10000) * Math.PI * 2, 46, 8, 8);
  needle(g, ((a % 1000) / 1000) * Math.PI * 2, 74, 4.5);
  hub(g);
}

// ---- 方位計：方位盤が回り、上の印が今の向き ----
function drawHeading(g: CanvasRenderingContext2D, heading: number): void {
  g.save();
  g.translate(100, 100);
  g.rotate(-heading);
  g.translate(-100, -100);
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const major = k % 2 === 0;
    tick(g, a, major ? 66 : 71, 78, major ? 2 : 1.2);
    if (k % 6 === 0) {
      const n = (k / 6) * 3;
      const text = n === 0 ? 'N' : n === 9 ? 'E' : n === 18 ? 'S' : n === 27 ? 'W' : `${n}`;
      g.save();
      g.translate(100 + Math.sin(a) * 54, 100 - Math.cos(a) * 54);
      g.rotate(a);
      label(g, text, 0, 0, text.length === 1 && n % 9 === 0 ? 16 : 13, n % 9 === 0 ? ACCENT : INK);
      g.restore();
    }
  }
  g.restore();
  // 上の固定の印（今の向き）と、中央の機体の印
  triangle(g, 0, 80, 90, INK);
  g.fillStyle = INK;
  g.save();
  g.translate(100, 100);
  g.beginPath();
  g.moveTo(0, -22);
  g.lineTo(3, -12);
  g.lineTo(3, -4);
  g.lineTo(20, 4);
  g.lineTo(20, 8);
  g.lineTo(3, 4);
  g.lineTo(3, 14);
  g.lineTo(8, 18);
  g.lineTo(8, 21);
  g.lineTo(0, 19);
  g.lineTo(-8, 21);
  g.lineTo(-8, 18);
  g.lineTo(-3, 14);
  g.lineTo(-3, 4);
  g.lineTo(-20, 8);
  g.lineTo(-20, 4);
  g.lineTo(-3, -4);
  g.lineTo(-3, -12);
  g.closePath();
  g.fill();
  g.restore();
  // 方位の数字（3桁）
  const degrees = Math.round((((heading * 180) / Math.PI) % 360 + 360) % 360) % 360;
  g.fillStyle = '#050505';
  roundRect(g, 76, 124, 48, 18, 3);
  g.fill();
  label(g, `${degrees}`.padStart(3, '0'), 100, 134, 13, ACCENT);
}
