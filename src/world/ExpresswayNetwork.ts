import * as THREE from 'three';
import { EXPRESSWAYS, WATER } from '../core/config';
import { cutFloor, smoothGround } from './groundProfile';
import { approxMeters, decode, MeshBuilder } from './RoadNetwork';
import type { ChunkListener, Terrain } from './Terrain';

/**
 * 高速道路データ1タイル（scripts/build-expressways.mjs の出力）。
 * w：[連絡路(0/1), 車線数, 掘割(0/1), 名前, 座標（1e-6度、先頭以外は差分）, 各点の地面からの高さ（0.1m）]
 * x：[緯度, 経度（1e-6度）, 半径(m)] 一般道・線路と交わる所（橋脚を立てない）
 */
interface ExpresswayTile {
  w: Array<[0 | 1, number, 0 | 1, string, number[], number[]]>;
  x: Array<[number, number, number]>;
}

/** 路面の画像1枚が表す長さ (m) */
const TEXTURE_LENGTH_M = 12;

/**
 * 高速道路（首都高・湾岸線・外環道など）。写真を参考に、白い高架・壁高欄・路面標示・街灯で作る。
 * - 路面：濃いアスファルトに白い外側線と破線の車線境界（車線数ごとの画像）
 * - 壁高欄：両側の白いコンクリートの低い壁と、上の手すり
 * - 高架：白い桁の側面、少し暗い裏側、白い丸柱＋T字の梁の橋脚
 * - カーブの外側：白いしましま（減速を促す路面標示）
 * - 街灯、路面の路線名
 * 地形チャンクが読まれたら同じ範囲のデータを読み、捨てられたら一緒に捨てる。
 */
export class ExpresswayNetwork implements ChunkListener {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, THREE.Group | 'loading'>();
  private readonly deckMaterials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly concrete = new THREE.MeshStandardMaterial({
    color: EXPRESSWAYS.concreteColor,
    roughness: 0.8,
    side: THREE.DoubleSide,
  });
  private readonly underside = new THREE.MeshStandardMaterial({
    color: EXPRESSWAYS.undersideColor,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  private readonly rail = new THREE.MeshStandardMaterial({ color: EXPRESSWAYS.railColor, metalness: 0.4, roughness: 0.5 });
  private readonly zebraMaterial = createZebraMaterial();
  private readonly lampPole = new THREE.MeshStandardMaterial({ color: EXPRESSWAYS.lampPoleColor, roughness: 0.6 });
  private readonly lampHead = new THREE.MeshBasicMaterial({ color: EXPRESSWAYS.lampColor, toneMapped: false });
  private readonly nameTextures = new Map<string, { texture: THREE.CanvasTexture; aspect: number; users: number }>();

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
  }

  onChunkAdded(x: number, y: number): void {
    const key = `${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    const url = `${import.meta.env.BASE_URL}${EXPRESSWAYS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    fetch(url)
      // 高速道路の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<ExpresswayTile>) : null,
      )
      .then((data) => {
        if (this.tiles.get(key) !== 'loading') return;
        const group = data ? this.build(data, key) : new THREE.Group();
        this.tiles.set(key, group);
        this.group.add(group);
      })
      .catch((e) => {
        console.warn('[Expressways] 読込に失敗しました', key, e);
        this.tiles.delete(key);
      });
  }

  onChunkRemoved(x: number, y: number): void {
    const key = `${x}/${y}`;
    const tile = this.tiles.get(key);
    this.tiles.delete(key);
    this.terrain.removeCarve(`expressway:${key}`);
    if (!tile || tile === 'loading') return;
    this.group.remove(tile);
    tile.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        obj.dispose();
      } else if (obj instanceof THREE.Mesh) {
        obj.geometry.disposeBoundsTree?.();
        obj.geometry.dispose();
        if (obj.userData.name) this.releaseName(obj.userData.name as string, obj.material as THREE.Material);
      }
    });
  }

  private build(data: ExpresswayTile, key: string): THREE.Group {
    const decks = new Map<number, MeshBuilder>();
    const parts = {
      wall: new MeshBuilder(),
      bottom: new MeshBuilder(),
      railing: new MeshBuilder(),
      zebra: new MeshBuilder(),
    };
    const piers: PierSpot[] = [];
    const lamps: LampSpot[] = [];
    const names: NameSpot[] = [];
    const cuts: THREE.Vector3[][] = [];
    const noPier = data.x.map(([lat, lon, r]) => [lat / 1e6, lon / 1e6, r] as const);

    for (const [link, lanes, cut, name, coords, offsets] of data.w) {
      if (!decks.has(lanes)) decks.set(lanes, new MeshBuilder());
      const line = this.buildWay(
        { link: link === 1, lanes, cut: cut === 1, name },
        decode(coords),
        offsets,
        noPier,
        decks.get(lanes)!,
        parts,
        piers,
        lamps,
        names,
      );
      if (cut === 1 && line) cuts.push(line.map((p) => p.clone().setY(p.y - EXPRESSWAYS.lift - 0.2)));
    }
    if (cuts.length > 0) this.terrain.addCarve(`expressway:${key}`, cuts, EXPRESSWAYS.cutWidth, EXPRESSWAYS.cutSlope);

    const group = new THREE.Group();
    for (const [lanes, builder] of decks) {
      const g = builder.build();
      if (!g) continue;
      // 当たり判定のレイキャストを速くする
      g.computeBoundsTree();
      group.add(new THREE.Mesh(g, this.deckMaterial(lanes)));
    }
    const add = (b: MeshBuilder, m: THREE.Material) => {
      const g = b.build();
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(parts.wall, this.concrete);
    add(parts.bottom, this.underside);
    add(parts.railing, this.rail);
    add(parts.zebra, this.zebraMaterial);
    if (piers.length > 0) group.add(...this.buildPiers(piers));
    if (lamps.length > 0) group.add(...this.buildLamps(lamps));
    for (const n of names) group.add(this.buildName(n));
    return group;
  }

  /** 1本の道（一方通行）。中心線の点（ローカル座標）を返す */
  private buildWay(
    way: { link: boolean; lanes: number; cut: boolean; name: string },
    points: Array<[number, number]>,
    offsets: number[],
    noPier: ReadonlyArray<readonly [number, number, number]>,
    deck: MeshBuilder,
    parts: { wall: MeshBuilder; bottom: MeshBuilder; railing: MeshBuilder; zebra: MeshBuilder },
    piers: PierSpot[],
    lamps: LampSpot[],
    names: NameSpot[],
  ): THREE.Vector3[] | null {
    const E = EXPRESSWAYS;
    // 細かく区切った点と、中心線に沿った距離 s、地面からの高さ
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    const lift: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i];
      const off = offsets[i] / 10;
      if (i === 0) {
        samples.push([lat, lon]);
        s.push(0);
        lift.push(off);
        continue;
      }
      const [plat, plon] = points[i - 1];
      const poff = offsets[i - 1] / 10;
      const length = approxMeters(plat, plon, lat, lon);
      const steps = Math.max(1, Math.ceil(length / E.densifyStep));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        samples.push([plat + (lat - plat) * t, plon + (lon - plon) * t]);
        s.push(s[s.length - 1] + length / steps);
        lift.push(poff + (off - poff) * t);
      }
    }
    if (samples.length < 2) return null;

    const raw = way.cut
      ? cutFloor(this.terrain, samples, s, E.cutFloorRadius)
      : samples.map(([lat, lon]) => this.terrain.surfaceHeightAt(lat, lon));
    let last = raw.find((g) => g !== null) ?? 0;
    const ground = raw.map((g) => (last = g ?? last));
    const smooth = samples.map(([lat, lon], i) => smoothGround(this.terrain, lat, lon, E.smoothRadius) ?? ground[i]);
    const heights = ground.map((g, i) => {
      // 高架ほど均した地面に寄せる（地上は地形に沿わせる）
      const base = THREE.MathUtils.lerp(g, smooth[i], THREE.MathUtils.clamp(lift[i] / 2, 0, 1));
      return Math.max(base + lift[i], WATER.surfaceHeight + 1) + E.lift;
    });
    const pts = samples.map(([lat, lon], i) => this.terrain.toLocal(lat, lon, heights[i]));
    const elevated = lift.map((l) => l > E.elevatedFrom);

    const up = new THREE.Vector3(0, 1, 0);
    const tangents = pts.map((_, i) =>
      new THREE.Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).setY(0).normalize(),
    );
    const sides = tangents.map((t) => new THREE.Vector3().crossVectors(up, t).normalize());
    const half = (way.lanes * E.laneWidth) / 2 + E.shoulder;
    const at = (i: number, across: number, dy: number) =>
      pts[i].clone().addScaledVector(sides[i], across).setY(pts[i].y + dy);

    /** pts に沿った帯（a(i)・b(i) の2本の線の間）。filter が false の所は切る */
    const strip = (
      b: MeshBuilder,
      fa: (i: number) => THREE.Vector3,
      fb: (i: number) => THREE.Vector3,
      filter: (i: number) => boolean = () => true,
      uScale = 1,
      vLength = 4,
    ) => {
      let prev: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        if (!filter(i)) {
          prev = null;
          continue;
        }
        const va = b.vertex(fa(i), 0, s[i] / vLength);
        const vb = b.vertex(fb(i), uScale, s[i] / vLength);
        if (prev) b.quad(prev[0], prev[1], va, vb);
        prev = [va, vb];
      }
    };

    // 路面（左端 u=0 → 右端 u=1、v は進行方向）
    strip(deck, (i) => at(i, half, 0), (i) => at(i, -half, 0), undefined, 1, TEXTURE_LENGTH_M);

    // 壁高欄：両側の白い壁（内側・上面・外側）と、上の手すり
    const wallIn = half;
    const wallOut = half + E.barrierThickness;
    const h = E.barrierHeight;
    for (const dir of [1, -1]) {
      strip(parts.wall, (i) => at(i, dir * wallIn, 0), (i) => at(i, dir * wallIn, h));
      strip(parts.wall, (i) => at(i, dir * wallIn, h), (i) => at(i, dir * wallOut, h));
      strip(parts.wall, (i) => at(i, dir * wallOut, h), (i) => at(i, dir * wallOut, elevated[i] ? -E.girderDepth : -0.3));
      const r = dir * (wallIn + E.barrierThickness / 2);
      strip(parts.railing, (i) => at(i, r - 0.06, h + E.railHeight), (i) => at(i, r + 0.06, h + E.railHeight));
      strip(parts.railing, (i) => at(i, r, h + E.railHeight), (i) => at(i, r, h + E.railHeight - 0.12));
    }
    // 桁の裏側（高架の所だけ）
    strip(
      parts.bottom,
      (i) => at(i, wallOut, -E.girderDepth),
      (i) => at(i, -wallOut, -E.girderDepth),
      (i) => elevated[i],
    );

    // カーブの外側のしましま：曲がり具合（向きの変化 / 距離）が大きい所
    const turn = tangents.map((_, i) => {
      const a = tangents[Math.max(0, i - 2)];
      const b = tangents[Math.min(tangents.length - 1, i + 2)];
      const ds = s[Math.min(s.length - 1, i + 2)] - s[Math.max(0, i - 2)] || 1;
      // 右カーブで正
      return (a.x * b.z - a.z * b.x) / ds;
    });
    const curved = (i: number) => Math.abs(turn[i]) > 1 / E.zebraRadius;
    for (const dir of [1, -1]) {
      // 左カーブ（turn<0）なら外側は右（-1）、右カーブなら外側は左（+1）
      const outer = (i: number) => curved(i) && Math.sign(-turn[i]) === -dir;
      strip(
        parts.zebra,
        (i) => at(i, dir * (half - 0.25), 0.03),
        (i) => at(i, dir * (half - 0.25 - E.zebraWidth), 0.03),
        outer,
        E.zebraWidth / 0.9,
        1.8,
      );
    }

    // 橋脚
    const pierStart = Math.floor(s[0] / E.pierSpacing);
    let lastPier = pierStart;
    for (let i = 1; i < pts.length; i++) {
      const n = Math.floor(s[i] / E.pierSpacing);
      if (n === lastPier) continue;
      lastPier = n;
      if (lift[i] < E.pierFrom) continue;
      const [plat, plon] = samples[i];
      if (noPier.some(([lat, lon, r]) => approxMeters(lat, lon, plat, plon) < r + E.pierRadius + 1)) continue;
      const bottom = this.terrain.toLocal(plat, plon, ground[i] - 1).y;
      piers.push({ top: pts[i].y - E.girderDepth, bottom, center: pts[i], side: sides[i], width: wallOut * 2 });
    }

    // 街灯：本線の左側に一定間隔で
    if (!way.link) {
      let lastLamp = Math.floor(s[0] / E.lampSpacing);
      for (let i = 1; i < pts.length; i++) {
        const n = Math.floor(s[i] / E.lampSpacing);
        if (n === lastLamp) continue;
        lastLamp = n;
        lamps.push({ base: at(i, wallIn + E.barrierThickness / 2, h), inward: sides[i].clone().negate() });
      }
    }

    // 路線名：名前のある本線に一定間隔で、進行方向に沿って
    if (way.name && !way.link) {
      const total = s[s.length - 1];
      for (let d = E.nameSpacing / 2; d < total - 20; d += E.nameSpacing) {
        const i = s.findIndex((v) => v >= d);
        if (i <= 0) continue;
        names.push({ name: way.name, center: at(i, 0, 0.05), forward: tangents[i].clone(), width: half * 2 });
      }
    }
    return pts;
  }

  /** 白い丸柱と、その上の T 字の梁 */
  private buildPiers(piers: PierSpot[]): THREE.InstancedMesh[] {
    const E = EXPRESSWAYS;
    const column = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 14).translate(0, 0.5, 0),
      this.concrete,
      piers.length,
    );
    const beam = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0), this.concrete, piers.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    piers.forEach((p, k) => {
      const yaw = Math.atan2(p.side.x, p.side.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const height = Math.max(0.5, p.top - E.beamDepth - p.bottom);
      m.compose(new THREE.Vector3(p.center.x, p.bottom, p.center.z), q, new THREE.Vector3(E.pierRadius, height, E.pierRadius));
      column.setMatrixAt(k, m);
      m.compose(new THREE.Vector3(p.center.x, p.top, p.center.z), q, new THREE.Vector3(E.beamDepth * 1.3, E.beamDepth, p.width * 0.85));
      beam.setMatrixAt(k, m);
    });
    for (const mesh of [column, beam]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    return [column, beam];
  }

  /** 街灯：柱・腕・光る灯具 */
  private buildLamps(lamps: LampSpot[]): THREE.InstancedMesh[] {
    const E = EXPRESSWAYS;
    const pole = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.13, E.lampHeight, 6).translate(0, E.lampHeight / 2, 0),
      this.lampPole,
      lamps.length,
    );
    const arm = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.1, 0.1, E.lampArm).translate(0, E.lampHeight, E.lampArm / 2),
      this.lampPole,
      lamps.length,
    );
    const head = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.35, 0.14, 0.7).translate(0, E.lampHeight - 0.1, E.lampArm),
      this.lampHead,
      lamps.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    lamps.forEach((l, k) => {
      // 腕は +z 向きに作ってあるので、道の内側に向ける
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(l.inward.x, l.inward.z));
      m.compose(l.base, q, one);
      for (const mesh of [pole, arm, head]) mesh.setMatrixAt(k, m);
    });
    for (const mesh of [pole, arm, head]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    return [pole, arm, head];
  }

  /** 路面の路線名（進行方向に沿って、左から右へ読める向き） */
  private buildName(n: NameSpot): THREE.Mesh {
    const tex = this.acquireName(n.name);
    const height = Math.min(EXPRESSWAYS.nameHeight, n.width * 0.6);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(height * tex.aspect, height),
      new THREE.MeshBasicMaterial({
        map: tex.texture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    // 板を地面に寝かせ、文字の横向きを進行方向に合わせる
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = Math.atan2(-n.forward.z, n.forward.x);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(n.center);
    mesh.userData.name = n.name;
    return mesh;
  }

  private acquireName(name: string): { texture: THREE.CanvasTexture; aspect: number } {
    let entry = this.nameTextures.get(name);
    if (!entry) {
      const canvas = drawName(name);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      entry = { texture, aspect: canvas.width / canvas.height, users: 0 };
      this.nameTextures.set(name, entry);
    }
    entry.users++;
    return entry;
  }

  private releaseName(name: string, material: THREE.Material): void {
    material.dispose();
    const entry = this.nameTextures.get(name);
    if (!entry) return;
    entry.users--;
    if (entry.users <= 0) {
      entry.texture.dispose();
      this.nameTextures.delete(name);
    }
  }

  /** 車線数ごとの路面の材質（画像は共有） */
  private deckMaterial(lanes: number): THREE.MeshStandardMaterial {
    let m = this.deckMaterials.get(lanes);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ map: createDeckTexture(lanes), roughness: 0.9, side: THREE.DoubleSide });
      this.deckMaterials.set(lanes, m);
    }
    return m;
  }
}

interface PierSpot {
  top: number;
  bottom: number;
  center: THREE.Vector3;
  side: THREE.Vector3;
  width: number;
}

interface LampSpot {
  base: THREE.Vector3;
  inward: THREE.Vector3;
}

interface NameSpot {
  name: string;
  center: THREE.Vector3;
  forward: THREE.Vector3;
  width: number;
}

/** 路面の画像：濃いアスファルトに白い外側線と、車線の境界の白い破線（幅 = 車線数 × 車線幅 + 路肩×2、長さ 12m） */
function createDeckTexture(lanes: number): THREE.CanvasTexture {
  const E = EXPRESSWAYS;
  const width = lanes * E.laneWidth + E.shoulder * 2;
  const w = 32 * Math.ceil(width);
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const pxPerM = w / width;
  g.fillStyle = '#3b3d42';
  g.fillRect(0, 0, w, h);
  let seed = lanes * 97 + 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1500; i++) {
    const v = 50 + rand() * 25;
    g.fillStyle = `rgb(${v},${v + 1},${v + 4})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
  const line = (m: number, dashed: boolean) => {
    g.fillStyle = 'rgba(238, 240, 243, 0.95)';
    const lw = Math.max(2, 0.18 * pxPerM);
    // 破線：12m のうち 6m
    g.fillRect(m * pxPerM - lw / 2, 0, lw, dashed ? h / 2 : h);
  };
  line(E.shoulder, false);
  line(width - E.shoulder, false);
  for (let i = 1; i < lanes; i++) line(E.shoulder + i * E.laneWidth, true);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** カーブの外側のしましま：斜めの白い縞（u は幅方向に 0.9m で1周期） */
function createZebraMaterial(): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(240, 242, 245, 1)';
  // 斜めの縞
  for (let k = -64; k < 128; k += 32) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 16, 0);
    g.lineTo(k + 16 + 64, 64);
    g.lineTo(k + 64, 64);
    g.closePath();
    g.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    alphaTest: 0.5,
    roughness: 0.8,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** 路線名：路面に描く白い文字（縁取り付き） */
function drawName(name: string): HTMLCanvasElement {
  const font = `800 64px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(name).width + 24);
  const h = 84;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(20, 24, 32, 0.7)';
  g.strokeText(name, w / 2, h / 2);
  g.fillStyle = '#f4f6f8';
  g.fillText(name, w / 2, h / 2);
  return canvas;
}
