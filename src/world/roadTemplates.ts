import * as THREE from 'three';
import { ROADS } from '../core/config';

/**
 * 道路の見た目のテンプレート（写真を参考に、日本の道路の路面標示を手続き的に描く）。
 *
 * 車道：道の種別・車線数・一方通行ごとに「路面標示だけ」を描いた列を1枚の画像（アトラス）に横に並べる。
 *   1列 = 道の幅いっぱい × 長さ 10m。縦方向に繰り返して貼る。アスファルトの色はシェーダーで塗る
 *   - 幹線：黄色の中央線（はみ出し禁止）、白破線の車線境界、白の外側線
 *   - 2車線：白破線の中央線、白の外側線
 *   - 生活道路：両端の白線だけ
 * 歩道：明るいグレーのタイル張り（30cm 角）。
 * 横断歩道：道の向きに沿った白い縞（ゼブラ）。
 */

/** 道の種別（スクリプトの出力と同じ番号） */
export const enum RoadClass {
  Major = 0,
  Collector = 1,
  Local = 2,
}

export interface RoadLayout {
  /** 車道の幅 (m) */
  width: number;
  /** 片側の歩道の幅 (m)。0 なら歩道なし */
  sidewalk: number;
  /** アトラスの何列目か */
  column: number;
  /** 地面から浮かせる高さ (m)。交差点で重なった時に太い道が上に来るよう種別で変える */
  lift: number;
  /** アスファルトの明るさ（生活道路は少し明るく使い込まれた色） */
  shade: number;
}

const COLUMN_PX = 128;
const COLUMNS = 32;
const LENGTH_PX = 512;
/** 1列が表す長さ (m) */
export const TEMPLATE_LENGTH_M = 10;

const atlasCanvas = document.createElement('canvas');
atlasCanvas.width = COLUMN_PX * COLUMNS;
atlasCanvas.height = LENGTH_PX;
const atlasTexture = new THREE.CanvasTexture(atlasCanvas);
atlasTexture.colorSpace = THREE.SRGBColorSpace;
atlasTexture.wrapT = THREE.RepeatWrapping;
atlasTexture.anisotropy = 8;
const columns = new Map<string, number>();
const layouts = new Map<string, RoadLayout>();

/** 種別・車線数・一方通行から、道の幅と見た目のテンプレートを決める */
export function roadLayout(cls: RoadClass, taggedLanes: number, oneway: boolean): RoadLayout {
  const key = `${cls}/${taggedLanes}/${oneway ? 1 : 0}`;
  const cached = layouts.get(key);
  if (cached) return cached;

  const spec = ROADS.classes[cls];
  const lanes =
    cls === RoadClass.Local ? 0 : THREE.MathUtils.clamp(taggedLanes || (oneway ? spec.lanes / 2 : spec.lanes), 1, 6);
  const width = cls === RoadClass.Local ? spec.width : lanes * spec.laneWidth + spec.shoulder * 2;
  const columnKey = `${cls}/${lanes}/${oneway ? 1 : 0}`;
  let column = columns.get(columnKey);
  if (column === undefined) {
    column = columns.size % COLUMNS;
    columns.set(columnKey, column);
    drawColumn(column, cls, lanes, oneway, width);
  }
  const layout = { width, sidewalk: spec.sidewalk, column, lift: spec.lift, shade: spec.shade };
  layouts.set(key, layout);
  return layout;
}

/** アトラスの列の左端・右端の u（にじみ防止に少し内側） */
export function columnU(column: number, side: 0 | 1): number {
  const pad = 2 / atlasCanvas.width;
  return side === 0 ? column / COLUMNS + pad : (column + 1) / COLUMNS - pad;
}

function drawColumn(column: number, cls: RoadClass, lanes: number, oneway: boolean, width: number): void {
  const g = atlasCanvas.getContext('2d')!;
  const x0 = column * COLUMN_PX;
  g.clearRect(x0, 0, COLUMN_PX, LENGTH_PX);
  const pxPerM = COLUMN_PX / width;
  const along = LENGTH_PX / TEMPLATE_LENGTH_M;
  const lineW = Math.max(1.5, 0.15 * pxPerM);
  /** 幅方向 m の位置に縦線を引く。dashed なら 10m のうち前半 5m だけ */
  const line = (m: number, color: string, dashed = false, w = lineW) => {
    g.fillStyle = color;
    g.fillRect(x0 + m * pxPerM - w / 2, 0, w, dashed ? 5 * along : LENGTH_PX);
  };
  const white = 'rgba(240, 242, 245, 0.95)';
  const yellow = 'rgba(240, 190, 40, 0.95)';
  const spec = ROADS.classes[cls];

  if (cls === RoadClass.Local) {
    // 生活道路：両端の白線（外側線）だけ
    line(0.35, white);
    line(width - 0.35, white);
  } else {
    // 外側線
    line(spec.shoulder, white);
    line(width - spec.shoulder, white);
    // 車線の境界
    for (let i = 1; i < lanes; i++) {
      const m = spec.shoulder + i * spec.laneWidth;
      const center = !oneway && i === lanes / 2;
      if (!center) line(m, white, true);
      else if (cls === RoadClass.Major) {
        // 幹線の中央線：黄色の実線（はみ出し禁止）を2本
        line(m - lineW / pxPerM, yellow);
        line(m + lineW / pxPerM, yellow);
      } else line(m, white, true);
    }
    // 片側1車線の2車線道路：中央に白破線
    if (!oneway && lanes === 1) line(width / 2, white, true);
  }
  // 路面標示のかすれ
  for (let i = 0; i < 400; i++) {
    g.clearRect(x0 + Math.random() * COLUMN_PX, Math.random() * LENGTH_PX, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  atlasTexture.needsUpdate = true;
}

/**
 * 車道のマテリアル。頂点属性 roadAttr = (路面標示の濃さ 0..1, アスファルトの明るさ)。
 * 交差点の中は標示の濃さを 0 にして、線が交差点を突っ切らないようにする
 */
export function createRoadMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ map: atlasTexture, roughness: 0.92 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.asphaltColor = { value: new THREE.Color(ROADS.asphaltColor) };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 roadAttr;
        varying vec2 vRoadAttr;
        varying vec3 vRoadWorld;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vRoadAttr = roadAttr;
        vRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 asphaltColor;
        varying vec2 vRoadAttr;
        varying vec3 vRoadWorld;
        float roadHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float roadNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(roadHash(i), roadHash(i + vec2(1, 0)), u.x), mix(roadHash(i + vec2(0, 1)), roadHash(i + vec2(1, 1)), u.x), u.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          // アスファルト：補修跡のようなまだらと細かいざらつき
          float patches = roadNoise(vRoadWorld.xz / 9.0) * 0.6 + roadNoise(vRoadWorld.xz / 2.3) * 0.4;
          float grain = roadNoise(vRoadWorld.xz * 3.0);
          vec3 asphalt = asphaltColor * vRoadAttr.y * (0.85 + patches * 0.25 + grain * 0.06);
          vec4 marking = texture2D(map, vMapUv);
          diffuseColor.rgb *= mix(asphalt, marking.rgb, marking.a * vRoadAttr.x);
        }`,
      );
  };
  material.customProgramCacheKey = () => 'road';
  return material;
}

/** 歩道：明るいグレーのタイル張り（1枚の画像 = 2.4m 四方、30cm 角のタイル 8×8） */
export function createSidewalkMaterial(): THREE.MeshStandardMaterial {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const n = 8;
  const cell = size / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 196 + Math.floor((Math.random() - 0.5) * 18);
      g.fillStyle = `rgb(${v}, ${v + 1}, ${v + 4})`;
      g.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // 目地
  g.fillStyle = 'rgba(70, 72, 78, 0.55)';
  for (let i = 0; i <= n; i++) {
    g.fillRect(i * cell - 1, 0, 2, size);
    g.fillRect(0, i * cell - 1, size, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, color: ROADS.sidewalkColor });
}

/** 横断歩道：白い縞（幅 0.45m・間隔 0.45m）。u は道の幅方向に 0.9m で1周期 */
export function createCrosswalkMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 16;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(240, 242, 245, 1)';
  g.fillRect(0, 0, 32, 16);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    alphaTest: 0.5,
    roughness: 0.8,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
