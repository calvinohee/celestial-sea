import type { PhaseName } from '../config';

// Pure music rules: no audio objects in here, so it can be unit-tested.
// One key throughout: D, using D major pentatonic and D Lydian notes only.

export const BPM = 60;
export const BEATS_PER_BAR = 4;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Pitch classes of D Lydian: D E F# G# A B C#. */
export const LYDIAN: ReadonlySet<number> = new Set([2, 4, 6, 8, 9, 11, 1]);
/** Pitch classes of D major pentatonic: D E F# A B. */
export const PENTATONIC: ReadonlySet<number> = new Set([2, 4, 6, 9, 11]);

export function noteToMidi(name: string): number {
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`Bad note name: ${name}`);
  return NAMES.indexOf(m[1]) + 12 * (Number(m[2]) + 1);
}

export function midiToNote(midi: number): string {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

const pc = (midi: number) => ((midi % 12) + 12) % 12;

export function isInKey(midi: number): boolean {
  return LYDIAN.has(pc(midi));
}

export interface Chord {
  name: string;
  /** Pad voicing, low to high (MIDI). */
  pad: number[];
  /** Pitch classes of the chord. */
  tones: ReadonlySet<number>;
}

function chord(name: string, notes: string[]): Chord {
  const pad = notes.map(noteToMidi);
  return { name, pad, tones: new Set(pad.map(pc)) };
}

/**
 * A short progression per phase. Golden hour is warm and settled, dusk leans
 * on the Lydian #4, night is open fourths and fifths with no thirds.
 */
export const PROGRESSIONS: Record<PhaseName, Chord[]> = {
  golden: [
    chord('Dadd9', ['D3', 'A3', 'E4', 'F#4']),
    chord('Bm7', ['B2', 'F#3', 'A3', 'D4']),
    chord('F#m7', ['F#3', 'A3', 'C#4', 'E4']),
    chord('Aadd9', ['A2', 'E3', 'B3', 'C#4']),
  ],
  dusk: [
    chord('Dmaj7', ['D3', 'A3', 'C#4', 'F#4']),
    chord('E/D', ['D3', 'G#3', 'B3', 'E4']),
    chord('Bm7', ['B2', 'A3', 'D4', 'F#4']),
    chord('A6', ['A2', 'E3', 'F#3', 'C#4']),
  ],
  blue: [
    chord('F#m7', ['F#3', 'A3', 'C#4', 'E4']),
    chord('Dmaj7', ['D3', 'A3', 'C#4', 'F#4']),
    chord('Bm7', ['B2', 'F#3', 'A3', 'D4']),
    chord('Esus4', ['E3', 'A3', 'B3', 'E4']),
  ],
  night: [
    chord('Dsus2', ['D3', 'A3', 'E4']),
    chord('Bsus4', ['B2', 'F#3', 'E4']),
    chord('Asus2', ['A2', 'E3', 'B3']),
    chord('Esus4', ['E3', 'A3', 'B3']),
  ],
  predawn: [
    chord('Dmaj7', ['D3', 'A3', 'C#4', 'F#4']),
    chord('Aadd9', ['A2', 'E3', 'B3', 'C#4']),
    chord('Bm7', ['B2', 'F#3', 'A3', 'D4']),
    chord('E', ['E3', 'G#3', 'B3', 'E4']),
  ],
};

/** Chance of a generative note on a strong 8th, per phase (sparser at night). */
export const DENSITY: Record<PhaseName, number> = {
  golden: 0.3,
  dusk: 0.34,
  blue: 0.24,
  night: 0.15,
  predawn: 0.2,
};

/** Relative weight of each 8th in the bar: downbeats speak, off-beats mostly rest. */
export const STEP_WEIGHTS = [1.0, 0.3, 0.6, 0.35, 0.85, 0.3, 0.6, 0.45];

/**
 * May `midi` sound over `chord`? It must be a pentatonic note or a chord tone,
 * and must not sit a semitone above a chord tone (the classic avoid note)
 * unless it is itself part of the chord.
 */
export function isAllowed(midi: number, c: Chord): boolean {
  const p = pc(midi);
  if (c.tones.has(p)) return true;
  if (!PENTATONIC.has(p)) return false;
  return !c.tones.has((p + 11) % 12);
}

/** Closest allowed note to `midi` within [low, high]; ties resolve downward. */
export function nearestAllowed(midi: number, c: Chord, low: number, high: number): number {
  const start = Math.min(high, Math.max(low, Math.round(midi)));
  for (let d = 0; d <= 12; d++) {
    if (start - d >= low && isAllowed(start - d, c)) return start - d;
    if (start + d <= high && isAllowed(start + d, c)) return start + d;
  }
  return start;
}

/** All allowed notes for a chord within a range, ascending. */
export function allowedNotes(c: Chord, low: number, high: number): number[] {
  const out: number[] = [];
  for (let m = low; m <= high; m++) if (isAllowed(m, c)) out.push(m);
  return out;
}

/** Chord tones within a range, ascending. */
export function chordTones(c: Chord, low: number, high: number): number[] {
  const out: number[] = [];
  for (let m = low; m <= high; m++) if (c.tones.has(pc(m))) out.push(m);
  return out;
}

const TOUCH_LOW = noteToMidi('A2');
const TOUCH_HIGH = noteToMidi('B4');

/**
 * Water-touch note: horizontal touch position (0..1) mapped across two low
 * octaves of the scale. Whatever the position, the result is in key.
 */
export function touchNote(x01: number, c: Chord): number {
  const notes = allowedNotes(c, TOUCH_LOW, TOUCH_HIGH);
  const x = Math.min(1, Math.max(0, x01));
  return notes[Math.min(notes.length - 1, Math.floor(x * notes.length))];
}

/** A rising run of chord tones for the constellation-complete flourish. */
export function arpeggio(c: Chord, low: number, count: number): number[] {
  const tones = chordTones(c, low, low + 36);
  const out: number[] = [];
  for (let i = 0; i < count && i < tones.length; i++) out.push(tones[i]);
  return out;
}

const MELODY_LOW = noteToMidi('A3');
const MELODY_HIGH = noteToMidi('E6');
const MELODY_CENTRE = noteToMidi('D5');

/**
 * Sparse generative melody: a gentle random walk over the allowed notes that
 * prefers small steps, leans back toward the middle of its range and often
 * lands on chord tones.
 */
export class MelodyGenerator {
  private last = MELODY_CENTRE;

  constructor(private readonly rand: () => number) {}

  next(c: Chord): number {
    const notes = allowedNotes(c, MELODY_LOW, MELODY_HIGH);
    // Where are we on this chord's ladder?
    let index = 0;
    let best = Infinity;
    for (let i = 0; i < notes.length; i++) {
      const d = Math.abs(notes[i] - this.last);
      if (d < best) {
        best = d;
        index = i;
      }
    }
    // Step sizes with weights: mostly neighbours, sometimes a small leap.
    const r = this.rand();
    const step = r < 0.08 ? 0 : r < 0.6 ? 1 : r < 0.86 ? 2 : r < 0.96 ? 3 : 4;
    // Bias direction back toward the centre of the range.
    const pull = (MELODY_CENTRE - notes[index]) / 14;
    const up = this.rand() < 0.5 + Math.max(-0.38, Math.min(0.38, pull));
    index += up ? step : -step;
    if (index < 0) index = -index;
    if (index >= notes.length) index = 2 * (notes.length - 1) - index;
    index = Math.min(notes.length - 1, Math.max(0, index));
    let note = notes[index];

    // Often settle onto a neighbouring chord tone.
    if (!c.tones.has(pc(note)) && this.rand() < 0.5) {
      for (const j of [index - 1, index + 1]) {
        if (j >= 0 && j < notes.length && c.tones.has(pc(notes[j]))) {
          note = notes[j];
          break;
        }
      }
    }
    this.last = note;
    return note;
  }
}

/** Next grid line at or after `time` (seconds), for a grid of `interval` seconds. */
export function quantize(time: number, interval: number): number {
  return Math.ceil(time / interval - 1e-9) * interval;
}
