import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Mesh,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { CONSTELLATIONS } from '../config';
import { REFLECT_LAYER } from '../render/stars';
import type { DayCycle } from '../time/dayCycle';
import { saveSky, type SavedConstellation, type SkyStore } from './persistence';

/** Just inside the background stars. */
const RADIUS = 7600;
/** Stand-in for "has not happened yet" in time attributes. */
const NEVER = 1e6;
/** Birth time for stars restored from storage: long settled. */
const LONG_AGO = -1e4;
const DEG = Math.PI / 180;

const MAX_STARS = (CONSTELLATIONS.max + 2) * CONSTELLATIONS.maxStars;

export interface Constellation {
  /** Star directions in the star frame (x, y, z per star), including ones still in flight. */
  dirs: number[];
  /** When each settled star appeared. `births.length` = settled count. */
  births: number[];
  /** Completes when this many stars have settled. */
  target: number;
  completedAt: number;
  removeAt: number;
  seed: number;
}

/** A place in the sky promised to a lantern that is still rising. */
export interface Reservation {
  constellation: Constellation;
  index: number;
  /** Star-frame direction. */
  dir: Vector3;
}

export interface SettleResult {
  completed: boolean;
  /** Whether the completion deserves the chord swell (tiny fragments finish quietly). */
  fanfare: boolean;
}

/** View geometry used to keep new stars where the player can see them. */
export interface ViewFrame {
  /** Unit, horizontal. */
  forward: Vector3;
  right: Vector3;
  /** Radians: half the horizontal field of view, and the elevation of the top of the screen. */
  halfWidth: number;
  top: number;
}

const _flat = new Vector3();

/** Azimuth (relative to the view, radians, + to the right) and elevation of a world direction. */
export function viewAngles(dir: Vector3, view: ViewFrame): { az: number; el: number } {
  _flat.set(dir.x, 0, dir.z);
  const az = Math.atan2(_flat.dot(view.right), _flat.dot(view.forward));
  return { az, el: Math.asin(Math.max(-1, Math.min(1, dir.y))) };
}

function angleBetween(ax: number, ay: number, az: number, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, ax * b.x + ay * b.y + az * b.z)));
}

const STAR_VERT = /* glsl */ `
attribute vec3 aTimes;  // birth, completed at, removed at
attribute float aSeed;
uniform float uTime;
uniform float uPixelRatio;
uniform float uBright;
uniform float uSize;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * ${RADIUS.toFixed(1)}, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 wdir = normalize(mat3(modelMatrix) * position);
  float extinction = smoothstep(0.0, 0.1, wdir.y);

  float age = uTime - aTimes.x;
  float appear = smoothstep(0.0, 0.45, age);
  float flash = exp(-max(age, 0.0) * 1.5) * 1.5;
  float c = uTime - aTimes.y;
  // On completion a wave of light runs along the constellation, then it rests a little brighter.
  float shimmer = c > 0.0 ? exp(-c * 0.5) * (0.5 + 0.5 * sin(c * 6.5 - aSeed * 1.6)) * 1.4 : 0.0;
  float done = smoothstep(0.0, 1.5, c) * 0.25;
  float gone = 1.0 - smoothstep(0.0, ${CONSTELLATIONS.fadeOut.toFixed(1)}, uTime - aTimes.z);
  float twinkle = 0.9 + 0.1 * sin(uTime * (1.0 + fract(aSeed * 0.37)) + aSeed * 5.0);

  float b = appear * (1.0 + flash + shimmer + done) * gone * extinction * twinkle * uBright;
  // Warmer than any background star: these were lanterns.
  vColor = vec3(1.0, 0.8, 0.52) * b;
  gl_PointSize = uSize * uPixelRatio * (1.0 + 0.3 * min(flash, 1.0) + 0.25 * shimmer);
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = max(1.0 - d, 0.0);
  float a2 = a * a;
  float core = a2 * a2;
  gl_FragColor = vec4(vColor * (a2 * 0.7 + core * core * 1.7), 1.0);
}
`;

// Links are screen-space ribbons a couple of pixels wide (GL lines are too thin on phones).
const LINE_VERT = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute vec2 aCorner;  // x: 0 at A, 1 at B; y: -1 or 1 across
attribute vec3 aTimes;   // birth of B, completed at, removed at
attribute float aSeed;
uniform vec2 uResolution;
uniform float uWidth;
varying vec2 vCorner;
varying vec3 vTimes;
varying float vSeed;
varying float vExtinction;
void main() {
  vCorner = aCorner;
  vTimes = aTimes;
  vSeed = aSeed;
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(aA * ${RADIUS.toFixed(1)}, 1.0);
  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB * ${RADIUS.toFixed(1)}, 1.0);
  vec3 wdir = normalize(mat3(modelMatrix) * mix(aA, aB, aCorner.x));
  vExtinction = smoothstep(0.0, 0.1, wdir.y);
  if (ca.w <= 0.0 || cb.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 half_ = uResolution * 0.5;
  vec2 sa = ca.xy / ca.w * half_;
  vec2 sb = cb.xy / cb.w * half_;
  vec2 dir = sb - sa;
  float len = max(length(dir), 1e-3);
  dir /= len;
  vec2 normal = vec2(-dir.y, dir.x);
  // Stop short of the stars themselves so the link reads as a thread between them.
  float gap = min(uWidth * 3.2, len * 0.3);
  vec4 c = mix(ca, cb, aCorner.x);
  vec2 offset = normal * (aCorner.y * uWidth * 0.5) + dir * (gap * (1.0 - 2.0 * aCorner.x));
  c.xy += offset / half_ * c.w;
  gl_Position = c;
}
`;

const LINE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vCorner;
varying vec3 vTimes;
varying float vSeed;
varying float vExtinction;
uniform float uTime;
uniform float uBright;
void main() {
  float across = 1.0 - abs(vCorner.y);
  // The thread is drawn from the older star to the new one as it settles.
  float age = uTime - vTimes.x;
  float reveal = smoothstep(vCorner.x - 0.12, vCorner.x, age / 1.3 - 0.12);
  float c = uTime - vTimes.y;
  float done = smoothstep(0.0, 1.5, c);
  float shimmer = c > 0.0 ? exp(-c * 0.5) * (0.5 + 0.5 * sin(c * 6.5 - (vSeed + vCorner.x) * 1.6)) : 0.0;
  float gone = 1.0 - smoothstep(0.0, ${CONSTELLATIONS.fadeOut.toFixed(1)}, uTime - vTimes.z);
  float a = across * reveal * gone * vExtinction * uBright * (0.2 + 0.24 * done + 0.75 * shimmer);
  gl_FragColor = vec4(vec3(1.0, 0.87, 0.68) * a, 1.0);
}
`;

/**
 * The player's sky: stars made from settled lanterns, the threads linking
 * them, completion, the cap with graceful fade-out, and saving.
 *
 * Everything lives in the star frame, so finished constellations turn slowly
 * overhead with the rest of the sky.
 */
export class Constellations {
  readonly group = new Group();
  readonly list: Constellation[] = [];

  private current: Constellation | null = null;
  private readonly points: Points;
  private readonly reflected: Points;
  private readonly lines: Mesh;
  private readonly starMaterial: ShaderMaterial;
  private readonly reflectMaterial: ShaderMaterial;
  private readonly lineMaterial: ShaderMaterial;

  private readonly starPos = new Float32Array(MAX_STARS * 3);
  private readonly starTimes = new Float32Array(MAX_STARS * 3);
  private readonly starSeed = new Float32Array(MAX_STARS);
  private readonly lineA = new Float32Array(MAX_STARS * 4 * 3);
  private readonly lineB = new Float32Array(MAX_STARS * 4 * 3);
  private readonly lineTimes = new Float32Array(MAX_STARS * 4 * 3);
  private readonly lineSeed = new Float32Array(MAX_STARS * 4);

  private readonly inverse = new Quaternion();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly east = new Vector3();
  private readonly north = new Vector3();
  private readonly view: ViewFrame = { forward: new Vector3(), right: new Vector3(), halfWidth: 0.4, top: 0.6 };

  constructor(
    saved: SavedConstellation[] = [],
    private readonly rand: () => number = Math.random,
    private readonly store?: SkyStore | null,
  ) {
    for (const s of saved) {
      const count = s.stars.length / 3;
      const c: Constellation = {
        dirs: s.stars.slice(),
        births: new Array<number>(count).fill(LONG_AGO),
        target: s.done ? count : Math.max(count, s.target),
        completedAt: s.done ? LONG_AGO : NEVER,
        removeAt: NEVER,
        seed: this.rand() * 100,
      };
      this.list.push(c);
      // An unfinished constellation picks up where it left off.
      if (!s.done && count < c.target) this.current = c;
    }

    const dynamic = (array: Float32Array, size: number) => {
      const a = new BufferAttribute(array, size);
      a.setUsage(DynamicDrawUsage);
      return a;
    };

    const starGeometry = new BufferGeometry();
    starGeometry.setAttribute('position', dynamic(this.starPos, 3));
    starGeometry.setAttribute('aTimes', dynamic(this.starTimes, 3));
    starGeometry.setAttribute('aSeed', dynamic(this.starSeed, 1));
    const starMaterial = (size: number, bright: number) =>
      new ShaderMaterial({
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: 1 },
          uBright: { value: bright },
          uSize: { value: size },
        },
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
    this.starMaterial = starMaterial(12, 1);
    this.points = new Points(starGeometry, this.starMaterial);
    this.points.frustumCulled = false;
    this.points.renderOrder = -87;
    // A softer copy for the water's reflection pass.
    this.reflectMaterial = starMaterial(9, 0.5);
    this.reflected = new Points(starGeometry, this.reflectMaterial);
    this.reflected.frustumCulled = false;
    this.reflected.layers.set(REFLECT_LAYER);

    const lineGeometry = new BufferGeometry();
    const corners = new Float32Array(MAX_STARS * 4 * 2);
    const index: number[] = [];
    for (let i = 0; i < MAX_STARS; i++) {
      corners.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
      const v = i * 4;
      index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
    // "position" is unused by the shader but three expects the attribute.
    lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(MAX_STARS * 4 * 3), 3));
    lineGeometry.setAttribute('aA', dynamic(this.lineA, 3));
    lineGeometry.setAttribute('aB', dynamic(this.lineB, 3));
    lineGeometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
    lineGeometry.setAttribute('aTimes', dynamic(this.lineTimes, 3));
    lineGeometry.setAttribute('aSeed', dynamic(this.lineSeed, 1));
    lineGeometry.setIndex(index);
    this.lineMaterial = new ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uBright: { value: 1 },
        uResolution: { value: new Vector2(1, 1) },
        uWidth: { value: 3 },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    this.lines = new Mesh(lineGeometry, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -88;

    this.group.add(this.lines, this.points, this.reflected);
    this.rebuild();
  }

  /** `width`/`height` are drawing-buffer pixels. */
  setResolution(width: number, height: number, pixelRatio: number): void {
    this.lineMaterial.uniforms.uResolution.value.set(width, height);
    this.lineMaterial.uniforms.uWidth.value = 1.7 * pixelRatio;
    this.starMaterial.uniforms.uPixelRatio.value = pixelRatio;
    this.reflectMaterial.uniforms.uPixelRatio.value = pixelRatio;
  }

  /** Total settled stars across the whole sky. */
  get starCount(): number {
    let n = 0;
    for (const c of this.list) n += c.births.length;
    return n;
  }

  // --- Placement ----------------------------------------------------------

  private readView(camera: PerspectiveCamera): ViewFrame {
    const v = this.view;
    camera.getWorldDirection(v.forward);
    const pitch = Math.asin(Math.max(-1, Math.min(1, v.forward.y)));
    v.forward.y = 0;
    v.forward.normalize();
    v.right.set(-v.forward.z, 0, v.forward.x);
    const halfFov = (camera.fov * DEG) / 2;
    v.halfWidth = Math.atan(Math.tan(halfFov) * camera.aspect);
    v.top = pitch + halfFov;
    return v;
  }

  /** World direction for a view-relative azimuth and elevation. */
  private fromView(view: ViewFrame, az: number, el: number, out: Vector3): Vector3 {
    const c = Math.cos(el);
    return out
      .copy(view.forward)
      .multiplyScalar(Math.cos(az) * c)
      .addScaledVector(view.right, Math.sin(az) * c)
      .setY(Math.sin(el));
  }

  /** Smallest angle from a world direction to any star already in the sky (radians). */
  private nearestStar(world: Vector3, skyRotation: Quaternion, only?: Constellation): number {
    // Compare in the star frame, where the stars are stored.
    const local = this.v3.copy(world).applyQuaternion(this.inverse.copy(skyRotation).invert());
    let best = Math.PI;
    for (const c of this.list) {
      if (only && c !== only) continue;
      if (c.removeAt !== NEVER) continue;
      for (let i = 0; i < c.dirs.length; i += 3) {
        best = Math.min(best, angleBetween(c.dirs[i], c.dirs[i + 1], c.dirs[i + 2], local));
      }
    }
    return best;
  }

  /** How far a candidate strays outside the comfortable part of the view (0 = inside). */
  private strayPenalty(world: Vector3, view: ViewFrame): number {
    const { az, el } = viewAngles(world, view);
    const azLimit = view.halfWidth * 0.82;
    const low = 9 * DEG;
    const high = Math.max(low + 6 * DEG, view.top * 0.8);
    let p = 0;
    if (Math.abs(az) > azLimit) p += Math.abs(az) - azLimit;
    if (el < low) p += (low - el) * 2.5;
    if (el > high) p += el - high;
    return p;
  }

  /** A fresh spot for a new constellation: in view, and in the emptiest patch of sky on offer. */
  private placeFirst(view: ViewFrame, skyRotation: Quaternion, out: Vector3): Vector3 {
    const azRange = view.halfWidth * 0.62;
    const low = Math.max(12 * DEG, view.top * 0.24);
    const high = Math.max(low + 5 * DEG, view.top * 0.68);
    let bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const cand = this.fromView(view, (this.rand() * 2 - 1) * azRange, low + this.rand() * (high - low), this.v1);
      const score = Math.min(this.nearestStar(cand, skyRotation), 22 * DEG) + this.rand() * 0.02;
      if (score > bestScore) {
        bestScore = score;
        out.copy(cand);
      }
    }
    return out;
  }

  /** The next star of a constellation: one step on from `anchor`, wandering but staying in view. */
  private placeNext(
    c: Constellation,
    anchor: Vector3,
    previous: Vector3 | null,
    view: ViewFrame,
    skyRotation: Quaternion,
    out: Vector3,
  ): Vector3 {
    // Local compass at the anchor.
    this.east.set(0, 1, 0).cross(anchor).normalize();
    this.north.crossVectors(anchor, this.east);
    let heading = this.rand() * Math.PI * 2;
    if (previous) {
      const d = this.v2.copy(anchor).sub(previous);
      heading = Math.atan2(d.dot(this.north), d.dot(this.east));
    }
    const scale = Math.min(1, Math.max(0.7, (view.halfWidth * 2) / (50 * DEG)));
    const [stepMin, stepMax] = CONSTELLATIONS.step;
    let bestScore = Infinity;
    for (let i = 0; i < 18; i++) {
      // Turn up to ~80 degrees from the previous segment: shapes, not straight lines or doubling back.
      const turn = previous ? (this.rand() * 2 - 1) * 1.4 : this.rand() * Math.PI * 2;
      const theta = heading + turn;
      const step = (stepMin + this.rand() * (stepMax - stepMin)) * DEG * scale;
      const cand = this.v1
        .copy(anchor)
        .multiplyScalar(Math.cos(step))
        .addScaledVector(this.east, Math.cos(theta) * Math.sin(step))
        .addScaledVector(this.north, Math.sin(theta) * Math.sin(step))
        .normalize();
      let score = this.strayPenalty(cand, view) * 4;
      const own = this.nearestStar(cand, skyRotation, c);
      if (own < 4.2 * DEG * scale) score += (4.2 * DEG * scale - own) * 8;
      const any = this.nearestStar(cand, skyRotation);
      if (any < 3 * DEG) score += (3 * DEG - any) * 4;
      score += this.rand() * 0.01;
      if (score < bestScore) {
        bestScore = score;
        out.copy(cand);
      }
    }
    return out;
  }

  /**
   * Promise a place in the sky to a lantern that is about to rise. The spot is
   * chosen now so that several lanterns in flight chain correctly.
   */
  reserve(camera: PerspectiveCamera, skyRotation: Quaternion, elapsed: number): Reservation {
    const view = this.readView(camera);
    const world = new Vector3();
    let c = this.current;

    if (c) {
      const n = c.dirs.length / 3;
      const anchor = new Vector3(c.dirs[(n - 1) * 3], c.dirs[(n - 1) * 3 + 1], c.dirs[(n - 1) * 3 + 2]).applyQuaternion(
        skyRotation,
      );
      const { az, el } = viewAngles(anchor, view);
      const reachable = el > 6 * DEG && el < 64 * DEG && Math.abs(az) < Math.max(view.halfWidth * 1.5, 55 * DEG);
      if (reachable) {
        const previous =
          n >= 2
            ? new Vector3(c.dirs[(n - 2) * 3], c.dirs[(n - 2) * 3 + 1], c.dirs[(n - 2) * 3 + 2]).applyQuaternion(
                skyRotation,
              )
            : null;
        this.placeNext(c, anchor, previous, view, skyRotation, world);
      } else {
        // The unfinished constellation has drifted (or been steered) out of
        // reach: close it as it stands and begin a new one where the player is looking.
        this.finishEarly(c, elapsed);
        c = null;
      }
    }

    if (!c) {
      this.placeFirst(view, skyRotation, world);
      const span = CONSTELLATIONS.maxStars - CONSTELLATIONS.minStars + 1;
      c = {
        dirs: [],
        births: [],
        target: CONSTELLATIONS.minStars + Math.floor(this.rand() * span),
        completedAt: NEVER,
        removeAt: NEVER,
        seed: this.rand() * 100,
      };
      this.list.push(c);
      this.current = c;
      this.enforceCap(elapsed);
    }

    const dir = world.applyQuaternion(this.inverse.copy(skyRotation).invert()).normalize();
    c.dirs.push(dir.x, dir.y, dir.z);
    const index = c.dirs.length / 3 - 1;
    // Once its last place is promised, the next lantern starts a new constellation.
    if (c.dirs.length / 3 >= c.target) this.current = null;
    return { constellation: c, index, dir };
  }

  private finishEarly(c: Constellation, elapsed: number): void {
    c.target = c.dirs.length / 3;
    if (this.current === c) this.current = null;
    if (c.births.length >= c.target && c.completedAt === NEVER) {
      c.completedAt = elapsed;
      this.rebuild();
      this.save();
    }
  }

  private enforceCap(elapsed: number): void {
    let alive = 0;
    for (const c of this.list) if (c.removeAt === NEVER) alive++;
    for (let i = 0; alive > CONSTELLATIONS.max && i < this.list.length; i++) {
      const c = this.list[i];
      if (c.removeAt !== NEVER || c === this.current) continue;
      // Oldest first: fade out gracefully; it is dropped once invisible.
      c.removeAt = elapsed;
      alive--;
    }
    this.rebuild();
  }

  // --- Lifecycle ----------------------------------------------------------

  /** A lantern has arrived: its star appears and links to the one before. */
  settle(reservation: Reservation, elapsed: number): SettleResult | null {
    const c = reservation.constellation;
    if (c.removeAt !== NEVER || !this.list.includes(c)) return null;
    c.births.push(elapsed);
    let completed = false;
    if (c.births.length >= c.target && c.completedAt === NEVER) {
      c.completedAt = elapsed + 0.4;
      completed = true;
    }
    this.rebuild();
    this.save();
    return { completed, fanfare: completed && c.target >= 3 };
  }

  /** "Clear my sky": everything fades out; storage is cleared straight away. */
  clear(elapsed: number): void {
    for (const c of this.list) if (c.removeAt === NEVER) c.removeAt = elapsed;
    this.current = null;
    this.rebuild();
    this.save();
  }

  update(elapsed: number, cycle: DayCycle, camera: PerspectiveCamera, skyRotation: Quaternion): void {
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(skyRotation);

    // Drop constellations that have finished fading out.
    let dropped = false;
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (elapsed - this.list[i].removeAt > CONSTELLATIONS.fadeOut + 0.2) {
        this.list.splice(i, 1);
        dropped = true;
      }
    }
    if (dropped) this.rebuild();

    const bright = CONSTELLATIONS.dayBrightness + (1 - CONSTELLATIONS.dayBrightness) * Math.min(1, cycle.stars * 1.4);
    this.starMaterial.uniforms.uTime.value = elapsed;
    this.starMaterial.uniforms.uBright.value = bright;
    this.reflectMaterial.uniforms.uTime.value = elapsed;
    this.reflectMaterial.uniforms.uBright.value = bright * 0.5;
    this.lineMaterial.uniforms.uTime.value = elapsed;
    this.lineMaterial.uniforms.uBright.value = bright;
  }

  /** What gets written to storage: settled stars only, fading constellations excluded. */
  serialise(): SavedConstellation[] {
    const out: SavedConstellation[] = [];
    for (const c of this.list) {
      if (c.removeAt !== NEVER || c.births.length === 0) continue;
      out.push({
        stars: c.dirs.slice(0, c.births.length * 3),
        target: c.target,
        done: c.completedAt !== NEVER,
      });
    }
    return out;
  }

  private save(): void {
    saveSky(this.serialise(), this.store);
  }

  /** Rewrite the GPU buffers. Only called when the sky changes, never per frame. */
  private rebuild(): void {
    let s = 0;
    let l = 0;
    for (const c of this.list) {
      const settled = c.births.length;
      for (let i = 0; i < settled && s < MAX_STARS; i++) {
        const o = i * 3;
        this.starPos.set([c.dirs[o], c.dirs[o + 1], c.dirs[o + 2]], s * 3);
        this.starTimes.set([c.births[i], c.completedAt, c.removeAt], s * 3);
        this.starSeed[s] = c.seed + i;
        s++;
        if (i === 0) continue;
        for (let k = 0; k < 4; k++) {
          const v = (l * 4 + k) * 3;
          this.lineA.set([c.dirs[o - 3], c.dirs[o - 2], c.dirs[o - 1]], v);
          this.lineB.set([c.dirs[o], c.dirs[o + 1], c.dirs[o + 2]], v);
          this.lineTimes.set([c.births[i], c.completedAt, c.removeAt], v);
          this.lineSeed[l * 4 + k] = c.seed + i - 1;
        }
        l++;
      }
    }
    const sg = this.points.geometry;
    for (const name of ['position', 'aTimes', 'aSeed']) sg.attributes[name].needsUpdate = true;
    sg.setDrawRange(0, s);
    const lg = this.lines.geometry;
    for (const name of ['aA', 'aB', 'aTimes', 'aSeed']) lg.attributes[name].needsUpdate = true;
    lg.setDrawRange(0, l * 6);
  }
}
