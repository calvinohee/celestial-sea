import { describe, expect, it } from 'vitest';
import { AUTO_QUALITY } from '../src/config';
import { DEFAULT_SETTINGS, loadSettings, sanitiseSettings, saveSettings, type SkyStore } from '../src/game/persistence';
import { AutoQuality, frameDue } from '../src/render/autoQuality';

const TARGET = 1 / 60;

/** Feed `seconds` worth of frames at a given frame time; returns the tiers switched to. */
function run(q: AutoQuality, seconds: number, frame: number, target = TARGET): string[] {
  const changes: string[] = [];
  for (let t = 0; t < seconds; t += frame) {
    const c = q.sample(frame, target);
    if (c) changes.push(c);
  }
  return changes;
}

describe('auto quality', () => {
  it('holds a fixed tier when the player picks High or Low', () => {
    const high = new AutoQuality('high');
    expect(run(high, 30, 1 / 20)).toEqual([]);
    expect(high.tier).toBe('high');
    const low = new AutoQuality('low');
    expect(run(low, 120, TARGET)).toEqual([]);
    expect(low.tier).toBe('low');
  });

  it('stays put when frames are on target', () => {
    const q = new AutoQuality('auto');
    expect(run(q, 20, TARGET)).toEqual([]);
    expect(q.tier).toBe('high');
  });

  it('steps down one tier at a time under sustained load, then stops at low', () => {
    const q = new AutoQuality('auto');
    expect(run(q, 60, 1 / 38)).toEqual(['medium', 'low']);
    expect(q.tier).toBe('low');
  });

  it('ignores a brief hitch and a long stall', () => {
    const q = new AutoQuality('auto');
    run(q, 6, TARGET);
    expect(run(q, 0.4, 1 / 20)).toEqual([]);
    expect(q.sample(3, TARGET)).toBeNull();
    expect(run(q, 6, TARGET)).toEqual([]);
    expect(q.tier).toBe('high');
  });

  it('steps back up only after a long calm spell', () => {
    const q = new AutoQuality('auto', 'medium');
    expect(run(q, AUTO_QUALITY.upSeconds - 2, TARGET)).toEqual([]);
    expect(run(q, 8, TARGET)).toEqual(['high']);
  });

  it('backs off after a failed step up: each retry waits longer', () => {
    const q = new AutoQuality('auto', 'medium');
    expect(run(q, AUTO_QUALITY.upSeconds + 6, TARGET)).toEqual(['high']);
    // High turns out too heavy straight away: slow frames until it gives the tier back.
    let back: string | null = null;
    for (let t = 0; t < 10 && !back; t += 1 / 40) back = q.sample(1 / 40, TARGET);
    expect(back).toBe('medium');
    // The normal wait is no longer enough...
    expect(run(q, AUTO_QUALITY.upSeconds + 6, TARGET)).toEqual([]);
    // ...but double that is.
    expect(run(q, AUTO_QUALITY.upSeconds + 6, TARGET)).toEqual(['high']);
  });

  it('judges against the 30 fps target in battery mode', () => {
    const q = new AutoQuality('auto');
    expect(run(q, 30, 1 / 30, 1 / 30)).toEqual([]);
    expect(q.tier).toBe('high');
  });

  it('switching mode applies at once and Auto resumes from the current tier', () => {
    const q = new AutoQuality('auto');
    expect(q.setMode('low')).toBe('low');
    expect(q.setMode('auto')).toBe('low');
    expect(q.setMode('high')).toBe('high');
  });
});

describe('frame limiter', () => {
  /** Frames rendered in one second on a display refreshing at `hz`, aiming for `fps`. */
  function rendered(hz: number, fps: number): number {
    let last = -1000;
    let count = 0;
    for (let i = 0; i < hz; i++) {
      const now = (i * 1000) / hz;
      if (frameDue(now - last, fps)) {
        count++;
        last = now;
      }
    }
    return count;
  }

  it('renders every frame on a 60 Hz display', () => {
    expect(rendered(60, 60)).toBe(60);
  });

  it('caps a 120 Hz display at 60', () => {
    expect(rendered(120, 60)).toBe(60);
  });

  it('battery mode gives 30 on both 60 Hz and 120 Hz displays', () => {
    expect(rendered(60, 30)).toBe(30);
    expect(rendered(120, 30)).toBe(30);
  });
});

describe('settings', () => {
  const store = (): SkyStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };

  it('defaults when nothing is stored or storage is unavailable', () => {
    expect(loadSettings(store())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips and repairs bad values', () => {
    const s = store();
    const mine = { music: 0.25, effects: 0, ambience: 1, quality: 'low' as const, battery: true, reduceMotion: true, dayMinutes: 5 };
    expect(saveSettings(mine, s)).toBe(true);
    expect(loadSettings(s)).toEqual(mine);
    expect(
      sanitiseSettings({ music: 7, effects: 'loud', ambience: -2, quality: 'ultra', battery: 'yes', reduceMotion: 1, dayMinutes: 3 }),
    ).toEqual({
      music: 1,
      effects: DEFAULT_SETTINGS.effects,
      ambience: 0,
      quality: 'auto',
      battery: false,
      reduceMotion: false,
      dayMinutes: DEFAULT_SETTINGS.dayMinutes,
    });
    // Settings saved before these options existed pick up this device's defaults.
    expect(sanitiseSettings({ music: 0.5 }, { ...DEFAULT_SETTINGS, reduceMotion: true }).reduceMotion).toBe(true);
    s.data.set('celestial-sea.settings.v1', 'not json');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
  });
});
