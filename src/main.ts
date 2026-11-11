import { Scene } from 'three';
import { DEBUG_TIME_SCALE, type QualityTier } from './config';
import { CameraRig, type FollowTarget } from './render/camera';
import { RenderPipeline } from './render/renderer';
import { Ridges } from './render/ridges';
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
scene.add(sky.mesh, stars.group, ridges.group, water.mesh);

const rig = new CameraRig();
const followTarget: FollowTarget = { x: 0, z: 0, heading: 0 };

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

// Debug: T toggles a x20 fast-forward of the day cycle.
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyT' && !e.repeat) {
    cycle.timeScale = cycle.timeScale === 1 ? DEBUG_TIME_SCALE : 1;
    console.info(`[celestial] time x${cycle.timeScale} (${cycle.phaseName})`);
  }
});

let last = performance.now();
let elapsed = 0;
let raf = 0;

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  elapsed += dt;

  cycle.update(dt);
  updateSkyUniforms(skyUniforms, cycle);
  rig.update(dt, elapsed, followTarget);
  const camera = rig.camera;

  sky.update(cycle);
  stars.update(dt, elapsed, cycle, camera);
  ridges.update(camera);
  water.update(elapsed, cycle, camera);

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
  (window as unknown as Record<string, unknown>).__cs = { cycle, pipeline, stars, water, rig, scene, setQuality };
}
