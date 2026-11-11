import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three';

/** Small deterministic PRNG so the world looks the same every session. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Periodic 1D value noise: `period` lattice cells wrap around. */
export function makePeriodicNoise1D(period: number, rand: () => number): (x: number) => number {
  const v = new Float32Array(period);
  for (let i = 0; i < period; i++) v[i] = rand();
  return (x: number) => {
    const xi = Math.floor(x);
    const f = fade(x - xi);
    const a = v[((xi % period) + period) % period];
    const b = v[(((xi + 1) % period) + period) % period];
    return a + (b - a) * f;
  };
}

/** Periodic 2D value noise on a `period` x `period` lattice, returned as a sampler over [0, period). */
function makePeriodicNoise2D(period: number, rand: () => number): (x: number, y: number) => number {
  const v = new Float32Array(period * period);
  for (let i = 0; i < v.length; i++) v[i] = rand();
  const at = (x: number, y: number) => v[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

function tileableFbm(size: number, basePeriod: number, octaves: number, rand: () => number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const n = makePeriodicNoise2D(period, rand);
    const s = period / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) out[y * size + x] += amp * n(x * s, y * s);
    }
    total += amp;
    amp *= 0.5;
    period *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * One shared tiling texture used instead of in-shader noise (much cheaper on
 * phones). RG = ripple normal (xy, 0.5-centred), B and A = two cloud fbm fields.
 */
export function createNoiseTexture(size = 256): DataTexture {
  const rand = mulberry32(7719);
  const height = tileableFbm(size, 6, 5, rand);
  const cloudA = tileableFbm(size, 3, 5, rand);
  const cloudB = tileableFbm(size, 5, 4, rand);
  const data = new Uint8Array(size * size * 4);
  const h = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  const strength = size * 0.085;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round((dx * 0.5 + 0.5) * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((dy * 0.5 + 0.5) * 255)));
      data[i + 2] = Math.round(cloudA[y * size + x] * 255);
      data[i + 3] = Math.round(cloudB[y * size + x] * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
