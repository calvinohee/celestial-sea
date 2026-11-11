import {
  HalfFloatType,
  LinearFilter,
  NoToneMapping,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { POST, QUALITY, type QualitySettings, type QualityTier } from '../config';
import { createColorTarget, FSQ_VERT, FullScreenQuad } from '../util/fullscreen';

const MAX_BLOOM_LEVELS = 5;

// Bright-pass + first 2x downsample, with a soft knee so nothing pops.
const PREFILTER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  // Guard against stray huge values so one hot pixel cannot flood the bloom.
  c = min(c, vec3(24.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

// Dual-filter (Kawase) downsample: 5 bilinear taps.
const DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uTexel;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb * 4.0;
  c += texture2D(tMap, vUv + uTexel).rgb;
  c += texture2D(tMap, vUv - uTexel).rgb;
  c += texture2D(tMap, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
  c += texture2D(tMap, vUv - vec2(uTexel.x, -uTexel.y)).rgb;
  gl_FragColor = vec4(c * 0.125, 1.0);
}
`;

// Dual-filter upsample (8 taps) added to the matching downsample level.
const UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform sampler2D tHigh;
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel;
  vec3 c = texture2D(tMap, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  c += texture2D(tMap, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  c += texture2D(tMap, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += texture2D(tMap, vUv + vec2(h.x, h.y)).rgb * 2.0;
  c += texture2D(tMap, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture2D(tMap, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  c += texture2D(tMap, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  c += texture2D(tMap, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0 + texture2D(tHigh, vUv).rgb, 1.0);
}
`;

// Composite: scene + bloom, exposure, vignette, ACES filmic, grade, sRGB, grain.
const FINAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uSaturation;
uniform float uTime;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

// ACES filmic (Stephen Hill's fit, as in three.js).
vec3 acesFilmic(vec3 color) {
  const mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = inputMat * color;
  color = RRTAndODTFit(color);
  color = outputMat * color;
  return clamp(color, 0.0, 1.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 col = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom;
  col *= uExposure;

  float d = length(vUv - 0.5) * 1.4142;
  col *= 1.0 - uVignette * smoothstep(0.3, 1.05, d);

  col = acesFilmic(col);
  // Keep the pinks and oranges rich after the filmic shoulder.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(l), col, uSaturation), 0.0, 1.0);

  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), col));

  // Dither always (hides banding in the dark gradients); grain is optional.
  float n = hash(gl_FragCoord.xy + fract(uTime * 7.31) * 173.0) - 0.5;
  col += n * (1.5 / 255.0 + uGrain);
  gl_FragColor = vec4(col, 1.0);
}
`;

function passMaterial(fragmentShader: string, uniforms: ShaderMaterial['uniforms']): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: FSQ_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

/**
 * WebGL renderer plus a small hand-rolled post chain:
 * scene (HDR, optional MSAA) -> dual-filter bloom -> tone map/grade to screen.
 * Quality tiers change DPR, MSAA, bloom depth and grain.
 */
export class RenderPipeline {
  readonly renderer: WebGLRenderer;
  tier: QualityTier = 'high';
  settings: QualitySettings = QUALITY.high;
  /** Drawing-buffer size in pixels. */
  readonly bufferSize = new Vector2(2, 2);
  pixelRatio = 1;
  /** Called after any size or pixel-ratio change. */
  onResize: ((bufferWidth: number, bufferHeight: number, pixelRatio: number) => void) | null = null;

  private sceneTarget: WebGLRenderTarget;
  private readonly down: WebGLRenderTarget[] = [];
  private readonly up: WebGLRenderTarget[] = [];
  private readonly prefilter: ShaderMaterial;
  private readonly downMat: ShaderMaterial;
  private readonly upMat: ShaderMaterial;
  private readonly finalMat: ShaderMaterial;
  private readonly quad = new FullScreenQuad();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping; // tone mapping happens in the final pass
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 1);

    this.sceneTarget = this.createSceneTarget();
    for (let i = 0; i < MAX_BLOOM_LEVELS; i++) {
      this.down.push(createColorTarget());
      this.up.push(createColorTarget());
    }

    this.prefilter = passMaterial(PREFILTER_FRAG, {
      tMap: { value: null },
      uTexel: { value: new Vector2() },
      uThreshold: { value: POST.bloomThreshold },
      uKnee: { value: POST.bloomKnee },
    });
    this.downMat = passMaterial(DOWN_FRAG, { tMap: { value: null }, uTexel: { value: new Vector2() } });
    this.upMat = passMaterial(UP_FRAG, {
      tMap: { value: null },
      tHigh: { value: null },
      uTexel: { value: new Vector2() },
    });
    this.finalMat = passMaterial(FINAL_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      uBloom: { value: POST.bloomStrength },
      uExposure: { value: 1 },
      uVignette: { value: POST.vignette },
      uGrain: { value: POST.grain },
      uSaturation: { value: POST.saturation },
      uTime: { value: 0 },
    });

    this.resize();
  }

  private createSceneTarget(): WebGLRenderTarget {
    return new WebGLRenderTarget(this.bufferSize.x, this.bufferSize.y, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: this.settings.msaa,
    });
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.settings = QUALITY[tier];
    this.sceneTarget.dispose();
    this.sceneTarget = this.createSceneTarget();
    this.resize();
  }

  /** Re-read the canvas' CSS size and device pixel ratio. */
  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.settings.maxDpr);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.renderer.getDrawingBufferSize(this.bufferSize);
    const bw = this.bufferSize.x;
    const bh = this.bufferSize.y;

    this.sceneTarget.setSize(bw, bh);
    let w = bw;
    let h = bh;
    for (let i = 0; i < MAX_BLOOM_LEVELS; i++) {
      w = Math.max(2, Math.round(w / 2));
      h = Math.max(2, Math.round(h / 2));
      this.down[i].setSize(w, h);
      this.up[i].setSize(w, h);
    }
    this.onResize?.(bw, bh, this.pixelRatio);
  }

  get aspect(): number {
    return this.bufferSize.x / this.bufferSize.y;
  }

  render(scene: Scene, camera: PerspectiveCamera, exposure: number, elapsed: number): void {
    const r = this.renderer;

    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(scene, camera);

    // Bloom: prefilter to half res, walk down, then back up accumulating.
    const levels = Math.min(this.settings.bloomLevels, MAX_BLOOM_LEVELS);
    const src = this.sceneTarget;
    this.quad.material = this.prefilter;
    this.prefilter.uniforms.tMap.value = src.texture;
    this.prefilter.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    r.setRenderTarget(this.down[0]);
    this.quad.render(r);

    this.quad.material = this.downMat;
    for (let i = 1; i < levels; i++) {
      const from = this.down[i - 1];
      this.downMat.uniforms.tMap.value = from.texture;
      this.downMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
      r.setRenderTarget(this.down[i]);
      this.quad.render(r);
    }

    this.quad.material = this.upMat;
    let low = this.down[levels - 1];
    for (let i = levels - 2; i >= 0; i--) {
      this.upMat.uniforms.tMap.value = low.texture;
      this.upMat.uniforms.tHigh.value = this.down[i].texture;
      this.upMat.uniforms.uTexel.value.set(0.5 / low.width, 0.5 / low.height);
      r.setRenderTarget(this.up[i]);
      this.quad.render(r);
      low = this.up[i];
    }

    const u = this.finalMat.uniforms;
    u.tScene.value = this.sceneTarget.texture;
    u.tBloom.value = low.texture;
    u.uBloom.value = POST.bloomStrength / levels;
    u.uExposure.value = exposure;
    u.uGrain.value = this.settings.grain ? POST.grain : 0;
    u.uTime.value = elapsed;
    this.quad.material = this.finalMat;
    r.setRenderTarget(null);
    this.quad.render(r);
  }
}
