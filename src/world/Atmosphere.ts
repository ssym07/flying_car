import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { ATMOSPHERE, WORLD } from '../core/config';
import { AnimeSky } from './AnimeSky';

/**
 * 空・雲・太陽・霧・環境光をまとめて扱う。ATMOSPHERE.style で空の描き方を選ぶ。
 * - anime：アニメ調の夕焼け空（AnimeSky）
 * - physical：物理ベースの大気散乱シェーダー（three.js の Sky）。雲も同じシェーダーで流す
 * 建物を照らす太陽光は空の太陽と同じ向きにし、ガラスに映る環境マップも空から作る。
 */
export class Atmosphere {
  private readonly sky: Sky | AnimeSky;
  private time = 0;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    const anime = ATMOSPHERE.style === 'anime';
    const preset = anime ? ATMOSPHERE.anime : ATMOSPHERE.physical;
    const sunDir = sunDirection(preset.sunElevationDeg, preset.sunAzimuthDeg);

    // アニメ調は色をそのまま出したいので、色相のずれが少ないトーンマッピングにする
    renderer.toneMapping = anime ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = preset.exposure;

    this.sky = anime ? new AnimeSky(sunDir) : createPhysicalSky(sunDir);
    // 空はカメラに追従させる。描画距離より内側に収め、最初に描いて（深度は書かない）
    // 後から描く建物や地形で上書きされるようにする
    this.sky.scale.setScalar(WORLD.viewDistance * 0.5);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    const sun = new THREE.DirectionalLight(preset.sunColor, preset.sunIntensity);
    sun.position.copy(sunDir);
    const hemisphere = new THREE.HemisphereLight(preset.skyLight, preset.groundLight, preset.ambientIntensity);
    scene.add(sun, hemisphere);

    scene.background = null;
    scene.fog = new THREE.Fog(preset.fogColor, preset.fog.near, preset.fog.far);

    // ガラスなどに映る環境マップを1回だけ作る
    const envScene = new THREE.Scene();
    const envSky = anime ? new AnimeSky(sunDir) : createPhysicalSky(sunDir);
    if (envSky instanceof Sky) {
      // 物理ベースの空は太陽円盤や雲を入れると映り込みがちらつく
      envSky.material.uniforms.showSunDisc.value = 0;
      envSky.material.uniforms.cloudCoverage.value = 0;
    }
    envSky.scale.setScalar(1000);
    envScene.add(envSky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene).texture;
    scene.environmentIntensity = preset.environmentIntensity;
    pmrem.dispose();
    envSky.geometry.dispose();
    envSky.material.dispose();
  }

  /** 毎フレーム呼ぶ。空をカメラに追従させ、雲を流す */
  update(camera: THREE.Camera, dt: number): void {
    this.sky.position.copy(camera.position);
    this.time += dt;
    if (this.sky instanceof AnimeSky) this.sky.time = this.time;
    else this.sky.material.uniforms.time.value = this.time;
  }
}

function createPhysicalSky(sunDir: THREE.Vector3): Sky {
  const p = ATMOSPHERE.physical;
  const sky = new Sky();
  const u = sky.material.uniforms;
  u.turbidity.value = p.turbidity;
  u.rayleigh.value = p.rayleigh;
  u.mieCoefficient.value = p.mieCoefficient;
  u.mieDirectionalG.value = p.mieDirectionalG;
  u.sunPosition.value.copy(sunDir);
  u.cloudCoverage.value = p.clouds.coverage;
  u.cloudDensity.value = p.clouds.density;
  u.cloudScale.value = p.clouds.scale;
  u.cloudSpeed.value = p.clouds.speed;
  u.cloudElevation.value = p.clouds.elevation;
  return sky;
}

/** 太陽の向き（ローカル座標、+x=西, +z=北, +y=上） */
function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = elevationDeg * THREE.MathUtils.DEG2RAD;
  // 方位は北から時計回り。東 = -x、北 = +z
  const az = azimuthDeg * THREE.MathUtils.DEG2RAD;
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
