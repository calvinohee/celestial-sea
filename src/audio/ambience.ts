import * as Tone from 'tone';

/**
 * Synthesised atmosphere: water lapping on both sides, a faint wind, and a
 * darker low bed that comes up at night. Everything is filtered noise moved by
 * slow, unrelated LFOs so it never loops audibly. Very quiet by design.
 */
export class Ambience {
  private readonly nightBed: Tone.Gain;
  private readonly waterTone: Tone.Filter[] = [];
  private readonly sources: Tone.Noise[] = [];
  private readonly lfos: Tone.LFO[] = [];

  constructor(output: Tone.ToneAudioNode) {
    // Water: two decorrelated pink-noise voices, left and right. Each has a
    // low-pass that opens and closes and a level that swells like small waves.
    const side = (pan: number, rateA: number, rateB: number, phase: number) => {
      const noise = new Tone.Noise({ type: 'pink', volume: -6 });
      const highpass = new Tone.Filter({ type: 'highpass', frequency: 180, Q: 0.3 });
      const lowpass = new Tone.Filter({ type: 'lowpass', frequency: 900, Q: 0.6 });
      const level = new Tone.Gain(0);
      const panner = new Tone.Panner(pan);
      noise.chain(highpass, lowpass, level, panner, output);

      const sweep = new Tone.LFO({ frequency: rateA, min: 480, max: 1500, phase });
      sweep.connect(lowpass.frequency);
      // Two slow swells added together make an irregular lapping.
      const swellA = new Tone.LFO({ frequency: rateA, min: 0.03, max: 0.26, phase });
      const swellB = new Tone.LFO({ frequency: rateB, min: 0.0, max: 0.13, phase: phase + 70 });
      swellA.connect(level.gain);
      swellB.connect(level.gain);

      this.sources.push(noise);
      this.lfos.push(sweep, swellA, swellB);
      this.waterTone.push(lowpass);
    };
    side(-0.55, 0.137, 0.061, 0);
    side(0.55, 0.113, 0.047, 140);

    // Wind: band-passed noise, barely there.
    const wind = new Tone.Noise({ type: 'pink', volume: -8 });
    const windBand = new Tone.Filter({ type: 'bandpass', frequency: 380, Q: 0.7 });
    const windLevel = new Tone.Gain(0);
    wind.chain(windBand, windLevel, output);
    const windPitch = new Tone.LFO({ frequency: 0.029, min: 260, max: 560 });
    windPitch.connect(windBand.frequency);
    const windSwell = new Tone.LFO({ frequency: 0.041, min: 0.02, max: 0.15, phase: 200 });
    windSwell.connect(windLevel.gain);
    this.sources.push(wind);
    this.lfos.push(windPitch, windSwell);

    // Night bed: soft, dark and low.
    const bed = new Tone.Noise({ type: 'brown', volume: -4 });
    const bedTone = new Tone.Filter({ type: 'lowpass', frequency: 210, Q: 0.4 });
    this.nightBed = new Tone.Gain(0);
    bed.chain(bedTone, this.nightBed, output);
    this.sources.push(bed);
  }

  start(): void {
    for (const s of this.sources) s.start();
    for (const l of this.lfos) l.start();
  }

  /** `darkness` 0 (day) .. 1 (night). Called now and then, not every frame. */
  setDarkness(darkness: number): void {
    this.nightBed.gain.rampTo(0.4 * darkness, 4);
  }
}
