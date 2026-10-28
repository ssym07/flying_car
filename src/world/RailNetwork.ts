import * as THREE from 'three';
import { RAILWAYS, TERRAIN, WATER } from '../core/config';
import { approxMeters, decode, MeshBuilder } from './RoadNetwork';
import { cutFloor, smoothGround, stationGround } from './groundProfile';
import type { ChunkListener, Terrain } from './Terrain';
import { type Approach, type PortalRecord, TunnelPortalBuilder } from './tunnelPortals';

/**
 * 線路データ1タイル（scripts/build-rail-heights.mjs の出力）。
 * t：[軌間(mm), 座標（1e-6度、先頭以外は差分）, 各点の地面からの高さ（0.1m 単位）, 掘割(0/1),
 *     各点の駅（s の番号、駅の外は -1）, 各点の駅の地面に合わせる割合（0〜10）]（駅の2つは駅の近くの線路だけ）
 * x：[緯度, 経度（1e-6度）, 半径(m)] 線路が道路と交わる所（橋脚を立てない）
 * s：[緯度, 経度（1e-6度）, 掘割(0/1)] 駅の地面の基準点（ホームも同じ点を基準にする）
 * p：トンネルの入口（坑口）。形式は tunnelPortals.ts の PortalRecord
 * 高さが負の所は、トンネルの入口へ下りる坂（地形を削って掘割にする）
 */
interface RailTile {
  t: Array<[number, number[], number[], (0 | 1)?, number[]?, number[]?]>;
  x: Array<[number, number, number]>;
  s?: Array<[number, number, 0 | 1]>;
  p?: PortalRecord[];
}

/** 道床の画像1枚が表す長さ (m)。枕木 4 本ぶん */
const TEXTURE_LENGTH_M = 2.4;

/**
 * 線路。航空写真を参考に、茶色い砂利の道床・枕木・2本のレールを1枚の画像にして、線路の中心線に沿って貼る。
 * 高架の線路は地面から持ち上げ、コンクリートの桁・側壁・橋脚を付ける。トンネルの入口には、コンクリートの壁と暗い開口部を付ける。
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
  /** トンネルの入口・擁壁のコンクリート（型枠の継ぎ目と雨だれの汚れ） */
  private readonly portalMaterial = createPortalConcreteMaterial();
  /** トンネルの内壁（頂点色で、入口から奥へ暗くする。光の届かない所なのでライティングしない） */
  private readonly liningMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

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
        res.ok && res.headers.get('content-type')?.includes('json') ? (res.json() as Promise<RailTile>) : null,
      )
      .then((data) => {
        if (this.tiles.get(key) !== 'loading') return;
        const group = data ? this.build(data, key) : new THREE.Group();
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
    this.terrain.removeCarve(`rail:${key}`);
    this.terrain.removeCarve(`rail-portal:${key}`);
    if (!tile || tile === 'loading') return;
    this.group.remove(tile);
    tile.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }

  private build(data: RailTile, key: string): THREE.Group {
    const narrow = new MeshBuilder();
    const standard = new MeshBuilder();
    const viaduct = new MeshBuilder();
    const noPier = data.x.map(([lat, lon, r]) => [lat / 1e6, lon / 1e6, r] as const);
    const cuts: THREE.Vector3[][] = [];
    // トンネルの入口へ下りる掘割（両側に擁壁を立てる）
    const approachCuts: THREE.Vector3[][] = [];
    const approaches: Approach[] = [];
    // 駅の地面の高さ（駅の中の線路はこれを基準にして、ホームと高さをそろえる）
    const stationBase = (data.s ?? []).map(([lat, lon, cut]) =>
      stationGround(this.terrain, lat / 1e6, lon / 1e6, cut === 1, RAILWAYS.smoothRadius, RAILWAYS.cutFloorRadius),
    );
    for (const [gauge, coords, offsets, cut, stations, weights] of data.t) {
      const station = stations && weights ? { stations, weights, base: stationBase } : null;
      const built = this.buildTrack(
        decode(coords),
        offsets,
        cut === 1,
        station,
        noPier,
        gauge >= 1400 ? standard : narrow,
        viaduct,
      );
      if (!built) continue;
      const floor = (p: THREE.Vector3) => p.clone().setY(p.y - RAILWAYS.lift - RAILWAYS.cutDepthBelow);
      if (cut === 1) cuts.push(built.pts.map(floor));
      else {
        // 地面より下の所（トンネルの入口へ下りる坂）だけ削る。前後に1点ずつ足して、地面との境目までつなぐ
        let run: number[] = [];
        const flush = () => {
          if (run.length > 1) {
            // 削るのは当たり判定のため（見た目は Terrain.setTrenchMask と擁壁）。入口の側は手前で止める
            // （削った影響がトンネルの上の地形まで届くと、地形が開口部の中へ垂れ下がる）
            const deep = built.lift[run[0]] < built.lift[run[run.length - 1]] ? 0 : run.length - 1;
            const end = built.pts[run[deep]];
            const kept = run.filter((i) => built.pts[i].distanceTo(end) > RAILWAYS.portal.carveStop);
            if (kept.length > 1) approachCuts.push(kept.map((i) => floor(built.pts[i])));
            approaches.push({
              pts: run.map((i) => built.pts[i]),
              sides: run.map((i) => built.sides[i]),
              lift: run.map((i) => built.lift[i]),
            });
          }
          run = [];
        };
        built.lift.forEach((l, i) => {
          if (l < -0.3) {
            if (run.length === 0 && i > 0) run.push(i - 1);
            run.push(i);
          } else if (run.length > 0) {
            run.push(i);
            flush();
          }
        });
        flush();
      }
    }
    // トンネルの入口と、入口へ下りる掘割の擁壁
    const portals = new TunnelPortalBuilder(this.terrain, narrow);
    for (const p of data.p ?? []) portals.addPortal(p);
    portals.addRetainingWalls(approaches);
    // 掘割の内側の地形は描かない（地形の頂点の間隔では、深く細い掘割を削りきれない）
    const [tx, ty] = key.split('/').map(Number);
    this.terrain.setTrenchMask(tx, ty, this.trenchMask(tx, ty, approaches));
    // 掘割の線路のまわりの地形を削る
    if (cuts.length > 0) this.terrain.addCarve(`rail:${key}`, cuts, RAILWAYS.cutWidth, RAILWAYS.cutSlope);
    // 入口へ下りる掘割も同じく削る（地形の頂点の間隔が広いので、擁壁の幅では削りきれない。壁の外は斜面になる）
    if (approachCuts.length > 0) {
      this.terrain.addCarve(`rail-portal:${key}`, approachCuts, RAILWAYS.cutWidth, RAILWAYS.cutSlope);
    }
    const group = new THREE.Group();
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material) => {
      if (g) group.add(new THREE.Mesh(g, m));
    };
    add(narrow.build(), this.trackMaterials.narrow);
    add(standard.build(), this.trackMaterials.standard);
    add(viaduct.build(), this.concreteMaterial);
    const { concrete, lining } = portals.build();
    add(concrete, this.portalMaterial);
    add(lining, this.liningMaterial);
    return group;
  }

  /**
   * チャンク (x, y) の、掘割の中心線からの距離の画像（Terrain.setTrenchMask の形式）。掘割が無ければ null
   */
  private trenchMask(x: number, y: number, approaches: Approach[]): THREE.Texture | null {
    const { maskSize: S, maskRange } = RAILWAYS.portal;
    const z = TERRAIN.demZoom;
    const n = 2 ** z;
    const toPx = (p: THREE.Vector3): [number, number] | null => {
      const ll = this.terrain.toLatLon(p);
      if (!ll) return null;
      const tx = ((ll.lon + 180) / 360) * n;
      const ty = ((1 - Math.asinh(Math.tan(THREE.MathUtils.degToRad(ll.lat))) / Math.PI) / 2) * n;
      return [(tx - x) * S, (ty - y) * S];
    };
    const segments: Array<[[number, number], [number, number]]> = [];
    let lat = 0;
    for (const ap of approaches) {
      const px = ap.pts.map(toPx);
      for (let i = 1; i < px.length; i++) if (px[i - 1] && px[i]) segments.push([px[i - 1]!, px[i]!]);
      lat = this.terrain.toLatLon(ap.pts[0])?.lat ?? lat;
    }
    if (segments.length === 0) return null;
    const metersPerPx = (40075016 * Math.cos(THREE.MathUtils.degToRad(lat))) / n / S;
    const reach = maskRange / metersPerPx;
    const data = new Uint8Array(S * S).fill(255);
    for (const [a, b] of segments) {
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - reach));
      const x1 = Math.min(S - 1, Math.ceil(Math.max(a[0], b[0]) + reach));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - reach));
      const y1 = Math.min(S - 1, Math.ceil(Math.max(a[1], b[1]) + reach));
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      for (let row = y0; row <= y1; row++) {
        for (let col = x0; col <= x1; col++) {
          const cx = col + 0.5;
          const cy = row + 0.5;
          const t = Math.min(1, Math.max(0, ((cx - a[0]) * dx + (cy - a[1]) * dy) / len2));
          const d = Math.hypot(cx - a[0] - dx * t, cy - a[1] - dy * t) * metersPerPx;
          const v = Math.min(255, Math.round((d / maskRange) * 255));
          // 画像の行 0 が v = 0（南）。写真（北が上）と同じ uv で貼るので上下を入れ替える
          const k = (S - 1 - row) * S + col;
          if (v < data[k]) data[k] = v;
        }
      }
    }
    const texture = new THREE.DataTexture(data, S, S, THREE.RedFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * 1本の線路を作り、中心線の点（ローカル座標）を返す。offsets は各点の地面からの高さ（0.1m 単位、スロープ込みで計算済み）。
   * 高架の所は、地形の細かい凹凸を均した地面を基準にして、上面をなだらかにする。
   * 駅の中は駅の地面（station.base）を基準にし、駅の外へは station.weights の割合で地形に戻す
   */
  private buildTrack(
    points: Array<[number, number]>,
    offsets: number[],
    cut: boolean,
    station: { stations: number[]; weights: number[]; base: Array<number | null> } | null,
    noPier: ReadonlyArray<readonly [number, number, number]>,
    track: MeshBuilder,
    viaduct: MeshBuilder,
  ): { pts: THREE.Vector3[]; lift: number[]; sides: THREE.Vector3[] } | null {
    // 細かく区切った点と、中心線に沿った距離 s、地面からの高さ
    const samples: Array<[number, number]> = [];
    const s: number[] = [];
    const lift: number[] = [];
    // 駅の地面の高さと、それに合わせる割合（駅の近くでなければ null / 0）
    const stationAt = (i: number): [number | null, number] => {
      const ref = station?.stations[i] ?? -1;
      return ref < 0 ? [null, 0] : [station!.base[ref] ?? null, station!.weights[i] / 10];
    };
    const stationBase: Array<number | null> = [];
    const stationWeight: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i];
      const off = offsets[i] / 10;
      const [base, weight] = stationAt(i);
      if (i === 0) {
        samples.push([lat, lon]);
        s.push(0);
        lift.push(off);
        stationBase.push(base);
        stationWeight.push(base === null ? 0 : weight);
        continue;
      }
      const [plat, plon] = points[i - 1];
      const poff = offsets[i - 1] / 10;
      const [pbase, pweight] = stationAt(i - 1);
      const length = approxMeters(plat, plon, lat, lon);
      const steps = Math.max(1, Math.ceil(length / RAILWAYS.densifyStep));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        samples.push([plat + (lat - plat) * t, plon + (lon - plon) * t]);
        s.push(s[s.length - 1] + length / steps);
        lift.push(poff + (off - poff) * t);
        // 割合は前後の点の間で補間し、地面の高さは割合の大きい方の駅のもの
        const b = weight >= pweight ? (base ?? pbase) : (pbase ?? base);
        stationBase.push(b);
        stationWeight.push(b === null ? 0 : (base === null ? 0 : weight) * t + (pbase === null ? 0 : pweight) * (1 - t));
      }
    }
    if (samples.length < 2) return null;

    // 地上の線路は、描いている地形の面に合わせる（標高データそのものだと面に埋もれる）
    // 掘割は、細かい標高（5m メッシュ）の前後 cutFloorRadius m の一番低い所＝掘割の底に置く（あとで地形を削る）
    const raw = cut
      ? cutFloor(this.terrain, samples, s, RAILWAYS.cutFloorRadius)
      : samples.map(([lat, lon]) => this.terrain.surfaceHeightAt(lat, lon));
    let last = raw.find((g) => g !== null) ?? 0;
    const ground = raw.map((g) => (last = g ?? last));
    // 均した地面：場所だけで決まる平均（周りの格子点の地形の平均）にして、隣を並んで走る線路と同じ高さにする
    const smooth = samples.map(([lat, lon], i) => smoothGround(this.terrain, lat, lon, RAILWAYS.smoothRadius) ?? ground[i]);
    const heights = ground.map((g, i) => {
      // 高架ほど均した地面に寄せる（地上の線路は地形に沿わせる）
      let base = THREE.MathUtils.lerp(g, smooth[i], THREE.MathUtils.clamp(lift[i] / 2, 0, 1));
      // 駅の近くは駅の地面に寄せる
      if (stationWeight[i] > 0) base = THREE.MathUtils.lerp(base, stationBase[i]!, stationWeight[i]);
      // 川の上（地面が水面）では水面から少し上に（駅の中はホームと高さをそろえるので上げない。
      // 地面より下（トンネルの入口へ下りる坂）も上げない）
      const overWater =
        lift[i] < 0 ? base + lift[i] : Math.max(base + lift[i], WATER.surfaceHeight + RAILWAYS.waterClearance);
      return THREE.MathUtils.lerp(overWater, base + lift[i], stationWeight[i]) + RAILWAYS.lift;
    });
    const pts = samples.map(([lat, lon], i) => this.terrain.toLocal(lat, lon, heights[i]));
    const elevated = lift.map((l) => l > RAILWAYS.elevatedFrom);
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
    if (!elevated.some(Boolean)) return { pts, lift, sides };

    // 高架：側壁・桁の側面・底面（高架の所だけ）
    const edge = half + RAILWAYS.viaductShoulder;
    const strip = (fa: (i: number) => THREE.Vector3, fb: (i: number) => THREE.Vector3) => {
      let p: [number, number] | null = null;
      for (let i = 0; i < pts.length; i++) {
        if (!elevated[i]) {
          p = null;
          continue;
        }
        const va = viaduct.vertex(fa(i), s[i] / 4, 0);
        const vb = viaduct.vertex(fb(i), s[i] / 4, 1);
        if (p) viaduct.quad(p[0], p[1], va, vb);
        p = [va, vb];
      }
    };
    // 側壁は立てない（並んだ線路それぞれに立つと、線路の間が壁だらけになる）。桁の側面だけ
    strip((i) => at(i, edge, -0.05), (i) => at(i, edge, -RAILWAYS.viaductDepth));
    strip((i) => at(i, -edge, -RAILWAYS.viaductDepth), (i) => at(i, -edge, -0.05));
    strip((i) => at(i, edge, -RAILWAYS.viaductDepth), (i) => at(i, -edge, -RAILWAYS.viaductDepth));
    // 道床の脇の平らな部分（道床と側壁の間）
    strip((i) => at(i, edge, -0.05), (i) => at(i, half, -0.05));
    strip((i) => at(i, -half, -0.05), (i) => at(i, -edge, -0.05));

    // 橋脚
    for (let i = 1; i < pts.length; i++) {
      if (Math.floor(s[i] / RAILWAYS.pierSpacing) === Math.floor(s[i - 1] / RAILWAYS.pierSpacing)) continue;
      if (lift[i] < RAILWAYS.pierFrom) continue;
      // 下を通る道路の上には立てない
      const [plat, plon] = samples[i];
      if (noPier.some(([lat, lon, r]) => approxMeters(lat, lon, plat, plon) < r + RAILWAYS.pierThickness)) continue;
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
    return { pts, lift, sides };
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

/** トンネルの入口・擁壁のコンクリート：型枠の縦の継ぎ目と、上からの雨だれの汚れ（1枚 = 4m 四方） */
function createPortalConcreteMaterial(): THREE.MeshStandardMaterial {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#b3b1aa';
  g.fillRect(0, 0, size, size);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // ざらつき
  for (let i = 0; i < 3000; i++) {
    const v = 150 + rand() * 50;
    g.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`;
    g.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
  }
  // 雨だれ（上から下へ細く暗い筋）
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const len = size * (0.2 + rand() * 0.6);
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, 'rgba(60,58,52,0.35)');
    grad.addColorStop(1, 'rgba(60,58,52,0)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 1 + rand() * 4, len);
  }
  // 型枠の継ぎ目（縦 0.9m おき、横 1.8m おき）
  g.fillStyle = 'rgba(70,68,64,0.5)';
  for (let k = 0; k <= 4; k++) g.fillRect((k * size) / 4.44 - 1, 0, 2, size);
  for (let k = 0; k <= 2; k++) g.fillRect(0, (k * size) / 2.22 - 1, size, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.25, 0.25);
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, side: THREE.DoubleSide });
}
