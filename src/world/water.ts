import * as THREE from 'three';
import { WATER } from '../core/config';

/**
 * 海・川などの水域。
 * 国土地理院の淡色地図は水域を1色（#bed2ff）で塗っているので、その色の画素を水域とみなす。
 * 地形チャンクごとに「水域かどうか」と「岸からの距離（深さの代わり）」を1枚の画像にして、
 * 地形の材質の中で水面の色・映り込み・さざ波を足す。
 */

/** 波を動かす時間（全チャンクで共有） */
export const waterTime = { value: 0 };

/**
 * 地形チャンク (x, y, z) の範囲の水域の画像を作る。R = 水域 (0/255)、G = 岸からの距離 (0..255)。
 * 水域が無ければ null
 */
export async function fetchWaterMask(x: number, y: number, z: number): Promise<THREE.DataTexture | null> {
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

  // 水色の画素（文字のふちのにじみも拾えるよう少し幅を持たせる）
  const { data } = ctx.getImageData(0, 0, size, size);
  let mask: Uint8Array = new Uint8Array(size * size);
  let any = false;
  for (let p = 0; p < mask.length; p++) {
    const r = data[p * 4];
    const g = data[p * 4 + 1];
    const b = data[p * 4 + 2];
    if (Math.abs(r - 0xbe) < 18 && Math.abs(g - 0xd2) < 18 && b > 0xf0) {
      mask[p] = 1;
      any = true;
    }
  }
  if (!any) return null;

  // 川の上の文字ラベルなどの小さな穴を埋める（膨らませてから縮める）
  mask = erode(dilate(mask, size, WATER.closeRadius), size, WATER.closeRadius);

  const distance = shoreDistance(mask, size);
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
  const texture = new THREE.DataTexture(out, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 地形の材質に水面を足す。waterMap は fetchWaterMask の画像で、写真と同じ uv で貼る。
 * 水域だけ色を水の色にし、表面をなめらかにして空を映し、さざ波で法線を揺らす
 */
export function addWater(material: THREE.MeshStandardMaterial, waterMap: THREE.Texture): void {
  material.userData.waterMap = waterMap;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.waterMap = { value: waterMap };
    shader.uniforms.waterTime = waterTime;
    shader.uniforms.shallowColor = { value: new THREE.Color(WATER.shallowColor) };
    shader.uniforms.deepColor = { value: new THREE.Color(WATER.deepColor) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWaterWorld;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D waterMap;
        uniform float waterTime;
        uniform vec3 shallowColor;
        uniform vec3 deepColor;
        varying vec3 vWaterWorld;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec4 waterSample = texture2D(waterMap, vMapUv);
        float isWater = smoothstep(0.35, 0.65, waterSample.r);
        float waterDepth = waterSample.g;
        // 岸辺は明るい青緑、沖は深い青。岸のきわは写真の色を少し残して浅瀬らしく
        vec3 waterColor = mix(shallowColor, deepColor, smoothstep(0.0, 1.0, waterDepth));
        waterColor = mix(mix(diffuseColor.rgb, waterColor, 0.6), waterColor, smoothstep(0.0, 0.08, waterDepth));
        diffuseColor.rgb = mix(diffuseColor.rgb, waterColor, isWater);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, ${WATER.roughness.toFixed(3)}, isWater);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (isWater > 0.0) {
          // さざ波：向きと速さの違う波を重ねる。沖ほど大きく
          vec2 p = vWaterWorld.xz;
          float t = waterTime;
          float amp = ${WATER.waveStrength.toFixed(3)} * mix(0.6, 1.6, waterDepth);
          vec2 g = vec2(
            sin(p.x * 0.31 + p.y * 0.12 + t * 1.3) + 0.5 * sin(p.x * 0.83 - p.y * 0.57 - t * 1.9) + 0.25 * sin(p.x * 2.1 + p.y * 1.7 + t * 2.7),
            cos(p.y * 0.37 - p.x * 0.09 - t * 1.1) + 0.5 * cos(p.y * 0.97 + p.x * 0.44 + t * 1.6) + 0.25 * cos(p.y * 2.3 - p.x * 1.4 - t * 3.1)
          );
          vec3 waveNormal = normalize((viewMatrix * vec4(normalize(vec3(g.x * amp, 1.0, g.y * amp)), 0.0)).xyz);
          normal = normalize(mix(normal, waveNormal, isWater));
        }`,
      );
  };
  material.customProgramCacheKey = () => 'terrain-water';
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
