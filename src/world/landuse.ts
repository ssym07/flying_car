import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDUSE } from '../core/config';
import { roadMask } from './roadMask';

/**
 * 道路・公園・水以外の地面。OpenStreetMap の土地の種類（駐車場・線路の敷地・墓地・寺社・学校・工事現場・工場・草地・畑・広場・砂浜。
 * public/landuse、scripts/fetch-landuse.mjs で作る）から、地形チャンクごとに「地面の種類」の画像を作り、
 * 種類ごとのテンプレート（アスファルトと白線・砂利・墓石の並び など）で地形の色を塗り替える。
 * データの無い所は「住宅地の敷地」のテンプレートで塗る（航空写真のぼやけと、写り込んだ屋根を見せない）。
 * ただし写真が緑っぽい所（印の無い河川敷・芝など）は草地にする。
 * どの種類も航空写真の色を少しだけ混ぜて、場所ごとの違いを残す。
 * 墓地には立体の墓石（台石・上台・竿石）を、墓地の向きに合わせた格子に並べる（通路・空き区画を空け、道路の上には置かない）。
 */

/** 地面の種類データ1タイル：[種類, 向き(度, 0〜179。東が 0、北へ回る), 座標（1e-6度、先頭以外は差分）] */
interface LanduseTile {
  a: Array<[number, number, number[]]>;
}

const SIZE = 512;
/** 墓地・砂浜の種類の番号（scripts/fetch-landuse.mjs と同じ） */
const CEMETERY = 2;
const BEACH = 10;

/** 墓石1基：タイルの中の位置（u = 東へ、v = 南へ、0〜1）、区画の並ぶ向き（度、東が 0、北へ回る）、色の明るさ */
export interface GraveSpot {
  u: number;
  v: number;
  angle: number;
  shade: number;
}

export interface LanduseData {
  texture: THREE.Texture;
  graves: GraveSpot[];
}

/**
 * チャンク (x, y, z) の地面の種類の画像（R = 種類 + 1 を 20 倍した値（0 はデータ無し）、G = 向き / 180）と、墓地の墓石の位置。
 * データが無ければ null（全体を住宅地の敷地で塗る）
 */
export async function fetchLanduse(x: number, y: number, z: number): Promise<LanduseData | null> {
  let data: LanduseTile;
  try {
    const res = await fetch(
      `${import.meta.env.BASE_URL}${LANDUSE.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`,
    );
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
    for (const [, py] of pts) ((top = Math.min(top, py)), (bottom = Math.max(bottom, py)));
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
  const graves = data.a.some(([kind]) => kind === CEMETERY) ? await placeGraves(data, pixels, x, y, z) : [];
  if (data.a.some(([kind]) => kind === BEACH)) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
    markBeachReach(data, toPx, pixels, (n * SIZE) / (40075016 * Math.cos((lat * Math.PI) / 180)));
  }
  const texture = new THREE.DataTexture(pixels, SIZE, SIZE);
  texture.needsUpdate = true;
  // 種類の番号が隣と混ざらないよう、補間しない
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return { texture, graves };
}

/** タイルの中の位置（u = 東へ、v = 南へ、0〜1）が砂浜か（砂浜に木を植えないのに使う） */
export function isBeachAt(data: LanduseData, u: number, v: number): boolean {
  const pixels = (data.texture as THREE.DataTexture).image.data as Uint8Array;
  const col = Math.min(SIZE - 1, Math.max(0, Math.floor(u * SIZE)));
  const row = Math.min(SIZE - 1, Math.max(0, Math.floor(v * SIZE)));
  return pixels[((SIZE - 1 - row) * SIZE + col) * 4] === (BEACH + 1) * 20;
}

/**
 * 青の成分に「砂浜からの近さ」を入れる（砂浜で 255、LANDUSE.beachReach m 離れると 0）。
 * 水面のシェーダーが、砂浜の前の海だけに浅瀬の色と寄せる波を描くのに使う。pxPerMeter：1m が何画素か。
 * 砂浜が隣のタイルにある所も測れるよう、まわりに余白を付けた画像に砂浜を描いてから距離を測る
 * （砂浜の形は scripts/add-beaches.mjs がまわりのタイルにも入れている）
 */
function markBeachReach(
  data: LanduseTile,
  toPx: (lat: number, lon: number) => [number, number],
  pixels: Uint8Array,
  pxPerMeter: number,
): void {
  const reach = Math.max(1, LANDUSE.beachReach * pxPerMeter);
  const pad = Math.ceil(reach) + 2;
  const P = SIZE + pad * 2;
  const dist = new Float32Array(P * P).fill(1e9);
  // 砂浜の形を余白付きの画像に塗る（画素の中心が形の中なら砂浜。行 0 がタイルの北の端）
  for (const [kind, , coords] of data.a) {
    if (kind !== BEACH) continue;
    const pts = decode(coords).map(([lat, lon]) => toPx(lat, lon).map((v) => v + pad) as [number, number]);
    let top = Infinity;
    let bottom = -Infinity;
    for (const [, py] of pts) ((top = Math.min(top, py)), (bottom = Math.max(bottom, py)));
    for (let row = Math.max(0, Math.floor(top)); row <= Math.min(P - 1, Math.ceil(bottom)); row++) {
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
        const to = Math.min(P - 1, Math.floor(xs[k + 1] - 0.5));
        for (let col = from; col <= to; col++) dist[row * P + col] = 0;
      }
    }
  }
  // 2回のなめ（前から・後ろから）で、砂浜の画素までの距離（画素、斜めは 1.4）を求める
  const relax = (p: number, q: number, d: number) => {
    if (dist[q] + d < dist[p]) dist[p] = dist[q] + d;
  };
  for (let row = 0; row < P; row++) {
    for (let col = 0; col < P; col++) {
      const p = row * P + col;
      if (col > 0) relax(p, p - 1, 1);
      if (row > 0) {
        relax(p, p - P, 1);
        if (col > 0) relax(p, p - P - 1, 1.4);
        if (col < P - 1) relax(p, p - P + 1, 1.4);
      }
    }
  }
  for (let row = P - 1; row >= 0; row--) {
    for (let col = P - 1; col >= 0; col--) {
      const p = row * P + col;
      if (col < P - 1) relax(p, p + 1, 1);
      if (row < P - 1) {
        relax(p, p + P, 1);
        if (col < P - 1) relax(p, p + P + 1, 1.4);
        if (col > 0) relax(p, p + P - 1, 1.4);
      }
    }
  }
  // 画像はデータの行 0 が v = 0（南）なので、上下を入れ替えて詰める
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const d = dist[(row + pad) * P + col + pad];
      pixels[((SIZE - 1 - row) * SIZE + col) * 4 + 2] = Math.round(255 * Math.max(0, 1 - d / reach));
    }
  }
}

/** 墓石の区画の大きさ (m)：並ぶ向き（along）と、それに直角（across）。この区画ごとに通路を空ける */
const PLOT_ALONG = 2.4;
const PLOT_ACROSS = 3.0;
const AISLE_EVERY_ALONG = 6;
const AISLE_EVERY_ACROSS = 4;
/** 空き区画の割合 */
const EMPTY = 0.1;
/** 1チャンクの墓石の上限 */
const MAX_GRAVES = 30000;

/**
 * 墓地の墓石の位置。区画の格子は世界で共通の座標で作る（タイルの境目で墓地が分かれても列がずれない）。
 * 区画の中心が「墓地」の画素で、道路から離れていれば置く
 */
async function placeGraves(
  data: LanduseTile,
  pixels: Uint8Array,
  x: number,
  y: number,
  z: number,
): Promise<GraveSpot[]> {
  const roads = await roadMask(x, y, z, SIZE);
  const n = 2 ** z;
  const K = Math.PI / 180;
  const MY = 111320;
  const MX = 111320 * Math.cos(35.6 * K);
  const graves: GraveSpot[] = [];
  const hash = (a: number, b: number) => {
    const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  for (const [kind, angle, coords] of data.a) {
    if (kind !== CEMETERY) continue;
    const pts = decode(coords);
    const c = Math.cos(angle * K);
    const s = Math.sin(angle * K);
    // 形の範囲を、区画の格子の座標（along, across）にする
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [lat, lon] of pts) {
      const e = lon * MX;
      const nn = lat * MY;
      const along = e * c + nn * s;
      const across = -e * s + nn * c;
      a0 = Math.min(a0, along);
      a1 = Math.max(a1, along);
      b0 = Math.min(b0, across);
      b1 = Math.max(b1, across);
    }
    for (let i = Math.floor(a0 / PLOT_ALONG); i <= Math.ceil(a1 / PLOT_ALONG); i++) {
      // 通路の列
      if (((i % AISLE_EVERY_ALONG) + AISLE_EVERY_ALONG) % AISLE_EVERY_ALONG === AISLE_EVERY_ALONG - 1) continue;
      for (let j = Math.floor(b0 / PLOT_ACROSS); j <= Math.ceil(b1 / PLOT_ACROSS); j++) {
        if (((j % AISLE_EVERY_ACROSS) + AISLE_EVERY_ACROSS) % AISLE_EVERY_ACROSS === AISLE_EVERY_ACROSS - 1) continue;
        if (hash(i, j) < EMPTY) continue;
        const along = (i + 0.5) * PLOT_ALONG;
        const across = (j + 0.5) * PLOT_ACROSS;
        const lon = (along * c - across * s) / MX;
        const lat = (along * s + across * c) / MY;
        const tx = ((lon + 180) / 360) * n - x;
        const ty = ((1 - Math.asinh(Math.tan(lat * K)) / Math.PI) / 2) * n - y;
        if (tx < 0 || tx >= 1 || ty < 0 || ty >= 1) continue;
        const col = Math.floor(tx * SIZE);
        const row = Math.floor(ty * SIZE);
        // 画素は行 0 が南（上下を入れ替えて塗っている）
        if (pixels[((SIZE - 1 - row) * SIZE + col) * 4] !== (CEMETERY + 1) * 20) continue;
        if (roads && roads[row * SIZE + col]) continue;
        graves.push({ u: tx, v: ty, angle, shade: hash(j, i) });
        if (graves.length >= MAX_GRAVES) return graves;
      }
    }
  }
  return graves;
}

let graveMaterial: THREE.MeshStandardMaterial | null = null;
let graveGeometry: THREE.BufferGeometry | null = null;

/**
 * 墓石を InstancedMesh にまとめる。position(u, v) は地面の上の点、along(u, v, angle) はその点での区画の並ぶ向き（ローカル座標）。
 * 墓石は和型：台石（1.5m 角）・上台・竿石（高さ 1.7m）。正面は区画の並ぶ向きに直角
 */
export function buildGraves(
  graves: GraveSpot[],
  position: (u: number, v: number) => THREE.Vector3 | null,
  along: (u: number, v: number, angle: number) => THREE.Vector3 | null,
): THREE.InstancedMesh | null {
  if (graves.length === 0) return null;
  graveMaterial ??= new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 });
  graveGeometry ??= (() => {
    const parts = [
      new THREE.BoxGeometry(1.5, 0.3, 1.5).translate(0, 0.15, 0),
      new THREE.BoxGeometry(1.05, 0.32, 0.9).translate(0, 0.46, 0.1),
      new THREE.BoxGeometry(0.55, 1.08, 0.42).translate(0, 1.16, 0.12),
    ];
    const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
    for (const p of parts) p.dispose();
    return g;
  })();
  const mesh = new THREE.InstancedMesh(graveGeometry, graveMaterial, graves.length);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const unitX = new THREE.Vector3(1, 0, 0);
  const scale = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();
  let count = 0;
  for (const grave of graves) {
    const p = position(grave.u, grave.v);
    const dir = along(grave.u, grave.v, grave.angle);
    if (!p || !dir) continue;
    quat.setFromUnitVectors(unitX, dir.setY(0).normalize());
    // 墓石ごとの高さのばらつき
    scale.set(1, 0.9 + grave.shade * 0.25, 1);
    matrix.compose(p, quat, scale);
    mesh.setMatrixAt(count, matrix);
    // 明るい灰色の御影石を中心に、ところどころ黒っぽい石
    const k = grave.shade < 0.12 ? 0.32 + grave.shade : 0.62 + grave.shade * 0.25;
    mesh.setColorAt(count, color.setRGB(k, k, k * 0.98));
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
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
        // 砂浜（水面・公園の処理でも使う）：この画素が砂浜か、砂浜からの近さ（0〜1）
        float luIsBeach = 0.0;
        float luBeachNear = 0.0;
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
          luBeachNear = lu.b;
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
            // 墓地：白っぽい石張り（不揃いな丸い石の目地）。墓石は立体で並べる（buildGraves）
            col = lu_stone * (0.95 + fine * 0.08);
            vec2 q = w / 0.6;
            vec2 cell = floor(q);
            vec2 f = fract(q) - 0.5 + (vec2(luHash(cell), luHash(cell + 3.1)) - 0.5) * 0.3;
            float joint = smoothstep(0.32, 0.5, max(abs(f.x), abs(f.y)));
            col *= 1.0 - joint * 0.12 * (1.0 - clamp(fwidth(q.x), 0.0, 1.0));
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
          } else if (kind < 9.5) {
            // 広場・商業地：タイル舗装（1m 角、1枚ごとに少し色を変える）
            col = lu_paving * (0.92 + luHash(floor(w)) * 0.12);
            col *= 1.0 - 0.2 * clamp(luLine(w.x, 1.0, 0.04) + luLine(w.y, 1.0, 0.04), 0.0, 1.0);
          } else {
            // 砂浜：明るい砂の大きなむらと、風紋（細かい縞）。波打ち際の湿った砂は水面の処理で描く
            float ripple = sin(dot(w, vec2(0.8, 0.6)) * 7.0 + big * 9.0) * 0.5 + 0.5;
            float rippleFade = 1.0 - clamp(fwidth(w.x) * 1.5, 0.0, 1.0);
            col = mix(lu_sand, lu_sand2, smoothstep(0.3, 0.8, big)) * (0.95 + fine * 0.07 + (ripple - 0.5) * 0.06 * rippleFade);
            photoMix = 0.06;
            luIsBeach = 1.0;
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
