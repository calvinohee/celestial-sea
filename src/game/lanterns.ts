import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
  type Quaternion,
} from 'three';
import { LANTERNS } from '../config';
import { REFLECT_LAYER } from '../render/stars';
import type { Reservation } from './constellations';

/** Distance at which a lantern is "in the sky": far enough to be a point of light. */
const SKY_DISTANCE = 900;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute float aIntensity;
uniform float uSize;
uniform float uMinAngle;
varying vec2 vUv;
varying float vNear;
varying float vIntensity;
void main() {
  vUv = position.xy;
  vIntensity = aIntensity;
  if (aIntensity <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float dist = length(mv.xyz);
  // Never smaller on screen than a bright star, however far it has risen.
  float minSize = dist * uMinAngle;
  vNear = clamp((uSize / minSize - 1.0) / 3.0, 0.0, 1.0);
  mv.xy += position.xy * max(uSize, minSize);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vNear;
varying float vIntensity;
void main() {
  float r2 = dot(vUv, vUv);
  float halo = exp(-r2 * 7.0) * 0.3 + exp(-r2 * 34.0) * mix(1.5, 0.3, vNear);
  // Up close it is a small paper lantern: a tall soft shape, brighter toward the flame.
  vec2 q = vec2(vUv.x / 0.15, (vUv.y + 0.01) / 0.23);
  float body = 1.0 - smoothstep(0.72, 1.0, length(q));
  float flame = exp(-dot(vUv - vec2(0.0, -0.09), vUv - vec2(0.0, -0.09)) * 150.0);
  vec3 col = vec3(1.0, 0.6, 0.28) * halo;
  col += (vec3(1.0, 0.6, 0.28) * 0.55 * body + vec3(1.0, 0.85, 0.6) * 0.7 * flame) * vNear;
  col *= 1.0 - smoothstep(0.75, 1.0, r2);
  gl_FragColor = vec4(col * vIntensity, 1.0);
}
`;

interface Lantern {
  active: boolean;
  reservation: Reservation | null;
  readonly start: Vector3;
  /** Velocity inherited from the boat (m/s), which it gradually sheds. */
  vx: number;
  vz: number;
  t0: number;
  duration: number;
  phaseA: number;
  phaseB: number;
  settled: boolean;
}

/**
 * Lanterns released from the boat. Each rises and sways on its own for a
 * while, is then drawn up toward its reserved place in the sky, and on arrival
 * hands over to a star. A fixed pool drawn as one instanced mesh.
 */
export class Lanterns {
  readonly mesh: Mesh;
  private readonly pool: Lantern[] = [];
  private readonly positions: InstancedBufferAttribute;
  private readonly intensities: InstancedBufferAttribute;
  private lastSettleTime = -Infinity;

  private readonly free = new Vector3();
  private readonly target = new Vector3();
  private readonly dir = new Vector3();
  private readonly out = new Vector3();

  constructor(private readonly rand: () => number = Math.random) {
    for (let i = 0; i < LANTERNS.pool; i++) {
      this.pool.push({
        active: false,
        reservation: null,
        start: new Vector3(),
        vx: 0,
        vz: 0,
        t0: 0,
        duration: 8,
        phaseA: 0,
        phaseB: 0,
        settled: false,
      });
    }

    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    this.positions = new InstancedBufferAttribute(new Float32Array(LANTERNS.pool * 3), 3);
    this.intensities = new InstancedBufferAttribute(new Float32Array(LANTERNS.pool), 1);
    this.positions.setUsage(DynamicDrawUsage);
    this.intensities.setUsage(DynamicDrawUsage);
    g.setAttribute('aPos', this.positions);
    g.setAttribute('aIntensity', this.intensities);
    g.instanceCount = LANTERNS.pool;

    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uSize: { value: 0.95 }, uMinAngle: { value: 0.011 } },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    this.mesh.layers.enable(REFLECT_LAYER);
  }

  /** True while the pool has a lantern to give. */
  get hasFree(): boolean {
    return this.pool.some((l) => !l.active);
  }

  /** Lanterns currently rising or dissolving. */
  get activeCount(): number {
    let n = 0;
    for (const l of this.pool) if (l.active) n++;
    return n;
  }

  /**
   * Release a lantern from `from` (world position) toward a reserved place in
   * the sky. `vx`/`vz` is the boat's velocity, so a lantern let go under way
   * drifts on with the boat for a while instead of being left behind.
   * Returns false only if the pool is somehow exhausted.
   */
  release(from: Vector3, elapsed: number, reservation: Reservation, vx = 0, vz = 0): boolean {
    const lantern = this.pool.find((l) => !l.active);
    if (!lantern) return false;
    const [min, max] = LANTERNS.rise;
    let duration = min + this.rand() * (max - min);
    // Stars must appear in the order their lanterns left, so the links make sense.
    const settleAt = Math.max(elapsed + duration, this.lastSettleTime + 0.7);
    duration = settleAt - elapsed;
    this.lastSettleTime = settleAt;

    lantern.active = true;
    lantern.reservation = reservation;
    lantern.start.copy(from);
    lantern.vx = vx;
    lantern.vz = vz;
    lantern.t0 = elapsed;
    lantern.duration = duration;
    lantern.phaseA = this.rand() * Math.PI * 2;
    lantern.phaseB = this.rand() * Math.PI * 2;
    lantern.settled = false;
    return true;
  }

  /**
   * @param skyRotation star frame -> world
   * @param onSettle called once per lantern, at the moment it becomes a star
   */
  update(
    elapsed: number,
    camera: PerspectiveCamera,
    skyRotation: Quaternion,
    brightness: number,
    onSettle: (reservation: Reservation) => void,
  ): void {
    let any = false;
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      if (!l.active || !l.reservation) {
        if (this.intensities.getX(i) !== 0) {
          this.intensities.setX(i, 0);
          any = true;
        }
        continue;
      }
      any = true;
      const age = elapsed - l.t0;
      const u = Math.min(1, age / l.duration);

      // Free flight: a slow rise with a lazy sway that grows as it climbs.
      const rise = u * u * (3 - 2 * u);
      const sway = 0.12 + 1.1 * u;
      const carried = LANTERNS.drift * (1 - Math.exp(-age / LANTERNS.drift));
      this.free.set(
        l.start.x + l.vx * carried + Math.sin(age * 0.83 + l.phaseA) * sway,
        l.start.y + 0.2 + LANTERNS.climb * Math.pow(rise, 0.85),
        l.start.z + l.vz * carried + Math.cos(age * 0.61 + l.phaseB) * sway,
      );

      // Drawn into the sky: seen from the camera, its direction eases toward
      // the reserved star while its distance grows geometrically, so the
      // motion across the screen stays gentle the whole way up.
      const w0 = Math.min(1, Math.max(0, (u - 0.22) / 0.78));
      const w = w0 * w0 * (3 - 2 * w0);
      this.target.copy(l.reservation.dir).applyQuaternion(skyRotation);
      this.dir.copy(this.free).sub(camera.position);
      const d0 = Math.max(1, this.dir.length());
      this.dir.multiplyScalar(1 / d0).lerp(this.target, w).normalize();
      const dist = d0 * Math.pow(SKY_DISTANCE / d0, w);
      this.out.copy(camera.position).addScaledVector(this.dir, dist);
      this.positions.setXYZ(i, this.out.x, this.out.y, this.out.z);

      let intensity = Math.min(1, age / 0.5) * brightness;
      if (u >= 1) {
        if (!l.settled) {
          l.settled = true;
          onSettle(l.reservation);
        }
        // Dissolve as the star takes over.
        const fade = 1 - (age - l.duration) / LANTERNS.fade;
        intensity *= Math.max(0, fade);
        if (fade <= 0) {
          l.active = false;
          l.reservation = null;
          intensity = 0;
        }
      }
      this.intensities.setX(i, intensity);
    }
    if (any) {
      this.positions.needsUpdate = true;
      this.intensities.needsUpdate = true;
    }
  }
}
