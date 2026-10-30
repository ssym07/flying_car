import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARKS } from '../core/config';

/**
 * 公園。OpenStreetMap の公園・林・グラウンドの形と園路（public/parks、scripts/fetch-parks.mjs で作る）から、
 * 地形チャンクごとに「芝生・土の道」の画像を作り、地形の色を塗り替える（地形の起伏にぴったり沿う）。
 * 木はデータを持たず、芝生の上に手続き的に並べて、同じ形の木をまとめて描く（InstancedMesh）。
 */

/** 公園データ1タイル */
interface ParkTile {
  /** [種類（0=公園・庭園, 1=林, 2=グラウンド）, 座標（1e-6度、先頭以外は差分）] */
  a: Array<[0 | 1 | 2, number[]]>;
  /** [幅(m), 座標] 公園の中の園路 */
  p: Array<[number, number[]]>;
}

export const enum TreeKind {
  Broadleaf = 0,
  Conifer = 1,
  Sakura = 2,
}

/** 木1本：チャンクの中の位置（0..1、x は東向き、y は南向き）、種類、大きさの倍率 */
export interface TreeSpot {
  u: number;
  v: number;
  kind: TreeKind;
  scale: number;
}

const SIZE = 512;

/**
 * チャンク (x, y, z) の公園の画像（R = 芝生、G = 土の道・グラウンド）と、木を置く場所を作る。
 * waterMask（SIZE×SIZE、上の行から）を渡すと、水の上には木を置かない。公園が無ければ null
 */
export async function fetchParks(
  x: number,
  y: number,
  z: number,
  waterMask: Uint8Array | null,
): Promise<{ texture: THREE.Texture; trees: TreeSpot[] } | null> {
  let data: ParkTile;
  try {
    const res = await fetch(
      `${import.meta.env.BASE_URL}${PARKS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`,
    );
    // 公園の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    data = (await res.json()) as ParkTile;
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
  const metersPerPx = (40075016 * Math.cos((decode(data.a[0][1])[0][0] * Math.PI) / 180)) / n / SIZE;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIZE, SIZE);
  // 赤 = 芝生、緑 = 土。加算で重ねる（グラウンドが公園の中にあれば両方が立つ）
  g.globalCompositeOperation = 'lighter';
  const fill = (coords: number[], color: string) => {
    const pts = decode(coords);
    g.beginPath();
    pts.forEach(([lat, lon], i) => {
      const [px, py] = toPx(lat, lon);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  for (const [kind, coords] of data.a) if (kind !== 2) fill(coords, '#ff0000');
  // 林は青も立てる（木を密に植える）
  for (const [kind, coords] of data.a) if (kind === 1) fill(coords, '#0000ff');
  for (const [kind, coords] of data.a) if (kind === 2) fill(coords, '#00ff00');
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [width, coords] of data.p) {
    g.beginPath();
    decode(coords).forEach(([lat, lon], i) => {
      const [px, py] = toPx(lat, lon);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.strokeStyle = '#00ff00';
    g.lineWidth = Math.max(1, width / metersPerPx);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';

  const { data: pixels } = g.getImageData(0, 0, SIZE, SIZE);
  // 画素 → 緯度経度（森のような公園の範囲を調べるのに使う）
  const toLatLon = (px: number, py: number): [number, number] => {
    const lon = ((x + px / SIZE) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / SIZE)) / n))) * 180) / Math.PI;
    return [lat, lon];
  };
  const trees = placeTrees(pixels, waterMask, metersPerPx, x * 7919 + y * 104729, toLatLon);

  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, trees };
}

/**
 * 芝生の上に、少しずらした格子で木を置く。林と芝生の縁は密に、道・グラウンド・水の上には置かない。
 * 森のような公園（PARKS.groves）の中は芝生にも林のように植え、水辺（お堀など）は桜並木にする
 */
function placeTrees(
  pixels: Uint8ClampedArray,
  water: Uint8Array | null,
  metersPerPx: number,
  seed: number,
  toLatLon: (px: number, py: number) => [number, number],
): TreeSpot[] {
  let s = seed % 2147483647 || 1;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const step = PARKS.treeSpacing / metersPerPx;
  const edge = Math.max(2, Math.round(PARKS.edgeWidth / metersPerPx));
  const at = (px: number, py: number) => {
    const i = (Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))) * 4;
    return { grass: pixels[i] > 127, dirt: pixels[i + 1] > 127, wood: pixels[i + 2] > 127 };
  };
  const waterAt = (px: number, py: number) =>
    !!water && water[Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))] > 0;
  const bank = Math.max(2, Math.round(PARKS.bankWidth / metersPerPx));
  const inGrove = (px: number, py: number) => {
    const [lat, lon] = toLatLon(px, py);
    return PARKS.groves.some(
      ([glat, glon, r]) =>
        Math.hypot((lat - glat) * 111320, (lon - glon) * 111320 * Math.cos((glat * Math.PI) / 180)) < r,
    );
  };
  const trees: TreeSpot[] = [];
  for (let gy = step / 2; gy < SIZE; gy += step) {
    for (let gx = step / 2; gx < SIZE; gx += step) {
      const px = Math.floor(gx + (rand() - 0.5) * step * 0.9);
      const py = Math.floor(gy + (rand() - 0.5) * step * 0.9);
      const here = at(px, py);
      if (!here.grass || here.dirt) continue;
      if (water && water[Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))]) continue;
      // 道から少し離す
      const nearPath = [-2, 2].some((d) => at(px + d, py).dirt || at(px, py + d).dirt);
      if (nearPath) continue;
      const nearEdge = [-edge, edge].some((d) => !at(px + d, py).grass || !at(px, py + d).grass);
      const grove = PARKS.groves.length > 0 && inGrove(px, py);
      const nearWater = grove && [-bank, bank].some((d) => waterAt(px + d, py) || waterAt(px, py + d));
      const density = here.wood || grove ? PARKS.woodDensity : nearEdge ? PARKS.edgeDensity : PARKS.lawnDensity;
      if (rand() > density) continue;
      const r = rand();
      const kind = nearWater
        ? r < 0.85
          ? TreeKind.Sakura
          : TreeKind.Broadleaf
        : grove
          ? r < 0.15
            ? TreeKind.Sakura
            : r < 0.3
              ? TreeKind.Conifer
              : TreeKind.Broadleaf
          : here.wood
            ? r < 0.65
              ? TreeKind.Conifer
              : TreeKind.Broadleaf
            : r < PARKS.sakuraRatio
              ? TreeKind.Sakura
              : r < PARKS.sakuraRatio + 0.15
                ? TreeKind.Conifer
                : TreeKind.Broadleaf;
      trees.push({ u: px / SIZE, v: py / SIZE, kind, scale: 0.7 + rand() * 0.6 });
      if (trees.length >= PARKS.maxTreesPerChunk) return trees;
    }
  }
  return trees;
}

/**
 * 地形の材質に公園を足す。parkMap は fetchParks の画像で、写真と同じ uv で貼る。
 * 芝生は明るい緑（濃淡のむら付き）、園路・グラウンドはベージュの土。
 * 水面（addWater）より先に塗る：addWater の後に呼ぶと、こちらの処理が水面の処理の前に入る
 */
export function addParks(material: THREE.MeshStandardMaterial, parkMap: THREE.Texture): void {
  material.userData.parkMap = parkMap;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.parkMap = { value: parkMap };
    shader.uniforms.grassColor = { value: new THREE.Color(PARKS.grassColor) };
    shader.uniforms.grassColor2 = { value: new THREE.Color(PARKS.grassColor2) };
    shader.uniforms.dirtColor = { value: new THREE.Color(PARKS.dirtColor) };
    if (!shader.vertexShader.includes('vParkWorld')) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vParkWorld;`)
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>\nvParkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D parkMap;
        uniform vec3 grassColor;
        uniform vec3 grassColor2;
        uniform vec3 dirtColor;
        varying vec3 vParkWorld;
        float parkHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float parkNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(parkHash(i), parkHash(i + vec2(1, 0)), u.x), mix(parkHash(i + vec2(0, 1)), parkHash(i + vec2(1, 1)), u.x), u.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec4 park = texture2D(parkMap, vMapUv);
          // 公園の中の砂浜（葛西臨海公園など）は芝生にしない
          float grass = smoothstep(0.3, 0.7, park.r) * (1.0 - luIsBeach);
          float dirt = smoothstep(0.3, 0.7, park.g) * (1.0 - luIsBeach);
          // 芝生：大きなむらと細かいざらつき。写真の色も少しだけ残して場所ごとの違いを出す
          float n = parkNoise(vParkWorld.xz / 14.0) * 0.65 + parkNoise(vParkWorld.xz / 3.0) * 0.35;
          vec3 lawn = mix(grassColor, grassColor2, n);
          lawn = mix(lawn, diffuseColor.rgb, 0.15);
          vec3 soil = dirtColor * (0.9 + parkNoise(vParkWorld.xz * 1.7) * 0.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, lawn, grass);
          diffuseColor.rgb = mix(diffuseColor.rgb, soil, dirt);
        }`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}+parks`;
}

// ---- 木の形（全チャンクで共有） ----

let treeGeometries: THREE.BufferGeometry[] | null = null;

/** 幹と樹冠をまとめた木の形。色は頂点色。[広葉樹, 針葉樹, 桜] */
function getTreeGeometries(): THREE.BufferGeometry[] {
  if (treeGeometries) return treeGeometries;
  const colored = (geo: THREE.BufferGeometry, hex: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const c = new THREE.Color(hex);
    const colors = new Float32Array(g.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const trunk = (h: number) => colored(new THREE.CylinderGeometry(0.18, 0.28, h, 6).translate(0, h / 2, 0), 0x6b4b36);
  // 樹冠は球を少しつぶした塊を3つ重ねて、もこもこさせる
  const crown = (hex: number, y: number, r: number) => {
    const parts = [
      new THREE.IcosahedronGeometry(r, 1).scale(1, 0.85, 1).translate(0, y, 0),
      new THREE.IcosahedronGeometry(r * 0.7, 1).translate(r * 0.55, y + r * 0.25, r * 0.2),
      new THREE.IcosahedronGeometry(r * 0.65, 1).translate(-r * 0.45, y + r * 0.35, -r * 0.3),
    ];
    return mergeGeometries(parts.map((p) => colored(p, hex)))!;
  };
  const broadleaf = mergeGeometries([trunk(2.6), crown(PARKS.leafColor, 4.6, 2.4)])!;
  const conifer = mergeGeometries([
    trunk(1.6),
    colored(new THREE.ConeGeometry(2.0, 5.5, 8).translate(0, 4.2, 0), PARKS.coniferColor),
    colored(new THREE.ConeGeometry(1.4, 3.6, 8).translate(0, 6.6, 0), PARKS.coniferColor),
  ])!;
  const sakura = mergeGeometries([trunk(2.2), crown(PARKS.sakuraColor, 4.0, 2.6)])!;
  for (const geo of [broadleaf, conifer, sakura]) geo.computeVertexNormals();
  treeGeometries = [broadleaf, conifer, sakura];
  return treeGeometries;
}

let treeMaterial: THREE.MeshStandardMaterial | null = null;

/** 木を種類ごとに InstancedMesh にまとめる。position(u, v) は地面の上の点（ローカル座標） */
export function buildTrees(trees: TreeSpot[], position: (u: number, v: number) => THREE.Vector3 | null): THREE.Group {
  const group = new THREE.Group();
  treeMaterial ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const geos = getTreeGeometries();
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  for (const kind of [TreeKind.Broadleaf, TreeKind.Conifer, TreeKind.Sakura]) {
    const list = trees.filter((t) => t.kind === kind);
    if (list.length === 0) continue;
    const mesh = new THREE.InstancedMesh(geos[kind], treeMaterial, list.length);
    let count = 0;
    list.forEach((t, i) => {
      const p = position(t.u, t.v);
      if (!p) return;
      quat.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
      matrix.compose(p, quat, new THREE.Vector3(t.scale, t.scale * (0.9 + (i % 5) * 0.05), t.scale));
      mesh.setMatrixAt(count, matrix);
      // 色のゆらぎ
      const k = 0.85 + ((i * 37) % 30) / 100;
      mesh.setColorAt(count, color.setRGB(k, k, k));
      count++;
    });
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
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
