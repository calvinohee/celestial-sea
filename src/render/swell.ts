import { WATER } from '../config';

const TAU = Math.PI * 2;

interface Wave {
  dx: number;
  dz: number;
  k: number;
  w: number;
  amp: number;
}

const WAVES: Wave[] = WATER.swell.map((s) => {
  const len = Math.hypot(s.dir[0], s.dir[1]);
  const k = TAU / s.length;
  return { dx: s.dir[0] / len, dz: s.dir[1] / len, k, w: k * s.speed, amp: s.amp };
});

/**
 * Overall swell height, shared by reference with every shader that includes
 * SWELL_GLSL (as `uSwellScale`) and used by the CPU sampler, so the comfort
 * settings scale what is drawn and what the boat rides together.
 */
export const swellScale = { value: 1 };

export interface SwellSample {
  height: number;
  /** dHeight/dx and dHeight/dz. */
  gx: number;
  gz: number;
}

/** CPU twin of the GLSL swell below, so the boat rides exactly what is drawn. */
export function sampleSwell(x: number, z: number, t: number, out: SwellSample): SwellSample {
  let h = 0;
  let gx = 0;
  let gz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const phase = (w.dx * x + w.dz * z) * w.k + t * w.w;
    h += w.amp * Math.sin(phase);
    const c = w.amp * w.k * Math.cos(phase);
    gx += c * w.dx;
    gz += c * w.dz;
  }
  const k = swellScale.value;
  out.height = h * k;
  out.gx = gx * k;
  out.gz = gz * k;
  return out;
}

const n = (v: number) => v.toFixed(6);

/** `vec3 swell(vec2 p, float t)`: x = height, yz = gradient (d/dx, d/dz). */
export const SWELL_GLSL = /* glsl */ `
uniform float uSwellScale;
vec3 swell(vec2 p, float t) {
  vec3 r = vec3(0.0);
  float ph;
  float c;
${WAVES.map(
  (w) => `  ph = dot(vec2(${n(w.dx)}, ${n(w.dz)}), p) * ${n(w.k)} + t * ${n(w.w)};
  c = ${n(w.amp * w.k)} * cos(ph);
  r += vec3(${n(w.amp)} * sin(ph), c * ${n(w.dx)}, c * ${n(w.dz)});`,
).join('\n')}
  return r * uSwellScale;
}
`;
