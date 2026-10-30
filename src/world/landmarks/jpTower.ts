import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, cap, facadeMaterial } from './azabudaiHills';

/**
 * JPタワー（2012年、200m）と、低層部に残した旧東京中央郵便局（KITTE、1931年）。写真を参考に作る。
 * 座標：敷地の中心が (cx, 0, 0)、x = 東、z = 南、y = 上。平面の点は [東, 南]（m）で書く。
 *
 * - 低層部：旧郵便局の白いタイルの壁に、黒い枠の窓の格子。東京駅に向いた北東の面は斜め（駅前の広場に沿う）。
 *   その面の真ん中に時計。屋上は庭園（KITTE ガーデン）
 * - 塔：駅の側の面は、折れ目のある2枚の青いガラスの面。屋上より上までガラスが伸び、上の縁は真ん中が下がる。
 *   ほかの面は白っぽい横の帯（庇）と暗いガラスの縞
 */
export interface JpTowerParts {
  podium: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  band: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  green: THREE.BufferGeometry;
  clock: THREE.BufferGeometry;
}

type P2 = [number, number];

/** 敷地（PLATEAU の形を簡単にしたもの）。北東の斜めの面 = 最後の点 → 最初の点 */
const SITE: P2[] = [
  [28.9, -30.6],
  [-45.9, -52.7],
  [-65.8, 33.1],
  [-3, 49.9],
  [0, 38.3],
  [57.3, 52.7],
  [62.8, 32.4],
];
/** 塔。T2 → T3 → T4 が駅の側のガラスの面（T3 が折れ目） */
const TOWER: P2[] = [
  [-42, -46],
  [14, -29],
  [34, 2],
  [40, 34],
  [-50, 24],
];
const PODIUM_TOP = 25;
const TOWER_TOP = 190;

/** 点 a〜b の間の縦の壁。下 y0、上は a の側 ya・b の側 yb（uv：横 / 3m、縦 / FLOOR） */
function wall(cx: number, a: P2, b: P2, y0: number, ya: number, yb: number, u0 = 0): THREE.BufferGeometry {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u1 = u0 + len / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        ...[cx + a[0], y0, a[1]],
        ...[cx + b[0], y0, b[1]],
        ...[cx + b[0], yb, b[1]],
        ...[cx + a[0], y0, a[1]],
        ...[cx + b[0], yb, b[1]],
        ...[cx + a[0], ya, a[1]],
      ],
      3,
    ),
  );
  g.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      [u0, y0 / FLOOR, u1, y0 / FLOOR, u1, yb / FLOOR, u0, y0 / FLOOR, u1, yb / FLOOR, u0, ya / FLOOR],
      2,
    ),
  );
  return g;
}

/** 平面の形（x・y の平面、y = 南）。向きは左回りにそろえる */
function shape(pts: P2[]): THREE.Shape {
  const area = pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0);
  const list = area < 0 ? [...pts].reverse() : pts;
  return new THREE.Shape(list.map(([x, y]) => new THREE.Vector2(x, y)));
}

export function buildJpTower(cx: number): JpTowerParts {
  const P: Record<keyof JpTowerParts, THREE.BufferGeometry[]> = {
    podium: [],
    glass: [],
    band: [],
    frame: [],
    roof: [],
    green: [],
    clock: [],
  };

  // ---- 低層部：旧郵便局の白い壁（〜25m）と、上の細い軒、屋上 ----
  for (let i = 0; i < SITE.length; i++) {
    const a = SITE[i];
    const b = SITE[(i + 1) % SITE.length];
    P.podium.push(wall(cx, a, b, 0, PODIUM_TOP, PODIUM_TOP));
    P.frame.push(wall(cx, a, b, PODIUM_TOP, PODIUM_TOP + 1.2, PODIUM_TOP + 1.2));
  }
  P.roof.push(cap(shape(SITE), cx, PODIUM_TOP - 1.4));
  // 屋上の庭園：斜めの面と塔のガラスの面の間
  P.green.push(
    cap(
      shape([
        [58, 31],
        [28, -26],
        [14, -26],
        [33, 2],
        [38, 32],
      ]),
      cx,
      PODIUM_TOP - 1.2,
    ),
  );
  // 斜めの面の真ん中の時計（白い文字盤と暗い縁）
  {
    const a = SITE[SITE.length - 1];
    const b = SITE[0];
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    // 外向き（北東）の向き
    const nx = b[1] - a[1];
    const nz = -(b[0] - a[0]);
    const n = Math.hypot(nx, nz);
    const angle = Math.atan2(nx / n, nz / n);
    const at = (g: THREE.BufferGeometry, out: number) =>
      g.rotateY(angle).translate(cx + mx + (nx / n) * out, 19, mz + (nz / n) * out);
    P.frame.push(at(new THREE.CylinderGeometry(1.9, 1.9, 0.3, 24).rotateX(Math.PI / 2), 0.15));
    P.clock.push(at(new THREE.CircleGeometry(1.6, 24), 0.32));
  }

  // ---- 塔：駅の側の2枚のガラスの面（屋上より上へ伸び、上の縁は折れ目で下がる）と、ほかの面の横の帯 ----
  const glassTop = [201, 196.5, 201];
  for (let i = 0; i < TOWER.length; i++) {
    const a = TOWER[i];
    const b = TOWER[(i + 1) % TOWER.length];
    if (i === 1 || i === 2) {
      P.glass.push(wall(cx, a, b, PODIUM_TOP, glassTop[i - 1], glassTop[i]));
    } else {
      P.band.push(wall(cx, a, b, PODIUM_TOP, TOWER_TOP, TOWER_TOP));
      P.frame.push(wall(cx, a, b, TOWER_TOP, TOWER_TOP + 2, TOWER_TOP + 2));
    }
  }
  P.roof.push(cap(shape(TOWER), cx, TOWER_TOP - 1.5));
  // ガラスの上の部分の裏の骨組み（横の梁と縦の柱）
  for (const [i, j] of [
    [1, 2],
    [2, 3],
  ]) {
    const a = TOWER[i];
    const b = TOWER[j];
    const inset = (p: P2): P2 => [p[0] - 1.2, p[1]];
    for (const y of [193.5, 197]) P.frame.push(wall(cx, inset(a), inset(b), y, y + 0.5, y + 0.5));
    for (let t = 0; t <= 1.0001; t += 0.25) {
      const x = a[0] + (b[0] - a[0]) * t - 1.4;
      const z = a[1] + (b[1] - a[1]) * t;
      const top = glassTop[i - 1] + (glassTop[j - 1] - glassTop[i - 1]) * t - 0.5;
      P.frame.push(new THREE.BoxGeometry(0.5, top - TOWER_TOP, 0.5).translate(cx + x, (top + TOWER_TOP) / 2, z));
    }
  }

  const merge = (list: THREE.BufferGeometry[]) => {
    const prepared = list.map((g) => {
      const out = g.index ? g.toNonIndexed() : g;
      for (const name of Object.keys(out.attributes))
        if (name !== 'position' && name !== 'uv') out.deleteAttribute(name);
      if (!out.getAttribute('uv')) {
        out.setAttribute(
          'uv',
          new THREE.Float32BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2),
        );
      }
      return out;
    });
    const g = mergeGeometries(prepared)!;
    for (const x of list) x.dispose();
    g.computeVertexNormals();
    return g;
  };
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, merge(v)])) as unknown as JpTowerParts;
}

/** 旧郵便局の壁：白いタイルに、黒い枠の窓（田の字の桟）（1枚 = 3m × 1階、窓 1 つ） */
export function createPostOfficeMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#ebe8e1';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#2c3034';
      g.fillRect(W * 0.2, H * 0.2, W * 0.6, H * 0.58);
      g.fillStyle = '#7d8c99';
      g.fillRect(W * 0.24, H * 0.24, W * 0.52, H * 0.5);
      g.fillStyle = '#2c3034';
      g.fillRect(W * 0.49, H * 0.24, 2, H * 0.5);
      g.fillRect(W * 0.24, H * 0.45, W * 0.52, 2);
    },
    0.7,
    0,
  );
}

/** 駅の側のガラス：空を映す青いガラスに、細い縦横の桟（1枚 = 3m × 1階） */
export function createJpGlassMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#7fb0e2');
      grad.addColorStop(1, '#4a82c4');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(200,215,230,0.55)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(W / 2, 0, 1, H);
      g.fillRect(0, H - 2, W, 2);
    },
    0.1,
    0.35,
  );
}

/** ほかの面：白っぽい横の帯（庇）と暗いガラスの縞（1枚 = 3m × 1階） */
export function createJpBandMaterial(): THREE.MeshStandardMaterial {
  return facadeMaterial(
    (g, W, H) => {
      g.fillStyle = '#4c5966';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#d4d6d8';
      g.fillRect(0, H * 0.62, W, H * 0.38);
      g.fillStyle = 'rgba(180,190,200,0.5)';
      g.fillRect(0, 0, 2, H * 0.62);
    },
    0.45,
    0.2,
  );
}
