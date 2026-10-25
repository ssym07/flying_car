import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { ATMOSPHERE, WORLD } from '../core/config';

/**
 * 空・雲・太陽・霧・環境光をまとめて扱う。
 * 空は物理ベースの大気散乱シェーダー（three.js の Sky）で描き、雲も同じシェーダーで流す。
 * 建物を照らす太陽光は空の太陽と同じ向きにし、ガラスに映る環境マップも空から作る。
 */
export class Atmosphere {
  private readonly sky = new Sky();
  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  private time = 0;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = ATMOSPHERE.exposure;

    const sunDir = sunDirection();
    const u = this.sky.material.uniforms;
    u.turbidity.value = ATMOSPHERE.turbidity;
    u.rayleigh.value = ATMOSPHERE.rayleigh;
    u.mieCoefficient.value = ATMOSPHERE.mieCoefficient;
    u.mieDirectionalG.value = ATMOSPHERE.mieDirectionalG;
    u.sunPosition.value.copy(sunDir);
    u.cloudCoverage.value = ATMOSPHERE.clouds.coverage;
    u.cloudDensity.value = ATMOSPHERE.clouds.density;
    u.cloudScale.value = ATMOSPHERE.clouds.scale;
    u.cloudSpeed.value = ATMOSPHERE.clouds.speed;
    u.cloudElevation.value = ATMOSPHERE.clouds.elevation;

    // 空の箱はカメラに追従させる。描画距離より内側に収め、最初に描いて（深度は書かない）
    // 後から描く建物や地形で上書きされるようにする
    this.sky.scale.setScalar(WORLD.viewDistance * 0.5);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xfff4e5, ATMOSPHERE.sunIntensity);
    this.sun.position.copy(sunDir);
    this.hemisphere = new THREE.HemisphereLight(0xe6eef8, 0x4d4a44, ATMOSPHERE.ambientIntensity);
    scene.add(this.sun, this.hemisphere);

    scene.background = null;
    scene.fog = new THREE.Fog(ATMOSPHERE.fogColor, WORLD.fog.near, WORLD.fog.far);

    // ガラスなどに映る環境マップ（雲や太陽円盤は入れない）を1回だけ作る
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    Object.assign(envSky.material.uniforms, THREE.UniformsUtils.clone(this.sky.material.uniforms));
    envSky.material.uniforms.showSunDisc.value = 0;
    envSky.material.uniforms.cloudCoverage.value = 0;
    envScene.add(envSky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene).texture;
    scene.environmentIntensity = ATMOSPHERE.environmentIntensity;
    pmrem.dispose();
    envSky.geometry.dispose();
    envSky.material.dispose();
  }

  /** 毎フレーム呼ぶ。空をカメラに追従させ、雲を流す */
  update(camera: THREE.Camera, dt: number): void {
    this.sky.position.copy(camera.position);
    this.time += dt;
    this.sky.material.uniforms.time.value = this.time;
  }
}

/** 太陽の向き（ローカル座標、+x=西, +z=北, +y=上） */
function sunDirection(): THREE.Vector3 {
  const el = ATMOSPHERE.sunElevationDeg * THREE.MathUtils.DEG2RAD;
  // 方位は北から時計回り。東 = -x、北 = +z
  const az = ATMOSPHERE.sunAzimuthDeg * THREE.MathUtils.DEG2RAD;
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
