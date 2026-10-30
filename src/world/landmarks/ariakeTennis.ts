import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 有明テニスの森公園（テニスコート・インドアコート・ショーコート）と有明コロシアム。案内図と航空写真を参考に作る。
 *
 * 公園：中心（緯度 35.6355, 経度 139.788）が (cx, 0, 0)、x = 公園の長い向き（東北東、東から 33.5°）、
 * z = それに直角（南南東が +）、y = 上。位置は OpenStreetMap のコート・インドアコートの形に合わせる。
 * - 屋外コート：青いハードコート（外側は少し明るい青、白い線）。北西に4面ずつの4つの区画、南西に2面ずつの10の区画。
 *   区画のまわりに植え込み
 * - インドアコート：白い屋根（縦の筋）と、ガラスの壁
 * - ショーコート：1面のコートをすり鉢の観客席が囲み、南に白い屋根
 *
 * コロシアム：中心が (cx, 0, 0)、x = 長い向き（東から 18.4°）、z = それに直角、y = 上。
 * 長い辺が外へふくらむ平面。白い壁と、真ん中の継ぎ目で2つに分かれた白い膨らんだ屋根（開閉式）。継ぎ目から中の青いコート
 */
export interface TennisParts {
  court: THREE.BufferGeometry;
  hedge: THREE.BufferGeometry;
  white: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  seats: THREE.BufferGeometry;
}
export interface ColiseumParts {
  wall: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  court: THREE.BufferGeometry;
  seats: THREE.BufferGeometry;
}

type P2 = [number, number];

/** 公園の座標：u = 東北東、v = 南南東。(東, 南) の m から直す */
const U: P2 = [0.834, -0.552];
const V: P2 = [0.552, 0.834];
const toUV = ([e, s]: P2): P2 => [e * U[0] + s * U[1], e * V[0] + s * V[1]];

/** インドアコートの平面（OpenStreetMap、(東, 南) m） */
const INDOOR: P2[] = [
  [-136.6, -7.8],
  [-83.0, 74.8],
  [-25.6, 37.5],
  [-31.1, 29.0],
  [-15.1, 18.7],
  [-63.2, -55.4],
];

/** 1面のコート（外側を含む 18 × 36m）の板。中心 (x, z)、長い向きは z */
function courtPlate(x: number, z: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(18, 36).rotateX(-Math.PI / 2).translate(x, 0.12, z);
}

/** 箱 */
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);

/** 長方形の区画のまわりの植え込み（高さ 1.6m、幅 1.6m） */
function hedgeRing(list: THREE.BufferGeometry[], x0: number, x1: number, z0: number, z1: number): void {
  list.push(box(x0, x1, 0, 1.6, z0 - 1.6, z0));
  list.push(box(x0, x1, 0, 1.6, z1, z1 + 1.6));
  list.push(box(x0 - 1.6, x0, 0, 1.6, z0 - 1.6, z1 + 1.6));
  list.push(box(x1, x1 + 1.6, 0, 1.6, z0 - 1.6, z1 + 1.6));
}

function mergeAll<K extends string>(P: Record<K, THREE.BufferGeometry[]>): Record<K, THREE.BufferGeometry> {
  const one = (list: THREE.BufferGeometry[]) => {
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
  return Object.fromEntries(Object.entries(P).map(([k, v]) => [k, one(v as THREE.BufferGeometry[])])) as Record<
    K,
    THREE.BufferGeometry
  >;
}

export function buildAriakeTennis(cx: number): TennisParts {
  const P: Record<keyof TennisParts, THREE.BufferGeometry[]> = {
    court: [],
    hedge: [],
    white: [],
    glass: [],
    seats: [],
  };

  // ---- 南西の10区画（2面ずつ、2列×5）。OpenStreetMap のコートの区画（約 50 × 48m）に合わせる ----
  for (const v0 of [38, 88]) {
    for (let k = 0; k < 5; k++) {
      const u0 = -243 + k * 47;
      for (const du of [-9.5, 9.5]) P.court.push(courtPlate(cx + u0 + 24 + du, v0 + 24));
      hedgeRing(P.hedge, cx + u0 + 3, cx + u0 + 45, v0 + 3, v0 + 45);
    }
  }
  // ---- 北西の4区画（4面ずつ、2×2） ----
  for (const v0 of [-68, -26]) {
    for (const u0 of [-300, -216]) {
      for (let k = 0; k < 4; k++) P.court.push(courtPlate(cx + u0 + 9 + k * 18, v0 + 18));
      hedgeRing(P.hedge, cx + u0, cx + u0 + 72, v0, v0 + 36);
    }
  }

  // ---- インドアコート：ガラスの壁（〜10m）と白い屋根（縦の筋） ----
  {
    const pts = INDOOR.map(toUV);
    const shape = new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, -v)));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            cx + a[0],
            0,
            a[1],
            cx + b[0],
            0,
            b[1],
            cx + b[0],
            10,
            b[1],
            cx + a[0],
            0,
            a[1],
            cx + b[0],
            10,
            b[1],
            cx + a[0],
            10,
            a[1],
          ],
          3,
        ),
      );
      P.glass.push(g);
    }
    // 屋根：少し張り出した白い板（筋の模様は uv で）。上向きの面になるよう y = -z の形を -90° 回す
    const roof = new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false })
      .rotateX(-Math.PI / 2)
      .translate(cx, 10, 0);
    P.white.push(roof);
  }
  // クラブハウス（インドアコートの東）
  P.white.push(box(cx - 20, cx + 2, 0, 8, -72, -48));

  // ---- ショーコート：1面のコート、すり鉢の観客席（12m まで）、南の白い屋根 ----
  {
    const sx = cx + 55;
    const sz = 84;
    P.court.push(courtPlate(sx, sz));
    // 観客席：コートのまわり（20 × 38m）から外（60 × 72m）へ上がる斜面
    const ring = (w0: number, d0: number, y0: number, w1: number, d1: number, y1: number) => {
      const c = (w: number, d: number, y: number): THREE.Vector3[] => [
        new THREE.Vector3(sx - w, y, sz - d),
        new THREE.Vector3(sx + w, y, sz - d),
        new THREE.Vector3(sx + w, y, sz + d),
        new THREE.Vector3(sx - w, y, sz + d),
      ];
      const a = c(w0, d0, y0);
      const b = c(w1, d1, y1);
      const pos: number[] = [];
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        pos.push(
          ...a[i].toArray(),
          ...a[j].toArray(),
          ...b[j].toArray(),
          ...a[i].toArray(),
          ...b[j].toArray(),
          ...b[i].toArray(),
        );
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      return g;
    };
    P.seats.push(ring(11, 20, 1, 30, 36, 12));
    // 外壁と、南の白い屋根（観客席の上に張り出す）
    P.white.push(box(sx - 31, sx + 31, 0, 12.5, sz - 37, sz - 36));
    P.white.push(box(sx - 31, sx + 31, 0, 12.5, sz + 36, sz + 37));
    P.white.push(box(sx - 31, sx - 30, 0, 12.5, sz - 37, sz + 37));
    P.white.push(box(sx + 30, sx + 31, 0, 12.5, sz - 37, sz + 37));
    P.white.push(
      new THREE.CylinderGeometry(14, 14, 58, 24, 1, true, 0, Math.PI)
        .rotateZ(Math.PI / 2)
        .scale(1, 0.45, 1)
        .translate(sx, 12, sz + 26),
    );
  }

  return mergeAll(P);
}

/** コロシアム：長さ 145m、幅 114m。長い辺は外へ 12m ふくらむ */
export function buildAriakeColiseum(cx: number): ColiseumParts {
  const P: Record<keyof ColiseumParts, THREE.BufferGeometry[]> = { wall: [], roof: [], dark: [], court: [], seats: [] };
  const HX = 72.5;
  const HZ = 57;
  const BULGE = 12;
  const WALL = 20;
  const SEAM = 3;
  const N = 40;
  /** 長い辺の、x での z（中心から） */
  const edge = (x: number) => HZ + BULGE * (1 - (x / HX) ** 2);
  // 外周の点（左回り）
  const outline: P2[] = [];
  for (let i = 0; i <= N; i++) {
    const x = -HX + (2 * HX * i) / N;
    outline.push([x, edge(x)]);
  }
  for (let i = 0; i <= N; i++) {
    const x = HX - (2 * HX * i) / N;
    outline.push([x, -edge(x)]);
  }
  // ---- 外壁（〜20m）：白い壁 ----
  {
    const pos: number[] = [];
    const uv: number[] = [];
    let run = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      pos.push(cx + a[0], 0, a[1], cx + b[0], 0, b[1], cx + b[0], WALL, b[1]);
      pos.push(cx + a[0], 0, a[1], cx + b[0], WALL, b[1], cx + a[0], WALL, a[1]);
      uv.push(
        run / 4,
        0,
        (run + len) / 4,
        0,
        (run + len) / 4,
        WALL / 4,
        run / 4,
        0,
        (run + len) / 4,
        WALL / 4,
        run / 4,
        WALL / 4,
      );
      run += len;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    P.wall.push(g);
  }
  // ---- 屋根：継ぎ目（z = 0）の両側の、膨らんだ白い殻 ----
  for (const side of [-1, 1]) {
    const S = 32;
    const T = 16;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= S; i++) {
      const s = -1 + (2 * i) / S;
      const x = s * HX;
      for (let j = 0; j <= T; j++) {
        const t = j / T;
        const z = side * (SEAM + (edge(x) - SEAM) * t);
        const lift = Math.sin(Math.PI * t) ** 0.6 * (1 - Math.abs(s) ** 6) ** 0.5;
        pos.push(cx + x, WALL + 16 * lift, z);
        uv.push(x / 6, z / 6);
      }
    }
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < T; j++) {
        const a = i * (T + 1) + j;
        const b = a + T + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    P.roof.push(g);
  }
  // ---- 中：すり鉢の観客席（暗い）、青いコート ----
  {
    const pos: number[] = [];
    const ringAt = (k: number): P2[] => outline.map(([x, z]) => [x * k, z * k]);
    const inner = ringAt(0.32);
    const outer = ringAt(0.94);
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      const a0 = inner[i];
      const b0 = inner[j];
      const a1 = outer[i];
      const b1 = outer[j];
      pos.push(cx + a0[0], 1, a0[1], cx + b0[0], 1, b0[1], cx + b1[0], WALL - 2, b1[1]);
      pos.push(cx + a0[0], 1, a0[1], cx + b1[0], WALL - 2, b1[1], cx + a1[0], WALL - 2, a1[1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    P.seats.push(g);
    P.court.push(
      new THREE.PlaneGeometry(22, 40)
        .rotateX(-Math.PI / 2)
        .rotateY(Math.PI / 2)
        .translate(cx, 1.05, 0),
    );
    P.dark.push(new THREE.PlaneGeometry(2 * HX * 0.34, 2 * HZ * 0.4).rotateX(-Math.PI / 2).translate(cx, 1.0, 0));
  }
  return mergeAll(P);
}

/** 1面のテニスコート（外側を含む 18 × 36m）：青いハードコート、外側は少し明るい青、白い線 */
export function createTennisCourtMaterial(): THREE.MeshStandardMaterial {
  const W = 180;
  const H = 360;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3f86c9';
  g.fillRect(0, 0, W, H);
  // コートの中（ダブルス 10.97 × 23.77m）
  const m = 10; // 1m の画素
  const cw = 10.97 * m;
  const ch = 23.77 * m;
  const x0 = (W - cw) / 2;
  const y0 = (H - ch) / 2;
  g.fillStyle = '#2459a8';
  g.fillRect(x0, y0, cw, ch);
  g.strokeStyle = '#f4f6f8';
  g.lineWidth = 2;
  g.strokeRect(x0, y0, cw, ch);
  // シングルスの線・サービスライン・センターライン・ネット
  const sx = ((10.97 - 8.23) / 2) * m;
  g.beginPath();
  g.moveTo(x0 + sx, y0);
  g.lineTo(x0 + sx, y0 + ch);
  g.moveTo(x0 + cw - sx, y0);
  g.lineTo(x0 + cw - sx, y0 + ch);
  const sv = (23.77 / 2 - 6.4) * m;
  g.moveTo(x0 + sx, y0 + sv);
  g.lineTo(x0 + cw - sx, y0 + sv);
  g.moveTo(x0 + sx, y0 + ch - sv);
  g.lineTo(x0 + cw - sx, y0 + ch - sv);
  g.moveTo(W / 2, y0 + sv);
  g.lineTo(W / 2, y0 + ch - sv);
  g.stroke();
  g.fillStyle = '#1c2630';
  g.fillRect(x0 - 8, H / 2 - 2, cw + 16, 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 });
}

/** インドアコートの白い屋根：縦の筋（明かり取り）の模様（uv は m） */
export function createRibbedRoofMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#eef0f1';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#b9c3cc';
  g.fillRect(0, 0, 4, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / 4, 1 / 4);
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, side: THREE.DoubleSide });
}

/** コロシアムの白い壁：横の目地と、上の暗い窓の帯（uv は 4m 単位） */
export function createColiseumWallMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#e7e9ea';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = 'rgba(120,128,136,0.5)';
  g.fillRect(0, 30, 32, 2);
  g.fillRect(30, 0, 2, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, side: THREE.DoubleSide });
}
