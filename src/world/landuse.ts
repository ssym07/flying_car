import * as THREE from 'three';
import { LANDUSE } from '../core/config';

/**
 * 道路・公園・水以外の地面。OpenStreetMap の土地の種類（駐車場・線路の敷地・墓地・寺社・学校・工事現場・工場・草地・畑・広場。
 * public/landuse、scripts/fetch-landuse.mjs で作る）から、地形チャンクごとに「地面の種類」の画像を作り、
 * 種類ごとのテンプレート（アスファルトと白線・砂利・墓石の並び など）で地形の色を塗り替える。
 * データの無い所は「住宅地の敷地」のテンプレートで塗る（航空写真のぼやけと、写り込んだ屋根を見せない）。
 * ただし写真が緑っぽい所（印の無い河川敷・芝など）は草地にする。
 * どの種類も航空写真の色を少しだけ混ぜて、場所ごとの違いを残す。
 */

/** 地面の種類データ1タイル：[種類, 向き(度, 0〜179。東が 0、北へ回る), 座標（1e-6度、先頭以外は差分）] */
interface LanduseTile {
  a: Array<[number, number, number[]]>;
}

const SIZE = 512;

/**
 * チャンク (x, y, z) の地面の種類の画像（R = 種類 + 1 を 20 倍した値（0 はデータ無し）、G = 向き / 180）。
 * データが無ければ null（全体を住宅地の敷地で塗る）
 */
export async function fetchLanduse(x: number, y: number, z: number): Promise<THREE.Texture | null> {
  let data: LanduseTile;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${LANDUSE.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`);
    // データの無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    data = (await res.json()) as LanduseTile;
  } catch {
    return null;
  }
  if (data.a.length === 0) return null;

  const n = 2 ** z;
  const toPx = (lat: number, lon: number): [number, number] => {
    const tx = ((lon + 180) / 360) * n;
    const ty = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    return [(tx - x) * SIZE, (ty - y) * SIZE];
  };
  // 種類の番号をそのまま色にするので、縁をぼかさずに塗る（キャンバスで塗ると縁が混ざって別の番号になる）。
  // 画素の中心が形の中にあれば塗る（偶奇規則）。塗る順（後ろほど上）に並んでいる
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  for (const [kind, angle, coords] of data.a) {
    const pts = decode(coords).map(([lat, lon]) => toPx(lat, lon));
    let top = Infinity;
    let bottom = -Infinity;
    for (const [, py] of pts) (top = Math.min(top, py)), (bottom = Math.max(bottom, py));
    const r = (kind + 1) * 20;
    const gch = Math.round((angle / 180) * 255);
    for (let row = Math.max(0, Math.floor(top)); row <= Math.min(SIZE - 1, Math.ceil(bottom)); row++) {
      const cy = row + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[j];
        if (ay > cy !== by > cy) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] - 0.5));
        const to = Math.min(SIZE - 1, Math.floor(xs[k + 1] - 0.5));
        for (let col = from; col <= to; col++) {
          // データの行 0 が v = 0（南）。写真（北が上の画像）と同じ uv で貼るので上下を入れ替える
          const p = ((SIZE - 1 - row) * SIZE + col) * 4;
          pixels[p] = r;
          pixels[p + 1] = gch;
        }
      }
    }
  }
  const texture = new THREE.DataTexture(pixels, SIZE, SIZE);
  texture.needsUpdate = true;
  // 種類の番号が隣と混ざらないよう、補間しない
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** データの無いチャンク用（全体を住宅地の敷地に） */
const emptyLanduse = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
emptyLanduse.needsUpdate = true;

/**
 * 地形の材質に地面の種類を足す。landuseMap は fetchLanduse の画像（無ければ null）で、写真と同じ uv で貼る。
 * 公園（addParks）・水面（addWater）より先に塗る：それらの後に呼ぶと、こちらの処理がそれらの処理の前に入る
 */
export function addLanduse(material: THREE.MeshStandardMaterial, landuseMap: THREE.Texture | null): void {
  material.userData.landuseMap = landuseMap;
  const C = LANDUSE.colors;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.landuseMap = { value: landuseMap ?? emptyLanduse };
    for (const [name, hex] of Object.entries(C)) shader.uniforms[`lu_${name}`] = { value: new THREE.Color(hex) };
    shader.uniforms.luPhotoMix = { value: LANDUSE.photoMix };
    shader.uniforms.luDefaultPhotoMix = { value: LANDUSE.defaultPhotoMix };
    if (!shader.vertexShader.includes('vLandWorld')) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vLandWorld;`)
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>\nvLandWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D landuseMap;
        ${Object.keys(C)
          .map((name) => `uniform vec3 lu_${name};`)
          .join('\n')}
        uniform float luPhotoMix;
        uniform float luDefaultPhotoMix;
        varying vec3 vLandWorld;
        float luHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float luNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(luHash(i), luHash(i + vec2(1, 0)), u.x), mix(luHash(i + vec2(0, 1)), luHash(i + vec2(1, 1)), u.x), u.y);
        }
        // 線の太さ w (m) の繰り返しの線（間隔 period m）の濃さ。遠くでちらつかないよう、画面上の幅でぼかす
        float luLine(float x, float period, float w) {
          float d = abs(fract(x / period + 0.5) - 0.5) * period;
          float aa = fwidth(x) * 0.75;
          return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, d);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec4 lu = texture2D(landuseMap, vMapUv);
          float kind = floor(lu.r * 255.0 / 20.0 + 0.5) - 1.0;
          // 向き：東が 0、北へ回る。ローカル座標は +x が西、+z が北
          float ang = lu.g * 3.14159265;
          vec2 w = vLandWorld.xz;
          vec2 dir = vec2(-cos(ang), sin(ang));
          float along = dot(w, dir);
          float across = dot(w, vec2(dir.y, -dir.x));
          float big = luNoise(w / 9.0);
          float fine = luNoise(w * 1.7);
          vec3 photo = diffuseColor.rgb;
          vec3 col;
          float photoMix = luPhotoMix;
          if (kind < -0.5) {
            // 住宅地の敷地：明るい舗装と土のむら。ただし写真が緑っぽい所（印の無い河川敷・芝・庭木）は草地にする
            col = mix(lu_lot, lu_lot2, smoothstep(0.35, 0.75, big)) * (0.94 + fine * 0.1);
            float green = smoothstep(0.01, 0.06, photo.g - max(photo.r, photo.b));
            col = mix(col, mix(lu_grass, lu_grass2, big) * (0.92 + fine * 0.12), green);
            photoMix = luDefaultPhotoMix;
          } else if (kind < 0.5) {
            // 駐車場：アスファルトに白線（幅 2.5m・奥行き 5m の区画が、通路 6m をはさんで向かい合う）
            col = lu_parking * (0.9 + fine * 0.15);
            float band = mod(across, 16.0);
            float inStall = step(band, 5.0) + step(11.0, band);
            float stall = luLine(along, 2.5, 0.15) * inStall;
            float edge = luLine(across - 5.0, 16.0, 0.15) + luLine(across - 11.0, 16.0, 0.15);
            col = mix(col, lu_marking, clamp(stall + edge, 0.0, 1.0) * 0.9);
          } else if (kind < 1.5) {
            // 線路の敷地：砂利
            col = lu_ballast * (0.7 + luHash(floor(w * 6.0)) * 0.45) * (0.9 + big * 0.15);
          } else if (kind < 2.5) {
            // 墓地：石畳に墓石の並び。6区画ごとに通路を空け、ところどころ空き区画にする
            col = lu_stone * (0.92 + fine * 0.1);
            vec2 cell = floor(vec2(along / 2.2, across / 2.6));
            vec2 g = vec2(mod(along, 2.2), mod(across, 2.6));
            float aisle = step(5.0, mod(cell.x, 6.0)) + step(3.0, mod(cell.y, 4.0));
            float grave = step(0.4, g.x) * step(g.x, 1.4) * step(0.5, g.y) * step(g.y, 1.7);
            grave *= (1.0 - clamp(aisle, 0.0, 1.0)) * step(0.12, luHash(cell + 7.0));
            col = mix(col, lu_grave * (0.8 + luHash(cell) * 0.4), grave);
          } else if (kind < 3.5) {
            // 寺社の境内：白い玉砂利
            col = lu_gravel * (0.85 + luHash(floor(w * 8.0)) * 0.25);
          } else if (kind < 4.5) {
            // 学校：校庭の土
            col = lu_schoolyard * (0.9 + big * 0.12 + fine * 0.06);
          } else if (kind < 5.5) {
            // 工事現場・空き地：荒れた土（濃いむらと轍）
            col = mix(lu_bare, lu_bare2, smoothstep(0.3, 0.8, big)) * (0.88 + fine * 0.18);
          } else if (kind < 6.5) {
            // 工場・倉庫・港：目地のあるコンクリート（6m 角）
            col = lu_concrete * (0.9 + big * 0.12);
            col *= 1.0 - 0.25 * clamp(luLine(along, 6.0, 0.12) + luLine(across, 6.0, 0.12), 0.0, 1.0);
          } else if (kind < 7.5) {
            // 草地
            col = mix(lu_grass, lu_grass2, big) * (0.92 + fine * 0.12);
          } else if (kind < 8.5) {
            // 畑：土のうねと作物の列
            float row = luLine(across, 1.2, 0.55);
            col = mix(lu_soil * (0.9 + fine * 0.15), lu_crop * (0.85 + big * 0.25), row);
          } else {
            // 広場・商業地：タイル舗装（1m 角、1枚ごとに少し色を変える）
            col = lu_paving * (0.92 + luHash(floor(w)) * 0.12);
            col *= 1.0 - 0.2 * clamp(luLine(w.x, 1.0, 0.04) + luLine(w.y, 1.0, 0.04), 0.0, 1.0);
          }
          diffuseColor.rgb = mix(col, photo, photoMix);
        }`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}+landuse`;
}

function decode(coords: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < coords.length; i += 2) {
    lat += coords[i];
    lon += coords[i + 1];
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}
