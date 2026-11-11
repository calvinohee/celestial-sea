import { Scene } from 'three';
import { BOAT, DEBUG_TIME_SCALE, LANTERN_COOLDOWN, type QualityTier } from './config';
import { Input } from './game/input';
import { Boat } from './render/boat';
import { CameraRig } from './render/camera';
import { RenderPipeline } from './render/renderer';
import { Ridges } from './render/ridges';
import { Ripples, Wake } from './render/ripples';
import { createSkyUniforms, Sky, updateSkyUniforms } from './render/sky';
import { Stars } from './render/stars';
import { Water } from './render/water';
import { DayCycle } from './time/dayCycle';
import { createNoiseTexture } from './util/noise';

const canvas = document.getElementById('scene') as HTMLCanvasElement;

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
scene.add(sky.mesh, stars.group, ridges.group, water.mesh, wake.mesh, ripples.mesh, boat.group, boat.lights);

const rig = new CameraRig();

let elapsed = 0;
let lastRelease = -Infinity;

const input = new Input(canvas, rig.camera, {
  onWaterTouch(x, z) {
    ripples.spawn(x, z, 1, 1);
  },
  onRelease() {
    // Lanterns arrive in milestone 4; the calm rate limit already applies.
    if (elapsed - lastRelease < LANTERN_COOLDOWN) return;
    lastRelease = elapsed;
  },
  onKey(code) {
    // Debug: T toggles a x20 fast-forward of the day cycle.
    if (code === 'KeyT') {
      cycle.timeScale = cycle.timeScale === 1 ? DEBUG_TIME_SCALE : 1;
      console.info(`[celestial] time x${cycle.timeScale} (${cycle.phaseName})`);
    }
  },
});
input.enabled = true;

function setQuality(tier: QualityTier): void {
  pipeline.setQuality(tier);
  water.reflections = pipeline.settings.reflections;
  stars.setCount(pipeline.settings.stars);
}

pipeline.onResize = (bw, bh, pixelRatio) => {
  rig.setAspect(bw / bh);
  water.setSize(bw, bh);
  stars.setPixelRatio(pixelRatio);
};
pipeline.resize();
setQuality('high');

window.addEventListener('resize', () => pipeline.resize());
window.visualViewport?.addEventListener('resize', () => pipeline.resize());

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
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  tick(dt);
}

function tick(dt: number): void {
  elapsed += dt;

  cycle.update(dt);
  updateSkyUniforms(skyUniforms, cycle);

  input.update();
  boat.update(dt, elapsed, input.steer, cycle);
  rig.update(dt, elapsed, boat);
  const camera = rig.camera;

  sky.update(cycle);
  stars.update(dt, elapsed, cycle, camera);
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
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function stop(): void {
  cancelAnimationFrame(raf);
  raf = 0;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
  else start();
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
    setQuality,
    /** Advance the simulation by `seconds` in fixed steps (browser-independent testing). */
    step(seconds: number, fps = 60) {
      for (let i = 0; i < Math.round(seconds * fps); i++) tick(1 / fps);
    },
  };
}
