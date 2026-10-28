import * as THREE from 'three';

/**
 * 東京駅丸の内駅前広場（2017年整備）。写真と整備図を参考に、駅舎の前に作る。
 * 座標は駅舎と同じ（x = 駅舎の長い向き・南の端が 0、y = 上、z = 駅舎の正面へ +）。
 *
 * - 中央：白い石張りの広場（行幸通りへまっすぐ続く）。左右に芝生の帯、芝生の縁に並木、駅舎の前に松
 * - 南北：交通広場（タクシー・バスのロータリー）。アスファルトの車路が、植え込みの島のまわりを回る。
 *   島には地下の明かり取りの丸い屋根（ガラス）
 * 広場の面は地面より少し高く、厚みを付けて縁を隠す
 */
export interface PlazaParts {
  /** 白い石張り（u, v = m） */
  stone: THREE.BufferGeometry[];
  lawn: THREE.BufferGeometry[];
  asphalt: THREE.BufferGeometry[];
  /** 縁石・植え込みの枠・円形の屋根の縁（明るい灰色） */
  curb: THREE.BufferGeometry[];
  /** 車路の白線 */
  marking: THREE.BufferGeometry[];
  /** 明かり取りのガラスの屋根 */
  glass: THREE.BufferGeometry[];
  trunk: THREE.BufferGeometry[];
  /** 並木の葉 */
  leaves: THREE.BufferGeometry[];
  /** 松の葉 */
  pine: THREE.BufferGeometry[];
}

/** 広場の面の高さ（駅舎の地面から, m） */
const TOP = 0.35;
/** 駅舎の正面からの広場の範囲 (z) */
const NEAR = 27;
const FAR = 118;

export function buildMarunouchiPlaza(length: number): PlazaParts {
  const p: PlazaParts = {
    stone: [],
    lawn: [],
    asphalt: [],
    curb: [],
    marking: [],
    glass: [],
    trunk: [],
    leaves: [],
    pine: [],
  };
  const c = length / 2;
  let seed = 17;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // ---- 中央広場：白い石張りの面（厚み付き）と芝生の帯 ----
  const half = 62;
  p.stone.push(slab(c - half, c + half, NEAR, FAR, TOP, 1.5));
  // 駅舎の正面との間（ドームの庇の前まで）も石張りにする
  p.stone.push(slab(4, length - 4, 10.5, NEAR, TOP, 1.5));
  for (const side of [-1, 1]) {
    const x0 = c + side * 14;
    const x1 = c + side * 46;
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
    p.lawn.push(slab(a, b, 48, FAR - 8, TOP + 0.08, 0.2));
    // 芝生の縁の低い石の枠
    p.curb.push(...frame(a, b, 48, FAR - 8, TOP, 0.25, 0.3));
    // 並木：芝生の外側の縁に沿って（行幸通りの向き）
    for (let z = 52; z < FAR - 8; z += 9) {
      for (const x of [a - 3, b + 3]) tree(p, x + (rand() - 0.5) * 0.6, z + (rand() - 0.5) * 0.6, 0.85 + rand() * 0.3);
    }
  }
  // 駅舎の中央口の前の松（植え込みの中）
  for (const side of [-1, 1]) {
    const x0 = c + side * 9;
    const x1 = c + side * 26;
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0];
    p.lawn.push(slab(a, b, 29, 38, TOP + 0.4, 0.5));
    p.curb.push(...frame(a, b, 29, 38, TOP, 0.6, 0.35));
    for (let k = 0; k < 4; k++) pineTree(p, a + 2 + rand() * (b - a - 4), 30.5 + rand() * 6, TOP + 0.4, 0.8 + rand() * 0.5);
  }

  // ---- 南北の交通広場（ロータリー） ----
  for (const side of [-1, 1]) {
    const inner = c + side * half;
    const outer = c + side * (half + 92);
    const [a, b] = inner < outer ? [inner, outer] : [outer, inner];
    // 車路（アスファルト）と、外まわりの歩道（石張り）
    p.stone.push(slab(a, b, NEAR, FAR, TOP - 0.15, 1.5));
    p.asphalt.push(slab(a + 4, b - 4, NEAR + 4, FAR - 8, TOP - 0.13, 0.05));
    // 中の島：植え込みと、地下の明かり取りの丸い屋根
    const ia = a + 18;
    const ib = b - 18;
    p.curb.push(slab(ia, ib, NEAR + 18, FAR - 24, TOP, 0.3));
    p.lawn.push(slab(ia + 1, ib - 1, NEAR + 19, FAR - 25, TOP + 0.02, 0.05));
    const cx = (ia + ib) / 2;
    const cz = (NEAR + 18 + FAR - 24) / 2;
    const r = Math.min(ib - ia, FAR - NEAR - 42) / 2 - 4;
    p.curb.push(new THREE.CylinderGeometry(r, r + 0.6, 1.6, 40).translate(cx, TOP + 0.8, cz));
    // ガラスの屋根：ゆるく盛り上がった円盤（骨組みの筋は放射状の細い板）
    p.glass.push(
      new THREE.SphereGeometry(r - 0.6, 40, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.12, 1).translate(cx, TOP + 1.6, cz),
    );
    for (let k = 0; k < 12; k++) {
      p.curb.push(
        new THREE.BoxGeometry(r - 0.6, 0.12, 0.2)
          .translate((r - 0.6) / 2, 0, 0)
          .rotateY((k / 12) * Math.PI * 2)
          .translate(cx, TOP + 1.65 + (r - 0.6) * 0.06, cz),
      );
    }
    // 島のまわりの車線の白線（島から 3.5m 外）と、タクシー乗り場の区画
    p.marking.push(...outline(ia - 3.5, ib + 3.5, NEAR + 14.5, FAR - 20.5, TOP - 0.07, 0.15));
    for (let x = a + 6; x < b - 6; x += 2.5) p.marking.push(slab(x, x + 0.15, FAR - 13, FAR - 8.5, TOP - 0.07, 0.01));
    // 島の角の木
    for (const [x, z] of [
      [ia + 3, NEAR + 21],
      [ib - 3, NEAR + 21],
      [ia + 3, FAR - 27],
      [ib - 3, FAR - 27],
    ]) {
      tree(p, x, z, 1 + rand() * 0.2);
    }
  }
  return p;
}

/** 厚み thick の板（上面 y = top）。上面の uv は m */
function slab(x0: number, x1: number, z0: number, z1: number, top: number, thick: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, thick, z1 - z0).translate((x0 + x1) / 2, top - thick / 2, (z0 + z1) / 2);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i) + pos.getY(i));
  return g;
}

/** 長方形の縁の枠（幅 w、上端 top + h） */
function frame(x0: number, x1: number, z0: number, z1: number, top: number, h: number, w: number): THREE.BufferGeometry[] {
  return [
    slab(x0 - w, x1 + w, z0 - w, z0, top + h, h + 0.3),
    slab(x0 - w, x1 + w, z1, z1 + w, top + h, h + 0.3),
    slab(x0 - w, x0, z0, z1, top + h, h + 0.3),
    slab(x1, x1 + w, z0, z1, top + h, h + 0.3),
  ];
}

/** 長方形の白線（幅 w） */
function outline(x0: number, x1: number, z0: number, z1: number, top: number, w: number): THREE.BufferGeometry[] {
  return [
    slab(x0, x1, z0, z0 + w, top, 0.01),
    slab(x0, x1, z1 - w, z1, top, 0.01),
    slab(x0, x0 + w, z0, z1, top, 0.01),
    slab(x1 - w, x1, z0, z1, top, 0.01),
  ];
}

/** 並木（ケヤキのような丸い樹冠） */
function tree(p: PlazaParts, x: number, z: number, s: number): void {
  p.trunk.push(new THREE.CylinderGeometry(0.18 * s, 0.28 * s, 4 * s, 6).translate(x, TOP + 2 * s, z));
  p.leaves.push(new THREE.IcosahedronGeometry(2.6 * s, 1).scale(1, 0.85, 1).translate(x, TOP + 5.2 * s, z));
  p.leaves.push(new THREE.IcosahedronGeometry(1.8 * s, 1).translate(x + 1.2 * s, TOP + 6 * s, z - 0.6 * s));
}

/** 松（平たい葉の塊を段にして、少し傾いた幹） */
function pineTree(p: PlazaParts, x: number, z: number, base: number, s: number): void {
  p.trunk.push(new THREE.CylinderGeometry(0.15 * s, 0.3 * s, 3.4 * s, 6).rotateZ(0.15).translate(x, base + 1.7 * s, z));
  for (const [dx, y, r] of [
    [-0.4, 2.2, 1.8],
    [0.5, 3.1, 1.5],
    [0.2, 3.9, 1.1],
  ]) {
    p.pine.push(
      new THREE.CylinderGeometry(r * s, r * s * 1.1, 0.7 * s, 8).translate(x + dx * s, base + y * s, z + dx * 0.3 * s),
    );
  }
}

/** 白い石張りの画像：細長い石（0.6m × 1.2m）を行幸通りの向きに並べ、少しずつ色を変える。1枚 = 4.8m 四方 */
export function createStoneMaterial(): THREE.MeshStandardMaterial {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d')!;
  let seed = 5;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const px = S / 4.8;
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 4; row++) {
      const off = col % 2 === 0 ? 0 : 0.6;
      const v = 222 + Math.round((rand() - 0.5) * 16);
      g.fillStyle = `rgb(${v},${v},${v - 4})`;
      g.fillRect(col * 0.6 * px, (row * 1.2 + off) * px, 0.6 * px, 1.2 * px);
      g.fillRect(col * 0.6 * px, (row * 1.2 + off - 4.8) * px, 0.6 * px, 1.2 * px);
    }
  }
  g.fillStyle = 'rgba(120,120,115,0.45)';
  for (let col = 0; col <= 8; col++) g.fillRect(col * 0.6 * px - 0.5, 0, 1, S);
  for (let col = 0; col < 8; col++) {
    const off = col % 2 === 0 ? 0 : 0.6;
    for (let row = 0; row <= 4; row++) g.fillRect(col * 0.6 * px, (row * 1.2 + off) * px - 0.5, 0.6 * px, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / 4.8, 1 / 4.8);
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.75 });
}
