import * as THREE from 'three';
import { RAILWAYS } from '../core/config';
import { approxMeters, decode, MeshBuilder } from './RoadNetwork';
import type { ChunkListener, Terrain } from './Terrain';

/** 線路1件：[高架(0/1), layer, 軌間(mm), 座標（1e-6度、先頭以外は差分）] */
type RailRecord = [0 | 1, number, number, number[]];

/** 道床の画像1枚が表す長さ (m)。枕木 4 本ぶん */
const TEXTURE_LENGTH_M = 2.4;

/**
 * 線路。航空写真を参考に、茶色い砂利の道床・枕木・2本のレールを1枚の画像にして、線路の中心線に沿って貼る。
 * 高架の線路は地面から持ち上げ、コンクリートの桁・側壁・橋脚を付ける。
 * 地形チャンクが読まれたら同じ範囲の線路データを読み、捨てられたら一緒に捨てる。
 */
export class RailNetwork implements ChunkListener {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, THREE.Group | 'loading'>();
  private readonly trackMaterials: Record<'narrow' | 'standard', THREE.MeshStandardMaterial> = {
    narrow: createTrackMaterial(1.067),
    standard: createTrackMaterial(1.435),
  };
  private readonly concreteMaterial = new THREE.MeshStandardMaterial({
    color: RAILWAYS.concreteColor,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });

  constructor(private readonly terrain: Terrain) {
    terrain.addListener(this);
  }

  onChunkAdded(x: number, y: number): void {
    const key = `${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    const url = `${import.meta.env.BASE_URL}${RAILWAYS.tilePath.replace('{x}', `${x}`).replace('{y}', `${y}`)}`;
    fetch(url)
      // 線路の無いタイルはファイルが無い（開発サーバーは代わりに HTML を返すので、JSON かどうかで見分ける）
      .then((res) =>
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<RailRecord[]>) : null,
      )
      .then((data) => {
        if (this.tiles.get(key) !== 'loading') return;
        const group = data ? this.build(data) : new THREE.Group();
        this.tiles.set(key, group);
        this.group.add(group);
      })
      .catch((e) => {
        console.warn('[Rails] 読込に失敗しました', key, e);
        this.tiles.delete(key);
      });
  }

  onChunkRemoved(x: number, y: number): void {
    const key = `${x}/${y}`;
    const tile = this.tiles.get(key);
    this.tiles.delete(key);
    if (!tile || tile === 'loading') return;
    this.group.remove(tile);
    tile.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }

  private build(records: RailRecord[]): THREE.Group {
    const narrow = new MeshBuilder();
    const standard = new MeshBuilder();
    const viaduct = new MeshBuilder();
    for (const [bridge, layer, gauge, coords] of records) {
      this.buildTrack(decode(coords), bridge === 1, layer, gauge >= 1400 ? standard : narrow, viaduct);
    }
    const group = new THREE.Group();
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material) => {
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(narrow.build(), this.trackMaterials.narrow);
    add(standard.build(), this.trackMaterials.standard);
    add(viaduct.build(), this.concreteMaterial);
    return group;
  }

  private buildTrack(
    points: Array<[number, number]>,
    elevated: boolean,
    layer: number,
    track: MeshBuilder,
    viaduct: MeshBuilder,
  ): void {
    // 細かく区切った点と、中心線に沿った距離 s
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i];
      if (i === 0) {
        samples.push([lat, lon]);
        s.push(0);
        continue;
      }
      const [plat, plon] = points[i - 1];
      const length = approxMeters(plat, plon, lat, lon);
      const steps = Math.max(1, Math.ceil(length / RAILWAYS.densifyStep));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        samples.push([plat + (lat - plat) * t, plon + (lon - plon) * t]);
        s.push(s[s.length - 1] + length / steps);
      }
    }
    if (samples.length < 2) return;

    // 高さ：地上は地形に沿わせる。高架は地面から一定の高さ（区間の中で一番高い地面を基準にして平らに近づける）
    const grounds = samples.map(([lat, lon]) => this.terrain.heightAt(lat, lon));
    let last = grounds.find((g) => g !== null) ?? 0;
    const ground = grounds.map((g) => (last = g ?? last));
    const raise = elevated ? (layer > 0 ? layer * RAILWAYS.layerHeight : RAILWAYS.bridgeHeight) : 0;
    const deckBase = elevated ? Math.max(...ground) : 0;
    const heights = ground.map((g) => (elevated ? Math.max(g, deckBase - 2) + raise : g) + RAILWAYS.lift);
    const pts = samples.map(([lat, lon], i) => this.terrain.toLocal(lat, lon, heights[i]));

    // 各点の左右の向き
    const up = new THREE.Vector3(0, 1, 0);
    const sides = pts.map((_, i) => {
      const tangent = new THREE.Vector3()
        .subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)])
        .setY(0)
        .normalize();
      return new THREE.Vector3().crossVectors(up, tangent).normalize();
    });
    const half = RAILWAYS.ballastWidth / 2;
    const at = (i: number, across: number, dy: number) =>
      pts[i].clone().addScaledVector(sides[i], across).setY(pts[i].y + dy);

    // 道床（u：幅方向 0..1、v：枕木の繰り返し）
    let prev: [number, number] | null = null;
    for (let i = 0; i < pts.length; i++) {
      const v = s[i] / TEXTURE_LENGTH_M;
      const a = track.vertex(at(i, half, 0), 0, v);
      const b = track.vertex(at(i, -half, 0), 1, v);
      if (prev) track.quad(prev[0], prev[1], a, b);
      prev = [a, b];
    }
    if (!elevated) return;

    // 高架：側壁・桁の側面・底面
    const edge = half + RAILWAYS.viaductShoulder;
    const strip = (fa: (i: number) => THREE.Vector3, fb: (i: number) => THREE.Vector3) => {
      let p: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        const va = viaduct.vertex(fa(i), s[i] / 4, 0);
        const vb = viaduct.vertex(fb(i), s[i] / 4, 1);
        if (p) viaduct.quad(p[0], p[1], va, vb);
        p = [va, vb];
      }
    };
    strip((i) => at(i, edge, RAILWAYS.parapetHeight), (i) => at(i, edge, -RAILWAYS.viaductDepth));
    strip((i) => at(i, -edge, -RAILWAYS.viaductDepth), (i) => at(i, -edge, RAILWAYS.parapetHeight));
    strip((i) => at(i, edge, -RAILWAYS.viaductDepth), (i) => at(i, -edge, -RAILWAYS.viaductDepth));
    // 道床の脇の平らな部分（道床と側壁の間）
    strip((i) => at(i, edge, -0.05), (i) => at(i, half, -0.05));
    strip((i) => at(i, -half, -0.05), (i) => at(i, -edge, -0.05));

    // 橋脚
    for (let i = 1; i < pts.length; i++) {
      if (Math.floor(s[i] / RAILWAYS.pierSpacing) === Math.floor(s[i - 1] / RAILWAYS.pierSpacing)) continue;
      const bottom = this.terrain.toLocal(samples[i][0], samples[i][1], ground[i] - 1).y;
      const top = pts[i].y - RAILWAYS.viaductDepth;
      if (top - bottom < 2) continue;
      const tangent = new THREE.Vector3(-sides[i].z, 0, sides[i].x);
      const t = RAILWAYS.pierThickness / 2;
      const corners = [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ].map(([a, b]) => pts[i].clone().addScaledVector(sides[i], a * t).addScaledVector(tangent, b * t));
      for (let k = 0; k < 4; k++) {
        const p = corners[k];
        const q = corners[(k + 1) % 4];
        const a = viaduct.vertex(p.clone().setY(bottom), 0, 0);
        const b = viaduct.vertex(q.clone().setY(bottom), 1, 0);
        const c = viaduct.vertex(p.clone().setY(top), 0, 1);
        const d = viaduct.vertex(q.clone().setY(top), 1, 1);
        viaduct.quad(a, b, c, d);
      }
    }
  }
}

/**
 * 道床の画像（幅 = 道床の幅、長さ 2.4m）：茶色い砂利、コンクリートの枕木、2本のレール。
 * gauge はレールの間隔 (m)
 */
function createTrackMaterial(gauge: number): THREE.MeshStandardMaterial {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const pxPerM = w / RAILWAYS.ballastWidth;

  // 砂利：茶色の濃淡の粒。両端は少し暗くして溝のように
  g.fillStyle = '#6b5544';
  g.fillRect(0, 0, w, h);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2200; i++) {
    const v = 70 + rand() * 70;
    g.fillStyle = `rgb(${v + 25},${v + 8},${v - 8})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
  const edge = g.createLinearGradient(0, 0, w, 0);
  edge.addColorStop(0, 'rgba(30,20,15,0.45)');
  edge.addColorStop(0.12, 'rgba(30,20,15,0)');
  edge.addColorStop(0.88, 'rgba(30,20,15,0)');
  edge.addColorStop(1, 'rgba(30,20,15,0.45)');
  g.fillStyle = edge;
  g.fillRect(0, 0, w, h);

  // 枕木（長さ 2.0m × 幅 0.24m、0.6m 間隔）
  const sleeperLen = 2.0 * pxPerM;
  const sleeperW = 0.24 * (h / 2.4);
  for (let k = 0; k < 4; k++) {
    const y = (k + 0.5) * (h / 4) - sleeperW / 2;
    g.fillStyle = '#8f8a82';
    g.fillRect((w - sleeperLen) / 2, y, sleeperLen, sleeperW);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect((w - sleeperLen) / 2, y + sleeperW - 1.5, sleeperLen, 1.5);
  }

  // レール：鈍い鋼色に、上面の光った筋
  const railW = Math.max(2, 0.07 * pxPerM);
  for (const sign of [-1, 1]) {
    const x = w / 2 + (sign * gauge * pxPerM) / 2 - railW / 2;
    g.fillStyle = '#3d3a38';
    g.fillRect(x - 1, 0, railW + 2, h);
    g.fillStyle = '#c9c6c0';
    g.fillRect(x + railW * 0.3, 0, railW * 0.4, h);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.95,
    // 地形・道路とちらつかないよう手前に寄せる
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
