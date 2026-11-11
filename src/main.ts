import { Scene } from 'three';
import { AudioEngine } from './audio/engine';
import { prefetchSamples } from './audio/instruments';
import { BOAT, DEBUG_TIME_SCALE, FRAME, LANTERN_COOLDOWN, type QualityTier } from './config';
import { Constellations, type Reservation } from './game/constellations';
import { Input } from './game/input';
import { Lanterns } from './game/lanterns';
import { loadSettings, loadSky, saveSettings } from './game/persistence';
import { AutoQuality, frameDue } from './render/autoQuality';
import { Boat } from './render/boat';
import { CameraRig } from './render/camera';
import { RenderPipeline } from './render/renderer';
import { Ridges } from './render/ridges';
import { Ripples, Wake } from './render/ripples';
import { createSkyUniforms, Sky, updateSkyUniforms } from './render/sky';
import { Stars } from './render/stars';
import { Water } from './render/water';
import { DayCycle } from './time/dayCycle';
import { SettingsPanel } from './ui/settings';
import { showStartScreen } from './ui/startScreen';
import { createNoiseTexture } from './util/noise';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const settings = loadSettings();
const audio = new AudioEngine();
audio.setVolume('music', settings.music);
audio.setVolume('effects', settings.effects);
audio.setVolume('ambience', settings.ambience);
prefetchSamples();

// Auto quality starts phones a notch lower and lets them earn the top tier.
const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const quality = new AutoQuality(settings.quality, coarsePointer ? 'medium' : 'high');

const cycle = new DayCycle();
const pipeline = new RenderPipeline(canvas);
const scene = new Scene();
const noise = createNoiseTexture();
const skyUniforms = createSkyUniforms(cycle);

const stars = new Stars();
const sky = new Sky(skyUniforms, noise, stars.skyRotation);
const ridges = new Ridges(skyUniforms);
const water = new Water(skyUniforms, noise, ridges.profile);
const ripples = new Ripples();
const wake = new Wake(noise);
const boat = new Boat();
const constellations = new Constellations(loadSky());
const lanterns = new Lanterns();
scene.add(
  sky.mesh,
  stars.group,
  constellations.group,
  ridges.group,
  water.mesh,
  wake.mesh,
  ripples.mesh,
  boat.group,
  boat.lights,
  lanterns.mesh,
);

const rig = new CameraRig();

let elapsed = 0;
let lastRelease = -Infinity;
/** When to play the constellation-complete swell (just after its last star lands). */
let fanfareAt = Infinity;

/** Release a lantern from the boat. Always allowed, but never faster than the calm rate limit. */
function releaseLantern(): boolean {
  if (elapsed - lastRelease < LANTERN_COOLDOWN || !lanterns.hasFree) return false;
  lastRelease = elapsed;
  const reservation = constellations.reserve(rig.camera, stars.quaternion, elapsed);
  lanterns.release(
    boat.lanternPosition,
    elapsed,
    reservation,
    Math.sin(boat.heading) * boat.speed,
    -Math.cos(boat.heading) * boat.speed,
  );
  ripples.spawn(boat.x, boat.z, 0.3, 0.6);
  audio.music?.lanternRelease();
  return true;
}

/** A lantern has reached its place: it becomes a star and links to the one before. */
function onLanternSettle(reservation: Reservation): void {
  const result = constellations.settle(reservation, elapsed);
  if (!result) return;
  audio.music?.starSettle();
  if (result.fanfare) fanfareAt = elapsed + 0.9;
}

const input = new Input(canvas, rig.camera, {
  onWaterTouch(x, z, screenX) {
    ripples.spawn(x, z, 1, 1);
    audio.music?.waterTouch(screenX);
  },
  onRelease() {
    releaseLantern();
  },
  onKey(code) {
    // Debug: T toggles a x20 fast-forward of the day cycle.
    if (code === 'KeyT') {
      cycle.timeScale = cycle.timeScale === 1 ? DEBUG_TIME_SCALE : 1;
      console.info(`[celestial] time x${cycle.timeScale} (${cycle.phaseName})`);
    }
    if (import.meta.env.DEV) {
      // Audition sounds on demand; C clears the sky without the confirm step.
      if (code === 'Digit1') audio.music?.starSettle();
      if (code === 'Digit2') audio.music?.constellationComplete();
      if (code === 'Digit3') stars.triggerShootingStar(rig.camera);
      if (code === 'KeyC') constellations.clear(elapsed);
    }
  },
});

stars.onShootingStar = () => audio.music?.shootingStar();
canvas.addEventListener('pointerdown', () => audio.ensureRunning());

const settingsPanel = new SettingsPanel(ui, settings, {
  onChange(s, key) {
    if (key === 'music' || key === 'effects' || key === 'ambience') audio.setVolume(key, s[key]);
    if (key === 'quality') setQuality(quality.setMode(s.quality));
    if (key === 'battery') quality.reset();
    saveSettings(s);
  },
  onClearSky() {
    constellations.clear(elapsed);
  },
  onOpenChange(open) {
    // Steering and lanterns pause while the panel is up; the world carries on.
    input.enabled = !open;
  },
});

// Title card. The first tap unlocks audio (required on iOS), then play begins.
showStartScreen(ui, () => {
  void audio.start();
  settingsPanel.show();
  // Enable input a moment later so the starting tap is not also a lantern.
  window.setTimeout(() => {
    if (!settingsPanel.open) input.enabled = true;
  }, 450);
});

function setQuality(tier: QualityTier): void {
  pipeline.setQuality(tier);
  water.reflections = pipeline.settings.reflections;
  stars.setCount(pipeline.settings.stars);
}

pipeline.onResize = (bw, bh, pixelRatio) => {
  rig.setAspect(bw / bh);
  water.setSize(bw, bh);
  stars.setPixelRatio(pixelRatio);
  constellations.setResolution(bw, bh, pixelRatio);
};
pipeline.resize();
setQuality(quality.tier);

const onViewportChange = (): void => {
  pipeline.resize();
  quality.reset();
};
window.addEventListener('resize', onViewportChange);
window.visualViewport?.addEventListener('resize', onViewportChange);

/** Distance from the boat's centre back to its stern, and forward to its bow. */
const STERN_OFFSET = 2.1;
const BOW_OFFSET = 1.9;

// The boat sheds its own faint rings: at the bow under way, and now and then at rest.
let bowRippleTimer = 0;
function updateBoatRipples(dt: number): void {
  const speed01 = boat.speed / BOAT.maxSpeed;
  bowRippleTimer -= dt * (0.25 + speed01 * 1.4);
  if (bowRippleTimer > 0) return;
  bowRippleTimer = 1.1 + Math.random() * 0.5;
  const ahead = speed01 > 0.08 ? BOW_OFFSET : 0;
  ripples.spawn(
    boat.x + Math.sin(boat.heading) * ahead,
    boat.z - Math.cos(boat.heading) * ahead,
    0.12 + 0.2 * speed01,
    0.5 + 0.3 * speed01,
  );
}

let last = performance.now();
let raf = 0;

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  // 60 fps (even on 120 Hz screens), or 30 in battery mode.
  const fps = settings.battery ? FRAME.batteryFps : FRAME.fps;
  const since = now - last;
  if (!frameDue(since, fps)) return;
  last = now;

  const tier = quality.sample(since / 1000, 1 / fps);
  if (tier) setQuality(tier);
  tick(Math.min(0.1, Math.max(0, since / 1000)));
}

function tick(dt: number): void {
  elapsed += dt;

  cycle.update(dt);
  updateSkyUniforms(skyUniforms, cycle);
  audio.setPhase(cycle.phaseName, cycle.darkness);

  input.update();
  boat.update(dt, elapsed, input.steer, cycle);
  rig.update(dt, elapsed, boat);
  const camera = rig.camera;

  sky.update(cycle);
  stars.update(dt, elapsed, cycle, camera);
  lanterns.update(elapsed, camera, stars.quaternion, 0.8 + 0.2 * cycle.darkness, onLanternSettle);
  constellations.update(elapsed, cycle, camera, stars.quaternion);
  if (elapsed >= fanfareAt) {
    fanfareAt = Infinity;
    audio.music?.constellationComplete();
  }
  ridges.update(camera);
  water.update(elapsed, cycle, camera);
  water.setLamp(boat.lanternPosition, boat.lanternLight);
  updateBoatRipples(dt);
  ripples.update(elapsed, cycle);
  wake.update(
    elapsed,
    boat.x - Math.sin(boat.heading) * STERN_OFFSET,
    boat.z + Math.cos(boat.heading) * STERN_OFFSET,
    boat.heading,
    boat.speed / BOAT.maxSpeed,
    cycle,
  );

  pipeline.renderer.info.reset();
  water.renderReflection(pipeline.renderer, scene, camera);
  pipeline.render(scene, camera, cycle.exposure, elapsed);
}

function start(): void {
  if (raf) return;
  quality.reset();
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function stop(): void {
  cancelAnimationFrame(raf);
  raf = 0;
}

// Hidden: stop rendering, fade and suspend audio. Visible: pick both back up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stop();
    audio.suspend();
  } else {
    start();
    audio.resume();
  }
});

start();

if (import.meta.env.DEV) {
  // Handy handles for poking at the scene from the console.
  (window as unknown as Record<string, unknown>).__cs = {
    cycle,
    pipeline,
    stars,
    water,
    rig,
    scene,
    boat,
    input,
    ripples,
    audio,
    constellations,
    lanterns,
    releaseLantern,
    settings,
    quality,
    settingsPanel,
    /** Simulation clock in seconds. */
    get elapsed() {
      return elapsed;
    },
    setQuality,
    /** Advance the simulation by `seconds` in fixed steps (browser-independent testing). */
    step(seconds: number, fps = 60) {
      for (let i = 0; i < Math.round(seconds * fps); i++) tick(1 / fps);
    },
  };
}
