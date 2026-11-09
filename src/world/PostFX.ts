import * as THREE from 'three';
import { GRAPHICS } from '../core/config';

/**
 * 画面全体にかける後処理。今は SSAO（建物の足元・壁の隅・狭い通りに落ちる柔らかい影）だけ。
 *
 * 1. シーンを一度だけ、色と深度を持つ画面外の絵（マルチサンプル、HalfFloat）に描く
 * 2. 深度だけから AO を求める（半分の解像度）。法線は深度から作るので、シーンを描き直さない
 *    （GTAOPass などは法線を描くためにシーンをもう一度描くので、建物の多いこのゲームでは重い）
 * 3. 色に AO を掛け、トーンマッピングと sRGB への変換をして画面に描く（AO は深度の近いものだけで 5×5 にぼかしながら広げる）
 *
 * 空（深度 1）には AO を掛けない。遠くは霧に溶けるので、GRAPHICS.ao.fadeFar で消す。
 * GRAPHICS.ao.enabled が false、または URL に ?ao=0 がある時は、今までどおり直接画面に描く
 */
export class PostFX {
  readonly enabled: boolean;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly quad: THREE.Mesh;
  private readonly color: THREE.WebGLRenderTarget;
  private readonly ao: THREE.WebGLRenderTarget;
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly outMaterial: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('ao');
    this.enabled = param === null ? GRAPHICS.ao.enabled : param !== '0';
    // ?ao=debug：AO だけを白黒で映す（調整用）
    const debug = param === 'debug';

    this.color = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: GRAPHICS.msaa,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.ao = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, format: THREE.RedFormat, depthBuffer: false });

    const { ao } = GRAPHICS;
    this.aoMaterial = new THREE.ShaderMaterial({
      defines: { SAMPLES: ao.samples },
      uniforms: {
        tDepth: { value: this.color.depthTexture },
        projection: { value: new THREE.Matrix4() },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraNear: { value: 0.5 },
        cameraFar: { value: 1000 },
        radius: { value: ao.radius },
        radiusFar: { value: ao.radiusFar },
        bias: { value: ao.bias },
        power: { value: ao.power },
        fade: { value: new THREE.Vector2(ao.fadeNear, ao.fadeFar) },
        texel: { value: new THREE.Vector2() },
      },
      vertexShader: VERTEX,
      fragmentShader: AO_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.outMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.color.texture },
        tDepth: { value: this.color.depthTexture },
        tAO: { value: this.ao.texture },
        intensity: { value: ao.intensity },
        aoTexel: { value: new THREE.Vector2() },
        cameraNear: { value: 0.5 },
        cameraFar: { value: 1000 },
      },
      defines: debug ? { DEBUG_AO: 1 } : {},
      vertexShader: VERTEX,
      fragmentShader: OUT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      // トーンマッピングと出力の色空間はレンダラーの設定どおり（<tonemapping_fragment>・<colorspace_fragment>）
      toneMapped: true,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.aoMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.resize();
  }

  /** 画面の大きさ・画素の比が変わった時 */
  resize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    this.color.setSize(w, h);
    const aw = Math.max(1, Math.round(w * GRAPHICS.ao.resolution));
    const ah = Math.max(1, Math.round(h * GRAPHICS.ao.resolution));
    this.ao.setSize(aw, ah);
    this.aoMaterial.uniforms.texel.value.set(1 / aw, 1 / ah);
    this.outMaterial.uniforms.aoTexel.value.set(1 / aw, 1 / ah);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    if (!this.enabled) {
      r.render(scene, camera);
      return;
    }
    r.setRenderTarget(this.color);
    r.render(scene, camera);

    const u = this.aoMaterial.uniforms;
    u.projection.value.copy(camera.projectionMatrix);
    u.projectionInverse.value.copy(camera.projectionMatrixInverse);
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    this.outMaterial.uniforms.cameraNear.value = camera.near;
    this.outMaterial.uniforms.cameraFar.value = camera.far;

    this.quad.material = this.aoMaterial;
    r.setRenderTarget(this.ao);
    r.render(this.scene, this.camera);

    this.quad.material = this.outMaterial;
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const AO_FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform mat4 projection;
uniform mat4 projectionInverse;
uniform float cameraNear;
uniform float cameraFar;
uniform float radius;
uniform float radiusFar;
uniform float bias;
uniform float power;
uniform vec2 fade;
uniform vec2 texel;
varying vec2 vUv;

vec3 viewPosition(vec2 uv, float depth) {
  vec4 p = projectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

// 画面の位置ごとにずらす乱れ（Interleaved Gradient Noise）。サンプルの向きを回して、少ない数でも縞にならないように
float noise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  float depth = texture2D(tDepth, vUv).x;
  if (depth >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPosition(vUv, depth);
  float dist = -P.z;
  float fadeOut = 1.0 - smoothstep(fade.x, fade.y, dist);
  if (fadeOut <= 0.0) { gl_FragColor = vec4(1.0); return; }

  // 法線：上下左右の近い方の点と結ぶ（建物の縁で、奥の面と手前の面を混ぜない）
  vec3 l = viewPosition(vUv - vec2(texel.x, 0.0), texture2D(tDepth, vUv - vec2(texel.x, 0.0)).x);
  vec3 rr = viewPosition(vUv + vec2(texel.x, 0.0), texture2D(tDepth, vUv + vec2(texel.x, 0.0)).x);
  vec3 d = viewPosition(vUv - vec2(0.0, texel.y), texture2D(tDepth, vUv - vec2(0.0, texel.y)).x);
  vec3 u = viewPosition(vUv + vec2(0.0, texel.y), texture2D(tDepth, vUv + vec2(0.0, texel.y)).x);
  vec3 dx = abs(rr.z - P.z) < abs(P.z - l.z) ? rr - P : P - l;
  vec3 dy = abs(u.z - P.z) < abs(P.z - d.z) ? u - P : P - d;
  vec3 N = normalize(cross(dx, dy));

  // 遠いほど半径を広げる（遠くでは画素が粗く、近い半径では何も拾えない）
  float R = mix(radius, radiusFar, smoothstep(fade.x * 0.25, fade.y, dist));
  float angle = noise(gl_FragCoord.xy) * 6.2831853;
  vec3 T = normalize(abs(N.y) < 0.99 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(N, T);
  float occlusion = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float k = (float(i) + 0.5) / float(SAMPLES);
    // 半球の中の点：らせん状に並べ、中心に近いほど多く（近い遮りを重く見る）
    float a = angle + float(i) * 2.39996323;
    float s = sqrt(k);
    vec3 dir = T * (cos(a) * s) + B * (sin(a) * s) + N * sqrt(max(0.0, 1.0 - k));
    vec3 S = P + dir * (R * mix(0.2, 1.0, k * k));
    vec4 clip = projection * vec4(S, 1.0);
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
    float sceneZ = viewPosition(suv, texture2D(tDepth, suv).x).z;
    // 遮る：サンプルの点より手前に面がある。ただし半径より大きく離れた手前のもの（空中の電線・遠くの建物の縁）は数えない
    float range = smoothstep(0.0, 1.0, R / abs(P.z - sceneZ));
    // 遠いほど深度の精度が粗いので、平らな面が自分を遮らないよう余裕を距離に比例して広げる
    occlusion += (sceneZ >= S.z + bias * R + dist * 0.004 ? 1.0 : 0.0) * range;
  }
  float ao = mix(1.0, pow(1.0 - occlusion / float(SAMPLES), power), fadeOut);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

const OUT_FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform float intensity;
uniform vec2 aoTexel;
uniform float cameraNear;
uniform float cameraFar;
varying vec2 vUv;

float viewZ(float depth) {
  return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
}

void main() {
  vec4 color = texture2D(tColor, vUv);
  float z = viewZ(texture2D(tDepth, vUv).x);
  // AO（半分の解像度）を、深度の近い所だけで 5×5 にぼかしながら広げる（サンプルの向きの乱れを消す。
  // 建物の縁で手前と奥の AO が混ざらないように）
  float sum = 0.0;
  float weight = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * aoTexel;
      float sz = viewZ(texture2D(tDepth, uv).x);
      float w = 1.0 / (1e-3 + abs(sz - z) / max(1.0, -z * 0.02));
      sum += texture2D(tAO, uv).r * w;
      weight += w;
    }
  }
  float ao = sum / weight;
  gl_FragColor = vec4(color.rgb * mix(1.0, ao, intensity), color.a);
  #ifdef DEBUG_AO
  gl_FragColor = vec4(vec3(ao), 1.0);
  return;
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
