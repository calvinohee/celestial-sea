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
import { BOAT, COMFORT, SKY, type ComfortSettings } from '../config';
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

interface Station {
  /** 0 at the stern, 1 at the bow. */
  t: number;
  /** Half beam at the gunwale. */
  w: number;
  sheer: number;
  keel: number;
}

// Hull lines from stern to bow.
const STATIONS: Station[] = [
  { t: 0.0, w: 0.42, sheer: 0.41, keel: 0.1 },
  { t: 0.08, w: 0.51, sheer: 0.385, keel: 0.145 },
  { t: 0.18, w: 0.59, sheer: 0.365, keel: 0.18 },
  { t: 0.3, w: 0.64, sheer: 0.352, keel: 0.2 },
  { t: 0.42, w: 0.655, sheer: 0.348, keel: 0.205 },
  { t: 0.54, w: 0.645, sheer: 0.352, keel: 0.2 },
  { t: 0.66, w: 0.59, sheer: 0.368, keel: 0.185 },
  { t: 0.77, w: 0.49, sheer: 0.4, keel: 0.16 },
  { t: 0.86, w: 0.365, sheer: 0.445, keel: 0.125 },
  { t: 0.93, w: 0.22, sheer: 0.5, keel: 0.08 },
  { t: 0.975, w: 0.1, sheer: 0.555, keel: 0.02 },
  { t: 1.0, w: 0.02, sheer: 0.6, keel: -0.08 },
];

const stationZ = (t: number) => (0.5 - t) * LENGTH;

/** Half beam and sheer height at any point along the hull (linear between stations). */
function hullAt(t: number): { w: number; sheer: number } {
  for (let i = 1; i < STATIONS.length; i++) {
    if (t <= STATIONS[i].t) {
      const a = STATIONS[i - 1];
      const b = STATIONS[i];
      const k = (t - a.t) / (b.t - a.t);
      return { w: a.w + (b.w - a.w) * k, sheer: a.sheer + (b.sheer - a.sheer) * k };
    }
  }
  const last = STATIONS[STATIONS.length - 1];
  return { w: last.w, sheer: last.sheer };
}

function buildBoatGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const plankA = new Color('#d2c5b3');
  const plankB = new Color('#c4b6a3');
  const plankC = new Color('#b8aa98');
  const bottom = new Color('#8e8378');
  const stripe = new Color('#a4553e');
  const rail = new Color('#5c4030');
  const inner = new Color('#b3a595');
  const floorA = new Color('#80593f');
  const floorB = new Color('#74503a');
  const wood = new Color('#6c4a36');
  const darkWood = new Color('#4b3628');
  const iron = new Color('#2c2622');
  const rope = new Color('#c9b48a');
  const paper = new Color('#efe3cd');
  const cloth = new Color('#b7584a');
  const oarBlade = new Color('#d8c7a6');

  // --- Hull: a sheer stripe, three strakes of planking and the bottom, each side. ---
  const ring = (s: Station): V3[] => {
    const z = stationZ(s.t);
    const side = (sign: number): V3[] => [
      [sign * s.w, s.sheer, z],
      [sign * s.w * 0.99, s.sheer - 0.07, z],
      [sign * s.w * 0.955, s.sheer - 0.175, z],
      [sign * s.w * 0.89, s.sheer - 0.28, z],
      [sign * s.w * 0.76, -0.03, z],
    ];
    return [...side(-1), [0, -s.keel, z], ...side(1).reverse()];
  };
  const bands = [stripe, plankA, plankB, plankC, bottom, bottom, plankC, plankB, plankA, stripe];
  const deckY = (s: Station) => s.sheer - 0.15;

  for (let i = 0; i < STATIONS.length - 1; i++) {
    const s0 = STATIONS[i];
    const s1 = STATIONS[i + 1];
    const a = ring(s0);
    const c = ring(s1);
    for (let j = 0; j < bands.length; j++) b.quad(a[j], a[j + 1], c[j + 1], c[j], bands[j]);

    const z0 = stationZ(s0.t);
    const z1 = stationZ(s1.t);
    // Floorboards: three planks across, alternating tone.
    const edges0 = [-0.93, -0.31, 0.31, 0.93].map((k) => k * s0.w);
    const edges1 = [-0.93, -0.31, 0.31, 0.93].map((k) => k * s1.w);
    for (let k = 0; k < 3; k++) {
      b.quad(
        [edges0[k], deckY(s0), z0],
        [edges0[k + 1], deckY(s0), z0],
        [edges1[k + 1], deckY(s1), z1],
        [edges1[k], deckY(s1), z1],
        k === 1 ? floorB : floorA,
      );
    }
    for (const sign of [-1, 1]) {
      // Inside of the planking.
      b.quad(
        [sign * s0.w * 0.965, s0.sheer, z0],
        [sign * s0.w * 0.93, deckY(s0), z0],
        [sign * s1.w * 0.93, deckY(s1), z1],
        [sign * s1.w * 0.965, s1.sheer, z1],
        inner,
      );
      // Gunwale: a rail capping the planking, standing a little proud of it.
      const top0 = s0.sheer + 0.028;
      const top1 = s1.sheer + 0.028;
      b.quad(
        [sign * (s0.w + 0.03), top0, z0],
        [sign * (s0.w * 0.965 - 0.015), top0, z0],
        [sign * (s1.w * 0.965 - 0.015), top1, z1],
        [sign * (s1.w + 0.03), top1, z1],
        rail,
      );
      b.quad(
        [sign * (s0.w + 0.03), top0, z0],
        [sign * (s0.w + 0.03), s0.sheer - 0.022, z0],
        [sign * (s1.w + 0.03), s1.sheer - 0.022, z1],
        [sign * (s1.w + 0.03), top1, z1],
        rail,
      );
    }
  }

  // Transom, with a capping rail.
  const sternStation = STATIONS[0];
  const stern = ring(sternStation);
  const zs = stationZ(0);
  for (let j = 1; j < stern.length - 1; j++) b.tri(stern[0], stern[j], stern[j + 1], plankB);
  b.box(0, sternStation.sheer + 0.014, zs + 0.02, sternStation.w * 2 + 0.06, 0.03, 0.07, rail);

  // Stem post at the bow.
  b.box(0, 0.5, stationZ(1) - 0.01, 0.05, 0.42, 0.07, darkWood);

  // Ribs: slim frames against the planking.
  for (const t of [0.14, 0.26, 0.38, 0.5, 0.62, 0.74]) {
    const h = hullAt(t);
    const z = stationZ(t);
    for (const sign of [-1, 1]) {
      b.quad(
        [sign * h.w * 0.96, h.sheer - 0.005, z - 0.02],
        [sign * h.w * 0.96, h.sheer - 0.005, z + 0.02],
        [sign * h.w * 0.9, h.sheer - 0.15, z + 0.02],
        [sign * h.w * 0.9, h.sheer - 0.15, z - 0.02],
        wood,
      );
    }
  }

  // Thwarts, a stern seat and a small foredeck.
  const thwart = (t: number, depth: number) => {
    const h = hullAt(t);
    b.box(0, h.sheer - 0.035, stationZ(t), h.w * 1.9, 0.04, depth, darkWood);
  };
  thwart(0.33, 0.24);
  thwart(0.62, 0.2);
  {
    const a = hullAt(0.02);
    const c = hullAt(0.13);
    const y = a.sheer - 0.04;
    b.quad(
      [-a.w * 0.93, y, stationZ(0.02)],
      [a.w * 0.93, y, stationZ(0.02)],
      [c.w * 0.93, y, stationZ(0.13)],
      [-c.w * 0.93, y, stationZ(0.13)],
      wood,
    );
    b.quad(
      [-c.w * 0.93, y, stationZ(0.13)],
      [c.w * 0.93, y, stationZ(0.13)],
      [c.w * 0.93, y - 0.11, stationZ(0.13)],
      [-c.w * 0.93, y - 0.11, stationZ(0.13)],
      darkWood,
    );
    const f = hullAt(0.86);
    const fy = f.sheer - 0.01;
    b.tri([-f.w * 0.95, fy, stationZ(0.86)], [f.w * 0.95, fy, stationZ(0.86)], [0, 0.585, stationZ(0.995)], wood);
    // Mooring cleat on the foredeck.
    b.box(0, fy + 0.035, stationZ(0.91), 0.16, 0.03, 0.035, iron);
    b.box(0, fy + 0.015, stationZ(0.91), 0.04, 0.04, 0.04, iron);
  }

  // Rudder and tiller.
  b.box(0, 0.1, zs + 0.09, 0.03, 0.62, 0.2, darkWood);
  b.box(0, 0.45, zs - 0.28, 0.035, 0.035, 0.78, wood);
  b.box(0, 0.45, zs - 0.69, 0.05, 0.05, 0.08, darkWood);

  // Oars shipped along the thwarts, blades toward the stern, with rowlocks.
  for (const sign of [-1, 1]) {
    const x = sign * 0.36;
    const y = hullAt(0.45).sheer + 0.01;
    b.box(x, y, stationZ(0.47), 0.035, 0.035, 1.9, wood);
    b.box(x, y, stationZ(0.2), 0.13, 0.02, 0.5, oarBlade);
    const lock = hullAt(0.44);
    b.box(sign * (lock.w + 0.005), lock.sheer + 0.07, stationZ(0.44), 0.03, 0.09, 0.03, iron);
    b.box(sign * (lock.w + 0.005), lock.sheer + 0.07, stationZ(0.44) + 0.07, 0.03, 0.09, 0.03, iron);
  }

  // A coil of rope in the bow.
  {
    const cx = 0.14;
    const cz = stationZ(0.78);
    const y = hullAt(0.78).sheer - 0.14;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, r: number, h: number): V3 => [cx + Math.cos(a) * r, y + h, cz + Math.sin(a) * r];
      b.quad(p(a0, 0.17, 0.0), p(a1, 0.17, 0.0), p(a1, 0.15, 0.05), p(a0, 0.15, 0.05), rope);
      b.quad(p(a0, 0.15, 0.05), p(a1, 0.15, 0.05), p(a1, 0.07, 0.05), p(a0, 0.07, 0.05), rope);
    }
  }

  // A crate of paper lanterns waiting their turn, by the stern seat.
  {
    const cx = -0.2;
    const cz = stationZ(0.22);
    const y = hullAt(0.22).sheer - 0.15;
    b.box(cx, y + 0.07, cz, 0.44, 0.14, 0.34, wood);
    b.box(cx, y + 0.15, cz - 0.17, 0.46, 0.025, 0.025, darkWood);
    b.box(cx, y + 0.15, cz + 0.17, 0.46, 0.025, 0.025, darkWood);
    for (const [ox, oz, h] of [
      [-0.12, -0.07, 0.2],
      [0.03, 0.06, 0.24],
      [0.14, -0.06, 0.18],
    ]) {
      const n = 6;
      const r = 0.062;
      const y0 = y + 0.14;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        const p = (a: number, yy: number, rr: number): V3 => [cx + ox + Math.cos(a) * rr, yy, cz + oz + Math.sin(a) * rr];
        b.quad(p(a0, y0, r * 0.8), p(a1, y0, r * 0.8), p(a1, y0 + h, r), p(a0, y0 + h, r), paper);
        b.tri(p(a0, y0 + h, r), p(a1, y0 + h, r), [cx + ox, y0 + h, cz + oz], inner);
      }
    }
  }

  // Mast: tapered, six-sided, stepped through the forward thwart.
  const [lx, ly, lz] = LANTERN;
  {
    const n = 6;
    const y0 = 0.2;
    const y1 = ly - 0.15;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, y: number, r: number): V3 => [lx + Math.cos(a) * r, y, lz + Math.sin(a) * r];
      b.quad(p(a0, y0, 0.048), p(a1, y0, 0.048), p(a1, y1, 0.03), p(a0, y1, 0.03), darkWood);
    }
    // Collar where the mast meets the thwart.
    b.box(lx, hullAt(0.62).sheer - 0.005, lz, 0.15, 0.03, 0.15, iron);
  }
  // Stays to the stem and the stern, and a little pennant.
  const stay = (to: V3) => {
    const from: V3 = [lx, ly - 0.2, lz];
    const w = 0.008;
    b.quad([from[0] - w, from[1], from[2]], [from[0] + w, from[1], from[2]], [to[0] + w, to[1], to[2]], [to[0] - w, to[1], to[2]], rope);
    b.quad([from[0], from[1] - w, from[2]], [from[0], from[1] + w, from[2]], [to[0], to[1] + w, to[2]], [to[0], to[1] - w, to[2]], rope);
  };
  stay([0, 0.7, stationZ(1) - 0.01]);
  stay([0, sternStation.sheer + 0.03, zs + 0.02]);
  b.tri([lx, ly - 0.32, lz + 0.03], [lx, ly - 0.46, lz + 0.03], [lx + 0.02, ly - 0.4, lz + 0.36], cloth);

  // Lantern cage: base plate, four posts, a pitched roof with a finial and a carrying ring.
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
  b.box(lx, ly + 0.3, lz, 0.03, 0.06, 0.03, iron);
  b.box(lx, ly + 0.355, lz, 0.09, 0.016, 0.016, iron);

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

  /** Comfort scaling for speed, turning and bobbing (see COMFORT in config). */
  comfort: ComfortSettings = COMFORT.normal;

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
    const maxSpeed = BOAT.maxSpeed * this.comfort.speed;
    const maxTurn = BOAT.maxTurnRate * this.comfort.turn;
    const speedFrac = Math.min(1, Math.abs(this.speed) / maxSpeed);
    // A boat needs way on to turn well, but must still be able to turn from rest.
    const authority = 0.34 + 0.66 * speedFrac;
    let wantSpeed = 0;
    let wantTurn = 0;
    let braking = false;

    if (steer.thrust !== 0 || steer.turn !== 0) {
      if (steer.thrust > 0) wantSpeed = maxSpeed;
      else if (steer.thrust < 0) braking = true;
      else wantSpeed = Math.min(this.speed, maxSpeed);
      // Turning alone still nudges the boat along so it can come about.
      if (steer.turn !== 0 && steer.thrust === 0) wantSpeed = Math.max(wantSpeed, maxSpeed * 0.3);
      wantTurn = steer.turn * maxTurn * authority;
    } else if (steer.active) {
      const dx = steer.targetX - this.x;
      const dz = steer.targetZ - this.z;
      const dist = Math.hypot(dx, dz);
      const err = wrapAngle(Math.atan2(dx, -dz) - this.heading);
      const facing = Math.max(0, Math.cos(err));
      const arrive = Math.min(1, Math.max(0.12, dist / BOAT.arriveRadius));
      wantSpeed = maxSpeed * arrive * (0.4 + 0.6 * facing);
      wantTurn = Math.max(-1, Math.min(1, err * 1.5)) * maxTurn * authority;
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
    const speedFrac = this.speed / (BOAT.maxSpeed * this.comfort.speed);
    const amount = this.comfort.bob;

    // Bow lifts a touch under way and when accelerating; the boat heels into turns.
    const wantPitch = (Math.atan(slopeForward) * 0.85 + accel * 0.03) * amount + speedFrac * 0.025;
    const wantRoll =
      (Math.atan(slopeRight) * 0.95 - this.turnRate * speedFrac * 0.22 + Math.sin(elapsed * 0.83) * 0.012) * amount;
    const wantBob = (s.height * 0.9 + Math.sin(elapsed * 1.31) * 0.012) * (0.4 + 0.6 * amount);

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
