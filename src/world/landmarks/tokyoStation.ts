import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 東京駅丸の内駅舎（1914年竣工・2012年復原）。写真と寸法図を参考に、手続き的に形を作る。
 * 座標は「駅舎の座標」：x = 駅舎の長い向き（南の端が 0、北へ +）、y = 地面からの高さ、z = 正面（丸の内側）へ +。
 * 寸法：全長は PLATEAU の建物に合わせる（約 320m）。軒の高さ 17m、切妻部の頂部 23m、中央部 28m、ドーム 35m。
 *
 * 部品：赤れんがの本体（白い石の帯・窓）、スレートの屋根、南北のドーム（八角形の胴とドーム屋根・頂部の飾り）、
 * 中央部、切妻の棟、角の小さなドーム、ドームの下の入口の庇。
 */
export interface StationParts {
  /** 赤れんがの壁（u = 横の長さ / 柱の間隔、v = 高さ / 1階ぶん） */
  brick: THREE.BufferGeometry;
  /** スレートの屋根・ドーム */
  roof: THREE.BufferGeometry;
  /** 白い石・飾り（帯、ドームの頂部、庇の柱） */
  trim: THREE.BufferGeometry;
  /** 入口の庇（金属） */
  canopy: THREE.BufferGeometry;
}

/** 窓の並びの間隔 (m) と、1階ぶんの高さ (m)。壁の画像はこの大きさで1枚 */
export const BAY = 4;
export const STOREY = 5.6;

const EAVE = 17;
const DEPTH = 20;

export function buildTokyoStation(length: number): StationParts {
  const brick: THREE.BufferGeometry[] = [];
  const roof: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const canopy: THREE.BufferGeometry[] = [];
  // 寸法図（北が左）の位置を、南の端からの割合にする
  const at = (fromNorth: number) => length * (1 - fromNorth);
  const southDome = at(0.82);
  const northDome = at(0.18);
  const center = at(0.5);

  // 本体：全長の箱（軒 17m）と、寄棟の屋根
  brick.push(walls([[0, -DEPTH / 2], [length, -DEPTH / 2], [length, DEPTH / 2], [0, DEPTH / 2]], 0, EAVE));
  roof.push(hipRoof(0, length, -DEPTH / 2 - 0.6, DEPTH / 2 + 0.6, EAVE, 5));
  // 軒の白い帯と、各階の石の帯
  trim.push(band(0, length, DEPTH / 2, EAVE - 0.6, 0.6, 0.5));
  trim.push(band(0, length, -DEPTH / 2, EAVE - 0.6, 0.6, 0.5));

  // 切妻部（少し前に出た棟、頂部 23m）と、角の小さなドーム
  for (const f of [0.04, 0.3, 0.4, 0.6, 0.7, 0.96]) {
    const x = at(f);
    const w = f === 0.04 || f === 0.96 ? 16 : 12;
    brick.push(walls(rect(x - w / 2, x + w / 2, -DEPTH / 2 - 1.5, DEPTH / 2 + 2.5), 0, EAVE + 2));
    roof.push(gableRoof(x - w / 2 - 0.5, x + w / 2 + 0.5, -DEPTH / 2 - 2, DEPTH / 2 + 3, EAVE + 2, 4));
    trim.push(band(x - w / 2, x + w / 2, DEPTH / 2 + 2.5, EAVE + 1.4, 0.6, 0.6));
    for (const side of [-1, 1]) {
      const tx = x + (side * w) / 2;
      trim.push(turret(tx, DEPTH / 2 + 2.5, EAVE + 2, 1.6));
    }
  }

  // 中央部（28m）：前後に張り出した棟と、急な屋根
  brick.push(walls(rect(center - 18, center + 18, -DEPTH / 2 - 3, DEPTH / 2 + 5), 0, 21));
  roof.push(hipRoof(center - 18.6, center + 18.6, -DEPTH / 2 - 3.6, DEPTH / 2 + 5.6, 21, 7));
  trim.push(band(center - 18, center + 18, DEPTH / 2 + 5, 20.4, 0.6, 0.6));
  // 中央の入口のアーチ（白い石の枠）
  trim.push(box(center - 5, center + 5, 0, 8, DEPTH / 2 + 5, DEPTH / 2 + 5.4));

  // 南北のドーム：八角形の胴（れんが）、ドーム屋根、頂部の飾り。ドームの前には入口の庇
  for (const x of [southDome, northDome]) {
    const r = 16;
    brick.push(octagon(x, 0, r, 0, EAVE + 5));
    trim.push(octagonRing(x, 0, r + 0.4, EAVE + 4.2, 0.8));
    trim.push(octagonRing(x, 0, r + 0.6, EAVE - 0.6, 0.6));
    // ドーム：少しつぶした半球（八角形）と、上の灯籠・尖塔
    const dome = new THREE.SphereGeometry(r * 0.92, 8, 6, Math.PI / 8, Math.PI * 2, 0, Math.PI / 2)
      .scale(1, 0.72, 1)
      .translate(x, EAVE + 5, 0);
    roof.push(dome);
    trim.push(new THREE.CylinderGeometry(1.8, 2.2, 2.4, 8).translate(x, EAVE + 5 + r * 0.66 + 1.2, 0));
    roof.push(new THREE.ConeGeometry(2.2, 2.4, 8).translate(x, EAVE + 5 + r * 0.66 + 3.6, 0));
    trim.push(new THREE.CylinderGeometry(0.15, 0.25, 6, 6).translate(x, EAVE + 5 + r * 0.66 + 7, 0));
    // ドームの4方の小さな丸窓の飾り（時計の代わりの白い円盤）
    for (let k = 0; k < 8; k += 2) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      trim.push(
        new THREE.CylinderGeometry(1.4, 1.4, 0.4, 12)
          .rotateX(Math.PI / 2)
          .rotateY(-a + Math.PI / 2)
          .translate(x + Math.cos(a) * r * 0.86, EAVE + 5 + r * 0.25, Math.sin(a) * r * 0.86),
      );
    }
    // 入口の庇：ドームの前、高さ 4.5m の平らな屋根と柱
    canopy.push(box(x - 14, x + 14, 4.3, 4.8, DEPTH / 2 + 6, DEPTH / 2 + 16));
    for (const px of [x - 12, x - 4, x + 4, x + 12]) trim.push(box(px - 0.2, px + 0.2, 0, 4.3, DEPTH / 2 + 15, DEPTH / 2 + 15.4));
  }

  // 1階の下の御影石の帯（足元）
  trim.push(band(0, length, DEPTH / 2, 0, 1.0, 0.3));
  trim.push(band(0, length, -DEPTH / 2, 0, 1.0, 0.3));

  const merge = (list: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(list.map((x) => prepare(x)))!;
    g.computeVertexNormals();
    return g;
  };
  return { brick: merge(brick), roof: merge(roof), trim: merge(trim), canopy: merge(canopy) };
}

/** 位置・法線・uv だけの、番号の無い形にそろえる（まとめるため） */
function prepare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (!['position', 'uv'].includes(name)) out.deleteAttribute(name);
  if (!out.getAttribute('uv')) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  }
  return out;
}

function rect(x0: number, x1: number, z0: number, z1: number): Array<[number, number]> {
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
}

/** 多角形（上から見て反時計回り, [x, z]）の壁。u = 壁に沿った長さ / BAY、v = 高さ / STOREY */
function walls(poly: Array<[number, number]>, y0: number, y1: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bx - ax, bz - az);
    const u0 = s / BAY;
    const u1 = (s + len) / BAY;
    s += len;
    // 外向きになるよう、a→b を右回りに見て張る
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    uv.push(u0, y0 / STOREY, u1, y0 / STOREY, u1, y1 / STOREY, u0, y0 / STOREY, u1, y1 / STOREY, u0, y1 / STOREY);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** 寄棟の屋根：長方形の上に、高さ rise の棟（短い辺から rise ぶん内側まで） */
function hipRoof(x0: number, x1: number, z0: number, z1: number, y: number, rise: number): THREE.BufferGeometry {
  const zc = (z0 + z1) / 2;
  const inset = Math.min(rise, (x1 - x0) / 2);
  const r0 = new THREE.Vector3(x0 + inset, y + rise, zc);
  const r1 = new THREE.Vector3(x1 - inset, y + rise, zc);
  const c = [
    new THREE.Vector3(x0, y, z0),
    new THREE.Vector3(x1, y, z0),
    new THREE.Vector3(x1, y, z1),
    new THREE.Vector3(x0, y, z1),
  ];
  return faces([
    [c[0], r0, r1, c[1]],
    [c[1], r1, c[2]],
    [c[2], r1, r0, c[3]],
    [c[3], r0, c[0]],
  ]);
}

/** 切妻の屋根：棟は正面へ向かう向き（z）。前後の妻は三角の壁 */
function gableRoof(x0: number, x1: number, z0: number, z1: number, y: number, rise: number): THREE.BufferGeometry {
  const xc = (x0 + x1) / 2;
  const a = new THREE.Vector3(xc, y + rise, z0);
  const b = new THREE.Vector3(xc, y + rise, z1);
  const c = [
    new THREE.Vector3(x0, y, z0),
    new THREE.Vector3(x1, y, z0),
    new THREE.Vector3(x1, y, z1),
    new THREE.Vector3(x0, y, z1),
  ];
  return faces([
    [c[0], a, b, c[3]],
    [c[1], c[2], b, a],
    [c[0], c[1], a],
    [c[3], b, c[2]],
  ]);
}

/** 面（3点か4点、どちら向きでもよい。材質は両面描き）をまとめる */
function faces(list: THREE.Vector3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const f of list) {
    for (let i = 1; i + 1 < f.length; i++) for (const p of [f[0], f[i], f[i + 1]]) pos.push(p.x, p.y, p.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** 壁の前に少し出た、横に長い帯（白い石）。z は壁の面、正面側なら + へ、裏側なら - へ出す */
function band(x0: number, x1: number, z: number, y: number, h: number, out: number): THREE.BufferGeometry {
  const s = Math.sign(z) || 1;
  return box(x0 - out, x1 + out, y, y + h, z - s * 0.1, z + s * out);
}

/** 八角形の胴（中心 x, z・外接円の半径 r）。u・v は walls と同じ */
function octagon(x: number, z: number, r: number, y0: number, y1: number): THREE.BufferGeometry {
  const poly: Array<[number, number]> = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    poly.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
  }
  return walls(poly, y0, y1);
}

function octagonRing(x: number, z: number, r: number, y: number, h: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, h, 8, 1, false, Math.PI / 8).translate(x, y + h / 2, z);
}

/** 角の小さな塔：細い胴と、小さなドーム、先端の飾り */
function turret(x: number, z: number, y: number, r: number): THREE.BufferGeometry {
  return mergeGeometries([
    prepare(new THREE.CylinderGeometry(r, r, 2.5, 8).translate(x, y + 1.25, z)),
    prepare(new THREE.SphereGeometry(r * 1.05, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, y + 2.5, z)),
    prepare(new THREE.ConeGeometry(0.2, 1.6, 6).translate(x, y + 2.5 + r + 0.8, z)),
  ])!;
}

/** 赤れんがの壁の画像：1枚 = 柱の間隔 BAY m × 1階 STOREY m。白い石の帯、白い枠の縦長の窓 */
export function createBrickMaterial(): THREE.MeshStandardMaterial {
  const W = 128;
  const H = 180;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#7a3a36';
  g.fillRect(0, 0, W, H);
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // れんがの目地とむら（1段 = 約 7.5cm → 画像で 2.4px）
  for (let y = 0; y < H; y += 3) {
    const off = (y / 3) % 2 === 0 ? 0 : 4;
    for (let x = -8 + off; x < W; x += 8) {
      const v = 0.85 + rand() * 0.25;
      g.fillStyle = `rgb(${Math.round(128 * v)},${Math.round(58 * v)},${Math.round(56 * v)})`;
      g.fillRect(x, y, 7, 2);
    }
  }
  // 白い石の帯：階の境目（画像の下端）と、窓の上下の飾り
  g.fillStyle = '#d6cfc0';
  g.fillRect(0, H - 10, W, 10);
  // 窓：白い枠、暗い緑がかったガラス、中の縦の桟
  const wx = 40;
  const ww = 48;
  const wy = 40;
  const wh = 100;
  g.fillStyle = '#d9d2c4';
  g.fillRect(wx - 6, wy - 10, ww + 12, wh + 18);
  g.fillStyle = '#cfc8b9';
  g.fillRect(wx - 10, wy - 16, ww + 20, 8);
  g.fillStyle = '#2f3d3a';
  g.fillRect(wx, wy, ww, wh);
  g.fillStyle = '#d7d2c6';
  g.fillRect(wx + ww / 2 - 2, wy, 4, wh);
  g.fillRect(wx, wy + wh * 0.35, ww, 4);
  // 窓の左右の白い石の隅（両端の柱の飾り）
  g.fillStyle = '#d3ccbd';
  for (let y = 6; y < H - 12; y += 22) {
    g.fillRect(0, y, 10, 10);
    g.fillRect(W - 10, y + 11, 10, 10);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, side: THREE.DoubleSide });
}
