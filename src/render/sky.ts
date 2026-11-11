import {
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Mesh,
  ShaderMaterial,
  type IUniform,
  type Texture,
} from 'three';
import { RIDGES, SKY } from '../config';
import type { DayCycle } from '../time/dayCycle';

/**
 * Uniforms shared (by reference) between the sky dome, the water, the ridges
 * and anything else that needs to agree with the sky.
 */
export interface SkyUniforms {
  [name: string]: IUniform;
  uSky: IUniform;
  uSunDir: IUniform;
  uSunColor: IUniform;
  uSunGlow: IUniform;
  uSunDisc: IUniform;
  uRidgeNear: IUniform;
  uRidgeFar: IUniform;
}

export function createSkyUniforms(cycle: DayCycle): SkyUniforms {
  return {
    uSky: { value: cycle.sky },
    uSunDir: { value: cycle.sunDir },
    uSunColor: { value: cycle.sunColor },
    uSunGlow: { value: cycle.sunGlow },
    uSunDisc: { value: cycle.sunDisc },
    uRidgeNear: { value: cycle.ridgeNear },
    uRidgeFar: { value: cycle.ridgeFar },
  };
}

/** Colours are shared objects; only the scalars need copying each frame. */
export function updateSkyUniforms(u: SkyUniforms, cycle: DayCycle): void {
  u.uSunGlow.value = cycle.sunGlow;
  u.uSunDisc.value = cycle.sunDisc;
}

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const S = SKY.stops;
const sunR = (SKY.sunRadius * Math.PI) / 180;

/**
 * The sky colour function. Included by the sky dome, the water (analytic
 * reflection + fog) and the ridges (aerial perspective), so all three sample
 * exactly the same values. uSky[0] = zenith ... uSky[5] = horizon/sun.
 */
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSky[6];
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uSunDisc;
uniform vec3 uRidgeNear;
uniform vec3 uRidgeFar;

float skyEase(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return mix(t, t * t * (3.0 - 2.0 * t), 0.7);
}

// 1 when a direction points at the sun's azimuth, 0 when it points away.
float sunAzimuth(vec3 dir) {
  vec2 d = dir.xz / max(length(dir.xz), 1e-4);
  vec2 s = uSunDir.xz / max(length(uSunDir.xz), 1e-4);
  return dot(d, s) * 0.5 + 0.5;
}

// Six-stop vertical gradient. The hottest colour only appears in a narrow band
// at the horizon around the sun; elsewhere the horizon is the cooler lower sky.
vec3 skyGradient(vec3 dir) {
  float y = max(dir.y, 0.0);
  float az = sunAzimuth(dir);
  float az2 = az * az;
  float hot = az2 * az2 * az;
  vec3 cool = mix(uSky[3], uSky[4], 0.35);
  vec3 cHorizon = mix(cool, uSky[5], hot);
  vec3 cNear = mix(mix(uSky[3], uSky[4], 0.5), uSky[4], az2);
  vec3 c = cHorizon;
  c = mix(c, cNear, skyEase(${f(S[0])}, ${f(S[1])}, y));
  c = mix(c, uSky[3], skyEase(${f(S[1])}, ${f(S[2])}, y));
  c = mix(c, uSky[2], skyEase(${f(S[2])}, ${f(S[3])}, y));
  c = mix(c, uSky[1], skyEase(${f(S[3])}, ${f(S[4])}, y));
  c = mix(c, uSky[0], skyEase(${f(S[4])}, ${f(S[5])}, y));
  return c * mix(0.9, 1.0, az);
}

// Soft glow around the sun. wide = 1 gives the broader, blurrier lobe used for
// the matte water reflection.
vec3 skyGlow(vec3 dir, float wide) {
  float mu = max(dot(dir, uSunDir), 0.0);
  float mu2 = mu * mu;
  float mu8 = mu2 * mu2; mu8 *= mu8;
  float mu32 = mu8 * mu8; mu32 *= mu32;
  float tight = 0.5 * mu32 * mu32 * mu8 + 0.34 * mu8 * mu2;
  float broad = 0.36 * mu32 + 0.3 * mu8;
  return uSunColor * (uSunGlow * 0.22 * mix(tight, broad, wide));
}

vec3 skySunDisc(vec3 dir) {
  float d = 1.0 - dot(dir, uSunDir);
  float r = ${(0.5 * sunR * sunR).toFixed(7)};
  float disc = 1.0 - smoothstep(r * 0.78, r * 1.14, d);
  return uSunColor * (uSunDisc * disc);
}

vec3 skyBase(vec3 dir) {
  return skyGradient(dir) + skyGlow(dir, 0.0);
}

vec3 skyReflection(vec3 dir) {
  return skyGradient(dir) + skyGlow(dir, 1.0);
}

// Colour of the sky right at the horizon in the direction of dir. This is the
// fog colour, so far-off water and ridge bases melt into the sky.
vec3 skyHorizon(vec3 dir) {
  float l = max(length(dir.xz), 1e-4);
  return skyBase(vec3(dir.x / l, 0.0, dir.z / l));
}

// Ridge silhouette colour for a layer (0 = nearest, 1 = farthest) with aerial
// perspective: farther layers lean toward the horizon colour.
vec3 ridgeLayerColor(float layer, float haze, vec3 horizonColor) {
  vec3 base = mix(uRidgeNear, uRidgeFar, layer);
  return mix(base, horizonColor, haze);
}
`;

/** Hazes per ridge layer as a GLSL-friendly list. */
export const RIDGE_HAZE = RIDGES.layers.map((l) => l.haze);

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // Full-screen triangle; rebuild the world-space view ray from the projection.
  vec3 viewDir = vec3(position.x / projectionMatrix[0][0], position.y / projectionMatrix[1][1], -1.0);
  vDir = transpose(mat3(viewMatrix)) * viewDir;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform sampler2D tNoise;
uniform mat3 uSkyRot;
uniform float uStars;
${SKY_GLSL}

// Milky Way band and two faint nebula wisps, all in the rotating star frame.
vec3 nightSky(vec3 dir) {
  vec3 d = uSkyRot * dir;
  const vec3 bandN = vec3(0.5294, 0.3369, 0.7786);
  const vec3 bandU = vec3(0.8270, 0.0, -0.5623);
  vec3 bandV = cross(bandN, bandU);
  float lat = dot(d, bandN);
  vec2 q = vec2(dot(d, bandU), dot(d, bandV));

  float n1 = texture2D(tNoise, q * 0.9 + vec2(lat * 1.3, 0.17)).b;
  float n2 = texture2D(tNoise, q * 2.3 + vec2(0.4, lat * 2.1)).a;
  float n3 = texture2D(tNoise, q * 5.1 + vec2(lat * 3.0, 0.7)).b;
  float cloud = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;

  float band = exp(-lat * lat * 11.0);
  float core = exp(-lat * lat * 60.0);
  float density = band * smoothstep(0.3, 0.75, cloud) + core * 0.35 * cloud;
  // Dark dust lanes through the core.
  density *= 1.0 - 0.55 * core * smoothstep(0.45, 0.7, n2);
  vec3 col = density * mix(vec3(0.34, 0.42, 0.72), vec3(0.72, 0.66, 0.78), core) * 0.12;

  // Nebula wisps: violet and teal.
  const vec3 nebA = vec3(-0.3015, 0.6030, -0.7385);
  const vec3 nebB = vec3(0.6509, 0.4650, -0.6003);
  float wa = exp(-(1.0 - dot(d, nebA)) * 9.0) * smoothstep(0.35, 0.8, n1 * 0.6 + n2 * 0.4);
  float wb = exp(-(1.0 - dot(d, nebB)) * 13.0) * smoothstep(0.4, 0.85, n2 * 0.55 + n3 * 0.45);
  col += wa * vec3(0.42, 0.22, 0.66) * 0.075;
  col += wb * vec3(0.12, 0.46, 0.5) * 0.065;

  float extinction = smoothstep(0.03, 0.4, dir.y);
  return col * extinction * uStars * uStars;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyBase(dir) + skySunDisc(dir);
  if (uStars > 0.01) col += nightSky(dir);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(skyUniforms: SkyUniforms, noise: Texture, skyRotation: Matrix3) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...skyUniforms,
        tNoise: { value: noise },
        uSkyRot: { value: skyRotation },
        uStars: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.matrixAutoUpdate = false;
  }

  update(cycle: DayCycle): void {
    this.material.uniforms.uStars.value = cycle.stars;
  }
}
