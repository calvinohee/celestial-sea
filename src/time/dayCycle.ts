import { Color, Vector3 } from 'three';
import { LOOP_SECONDS, PHASES, SKY, type PhaseConfig, type PhaseName } from '../config';

/** Colours of one phase, converted once to linear working space. */
interface PhaseColors {
  sky: Color[];
  ridgeNear: Color;
  ridgeFar: Color;
  sun: Color;
}

const PHASE_COLORS: PhaseColors[] = PHASES.map((p) => ({
  sky: p.sky.map((hex) => new Color(hex)),
  ridgeNear: new Color(p.ridges[0]),
  ridgeFar: new Color(p.ridges[1]),
  sun: new Color(p.sun),
}));

const PHASE_START: number[] = [];
{
  let t = 0;
  for (const p of PHASES) {
    PHASE_START.push(t);
    t += p.duration;
  }
}

export function smoothstep01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

export interface PhaseBlend {
  /** Index of the phase the clock is in. */
  index: number;
  /** Index of the phase being blended toward. */
  next: number;
  /** 0 = pure `index` palette, 1 = pure `next` palette. */
  mix: number;
  /** 0..1 progress through the current phase. */
  progress: number;
}

/** Which phases are blending, and by how much, at loop time `time` (seconds). */
export function phaseBlendAt(time: number, out: PhaseBlend): PhaseBlend {
  const t = ((time % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
  let index = PHASES.length - 1;
  for (let i = 0; i < PHASES.length; i++) {
    if (t < PHASE_START[i] + PHASES[i].duration) {
      index = i;
      break;
    }
  }
  const phase = PHASES[index];
  const progress = (t - PHASE_START[index]) / phase.duration;
  out.index = index;
  out.next = (index + 1) % PHASES.length;
  out.progress = progress;
  out.mix = progress <= phase.hold ? 0 : smoothstep01((progress - phase.hold) / (1 - phase.hold));
  return out;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The fixed 20-minute day loop. Owns the clock and the blended palette; every
 * renderer module reads colours from here so sky, water and fog always agree.
 */
export class DayCycle {
  /** Seconds into the loop. Every session starts at 0 = golden hour. */
  time = 0;
  /** Clock multiplier (debug fast-forward). */
  timeScale = 1;

  readonly blend: PhaseBlend = { index: 0, next: 1, mix: 0, progress: 0 };

  /** Sky stops, zenith -> horizon (linear). */
  readonly sky: Color[] = [new Color(), new Color(), new Color(), new Color(), new Color(), new Color()];
  readonly ridgeNear = new Color();
  readonly ridgeFar = new Color();
  /** HDR sun colour (linear), already scaled for the disc. */
  readonly sunColor = new Color();
  /** Dark body colour of the water when looking down into it. */
  readonly waterDeep = new Color();
  /** Flat horizon colour away from the sun, for CPU-side fog on standard materials. */
  readonly fogColor = new Color();
  /** Sky light and bounce light for lit objects such as the boat. */
  readonly ambientSky = new Color();
  readonly ambientGround = new Color();
  readonly sunDir = new Vector3();

  sunElevation = 0;
  sunDisc = 0;
  sunGlow = 0;
  stars = 0;
  glow = 0;
  exposure = 1;
  /** 0 in full daylight, 1 at night. Handy for lights and ambience. */
  darkness = 0;

  private readonly tmp = new Color();

  constructor() {
    this.update(0);
  }

  get phase(): PhaseConfig {
    return PHASES[this.blend.index];
  }

  get phaseName(): PhaseName {
    return PHASES[this.blend.index].name;
  }

  /** Jump the clock (debug / tests). */
  setTime(seconds: number): void {
    this.time = ((seconds % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
    this.update(0);
  }

  update(dt: number): void {
    this.time = (this.time + dt * this.timeScale) % LOOP_SECONDS;
    const b = phaseBlendAt(this.time, this.blend);
    const pa = PHASES[b.index];
    const pb = PHASES[b.next];
    const ca = PHASE_COLORS[b.index];
    const cb = PHASE_COLORS[b.next];
    const m = b.mix;

    for (let i = 0; i < 6; i++) this.sky[i].lerpColors(ca.sky[i], cb.sky[i], m);
    this.ridgeNear.lerpColors(ca.ridgeNear, cb.ridgeNear, m);
    this.ridgeFar.lerpColors(ca.ridgeFar, cb.ridgeFar, m);

    this.sunElevation = lerp(pa.sunElevation, pb.sunElevation, m);
    this.sunDisc = lerp(pa.sunDisc, pb.sunDisc, m);
    this.sunGlow = lerp(pa.sunGlow, pb.sunGlow, m);
    this.stars = lerp(pa.stars, pb.stars, m);
    this.glow = lerp(pa.glow, pb.glow, m);
    this.exposure = lerp(pa.exposure, pb.exposure, m);
    this.darkness = Math.min(1, this.stars * 1.15);

    this.sunColor.lerpColors(ca.sun, cb.sun, m).multiplyScalar(SKY.sunIntensity);

    const el = (this.sunElevation * Math.PI) / 180;
    const az = SKY.sunAzimuth;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

    // Water body: a deep, slightly teal shade of the upper sky.
    this.waterDeep.lerpColors(this.sky[0], this.sky[1], 0.55).multiplyScalar(0.42);
    this.tmp.setRGB(0.012, 0.05, 0.065);
    this.waterDeep.lerp(this.tmp, 0.35);

    // Away from the sun the horizon is cooler: lower-sky colour with a touch of near-horizon.
    this.fogColor.lerpColors(this.sky[3], this.sky[4], 0.35);

    this.ambientSky.lerpColors(this.sky[1], this.sky[3], 0.45);
    this.ambientGround.copy(this.waterDeep).lerp(this.sky[4], 0.25);
  }
}
