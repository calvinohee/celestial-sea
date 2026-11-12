import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import { FLOATERS } from '../config';
import { REFLECT_LAYER } from '../render/stars';
import { sampleSwell, type SwellSample } from '../render/swell';
import type { DayCycle } from '../time/dayCycle';

const VERT = /* glsl */ `
attribute vec4 aState;  // xyz = position on the water, w = presence (0..1)
attribute float aNear;  // 0 far from the boat .. 1 about to be lit
uniform float uSize;
varying vec2 vUv;
varying float vPresence;
varying float vNearBoat;
void main() {
  vUv = position.xy;
  vPresence = aState.w;
  vNearBoat = aNear;
  if (aState.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 mv = viewMatrix * vec4(aState.xyz, 1.0);
  // Upright billboard whose lower edge sits just under the waterline. Far away
  // it is kept large enough to notice: a glimmer on the water to steer for.
  float size = max(uSize, length(mv.xyz) * 0.011);
  mv.xy += (position.xy + vec2(0.0, 0.62)) * size;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vPresence;
varying float vNearBoat;
uniform vec3 uPaper;
uniform float uEmber;
uniform float uTime;
void main() {
  // A small paper lantern: a soft-cornered tall shape, slightly narrower at the top.
  vec2 q = vec2(vUv.x / (0.36 - 0.05 * vUv.y), (vUv.y + 0.02) / 0.6);
  float d = max(abs(q.x), abs(q.y));
  d = mix(d, length(q), 0.45);
  float body = 1.0 - smoothstep(0.82, 0.98, d);

  // Unlit, but with a faint ember so it can be found in the dark. It warms as the boat nears.
  float glow = uEmber * (0.75 + 0.25 * sin(uTime * 1.1 + vPresence * 3.0)) + vNearBoat * 0.9;
  float core = exp(-dot(vUv - vec2(0.0, -0.18), vUv - vec2(0.0, -0.18)) * 9.0);
  vec3 col = uPaper * body * (0.55 + 0.45 * (vUv.y * 0.5 + 0.5));
  col += vec3(1.0, 0.62, 0.3) * body * core * glow;
  // A little halo once it is glowing properly.
  col += vec3(1.0, 0.58, 0.26) * exp(-dot(vUv, vUv) * 5.0) * glow * 0.5;
  gl_FragColor = vec4(col * vPresence, 1.0);
}
`;

interface Floater {
  active: boolean;
  x: number;
  z: number;
  /** 0..1, fades in on arrival and out on leaving. */
  presence: number;
  leaving: boolean;
  phase: number;
}

export interface BoatState {
  x: number;
  z: number;
  heading: number;
}

/**
 * Unlit paper lanterns adrift on the sea. Glide the boat up to one and it
 * takes its flame from the boat's lantern and rises: releasing lanterns by
 * steering, with no button to press. There are always a few ahead; nothing is
 * scarce and nothing is lost by passing one by.
 */
export class Floaters {
  readonly mesh: Mesh;
  private readonly pool: Floater[] = [];
  private readonly state: InstancedBufferAttribute;
  private readonly near: InstancedBufferAttribute;
  private readonly material: ShaderMaterial;
  private readonly swell: SwellSample = { height: 0, gx: 0, gz: 0 };
  private readonly lit = new Vector3();
  private seeded = false;

  constructor(private readonly rand: () => number = Math.random) {
    for (let i = 0; i < FLOATERS.pool; i++) {
      this.pool.push({ active: false, x: 0, z: 0, presence: 0, leaving: false, phase: this.rand() * 6.28 });
    }
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    this.state = new InstancedBufferAttribute(new Float32Array(FLOATERS.pool * 4), 4);
    this.near = new InstancedBufferAttribute(new Float32Array(FLOATERS.pool), 1);
    this.state.setUsage(DynamicDrawUsage);
    this.near.setUsage(DynamicDrawUsage);
    g.setAttribute('aState', this.state);
    g.setAttribute('aNear', this.near);
    g.instanceCount = FLOATERS.pool;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSize: { value: 0.62 },
        uPaper: { value: new Color() },
        uEmber: { value: 0.2 },
        uTime: { value: 0 },
      },
      // Additive, so the pale paper reads as catching the light rather than as a cut-out.
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    this.mesh.layers.enable(REFLECT_LAYER);
  }

  /** Positions of the lanterns currently afloat (for tests and debugging). */
  get afloat(): { x: number; z: number }[] {
    return this.pool.filter((f) => f.active && !f.leaving).map((f) => ({ x: f.x, z: f.z }));
  }

  private farEnough(x: number, z: number, self: Floater): boolean {
    for (const f of this.pool) {
      if (f === self || !f.active) continue;
      if (Math.hypot(f.x - x, f.z - z) < FLOATERS.spacing) return false;
    }
    return true;
  }

  private place(f: Floater, boat: BoatState, distanceMin: number, distanceMax: number, spread: number): boolean {
    for (let attempt = 0; attempt < 10; attempt++) {
      const bearing = boat.heading + (this.rand() * 2 - 1) * spread;
      const distance = distanceMin + this.rand() * (distanceMax - distanceMin);
      const x = boat.x + Math.sin(bearing) * distance;
      const z = boat.z - Math.cos(bearing) * distance;
      if (!this.farEnough(x, z, f)) continue;
      f.active = true;
      f.leaving = false;
      f.presence = 0;
      f.x = x;
      f.z = z;
      return true;
    }
    return false;
  }

  /**
   * @param canLight false while the release rate limit is running
   * @returns the position of a lantern the boat has just lit, or null
   */
  update(dt: number, elapsed: number, boat: BoatState, cycle: DayCycle, canLight: boolean): Vector3 | null {
    if (!this.seeded) {
      this.seeded = true;
      // The first is close and just off the bow, so the idea is discovered without a word.
      const first = this.pool[0];
      first.active = true;
      first.x = boat.x + Math.sin(boat.heading + 0.1) * 18;
      first.z = boat.z - Math.cos(boat.heading + 0.1) * 18;
      for (let i = 1; i < this.pool.length; i++) this.place(this.pool[i], boat, 24, FLOATERS.spawn[1], 1.35);
    }

    let result: Vector3 | null = null;
    const [spawnMin, spawnMax] = FLOATERS.spawn;

    for (let i = 0; i < this.pool.length; i++) {
      const f = this.pool[i];
      if (!f.active) {
        // Replace it somewhere ahead; if no room this frame, try again next frame.
        this.place(f, boat, spawnMin, spawnMax, 1.15);
        this.state.setW(i, 0);
        continue;
      }

      const dx = boat.x - f.x;
      const dz = boat.z - f.z;
      const distance = Math.hypot(dx, dz);

      if (f.leaving) {
        f.presence -= dt / 1.2;
        if (f.presence <= 0) f.active = false;
      } else {
        f.presence = Math.min(1, f.presence + dt / 2.5);
        if (distance > FLOATERS.despawn) f.leaving = true;

        // Forgiving: a lantern close by drifts the last little way to the boat on its own.
        if (distance < FLOATERS.attract && distance > 0.5) {
          const pull = (1 - distance / FLOATERS.attract) * 1.5 * dt;
          f.x += (dx / distance) * pull;
          f.z += (dz / distance) * pull;
        }
        if (distance < FLOATERS.reach && canLight && !result && f.presence > 0.5) {
          const s = sampleSwell(f.x, f.z, elapsed, this.swell);
          result = this.lit.set(f.x, s.height + 0.35, f.z);
          f.active = false;
          f.presence = 0;
        }
      }

      const s = sampleSwell(f.x, f.z, elapsed, this.swell);
      const bob = Math.sin(elapsed * 0.9 + f.phase) * 0.02;
      this.state.setXYZW(i, f.x, s.height + bob, f.z, Math.max(0, f.presence));
      this.near.setX(i, f.leaving ? 0 : Math.max(0, 1 - distance / FLOATERS.attract));
    }

    this.state.needsUpdate = true;
    this.near.needsUpdate = true;

    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    // Paper takes its colour from the sky; the ember matters more as the light goes.
    (u.uPaper.value as Color).copy(cycle.ambientSky).lerp(cycle.sky[4], 0.25).multiplyScalar(0.5);
    u.uEmber.value = 0.34 + 0.5 * cycle.darkness;
    return result;
  }
}
