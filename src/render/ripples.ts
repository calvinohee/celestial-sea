import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  type Texture,
} from 'three';
import { RIPPLES, WAKE } from '../config';
import type { DayCycle } from '../time/dayCycle';
import { SWELL_GLSL, swellScale } from './swell';

const RIPPLE_VERT = /* glsl */ `
attribute vec3 aCenter;  // x, z, start time
attribute vec2 aParams;  // strength, max radius
uniform float uTime;
varying vec2 vUv;
varying float vLife;
varying float vStrength;
${SWELL_GLSL}
void main() {
  float age = uTime - aCenter.z;
  float t = clamp(age / ${RIPPLES.lifetime.toFixed(2)}, 0.0, 1.0);
  vLife = t;
  vStrength = aParams.x * step(0.0, age) * step(age, ${RIPPLES.lifetime.toFixed(2)});
  // Ease out: quick at first, then slowing as it spreads.
  float radius = aParams.y * (1.0 - (1.0 - t) * (1.0 - t)) + 0.12;
  vUv = position.xz;
  vec2 xz = aCenter.xy + position.xz * radius;
  float h = swell(xz, uTime).x;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, h + 0.02, xz.y, 1.0);
}
`;

const RIPPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vLife;
varying float vStrength;
uniform float uIntensity;
void main() {
  if (vStrength <= 0.0) discard;
  float r = length(vUv);
  float w = 0.05 + 0.07 * vLife;
  float outer = exp(-pow((r - 0.86) / w, 2.0));
  float inner = exp(-pow((r - 0.5) / (w * 1.4), 2.0)) * 0.35 * (1.0 - vLife);
  float fill = (1.0 - smoothstep(0.0, 0.86, r)) * 0.12 * (1.0 - vLife);
  float fade = (1.0 - vLife);
  fade = fade * sqrt(fade) * smoothstep(0.0, 0.06, vLife);
  vec3 col = mix(vec3(0.16, 0.86, 0.9), vec3(0.42, 1.0, 0.86), outer);
  gl_FragColor = vec4(col * ((outer + inner + fill) * fade * vStrength * uIntensity), 1.0);
}
`;

/**
 * Bioluminescent rings: a fixed pool drawn as one instanced mesh. Spawning
 * just overwrites the oldest slot, so nothing is allocated at runtime.
 */
export class Ripples {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly centers: InstancedBufferAttribute;
  private readonly params: InstancedBufferAttribute;
  private next = 0;
  private time = 0;

  constructor() {
    // A small grid rather than a single quad so the ring can follow the swell.
    const n = 6;
    const positions: number[] = [];
    const index: number[] = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) positions.push((i / n) * 2 - 1, 0, (j / n) * 2 - 1);
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        index.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    g.setIndex(index);
    const centers = new Float32Array(RIPPLES.pool * 3);
    for (let i = 0; i < RIPPLES.pool; i++) centers[i * 3 + 2] = -1000;
    this.centers = new InstancedBufferAttribute(centers, 3);
    this.centers.setUsage(DynamicDrawUsage);
    this.params = new InstancedBufferAttribute(new Float32Array(RIPPLES.pool * 2), 2);
    this.params.setUsage(DynamicDrawUsage);
    g.setAttribute('aCenter', this.centers);
    g.setAttribute('aParams', this.params);
    g.instanceCount = RIPPLES.pool;

    this.material = new ShaderMaterial({
      vertexShader: RIPPLE_VERT,
      fragmentShader: RIPPLE_FRAG,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 }, uSwellScale: swellScale },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
      // Bias toward the camera so the rings never dip under the water surface.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -30;
  }

  /** Spawn a ring at a world position. `strength` 0..1, `size` scales the final radius. */
  spawn(x: number, z: number, strength = 1, size = 1): void {
    const i = this.next;
    this.next = (this.next + 1) % RIPPLES.pool;
    this.centers.setXYZ(i, x, z, this.time);
    this.params.setXY(i, strength, RIPPLES.maxRadius * size);
    this.centers.needsUpdate = true;
    this.params.needsUpdate = true;
  }

  update(elapsed: number, cycle: DayCycle): void {
    this.time = elapsed;
    this.material.uniforms.uTime.value = elapsed;
    // Visible by day, properly glowing by night.
    this.material.uniforms.uIntensity.value = 0.5 + 0.85 * cycle.glow;
  }
}

const WAKE_VERT = /* glsl */ `
attribute vec3 aSample;  // x, z, birth time
attribute vec3 aSide;    // perpendicular x, z, side (-1 or 1)
attribute float aStrength;
uniform float uTime;
varying float vAge;
varying float vSide;
varying float vStrength;
varying vec2 vWorld;
${SWELL_GLSL}
void main() {
  float age = clamp((uTime - aSample.z) / ${WAKE.lifetime.toFixed(2)}, 0.0, 1.0);
  vAge = age;
  vSide = aSide.z;
  vStrength = aStrength;
  float width = 0.3 + 2.6 * pow(age, 0.7);
  vec2 xz = aSample.xy + aSide.xy * (aSide.z * width);
  vWorld = xz;
  float h = swell(xz, uTime).x;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, h + 0.015, xz.y, 1.0);
}
`;

const WAKE_FRAG = /* glsl */ `
precision highp float;
varying float vAge;
varying float vSide;
varying float vStrength;
varying vec2 vWorld;
uniform sampler2D tNoise;
uniform float uTime;
uniform float uGlow;
void main() {
  float s = abs(vSide);
  // Two soft edges (the V of the wake) and a faint centre.
  float edges = exp(-pow((s - 0.7) / 0.17, 2.0));
  float centre = (1.0 - s * s) * 0.16;
  float n = texture2D(tNoise, vWorld * 0.19 + uTime * vec2(0.013, -0.009)).b;
  float n2 = texture2D(tNoise, vWorld * 0.53 - uTime * vec2(0.021, 0.006)).a;
  float breakup = smoothstep(0.34, 0.66, n * 0.55 + n2 * 0.45);
  float fade = (1.0 - vAge);
  fade *= fade;
  fade *= smoothstep(0.0, 0.015, vAge) * (1.0 - smoothstep(0.85, 1.0, s));
  float a = (edges + centre) * fade * vStrength * mix(0.25, 1.0, breakup);
  // Pale foam by day, cyan-teal bioluminescence as the light goes.
  vec3 col = mix(vec3(0.85, 0.92, 1.0) * 0.05, vec3(0.12, 0.74, 0.8) * 0.14, uGlow);
  col += vec3(0.3, 1.0, 0.9) * (uGlow * 0.22 * breakup * breakup * (1.0 - vAge));
  gl_FragColor = vec4(col * a, 1.0);
}
`;

/**
 * The boat's wake: a ribbon built from a ring buffer of stern positions. It
 * widens and fades with age and glows at dusk and night.
 */
export class Wake {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly samples: BufferAttribute;
  private readonly sides: BufferAttribute;
  private readonly strengths: BufferAttribute;
  private readonly count = WAKE.samples;

  // Ring buffer of committed samples: x, z, perpX, perpZ, birth, strength.
  private readonly data = new Float32Array(WAKE.samples * 6);
  private head = 0;
  private length = 0;
  private lastX = 0;
  private lastZ = 0;
  private started = false;

  constructor(noise: Texture) {
    const verts = this.count * 2;
    this.samples = new BufferAttribute(new Float32Array(verts * 3), 3);
    this.sides = new BufferAttribute(new Float32Array(verts * 3), 3);
    this.strengths = new BufferAttribute(new Float32Array(verts), 1);
    for (const a of [this.samples, this.sides, this.strengths]) a.setUsage(DynamicDrawUsage);
    const index: number[] = [];
    for (let i = 0; i < this.count - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new BufferGeometry();
    // "position" is unused by the shader but three expects the attribute.
    g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
    g.setAttribute('aSample', this.samples);
    g.setAttribute('aSide', this.sides);
    g.setAttribute('aStrength', this.strengths);
    g.setIndex(index);
    g.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      uniforms: { uTime: { value: 0 }, uGlow: { value: 0 }, tNoise: { value: noise }, uSwellScale: swellScale },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -35;
  }

  private writeVertexPair(slot: number, x: number, z: number, px: number, pz: number, birth: number, strength: number): void {
    const v = slot * 2;
    this.samples.setXYZ(v, x, z, birth);
    this.samples.setXYZ(v + 1, x, z, birth);
    this.sides.setXYZ(v, px, pz, -1);
    this.sides.setXYZ(v + 1, px, pz, 1);
    this.strengths.setX(v, strength);
    this.strengths.setX(v + 1, strength);
  }

  /**
   * @param sternX,sternZ world position of the stern
   * @param heading boat heading (radians)
   * @param speed01 boat speed as a fraction of its maximum
   */
  update(elapsed: number, sternX: number, sternZ: number, heading: number, speed01: number, cycle: DayCycle): void {
    const px = Math.cos(heading);
    const pz = Math.sin(heading);
    const strength = Math.min(1, speed01 * 1.6);

    if (!this.started) {
      this.started = true;
      this.lastX = sternX;
      this.lastZ = sternZ;
    }
    // Commit a sample each time the stern has travelled far enough.
    if (Math.hypot(sternX - this.lastX, sternZ - this.lastZ) >= WAKE.spacing) {
      const o = this.head * 6;
      this.data[o] = sternX;
      this.data[o + 1] = sternZ;
      this.data[o + 2] = px;
      this.data[o + 3] = pz;
      this.data[o + 4] = elapsed;
      this.data[o + 5] = strength;
      this.head = (this.head + 1) % (this.count - 1);
      this.length = Math.min(this.length + 1, this.count - 1);
      this.lastX = sternX;
      this.lastZ = sternZ;
    }

    // Rebuild the strip oldest -> newest, then a live sample pinned to the stern.
    let slot = 0;
    const cap = this.count - 1;
    for (let i = 0; i < this.length; i++) {
      const idx = (this.head - this.length + i + cap * 2) % cap;
      const o = idx * 6;
      if (elapsed - this.data[o + 4] > WAKE.lifetime) continue;
      this.writeVertexPair(slot++, this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3], this.data[o + 4], this.data[o + 5]);
    }
    this.writeVertexPair(slot++, sternX, sternZ, px, pz, elapsed, strength);

    this.samples.needsUpdate = true;
    this.sides.needsUpdate = true;
    this.strengths.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, Math.max(0, slot - 1) * 6);

    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uGlow.value = cycle.glow;
  }
}
