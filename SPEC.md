# Celestial Sea: build spec

Working title. A calm 3D relaxation game for iPhone and MacBook. You guide a small glowing boat across a quiet sea at dusk. Lanterns you release drift up and become stars, which link into your own constellations. Every action adds to a soft, generative soundtrack. No score, no fail state, no timers, no text beyond a title card and settings.

Read this whole file before writing code. Keep `PROGRESS.md` updated as you go (what's done, what's next, known issues) so a later session can pick up without re-reading everything.

---

## 1. Platform and stack

- **Web app / PWA.** Must run in Safari on iPhone (installed to Home Screen) and in Safari/Chrome on an M1 Max MacBook.
- **Stack:** Vite + TypeScript + three.js + Tone.js. No other frameworks. Minimal dependencies.
- **Deploy:** GitHub Pages via a GitHub Actions workflow. Use a relative `base` in Vite so it works under a repo subpath.
- **PWA:** `vite-plugin-pwa`. Manifest, icons (generate a simple icon procedurally: sunset gradient circle with a single star), offline caching of all assets including audio samples. `apple-mobile-web-app-capable`, status bar style black-translucent, full-screen, respect safe-area insets.
- Prevent page scroll, pinch-zoom, double-tap zoom, text selection and iOS rubber-banding on the canvas.

## 2. Look and feel

Reference mood: a hazy sunset over water seen from a height. Soft, painterly, matte. Nothing glossy or neon. Journey-like restraint: big gradients, simple silhouettes, light doing the work.

### 2.1 Sky

- Full-screen sky dome with a custom shader: **multi-stop vertical gradient** (6 stops) plus a sun glow term.
- The hottest colour sits in a **narrow band at the horizon around the sun**; the gradient spreads wide above it.
- Sun: disc partly sunk behind the ridges, soft bloom, colour driven by the palette.
- Stars: fade in from blue hour onward. Several thousand point stars with subtle twinkle, plus a faint Milky Way band (noise-based, low contrast) and one or two very soft nebula wisps in violet/teal.
- Occasional shooting star at night (every 40 to 90 s, random).
- Expose the sky colour function so the water shader and fog can sample the same values.

### 2.2 Distant ridges

- Three or four layered mountain silhouettes on the horizon, generated from 1D noise ridgelines (flat meshes or cards at increasing distance).
- **Aerial perspective:** each farther layer is lighter and tinted toward the current horizon colour. Nearest layer darkest.
- Ridges are silhouettes only, no texture detail.

### 2.3 Water

- Large plane, gentle slow swell (low amplitude), fine ripple normals from scrolling noise.
- **Reflection:** evaluate the sky colour function analytically along the reflected view vector, then soften/blur it. Matte, hazy reflection, not a mirror.
- **Light reflections** (sun, lanterns, bright stars, boat glow): half-resolution planar reflection render target, blurred, blended on top. Must be switchable off on the low quality tier.
- Fresnel: water darker looking down, brighter toward horizon.
- Bioluminescence: touching/disturbing the water spawns soft cyan-teal glow rings that expand and fade over ~3 s. Boat wake leaves a faint glowing trail at dusk and night (fades with daylight).

### 2.4 Atmosphere

- Distance fog tinted to the current horizon colour, so sea, ridges and sky blend at the horizon.
- Light bloom (UnrealBloomPass or a cheaper custom bloom), subtle. Gentle vignette. Very light film grain optional (off on low tier).
- Tone mapping: ACES or AgX, tuned so pinks and oranges stay saturated without clipping.

### 2.5 Boat

- Small, simple stylised boat (low-poly, a few hundred triangles at most) with a lantern on a short mast. Warm glow from the lantern.
- Bobs and rolls gently with the swell.
- Camera: third person, low and behind, slight offset, smooth damped follow, slow drift. Horizon roughly one third up the screen so the sky dominates.

## 3. Day cycle (fixed loop)

Fixed 20-minute loop. **Every session starts at golden hour.** Palettes blend smoothly (smoothstep between keyframes); nothing snaps.

| Phase | Duration | Notes |
|---|---|---|
| Golden hour | 3 min | Warm, hazy, the reference photo |
| Dusk | 6 min | Hero state. Vivid pink and orange, longest phase |
| Blue hour | 3 min | Colour drains, first stars |
| Night | 6 min | Full stars, Milky Way, bioluminescence strongest |
| Pre-dawn | 2 min | Navy to teal to faint rose, then loops to golden hour |

Palettes (zenith → horizon, then ridges near → far). Starting points; tune by eye.

| Phase | Zenith | Upper | Mid | Lower | Near horizon | Horizon/sun | Ridges |
|---|---|---|---|---|---|---|---|
| Golden hour | #8F97AA | #B9B4B4 | #E6D6BC | #F3C38C | #EE8E4A | #E2553A | #4A5266 → #7D8498 |
| Dusk | #0B1030 | #1E3A6E | #7A5C9E | #E86A92 | #F5A15A | #E8533A | #3A4560 → #6B7590 |
| Blue hour | #0A1238 | #1F3A72 | #4E5F9C | #9C78A6 | #D38E86 | #C9645A | #222A44 → #46507A |
| Night | #03050C | #070D22 | #0B1634 | #122046 | #1A2A55 | #22305E | #05070F → #0E1428 |
| Pre-dawn | #070C24 | #14285A | #2C5470 | #5E8A92 | #C9A3A6 | #E4A88E | #1C2238 → #3E4A66 |

Expose the loop length and phase durations as constants in one config file.

## 4. Interaction

Keep it to a handful of gestures. Everything should feel slow and forgiving.

### iPhone
- **Touch and hold / drag:** boat glides toward the touched point on the water (raycast to water plane). Slow acceleration, slow turning.
- **Short tap:** release a lantern from the boat.
- Any touch on the water also spawns a bioluminescent ripple and a soft note (see audio).

### Mac
- Same mouse behaviour (click-hold to steer, click to release lantern).
- Also: WASD/arrow keys to steer, Space to release a lantern.

### Lanterns, stars, constellations
- A released lantern rises slowly (~6 to 10 s), sways, then settles into the sky and becomes a star (a brighter, warmer star than the background).
- Each new player star links to the previous one with a faint line, forming a constellation. After **5 to 7 stars** the constellation completes: lines brighten, gentle shimmer, a chord swell plays, and the next lantern starts a new constellation.
- Completed constellations slowly drift/rotate overhead with the sky.
- **Persistence:** save player constellations in localStorage (wrap in try/catch) so the sky accumulates across sessions. Cap at ~30 constellations; oldest fade out gracefully.
- Lanterns are always allowed; no resources or limits. Rate-limit to one per ~1.5 s so spam stays calm.

### UI
- Start screen: title fades in over the sky, "Tap to begin" (needed to unlock audio on iOS). Fades out on tap.
- One small, low-opacity settings button in a corner. Panel: music volume, effects volume, ambience volume, quality (Auto / High / Low), 30 fps battery mode, "Clear my sky" (with confirm).
- Persist settings in localStorage.
- No HUD otherwise.

## 5. Audio

**Top priority: it must sound good.** Soft, warm, spacious, never harsh, never clicky, never cluttered. Think ambient album, not game bleeps. If a sound feels synthetic or grating, remove or soften it.

### 5.1 Sources
- **Melodic layer uses real sampled instruments**, played through `Tone.Sampler`: harp, celesta or glockenspiel (soft), felt/soft piano, and a soft string or choir pad if available.
- Source only **CC0 or clearly attributable free licences**. Candidates to check: VSCO 2 Community Edition (Versilian, CC0), Salamander Grand Piano (CC-BY, needs credit), Freesound CC0 samples. **Verify each licence before using it** and record source + licence in `CREDITS.md`, shown in the settings panel.
- Keep total sample payload under ~15 MB. Use a sparse set of sampled notes (every 3rd or 4th semitone) and let the sampler repitch. Compress to AAC/m4a or MP3 (Safari-safe).
- Synthesis only for atmosphere: pads, water, wind.
- Fallback if samples fail to load: soft FM bell / sine pluck with slow attack, never raw saw or square waves.

### 5.2 Layers
1. **Ambience:** water lapping (filtered noise with slow amplitude and filter modulation), faint wind. Very quiet. Night adds a softer, darker bed.
2. **Pad:** slow-attack (2 to 4 s) warm pad, heavily low-passed, playing the current chord. Chord changes every 8 to 16 s.
3. **Generative melody:** sparse notes from the current scale on a slow grid, even when idle, so the scene is never silent. Density follows the phase (sparser at night).
4. **Interaction sounds:**
   - Water touch: soft low note (kalimba/harp/marimba-like), pitch mapped from touch position, always in scale.
   - Lantern release: harp pluck.
   - Star settles: celesta/glockenspiel note.
   - Constellation complete: swelled chord (pad + harp arpeggio), 4 to 6 s.
   - Shooting star: very soft high shimmer.

### 5.3 Musical rules
- One key throughout (e.g. D major), using pentatonic or Lydian notes only. Nothing the player does can produce a wrong note.
- Tempo ~60 BPM. Quantise interaction notes to the next 8th note, with slight humanised timing and velocity.
- Each phase has its own short chord progression (golden hour warmer, night more open and suspended). Change chords only on bar lines.
- Voice cap: max ~8 simultaneous melodic notes; drop the oldest/quietest.
- Velocity ceiling so no single note jumps out.

### 5.4 Mix
- Large reverb (decay 6 to 10 s, wet ~0.35 to 0.45) on melodic and pad buses. Optional subtle feedback delay on the melody.
- Gentle high-shelf cut above ~8 kHz on the melodic bus. Low-cut below ~60 Hz.
- Master: compressor (gentle ratio) then limiter at about -1 dB. No clipping, ever.
- All gain changes use ramps (no clicks). Fade master in over 3 s on start.

### 5.5 iOS audio
- Start Tone's context on the first tap.
- If `navigator.audioSession` exists, set `type = 'playback'` so the ringer switch doesn't mute audio.
- On `visibilitychange` to hidden: fade out and suspend audio, stop the render loop. Resume (with fade in) when visible.

## 6. Performance

- Targets: 60 fps on the Mac; 60 fps on a recent iPhone at Auto quality, with 30 fps battery mode available.
- Cap device pixel ratio (2 on High, 1.25 to 1.5 on Low).
- **Auto quality:** measure frame times over a rolling window; step down (DPR, planar reflection off, bloom cheaper, fewer particles, grain off) if sustained below target, step up cautiously if headroom.
- Budgets (High): ≤ ~150 draw calls; background stars as one Points object; particles pooled; no per-frame allocations in the render loop.
- Pause rendering when hidden.
- Test with Safari's Web Inspector on the iPhone if possible; otherwise test in Safari on the Mac with responsive mode and a throttled DPR.

## 7. Project structure

```
/
  index.html
  vite.config.ts
  SPEC.md
  PROGRESS.md
  CREDITS.md
  public/
    audio/            (samples)
    icons/
  src/
    main.ts           (bootstrap, start screen, loop)
    config.ts         (cycle timings, palettes, tunables)
    time/dayCycle.ts  (phase, blend factors, current palette)
    render/
      renderer.ts     (renderer, post-processing, quality tiers)
      sky.ts          (+ shaders)
      water.ts        (+ shaders)
      ridges.ts
      stars.ts        (background stars, Milky Way, shooting stars)
      boat.ts
      camera.ts
      ripples.ts
    game/
      input.ts        (touch, mouse, keyboard)
      lanterns.ts
      constellations.ts
      persistence.ts
    audio/
      engine.ts       (Tone setup, buses, mix)
      instruments.ts  (samplers, synths, fallbacks)
      music.ts        (scales, chords, generative melody, quantising)
      ambience.ts
    ui/
      settings.ts
      startScreen.ts
  .github/workflows/deploy.yml
```

## 8. Build order

Work through milestones in order. Each must run in the browser before moving on. Commit after each.

1. **Scene:** Vite/TS scaffold, sky shader, ridges, water, fog, bloom, day cycle with all palettes. Add a debug key (e.g. `T`) to fast-forward time ×20 for checking transitions.
2. **Boat and controls:** boat, bobbing, camera, touch/mouse/keyboard steering, ripples, wake.
3. **Audio engine:** start screen + unlock, ambience, pad, generative melody, interaction sounds, mix chain, sample loading and fallback, iOS handling.
4. **Lanterns and constellations:** release, rise, settle, linking, completion, drift, persistence.
5. **Polish and ship:** settings panel, auto quality, PWA/offline, icons, safe areas, deploy workflow, `CREDITS.md`.

If time is short, stop at a clean milestone boundary and update `PROGRESS.md` rather than leaving half-built features.

## 9. Acceptance criteria

- Loads and runs on iPhone Safari and Mac Safari/Chrome; installs to the iPhone Home Screen and works offline after first load.
- Golden hour on start; all five phases visibly distinct; transitions smooth with no snapping.
- Sky, water and fog colours always agree at the horizon.
- Audio: no clicks, pops, clipping or harsh tones over a full 20-minute loop with heavy interaction. Every interaction note is in key.
- Constellations persist across reloads; "Clear my sky" works.
- No console errors. Stable frame rate on Auto with no visible stutter during palette changes.

## 10. Out of scope

Accounts, online features, scores, achievements, tutorials, text dialogue, ads, analytics, native app wrappers.
