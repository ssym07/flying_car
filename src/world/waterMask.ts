import { WATER } from '../core/config';
import { roadMask } from './roadMask';

/**
 * 地形チャンクの水域の画像を作る計算（three を使わない。Web Worker（water.worker.ts）の中で動かす）。
 * 国土地理院の淡色地図の水色の画素を水域とみなし、穴を埋め、橋の下をつなぎ、岸からの距離を測る
 */

/**
 * 地形チャンク (x, y, z) の範囲の水域。
 * rgba：R = 水域 (0..255)、G = 岸からの距離 (0..255) の画像（DataTexture の並び：1行目が下）。
 * mask：水域かどうか（size×size、上の行から）。水域が無ければ null
 */
export async function computeWaterMask(
  x: number,
  y: number,
  z: number,
): Promise<{ rgba: Uint8Array; mask: Uint8Array; size: number } | null> {
  const k = 1 << WATER.zoomOffset;
  const size = 256 * k;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const results = await Promise.all(
    Array.from({ length: k * k }, async (_, n) => {
      const i = n % k;
      const j = Math.floor(n / k);
      const url = WATER.mapUrl
        .replace('{z}', `${z + WATER.zoomOffset}`)
        .replace('{x}', `${x * k + i}`)
        .replace('{y}', `${y * k + j}`);
      try {
        const res = await fetch(url);
        if (!res.ok) return false;
        const image = await createImageBitmap(await res.blob());
        ctx.drawImage(image, i * 256, j * 256);
        image.close();
        return true;
      } catch {
        return false;
      }
    }),
  );
  if (!results.some(Boolean)) return null;

  // 水色の画素（isWaterColor）
  const { data } = ctx.getImageData(0, 0, size, size);
  let mask: Uint8Array = new Uint8Array(size * size);
  let any = false;
  for (let p = 0; p < mask.length; p++) {
    const r = data[p * 4];
    const g = data[p * 4 + 1];
    const b = data[p * 4 + 2];
    if (isWaterColor(r, g, b)) {
      mask[p] = 1;
      any = true;
    }
  }
  if (!any) return null;

  // 川の上の文字ラベル・線路などの小さな穴を埋める（膨らませてから縮める）
  mask = erode(dilate(mask, size, WATER.closeRadius), size, WATER.closeRadius);
  // 橋の下：地図では橋の道路が水の上に描かれて水が途切れるので、橋の所だけ大きく閉じて両岸の水をつなぐ
  const bridges = await roadMask(x, y, z, size, { margin: 3, bridgesOnly: true });
  if (bridges) {
    const closed = erode(dilate(mask, size, WATER.bridgeCloseRadius), size, WATER.bridgeCloseRadius);
    for (let p = 0; p < mask.length; p++) if (bridges[p] && closed[p]) mask[p] = 1;
  }

  // 岸からの距離は、まわりの区画の水域も見て測る（区画の中だけで測ると、岸が隣の区画にある所で
  // 区画の境目を境に海の色（岸辺の明るい青〜沖の深い青）が急に変わる）
  const margin = WATER.deepDistancePx + 8;
  const distance = crop(
    shoreDistance(await withNeighbors(mask, x, y, z, size, margin), size + margin * 2),
    size,
    margin,
  );
  // 岸の線が画素の階段にならないよう、水域をぼかして（シェーダーで 0.5 を境に切る）なめらかにする
  const soft = boxBlur(boxBlur(Float32Array.from(mask), size, WATER.edgeBlur), size, WATER.edgeBlur);
  // DataTexture は1行目が下（v=0）になるので、上下を反転して詰める
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const src = py * size + px;
      const dst = ((size - 1 - py) * size + px) * 4;
      out[dst] = Math.round(soft[src] * 255);
      out[dst + 1] = Math.min(255, Math.round((distance[src] / WATER.deepDistancePx) * 255));
      out[dst + 3] = 255;
    }
  }
  return { rgba: out, mask, size };
}

/** 淡色地図の水色の画素か：水面の色（#bed2ff）と、細い川の縁取りの青（#145aff）とその間の色（文字のふちのにじみも拾えるよう幅を持たせる） */
function isWaterColor(r: number, g: number, b: number): boolean {
  return b > 0xf0 && r < 0xd0 && g < 0xe2 && g > r && b - r > 40;
}

/**
 * 区画の水域 mask（size × size）のまわりに margin 画素の余白を付けた水域。余白は隣の 8 区画の淡色地図
 * （区画と同じズームの粗い地図を引き伸ばす）から作る。読めなかった所は区画の縁の値をそのまま延ばす
 */
async function withNeighbors(mask: Uint8Array, x: number, y: number, z: number, size: number, margin: number) {
  const E = size + margin * 2;
  const out = new Uint8Array(E * E);
  for (let py = 0; py < E; py++) {
    const sy = Math.min(size - 1, Math.max(0, py - margin));
    for (let px = 0; px < E; px++) out[py * E + px] = mask[sy * size + Math.min(size - 1, Math.max(0, px - margin))];
  }
  const canvas = new OffscreenCanvas(E, E);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const loaded: Array<[number, number]> = [];
  await Promise.all(
    [-1, 0, 1].flatMap((dy) =>
      [-1, 0, 1].map(async (dx) => {
        if (dx === 0 && dy === 0) return;
        const url = WATER.mapUrl
          .replace('{z}', `${z}`)
          .replace('{x}', `${x + dx}`)
          .replace('{y}', `${y + dy}`);
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const image = await createImageBitmap(await res.blob());
          ctx.drawImage(image, margin + dx * size, margin + dy * size, size, size);
          image.close();
          loaded.push([dx, dy]);
        } catch {
          // 読めなかった所は縁の値のまま
        }
      }),
    ),
  );
  if (loaded.length === 0) return out;
  const { data } = ctx.getImageData(0, 0, E, E);
  for (const [dx, dy] of loaded) {
    const x0 = Math.max(0, margin + dx * size);
    const x1 = Math.min(E, margin + (dx + 1) * size);
    const y0 = Math.max(0, margin + dy * size);
    const y1 = Math.min(E, margin + (dy + 1) * size);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const p = py * E + px;
        out[p] = isWaterColor(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) ? 1 : 0;
      }
    }
  }
  return out;
}

/** 余白 margin の付いた画像（(size + 2 margin) 四方）から、真ん中の size 四方を切り出す */
function crop(src: Float32Array, size: number, margin: number): Float32Array {
  const E = size + margin * 2;
  const out = new Float32Array(size * size);
  for (let py = 0; py < size; py++)
    out.set(src.subarray((py + margin) * E + margin, (py + margin) * E + margin + size), py * size);
  return out;
}

/** 縦横に分けた箱型のぼかし（半径 r 画素） */
function boxBlur(src: Float32Array, size: number, r: number): Float32Array {
  const pass = (a: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(a.length);
    for (let line = 0; line < size; line++) {
      let sum = 0;
      let count = 0;
      const at = (k: number) => (horizontal ? line * size + k : k * size + line);
      for (let k = 0; k < Math.min(r, size); k++) {
        sum += a[at(k)];
        count++;
      }
      for (let k = 0; k < size; k++) {
        if (k + r < size) {
          sum += a[at(k + r)];
          count++;
        }
        if (k - r - 1 >= 0) {
          sum -= a[at(k - r - 1)];
          count--;
        }
        out[at(k)] = sum / count;
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

function dilate(mask: Uint8Array, size: number, r: number): Uint8Array {
  return morph(mask, size, r, 1);
}

function erode(mask: Uint8Array, size: number, r: number): Uint8Array {
  return morph(mask, size, r, 0);
}

/** 正方形の窓での膨張（target=1）・収縮（target=0）。横→縦の2回に分けて速くする */
function morph(mask: Uint8Array, size: number, r: number, target: 0 | 1): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let hit = false;
        for (let d = -r; d <= r && !hit; d++) {
          const xx = horizontal ? x + d : x;
          const yy = horizontal ? y : y + d;
          // 画像の外は判定に使わない（チャンクの境目に偽の岸を作らない）
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          if (src[yy * size + xx] === target) hit = true;
        }
        dst[y * size + x] = hit ? target : 1 - target;
      }
    }
    return dst;
  };
  return pass(pass(mask, true), false);
}

/** 水域の各画素から一番近い陸までの距離（画素）。陸は 0 */
function shoreDistance(mask: Uint8Array, size: number): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(size * size);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const D = Math.SQRT2;
  // 2パスのチャンファー距離
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) v = Math.min(v, d[i - size] + 1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - size - 1] + D);
      if (x < size - 1 && y > 0) v = Math.min(v, d[i - size + 1] + D);
      d[i] = v;
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < size - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < size - 1) v = Math.min(v, d[i + size] + 1);
      if (x < size - 1 && y < size - 1) v = Math.min(v, d[i + size + 1] + D);
      if (x > 0 && y < size - 1) v = Math.min(v, d[i + size - 1] + D);
      d[i] = v;
    }
  }
  return d;
}
