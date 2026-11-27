import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { ATMOSPHERE, WORLD } from '../core/config';
import { REGION } from '../core/region';
import { currentSun, timeOfDay } from '../core/timeOfDay';
import { AnimeSky, type SkyLook } from './AnimeSky';

type TimeKey = (typeof ATMOSPHERE.anime.times)[number];
type ColorName = keyof TimeKey['colors'];
const COLOR_NAMES = Object.keys(ATMOSPHERE.anime.times[0].colors) as ColorName[];

/**
 * 空・雲・太陽・霧・環境光をまとめて扱う。ATMOSPHERE.style で空の描き方を選ぶ。
 * - anime：アニメ調の空（AnimeSky）。時刻（src/core/timeOfDay.ts）で太陽が動き、空の色・光・霧・明るさが
 *   ATMOSPHERE.anime.times の組の間でなめらかに変わる（夕焼け → 日没後の青 → 夜の星空と月）
 * - physical：物理ベースの大気散乱シェーダー（three.js の Sky）。太陽の向きだけ時刻で動かす
 * 建物を照らす光は、太陽が地平線より上の時は太陽、沈んだら月の向きから。ガラスに映る環境マップも空から作り、
 * 太陽が少し動くたびに作り直す。
 */
export class Atmosphere {
  private readonly sky: Sky | AnimeSky;
  private time = 0;
  /** 太陽（夜は月）の光（影は Shadows.ts の光が落とす） */
  readonly sun: THREE.DirectionalLight;
  /** 空からの環境光 */
  readonly hemisphere: THREE.HemisphereLight;
  /** 光の来る向き（太陽か月。影を落とす光もこの方位から） */
  readonly lightDirection = new THREE.Vector3();
  /** 影を落とす光の強さの倍率（夜は月の弱い影） */
  shadowStrength = 1;
  /** 夜の度合い 0（昼）..1（夜）。窓の灯りなどに使う */
  night = 0;
  /** 影がある時に環境光に掛ける倍率（Shadows.ts が決める） */
  ambientScale = 1;
  private readonly anime: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly fog: THREE.Fog;
  private readonly envSky: Sky | AnimeSky;
  private readonly envScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envElevation = NaN;
  private envAge = 0;
  private lastMinutes = NaN;
  private environmentIntensity = 0.5;
  private readonly look: SkyLook = {
    sunDirection: new THREE.Vector3(),
    moonDirection: new THREE.Vector3(),
    stars: 0,
    colors: Object.fromEntries(COLOR_NAMES.map((n) => [n, new THREE.Color()])) as SkyLook['colors'],
  };

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.anime = ATMOSPHERE.style === 'anime';
    this.renderer = renderer;
    this.scene = scene;
    const preset = this.anime ? ATMOSPHERE.anime : ATMOSPHERE.physical;
    const sunDir = sunDirection(preset.sunElevationDeg, preset.sunAzimuthDeg);

    // アニメ調は色をそのまま出したいので、色相のずれが少ないトーンマッピングにする
    renderer.toneMapping = this.anime ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = preset.exposure;

    this.sky = this.anime ? new AnimeSky(sunDir) : createPhysicalSky(sunDir);
    // 空はカメラに追従させる。描画距離より内側に収め、最初に描いて（深度は書かない）
    // 後から描く建物や地形で上書きされるようにする
    this.sky.scale.setScalar(WORLD.viewDistance * 0.5);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(preset.sunColor, preset.sunIntensity);
    this.sun.position.copy(sunDir);
    this.lightDirection.copy(sunDir);
    this.hemisphere = new THREE.HemisphereLight(preset.skyLight, preset.groundLight, preset.ambientIntensity);
    scene.add(this.sun, this.hemisphere);

    scene.background = null;
    this.fog = new THREE.Fog(preset.fogColor, preset.fog.near, preset.fog.far);
    scene.fog = this.fog;

    // ガラスなどに映る環境マップ用の空（太陽が動いたら作り直す）
    this.envSky = this.anime ? new AnimeSky(sunDir) : createPhysicalSky(sunDir);
    if (this.envSky instanceof Sky) {
      // 物理ベースの空は太陽円盤や雲を入れると映り込みがちらつく
      this.envSky.material.uniforms.showSunDisc.value = 0;
      this.envSky.material.uniforms.cloudCoverage.value = 0;
    }
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.environmentIntensity = preset.environmentIntensity;
    this.applyTime();
    this.rebuildEnvironment();
  }

  /** 毎フレーム呼ぶ。空をカメラに追従させ、雲を流し、時刻が変わったら空と光を変える */
  update(camera: THREE.Camera, dt: number): void {
    this.sky.position.copy(camera.position);
    this.time += dt;
    if (this.sky instanceof AnimeSky) this.sky.time = this.time;
    else this.sky.material.uniforms.time.value = this.time;
    if (timeOfDay.minutes !== this.lastMinutes) this.applyTime();
    // 環境マップは重いので、太陽が 1.5° 動くか、少し時間がたってから作り直す（スライダーを動かしている間に何度も作らない）
    this.envAge += dt;
    const el = this.look.sunDirection.y;
    if (Math.abs(el - this.envElevation) > 0.026 && this.envAge > 0.25) this.rebuildEnvironment();
  }

  /** 今の時刻から、太陽・月・空の色・光・霧・露出を決める */
  private applyTime(): void {
    this.lastMinutes = timeOfDay.minutes;
    const sun = currentSun(REGION.origin.latDeg, REGION.origin.lonDeg);
    const sunDir = sunDirection(sun.elevationDeg, sun.azimuthDeg);
    // 月は太陽のほぼ反対側
    const moonDir = sunDirection(-sun.elevationDeg, sun.azimuthDeg + 180);
    this.look.sunDirection.copy(sunDir);
    this.look.moonDirection.copy(moonDir);

    // 建物を照らす光の向き：太陽が出ている間は太陽（低すぎると壁に当たらないので 3° 以上）、
    // 沈んだら月（15〜60°）。日没後の -3〜-8° の間で入れ替える
    const sunLight = sunDirection(Math.max(sun.elevationDeg, 3), sun.azimuthDeg);
    const moonLight = sunDirection(THREE.MathUtils.clamp(-sun.elevationDeg, 15, 60), sun.azimuthDeg + 180);
    const toMoon = THREE.MathUtils.smoothstep(-sun.elevationDeg, 3, 8);
    this.lightDirection.copy(sunLight).lerp(moonLight, toMoon).normalize();
    this.sun.position.copy(this.lightDirection);
    this.night = 1 - THREE.MathUtils.smoothstep(sun.elevationDeg, -8, 1);

    if (!this.anime) {
      if (this.sky instanceof Sky) this.sky.material.uniforms.sunPosition.value.copy(sunDir);
      if (this.envSky instanceof Sky) this.envSky.material.uniforms.sunPosition.value.copy(sunDir);
      return;
    }

    // 太陽の高さで、隣り合う 2 つの組を混ぜる
    const keys = ATMOSPHERE.anime.times;
    let i = 0;
    while (i < keys.length - 2 && sun.elevationDeg > keys[i + 1].elevationDeg) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const t = THREE.MathUtils.clamp((sun.elevationDeg - a.elevationDeg) / (b.elevationDeg - a.elevationDeg), 0, 1);
    const k = t * t * (3 - 2 * t);
    const num = (x: number, y: number) => x + (y - x) * k;
    const col = (target: THREE.Color, x: number, y: number) => target.set(x).lerp(tmp.set(y), k);

    for (const n of COLOR_NAMES) col(this.look.colors[n], a.colors[n], b.colors[n]);
    this.look.stars = num(a.stars, b.stars);
    (this.sky as AnimeSky).setLook(this.look);
    (this.envSky as AnimeSky).setLook(this.look);

    col(this.sun.color, a.sunColor, b.sunColor);
    this.sun.intensity = num(a.sunIntensity, b.sunIntensity);
    col(this.hemisphere.color, a.skyLight, b.skyLight);
    col(this.hemisphere.groundColor, a.groundLight, b.groundLight);
    this.hemisphere.intensity = num(a.ambientIntensity, b.ambientIntensity) * this.ambientScale;
    col(this.fog.color, a.fogColor, b.fogColor);
    this.renderer.toneMappingExposure = num(a.exposure, b.exposure);
    this.environmentIntensity = num(a.environmentIntensity, b.environmentIntensity);
    this.scene.environmentIntensity = this.environmentIntensity;
    this.shadowStrength = num(a.shadow, b.shadow);
  }

  /** 影がある時に環境光を弱める倍率を決め直す */
  setAmbientScale(scale: number): void {
    this.ambientScale = scale;
    this.applyTime();
  }

  private rebuildEnvironment(): void {
    this.envElevation = this.look.sunDirection.y;
    this.envAge = 0;
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.environmentIntensity;
    old?.dispose();
  }
}

const tmp = new THREE.Color();

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
export function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = elevationDeg * THREE.MathUtils.DEG2RAD;
  // 方位は北から時計回り。東 = -x、北 = +z
  const az = azimuthDeg * THREE.MathUtils.DEG2RAD;
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
