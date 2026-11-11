// All tunables live here: cycle timings, palettes, world and feel constants.

export type PhaseName = 'golden' | 'dusk' | 'blue' | 'night' | 'predawn';

export interface PhaseConfig {
  name: PhaseName;
  /** Phase length in seconds. */
  duration: number;
  /**
   * Fraction of the phase spent holding its own palette before it starts
   * blending (smoothstep) into the next phase.
   */
  hold: number;
  /** Sky stops, zenith -> horizon (sRGB hex). */
  sky: [string, string, string, string, string, string];
  /** Ridge silhouettes, nearest -> farthest (sRGB hex). */
  ridges: [string, string];
  /** Sun disc / glow colour (sRGB hex). */
  sun: string;
  /** Sun elevation in degrees (negative = below the horizon). */
  sunElevation: number;
  /** 0..1 brightness of the sun disc. */
  sunDisc: number;
  /** 0..1 strength of the wide glow around the sun. */
  sunGlow: number;
  /** 0..1 visibility of stars, Milky Way and nebulae. */
  stars: number;
  /** 0..1 strength of bioluminescence (wake glow, ripple brightness). */
  glow: number;
  /** Overall exposure multiplier applied before tone mapping. */
  exposure: number;
}

const MIN = 60;

export const PHASES: PhaseConfig[] = [
  {
    name: 'golden',
    duration: 3 * MIN,
    hold: 0.4,
    sky: ['#8F97AA', '#B9B4B4', '#E6D6BC', '#F3C38C', '#EE8E4A', '#E2553A'],
    ridges: ['#4A5266', '#7D8498'],
    sun: '#FFD9A6',
    sunElevation: 3.4,
    sunDisc: 1.0,
    sunGlow: 0.85,
    stars: 0,
    glow: 0.12,
    exposure: 1.0,
  },
  {
    name: 'dusk',
    duration: 6 * MIN,
    hold: 0.55,
    sky: ['#0B1030', '#1E3A6E', '#7A5C9E', '#E86A92', '#F5A15A', '#E8533A'],
    ridges: ['#3A4560', '#6B7590'],
    sun: '#FF9A62',
    sunElevation: 1.1,
    sunDisc: 0.95,
    sunGlow: 1.0,
    stars: 0.06,
    glow: 0.45,
    exposure: 1.05,
  },
  {
    name: 'blue',
    duration: 3 * MIN,
    hold: 0.3,
    sky: ['#0A1238', '#1F3A72', '#4E5F9C', '#9C78A6', '#D38E86', '#C9645A'],
    ridges: ['#222A44', '#46507A'],
    sun: '#E8806A',
    sunElevation: -3.5,
    sunDisc: 0.0,
    sunGlow: 0.5,
    stars: 0.45,
    glow: 0.8,
    exposure: 1.0,
  },
  {
    name: 'night',
    duration: 6 * MIN,
    hold: 0.6,
    sky: ['#03050C', '#070D22', '#0B1634', '#122046', '#1A2A55', '#22305E'],
    ridges: ['#05070F', '#0E1428'],
    sun: '#3A4A80',
    sunElevation: -18,
    sunDisc: 0.0,
    sunGlow: 0.0,
    stars: 1.0,
    glow: 1.0,
    exposure: 1.0,
  },
  {
    name: 'predawn',
    duration: 2 * MIN,
    hold: 0.3,
    sky: ['#070C24', '#14285A', '#2C5470', '#5E8A92', '#C9A3A6', '#E4A88E'],
    ridges: ['#1C2238', '#3E4A66'],
    sun: '#F2C0A4',
    sunElevation: -2.5,
    sunDisc: 0.0,
    sunGlow: 0.45,
    stars: 0.35,
    glow: 0.6,
    exposure: 1.0,
  },
];

/** Full loop length in seconds (20 minutes). */
export const LOOP_SECONDS = PHASES.reduce((s, p) => s + p.duration, 0);

/** Debug fast-forward multiplier (toggle with `T`). */
export const DEBUG_TIME_SCALE = 20;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

export const SKY = {
  /**
   * Heights (sin of elevation) of the six stops, horizon -> zenith. The hot
   * colours are squeezed into a narrow band; the cool ones spread wide.
   */
  stops: [0.0, 0.036, 0.1, 0.21, 0.38, 0.7],
  /** Sun azimuth, radians, measured from -Z (the boat's starting heading). */
  sunAzimuth: 0.16,
  /** Angular radius of the sun disc in degrees (stylised, larger than real). */
  sunRadius: 1.3,
  /** HDR multiplier on the sun disc so it blooms. */
  sunIntensity: 3.2,
  /** Degrees per second the star field turns about the pole. */
  rotationSpeed: 0.12,
  starCount: 6000,
  starCountLow: 3000,
  /** Seconds between shooting stars at night (min, max). */
  shootingStarInterval: [40, 90] as [number, number],
};

// ---------------------------------------------------------------------------
// Ridges
// ---------------------------------------------------------------------------

export const RIDGES = {
  /** Layers, nearest first. Heights are tangents of the elevation angle. */
  layers: [
    { radius: 2600, minTan: 0.006, maxTan: 0.034, seed: 11, haze: 0.03 },
    { radius: 3400, minTan: 0.014, maxTan: 0.052, seed: 23, haze: 0.13 },
    { radius: 4400, minTan: 0.022, maxTan: 0.074, seed: 37, haze: 0.26 },
    { radius: 5600, minTan: 0.03, maxTan: 0.098, seed: 53, haze: 0.4 },
  ],
  segments: 720,
  /** Largest encodable tan(elevation) in the ridge profile texture. */
  profileMaxTan: 0.125,
};

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export interface SwellWave {
  /** Direction (unit-ish xz), wavelength m, amplitude m, speed m/s. */
  dir: [number, number];
  length: number;
  amp: number;
  speed: number;
}

export const WATER = {
  radius: 7000,
  rings: 84,
  spokes: 112,
  /** Slow, low swell. The same waves drive the shader and the boat's bobbing. */
  swell: [
    { dir: [0.92, 0.39], length: 41, amp: 0.105, speed: 1.9 },
    { dir: [-0.45, 0.89], length: 27, amp: 0.07, speed: 1.5 },
    { dir: [0.31, -0.95], length: 13.5, amp: 0.038, speed: 1.15 },
    { dir: [-0.83, -0.56], length: 7.3, amp: 0.016, speed: 0.9 },
  ] as SwellWave[],
  /** Swell fades out between these distances from the camera. */
  swellFade: [180, 700] as [number, number],
  /** Distance scale of the horizon haze, metres. */
  fogDistance: 430,
  rippleStrength: 0.085,
};

// ---------------------------------------------------------------------------
// Boat, camera, input
// ---------------------------------------------------------------------------

export const BOAT = {
  maxSpeed: 3.4,
  acceleration: 0.85,
  drag: 0.42,
  /** rad/s at full speed. */
  maxTurnRate: 0.42,
  /** rad/s^2: how quickly the turn rate itself may change. */
  turnAcceleration: 0.55,
  /** Boat eases off inside this distance from the steering target. */
  arriveRadius: 14,
  lanternHeight: 1.36,
};

export const CAMERA = {
  /** Vertical FOV in landscape and in tall portrait. */
  fovLandscape: 50,
  fovPortrait: 74,
  distance: 12,
  height: 2.0,
  /** Sideways offset so the boat sits slightly off-centre. */
  side: 1.1,
  /** Fraction of the screen height (from the bottom) where the horizon sits. */
  horizon: 1 / 3,
  /** Spring stiffness of the follow (higher = tighter). */
  followStiffness: 1.6,
  headingStiffness: 0.9,
  near: 0.3,
  far: 16000,
};

export const INPUT = {
  /** Press shorter than this (ms) and nearly still = a tap. */
  tapMaxMs: 260,
  tapMaxMovePx: 12,
  /** Touches farther than this from the camera are pulled in to it, metres. */
  targetMax: 180,
};

export const RIPPLES = {
  pool: 28,
  lifetime: 3.0,
  maxRadius: 4.2,
};

export const WAKE = {
  samples: 140,
  /** Seconds a wake sample lives. */
  lifetime: 9,
  /** Metres between samples. */
  spacing: 0.45,
};

/** Minimum seconds between lantern releases. */
export const LANTERN_COOLDOWN = 1.5;

export const LANTERNS = {
  pool: 10,
  /** Seconds from release to settling as a star (min, max). */
  rise: [7.5, 9] as [number, number],
  /** Metres a lantern climbs on its own while it is being drawn into the sky. */
  climb: 7,
  /** Seconds over which a lantern loses the boat's speed it was released with. */
  drift: 6,
  /** Seconds the lantern takes to dissolve once its star has appeared. */
  fade: 0.8,
};

export const CONSTELLATIONS = {
  /** A constellation completes after this many stars (min, max inclusive). */
  minStars: 5,
  maxStars: 7,
  /** Most constellations kept; beyond this the oldest fades out. */
  max: 30,
  /** Angular distance between linked stars, degrees (min, max). */
  step: [5.5, 10] as [number, number],
  /** Seconds a removed constellation takes to fade away. */
  fadeOut: 4,
  /** Brightness of player stars and links in full daylight (1 at night). */
  dayBrightness: 0.55,
};

// ---------------------------------------------------------------------------
// Rendering quality
// ---------------------------------------------------------------------------

export type QualityTier = 'high' | 'low';

export interface QualitySettings {
  maxDpr: number;
  msaa: number;
  reflections: boolean;
  bloomLevels: number;
  grain: boolean;
  stars: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { maxDpr: 2, msaa: 4, reflections: true, bloomLevels: 5, grain: true, stars: SKY.starCount },
  low: { maxDpr: 1.35, msaa: 0, reflections: false, bloomLevels: 3, grain: false, stars: SKY.starCountLow },
};

export const POST = {
  bloomStrength: 0.55,
  bloomThreshold: 0.92,
  bloomKnee: 0.5,
  vignette: 0.42,
  grain: 0.022,
  saturation: 1.12,
};
