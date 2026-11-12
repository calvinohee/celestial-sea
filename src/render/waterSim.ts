import {
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { WATER_SIM } from '../config';
import { createColorTarget, FSQ_VERT, FullScreenQuad } from '../util/fullscreen';

const MAX_IMPULSES = 8;

// One step of the 2D wave equation on a height field.
// R = height now, G = height one step ago.
const STEP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tState;
uniform vec2 uTexel;
uniform vec2 uShift;
uniform float uSpeed2;
uniform float uDamping;
uniform vec4 uImpulse[${MAX_IMPULSES}];  // xy = centre (uv), z = radius (uv), w = strength (metres)

void main() {
  // The field follows the boat in whole texels; read where this patch of water was before.
  vec2 uv = vUv + uShift;
  vec2 state = texture2D(tState, uv).rg;
  float h = state.r;
  float previous = state.g;
  float around =
    texture2D(tState, uv + vec2(uTexel.x, 0.0)).r + texture2D(tState, uv - vec2(uTexel.x, 0.0)).r +
    texture2D(tState, uv + vec2(0.0, uTexel.y)).r + texture2D(tState, uv - vec2(0.0, uTexel.y)).r;

  // Verlet step: carry on moving, pulled toward the neighbours' average, losing a little energy.
  float next = h + (h - previous) * uDamping + uSpeed2 * (around - 4.0 * h);
  next *= 0.9992;

  for (int i = 0; i < ${MAX_IMPULSES}; i++) {
    vec2 d = (vUv - uImpulse[i].xy) / max(uImpulse[i].z, 1e-5);
    next += uImpulse[i].w * exp(-dot(d, d));
  }

  // Water newly scrolled in is flat; waves reaching the border are absorbed, not reflected.
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float edge = smoothstep(0.0, 0.07, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  gl_FragColor = vec4(next * inside * edge, h * inside * edge, 0.0, 1.0);
}
`;

/** Uniforms the water shader needs to read the simulation. Shared by reference. */
export interface WaterSimUniforms {
  [name: string]: IUniform;
  tSim: IUniform;
  /** x, z of the field's centre and its width in metres. */
  uSim: IUniform;
  /** One texel in uv, and one cell in metres. */
  uSimCell: IUniform;
}

/**
 * Interactive water: a small height-field wave simulation centred on the boat.
 *
 * Anything that disturbs the surface (a touch, the hull pushing through, a
 * lantern lifting off) adds an impulse; the waves then spread, cross and fade
 * on their own. A hull moving faster than the waves leaves a V-shaped wake for
 * free. The water shader reads the field for its normals and for the
 * bioluminescent glow of agitated water.
 *
 * Runs at a fixed 60 steps per second so wave speed never depends on frame rate.
 */
export class WaterSim {
  readonly uniforms: WaterSimUniforms;

  private size: number = WATER_SIM.size;
  private a: WebGLRenderTarget;
  private b: WebGLRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly impulses: Vector3[] = [];
  private readonly impulseUniform: Vector4[] = [];
  private pending = 0;
  private accumulator = 0;
  private centerX = 0;
  private centerZ = 0;
  private started = false;

  constructor() {
    this.a = createColorTarget(this.size, this.size);
    this.b = createColorTarget(this.size, this.size);
    for (let i = 0; i < MAX_IMPULSES; i++) {
      this.impulses.push(new Vector3());
      this.impulseUniform.push(new Vector4(0, 0, 1, 0));
    }
    this.material = new ShaderMaterial({
      vertexShader: FSQ_VERT,
      fragmentShader: STEP_FRAG,
      uniforms: {
        tState: { value: null },
        uTexel: { value: new Vector2() },
        uShift: { value: new Vector2() },
        uSpeed2: { value: 0 },
        uDamping: { value: WATER_SIM.damping },
        uImpulse: { value: this.impulseUniform },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.uniforms = {
      tSim: { value: this.a.texture },
      uSim: { value: new Vector3(0, 0, WATER_SIM.worldSize) },
      uSimCell: { value: new Vector2(1 / this.size, WATER_SIM.worldSize / this.size) },
    };
    this.applySize();
  }

  /** Grid resolution (a quality-tier choice). Changing it calms the water. */
  setSize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    this.a.setSize(size, size);
    this.b.setSize(size, size);
    this.started = false;
    this.applySize();
  }

  private applySize(): void {
    const cell = WATER_SIM.worldSize / this.size;
    this.material.uniforms.uTexel.value.set(1 / this.size, 1 / this.size);
    // Courant number squared: (wave speed * dt / cell)^2. Small, so always stable.
    const c = (WATER_SIM.waveSpeed / WATER_SIM.stepsPerSecond / cell) ** 2;
    this.material.uniforms.uSpeed2.value = Math.min(0.45, c);
    this.uniforms.uSimCell.value.set(1 / this.size, cell);
  }

  /**
   * Disturb the surface at a world position.
   * @param radius metres
   * @param strength metres of displacement at the centre (negative pulls down)
   */
  addImpulse(x: number, z: number, radius: number, strength: number): void {
    if (this.pending >= MAX_IMPULSES) return;
    this.impulses[this.pending++].set(x, z, radius);
    this.impulseUniform[this.pending - 1].w = strength;
  }

  /** Advance the simulation, keeping the field centred near (x, z). */
  update(renderer: WebGLRenderer, dt: number, x: number, z: number): void {
    const cell = WATER_SIM.worldSize / this.size;
    const world = WATER_SIM.worldSize;
    this.accumulator = Math.min(this.accumulator + dt * WATER_SIM.stepsPerSecond, 3);
    const steps = Math.floor(this.accumulator);
    this.accumulator -= steps;
    if (steps === 0) return;

    const previousTarget = renderer.getRenderTarget();
    for (let s = 0; s < steps; s++) {
      // Re-centre in whole cells so the stored waves stay exactly where they are in the world.
      const cx = Math.round(x / cell) * cell;
      const cz = Math.round(z / cell) * cell;
      const u = this.material.uniforms;
      if (!this.started) {
        this.started = true;
        // A shift of more than the whole field reads as "all new, flat water".
        u.uShift.value.set(4, 4);
      } else {
        u.uShift.value.set((cx - this.centerX) / world, (cz - this.centerZ) / world);
      }
      this.centerX = cx;
      this.centerZ = cz;

      // Impulses land on the first step of the frame only.
      for (let i = 0; i < MAX_IMPULSES; i++) {
        const target = this.impulseUniform[i];
        if (s === 0 && i < this.pending) {
          const p = this.impulses[i];
          target.x = (p.x - cx) / world + 0.5;
          target.y = (p.y - cz) / world + 0.5;
          target.z = p.z / world;
        } else {
          target.w = 0;
        }
      }
      this.pending = 0;

      u.tState.value = this.a.texture;
      renderer.setRenderTarget(this.b);
      this.quad.render(renderer);
      const t = this.a;
      this.a = this.b;
      this.b = t;
    }
    renderer.setRenderTarget(previousTarget);

    this.uniforms.tSim.value = this.a.texture;
    this.uniforms.uSim.value.set(this.centerX, this.centerZ, world);
  }
}
