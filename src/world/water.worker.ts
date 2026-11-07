import { computeWaterMask } from './waterMask';

/** 水域の画像を作る Web Worker（water.ts の fetchWaterMask から使う） */
self.onmessage = async (e: MessageEvent<{ id: number; x: number; y: number; z: number }>) => {
  const { id, x, y, z } = e.data;
  let result: Awaited<ReturnType<typeof computeWaterMask>> = null;
  try {
    result = await computeWaterMask(x, y, z);
  } catch {
    // 作れなかった時は水域なし（画面側と同じ扱い）
  }
  (self as unknown as Worker).postMessage({ id, result }, result ? [result.rgba.buffer, result.mask.buffer] : []);
};
