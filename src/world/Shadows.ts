import * as THREE from 'three';
import { GRAPHICS } from '../core/config';
import type { Atmosphere } from './Atmosphere';

/**
 * 太陽の影。建物が通りや隣の建物に落とす影を、カメラのまわり（前の方へずらした四角の範囲）だけに落とす。
 *
 * 空の太陽は夕焼けで低い（高さ 4°）ので、その向きのまま影を落とすと、高いビルの影が何 km にも伸びて街全体が影になる。
 * そこで、今の太陽の光（影なし。西を向いた壁を夕焼け色に照らす）はそのまま残し、
 * 同じ方角から少し高い角度（GRAPHICS.shadows.elevationDeg）で照らす光（影あり）を足す。
 * 今までは地面の明るさのほとんどが空からの環境光で、影の中と外の差が出ないので、環境光を ambientScale 倍に下げ、
 * その分を影ありの光（intensity）で補う（日なたの地面の明るさは今までに近いまま、影の中が暗くなる）。
 *
 * 時刻で太陽が動くと、影の光も同じ方位へ回る。夜は月の方位から、弱い影を落とす。
 *
 * 影を落とす範囲は、カメラが動いても影の縁がちらつかないよう、影の画素の大きさの格子に合わせて動かす。
 * 影を落とす・受けるの印は、シーンに足された物に一定の間隔で付ける（GRAPHICS.shadows.tagEvery フレームごと）。
 * 透明なもの・深度を書かないもの（空・空の車の光跡・水しぶき）と userData.noShadow のものは影を落とさない
 */
export class Shadows {
  readonly enabled: boolean;
  private readonly light: THREE.DirectionalLight;
  private readonly dir: THREE.Vector3;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private frame = 0;

  private lastAzimuth = NaN;
  private lastElevation = NaN;

  /**
   * @param atmosphere 空と光。影ありの光は、その光（太陽・夜は月）と同じ方位・同じ色にし、
   *   強さは atmosphere.shadowStrength 倍にする。影がある時は空からの環境光を弱める
   */
  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private readonly atmosphere: Atmosphere,
    /** 影を落とす物の親（建物の各区・ランドマーク・駅の屋根・高架）。区のタイルは後から読まれるので、関数で受け取る */
    private readonly casters: () => THREE.Object3D[],
  ) {
    const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('shadows');
    const s = GRAPHICS.shadows;
    this.enabled = param === null ? s.enabled : param !== '0';
    this.dir = new THREE.Vector3(0, 1, 0);
    this.light = new THREE.DirectionalLight(atmosphere.sun.color, s.intensity);
    if (!this.enabled) {
      this.light.visible = false;
      return;
    }
    atmosphere.setAmbientScale(s.ambientScale);

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const l = this.light;
    l.castShadow = true;
    l.shadow.mapSize.set(s.mapSize, s.mapSize);
    l.shadow.bias = s.bias;
    l.shadow.normalBias = s.normalBias;
    l.shadow.radius = s.blur;
    // 影の地図は update で updateEvery フレームに1回だけ描き直す
    l.shadow.autoUpdate = false;
    // 影の範囲の外から影を落とす高いビルも入るよう、光の側へ長く取る
    const cam = l.shadow.camera;
    cam.near = 1;
    cam.far = s.distance * 2;
    scene.add(l, l.target);
    this.followLight();
  }

  /**
   * 影を落とす光の向きを、今の光（太陽か月）の方位に合わせる。高さは影が長くなりすぎないよう、
   * 低い時は GRAPHICS.shadows.elevationDeg まで上げ、高い時（夏の昼）は 70° まで
   */
  private followLight(): void {
    const d = this.atmosphere.lightDirection;
    const azimuth = Math.atan2(-d.x, d.z);
    const elevation = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), GRAPHICS.shadows.elevationDeg * THREE.MathUtils.DEG2RAD, 70 * THREE.MathUtils.DEG2RAD);
    this.light.color.copy(this.atmosphere.sun.color);
    this.light.intensity = GRAPHICS.shadows.intensity * this.atmosphere.shadowStrength;
    if (Math.abs(azimuth - this.lastAzimuth) < 1e-4 && Math.abs(elevation - this.lastElevation) < 1e-4) return;
    this.lastAzimuth = azimuth;
    this.lastElevation = elevation;
    this.dir.set(-Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    // 光から見た横・縦の向き（影の範囲を、影の画素の格子に合わせて動かすため）
    this.right.crossVectors(this.dir, new THREE.Vector3(0, 1, 0)).normalize();
    this.up.crossVectors(this.right, this.dir).normalize();
    this.light.shadow.needsUpdate = true;
  }

  /** 毎フレーム、描く前に呼ぶ */
  update(camera: THREE.PerspectiveCamera, groundY: number): void {
    if (!this.enabled) return;
    const s = GRAPHICS.shadows;
    this.followLight();
    // 高く飛ぶほど遠くまで見えるので、範囲を広げる
    const altitude = Math.max(0, camera.position.y - groundY);
    const half = THREE.MathUtils.clamp(s.halfSize + altitude * s.growWithAltitude, s.halfSize, s.maxHalfSize);
    const cam = this.light.shadow.camera;
    if (cam.right !== half) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
    }

    // 範囲の中心：カメラの前の方（見ている向きの水平成分）へずらす
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() > 1e-6) this.forward.normalize();
    this.focus.copy(camera.position).addScaledVector(this.forward, half * s.ahead);
    this.focus.y = groundY;

    // 影の画素の格子に合わせる（光から見た横・縦の位置を丸める）
    const texel = (2 * half) / s.mapSize;
    const x = Math.round(this.focus.dot(this.right) / texel) * texel;
    const y = Math.round(this.focus.dot(this.up) / texel) * texel;
    const z = this.focus.dot(this.dir);
    this.focus.copy(this.right).multiplyScalar(x).addScaledVector(this.up, y).addScaledVector(this.dir, z);

    this.light.target.position.copy(this.focus);
    this.light.position.copy(this.focus).addScaledVector(this.dir, s.distance);
    this.light.target.updateMatrixWorld();
    this.light.updateMatrixWorld();

    if (this.frame % s.updateEvery === 0) this.light.shadow.needsUpdate = true;
    if (this.frame % s.tagEvery === 0) this.tag();
    this.frame++;
  }

  /**
   * 新しく足された物に、影を落とす・受けるの印を付ける。
   * 影を落とすのは casters の下（建物・ランドマーク・駅の屋根・高架）だけ。地形・道路・公園・木などは受けるだけ
   * （平らなもの・数の多いものは影の地図に描いても見た目がほとんど変わらず、重くなるだけ）
   */
  private tag(): void {
    for (const root of this.casters()) {
      root.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.shadowTagged) return;
        mark(mesh, true);
      });
    }
    this.scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.shadowTagged) return;
      mark(mesh, false);
    });
  }
}

function mark(mesh: THREE.Mesh, cast: boolean): void {
  mesh.userData.shadowTagged = true;
  if (mesh.userData.noShadow) return;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  // 透明なもの・深度を書かないもの（空・空の車の光跡・水）は影を落とさず、受けもしない
  const solid = materials.every((m) => m && !m.transparent && m.depthWrite !== false);
  mesh.receiveShadow = solid;
  mesh.castShadow = solid && cast;
}
