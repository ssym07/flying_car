import * as THREE from 'three';

/**
 * テクスチャの無い建物（LOD1 など）に貼る、手続き的に描いた外壁テンプレート。
 *
 * - 外壁テンプレートは1枚の画像（アトラス）に縦に並べる。1段が「幅8m × 1フロア3.5m」
 * - 建物ごとに高さを測り、高さに合うテンプレートを選ぶ（高層＝ガラス、低層＝住宅 など）
 * - 窓の段が地面から揃うよう、頂点ごとに「建物の底からの高さ」を持たせる
 * - 横方向は壁に沿ったワールド座標、屋上は真上から見たワールド座標で貼る（UV が無いデータでも貼れる）
 */

/** 1段の大きさ (m) */
const CELL_WIDTH_M = 8;
const FLOOR_HEIGHT_M = 3.5;
const CELL_W = 256;
const CELL_H = 112;

type Painter = (g: CanvasRenderingContext2D, rand: () => number) => void;

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
const ROOFS: Painter[] = [roof('#4e5257'), roof('#64686d'), roof('#3e4247')];

const WALL_LIST = [...WALLS.tower, ...WALLS.mid, ...WALLS.low];
const ROWS = WALL_LIST.length + ROOFS.length;
const STYLE_OFFSET = { tower: 0, mid: WALLS.tower.length, low: WALLS.tower.length + WALLS.mid.length };
const ROOF_OFFSET = WALL_LIST.length;

/** 高さの区分の境目 (m) */
const TOWER_MIN = 45;
const MID_MIN = 12;

let atlas: THREE.Texture | null = null;

function getAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W;
  canvas.height = CELL_H * ROWS;
  const g = canvas.getContext('2d')!;
  // 再現性のある乱数（毎回同じ見た目にする）
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // 行 r は下から r 番目（テクスチャ座標の v は下が 0）
  [...WALL_LIST, ...ROOFS].forEach((paint, r) => {
    g.save();
    g.translate(0, (ROWS - 1 - r) * CELL_H);
    g.beginPath();
    g.rect(0, 0, CELL_W, CELL_H);
    g.clip();
    paint(g, rand);
    g.restore();
  });
  atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.wrapS = THREE.RepeatWrapping;
  atlas.anisotropy = 8;
  return atlas;
}

/** 外壁テンプレートを貼るマテリアル。各メッシュに assignFacadeAttributes で属性を付けておく */
export function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const map = getAtlas();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.facadeMap = { value: map };
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
        varying vec3 vFacade;
        varying vec3 vFacadeWorldPos;
        varying vec3 vFacadeWorldNormal;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          const float ROWS = ${ROWS.toFixed(1)};
          const float PAD = ${(1.5 / CELL_H).toFixed(5)};
          vec3 n = normalize(vFacadeWorldNormal);
          float row;
          vec2 cont;
          if (abs(n.y) > 0.6) {
            // 屋上：真上から見た座標で貼る
            row = ${ROOF_OFFSET.toFixed(1)} + mod(vFacade.x, ${ROOFS.length.toFixed(1)});
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
          diffuseColor.rgb *= facadeColor.rgb * vFacade.z;
        }`,
      );
  };
  // onBeforeCompile を使う他のマテリアルとプログラムを共有しないように
  material.customProgramCacheKey = () => 'facade';
  return material;
}

/**
 * タイルのメッシュに、建物ごとの「テンプレート番号・底からの高さ・明るさのゆらぎ」を頂点属性として付ける。
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
    const batch = geometry.getAttribute('_batchid');
    if (!position) return;

    // 上方向：地球中心からの向き（タイル内なら1つで十分）
    up.fromBufferAttribute(position, 0).applyMatrix4(obj.matrixWorld).normalize();
    const heights = new Float32Array(position.count);
    const range = new Map<number, { min: number; max: number }>();
    for (let i = 0; i < position.count; i++) {
      const h = v.fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld).dot(up);
      heights[i] = h;
      const id = batch ? batch.getX(i) : 0;
      const r = range.get(id);
      if (!r) range.set(id, { min: h, max: h });
      else {
        r.min = Math.min(r.min, h);
        r.max = Math.max(r.max, h);
      }
    }

    // 建物ごとにテンプレートを選ぶ（タイルの位置も混ぜて、タイルごとに違う並びにする）
    const tileSeed = Math.round(obj.matrixWorld.elements[12] + obj.matrixWorld.elements[13]);
    const styles = new Map<number, { style: number; tint: number }>();
    for (const [id, r] of range) {
      const rnd = hash(id * 7919 + tileSeed);
      const height = r.max - r.min;
      const group = height >= TOWER_MIN ? 'tower' : height >= MID_MIN ? 'mid' : 'low';
      const style = STYLE_OFFSET[group] + Math.floor(rnd * WALLS[group].length);
      styles.set(id, { style, tint: 0.85 + hash(id * 31 + tileSeed * 17) * 0.25 });
    }

    const facade = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const id = batch ? batch.getX(i) : 0;
      const s = styles.get(id)!;
      facade[i * 3] = s.style;
      facade[i * 3 + 1] = heights[i] - range.get(id)!.min;
      facade[i * 3 + 2] = s.tint;
    }
    geometry.setAttribute('facade', new THREE.BufferAttribute(facade, 3));
  });
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
  return (g, rand) => {
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
    // 床スラブ
    g.fillStyle = shade(glass, 0.55);
    g.fillRect(0, CELL_H - 12, CELL_W, 12);
    grime(g, rand, 0.06);
  };
}

/** 水平の帯（腰壁）と横長の窓が交互 */
function stripeWall(band: string, glass: string): Painter {
  return (g, rand) => {
    g.fillStyle = band;
    g.fillRect(0, 0, CELL_W, CELL_H);
    g.fillStyle = glass;
    g.fillRect(0, 14, CELL_W, CELL_H * 0.55);
    g.fillStyle = shade(band, 0.85);
    for (let x = 0; x < CELL_W; x += 64) g.fillRect(x, 14, 3, CELL_H * 0.55);
    grime(g, rand, 0.12);
  };
}

/** 壁に窓が並ぶ（オフィス・れんが） */
function punchedWall(wall: string, glass: string, windowsPer8m: number): Painter {
  return (g, rand) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, CELL_W, CELL_H);
    const step = CELL_W / windowsPer8m;
    for (let i = 0; i < windowsPer8m; i++) {
      const x = i * step + step * 0.18;
      g.fillStyle = shade(wall, 0.7);
      g.fillRect(x - 2, 22, step * 0.64 + 4, 60);
      g.fillStyle = glass;
      g.fillRect(x, 24, step * 0.64, 56);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x, 24, step * 0.64, 14);
    }
    grime(g, rand, 0.15);
  };
}

/** マンション：窓＋ベランダの手すり */
function apartmentWall(wall: string, glass: string): Painter {
  return (g, rand) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, CELL_W, CELL_H);
    for (let i = 0; i < 2; i++) {
      const x = i * 128 + 14;
      g.fillStyle = glass;
      g.fillRect(x, 12, 100, 70);
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
  return (g, rand) => {
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

/** 色を k 倍に暗くする */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const gr = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${gr},${b})`;
}
