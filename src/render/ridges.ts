import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  ClampToEdgeWrapping,
  DoubleSide,
  type PerspectiveCamera,
} from 'three';
import { RIDGES, SKY } from '../config';
import { makePeriodicNoise1D, mulberry32 } from '../util/noise';
import { SKY_GLSL, type SkyUniforms } from './sky';

const TAU = Math.PI * 2;

/** Azimuth (atan2(z, x)) of the sun, matching DayCycle.sunDir. */
const SUN_THETA = Math.atan2(-Math.cos(SKY.sunAzimuth), Math.sin(SKY.sunAzimuth));

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

/** Builds tan(elevation) as a function of azimuth for one ridge layer. */
function makeRidgeline(layerIndex: number): (theta: number) => number {
  const layer = RIDGES.layers[layerIndex];
  const rand = mulberry32(layer.seed);
  const base = 7 + layerIndex * 2;
  const octaves = [
    { n: makePeriodicNoise1D(base, rand), f: base, a: 1.0 },
    { n: makePeriodicNoise1D(base * 2, rand), f: base * 2, a: 0.52 },
    { n: makePeriodicNoise1D(base * 4, rand), f: base * 4, a: 0.27 },
    { n: makePeriodicNoise1D(base * 8, rand), f: base * 8, a: 0.13 },
    { n: makePeriodicNoise1D(base * 16, rand), f: base * 16, a: 0.06 },
  ];
  const total = octaves.reduce((s, o) => s + o.a, 0);
  const envelope = makePeriodicNoise1D(5, rand);
  const envPhase = rand();

  return (theta: number) => {
    const u = (theta + Math.PI) / TAU;
    let h = 0;
    for (let i = 0; i < octaves.length; i++) {
      const o = octaves[i];
      const v = o.n(u * o.f);
      // The two lowest octaves are "ridged" for peaked silhouettes.
      h += o.a * (i < 2 ? 1 - Math.abs(v * 2 - 1) : v);
    }
    h /= total;
    h = Math.pow(Math.min(1, Math.max(0, (h - 0.28) / 0.6)), 1.25);
    // Long stretches rise and fall so the horizon is not a uniform wall.
    const env = 0.35 + 0.65 * envelope((u + envPhase) * 5);
    // Dip in front of the sun so the disc sinks *partly* behind the ridges.
    const d = angleDiff(theta, SUN_THETA);
    const sunDip = 1 - 0.62 * Math.exp(-(d * d) / (2 * 0.2 * 0.2));
    return layer.minTan * (0.4 + 0.6 * env) + (layer.maxTan - layer.minTan) * h * env * sunDip;
  };
}

const VERT = /* glsl */ `
attribute float aV;
varying float vV;
varying vec3 vWorld;
void main() {
  vV = aV;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying float vV;
varying vec3 vWorld;
uniform float uLayer;
uniform float uHaze;
${SKY_GLSL}
void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 horizon = skyHorizon(dir);
  float tanEl = max(dir.y, 0.0) / max(length(dir.xz), 1e-4);
  // Haze pools at the foot of each ridge.
  float haze = clamp(uHaze + 0.22 * exp(-tanEl / 0.01), 0.0, 1.0);
  vec3 col = ridgeLayerColor(uLayer, haze, horizon);
  // Analytic anti-aliasing of the silhouette edge.
  float edge = fwidth(vV) * 1.5;
  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0, vV);
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * Layered mountain silhouettes on the horizon. They are effectively at
 * infinity: the group follows the camera and draws right after the sky and
 * stars, before the water.
 */
export class Ridges {
  readonly group = new Group();
  /**
   * 1D texture of tan(elevation) per azimuth, one channel per layer. The water
   * shader uses it to reflect the silhouettes without rendering them twice.
   */
  readonly profile: DataTexture;

  constructor(skyUniforms: SkyUniforms) {
    const layerCount = RIDGES.layers.length;
    const lines = RIDGES.layers.map((_, i) => makeRidgeline(i));

    // Draw far to near so nearer, darker layers overlap farther, hazier ones.
    for (let i = layerCount - 1; i >= 0; i--) {
      const layer = RIDGES.layers[i];
      const n = RIDGES.segments;
      const positions = new Float32Array((n + 1) * 2 * 3);
      const vs = new Float32Array((n + 1) * 2);
      const index: number[] = [];
      for (let s = 0; s <= n; s++) {
        const theta = (s / n) * TAU - Math.PI;
        const x = Math.cos(theta) * layer.radius;
        const z = Math.sin(theta) * layer.radius;
        const top = lines[i](theta) * layer.radius;
        positions.set([x, -layer.radius * 0.012, z], s * 6);
        positions.set([x, top, z], s * 6 + 3);
        vs[s * 2] = 0;
        vs[s * 2 + 1] = 1;
        if (s < n) {
          const a = s * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('aV', new BufferAttribute(vs, 1));
      geometry.setIndex(index);
      const material = new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          ...skyUniforms,
          uLayer: { value: layerCount > 1 ? i / (layerCount - 1) : 0 },
          uHaze: { value: layer.haze },
        },
        // Depth-tested (the boat and lanterns sit in front) but never written.
        depthWrite: false,
        transparent: true,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -80 + (layerCount - 1 - i);
      this.group.add(mesh);
    }

    const width = 1024;
    const data = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) {
      const theta = ((x + 0.5) / width) * TAU - Math.PI;
      for (let i = 0; i < 4; i++) {
        const tan = i < layerCount ? lines[i](theta) : 0;
        data[x * 4 + i] = Math.max(0, Math.min(255, Math.round((tan / RIDGES.profileMaxTan) * 255)));
      }
    }
    this.profile = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
    this.profile.wrapS = RepeatWrapping;
    this.profile.wrapT = ClampToEdgeWrapping;
    this.profile.magFilter = LinearFilter;
    this.profile.minFilter = LinearFilter;
    this.profile.colorSpace = NoColorSpace;
    this.profile.needsUpdate = true;
  }

  update(camera: PerspectiveCamera): void {
    this.group.position.set(camera.position.x, 0, camera.position.z);
  }
}
