# Credits

## Audio samples

All sampled instruments (harp, glockenspiel, marimba, upright piano) come from
**VSCO 2 Community Edition** by Versilian Studios (recorded by Sam Gossner and
Simon Dalzell, sample cutting by Elan Hickler / Soundemote).

- Source: https://github.com/sgossner/VSCO-2-CE
- Licence: **CC0 1.0 Universal** (public domain dedication). Verified on 2026-11-11 from the repository's `LICENSE` file and GitHub licence metadata. No attribution is required; it is given here gladly.

Files in `public/audio/` were trimmed, faded, peak-normalised and encoded to MP3 from:

| Instrument | Source folder | Notes used |
|---|---|---|
| Harp | `Strings/Harp` (`KSHarp_*_mf`) | D2 A2 E3 B3 D4 A4 E5 B5 D6 A6 |
| Soft piano | `Keys/Upright Nr1` (`UR1_*_mf`) | C2 G2 C3 G3 C4 G4 C5 G5 C6 G6 |
| Glockenspiel | `Percussion/Glock` (`glock_medium_*`) | named G4 to C7, sounding G5 to C8 |
| Marimba | `Percussion/Marimba` (`Marimba_hit_Outrigger_*`) | named C2 to B4, sounding C3 to B5 |

Glockenspiel and marimba files sound one octave above their original file names; they are renamed to their true pitch here.

Pad, water, wind and the fallback bell are synthesised with Tone.js.

## Libraries

- three.js (MIT)
- Tone.js (MIT)
