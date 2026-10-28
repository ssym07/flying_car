import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAILWAYS } from '../core/config';
import { MeshBuilder } from './RoadNetwork';
import type { Terrain } from './Terrain';

/**
 * トンネルの入口（坑口）：[緯度, 経度（1e-6度）, 向き（0.1度、東が 0 で北へ回る）, レール面の高さ（0.1m、地面から）,
 * 地下鉄(0/1), [各線路の、入口の中心からの左右の位置（0.1m、トンネルへ向かって左が正）...]]
 */
export type PortalRecord = [number, number, number, number, 0 | 1, number[]];

/** 入口へ下りる掘割の線路1本：中心線の点（レール面）、各点の左向きの単位ベクトル、各点のレール面の地面からの高さ */
export interface Approach {
  pts: THREE.Vector3[];
  sides: THREE.Vector3[];
  lift: number[];
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * トンネルの入口と、入口へ下りる掘割の擁壁を作る（写真を参考に、コンクリートの正面の壁に線路ごとの開口部、両脇の袖の壁、
 * 奥へ続く内壁（入口から奥へ暗くなる））。地下鉄は複線で1つの大きな開口部、それ以外は線路1本ごとに開口部を分け、
 * 単線のトンネルは半円のアーチ、それ以外は上の角を斜めに落とした四角にする。
 * 壁はコンクリート（concrete）、内壁は頂点色（lining）、トンネルの中の線路は track に足す
 */
export class TunnelPortalBuilder {
  private readonly concrete: THREE.BufferGeometry[] = [];
  private readonly lining: THREE.BufferGeometry[] = [];
  private readonly walls = new MeshBuilder();

  constructor(
    private readonly terrain: Terrain,
    private readonly track: MeshBuilder,
  ) {}

  /** ローカル座標の点の真下（真上）の地面の高さ（ローカルの y）。地形が無ければ null */
  private groundY(p: THREE.Vector3): number | null {
    const ll = this.terrain.toLatLon(p);
    if (!ll) return null;
    const h = this.terrain.surfaceHeightAt(ll.lat, ll.lon);
    return h === null ? null : this.terrain.toLocal(ll.lat, ll.lon, h).y;
  }

  addPortal([lat6, lon6, angle10, offset10, subway, across10]: PortalRecord): void {
    const lat = lat6 / 1e6;
    const lon = lon6 / 1e6;
    const ground = this.terrain.surfaceHeightAt(lat, lon);
    if (ground === null || across10.length === 0) return;
    const P = RAILWAYS.portal;
    const a = THREE.MathUtils.degToRad(angle10 / 10);
    const ahead = (d: number) =>
      [lat + (Math.sin(a) * d) / 111320, lon + (Math.cos(a) * d) / (111320 * Math.cos(THREE.MathUtils.degToRad(lat)))] as const;
    const rail = ground + offset10 / 10 + RAILWAYS.lift;
    const center = this.terrain.toLocal(lat, lon, rail);
    const forward = this.terrain.toLocal(...ahead(10), rail).sub(center).setY(0).normalize();
    const side = new THREE.Vector3().crossVectors(UP, forward).normalize();
    // 入口の座標（u = 左右・左が正、v = レール面からの高さ、z = トンネルの奥へ）→ ローカル座標
    const frame = new THREE.Matrix4().makeBasis(side, UP, forward).setPosition(center);

    // 開口部：近い線路はまとめる（地下鉄は複線で1つ。それ以外は柱が立たないほど近い時だけ）
    const tracks = across10.map((v) => v / 10).sort((x, y) => x - y);
    const openings: Array<{ left: number; right: number; count: number }> = [];
    for (const u of tracks) {
      const last = openings[openings.length - 1];
      const gap = last ? u - (last.right - P.openingWidth / 2) : Infinity;
      if (last && (subway ? gap <= P.subwayMerge : gap < P.openingWidth + P.minPier)) {
        last.right = u + P.openingWidth / 2;
        last.count++;
      } else openings.push({ left: u - P.openingWidth / 2, right: u + P.openingWidth / 2, count: 1 });
    }
    const arch = !subway && openings.length === 1 && openings[0].count === 1;
    const L = openings[0].left - P.side;
    const R = openings[openings.length - 1].right + P.side;
    // 壁の上端：入口とトンネルの少し奥の地面の高い方より上（地形との段差をふさぐ）。開口部の上には必ず梁を残す
    let high = -Infinity;
    for (const u of [L, 0, R]) {
      for (const z of [0, RAILWAYS.portalCover]) {
        const g = this.groundY(center.clone().addScaledVector(side, u).addScaledVector(forward, z));
        if (g !== null) high = Math.max(high, g - center.y);
      }
    }
    const top = Math.max(high + P.parapet, P.height + P.beam);
    const bottom = -1.5;

    // 正面の壁（開口部をくり抜いた板に厚みを付ける）と、上の笠石
    const outlines = openings.map((o) => openingOutline(o.left, o.right, P.height, arch, subway ? 0.6 : 1.2));
    const face = new THREE.Shape([
      new THREE.Vector2(L, bottom),
      new THREE.Vector2(R, bottom),
      new THREE.Vector2(R, top),
      new THREE.Vector2(L, top),
    ]);
    face.holes = outlines.map((pts) => new THREE.Path(pts));
    this.addConcrete(new THREE.ExtrudeGeometry(face, { depth: P.thickness, bevelEnabled: false }), frame);
    const coping = new THREE.Shape([
      new THREE.Vector2(L - 0.3, top),
      new THREE.Vector2(R + 0.3, top),
      new THREE.Vector2(R + 0.3, top + 0.4),
      new THREE.Vector2(L - 0.3, top + 0.4),
    ]);
    this.addConcrete(
      new THREE.ExtrudeGeometry(coping, { depth: P.thickness + 0.6, bevelEnabled: false }).translate(0, 0, -0.3),
      frame,
    );

    // トンネルの外側を覆うコンクリートの箱（地面に埋まっていれば見えない。浅い入口で、暗い内壁が地面から出ないように）
    const shell = new THREE.Shape([
      new THREE.Vector2(L, bottom),
      new THREE.Vector2(R, bottom),
      new THREE.Vector2(R, P.height + P.beam),
      new THREE.Vector2(L, P.height + P.beam),
    ]);
    // 側面だけ（前後のふたがあると、開口部の奥がふさがる）
    this.addConcrete(
      sideFaces(
        new THREE.ExtrudeGeometry(shell, { depth: RAILWAYS.portalDepth, bevelEnabled: false }).translate(0, 0, P.thickness),
      ),
      frame,
    );
    // 袖の壁：正面の壁の両端から、掘割の側へ。上端は壁の上端から、袖の先の地面へ下がる
    const at = (u: number, z: number) => center.clone().addScaledVector(side, u).addScaledVector(forward, z);
    for (const [u, out] of [
      [L + P.retainThickness, -1],
      [R - P.retainThickness, 1],
    ] as const) {
      const near = at(u, 0);
      const far = at(u, -P.wing);
      const farGround = this.groundY(far) ?? center.y;
      this.wall(near, far, center.y + top, Math.max(farGround + P.parapet, center.y + 1), center.y + bottom, side.clone().multiplyScalar(out));
    }

    // 奥へ続く内壁（入口近くは灰色、奥へ行くほど暗く）と、突き当たりの暗がり
    const near = new THREE.Color(RAILWAYS.tunnelLiningColor);
    const dark = new THREE.Color(RAILWAYS.tunnelColor);
    for (const pts of outlines) {
      const shape = new THREE.Shape(pts);
      const tube = sideFaces(
        new THREE.ExtrudeGeometry(shape, { depth: RAILWAYS.portalDepth, bevelEnabled: false, steps: 8 }).translate(
          0,
          0,
          P.thickness,
        ),
      );
      tube.deleteAttribute('uv');
      tube.deleteAttribute('normal');
      const pos = tube.getAttribute('position');
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        c.lerpColors(near, dark, THREE.MathUtils.clamp((pos.getZ(i) - P.thickness) / P.fade, 0, 1));
        colors.set([c.r, c.g, c.b], i * 3);
      }
      tube.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      tube.applyMatrix4(frame);
      this.lining.push(tube);
      const end = new THREE.ShapeGeometry(shape).translate(0, 0, P.thickness + RAILWAYS.portalDepth);
      end.deleteAttribute('uv');
      end.deleteAttribute('normal');
      const endColors = new Float32Array(end.getAttribute('position').count * 3);
      for (let i = 0; i < endColors.length; i += 3) endColors.set([dark.r, dark.g, dark.b], i);
      end.setAttribute('color', new THREE.BufferAttribute(endColors, 3));
      this.lining.push(end.applyMatrix4(frame).toNonIndexed());
    }

    // トンネルの中の線路（入口で途切れないよう、奥まで延ばす）
    const half = RAILWAYS.ballastWidth / 2;
    for (const u of tracks) {
      const rows = [0, RAILWAYS.portalDepth + P.thickness].map((z) => [
        this.track.vertex(at(u + half, z), 0, z / 2.4),
        this.track.vertex(at(u - half, z), 1, z / 2.4),
      ]);
      this.track.quad(rows[0][0], rows[0][1], rows[1][0], rows[1][1]);
    }
  }

  /**
   * 入口へ下りる掘割：底（擁壁の間）と、両側のコンクリートの擁壁（上端は地面の高さ。深い所は柵の代わりに少し高く）。
   * 掘割の内側の地形は描かない（Terrain.setTrenchMask）ので、地面より低い所はここで全部ふさぐ。
   * 隣を並んで走る掘割の線路がある側には擁壁を立てない（線路の間に壁が立たないように）
   */
  addRetainingWalls(approaches: Approach[]): void {
    const P = RAILWAYS.portal;
    const all = approaches.flatMap((ap) => ap.pts);
    for (const ap of approaches) {
      // 底
      for (let i = 1; i < ap.pts.length; i++) {
        const corner = (k: number, s: number) =>
          ap.pts[k].clone().addScaledVector(ap.sides[k], s * P.retainOffset).setY(ap.pts[k].y - P.floorDepth);
        const len = ap.pts[i - 1].distanceTo(ap.pts[i]);
        const a = this.walls.vertex(corner(i - 1, 1), 0, 0);
        const b = this.walls.vertex(corner(i - 1, -1), P.retainOffset * 2, 0);
        const c = this.walls.vertex(corner(i, 1), 0, len);
        const d = this.walls.vertex(corner(i, -1), P.retainOffset * 2, len);
        this.walls.quad(a, b, c, d);
      }
      for (const s of [1, -1]) {
        let prev: { base: THREE.Vector3; top: number; bottom: number } | null = null;
        for (let i = 0; i < ap.pts.length; i++) {
          const p = ap.pts[i];
          const dir = ap.sides[i].clone().multiplyScalar(s);
          const base = p.clone().addScaledVector(dir, P.retainOffset);
          const g = this.groundY(base);
          const blocked = all.some((q) => {
            if (q === p) return false;
            const d = q.clone().sub(p);
            const across = d.x * dir.x + d.z * dir.z;
            return across > 1 && across < P.retainOffset * 2 + 0.5 && Math.hypot(d.x, d.z) < P.retainOffset * 2 + 2;
          });
          const bottom = p.y - P.floorDepth - 0.2;
          if (g === null || blocked || g < bottom + 0.2) {
            prev = null;
            continue;
          }
          const cur = { base, top: g + (g - p.y > P.minDepth ? P.parapet : 0.05), bottom };
          if (prev) this.wall(prev.base, cur.base, prev.top, cur.top, Math.min(prev.bottom, cur.bottom), dir);
          prev = cur;
        }
      }
    }
  }

  /**
   * 壁1枚：内側の面の下端の線 a→b、上端の高さ topA・topB、下端の高さ bottom、外向き out（厚みを付ける向き）。
   * 内側・外側の面と上面
   */
  private wall(a: THREE.Vector3, b: THREE.Vector3, topA: number, topB: number, bottom: number, out: THREE.Vector3): void {
    const T = RAILWAYS.portal.retainThickness;
    const len = a.distanceTo(b);
    const w = this.walls;
    const quad = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, vScale: number) => {
      const i0 = w.vertex(p0, 0, p0.y * vScale);
      const i1 = w.vertex(p1, len, p1.y * vScale);
      const i2 = w.vertex(p2, 0, p2.y * vScale);
      const i3 = w.vertex(p3, len, p3.y * vScale);
      // 材質が両面描きなので、片向きだけ張る（両向きに重ねるとちらつく）
      w.quad(i0, i1, i2, i3);
    };
    const oa = a.clone().addScaledVector(out, T);
    const ob = b.clone().addScaledVector(out, T);
    quad(a.clone().setY(bottom), b.clone().setY(bottom), a.clone().setY(topA), b.clone().setY(topB), 1);
    quad(oa.clone().setY(bottom), ob.clone().setY(bottom), oa.clone().setY(topA), ob.clone().setY(topB), 1);
    quad(a.clone().setY(topA), b.clone().setY(topB), oa.clone().setY(topA), ob.clone().setY(topB), 0);
  }

  private addConcrete(g: THREE.BufferGeometry, frame: THREE.Matrix4): void {
    this.concrete.push(g.applyMatrix4(frame));
  }

  /** コンクリート（正面の壁・袖の壁・擁壁）と内壁の形。無ければ null */
  build(): { concrete: THREE.BufferGeometry | null; lining: THREE.BufferGeometry | null } {
    const walls = this.walls.build();
    const parts = [...this.concrete];
    if (walls) parts.push(walls.toNonIndexed());
    const concrete = parts.length > 0 ? mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g))) : null;
    const lining = this.lining.length > 0 ? mergeGeometries(this.lining) : null;
    for (const g of [...this.concrete, ...this.lining]) g.dispose();
    return { concrete, lining };
  }
}

/** 開口部の輪郭（u, v）：アーチ（半円の天井）か、上の角を斜めに落とした四角。下端はレール面より少し下 */
function openingOutline(left: number, right: number, height: number, arch: boolean, chamfer: number): THREE.Vector2[] {
  const b = -0.6;
  if (arch) {
    const r = (right - left) / 2;
    const cx = (left + right) / 2;
    const spring = height - r;
    const pts = [new THREE.Vector2(left, b), new THREE.Vector2(right, b)];
    for (let k = 0; k <= 12; k++) {
      const t = (k / 12) * Math.PI;
      pts.push(new THREE.Vector2(cx + Math.cos(t) * r, spring + Math.sin(t) * r));
    }
    return pts;
  }
  return [
    new THREE.Vector2(left, b),
    new THREE.Vector2(right, b),
    new THREE.Vector2(right, height - chamfer),
    new THREE.Vector2(right - chamfer, height),
    new THREE.Vector2(left + chamfer, height),
    new THREE.Vector2(left, height - chamfer),
  ];
}

/** ExtrudeGeometry の側面だけを取り出す（前後のふたを除く。属性はそのまま） */
function sideFaces(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const group = g.groups.find((gr) => gr.materialIndex === 1)!;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const size = attr.itemSize;
    const src = attr.array as Float32Array;
    out.setAttribute(
      name,
      new THREE.BufferAttribute(src.slice(group.start * size, (group.start + group.count) * size), size),
    );
  }
  g.dispose();
  return out;
}
