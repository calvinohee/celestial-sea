import * as Tone from 'tone';
import type { PhaseName } from '../config';
import type { Instruments } from './instruments';
import {
  allowedNotes,
  arpeggio,
  BEATS_PER_BAR,
  BPM,
  chordTones,
  DENSITY,
  MelodyGenerator,
  noteToMidi,
  PROGRESSIONS,
  STEP_WEIGHTS,
  touchNote,
  type Chord,
} from './theory';

const STEPS_PER_BAR = 8;
const BAR_SECONDS = (60 / BPM) * BEATS_PER_BAR;

/**
 * The generative score. A transport loop ticks on 8th notes at 60 BPM: chords
 * change only on bar lines (every 2 to 4 bars), a sparse melody plays even
 * when the player is idle, and every interaction sound is quantised to the
 * next 8th and drawn from notes that fit the current chord.
 */
export class Music {
  private phase: PhaseName = 'golden';
  private progressionPhase: PhaseName = 'golden';
  private progressionIndex = -1;
  private chord: Chord = PROGRESSIONS.golden[0];
  private barsLeft = 0;
  private step = 0;
  private restSteps = 4;
  private readonly melody: MelodyGenerator;
  private loop: Tone.Loop | null = null;

  constructor(
    private readonly instruments: Instruments,
    private readonly rand: () => number = Math.random,
  ) {
    this.melody = new MelodyGenerator(rand);
  }

  start(): void {
    if (this.loop) return;
    const transport = Tone.getTransport();
    transport.bpm.value = BPM;
    transport.timeSignature = BEATS_PER_BAR;
    this.loop = new Tone.Loop((time) => this.onStep(time), '8n').start(0);
    transport.start('+0.2');
  }

  /** The music follows the day: each phase has its own chords and density. */
  setPhase(phase: PhaseName): void {
    this.phase = phase;
  }

  get currentChord(): Chord {
    return this.chord;
  }

  private onStep(time: number): void {
    const stepInBar = this.step % STEPS_PER_BAR;
    this.step++;

    if (stepInBar === 0) {
      if (this.barsLeft <= 0) this.changeChord(time);
      this.barsLeft--;
    }

    // Leave air after each note so phrases never crowd.
    if (this.restSteps > 0) {
      this.restSteps--;
      return;
    }
    if (this.rand() < DENSITY[this.phase] * STEP_WEIGHTS[stepInBar]) this.playMelodyNote(time, stepInBar);
  }

  private changeChord(time: number): void {
    if (this.progressionPhase !== this.phase) {
      this.progressionPhase = this.phase;
      this.progressionIndex = -1;
    }
    const progression = PROGRESSIONS[this.progressionPhase];
    this.progressionIndex = (this.progressionIndex + 1) % progression.length;
    this.chord = progression[this.progressionIndex];

    // 2 to 4 bars = 8 to 16 seconds per chord.
    const bars = 2 + Math.floor(this.rand() * 3);
    this.barsLeft = bars;
    // The pad's long attack and release crossfade one chord into the next.
    this.instruments.padChord(this.chord.pad, bars * BAR_SECONDS - 1.5, time, 0.5);

    // Now and then a soft low piano note under the new chord.
    if (this.rand() < 0.55) {
      let root = this.chord.pad[0] - 12;
      if (root < noteToMidi('B1')) root += 12;
      this.instruments.play('melody', 'piano', root, time + 0.02 + this.rand() * 0.03, 0.3, 6);
    }
  }

  private playMelodyNote(time: number, stepInBar: number): void {
    const night = this.phase === 'night' || this.phase === 'blue';
    const note = this.melody.next(this.chord);
    const accent = stepInBar === 0 || stepInBar === 4 ? 0.06 : 0;
    const velocity = 0.27 + this.rand() * 0.16 + accent;
    const when = time + this.rand() * 0.022;

    const r = this.rand();
    const glockShare = night ? 0.2 : 0.08;
    if (r < glockShare) {
      let high = note;
      while (high < noteToMidi('G5')) high += 12;
      this.instruments.play('melody', 'glock', high, when, velocity * 0.8, 2.5);
    } else if (r < glockShare + 0.5) {
      this.instruments.play('melody', 'harp', note, when, velocity, 4);
      // Occasionally a quiet harmony note below.
      if (this.rand() < 0.14) {
        const ladder = allowedNotes(this.chord, note - 9, note - 3);
        if (ladder.length > 0) {
          const below = ladder[Math.floor(this.rand() * ladder.length)];
          this.instruments.play('melody', 'harp', below, when + 0.03, velocity * 0.7, 4);
        }
      }
    } else {
      this.instruments.play('melody', 'piano', note, when, velocity * 0.95, 3.5);
    }
    this.restSteps = 1 + Math.floor(this.rand() * (night ? 5 : 3));
  }

  /** Time of the next 8th note, with a few milliseconds of human looseness. */
  private nextEighth(): number {
    const transport = Tone.getTransport();
    const now = Tone.now();
    let t = transport.state === 'started' ? transport.nextSubdivision('8n') : now + 0.05;
    if (t < now + 0.02) t += 60 / BPM / 2;
    return t + this.rand() * 0.014;
  }

  private humanise(velocity: number): number {
    return velocity * (0.9 + this.rand() * 0.2);
  }

  // --- Interaction sounds -------------------------------------------------

  /** Touching the water: a soft low marimba note, pitched by horizontal position. */
  waterTouch(x01: number): void {
    const note = touchNote(x01, this.chord);
    this.instruments.play('fx', 'marimba', note, this.nextEighth(), this.humanise(0.44), 2);
  }

  /** Lantern release: a harp pluck on a chord tone. */
  lanternRelease(): void {
    const tones = chordTones(this.chord, noteToMidi('D4'), noteToMidi('A5'));
    const note = tones[Math.floor(this.rand() * tones.length)];
    this.instruments.play('fx', 'harp', note, this.nextEighth(), this.humanise(0.5), 4.5);
  }

  /** A lantern settles into the sky as a star: one glockenspiel note. */
  starSettle(): void {
    const tones = chordTones(this.chord, noteToMidi('D6'), noteToMidi('B6'));
    const note = tones[Math.floor(this.rand() * tones.length)];
    this.instruments.play('fx', 'glock', note, this.nextEighth(), this.humanise(0.42), 3);
  }

  /** Constellation complete: pad swell with a rising harp arpeggio, about 5 seconds. */
  constellationComplete(): void {
    const t = this.nextEighth();
    const eighth = 60 / BPM / 2;
    this.instruments.padChord(
      this.chord.pad.map((m) => m + 12),
      3.2,
      t,
      0.62,
    );
    const run = arpeggio(this.chord, noteToMidi('D4'), 7);
    run.forEach((note, i) => {
      const v = 0.3 + (i / Math.max(1, run.length - 1)) * 0.2;
      this.instruments.play('fx', 'harp', note, t + i * eighth + this.rand() * 0.012, this.humanise(v), 4.5);
    });
    const top = chordTones(this.chord, noteToMidi('D6'), noteToMidi('D7'));
    if (top.length > 0) {
      this.instruments.play('fx', 'glock', top[top.length - 1], t + run.length * eighth, 0.34, 3);
    }
  }

  /** Shooting star: three very soft, very high notes falling away. */
  shootingStar(): void {
    const notes = allowedNotes(this.chord, noteToMidi('D7'), noteToMidi('B7'));
    if (notes.length < 3) return;
    const start = notes.length - 1 - Math.floor(this.rand() * 2);
    const t = Tone.now() + 0.08;
    for (let i = 0; i < 3; i++) {
      this.instruments.play('fx', 'glock', notes[Math.max(0, start - i)], t + i * 0.13, 0.17 - i * 0.035, 2);
    }
  }
}
