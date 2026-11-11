# Celestial Sea: progress

Running record so a later session can pick up without re-reading everything. See `SPEC.md` for the full brief.

## Status

| Milestone | State |
|---|---|
| 1. Scene | Done |
| 2. Boat and controls | Done |
| 3. Audio engine | In progress |
| 4. Lanterns and constellations | Not started |
| 5. Polish and ship | Not started |

## How to run

```bash
npm install
npm run dev        # dev server
npm run build      # typecheck + production build to dist/
npm test           # unit tests (vitest)
```

Debug: `T` toggles a x20 fast-forward of the day cycle. In dev builds `window.__cs` exposes the cycle, pipeline, boat, etc. (`__cs.cycle.setTime(seconds)`, `__cs.setQuality('low')`, `__cs.step(seconds)` to advance the simulation in fixed steps without waiting on real time).

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

## Decisions worth knowing

- **Draw order:** sky (opaque, first) -> stars -> ridges -> water -> effects. Stars, ridges and water are in the transparent queue so `renderOrder` controls this; water uses `NoBlending` and still writes depth.
- **Fog:** there is no `scene.fog`. Water computes its own haze toward `skyHorizon(dir)`; ridges use per-layer haze.
- **Tone mapping** is done in the final pass (ACES), not by three.js; `renderer.toneMapping` stays off. All scene shaders output linear HDR.
- **Bloom** is custom (cheaper than `UnrealBloomPass`); levels per tier are in `QUALITY`.
- Sun reflection on water is analytic (glitter), not part of the planar pass.
- **Mirror camera:** three.js removes scale (so also a mirror) from camera view matrices in `Camera.updateMatrixWorld`. The reflection camera therefore has `matrixWorldAutoUpdate = false` and both of its matrices are written by hand in `Water.renderReflection`.
- **Headings:** 0 faces -Z, positive turns toward +X; forward is `(sin h, 0, -cos h)`.

## Known issues / to check on device

- Not yet run on a real iPhone. MSAA on a half-float render target and the half-float bloom chain should be confirmed in iOS Safari.
- Auto quality (frame-time based tier switching) is milestone 5; for now the tier is fixed at `high`.
