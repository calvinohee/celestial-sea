import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  PointLight,
  ShaderMaterial,
  Vector3,
} from 'three';
import { BOAT, SKY } from '../config';
import type { DayCycle } from '../time/dayCycle';
import type { FollowTarget } from './camera';
import { REFLECT_LAYER } from './stars';
import { sampleSwell, type SwellSample } from './swell';

type V3 = [number, number, number];

/** Collects flat-shaded, vertex-coloured triangles into one geometry. */
class GeometryBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  tri(a: V3, b: V3, c: V3, col: Color): void {
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.colors.push(col.r, col.g, col.b);
  }

  quad(a: V3, b: V3, c: V3, d: V3, col: Color): void {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: Color): void {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col);
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], col);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], col);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    g.computeVertexNormals();
    return g;
  }

  get triangleCount(): number {
    return this.positions.length / 9;
  }
}

const LENGTH = 3.7;
/** Overall size multiplier so the boat reads clearly from the follow camera. */
const SCALE = 1.18;
/** Lantern position in boat space (forward is -Z). */
const LANTERN: V3 = [0, BOAT.lanternHeight, -0.55];

function buildBoatGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const hull = new Color('#cdbfae');
  const hullLow = new Color('#a89c90');
  const stripe = new Color('#a4553e');
  const inner = new Color('#b3a595');
  const wood = new Color('#7a5540');
  const darkWood = new Color('#4b3628');
  const iron = new Color('#2c2622');

  // Stations from stern (t = 0) to bow (t = 1).
  const stations = [
    { t: 0.0, w: 0.42, sheer: 0.4, keel: 0.1 },
    { t: 0.12, w: 0.55, sheer: 0.37, keel: 0.16 },
    { t: 0.3, w: 0.64, sheer: 0.35, keel: 0.2 },
    { t: 0.5, w: 0.65, sheer: 0.35, keel: 0.2 },
    { t: 0.7, w: 0.56, sheer: 0.38, keel: 0.18 },
    { t: 0.85, w: 0.38, sheer: 0.44, keel: 0.13 },
    { t: 0.95, w: 0.17, sheer: 0.52, keel: 0.06 },
    { t: 1.0, w: 0.02, sheer: 0.6, keel: -0.08 },
  ];
  const ring = (s: (typeof stations)[number]): V3[] => {
    const z = (0.5 - s.t) * LENGTH;
    return [
      [-s.w, s.sheer, z],
      [-s.w * 0.985, s.sheer - 0.075, z],
      [-s.w * 0.78, -0.03, z],
      [0, -s.keel, z],
      [s.w * 0.78, -0.03, z],
      [s.w * 0.985, s.sheer - 0.075, z],
      [s.w, s.sheer, z],
    ];
  };
  const deck = (s: (typeof stations)[number]): [V3, V3] => {
    const z = (0.5 - s.t) * LENGTH;
    return [
      [-s.w * 0.93, s.sheer - 0.13, z],
      [s.w * 0.93, s.sheer - 0.13, z],
    ];
  };
  const bandColors = [stripe, hull, hullLow, hullLow, hull, stripe];

  for (let i = 0; i < stations.length - 1; i++) {
    const a = ring(stations[i]);
    const c = ring(stations[i + 1]);
    for (let j = 0; j < 6; j++) b.quad(a[j], a[j + 1], c[j + 1], c[j], bandColors[j]);
    const da = deck(stations[i]);
    const dc = deck(stations[i + 1]);
    b.quad(da[0], da[1], dc[1], dc[0], wood);
    // Inside faces of the gunwales.
    b.quad(a[0], da[0], dc[0], c[0], inner);
    b.quad(a[6], da[1], dc[1], c[6], inner);
  }
  // Transom.
  const stern = ring(stations[0]);
  for (let j = 0; j < 5; j++) b.tri(stern[3], stern[(j + 4) % 7], stern[(j + 5) % 7], hull);

  // Thwarts.
  b.box(0, 0.33, 0.55, 1.12, 0.045, 0.24, darkWood);
  b.box(0, 0.33, -0.42, 1.02, 0.045, 0.2, darkWood);

  // Short mast with a lantern cage on top.
  const [lx, ly, lz] = LANTERN;
  b.box(lx, (ly - 0.16 + 0.2) / 2, lz, 0.075, ly - 0.16 - 0.2, 0.075, darkWood);
  b.box(lx, ly - 0.15, lz, 0.2, 0.025, 0.2, iron);
  for (const [px, pz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    b.box(lx + px * 0.088, ly, lz + pz * 0.088, 0.016, 0.28, 0.016, iron);
  }
  const top: V3 = [lx, ly + 0.27, lz];
  const e = 0.13;
  const y = ly + 0.14;
  const corners: V3[] = [
    [lx - e, y, lz - e],
    [lx + e, y, lz - e],
    [lx + e, y, lz + e],
    [lx - e, y, lz + e],
  ];
  for (let i = 0; i < 4; i++) b.tri(corners[i], corners[(i + 1) % 4], top, iron);
  b.quad(corners[0], corners[1], corners[2], corners[3], iron);

  return b.build();
}

const GLOW_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  // Camera-facing billboard built in view space.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uIntensity;
void main() {
  float r2 = dot(vUv, vUv);
  float g = exp(-r2 * 7.0) * 0.8 + exp(-r2 * 38.0) * 1.3;
  g *= 1.0 - smoothstep(0.7, 1.0, r2);
  gl_FragColor = vec4(uColor * (g * uIntensity), 1.0);
}
`;

export interface SteerState {
  /** Pointer steering: glide toward (targetX, targetZ). */
  active: boolean;
  targetX: number;
  targetZ: number;
  /** Keyboard: -1..1 forward/brake and left/right. */
  thrust: number;
  turn: number;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * The little boat: procedural low-poly hull with a lantern on a short mast,
 * slow forgiving steering, and bobbing that follows the same swell the water
 * shader draws.
 */
export class Boat implements FollowTarget {
  readonly group = new Group();
  /** Lights that only the boat's Lambert material responds to. */
  readonly lights = new Group();

  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  turnRate = 0;

  /** World position of the lantern flame. */
  readonly lanternPosition = new Vector3();
  /** Linear HDR colour the lantern throws on the water this frame. */
  readonly lanternLight = new Color();

  private readonly hemisphere = new HemisphereLight(0xffffff, 0x000000, 1);
  private readonly sun = new DirectionalLight(0xffffff, 1);
  private readonly lamp = new PointLight(new Color(1.0, 0.66, 0.36), 4, 10, 2);
  private readonly glowMaterial: ShaderMaterial;
  private readonly coreMaterial: MeshBasicMaterial;
  private readonly swell: SwellSample = { height: 0, gx: 0, gz: 0 };
  private pitch = 0;
  private roll = 0;
  private bob = 0;
  private lastSpeed = 0;

  readonly triangleCount: number;

  constructor() {
    const geometry = buildBoatGeometry();
    this.triangleCount = geometry.attributes.position.count / 3;
    const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide });
    const hull = new Mesh(geometry, material);
    this.group.add(hull);

    this.coreMaterial = new MeshBasicMaterial({ color: new Color(1, 1, 1) });
    const core = new Mesh(new OctahedronGeometry(0.085, 0), this.coreMaterial);
    core.position.set(...LANTERN);
    core.scale.set(1, 1.3, 1);
    this.group.add(core);

    const quad = new BufferGeometry();
    quad.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    this.glowMaterial = new ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: {
        uColor: { value: new Color(1.0, 0.62, 0.3) },
        uIntensity: { value: 1 },
        uSize: { value: 1.5 },
      },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    const glow = new Mesh(quad, this.glowMaterial);
    glow.position.set(...LANTERN);
    glow.frustumCulled = false;
    glow.renderOrder = 20;
    glow.layers.enable(REFLECT_LAYER);
    this.group.add(glow);

    this.lamp.position.set(LANTERN[0], LANTERN[1], LANTERN[2]);
    this.group.add(this.lamp);
    this.lights.add(this.hemisphere, this.sun, this.sun.target);
    this.group.rotation.order = 'YXZ';
    this.group.scale.setScalar(SCALE);
  }

  update(dt: number, elapsed: number, steer: SteerState, cycle: DayCycle): void {
    this.steer(dt, steer);
    this.float(dt, elapsed);
    this.light(cycle);
  }

  private steer(dt: number, steer: SteerState): void {
    const speedFrac = Math.min(1, Math.abs(this.speed) / BOAT.maxSpeed);
    // A boat needs way on to turn well, but must still be able to turn from rest.
    const authority = 0.34 + 0.66 * speedFrac;
    let wantSpeed = 0;
    let wantTurn = 0;
    let braking = false;

    if (steer.thrust !== 0 || steer.turn !== 0) {
      if (steer.thrust > 0) wantSpeed = BOAT.maxSpeed;
      else if (steer.thrust < 0) braking = true;
      else wantSpeed = Math.min(this.speed, BOAT.maxSpeed);
      // Turning alone still nudges the boat along so it can come about.
      if (steer.turn !== 0 && steer.thrust === 0) wantSpeed = Math.max(wantSpeed, BOAT.maxSpeed * 0.3);
      wantTurn = steer.turn * BOAT.maxTurnRate * authority;
    } else if (steer.active) {
      const dx = steer.targetX - this.x;
      const dz = steer.targetZ - this.z;
      const dist = Math.hypot(dx, dz);
      const err = wrapAngle(Math.atan2(dx, -dz) - this.heading);
      const facing = Math.max(0, Math.cos(err));
      const arrive = Math.min(1, Math.max(0.12, dist / BOAT.arriveRadius));
      wantSpeed = BOAT.maxSpeed * arrive * (0.4 + 0.6 * facing);
      wantTurn = Math.max(-1, Math.min(1, err * 1.5)) * BOAT.maxTurnRate * authority;
      if (dist < 1.2) {
        wantSpeed = 0;
        wantTurn = 0;
      }
    }

    if (wantSpeed > this.speed) {
      this.speed = Math.min(wantSpeed, this.speed + BOAT.acceleration * dt);
    } else {
      // Coast down gently; brake a little harder when asked.
      const drag = BOAT.drag * (braking ? 2.6 : 1);
      this.speed += (wantSpeed - this.speed) * (1 - Math.exp(-drag * dt));
      if (this.speed < 0.004) this.speed = 0;
    }

    const maxDelta = BOAT.turnAcceleration * dt;
    this.turnRate += Math.max(-maxDelta, Math.min(maxDelta, wantTurn - this.turnRate));
    this.heading = wrapAngle(this.heading + this.turnRate * dt);
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z -= Math.cos(this.heading) * this.speed * dt;
  }

  private float(dt: number, elapsed: number): void {
    const fx = Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const s = sampleSwell(this.x, this.z, elapsed, this.swell);
    const slopeForward = s.gx * fx + s.gz * fz;
    const slopeRight = s.gx * -fz + s.gz * fx;

    const accel = dt > 0 ? (this.speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = this.speed;
    const speedFrac = this.speed / BOAT.maxSpeed;

    // Bow lifts a touch under way and when accelerating; the boat heels into turns.
    const wantPitch = Math.atan(slopeForward) * 0.85 + speedFrac * 0.03 + accel * 0.03;
    const wantRoll =
      Math.atan(slopeRight) * 0.95 - this.turnRate * speedFrac * 0.22 + Math.sin(elapsed * 0.83) * 0.012;
    const wantBob = s.height * 0.9 + Math.sin(elapsed * 1.31) * 0.012;

    const k = 1 - Math.exp(-3.2 * dt);
    this.pitch += (wantPitch - this.pitch) * k;
    this.roll += (wantRoll - this.roll) * k;
    this.bob += (wantBob - this.bob) * (1 - Math.exp(-5 * dt));

    this.group.position.set(this.x, this.bob, this.z);
    this.group.rotation.set(this.pitch, -this.heading, this.roll);
    this.group.updateMatrixWorld(true);
    this.lanternPosition.set(...LANTERN).applyMatrix4(this.group.matrixWorld);
  }

  private light(cycle: DayCycle): void {
    this.hemisphere.color.copy(cycle.ambientSky);
    this.hemisphere.groundColor.copy(cycle.ambientGround);
    this.hemisphere.intensity = 2.6;

    this.sun.color.copy(cycle.sunColor).multiplyScalar(1 / SKY.sunIntensity);
    this.sun.intensity = 2.4 * cycle.sunDisc + 0.7 * cycle.sunGlow;
    this.sun.position.copy(this.group.position).addScaledVector(cycle.sunDir, 20);
    this.sun.position.y = Math.max(this.sun.position.y, 1.5);
    this.sun.target.position.copy(this.group.position);
    this.sun.target.updateMatrixWorld();

    // The lantern is always lit; it simply matters more as daylight goes.
    const d = cycle.darkness;
    this.lamp.intensity = 2.5 + 9 * d;
    this.coreMaterial.color.setRGB(1.0, 0.74, 0.42).multiplyScalar(2.2 + 2.2 * d);
    this.glowMaterial.uniforms.uIntensity.value = 0.3 + 0.6 * d;
    this.glowMaterial.uniforms.uSize.value = 1.15 + 0.35 * d;
    this.lanternLight.setRGB(1.0, 0.6, 0.3).multiplyScalar(0.12 + 0.75 * d);
  }
}
