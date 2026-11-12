import { CONSTELLATIONS, CYCLE, type QualityMode } from '../config';

/** One saved constellation: star directions in the rotating star frame. */
export interface SavedConstellation {
  /** Flat x, y, z unit vectors, one per settled star. */
  stars: number[];
  /** How many stars this constellation completes at. */
  target: number;
  done: boolean;
}

const KEY = 'celestial-sea.sky.v1';

/** The subset of Storage we use, so tests can pass a stand-in. */
export interface SkyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage can throw on access (private mode, blocked cookies), so never assume it. */
function defaultStore(): SkyStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Accept only well-formed data: saved skies survive app updates and hand edits. */
export function sanitiseSky(raw: unknown): SavedConstellation[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedConstellation[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { stars, target, done } = item as Record<string, unknown>;
    if (!Array.isArray(stars) || stars.length < 3 || stars.length % 3 !== 0) continue;
    if (stars.length / 3 > CONSTELLATIONS.maxStars) continue;
    const clean: number[] = [];
    let ok = true;
    for (let i = 0; i < stars.length; i += 3) {
      const x = Number(stars[i]);
      const y = Number(stars[i + 1]);
      const z = Number(stars[i + 2]);
      const len = Math.hypot(x, y, z);
      if (!Number.isFinite(len) || len < 0.5 || len > 2) {
        ok = false;
        break;
      }
      clean.push(x / len, y / len, z / len);
    }
    if (!ok) continue;
    const count = clean.length / 3;
    const t = Math.round(Number(target));
    out.push({
      stars: clean,
      target: Number.isFinite(t) ? Math.min(CONSTELLATIONS.maxStars, Math.max(count, t)) : count,
      done: done === true,
    });
  }
  // Keep the most recent ones if the list is somehow over the cap.
  return out.slice(-CONSTELLATIONS.max);
}

export function loadSky(store: SkyStore | null = defaultStore()): SavedConstellation[] {
  if (!store) return [];
  try {
    const text = store.getItem(KEY);
    return text ? sanitiseSky(JSON.parse(text)) : [];
  } catch {
    return [];
  }
}

/** Returns false if the sky could not be saved (storage full or unavailable). */
export function saveSky(list: SavedConstellation[], store: SkyStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    const compact = list.map((c) => ({
      stars: c.stars.map((v) => Math.round(v * 1e5) / 1e5),
      target: c.target,
      done: c.done,
    }));
    store.setItem(KEY, JSON.stringify(compact));
    return true;
  } catch {
    return false;
  }
}

export function clearSky(store: SkyStore | null = defaultStore()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

// --- Settings ---------------------------------------------------------------

export interface Settings {
  /** Volumes, 0..1. */
  music: number;
  effects: number;
  ambience: number;
  quality: QualityMode;
  /** 30 fps battery mode. */
  battery: boolean;
  /** Calmer camera, boat and swell. */
  reduceMotion: boolean;
  /** Real minutes for one full day loop. */
  dayMinutes: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  music: 0.8,
  effects: 0.8,
  ambience: 0.7,
  quality: 'auto',
  battery: false,
  reduceMotion: false,
  dayMinutes: CYCLE.defaultMinutes,
};

const SETTINGS_KEY = 'celestial-sea.settings.v1';

function volume(raw: unknown, fallback: number): number {
  const v = typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Defaults for this device: Reduce motion starts on if the system asks for it. */
export function deviceDefaults(): Settings {
  let reduce = false;
  try {
    reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    /* no media queries: keep the default */
  }
  return { ...DEFAULT_SETTINGS, reduceMotion: reduce };
}

/** Fill in anything missing or invalid with defaults. */
export function sanitiseSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const quality = r.quality === 'high' || r.quality === 'low' || r.quality === 'auto' ? r.quality : DEFAULT_SETTINGS.quality;
  return {
    music: volume(r.music, DEFAULT_SETTINGS.music),
    effects: volume(r.effects, DEFAULT_SETTINGS.effects),
    ambience: volume(r.ambience, DEFAULT_SETTINGS.ambience),
    quality,
    battery: r.battery === true,
    reduceMotion: typeof r.reduceMotion === 'boolean' ? r.reduceMotion : defaults.reduceMotion,
    dayMinutes: CYCLE.options.includes(r.dayMinutes as number) ? (r.dayMinutes as number) : defaults.dayMinutes,
  };
}

export function loadSettings(store: SkyStore | null = defaultStore(), defaults: Settings = DEFAULT_SETTINGS): Settings {
  if (!store) return { ...defaults };
  try {
    const text = store.getItem(SETTINGS_KEY);
    return sanitiseSettings(text ? JSON.parse(text) : null, defaults);
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings: Settings, store: SkyStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
