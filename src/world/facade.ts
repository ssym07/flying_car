import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { NIGHT_LIGHTS, WORLD } from '../core/config';
import { isInStation } from './stationFootprints';

/**
 * テクスチャの無い建物（LOD1 など）に貼る、手続き的に描いた外壁テンプレート。
 *
 * - 外壁テンプレートは1枚の画像（アトラス）に縦に並べる。1段が「幅8m × 1フロア3.5m」
 * - 建物ごとに高さを測り、高さに合うテンプレートを選ぶ（高層＝ガラス、低層＝住宅 など）
 * - 窓の段が地面から揃うよう、頂点ごとに「建物の底からの高さ」を持たせる
 * - 横方向は壁に沿ったワールド座標、屋上は真上から見たワールド座標で貼る（UV が無いデータでも貼れる）
 * - 夜は窓が光る：テンプレートと同じ並びの「窓のマスク」（R = 窓、G = 1段の中で左から何番目の窓か）を一緒に描き、
 *   建物・階・窓ごとの乱数で、時刻の割合（NIGHT_LIGHTS.litByHour）だけ点ける
 */

/** 1段の大きさ (m) */
const CELL_WIDTH_M = 8;
const FLOOR_HEIGHT_M = 3.5;
const CELL_W = 256;
const CELL_H = 112;

/** 窓のマスクに窓を描く（x, y, 幅, 高さは px。i は 1段の中で左から何番目の窓か 0..7） */
type WindowMask = (x: number, y: number, w: number, h: number, i: number) => void;
type Painter = (g: CanvasRenderingContext2D, rand: () => number, win: WindowMask) => void;

/**
 * 外壁テンプレート。高さの区分ごとに候補を持つ。
 * 日本の街並みに寄せて、黒・紺・濃いグレーのガラスやタイルを主にする（れんがや明るいグレーは海外っぽく見える）。
 * 同じ候補を複数入れると、その見た目が選ばれやすくなる
 */
const WALLS: Record<'tower' | 'mid' | 'low', Painter[]> = {
  tower: [
    glassWall('#1f3048', '#3a4d66', 4),
    glassWall('#14181e', '#2c333c', 5),
    glassWall('#2a405e', '#4b6382', 3),
    stripeWall('#262b33', '#1a2a40'),
  ],
  mid: [
    punchedWall('#2b3036', '#1b2737', 3),
    stripeWall('#1f2a3a', '#0f1724'),
    glassWall('#24364d', '#3d5068', 4),
    punchedWall('#3a4048', '#16202c', 4),
    apartmentWall('#c4c7cb', '#1e2a38'),
  ],
  low: [
    houseWall('#3d4249', '#1c2633'),
    houseWall('#4a5563', '#1a222c'),
    apartmentWall('#5a6068', '#18212c'),
    houseWall('#c9cac7', '#26303b'),
  ],
};
const NORMAL_ROOFS: Painter[] = [roof('#4e5257'), roof('#64686d'), roof('#3e4247')];
/** 駅の建物の屋上：金属の波板（しましま） */
const ROOFS: Painter[] = [...NORMAL_ROOFS, stripedRoof('#9ea4aa')];
const STATION_ROOF_ROW = WALLS.tower.length + WALLS.mid.length + WALLS.low.length + NORMAL_ROOFS.length;

const WALL_LIST = [...WALLS.tower, ...WALLS.mid, ...WALLS.low];
const ROWS = WALL_LIST.length + ROOFS.length;
const STYLE_OFFSET = { tower: 0, mid: WALLS.tower.length, low: WALLS.tower.length + WALLS.mid.length };
const ROOF_OFFSET = WALL_LIST.length;

/** 高さの区分の境目 (m) */
const TOWER_MIN = 45;
/** これより高い建物は、夜の窓の灯りを白を基本にする */
const TALL_M = 80;
const MID_MIN = 12;

let atlas: { map: THREE.Texture; mask: THREE.Texture } | null = null;

function getAtlas(): { map: THREE.Texture; mask: THREE.Texture } {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H * ROWS;
  const g = canvas.getContext('2d')!;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = CELL_W;
  maskCanvas.height = CELL_H * ROWS;
  const m = maskCanvas.getContext('2d')!;
  m.fillStyle = '#000';
  m.fillRect(0, 0, CELL_W, CELL_H * ROWS);
  const win: WindowMask = (x, y, w, h, i) => {
    m.fillStyle = `rgb(255,${Math.min(7, i) * 32 + 16},0)`;
    m.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
  // 再現性のある乱数（毎回同じ見た目にする）
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // 行 r は下から r 番目（テクスチャ座標の v は下が 0）
  [...WALL_LIST, ...ROOFS].forEach((paint, r) => {
    for (const c of [g, m]) {
      c.save();
      c.translate(0, (ROWS - 1 - r) * CELL_H);
      c.beginPath();
      c.rect(0, 0, CELL_W, CELL_H);
      c.clip();
    }
    paint(g, rand, win);
    g.restore();
    m.restore();
  });
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  // マスクは色ではなく値なので、色空間の変換はしない。窓の番号（G）が混ざらないよう、近い画素をそのまま使う
  const mask = new THREE.CanvasTexture(maskCanvas);
  mask.wrapS = THREE.RepeatWrapping;
  mask.magFilter = THREE.NearestFilter;
  mask.minFilter = THREE.NearestMipmapLinearFilter;
  atlas = { map, mask };
  return atlas;
}

/** 夜の窓の灯り（全部の外壁のマテリアルで同じ値を使う。facadeNight は道路の街灯も使う） */
export const night = {
  facadeNight: { value: 0 },
  facadeLitRatio: { value: 0.5 },
  facadeWarm: { value: new THREE.Color(NIGHT_LIGHTS.warm).multiplyScalar(NIGHT_LIGHTS.glow) },
  facadeCool: { value: new THREE.Color(NIGHT_LIGHTS.cool).multiplyScalar(NIGHT_LIGHTS.glow) },
};

/**
 * 夜の度合い（0..1、Atmosphere の night）と時刻（日本時間の 0 時からの分）から、窓の灯りを決める。毎フレーム呼ぶ
 */
export function setFacadeNight(nightAmount: number, minutes: number): void {
  night.facadeNight.value = nightAmount;
  const table = NIGHT_LIGHTS.litByHour;
  const h = minutes / 60;
  let ratio = table[table.length - 1][1];
  for (let i = 1; i < table.length; i++) {
    const [h1, r1] = table[i];
    const [h0, r0] = table[i - 1];
    if (h <= h1) {
      ratio = r0 + ((r1 - r0) * (h - h0)) / (h1 - h0);
      break;
    }
  }
  night.facadeLitRatio.value = ratio;
}

/** 外壁テンプレートを貼るマテリアル。各メッシュに assignFacadeAttributes で属性を付けておく */
export function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const { map, mask } = getAtlas();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.facadeMap = { value: map };
    shader.uniforms.facadeMask = { value: mask };
    Object.assign(shader.uniforms, night);
    shader.uniforms.facadeBrightness = { value: WORLD.buildings.facadeBrightness };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 facade;
        varying vec3 vFacade;
        varying vec3 vFacadeWorldPos;
        varying vec3 vFacadeWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vFacade = facade;
        vFacadeWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vFacadeWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D facadeMap;
        uniform sampler2D facadeMask;
        uniform float facadeBrightness;
        uniform float facadeNight;
        uniform float facadeLitRatio;
        uniform vec3 facadeWarm;
        uniform vec3 facadeCool;
        float facadeHash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.x + p.y) * p.z);
        }
        varying vec3 vFacade;
        varying vec3 vFacadeWorldPos;
        varying vec3 vFacadeWorldNormal;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 facadeGlow = vec3(0.0);
        {
          const float ROWS = ${ROWS.toFixed(1)};
          const float PAD = ${(1.5 / CELL_H).toFixed(5)};
          vec3 n = normalize(vFacadeWorldNormal);
          float row;
          vec2 cont;
          // 明るさのゆらぎが負の建物は駅（屋上をしましまにする）
          bool station = vFacade.z < 0.0;
          if (abs(n.y) > 0.6) {
            // 屋上：真上から見た座標で貼る
            row = station ? ${STATION_ROOF_ROW.toFixed(1)} : ${ROOF_OFFSET.toFixed(1)} + mod(floor(vFacade.x), ${NORMAL_ROOFS.length.toFixed(1)});
            cont = vFacadeWorldPos.xz / 12.0;
          } else {
            // 壁：壁に沿った水平距離と、建物の底からの高さで貼る
            vec2 t = normalize(vec2(-n.z, n.x));
            row = floor(vFacade.x);
            cont = vec2(dot(vFacadeWorldPos.xz, t) / ${CELL_WIDTH_M.toFixed(1)}, vFacade.y / ${FLOOR_HEIGHT_M.toFixed(1)});
          }
          // 横は画像の幅いっぱいなので繰り返し、縦は自分の段の中だけで繰り返す（隣の段がにじまないよう少し内側）
          float v = (row + PAD + fract(cont.y) * (1.0 - 2.0 * PAD)) / ROWS;
          vec2 g = vec2(1.0, 1.0 / ROWS);
          vec4 facadeColor = textureGrad(facadeMap, vec2(cont.x, v), dFdx(cont) * g, dFdy(cont) * g);
          diffuseColor.rgb *= facadeColor.rgb * abs(vFacade.z) * facadeBrightness;
          // 夜の窓：屋上は光らない。窓ごとに、建物（明るさのゆらぎ）・段の位置・窓の番号から乱数を作り、割合だけ点ける
          if (facadeNight > 0.001 && abs(n.y) <= 0.6) {
            vec4 win = textureGrad(facadeMask, vec2(cont.x, v), dFdx(cont) * g, dFdy(cont) * g);
            if (win.r > 0.01) {
              float building = abs(vFacade.z) * 1000.0;
              float index = floor(win.g * 8.0);
              vec3 cell = vec3(floor(cont.x) * 8.0 + index, floor(cont.y), building);
              // 建物ごとの点き方のばらつき（0.2〜1.5 倍）
              float busy = 0.2 + 1.3 * facadeHash(vec3(building, 3.7, 1.3));
              float on = step(facadeHash(cell), facadeLitRatio * busy);
              // 低い建物（テンプレートの行が大きい）ほど暖色が多い。高さ ${TALL_M}m 以上（テンプレートの番号の小数が 0.5）は
              // 白を基本にして暖色を少しだけ混ぜ、明るさのばらつきも小さくする（色と明るさがばらばらだと目がちかちかする）
              bool tall = fract(vFacade.x) > 0.25;
              float warmShare = tall ? 0.08 : mix(0.35, 0.8, clamp(floor(vFacade.x) / ${(WALL_LIST.length - 1).toFixed(1)}, 0.0, 1.0));
              vec3 tone = facadeHash(cell + 17.0) < warmShare ? facadeWarm : facadeCool;
              // 窓ごとに明るさを少し変える
              tone *= tall ? 0.85 + 0.2 * facadeHash(cell + 41.0) : 0.6 + 0.6 * facadeHash(cell + 41.0);
              facadeGlow = tone * on * win.r * facadeNight;
            }
          }
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += facadeGlow;`,
      );
  };
  // onBeforeCompile を使う他のマテリアルとプログラムを共有しないように
  material.customProgramCacheKey = () => 'facade';
  return material;
}

/**
 * タイルのメッシュに、建物ごとの「テンプレート番号・底からの高さ・明るさのゆらぎ」を頂点属性として付ける。
 * 駅の形（OpenStreetMap の駅舎・上屋）の中にある建物は、明るさのゆらぎを負にして「駅」の印にする。
 * scene の行列はタイルの ECEF 変換を含んでいる前提（processTileModel の時点）
 */
export function assignFacadeAttributes(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const up = new THREE.Vector3();
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geometry = obj.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    // 建物の番号：b3dm（3D Tiles 1.0）は _batchid、glb（3D Tiles 1.1）は _feature_id_0
    const batch = geometry.getAttribute('_batchid') ?? geometry.getAttribute('_feature_id_0');
    if (!position) return;

    // 上方向：地球中心からの向き（タイル内なら1つで十分）
    up.fromBufferAttribute(position, 0).applyMatrix4(obj.matrixWorld).normalize();
    const heights = new Float32Array(position.count);
    const range = new Map<number, { min: number; max: number; footprint: Array<[number, number]> }>();
    const carto = { lat: 0, lon: 0, height: 0 };
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld);
      const h = v.dot(up);
      heights[i] = h;
      const id = batch ? batch.getX(i) : 0;
      let r = range.get(id);
      if (!r) range.set(id, (r = { min: h, max: h, footprint: [] }));
      r.min = Math.min(r.min, h);
      r.max = Math.max(r.max, h);
      // 平面の形（緯度経度, 度）。頂点の多い建物は間引く
      if (r.footprint.length < 64) {
        WGS84_ELLIPSOID.getPositionToCartographic(v, carto);
        r.footprint.push([carto.lat * THREE.MathUtils.RAD2DEG, carto.lon * THREE.MathUtils.RAD2DEG]);
      }
    }

    // 建物ごとにテンプレートを選ぶ（タイルの位置も混ぜて、タイルごとに違う並びにする）
    const tileSeed = Math.round(obj.matrixWorld.elements[12] + obj.matrixWorld.elements[13]);
    const styles = new Map<number, { style: number; tint: number; tall: boolean }>();
    for (const [id, r] of range) {
      const rnd = hash(id * 7919 + tileSeed);
      const height = r.max - r.min;
      const group = height >= TOWER_MIN ? 'tower' : height >= MID_MIN ? 'mid' : 'low';
      const style = STYLE_OFFSET[group] + Math.floor(rnd * WALLS[group].length);
      const tint = 0.85 + hash(id * 31 + tileSeed * 17) * 0.25;
      styles.set(id, { style, tint: isStationBuilding(r.footprint) ? -tint : tint, tall: height >= TALL_M });
    }

    const facade = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const id = batch ? batch.getX(i) : 0;
      const s = styles.get(id)!;
      // 高い建物は、テンプレートの番号に 0.5 を足して印にする（シェーダーは整数の部分を番号に使う）
      facade[i * 3] = s.style + (s.tall ? 0.5 : 0);
      facade[i * 3 + 1] = heights[i] - range.get(id)!.min;
      facade[i * 3 + 2] = s.tint;
    }
    geometry.setAttribute('facade', new THREE.BufferAttribute(facade, 3));
  });
}

/**
 * 建物の平面の形（頂点の緯度経度）が、駅の形（駅舎・ホーム・上屋）にどれだけ重なるかで駅かどうか決める。
 * 形を囲む凸包の中に格子状に点を打ち、そのうち STATION_OVERLAP 以上が駅の形の中なら駅。
 * 線路をまたぐ大きな駅舎は、中心が線路の上でホームの形から外れるので、中心だけでは判定できない
 */
const STATION_OVERLAP = 0.15;
const SAMPLES = 8;

function isStationBuilding(points: Array<[number, number]>): boolean {
  if (points.length < 3) return false;
  const hull = convexHull(points);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of hull) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  let inside = 0;
  let hit = 0;
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const lat = minLat + ((maxLat - minLat) * (j + 0.5)) / SAMPLES;
      const lon = minLon + ((maxLon - minLon) * (i + 0.5)) / SAMPLES;
      if (!insideConvex(hull, lat, lon)) continue;
      inside++;
      if (isInStation(lat, lon)) hit++;
    }
  }
  return inside > 0 && hit / inside >= STATION_OVERLAP;
}

/** 凸包（反時計回り）。点は [緯度, 経度] */
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function insideConvex(hull: Array<[number, number]>, lat: number, lon: number): boolean {
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if ((b[1] - a[1]) * (lat - a[0]) - (b[0] - a[0]) * (lon - a[1]) < 0) return false;
  }
  return true;
}

/** 0..1 の擬似乱数 */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ---- 外壁テンプレートの描画（1段 = 幅8m × 高さ3.5m を 256 × 112 px で描く。1m ≒ 32px） ----

function grime(g: CanvasRenderingContext2D, rand: () => number, alpha: number): void {
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(0,0,0,${rand() * alpha})`;
    g.fillRect(rand() * CELL_W, rand() * CELL_H, 1 + rand() * 3, 1 + rand() * 3);
  }
}

/** 全面ガラスのカーテンウォール */
function glassWall(glass: string, frame: string, mullionsPer8m: number): Painter {
  return (g, rand, win) => {
    const grad = g.createLinearGradient(0, 0, CELL_W, CELL_H);
    grad.addColorStop(0, glass);
    grad.addColorStop(1, shade(glass, 0.75));
    g.fillStyle = grad;
    g.fillRect(0, 0, CELL_W, CELL_H);
    // 空の映り込み
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, 0, CELL_W, CELL_H * 0.35);
    g.fillStyle = frame;
    const step = CELL_W / mullionsPer8m;
    for (let x = 0; x < CELL_W; x += step) g.fillRect(x, 0, 3, CELL_H);
    for (let i = 0; i < mullionsPer8m; i++) win(i * step + 3, 0, step - 3, CELL_H - 12, i);
    // 床スラブ
    g.fillStyle = shade(glass, 0.55);
    g.fillRect(0, CELL_H - 12, CELL_W, 12);
    grime(g, rand, 0.06);
  };
}

/** 水平の帯（腰壁）と横長の窓が交互 */
function stripeWall(band: string, glass: string): Painter {
  return (g, rand, win) => {
    g.fillStyle = band;
    g.fillRect(0, 0, CELL_W, CELL_H);
    g.fillStyle = glass;
    g.fillRect(0, 14, CELL_W, CELL_H * 0.55);
    g.fillStyle = shade(band, 0.85);
    for (let x = 0; x < CELL_W; x += 64) g.fillRect(x, 14, 3, CELL_H * 0.55);
    for (let i = 0; i < 4; i++) win(i * 64 + 3, 14, 61, CELL_H * 0.55, i);
    grime(g, rand, 0.12);
  };
}

/** 壁に窓が並ぶ（オフィス・れんが） */
function punchedWall(wall: string, glass: string, windowsPer8m: number): Painter {
  return (g, rand, win) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, CELL_W, CELL_H);
    const step = CELL_W / windowsPer8m;
    for (let i = 0; i < windowsPer8m; i++) {
      const x = i * step + step * 0.18;
      g.fillStyle = shade(wall, 0.7);
      g.fillRect(x - 2, 22, step * 0.64 + 4, 60);
      g.fillStyle = glass;
      g.fillRect(x, 24, step * 0.64, 56);
      win(x, 24, step * 0.64, 56, i);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x, 24, step * 0.64, 14);
    }
    grime(g, rand, 0.15);
  };
}

/** マンション：窓＋ベランダの手すり */
function apartmentWall(wall: string, glass: string): Painter {
  return (g, rand, win) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, CELL_W, CELL_H);
    for (let i = 0; i < 2; i++) {
      const x = i * 128 + 14;
      g.fillStyle = glass;
      g.fillRect(x, 12, 100, 70);
      // ベランダの手すりの上に見える所だけ
      win(x, 12, 100, 50, i);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(x, 12, 100, 16);
    }
    // ベランダの手すり
    g.fillStyle = shade(wall, 0.9);
    g.fillRect(0, 62, CELL_W, 34);
    g.fillStyle = shade(wall, 0.65);
    g.fillRect(0, 62, CELL_W, 3);
    for (let x = 0; x < CELL_W; x += 128) g.fillRect(x, 0, 4, CELL_H);
    g.fillStyle = shade(wall, 0.75);
    g.fillRect(0, CELL_H - 10, CELL_W, 10);
    grime(g, rand, 0.12);
  };
}

/** 戸建て：小さめの窓 */
function houseWall(wall: string, glass: string): Painter {
  return (g, rand, win) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, CELL_W, CELL_H);
    // サイディングの目地
    g.fillStyle = shade(wall, 0.92);
    for (let y = 0; y < CELL_H; y += 8) g.fillRect(0, y, CELL_W, 1);
    for (const x of [40, 170]) {
      g.fillStyle = '#f2f0ea';
      g.fillRect(x - 3, 30, 52, 50);
      g.fillStyle = glass;
      g.fillRect(x, 33, 46, 44);
      win(x, 33, 46, 44, x < 100 ? 0 : 1);
      g.fillStyle = '#f2f0ea';
      g.fillRect(x + 21, 33, 3, 44);
    }
    grime(g, rand, 0.12);
  };
}

/** 屋上：コンクリートと設備 */
function roof(base: string): Painter {
  return (g, rand) => {
    g.fillStyle = base;
    g.fillRect(0, 0, CELL_W, CELL_H);
    for (let i = 0; i < 600; i++) {
      const c = rand() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
      g.fillStyle = c;
      g.fillRect(rand() * CELL_W, rand() * CELL_H, 2 + rand() * 6, 2 + rand() * 6);
    }
    g.fillStyle = shade(base, 0.8);
    g.fillRect(40, 30, 36, 28);
    g.fillRect(170, 60, 24, 24);
  };
}

/** 駅の屋根：金属の波板。細い明暗の筋を繰り返す */
function stripedRoof(base: string): Painter {
  return (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, CELL_W, CELL_H);
    // 1m ≒ 32px。0.9m 間隔の山と谷
    for (let x = 0; x < CELL_W; x++) {
      const k = 0.5 + 0.5 * Math.cos((x / 29) * Math.PI * 2);
      g.fillStyle = `rgba(255,255,255,${0.22 * k})`;
      g.fillRect(x, 0, 1, CELL_H);
      g.fillStyle = `rgba(0,0,0,${0.18 * (1 - k)})`;
      g.fillRect(x, 0, 1, CELL_H);
    }
  };
}

/** 色を k 倍に暗くする */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const gr = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${gr},${b})`;
}

/**
 * 手で作った建物（src/world/landmarks）の材質に、夜の窓の灯りを足す。窓のマスクは無いので、
 * 建物の座標で「階 3.8m × 幅 1.8m」の格子を作り、その内側を窓として、外壁テンプレートと同じ割合（時刻）で点ける。
 * 模様の明るい所（石・白いルーバー・れんがの目地）は弱くし、屋上（上を向いた面）は光らない
 */
export function addNightWindows(material: THREE.MeshStandardMaterial): void {
  if (material.userData.nightWindows) return;
  material.userData.nightWindows = true;
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    Object.assign(shader.uniforms, night);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLmPos;
        varying vec3 vLmNormal;
        varying vec2 vLmSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLmPos = position;
        vLmNormal = normal;
        vLmSeed = modelMatrix[3].xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float facadeNight;
        uniform float facadeLitRatio;
        uniform vec3 facadeWarm;
        uniform vec3 facadeCool;
        varying vec3 vLmPos;
        varying vec3 vLmNormal;
        varying vec2 vLmSeed;
        float lmHash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.x + p.y) * p.z);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 lmGlow = vec3(0.0);
        if (facadeNight > 0.001) {
          vec3 nn = normalize(vLmNormal);
          if (abs(nn.y) < 0.5) {
            vec2 t = normalize(vec2(-nn.z, nn.x));
            float u = dot(vLmPos.xz, t) / 1.8;
            float w = vLmPos.y / 3.8;
            vec2 f = fract(vec2(u, w));
            float inside = step(0.12, f.x) * step(f.x, 0.88) * step(0.22, f.y) * step(f.y, 0.86);
            // 建物（置いた位置）と壁の向きで乱数を変える
            float building = floor(vLmSeed.x * 0.37 + vLmSeed.y * 0.73) + dot(sign(nn), vec3(1.0, 3.0, 7.0));
            vec3 cell = vec3(floor(u), floor(w), building);
            float busy = 0.2 + 1.3 * lmHash(vec3(building, 3.7, 1.3));
            float on = step(lmHash(cell), facadeLitRatio * busy);
            // 模様の明るい所（石・白いルーバー）は窓ではないので弱く
            float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            float glassy = 1.0 - smoothstep(0.25, 0.6, lum);
            // 手で作った建物は高層ビルが多いので、白を基本にして暖色は少しだけ、明るさのばらつきも小さく
            vec3 tone = lmHash(cell + 17.0) < 0.08 ? facadeWarm : facadeCool;
            tone *= 0.85 + 0.2 * lmHash(cell + 41.0);
            lmGlow = tone * on * inside * glassy * facadeNight;
          }
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += lmGlow;`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|night-windows`;
  material.needsUpdate = true;
}
