import * as THREE from 'three';
import { LANDUSE, WATER } from '../core/config';
import { computeWaterMask } from './waterMask';

/**
 * 海・川などの水域。
 * 国土地理院の淡色地図は水域を1色（#bed2ff）で塗っているので、その色の画素を水域とみなす。
 * 地形チャンクごとに「水域かどうか」と「岸からの距離（深さの代わり）」を1枚の画像にして、
 * 地形の材質の中で水面の色・映り込み・さざ波を足す。
 */

/** 波を動かす時間（全チャンクで共有） */
export const waterTime = { value: 0 };

/** 水域の画像を作る Web Worker（重い画素の計算で飛行中にカクつかないよう、画面の処理と別に動かす） */
let worker: Worker | null = null;
const pending = new Map<number, (r: WaterMaskResult | null) => void>();
let nextId = 0;
type WaterMaskResult = { rgba: Uint8Array; mask: Uint8Array; size: number };

function computeInWorker(x: number, y: number, z: number): Promise<WaterMaskResult | null> {
  if (typeof Worker === 'undefined') return computeWaterMask(x, y, z);
  if (!worker) {
    // Worker の中ではページの URL が見えないので、地域（?region=…）を Worker の名前で渡す（core/region.ts）
    worker = new Worker(new URL('./water.worker.ts', import.meta.url), { type: 'module', name: location.search });
    worker.onmessage = (e: MessageEvent<{ id: number; result: WaterMaskResult | null }>) => {
      pending.get(e.data.id)?.(e.data.result);
      pending.delete(e.data.id);
    };
  }
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ id, x, y, z });
  });
}

/**
 * 地形チャンク (x, y, z) の範囲の水域を作る。
 * texture：R = 水域 (0..255)、G = 岸からの距離 (0..255) の画像。mask：水域かどうか（size×size、上の行から）。
 * 水域が無ければ null
 */
export async function fetchWaterMask(
  x: number,
  y: number,
  z: number,
): Promise<{ texture: THREE.DataTexture; mask: Uint8Array; size: number } | null> {
  const result = await computeInWorker(x, y, z);
  if (!result) return null;
  const { rgba, mask, size } = result;
  const texture = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, mask, size };
}


/**
 * 水域の地形を水面の高さまで下げる（標高データは水面が「データなし」で、岸の高さで穴埋めされて盛り上がるため）。
 * 水面の高さは、つながった水域ごとに「まわりの岸の一番低い高さ」にする（海や川は海面の高さ、
 * 高台の池・川はその岸の高さ。全部を海面にすると、高台の池が深い穴になる）。
 * heights は 256×256 の標高、mask は fetchWaterMask の水域（heights より細かくてよい）
 */
export function flattenWater(heights: Float32Array, mask: Uint8Array, maskSize: number): void {
  const n = 256;
  const k = maskSize / n;
  // この標高の画素に重なる水域の画素の半分以上が水なら、水の画素
  const water = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let w = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) w += mask[(y * k + j) * maskSize + x * k + i];
      if (w * 2 >= k * k) water[y * n + x] = 1;
    }
  }
  // つながった水域ごとに、まわりの岸の一番低い高さを探して、そこまで下げる
  const label = new Int32Array(n * n).fill(-1);
  const stack: number[] = [];
  let id = 0;
  for (let start = 0; start < n * n; start++) {
    if (!water[start] || label[start] >= 0) continue;
    const members: number[] = [];
    let shore = Infinity;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      members.push(p);
      const px = p % n;
      const py = (p - px) / n;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
        const q = qy * n + qx;
        if (water[q]) {
          if (label[q] < 0) {
            label[q] = id;
            stack.push(q);
          }
        } else {
          shore = Math.min(shore, heights[q]);
        }
      }
    }
    // 岸の無い水域（チャンク全体が海など）は海面の高さ。川がチャンクをまたぐ所は隣と多少ずれるが、
    // 海面まで下げると高台の川が深い溝になるので、岸に合わせる方を選ぶ
    const level = Number.isFinite(shore) ? Math.max(WATER.surfaceHeight, shore - 0.5) : WATER.surfaceHeight;
    // 水域の中は岸の高さまで平らに満たす（川の護岸の斜面が水面から出て、水が細く見えないように）
    for (const p of members) heights[p] = level;
    id++;
  }
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
    shader.uniforms.foamColor = { value: new THREE.Color(WATER.foamColor) };
    shader.uniforms.bankColor = { value: new THREE.Color(WATER.bankColor) };
    shader.uniforms.beachShallowColor = { value: new THREE.Color(WATER.beachShallowColor) };
    shader.uniforms.wetSandColor = { value: new THREE.Color(LANDUSE.colors.wetSand) };
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
        uniform vec3 foamColor;
        uniform vec3 bankColor;
        uniform vec3 beachShallowColor;
        uniform vec3 wetSandColor;
        varying vec3 vWaterWorld;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec4 waterSample = texture2D(waterMap, vMapUv);
        float isWater = smoothstep(0.45, 0.55, waterSample.r);
        float waterDepth = waterSample.g;
        // 岸辺は明るい青緑、沖は深い青
        vec3 waterColor = mix(shallowColor, deepColor, smoothstep(0.0, 1.0, waterDepth));
        // 波打ち際：水側の縁に白い泡の線（ゆっくり揺らぐ）
        float foam = smoothstep(0.5, 0.6, waterSample.r) * (1.0 - smoothstep(0.6, 0.82, waterSample.r));
        foam *= 0.65 + 0.35 * sin(waterTime * 1.6 + (vWaterWorld.x + vWaterWorld.z) * 0.35);
        waterColor = mix(waterColor, foamColor, foam * ${WATER.foamStrength.toFixed(2)});
        // 砂浜の前の海（luBeachNear は地面の種類の処理で決まる）：浅瀬は明るい青緑、岸へ寄せる白い波の線
        float beachSea = smoothstep(0.0, 0.25, luBeachNear);
        // 岸からの距離 (m)：水面の岸からの距離は区画ごとにしか測れない（隣の区画の岸が見えない）ので、
        // 砂浜の前では区画をまたいで測った砂浜からの距離を使う
        float shoreM = (1.0 - luBeachNear) * ${LANDUSE.beachReach.toFixed(1)};
        waterColor = mix(waterColor, mix(beachShallowColor, waterColor, smoothstep(10.0, 80.0, shoreM)), beachSea);
        {
          // 波の線：岸からの距離が一定の線を、岸へ向かって動かす。所々で途切れさせ、沖ほど薄く
          float phase = shoreM / ${WATER.surfSpacing.toFixed(1)} + waterTime * ${(WATER.surfSpeed / WATER.surfSpacing).toFixed(4)};
          float band = fract(phase);
          float crest = smoothstep(0.0, 0.06, band) * (1.0 - smoothstep(0.06, 0.22, band));
          float broken = smoothstep(0.35, 0.65, luNoise(vWaterWorld.xz / 30.0 + floor(phase) * 3.7));
          float fade = 1.0 - smoothstep(10.0, ${WATER.surfReach.toFixed(1)}, shoreM);
          waterColor = mix(waterColor, foamColor, crest * broken * fade * beachSea * 0.85);
          // 波打ち際の白い泡の帯（寄せては返す）
          float swash = 0.5 + 0.5 * sin(waterTime * 0.8 + luNoise(vWaterWorld.xz / 40.0) * 6.0);
          float edgeM = waterDepth * ${WATER.deepDistancePx.toFixed(1)} * 2.0;
          float edgeFoam = 1.0 - smoothstep(2.0 + swash * 4.0, 7.0 + swash * 5.0, min(edgeM, shoreM));
          waterColor = mix(waterColor, foamColor, edgeFoam * beachSea * 0.8);
        }
        // 護岸：陸側の縁に明るいコンクリートの帯と、水際の濃い影の線。砂浜では代わりに湿った砂の帯
        float bank = smoothstep(0.12, 0.25, waterSample.r) * (1.0 - isWater);
        float lip = smoothstep(0.32, 0.45, waterSample.r) * (1.0 - isWater);
        float sandy = max(luIsBeach, beachSea);
        vec3 land = mix(diffuseColor.rgb, bankColor, bank * (1.0 - sandy));
        land = mix(land, bankColor * 0.55, lip * (1.0 - sandy));
        float wet = smoothstep(0.04, 0.3, waterSample.r) * (1.0 - isWater) * sandy;
        land = mix(land, wetSandColor, wet * 0.9);
        diffuseColor.rgb = mix(land, waterColor, isWater);`,
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
