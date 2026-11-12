import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { CYCLE, LOOP_SECONDS, PHASES } from '../src/config';
import { DayCycle, phaseBlendAt, type PhaseBlend } from '../src/time/dayCycle';

const blend = (): PhaseBlend => ({ index: 0, next: 0, mix: 0, progress: 0 });

describe('day cycle', () => {
  it('keeps the spec phase proportions on its reference timeline', () => {
    expect(LOOP_SECONDS).toBe(20 * 60);
    expect(PHASES.map((p) => p.duration / 60)).toEqual([3, 6, 3, 6, 2]);
  });

  it('runs a full loop in the chosen number of real minutes (8 by default)', () => {
    const cycle = new DayCycle();
    expect(cycle.loopMinutes).toBeCloseTo(CYCLE.defaultMinutes, 6);
    // Half the real loop later the clock is half way round the reference timeline.
    for (let i = 0; i < CYCLE.defaultMinutes * 30; i++) cycle.update(1);
    expect(cycle.time).toBeCloseTo(LOOP_SECONDS / 2, 3);
    for (const minutes of CYCLE.options) {
      const c = new DayCycle();
      c.loopMinutes = minutes;
      for (let i = 0; i < minutes * 60 - 1; i++) c.update(1);
      expect(c.phaseName).toBe('predawn');
      c.update(2);
      expect(c.phaseName).toBe('golden');
    }
  });

  it('starts every session at pure golden hour', () => {
    const cycle = new DayCycle();
    expect(cycle.phaseName).toBe('golden');
    expect(cycle.blend.mix).toBe(0);
    const horizon = new Color(PHASES[0].sky[5]);
    expect(cycle.sky[5].r).toBeCloseTo(horizon.r, 6);
    expect(cycle.sky[5].g).toBeCloseTo(horizon.g, 6);
    expect(cycle.sky[5].b).toBeCloseTo(horizon.b, 6);
  });

  it('holds each phase palette at the start of that phase', () => {
    let t = 0;
    for (let i = 0; i < PHASES.length; i++) {
      const b = phaseBlendAt(t + 0.001, blend());
      expect(b.index).toBe(i);
      expect(b.mix).toBe(0);
      t += PHASES[i].duration;
    }
  });

  it('reaches the next palette exactly at the phase boundary', () => {
    const b = phaseBlendAt(PHASES[0].duration - 1e-6, blend());
    expect(b.index).toBe(0);
    expect(b.next).toBe(1);
    expect(b.mix).toBeGreaterThan(0.999999);
  });

  it('never snaps: every value changes smoothly, including across the loop point', () => {
    const cycle = new DayCycle();
    const step = 0.25;
    const read = () => [
      ...cycle.sky.flatMap((c) => [c.r, c.g, c.b]),
      cycle.ridgeNear.r,
      cycle.ridgeFar.b,
      cycle.waterDeep.g,
      cycle.sunDir.y,
      cycle.sunDisc,
      cycle.sunGlow,
      cycle.stars,
      cycle.glow,
      cycle.exposure,
    ];
    cycle.setTime(0);
    let prev = read();
    let worst = 0;
    for (let t = step; t <= LOOP_SECONDS + step; t += step) {
      cycle.setTime(t);
      const cur = read();
      for (let i = 0; i < cur.length; i++) worst = Math.max(worst, Math.abs(cur[i] - prev[i]));
      prev = cur;
    }
    // A quarter-second step should never move any value by more than half a percent.
    expect(worst).toBeLessThan(0.005);
  });

  it('wraps time and honours the debug time scale', () => {
    const cycle = new DayCycle();
    cycle.loopMinutes = 20;
    cycle.timeScale = 20;
    cycle.update(10);
    expect(cycle.time).toBeCloseTo(200, 6);
    cycle.setTime(LOOP_SECONDS + 5);
    expect(cycle.time).toBeCloseTo(5, 6);
    expect(cycle.phaseName).toBe('golden');
  });
});
