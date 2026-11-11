import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CONSTELLATIONS } from '../src/config';
import { Constellations, type Reservation } from '../src/game/constellations';
import { clearSky, loadSky, sanitiseSky, saveSky, type SkyStore } from '../src/game/persistence';
import { DayCycle } from '../src/time/dayCycle';
import { mulberry32 } from '../src/util/noise';

const DEG = Math.PI / 180;

function fakeStore(): SkyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function makeCamera(aspect = 1.6, fov = 50): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, aspect, 0.3, 16000);
  camera.position.set(0, 2, 0);
  const pitch = Math.atan(Math.tan((fov * DEG) / 2) / 3);
  camera.lookAt(0, 2 + Math.tan(pitch) * 10, -10);
  camera.updateMatrixWorld();
  return camera;
}

const angle = (dirs: number[], i: number, j: number) =>
  new Vector3(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]).angleTo(
    new Vector3(dirs[j * 3], dirs[j * 3 + 1], dirs[j * 3 + 2]),
  );

describe('persistence', () => {
  it('round-trips a sky through storage', () => {
    const store = fakeStore();
    const sky = [{ stars: [0, 0.6, -0.8, 0.1, 0.5, -0.86], target: 6, done: false }];
    expect(saveSky(sky, store)).toBe(true);
    const loaded = loadSky(store);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].target).toBe(6);
    expect(loaded[0].done).toBe(false);
    expect(loaded[0].stars[1]).toBeCloseTo(0.6, 4);
    clearSky(store);
    expect(loadSky(store)).toEqual([]);
  });

  it('ignores malformed data instead of throwing', () => {
    expect(sanitiseSky(null)).toEqual([]);
    expect(sanitiseSky('nope')).toEqual([]);
    expect(sanitiseSky([{ stars: [1, 2], target: 5, done: true }])).toEqual([]);
    expect(sanitiseSky([{ stars: [0, 0, 0], target: 5, done: true }])).toEqual([]);
    expect(sanitiseSky([{ stars: ['x', 1, 0], target: 5, done: true }])).toEqual([]);
    expect(sanitiseSky([{ stars: new Array(30).fill(0.5), target: 5, done: true }])).toEqual([]);
    const store = fakeStore();
    store.data.set('celestial-sea.sky.v1', '{not json');
    expect(loadSky(store)).toEqual([]);
  });

  it('survives storage that throws', () => {
    const broken: SkyStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadSky(broken)).toEqual([]);
    expect(saveSky([], broken)).toBe(false);
    expect(() => clearSky(broken)).not.toThrow();
    expect(loadSky(null)).toEqual([]);
    expect(saveSky([], null)).toBe(false);
  });

  it('caps a saved sky and re-normalises directions', () => {
    const many = Array.from({ length: 50 }, () => ({ stars: [0, 0.9, -1.2], target: 5, done: true }));
    const clean = sanitiseSky(many);
    expect(clean).toHaveLength(CONSTELLATIONS.max);
    expect(Math.hypot(...clean[0].stars)).toBeCloseTo(1, 6);
  });
});

describe('constellations', () => {
  const identity = new Quaternion();

  for (const [label, aspect, fov] of [
    ['landscape', 1.6, 50],
    ['portrait', 0.46, 74],
  ] as const) {
    it(`builds linked constellations of 5 to 7 visible stars (${label})`, () => {
      const store = fakeStore();
      const sky = new Constellations([], mulberry32(7), store);
      const camera = makeCamera(aspect, fov);
      let t = 0;
      let completions = 0;
      for (let i = 0; i < 60; i++) {
        t += 2;
        const r = sky.reserve(camera, identity, t);
        const result = sky.settle(r, t + 8);
        expect(result).not.toBeNull();
        if (result!.completed) {
          completions++;
          expect(result!.fanfare).toBe(true);
        }
      }
      expect(completions).toBeGreaterThanOrEqual(8);
      const [stepMin, stepMax] = CONSTELLATIONS.step;
      for (const c of sky.list) {
        const n = c.dirs.length / 3;
        expect(n).toBeLessThanOrEqual(CONSTELLATIONS.maxStars);
        if (c.completedAt < 1e6) expect(n).toBeGreaterThanOrEqual(CONSTELLATIONS.minStars);
        for (let i = 0; i < n; i++) {
          // Every star is above the horizon haze.
          expect(c.dirs[i * 3 + 1]).toBeGreaterThan(Math.sin(6 * DEG));
          if (i > 0) {
            const step = angle(c.dirs, i - 1, i) / DEG;
            expect(step).toBeGreaterThan(stepMin * 0.65);
            expect(step).toBeLessThan(stepMax * 1.05);
          }
          for (let j = 0; j < i; j++) expect(angle(c.dirs, i, j) / DEG).toBeGreaterThan(2);
        }
      }
    });
  }

  it('starts a new constellation once the last place is promised, even mid-flight', () => {
    const sky = new Constellations([], mulberry32(3), fakeStore());
    const camera = makeCamera();
    const first = sky.reserve(camera, identity, 0);
    const target = first.constellation.target;
    const flights: Reservation[] = [first];
    for (let i = 1; i < target; i++) flights.push(sky.reserve(camera, identity, i));
    expect(flights.every((r) => r.constellation === first.constellation)).toBe(true);
    const next = sky.reserve(camera, identity, target);
    expect(next.constellation).not.toBe(first.constellation);
    expect(next.index).toBe(0);
    // Nothing completes until the lanterns actually arrive, in order.
    flights.forEach((r, i) => {
      const result = sky.settle(r, 20 + i)!;
      expect(result.completed).toBe(i === target - 1);
    });
    expect(sky.starCount).toBe(target);
  });

  it('keeps at most the cap, fading the oldest out', () => {
    const sky = new Constellations([], mulberry32(11), fakeStore());
    const camera = makeCamera();
    const cycle = new DayCycle();
    let t = 0;
    for (let i = 0; i < (CONSTELLATIONS.max + 6) * CONSTELLATIONS.maxStars; i++) {
      t += 2;
      sky.settle(sky.reserve(camera, identity, t), t);
    }
    const alive = sky.list.filter((c) => c.removeAt >= 1e6).length;
    expect(alive).toBeLessThanOrEqual(CONSTELLATIONS.max);
    expect(sky.serialise().length).toBeLessThanOrEqual(CONSTELLATIONS.max);
    sky.update(t + CONSTELLATIONS.fadeOut + 1, cycle, camera, identity);
    expect(sky.list.length).toBeLessThanOrEqual(CONSTELLATIONS.max);
  });

  it('persists across sessions and resumes an unfinished constellation', () => {
    const store = fakeStore();
    const camera = makeCamera();
    const a = new Constellations([], mulberry32(5), store);
    const first = a.reserve(camera, identity, 0);
    a.settle(first, 8);
    const second = a.reserve(camera, identity, 2);
    a.settle(second, 10);
    // A third lantern is still in flight when the page closes: it is not saved.
    a.reserve(camera, identity, 4);

    const b = new Constellations(loadSky(store), mulberry32(6), store);
    expect(b.starCount).toBe(2);
    const resumed = b.reserve(camera, identity, 0);
    expect(resumed.index).toBe(2);
    expect(b.list).toHaveLength(1);
  });

  it('clears the sky: storage at once, stars after the fade', () => {
    const store = fakeStore();
    const camera = makeCamera();
    const cycle = new DayCycle();
    const sky = new Constellations([], mulberry32(9), store);
    const inFlight: Reservation[] = [];
    for (let i = 0; i < 9; i++) {
      const r = sky.reserve(camera, identity, i);
      if (i < 8) sky.settle(r, i + 8);
      else inFlight.push(r);
    }
    expect(loadSky(store).length).toBeGreaterThan(0);
    sky.clear(30);
    expect(loadSky(store)).toEqual([]);
    // A lantern that was still rising simply fades; it does not resurrect the sky.
    expect(sky.settle(inFlight[0], 31)).toBeNull();
    sky.update(30 + CONSTELLATIONS.fadeOut + 1, cycle, camera, identity);
    expect(sky.list).toHaveLength(0);
    expect(sky.starCount).toBe(0);
    // And the next lantern starts afresh.
    expect(sky.reserve(camera, identity, 40).index).toBe(0);
  });

  it('closes an unfinished constellation that is out of view and starts a new one in view', () => {
    const sky = new Constellations([], mulberry32(21), fakeStore());
    const camera = makeCamera();
    for (let i = 0; i < 3; i++) sky.settle(sky.reserve(camera, identity, i), i + 8);
    expect(sky.list).toHaveLength(1);
    // The sky has turned half way round: the old stars are behind the player.
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    const r = sky.reserve(camera, turned, 100);
    expect(sky.list).toHaveLength(2);
    expect(r.index).toBe(0);
    expect(sky.list[0].completedAt).toBeLessThan(1e6);
    // The new star is in front of the camera (which looks down -Z).
    const world = r.dir.clone().applyQuaternion(turned);
    expect(world.z).toBeLessThan(0);
    expect(world.y).toBeGreaterThan(Math.sin(9 * DEG));
  });
});
