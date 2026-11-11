import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Mesh,
  NoBlending,
  PerspectiveCamera,
  ShaderMaterial,
  Vector2,
  type Scene,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RIDGES, WATER } from '../config';
import type { DayCycle } from '../time/dayCycle';
import { createColorTarget, FSQ_VERT, FullScreenQuad } from '../util/fullscreen';
import { SKY_GLSL, type SkyUniforms } from './sky';
import { REFLECT_LAYER } from './stars';
import { SWELL_GLSL } from './swell';

const VERT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec2 vGrad;
${SWELL_GLSL}
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  float fade = 1.0 - smoothstep(${WATER.swellFade[0].toFixed(1)}, ${WATER.swellFade[1].toFixed(1)}, length(position.xz));
  vec3 s = swell(world.xz, uTime) * fade;
  world.y = s.x;
  vGrad = s.yz;
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const layers = RIDGES.layers;
const layerT = (i: number) => (layers.length > 1 ? i / (layers.length - 1) : 0).toFixed(4);
const channel = ['r', 'g', 'b', 'a'];

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec2 vGrad;
uniform float uTime;
uniform sampler2D tNoise;
uniform sampler2D tRidge;
uniform sampler2D tReflect;
uniform float uReflect;
uniform vec2 uResolution;
uniform vec3 uWaterDeep;
uniform float uFogDistance;
uniform float uRipple;
${SKY_GLSL}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // Fine ripples: three scrolling lookups of the shared normal texture. The
  // mip chain flattens them with distance, which also keeps the far water calm.
  vec2 p = vWorld.xz;
  vec2 n1 = texture2D(tNoise, p * 0.021 + uTime * vec2(0.0041, 0.0027)).rg - 0.5;
  vec2 n2 = texture2D(tNoise, p * 0.067 + uTime * vec2(-0.0083, 0.0061)).rg - 0.5;
  vec2 n3 = texture2D(tNoise, p * 0.23 + uTime * vec2(0.011, -0.0147)).rg - 0.5;
  vec2 rip = (n1 * 1.1 + n2 * 0.8 + n3 * 0.5) * uRipple;
  vec3 N = normalize(vec3(-vGrad.x - rip.x, 1.0, -vGrad.y - rip.y));

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.004;
  R = normalize(R);

  // Analytic sky reflection, softened by blending in a lifted second sample:
  // a matte, hazy reflection rather than a mirror.
  vec3 refl = mix(skyReflection(R), skyReflection(normalize(R + vec3(0.0, 0.14, 0.0))), 0.45);

  // Ridge silhouettes, reflected from the baked ridgeline profile.
  float tanEl = R.y / max(length(R.xz), 1e-4);
  float az = atan(R.z, R.x) * 0.15915494 + 0.5;
  vec4 prof = texture2D(tRidge, vec2(az, 0.5)) * ${RIDGES.profileMaxTan.toFixed(4)};
  vec3 hz = skyHorizon(R);
  float soft = 0.012 + tanEl * 0.35;
  float ridgeMask = 0.0;
  float m;
${layers
  .map((_, idx) => layers.length - 1 - idx)
  .map(
    (i) => `  m = 1.0 - smoothstep(prof.${channel[i]} - soft, prof.${channel[i]} + soft, tanEl);
  refl = mix(refl, ridgeLayerColor(${layerT(i)}, ${Math.min(1, layers[i].haze + 0.1).toFixed(3)}, hz), m * 0.8);
  ridgeMask = max(ridgeMask, m);`,
  )
  .join('\n')}

  // Fresnel: darker looking down into the water, brighter toward the horizon.
  float cosT = max(dot(N, V), 0.0);
  float fres = 0.1 + 0.9 * pow(1.0 - cosT, 3.6);
  vec3 col = mix(uWaterDeep, refl, fres);

  // Sun road: glitter where rippled normals catch the sun.
  float sd = max(dot(R, uSunDir), 0.0);
  float sd2 = sd * sd; float sd8 = sd2 * sd2; sd8 *= sd8;
  float sd64 = sd8 * sd8; sd64 *= sd64; sd64 *= sd64;
  float glitter = sd64 * sd64 * sd64 * 0.85 + sd64 * 0.09;
  col += uSunColor * (uSunDisc * glitter * (1.0 - ridgeMask) * fres);

  // Blurred planar reflection of light sources (lanterns, bright stars, glow).
  if (uReflect > 0.0) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    suv += vec2(rip.x * 0.25, rip.y * 0.8);
    col += texture2D(tReflect, suv).rgb * (uReflect * mix(0.45, 1.0, fres));
  }

  // Horizon haze, tinted with the sky's own horizon colour in this direction.
  float fog = 1.0 - exp(-pow(dist / uFogDistance, 1.25));
  col = mix(col, skyHorizon(-V), fog);

  gl_FragColor = vec4(col, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uStep;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb * 0.227027;
  c += (texture2D(tMap, vUv + uStep * 1.3846154).rgb + texture2D(tMap, vUv - uStep * 1.3846154).rgb) * 0.3162162;
  c += (texture2D(tMap, vUv + uStep * 3.2307692).rgb + texture2D(tMap, vUv - uStep * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

/** Polar grid: fine under the camera, coarse toward the horizon. */
function createWaterGeometry(): BufferGeometry {
  const { rings, spokes, radius } = WATER;
  const inner = 5;
  const b = Math.log(radius / inner + 1);
  const count = 1 + rings * spokes;
  const positions = new Float32Array(count * 3);
  const index: number[] = [];
  let v = 1;
  for (let r = 1; r <= rings; r++) {
    const rad = inner * (Math.exp((b * r) / rings) - 1);
    for (let s = 0; s < spokes; s++) {
      // Stagger alternate rings to avoid long radial seams.
      const a = ((s + (r % 2) * 0.5) / spokes) * Math.PI * 2;
      positions[v * 3] = Math.cos(a) * rad;
      positions[v * 3 + 2] = Math.sin(a) * rad;
      v++;
    }
  }
  const at = (r: number, s: number) => 1 + (r - 1) * spokes + (((s % spokes) + spokes) % spokes);
  for (let s = 0; s < spokes; s++) index.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < spokes; s++) {
      const a = at(r, s);
      const bb = at(r, s + 1);
      const c = at(r + 1, s);
      const d = at(r + 1, s + 1);
      index.push(a, bb, c, bb, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

export class Water {
  readonly mesh: Mesh;
  /** Planar light reflections (off on the low quality tier). */
  reflections = true;

  private readonly material: ShaderMaterial;
  private readonly mirrorCamera = new PerspectiveCamera();
  private readonly mirror = new Matrix4().makeScale(1, -1, 1);
  private readonly rtScene: WebGLRenderTarget;
  private readonly rtBlurA: WebGLRenderTarget;
  private readonly rtBlurB: WebGLRenderTarget;
  private readonly blurQuad: FullScreenQuad;
  private readonly blurMaterial: ShaderMaterial;
  private readonly clearColor = new Color();
  private readonly black = new Color(0, 0, 0);

  constructor(skyUniforms: SkyUniforms, noise: Texture, ridgeProfile: Texture) {
    this.rtScene = createColorTarget();
    this.rtBlurA = createColorTarget();
    this.rtBlurB = createColorTarget();

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...skyUniforms,
        uTime: { value: 0 },
        tNoise: { value: noise },
        tRidge: { value: ridgeProfile },
        tReflect: { value: this.rtBlurB.texture },
        uReflect: { value: 0 },
        uResolution: { value: new Vector2(1, 1) },
        uWaterDeep: { value: new Color() },
        uFogDistance: { value: WATER.fogDistance },
        uRipple: { value: WATER.rippleStrength },
      },
      // Drawn in the transparent queue purely for ordering (after the ridges);
      // it still overwrites and writes depth like an opaque surface.
      transparent: true,
      blending: NoBlending,
      depthWrite: true,
    });
    this.mesh = new Mesh(createWaterGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -50;

    this.blurMaterial = new ShaderMaterial({
      vertexShader: FSQ_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { tMap: { value: null }, uStep: { value: new Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.blurQuad = new FullScreenQuad(this.blurMaterial);

    this.mirrorCamera.matrixAutoUpdate = false;
    this.mirrorCamera.layers.set(REFLECT_LAYER);
  }

  /** `width`/`height` are drawing-buffer pixels. */
  setSize(width: number, height: number): void {
    this.material.uniforms.uResolution.value.set(width, height);
    const hw = Math.max(2, Math.round(width / 2));
    const hh = Math.max(2, Math.round(height / 2));
    this.rtScene.setSize(hw, hh);
    const qw = Math.max(2, Math.round(width / 4));
    const qh = Math.max(2, Math.round(height / 4));
    this.rtBlurA.setSize(qw, qh);
    this.rtBlurB.setSize(qw, qh);
  }

  update(elapsed: number, cycle: DayCycle, camera: PerspectiveCamera): void {
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uWaterDeep.value.copy(cycle.waterDeep);
    this.material.uniforms.uReflect.value = this.reflections ? 1 : 0;
  }

  /**
   * Render everything on REFLECT_LAYER mirrored about the water plane, at half
   * resolution, then blur it (wider vertically, like real light on water).
   * Call before the main scene render.
   */
  renderReflection(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (!this.reflections) return;

    // View = mainView * mirror, so the reflected scene lands exactly where the
    // main camera sees the water: the water shader samples it by screen UV.
    const mc = this.mirrorCamera;
    mc.matrix.multiplyMatrices(this.mirror, camera.matrixWorld);
    mc.matrixWorldNeedsUpdate = true;
    mc.projectionMatrix.copy(camera.projectionMatrix);
    mc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);

    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(this.black, 1);

    renderer.setRenderTarget(this.rtScene);
    renderer.clear();
    renderer.render(scene, mc);

    const u = this.blurMaterial.uniforms;
    u.tMap.value = this.rtScene.texture;
    u.uStep.value.set(1.6 / this.rtScene.width, 0);
    renderer.setRenderTarget(this.rtBlurA);
    this.blurQuad.render(renderer);

    u.tMap.value = this.rtBlurA.texture;
    u.uStep.value.set(0, 2.6 / this.rtBlurA.height);
    renderer.setRenderTarget(this.rtBlurB);
    this.blurQuad.render(renderer);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.clearColor, prevAlpha);
  }
}
