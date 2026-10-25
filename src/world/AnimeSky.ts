import * as THREE from 'three';
import { ATMOSPHERE } from '../core/config';

/**
 * アニメ調の夕焼け空。紫の天頂からピンクの地平線へのグラデーションに、
 * 夕日の方向が明るく縁取られた雲を重ねる。
 * 雲は空に投影した 2D のノイズで、夕日側へ少しずらした濃さとの差で「光の当たる面」を決める。
 */
export class AnimeSky extends THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  constructor(sunDirection: THREE.Vector3) {
    const { colors, clouds } = ATMOSPHERE.anime;
    const color = (hex: number) => ({ value: new THREE.Color(hex) });
    super(
      new THREE.SphereGeometry(1, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: {
          sunDirection: { value: sunDirection.clone().normalize() },
          time: { value: 0 },
          zenithColor: color(colors.zenith),
          upperColor: color(colors.upper),
          horizonColor: color(colors.horizon),
          glowColor: color(colors.glow),
          cloudShadow: color(colors.cloudShadow),
          cloudMid: color(colors.cloudMid),
          cloudLit: color(colors.cloudLit),
          cloudRim: color(colors.cloudRim),
          coverage: { value: clouds.coverage },
          sharpness: { value: clouds.sharpness },
          cloudScale: { value: clouds.scale },
          cloudSpeed: { value: clouds.speed },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorldPosition;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorldPosition = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 sunDirection;
          uniform float time;
          uniform vec3 zenithColor, upperColor, horizonColor, glowColor;
          uniform vec3 cloudShadow, cloudMid, cloudLit, cloudRim;
          uniform float coverage, sharpness, cloudScale, cloudSpeed;
          varying vec3 vWorldPosition;

          float hash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }
          float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                       mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
          }
          float fbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
            for (int i = 0; i < 6; i++) {
              v += a * noise(p);
              p = m * p;
              a *= 0.5;
            }
            return v;
          }

          void main() {
            vec3 dir = normalize(vWorldPosition - cameraPosition);
            vec3 sun = normalize(sunDirection);
            float h = dir.y;
            float t = clamp(h, 0.0, 1.0);
            vec2 sun2 = normalize(sun.xz + 1e-5);
            // 夕日の方位を向いているほど 1
            float toward = 0.5 + 0.5 * dot(normalize(dir.xz + 1e-5), sun2);

            // 空のグラデーション：地平線のピンク → 中ほどのラベンダー → 天頂の紫
            vec3 col = mix(horizonColor, upperColor, smoothstep(0.0, 0.28, t));
            col = mix(col, zenithColor, smoothstep(0.25, 0.95, t));
            // 夕日側の地平線付近を暖色に
            float lowGlow = pow(toward, 3.0) * (1.0 - smoothstep(0.0, 0.4, t));
            col = mix(col, glowColor, lowGlow * 0.75);
            // 太陽のまわりの光
            float sunAmount = max(dot(dir, sun), 0.0);
            col += glowColor * (pow(sunAmount, 12.0) * 0.6 + pow(sunAmount, 400.0) * 1.5);

            // 天頂付近にまばらな星
            if (h > 0.35) {
              vec2 sp = dir.xz / (h + 0.2) * 220.0;
              float star = step(0.9975, hash(floor(sp)));
              col += vec3(star) * 0.6 * smoothstep(0.35, 0.8, h);
            }

            // 雲：空に投影したノイズ。地平線に近いほど引き伸ばされて遠くに見える
            if (h > 0.0) {
              vec2 uv = dir.xz / (h + 0.1) * cloudScale + vec2(time * cloudSpeed, time * cloudSpeed * 0.35);
              float d = fbm(uv);
              float mask = smoothstep(coverage, coverage + sharpness, d);
              // 雲の厚さ：縁は薄く夕日が透けて明るい、芯は厚く影になる
              float thickness = smoothstep(coverage, coverage + 0.28, d);
              // 夕日側に少しずらした濃さより薄い所 = 夕日を向いた面
              float d2 = fbm(uv + sun2 * 0.05);
              float facing = clamp((d - d2) * 18.0, 0.0, 1.0);
              float lit = clamp((1.0 - thickness) * 0.75 + facing * 0.6, 0.0, 1.0);
              vec3 c = mix(cloudShadow, cloudMid, smoothstep(0.0, 0.5, lit));
              c = mix(c, cloudLit, smoothstep(0.4, 1.0, lit) * (0.45 + 0.55 * toward));
              // 縁の光（シルバーライニング）
              float edge = mask * (1.0 - mask) * 4.0;
              c += cloudRim * edge * (0.35 + 0.65 * toward) * 0.55;
              // 地平線に近い雲は空の暖色になじませる
              c = mix(c, mix(c, glowColor, 0.4), (1.0 - smoothstep(0.0, 0.3, t)) * toward);
              float fade = smoothstep(0.0, 0.035, h);
              col = mix(col, c, mask * fade);
            } else {
              // 地平線より下（地形の外側）はかすんだ地平線の色
              col = mix(horizonColor, horizonColor * 0.7, clamp(-h / 0.2, 0.0, 1.0));
            }

            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
  }

  set time(value: number) {
    this.material.uniforms.time.value = value;
  }
}
