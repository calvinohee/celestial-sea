import { describe, expect, it } from 'vitest';
import { PHASES } from '../src/config';
import {
  allowedNotes,
  arpeggio,
  chordTones,
  isAllowed,
  isInKey,
  MelodyGenerator,
  midiToNote,
  nearestAllowed,
  noteToMidi,
  PROGRESSIONS,
  quantize,
  touchNote,
} from '../src/audio/theory';
import { mulberry32 } from '../src/util/noise';

const allChords = Object.values(PROGRESSIONS).flat();

describe('music theory', () => {
  it('converts note names and MIDI both ways', () => {
    expect(noteToMidi('A4')).toBe(69);
    expect(noteToMidi('C4')).toBe(60);
    expect(midiToNote(69)).toBe('A4');
    expect(midiToNote(noteToMidi('F#3'))).toBe('F#3');
  });

  it('has a progression for every phase, built only from notes in the key', () => {
    for (const phase of PHASES) {
      const chords = PROGRESSIONS[phase.name];
      expect(chords.length).toBeGreaterThanOrEqual(3);
      for (const chord of chords) for (const note of chord.pad) expect(isInKey(note)).toBe(true);
    }
  });

  it('night chords are open: no thirds above the root', () => {
    for (const chord of PROGRESSIONS.night) {
      const root = chord.pad[0] % 12;
      for (const tone of chord.tones) {
        const interval = (tone - root + 12) % 12;
        expect([3, 4]).not.toContain(interval);
      }
    }
  });

  it('every water-touch position gives an in-key, allowed, low note', () => {
    for (const chord of allChords) {
      for (let i = 0; i <= 200; i++) {
        const note = touchNote(i / 200, chord);
        expect(isInKey(note)).toBe(true);
        expect(isAllowed(note, chord)).toBe(true);
        expect(note).toBeGreaterThanOrEqual(noteToMidi('A2'));
        expect(note).toBeLessThanOrEqual(noteToMidi('B4'));
      }
      // Position maps monotonically to pitch.
      expect(touchNote(0, chord)).toBeLessThan(touchNote(1, chord));
      expect(touchNote(-5, chord)).toBe(touchNote(0, chord));
      expect(touchNote(9, chord)).toBe(touchNote(1, chord));
    }
  });

  it('never allows a note a semitone above a chord tone unless it is in the chord', () => {
    for (const chord of allChords) {
      for (const note of allowedNotes(chord, 36, 96)) {
        const pc = note % 12;
        if (!chord.tones.has(pc)) expect(chord.tones.has((pc + 11) % 12)).toBe(false);
        expect(isInKey(note)).toBe(true);
      }
    }
  });

  it('generative melody stays in key and in range over every chord', () => {
    const melody = new MelodyGenerator(mulberry32(1234));
    const low = noteToMidi('A3');
    const high = noteToMidi('E6');
    for (let round = 0; round < 40; round++) {
      for (const chord of allChords) {
        for (let i = 0; i < 25; i++) {
          const note = melody.next(chord);
          expect(isInKey(note)).toBe(true);
          expect(isAllowed(note, chord)).toBe(true);
          expect(note).toBeGreaterThanOrEqual(low);
          expect(note).toBeLessThanOrEqual(high);
        }
      }
    }
  });

  it('melody moves mostly by small steps', () => {
    const melody = new MelodyGenerator(mulberry32(99));
    const chord = PROGRESSIONS.dusk[0];
    let prev = melody.next(chord);
    let big = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const note = melody.next(chord);
      if (Math.abs(note - prev) > 9) big++;
      prev = note;
    }
    expect(big / n).toBeLessThan(0.1);
  });

  it('arpeggio and chord tones are ascending chord notes', () => {
    for (const chord of allChords) {
      const run = arpeggio(chord, noteToMidi('D4'), 7);
      expect(run.length).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < run.length; i++) {
        expect(chord.tones.has(run[i] % 12)).toBe(true);
        if (i > 0) expect(run[i]).toBeGreaterThan(run[i - 1]);
      }
      expect(chordTones(chord, noteToMidi('D6'), noteToMidi('B6')).length).toBeGreaterThan(0);
      expect(chordTones(chord, noteToMidi('D4'), noteToMidi('A5')).length).toBeGreaterThan(0);
      expect(allowedNotes(chord, noteToMidi('D7'), noteToMidi('B7')).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('nearestAllowed snaps into the allowed set', () => {
    for (const chord of allChords) {
      for (let m = 40; m < 90; m++) expect(isAllowed(nearestAllowed(m, chord, 36, 96), chord)).toBe(true);
    }
  });

  it('quantises to the next 8th note at 60 BPM', () => {
    expect(quantize(0.01, 0.5)).toBe(0.5);
    expect(quantize(0.5, 0.5)).toBe(0.5);
    expect(quantize(1.26, 0.5)).toBe(1.5);
  });
});
