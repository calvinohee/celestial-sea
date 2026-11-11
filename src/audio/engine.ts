import * as Tone from 'tone';
import type { PhaseName } from '../config';
import { Ambience } from './ambience';
import { Instruments } from './instruments';
import { Music } from './music';

export type VolumeKind = 'music' | 'effects' | 'ambience';

const FADE_IN_SECONDS = 3;

/**
 * Tone.js setup and the mix.
 *
 *   melody (+ delay), pad -> music volume  \
 *   interaction sounds    -> effects volume -> low-cut, high-shelf -> dry + reverb send
 *   ambience              -> ambience volume -> dry (+ a little reverb)
 *   everything            -> compressor -> limiter (-1 dB) -> soft ceiling -> master fade -> out
 *
 * Nothing is created until `start()` runs inside the first tap, which is what
 * unlocks audio on iOS.
 */
export class AudioEngine {
  started = false;
  /** Null until audio has been unlocked. */
  music: Music | null = null;
  instruments: Instruments | null = null;

  private readonly volumes: Record<VolumeKind, number> = { music: 0.8, effects: 0.8, ambience: 0.7 };
  private gains: Record<VolumeKind, Tone.Gain> | null = null;
  private master: Tone.Gain | null = null;
  private ambience: Ambience | null = null;
  private meter: Tone.Meter | null = null;
  private scope: Tone.Waveform | null = null;
  private suspendTimer = 0;
  private ready = false;
  private lastPhase: PhaseName | null = null;
  private lastDarkness = -1;

  /** Call synchronously from a user gesture (tap, click or key). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Keep playing with the ringer switch off (iOS 17+).
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) {
      try {
        nav.audioSession.type = 'playback';
      } catch {
        /* not critical */
      }
    }

    // A relaxed latency hint buys glitch-free playback; notes are quantised anyway.
    Tone.setContext(new Tone.Context({ latencyHint: 'playback', lookAhead: 0.15 }));
    const unlocked = Tone.start();

    // Master chain.
    const destination = Tone.getDestination();
    this.master = new Tone.Gain(0);
    const limiter = new Tone.Limiter(-1);
    const compressor = new Tone.Compressor({ threshold: -18, ratio: 2.5, attack: 0.04, release: 0.35, knee: 14 });
    const mix = new Tone.Gain(1);
    // Safety net after the limiter: perfectly linear below 0.8, then a smooth
    // knee that can never exceed 0.94. In normal play it does nothing at all.
    const ceiling = new Tone.WaveShaper((x) => {
      const a = Math.abs(x);
      if (a <= 0.8) return x;
      return Math.sign(x) * (0.8 + 0.14 * Math.tanh((a - 0.8) / 0.14));
    }, 2048);
    ceiling.oversample = '4x';
    mix.chain(compressor, limiter, ceiling, this.master, destination);
    if (import.meta.env.DEV) {
      this.meter = new Tone.Meter({ smoothing: 0.5 });
      this.scope = new Tone.Waveform(2048);
      this.master.connect(this.meter);
      this.master.connect(this.scope);
    }

    // One large, dark reverb shared by the melodic and pad buses.
    const reverb = new Tone.Reverb({ decay: 8, preDelay: 0.04, wet: 1 });
    const reverbTone = new Tone.Filter({ type: 'lowpass', frequency: 5200, Q: 0.3 });
    reverb.chain(reverbTone, mix);

    this.gains = {
      music: new Tone.Gain(this.volumes.music),
      effects: new Tone.Gain(this.volumes.effects),
      ambience: new Tone.Gain(this.volumes.ambience),
    };

    // Melodic chain: low-cut below 60 Hz, gentle high-shelf cut above 8 kHz.
    const melodicIn = new Tone.Gain(1);
    const lowCut = new Tone.Filter({ type: 'highpass', frequency: 60, Q: 0.5 });
    const shelf = new Tone.Filter({ type: 'highshelf', frequency: 8000, gain: -7 });
    const dry = new Tone.Gain(0.8);
    const send = new Tone.Gain(0.5);
    melodicIn.chain(lowCut, shelf);
    shelf.connect(dry);
    shelf.connect(send);
    dry.connect(mix);
    send.connect(reverb);
    this.gains.music.connect(melodicIn);
    this.gains.effects.connect(melodicIn);

    const melodyBus = new Tone.Gain(1);
    const fxBus = new Tone.Gain(1);
    const padBus = new Tone.Gain(1);
    melodyBus.connect(this.gains.music);
    padBus.connect(this.gains.music);
    fxBus.connect(this.gains.effects);

    // Subtle dotted-eighth echo on the generative melody only.
    const delay = new Tone.FeedbackDelay({ delayTime: 0.75, feedback: 0.26, wet: 1 });
    const delayReturn = new Tone.Gain(0.13);
    melodyBus.chain(delay, delayReturn, this.gains.music);

    // Ambience: mostly dry, a touch of the same room.
    const ambienceBus = new Tone.Gain(1);
    const ambienceSend = new Tone.Gain(0.1);
    ambienceBus.connect(this.gains.ambience);
    this.gains.ambience.connect(mix);
    this.gains.ambience.connect(ambienceSend);
    ambienceSend.connect(reverb);

    this.instruments = new Instruments({ melody: melodyBus, fx: fxBus }, padBus);
    this.instruments.load();
    this.ambience = new Ambience(ambienceBus);
    this.music = new Music(this.instruments);

    try {
      await Promise.all([unlocked, reverb.ready]);
    } catch (e) {
      console.warn('[celestial] audio could not start', e);
      return;
    }

    this.instruments.start();
    this.ambience.start();
    this.music.start();
    this.ready = true;
    if (!document.hidden) this.master.gain.rampTo(1, FADE_IN_SECONDS);
    else this.suspend();
  }

  /** Called from the render loop; cheap, and only acts when something changed. */
  setPhase(phase: PhaseName, darkness: number): void {
    if (!this.ready) return;
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.music?.setPhase(phase);
    }
    if (Math.abs(darkness - this.lastDarkness) > 0.02) {
      this.lastDarkness = darkness;
      this.ambience?.setDarkness(darkness);
      this.instruments?.setPadBrightness(1 - darkness);
    }
  }

  getVolume(kind: VolumeKind): number {
    return this.volumes[kind];
  }

  /** 0..1, always ramped so a slider drag can never click. */
  setVolume(kind: VolumeKind, value: number): void {
    const v = Math.min(1, Math.max(0, value));
    this.volumes[kind] = v;
    this.gains?.[kind].gain.rampTo(v, 0.15);
  }

  /** Page hidden: fade out, then suspend the context. */
  suspend(): void {
    if (!this.ready || !this.master) return;
    this.master.gain.rampTo(0, 0.25);
    window.clearTimeout(this.suspendTimer);
    this.suspendTimer = window.setTimeout(() => {
      const raw = Tone.getContext().rawContext as unknown as { suspend?: () => Promise<void> };
      raw.suspend?.().catch(() => undefined);
    }, 320);
  }

  /** Page visible again (or the OS interrupted us): resume and fade back in. */
  resume(): void {
    if (!this.ready || !this.master) return;
    window.clearTimeout(this.suspendTimer);
    Tone.getContext()
      .resume()
      .catch(() => undefined);
    this.master.gain.rampTo(1, 1.5);
  }

  /** Call on user input: recovers from an interrupted context (phone call, Siri...). */
  ensureRunning(): void {
    if (!this.ready || document.hidden) return;
    if (Tone.getContext().state !== 'running') this.resume();
  }

  /** 'running', 'suspended', ... or 'off' before the first tap. */
  get contextState(): string {
    return this.started ? Tone.getContext().state : 'off';
  }

  /** Dev only: RMS output level in dBFS. */
  get level(): number {
    const v = this.meter?.getValue();
    return typeof v === 'number' ? v : -Infinity;
  }

  /** Dev only: absolute peak of the most recent ~46 ms of output (linear, 1 = full scale). */
  get peak(): number {
    if (!this.scope) return 0;
    const data = this.scope.getValue();
    let p = 0;
    for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
    return p;
  }
}
