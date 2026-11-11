import * as Tone from 'tone';
import { midiToNote } from './theory';

export type InstrumentName = 'harp' | 'piano' | 'glock' | 'marimba';
export type BusName = 'melody' | 'fx';

/** No single note may be louder than this, however it was triggered. */
export const VELOCITY_CEILING = 0.62;
/** Most melodic notes that may ring at once; beyond this the weakest is released. */
export const MAX_VOICES = 8;

const FALLBACK_POLYPHONY = 24;
const FALLBACK_RELEASE = 1.6;

interface InstrumentSpec {
  /** Sampled notes (true sounding pitch). Sparse: the sampler repitches between them. */
  notes: string[];
  /** Level in dB and a low-pass to keep the tone soft. */
  gain: number;
  lowpass: number;
  release: number;
}

// All samples: VSCO 2 Community Edition (CC0). See CREDITS.md.
const SPECS: Record<InstrumentName, InstrumentSpec> = {
  harp: { notes: ['D2', 'A2', 'E3', 'B3', 'D4', 'A4', 'E5', 'B5', 'D6', 'A6'], gain: -2, lowpass: 9000, release: 1.6 },
  // The upright's mf layer, low-passed so it reads as a soft, felted piano.
  piano: { notes: ['C2', 'G2', 'C3', 'G3', 'C4', 'G4', 'C5', 'G5', 'C6', 'G6'], gain: -1, lowpass: 2400, release: 1.8 },
  glock: { notes: ['G5', 'C6', 'G6', 'C7', 'G7', 'C8'], gain: -14, lowpass: 6500, release: 1.4 },
  marimba: { notes: ['C3', 'G3', 'F4', 'C5', 'G5', 'B5'], gain: -3, lowpass: 2200, release: 1.0 },
};

const SPEC_INDEX: Record<InstrumentName, number> = { harp: 0, piano: 1, glock: 2, marimba: 3 };

const BUS_INSTRUMENTS: Record<BusName, InstrumentName[]> = {
  melody: ['harp', 'piano', 'glock'],
  fx: ['harp', 'glock', 'marimba'],
};

/** Warm the HTTP cache before audio is unlocked so samplers load instantly after the first tap. */
export function prefetchSamples(): void {
  const base = `${import.meta.env.BASE_URL}audio/`;
  for (const [name, spec] of Object.entries(SPECS)) {
    for (const note of spec.notes) {
      fetch(`${base}${name}-${encodeURIComponent(note)}.mp3`).catch(() => {
        /* offline or missing: the synth fallback covers it */
      });
    }
  }
}

interface ActiveVoice {
  end: number;
  start: number;
  velocity: number;
  release: (time: number) => void;
}

/**
 * Sampled instruments (harp, soft piano, glockenspiel, marimba) with a gentle
 * synth fallback while samples load or if they fail, the warm pad, and the
 * global voice cap.
 */
export class Instruments {
  /** 'loading' until samples arrive, then 'samples'; 'fallback' if they could not be loaded. */
  readonly status: Record<InstrumentName, 'loading' | 'samples' | 'fallback'> = {
    harp: 'loading',
    piano: 'loading',
    glock: 'loading',
    marimba: 'loading',
  };

  private readonly samplers: Record<BusName, Partial<Record<InstrumentName, Tone.Sampler>>> = { melody: {}, fx: {} };
  private readonly fallbacks: Record<BusName, Tone.PolySynth<Tone.FMSynth>>;
  private readonly pad: Tone.PolySynth<Tone.Synth>;
  private readonly padFilter: Tone.Filter;
  private readonly padBreath: Tone.LFO;
  private readonly voices: ActiveVoice[] = [];
  private readonly fallbackBusy: Record<BusName, number[]> = { melody: [], fx: [] };
  private lastKey = -1;
  private lastTime = -1;

  constructor(private readonly buses: Record<BusName, Tone.ToneAudioNode>, padBus: Tone.ToneAudioNode) {
    // Fallback: a soft FM bell with a rounded attack. Never a raw saw or square.
    const makeFallback = (bus: Tone.ToneAudioNode) => {
      const synth = new Tone.PolySynth({
        voice: Tone.FMSynth,
        maxPolyphony: FALLBACK_POLYPHONY,
        options: {
          harmonicity: 2,
          modulationIndex: 1.1,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: { attack: 0.025, decay: 1.5, sustain: 0, release: FALLBACK_RELEASE },
          modulationEnvelope: { attack: 0.01, decay: 0.35, sustain: 0, release: 0.5 },
          volume: -10,
        },
      });
      const soften = new Tone.Filter({ type: 'lowpass', frequency: 3200, Q: 0.4 });
      synth.chain(soften, bus);
      return synth;
    };
    this.fallbacks = { melody: makeFallback(buses.melody), fx: makeFallback(buses.fx) };

    // Pad: detuned triangles through a heavy low-pass that slowly breathes.
    this.pad = new Tone.PolySynth({
      voice: Tone.Synth,
      maxPolyphony: 20,
      options: {
        oscillator: { type: 'fattriangle', count: 3, spread: 14 },
        envelope: { attack: 3.2, decay: 2.5, sustain: 0.85, release: 6, attackCurve: 'sine', releaseCurve: 'sine' },
        volume: -14,
      },
    });
    this.padFilter = new Tone.Filter({ type: 'lowpass', frequency: 820, Q: 0.3, rolloff: -24 });
    // Started in start(), once the context is running (starting a source on a
    // still-suspended context makes Tone log a warning).
    this.padBreath = new Tone.LFO({ frequency: 0.045, min: 620, max: 1050, type: 'sine' });
    this.padBreath.connect(this.padFilter.frequency);
    this.pad.chain(this.padFilter, padBus);
  }

  /** Start free-running modulation. Call once the audio context is running. */
  start(): void {
    this.padBreath.start();
  }

  /** Begin loading samples. Safe to call once; failures leave the fallback in place. */
  load(): void {
    const base = `${import.meta.env.BASE_URL}audio/`;
    for (const name of Object.keys(SPECS) as InstrumentName[]) {
      const spec = SPECS[name];
      const urls: Record<string, string> = {};
      for (const note of spec.notes) urls[note] = `${name}-${encodeURIComponent(note)}.mp3`;
      let settled = false;
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        this.status[name] = 'fallback';
        console.warn(`[celestial] ${name} samples unavailable, using synth fallback.`, reason);
      };
      const buffers = new Tone.ToneAudioBuffers({
        urls,
        baseUrl: base,
        onload: () => {
          if (settled) return;
          settled = true;
          try {
            for (const bus of Object.keys(BUS_INSTRUMENTS) as BusName[]) {
              if (!BUS_INSTRUMENTS[bus].includes(name)) continue;
              const map: Record<string, Tone.ToneAudioBuffer> = {};
              for (const note of spec.notes) map[note] = buffers.get(note);
              const sampler = new Tone.Sampler({ urls: map, attack: 0.004, release: spec.release });
              const tone = new Tone.Filter({ type: 'lowpass', frequency: spec.lowpass, Q: 0.5 });
              const level = new Tone.Gain(Tone.dbToGain(spec.gain));
              sampler.chain(tone, level, this.buses[bus]);
              this.samplers[bus][name] = sampler;
            }
            this.status[name] = 'samples';
          } catch (e) {
            settled = false;
            fail(e);
          }
        },
        onerror: fail,
      });
      // If the network stalls, stop waiting; the fallback simply stays.
      window.setTimeout(() => fail('timeout'), 20000);
    }
  }

  /**
   * Play one note.
   * @param time AudioContext time
   * @param velocity 0..1 (clamped to VELOCITY_CEILING)
   * @param duration seconds before the release fade begins
   */
  play(bus: BusName, name: InstrumentName, midi: number, time: number, velocity: number, duration = 3): void {
    const v = Math.max(0.02, Math.min(VELOCITY_CEILING, velocity));
    const note = midiToNote(midi);
    // The same note on the same instrument at (almost) the same instant would
    // only stack up and phase; let the first one speak.
    const key = (bus === 'fx' ? 1000 : 0) + SPEC_INDEX[name] * 200 + midi;
    if (key === this.lastKey && Math.abs(time - this.lastTime) < 0.045) return;
    this.lastKey = key;
    this.lastTime = time;
    this.capVoices(time);

    const sampler = this.samplers[bus][name];
    if (sampler) {
      sampler.triggerAttackRelease(note, duration, time, v);
      this.voices.push({
        start: time,
        end: time + duration + SPECS[name].release,
        velocity: v,
        release: (t) => sampler.triggerRelease(note, t),
      });
    } else {
      // A fallback voice stays busy through its whole release, even when the
      // voice cap lets it go early. Under a flood of input, quietly skip notes
      // rather than run the synth out of voices.
      const busy = this.fallbackBusy[bus];
      for (let i = busy.length - 1; i >= 0; i--) if (busy[i] <= time) busy.splice(i, 1);
      if (busy.length >= FALLBACK_POLYPHONY - 4) return;
      const synth = this.fallbacks[bus];
      const d = Math.min(duration, 1.6);
      busy.push(time + d + FALLBACK_RELEASE + 0.1);
      synth.triggerAttackRelease(note, d, time, v * 0.8);
      this.voices.push({
        start: time,
        end: time + d + FALLBACK_RELEASE,
        velocity: v,
        release: (t) => synth.triggerRelease(note, t),
      });
    }
  }

  /** Keep at most MAX_VOICES ringing: release the oldest/quietest first. */
  private capVoices(now: number): void {
    const voices = this.voices;
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end <= now) voices.splice(i, 1);
    while (voices.length >= MAX_VOICES) {
      let worst = 0;
      let worstScore = Infinity;
      for (let i = 0; i < voices.length; i++) {
        const vo = voices[i];
        const life = Math.max(0, (vo.end - now) / Math.max(0.001, vo.end - vo.start));
        const score = vo.velocity * (0.35 + 0.65 * life);
        if (score < worstScore) {
          worstScore = score;
          worst = i;
        }
      }
      voices[worst].release(now);
      voices.splice(worst, 1);
    }
  }

  /** Number of melodic voices currently counted as ringing (for tests/debug). */
  get voiceCount(): number {
    return this.voices.length;
  }

  /** Slow-attack pad chord. */
  padChord(midis: number[], duration: number, time: number, velocity: number): void {
    this.pad.triggerAttackRelease(midis.map(midiToNote), duration, time, Math.min(0.8, velocity));
  }

  /** Darken the pad a little at night. */
  setPadBrightness(value01: number): void {
    this.pad.volume.rampTo(-16 + 2.5 * value01, 4);
  }
}
