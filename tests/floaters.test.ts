import { describe, expect, it } from 'vitest';
import { FLOATERS } from '../src/config';
import { Floaters } from '../src/game/floaters';
import { DayCycle } from '../src/time/dayCycle';
import { mulberry32 } from '../src/util/noise';

const cycle = new DayCycle();
const DT = 1 / 60;

describe('floating lanterns', () => {
  it('starts with a full set, one of them close off the bow', () => {
    const f = new Floaters(mulberry32(1));
    const boat = { x: 0, z: 0, heading: 0 };
    f.update(DT, 0, boat, cycle, true);
    const afloat = f.afloat;
    expect(afloat.length).toBeGreaterThanOrEqual(FLOATERS.pool - 2);
    const nearest = Math.min(...afloat.map((p) => Math.hypot(p.x, p.z)));
    expect(nearest).toBeGreaterThan(10);
    expect(nearest).toBeLessThan(22);
    // Spread out, never bunched.
    for (let i = 0; i < afloat.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(Math.hypot(afloat[i].x - afloat[j].x, afloat[i].z - afloat[j].z)).toBeGreaterThan(FLOATERS.spacing * 0.9);
      }
    }
  });

  it('gliding straight ahead lights the first lantern, with no button', () => {
    const f = new Floaters(mulberry32(2));
    const boat = { x: 0, z: 0, heading: 0 };
    let lit: { x: number; z: number } | null = null;
    let t = 0;
    for (let i = 0; i < 60 * 12 && !lit; i++) {
      boat.z -= 3 * DT; // heading 0 faces -Z
      t += DT;
      const r = f.update(DT, t, boat, cycle, true);
      if (r) lit = { x: r.x, z: r.z };
    }
    expect(lit).not.toBeNull();
    expect(Math.hypot(lit!.x - boat.x, lit!.z - boat.z)).toBeLessThanOrEqual(FLOATERS.reach + 0.01);
  });

  it('waits while the rate limit is running, then lights', () => {
    const f = new Floaters(mulberry32(3));
    const boat = { x: 0, z: 0, heading: 0 };
    f.update(DT, 0, boat, cycle, false);
    const target = f.afloat.reduce((a, b) => (Math.hypot(a.x, a.z) < Math.hypot(b.x, b.z) ? a : b));
    boat.x = target.x;
    boat.z = target.z + 1;
    for (let i = 0; i < 180; i++) expect(f.update(DT, i * DT, boat, cycle, false)).toBeNull();
    expect(f.update(DT, 3, boat, cycle, true)).not.toBeNull();
  });

  it('keeps lanterns ahead however far the boat travels', () => {
    const f = new Floaters(mulberry32(4));
    const boat = { x: 0, z: 0, heading: 0.6 };
    let t = 0;
    let lit = 0;
    for (let i = 0; i < 60 * 240; i++) {
      boat.x += Math.sin(boat.heading) * 3.4 * DT;
      boat.z -= Math.cos(boat.heading) * 3.4 * DT;
      t += DT;
      if (f.update(DT, t, boat, cycle, true)) lit++;
    }
    // After 800 m there are still lanterns ahead of the bow and within sight.
    const ahead = f.afloat.filter((p) => {
      const dx = p.x - boat.x;
      const dz = p.z - boat.z;
      return dx * Math.sin(boat.heading) - dz * Math.cos(boat.heading) > 0 && Math.hypot(dx, dz) < FLOATERS.spawn[1] + 5;
    });
    expect(ahead.length).toBeGreaterThanOrEqual(2);
    expect(f.afloat.every((p) => Math.hypot(p.x - boat.x, p.z - boat.z) <= FLOATERS.despawn + 1)).toBe(true);
    // Sailing in a straight line passes close enough to light some along the way.
    expect(lit).toBeGreaterThanOrEqual(1);
  });
});
