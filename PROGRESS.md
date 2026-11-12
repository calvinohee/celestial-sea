# Celestial Sea: progress

Running record so a later session can pick up without re-reading everything. See `SPEC.md` for the full brief.

## Status

| Milestone | State |
|---|---|
| 1. Scene | Done |
| 2. Boat and controls | Done |
| 3. Audio engine | Done |
| 4. Lanterns and constellations | Done |
| 5. Polish and ship | Done and deployed (needs device testing) |

## How to run

```bash
npm install
npm run dev        # dev server
npm run build      # typecheck + production build to dist/
npm test           # unit tests (vitest)
npm run icons      # redraw public/icons/*.png (procedural, no dependencies)
```

## Deploying

- **Live:** https://calvinohee.github.io/celestial-sea/
- **Repository:** https://github.com/calvinohee/celestial-sea (public)

`.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub Pages on every push to `main` (Pages source is set to "GitHub Actions"). First deployed 2026-11-12; checked live in Chrome: loads, starts, releases a lantern, service worker active with all 32 samples cached, console clean.

Commits use the GitHub no-reply address (set in this repository's git config); the first six local commits were rewritten to it before the first push, so earlier hashes quoted anywhere no longer exist.

The workflow run warns that `actions/checkout@v4`, `setup-node@v4`, `configure-pages@v5`, `upload-pages-artifact@v3` and `deploy-pages@v4` target the deprecated Node 20 runtime. It still passes; bump them when newer majors are confirmed.

## Milestone 1: Scene (done)

- Vite + TypeScript scaffold, relative `base`, no frameworks. Dependencies: `three`, `tone`.
- `src/config.ts`: every tunable (cycle timings, palettes, sky stops, ridges, swell, camera, quality tiers, post).
- `src/time/dayCycle.ts`: fixed 20 minute loop, starts at golden hour. Each phase holds its palette for a `hold` fraction, then smoothsteps into the next. Also blends sun elevation, disc, glow, star visibility, bioluminescence and exposure. Unit-tested for smoothness across the whole loop including the wrap.
- `src/render/sky.ts`: `SKY_GLSL` is the shared sky colour function (six-stop gradient, hot band localised around the sun's azimuth, sun glow, disc). Sky dome, water and ridges all include it and share one set of uniforms, so they agree at the horizon by construction. Milky Way band and two nebula wisps are added in the dome shader from a noise texture.
- `src/render/stars.ts`: 6000 stars in one `Points` (sorted brightest first so low tier just draws fewer), slow rotation about a pole, bright subset on `REFLECT_LAYER`, pooled shooting star every 40 to 90 s at night (`onShootingStar` hook).
- `src/render/ridges.ts`: four ridge rings from periodic 1D noise, far to near, analytic edge anti-aliasing, aerial perspective toward the horizon colour. Also bakes the ridgelines into a 1D texture the water uses to reflect them.
- `src/render/water.ts`: polar grid that follows the camera, swell shared with the CPU (`swell.ts`), ripple normals from a tiling noise texture, analytic matte sky reflection, reflected ridges, Fresnel, sun glitter road, horizon haze. Planar light reflection: half-res mirrored render of `REFLECT_LAYER`, blurred, added on top (off on low tier).
- `src/render/renderer.ts`: HDR scene target (MSAA on high), hand-rolled dual-filter bloom, final pass with exposure, vignette, ACES filmic, saturation, sRGB, dither and optional grain. `high` / `low` tiers.
- `src/render/camera.ts`: follow rig; pitch is derived from FOV so the horizon sits one third up the screen; wider FOV in portrait.

## Milestone 2: Boat and controls (done)

- `src/render/boat.ts`: procedural low-poly boat (233 triangles, one draw call) with thwarts, a short mast and a lantern cage; emissive lantern core, billboard glow (also on `REFLECT_LAYER`), and its own hemisphere / sun / lantern lights that follow the palette. Steering is slow and forgiving: limited acceleration, turn rate and turn acceleration, eases off near the target, coasts when released. Bob, pitch and roll come from `sampleSwell`, the CPU twin of the water shader's swell.
- `src/render/camera.ts` follows the boat (it implements `FollowTarget`): low and behind, slightly to one side, damped position and heading, slow idle sway.
- `src/game/input.ts`: pointer events for touch and mouse (hold / drag steers toward the raycast point on the water, a short tap fires `onRelease`), WASD / arrows, Space for `onRelease`, other keys go to `onKey`. Touching the sky still steers but makes no ripple. Blocks scroll, pinch, double-tap zoom, context menu and selection.
- `src/render/ripples.ts`: `Ripples` is a pool of 28 instanced bioluminescent rings (about 3 s each); `Wake` is a ribbon built from a ring buffer of stern positions, pale foam by day and cyan-teal as `cycle.glow` rises. Both ride the swell and use polygon offset instead of disabling depth, so the boat still occludes them.
- The lantern lights the water around the boat (term in the water shader) and is mirrored by the planar reflection pass.
- `onRelease` is rate-limited to one per 1.5 s already; the lantern itself is milestone 4.

## Milestone 3: Audio engine (done)

- `src/ui/startScreen.ts`: title card over the live sky; the first tap/click/Enter calls `audio.start()` inside the gesture (iOS unlock), then input is enabled 450 ms later.
- `src/audio/engine.ts`: context created on first tap (`latencyHint: 'playback'`). Buses: melody (+ dotted-eighth echo) and pad -> music volume; interaction sounds -> effects volume; ambience -> ambience volume. Melodic chain has a 60 Hz low-cut and -7 dB shelf above 8 kHz, dry + send to one 8 s reverb. Master: compressor -> limiter (-1 dB) -> soft ceiling -> 3 s fade in. `setVolume(kind, v)` ramps (ready for the settings panel). `navigator.audioSession.type = 'playback'`; hidden -> fade, suspend; visible -> resume, fade in; `ensureRunning()` on pointer down.
- `src/audio/instruments.ts`: `Tone.Sampler`s for harp, soft piano, glockenspiel, marimba (32 MP3s, 2.7 MB, in `public/audio/`, all CC0, see `CREDITS.md`). Soft FM bell fallback while loading or if loading fails. Voice cap of 8 (weakest released), velocity ceiling 0.62, duplicate-note guard. Pad is detuned triangles through a breathing low-pass.
- `src/audio/theory.ts` (pure, unit-tested): D Lydian / D pentatonic only, per-phase progressions, avoid-note rule, touch-note mapping, melody random walk. `src/audio/music.ts`: 60 BPM transport, chords change on bar lines every 2 to 4 bars, sparse generative melody (sparser at night), interaction sounds quantised to the next 8th.
- Wired now: water touch (marimba, pitch from screen x), tap/Space (harp pluck, rate-limited), shooting star (glock shimmer). `starSettle()` and `constellationComplete()` exist for milestone 4; in dev builds keys `1`, `2`, `3` audition star settle, constellation complete and a shooting star.
- `src/audio/ambience.ts`: stereo water lapping, faint wind, darker bed at night, all filtered noise with slow LFOs.

Measured in Chrome (dev meter after the master): idle about -30 dBFS RMS with peaks near -12; ambience alone about -40; a deliberately absurd stress run (a touch every 100 ms plus everything else) peaked at -2.9 dBFS with the voice cap holding at 8. Interaction notes landed within 8 ms of the 8th-note grid and every note was in key. Hide/show suspends and resumes the context. Blocking the sample files switches all four instruments to the fallback.

Console is clean in Chrome through start, play and a hide/show cycle (checked 2026-11-12). Two things fixed after the milestone commit:

- Tone's `The AudioContext is "suspended"...` warning fired once, just after the first tap: the pad's filter LFO was started in the `Instruments` constructor while `Tone.start()` was still resolving. It now starts in `Instruments.start()`, called once the context is running. Rule of thumb: construct nodes any time, but call `.start()` on sources, LFOs and the transport only after the `await` in `AudioEngine.start()`.
- With samples unavailable, flooding input made the fallback `PolySynth` log `Max polyphony exceeded`. The fallback now tracks how long each voice stays busy and silently skips notes before Tone's limit is reached. The only console output left in that case is one deliberate `[celestial] ... samples unavailable` warning per instrument.

## Milestone 4: Lanterns and constellations (done)

- `src/game/lanterns.ts`: pool of 10 lanterns, one instanced draw call (also on `REFLECT_LAYER`). A lantern inherits the boat's velocity, rises and sways on its own, then is drawn toward its reserved place: seen from the camera its direction eases to the star while its distance grows geometrically to 900 m, so it shrinks to a point exactly where the star will appear. Flight is 7.5 to 9 s; arrivals are forced into release order. The shader draws a small paper lantern up close and never lets it get smaller than a bright star.
- `src/game/constellations.ts`: everything is stored in the star frame, so finished constellations turn with the sky. `reserve()` picks the star's place at release time (so several lanterns in flight chain correctly): a new constellation starts in the emptiest visible patch; later stars step 5.5 to 10 degrees on from the previous one, turning up to about 80 degrees, scored to stay in view and clear of other stars. `settle()` adds the star and its thread, completes at the constellation's target (5 to 7, chosen at random), and returns whether to play the swell. If an unfinished constellation is out of view when the next lantern is released, it is closed as it stands and a new one begins in view. Stars are one `Points` (warm, larger than background stars, settle flash, completion shimmer); threads are screen-space ribbons in one mesh.
- Cap of 30: the oldest fades out over 4 s, then is dropped. `clear()` fades everything and empties storage at once.
- `src/game/persistence.ts`: `localStorage` key `celestial-sea.sky.v1`, every access in try/catch, loaded data validated and re-normalised. Saved on every settle. Only settled stars are saved; an unfinished constellation resumes next session.
- Wiring in `main.ts`: `releaseLantern()` (rate limit 1.5 s, needs a free pool slot) reserves, releases, ripples and plays the pluck; `onLanternSettle` plays the glockenspiel note and schedules the completion swell 0.9 s later.
- Dev key `C` clears the sky without the confirm step (the real control is "Clear my sky" in the settings panel).
- Tests: `tests/sky.test.ts` covers storage failure modes, 5 to 7 star constellations in landscape and portrait, in-flight chaining, the cap, resume after reload, clear, and the out-of-view case.

Checked in Chrome: flight path, linking, completion (8 releases gave 8 settle notes and 1 swell), reload restores the sky and resumes the unfinished constellation, clear empties sky and storage, console clean. Draw calls on high measured at 31 with lanterns in flight and constellations on screen (budget 150).

## Milestone 5: Polish and ship (done)

- `src/ui/settings.ts`: one quiet button in the top-right corner (safe-area aware, shown once play begins) and its panel: music / effects / ambience volume, quality (Auto / High / Low), 30 fps battery mode, "Clear my sky" with a confirm step, and credits rendered from `CREDITS.md` (imported with `?raw`, built as DOM nodes). Escape or a click outside closes it. While open, steering and lanterns are paused (`input.enabled = false`) but the world keeps running.
- Settings persist under `celestial-sea.settings.v1` (`loadSettings` / `saveSettings` in `persistence.ts`, validated, try/catch).
- `src/render/autoQuality.ts` (pure, unit-tested): `frameDue()` caps rendering at 60 fps even on 120 Hz screens, or 30 in battery mode. `AutoQuality` keeps a 90-frame rolling window; average frame time 22% over target for 2.5 s steps down one tier (high -> medium -> low); 25 s on target earns one step up, and if that step turns slow within 12 s it steps back and doubles the wait (up to 10 min). Stalls over 0.5 s and the first 2.5 s after any change are ignored. Touch devices start Auto on `medium`.
- New `medium` tier (DPR 1.5, no MSAA, reflections on, 4 bloom levels, no grain). Tier table is `QUALITY` in `config.ts`.
- PWA: `vite-plugin-pwa` generates the manifest (relative `start_url` / `scope`, `display: fullscreen`) and a Workbox service worker that precaches everything including all 32 samples (about 3.8 MB). Registered by the injected `registerSW.js`; production builds only.
- Icons: `scripts/make-icons.mjs` draws them (dusk-gradient circle with one star) and writes PNGs with a tiny built-in encoder. Output is committed in `public/icons/`.
- `input.ts`: the document-level touch blocking now lets touches through inside `[data-allow-touch]` (the panel), and keys are only swallowed while input is enabled, so sliders work by touch and keyboard.

Checked in Chrome: every control, settings and sky surviving reload, Escape, clear-with-confirm, all three tiers rendering and switching without errors. The production build was served under a subpath (`/celestial-sea/`): service worker active with the right scope, 42 cached entries of which 32 are samples; with the server then stopped the page reloaded, started, and loaded its samples from cache.

## Round 2: owner feedback (2026-11-12)

The owner asked for more boat detail, less motion (motion sickness), more water physics, a shorter day and a lantern mechanic that is not "press Space". Where these depart from `SPEC.md`, the owner's request wins.

- **Day length:** default 8 minutes, with 5 / 8 / 10 in settings (`dayMinutes`). `PHASES` in `config.ts` still describes a 20-minute reference timeline; `DayCycle` just moves through it faster (`loopMinutes`), so phase proportions are unchanged.
- **Comfort** (`COMFORT` in `config.ts`, applied by `applyComfort()` in `main.ts`): the camera has no yaw sway, a quarter of the old drift, and swings round at a capped, eased rate (0.2 rad/s; boat turns at up to 0.3). Boat bob / pitch / roll are 60% of before and the swell 80%. Camera sits a little higher and further back. **Reduce motion** in settings (on by default when the system asks for reduced motion) goes further: no drift, camera 0.11 rad/s, bob 25%, swell 50%, top speed 80%. The horizon never tilts in either mode. Swell height is one shared value (`swellScale` in `swell.ts`) used by every shader and by the CPU sampler.
- **Water physics** (`src/render/waterSim.ts`): a 256 x 256 height-field wave simulation over a 64 m patch that follows the boat in whole cells (128 on the low tier), stepped at a fixed 60 Hz. Touches, the hull (bow pushes up, stern pulls down, scaled by speed) and lantern lift-offs add impulses; waves spread, cross and are absorbed at the border. Wave speed (1.7 m/s) is below the boat's, so a V wake forms on its own. The water shader reads the field for its normals and makes steep wave faces glow (bioluminescence by night, a faint glint by day). The old periodic "fake" rings from the boat are gone; the glow rings on touch and the wake ribbon remain, the ribbon much fainter.
- **Lantern mechanic** (`src/game/floaters.ts`): seven unlit paper lanterns drift on the water, mostly ahead of the boat, never bunched, replaced as they fall behind. Glide within 4 m and one lights and rises (it drifts the last few metres toward the boat on its own). The first sits just off the bow so a straight course finds it. Tap and Space still release from the boat; all share the 1.5 s rate limit.
- **Boat** (`src/render/boat.ts`): three strakes of planking, gunwale rail, stem post, ribs, floorboards, two thwarts, stern seat, foredeck with cleat, rudder and tiller, shipped oars with rowlocks, a rope coil, a crate of spare paper lanterns, tapered mast with stays and a pennant, lantern finial. 905 triangles, still one draw call (the spec's "a few hundred" was relaxed on request).
- Settings gained `reduceMotion` and `dayMinutes`; older saved settings pick up defaults.

Checked in Chrome: camera yaw rate measured at exactly the cap in both modes (0.20 and 0.11 rad/s), boat roll under 1 degree in Reduce motion, a straight course lights the first lantern with no input, V wake by day and glowing arms by night, both new settings saved and applied, low and high tiers render (23 and 34 draw calls). 45 unit tests.

## Decisions worth knowing

- **Draw order:** sky (opaque, first) -> stars -> ridges -> water -> effects. Stars, ridges and water are in the transparent queue so `renderOrder` controls this; water uses `NoBlending` and still writes depth.
- **Fog:** there is no `scene.fog`. Water computes its own haze toward `skyHorizon(dir)`; ridges use per-layer haze.
- **Tone mapping** is done in the final pass (ACES), not by three.js; `renderer.toneMapping` stays off. All scene shaders output linear HDR.
- **Bloom** is custom (cheaper than `UnrealBloomPass`); levels per tier are in `QUALITY`.
- Sun reflection on water is analytic (glitter), not part of the planar pass.
- **Mirror camera:** three.js removes scale (so also a mirror) from camera view matrices in `Camera.updateMatrixWorld`. The reflection camera therefore has `matrixWorldAutoUpdate = false` and both of its matrices are written by hand in `Water.renderReflection`.
- **Headings:** 0 faces -Z, positive turns toward +X; forward is `(sin h, 0, -cos h)`.

## Known issues / to check on device

- **Comfort is tuned by numbers, not by a person who gets motion sick.** The owner needs to say whether the default is calm enough or whether Reduce motion should become the default.
- The wave simulation adds one 256 x 256 pass per frame and four texture reads per water pixel. Not profiled on a phone.
- The boat and floating lanterns ride the swell but not the simulated ripples (those only affect how the water is lit).

- Audio: the owner listened on 2026-11-12 and found it soothing. Not yet heard on an iPhone speaker, and nobody has sat through a full 20-minute loop listening for clicks.
- Constellations are placed for the screen shape in use. One built in landscape can run off the sides when viewed in portrait (only matters if the same saved sky is opened in both orientations).
- An unexplained event during this session emptied `node_modules/expect-type/dist` (vitest then fails to start). `rm -rf node_modules/expect-type && npm install` fixes it.

- Not yet run on a real iPhone. MSAA on a half-float render target and the half-float bloom chain should be confirmed in iOS Safari.
- **Auto quality has only been tested as logic** (synthetic frame times). Whether its thresholds feel right on a real iPhone, and whether tier switches cause a visible hitch, is unknown.
- **Install to Home Screen and offline are verified in Chrome only.** iOS Safari install, full-screen behaviour, safe areas with a notch, and the ringer-switch audio session all need a real phone.
- Nobody has run a full 20-minute loop start to finish in real time.
- `npm audit` reports moderate advisories in `vite-plugin-pwa`'s build-time dependencies (`glob` / `minimatch` via `workbox-build`). They run only during `npm run build` on patterns we control and ship nothing to players. The offered fix is a downgrade to 1.1.0; left alone on purpose.
- Sliders in the settings panel have not been dragged on a real touch screen.
