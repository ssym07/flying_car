import * as THREE from 'three';
import { GRAPHICS } from '../core/config';

/**
 * 太陽の影。建物が通りや隣の建物に落とす影を、カメラのまわり（前の方へずらした四角の範囲）だけに落とす。
 *
 * 空の太陽は夕焼けで低い（高さ 4°）ので、その向きのまま影を落とすと、高いビルの影が何 km にも伸びて街全体が影になる。
 * そこで、今の太陽の光（影なし。西を向いた壁を夕焼け色に照らす）はそのまま残し、
 * 同じ方角から少し高い角度（GRAPHICS.shadows.elevationDeg）で照らす光（影あり）を足す。
 * 今までは地面の明るさのほとんどが空からの環境光で、影の中と外の差が出ないので、環境光を ambientScale 倍に下げ、
 * その分を影ありの光（intensity）で補う（日なたの地面の明るさは今までに近いまま、影の中が暗くなる）。
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

  /**
   * @param sun 今の太陽の光（影なしのまま。色を影ありの光に使う）
   * @param hemisphere 空からの環境光（影がある時は弱める）
   * @param azimuthDeg 太陽の方位（北から時計回り）
   */
  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    sun: THREE.DirectionalLight,
    hemisphere: THREE.HemisphereLight,
    azimuthDeg: number,
    /** 影を落とす物の親（建物の各区・ランドマーク・駅の屋根・高架）。区のタイルは後から読まれるので、関数で受け取る */
    private readonly casters: () => THREE.Object3D[],
  ) {
    const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('shadows');
    const s = GRAPHICS.shadows;
    this.enabled = param === null ? s.enabled : param !== '0';
    this.dir = sunDirection(s.elevationDeg, azimuthDeg);
    this.light = new THREE.DirectionalLight(sun.color, s.intensity);
    if (!this.enabled) {
      this.light.visible = false;
      return;
    }
    hemisphere.intensity *= s.ambientScale;

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

    // 光から見た横・縦の向き（影の範囲を、影の画素の格子に合わせて動かすため）
    this.right.crossVectors(this.dir, new THREE.Vector3(0, 1, 0)).normalize();
    this.up.crossVectors(this.right, this.dir).normalize();
  }

  /** 毎フレーム、描く前に呼ぶ */
  update(camera: THREE.PerspectiveCamera, groundY: number): void {
    if (!this.enabled) return;
    const s = GRAPHICS.shadows;
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

/** 太陽の向き（ローカル座標、+x=西, +z=北, +y=上。Atmosphere.ts と同じ） */
function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = elevationDeg * THREE.MathUtils.DEG2RAD;
  const az = azimuthDeg * THREE.MathUtils.DEG2RAD;
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
