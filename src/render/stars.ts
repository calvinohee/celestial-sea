import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { SKY } from '../config';
import type { DayCycle } from '../time/dayCycle';
import { mulberry32 } from '../util/noise';

/** Objects on this layer are also drawn into the water's light-reflection pass. */
export const REFLECT_LAYER = 1;

const SKY_RADIUS = 8000;
const BRIGHT_COUNT = 180;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute vec3 aTwinkle; // x = speed, y = phase, z = visibility threshold
uniform float uTime;
uniform float uPixelRatio;
uniform float uStars;
uniform float uSizeScale;
uniform float uIntensity;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * ${SKY_RADIUS.toFixed(1)}, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 wdir = normalize(mat3(modelMatrix) * position);
  float extinction = smoothstep(0.004, 0.2, wdir.y);
  float twinkle = 0.8 + 0.2 * sin(uTime * aTwinkle.x + aTwinkle.y);
  float vis = smoothstep(aTwinkle.z, aTwinkle.z + 0.3, uStars);
  vColor = aColor * (vis * extinction * twinkle * uIntensity);
  gl_PointSize = aSize * uPixelRatio * uSizeScale;
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = max(1.0 - d, 0.0);
  gl_FragColor = vec4(vColor * (a * sqrt(a)), 1.0);
}
`;

const SHOOT_VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHOOT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uAlpha;
void main() {
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float along = vUv.x * vUv.x * vUv.x;
  float head = smoothstep(0.9, 1.0, vUv.x);
  vec3 col = mix(vec3(0.55, 0.7, 1.0), vec3(1.0, 0.97, 0.9), vUv.x) * (1.6 + 2.4 * head);
  gl_FragColor = vec4(col * (along * across * across * uAlpha), 1.0);
}
`;

/**
 * Background stars (one Points object), a bright subset for the water's
 * reflection pass, the slow rotation of the whole star field, and the
 * occasional shooting star.
 */
export class Stars {
  readonly group = new Group();
  /** Star-frame -> world rotation. Constellations parent to this later. */
  readonly quaternion = new Quaternion();
  /** World -> star-frame rotation for the sky shader (Milky Way). */
  readonly skyRotation = new Matrix3();
  /** Fired when a shooting star starts (audio hooks in here). */
  onShootingStar: (() => void) | null = null;

  private readonly points: Points;
  private readonly bright: Points;
  private readonly material: ShaderMaterial;
  private readonly brightMaterial: ShaderMaterial;

  private readonly shootMesh: Mesh;
  private readonly shootMaterial: ShaderMaterial;
  private readonly shootPositions: Float32Array;
  private shootTimer = 0;
  private shootAge = -1;
  private shootDuration = 1;
  private readonly shootStart = new Vector3();
  private readonly shootVel = new Vector3();

  private angle = 0;
  private readonly pole = new Vector3(0, Math.sin(0.72), Math.cos(0.72)).normalize();
  private readonly rand = mulberry32(90210);
  private readonly m4 = new Matrix4();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly v4 = new Vector3();

  constructor() {
    const count = SKY.starCount;
    const rand = mulberry32(4242);
    const bandN = new Vector3(0.5294, 0.3369, 0.7786);
    const bandU = new Vector3(0.827, 0, -0.5623);
    const bandV = new Vector3().crossVectors(bandN, bandU);

    interface Star {
      x: number;
      y: number;
      z: number;
      b: number;
    }
    const stars: Star[] = [];
    const dir = new Vector3();
    for (let i = 0; i < count; i++) {
      if (rand() < 0.38) {
        // Concentrated toward the Milky Way band.
        const a = rand() * Math.PI * 2;
        const lat = (rand() + rand() + rand() - 1.5) * 0.36;
        const c = Math.sqrt(Math.max(0, 1 - lat * lat));
        dir
          .set(0, 0, 0)
          .addScaledVector(bandU, Math.cos(a) * c)
          .addScaledVector(bandV, Math.sin(a) * c)
          .addScaledVector(bandN, lat)
          .normalize();
      } else {
        const z = rand() * 2 - 1;
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(1 - z * z);
        dir.set(r * Math.cos(a), z, r * Math.sin(a));
      }
      stars.push({ x: dir.x, y: dir.y, z: dir.z, b: Math.pow(rand(), 5.5) });
    }
    // Brightest first, so lower quality tiers can simply draw fewer.
    stars.sort((p, q) => q.b - p.b);

    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const twinkle = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const s = stars[i];
      positions.set([s.x, s.y, s.z], i * 3);
      sizes[i] = 1.7 + 2.6 * Math.sqrt(s.b);
      const intensity = 0.5 + 2.3 * s.b;
      const temp = rand();
      // Cool blue-white through neutral to a gentle warm tint.
      const r = temp < 0.6 ? 0.78 + 0.22 * (temp / 0.6) : 1.0;
      const g = temp < 0.6 ? 0.86 + 0.12 * (temp / 0.6) : 0.98 - 0.14 * ((temp - 0.6) / 0.4);
      const bl = temp < 0.6 ? 1.0 : 1.0 - 0.3 * ((temp - 0.6) / 0.4);
      colors.set([r * intensity, g * intensity, bl * intensity], i * 3);
      twinkle.set([0.6 + rand() * 2.2, rand() * Math.PI * 2, 0.04 + 0.62 * (1 - Math.pow(s.b, 0.25))], i * 3);
    }

    const attrs = {
      position: new BufferAttribute(positions, 3),
      aSize: new BufferAttribute(sizes, 1),
      aColor: new BufferAttribute(colors, 3),
      aTwinkle: new BufferAttribute(twinkle, 3),
    };
    const makeGeometry = (n: number) => {
      const g = new BufferGeometry();
      for (const [name, attr] of Object.entries(attrs)) g.setAttribute(name, attr);
      g.setDrawRange(0, n);
      return g;
    };
    const makeMaterial = (sizeScale: number, intensity: number) =>
      new ShaderMaterial({
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: 1 },
          uStars: { value: 0 },
          uSizeScale: { value: sizeScale },
          uIntensity: { value: intensity },
        },
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });

    this.material = makeMaterial(1, 1);
    this.points = new Points(makeGeometry(count), this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -90;

    // Only the brightest stars are worth reflecting in the water.
    this.brightMaterial = makeMaterial(2.2, 0.14);
    this.bright = new Points(makeGeometry(BRIGHT_COUNT), this.brightMaterial);
    this.bright.frustumCulled = false;
    this.bright.layers.set(REFLECT_LAYER);

    // Shooting star: one pooled quad, vertices rewritten while it is alive.
    this.shootPositions = new Float32Array(12);
    const sg = new BufferGeometry();
    const posAttr = new BufferAttribute(this.shootPositions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    sg.setAttribute('position', posAttr);
    sg.setAttribute('aUv', new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), 2));
    sg.setIndex([0, 2, 1, 1, 2, 3]);
    this.shootMaterial = new ShaderMaterial({
      vertexShader: SHOOT_VERT,
      fragmentShader: SHOOT_FRAG,
      uniforms: { uAlpha: { value: 0 } },
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    this.shootMesh = new Mesh(sg, this.shootMaterial);
    this.shootMesh.frustumCulled = false;
    this.shootMesh.renderOrder = -85;
    this.shootMesh.visible = false;
    this.shootMesh.layers.enable(REFLECT_LAYER);

    this.group.add(this.points, this.bright, this.shootMesh);
    this.scheduleShootingStar();
    this.applyRotation();
  }

  setCount(count: number): void {
    this.points.geometry.setDrawRange(0, Math.min(count, SKY.starCount));
  }

  setPixelRatio(pixelRatio: number): void {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
    this.brightMaterial.uniforms.uPixelRatio.value = pixelRatio;
  }

  update(dt: number, elapsed: number, cycle: DayCycle, camera: PerspectiveCamera): void {
    this.group.position.copy(camera.position);
    this.angle += ((SKY.rotationSpeed * Math.PI) / 180) * dt * cycle.timeScale;
    this.applyRotation();

    const visible = cycle.stars > 0.005;
    this.points.visible = visible;
    this.bright.visible = visible;
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uStars.value = cycle.stars;
    this.brightMaterial.uniforms.uTime.value = elapsed;
    this.brightMaterial.uniforms.uStars.value = cycle.stars;

    this.updateShootingStar(dt, cycle, camera);
  }

  private applyRotation(): void {
    this.quaternion.setFromAxisAngle(this.pole, this.angle);
    this.points.quaternion.copy(this.quaternion);
    this.bright.quaternion.copy(this.quaternion);
    this.m4.makeRotationFromQuaternion(this.quaternion);
    // Inverse of a rotation is its transpose.
    this.skyRotation.setFromMatrix4(this.m4).transpose();
  }

  private scheduleShootingStar(): void {
    const [min, max] = SKY.shootingStarInterval;
    this.shootTimer = min + this.rand() * (max - min);
  }

  /** Start a shooting star now (also used by the debug key). */
  triggerShootingStar(camera: PerspectiveCamera): void {
    const forward = camera.getWorldDirection(this.v1);
    forward.y = 0;
    forward.normalize();
    const right = this.v2.set(-forward.z, 0, forward.x);
    const yaw = (this.rand() - 0.5) * 1.1;
    const elevation = 0.3 + this.rand() * 0.3;
    const side = this.rand() < 0.5 ? -1 : 1;

    // Start direction in front of the camera, up in the sky.
    this.shootStart
      .copy(forward)
      .multiplyScalar(Math.cos(yaw))
      .addScaledVector(right, Math.sin(yaw))
      .multiplyScalar(Math.cos(elevation));
    this.shootStart.y = Math.sin(elevation);
    this.shootStart.normalize();

    // Travel sideways and gently downward.
    this.shootVel.copy(right).multiplyScalar(side);
    this.shootVel.y = -(0.3 + this.rand() * 0.45);
    this.shootVel.normalize();
    this.shootDuration = 0.75 + this.rand() * 0.45;
    this.shootVel.multiplyScalar((0.2 + this.rand() * 0.1) / this.shootDuration);

    this.shootAge = 0;
    this.shootMesh.visible = true;
    this.onShootingStar?.();
  }

  private updateShootingStar(dt: number, cycle: DayCycle, camera: PerspectiveCamera): void {
    if (this.shootAge < 0) {
      if (cycle.stars > 0.55) {
        this.shootTimer -= dt;
        if (this.shootTimer <= 0) {
          this.scheduleShootingStar();
          this.triggerShootingStar(camera);
        }
      }
      return;
    }

    this.shootAge += dt;
    const t = this.shootAge / this.shootDuration;
    if (t >= 1) {
      this.shootAge = -1;
      this.shootMesh.visible = false;
      return;
    }

    const head = this.v1.copy(this.shootStart).addScaledVector(this.shootVel, this.shootAge).normalize();
    const tailLen = 0.085 * Math.min(1, t * 4);
    const tail = this.v2.copy(head).addScaledVector(this.shootVel, -tailLen / this.shootVel.length()).normalize();
    const across = this.v3.crossVectors(head, this.shootVel).normalize().multiplyScalar(SKY_RADIUS * 0.0016);
    head.multiplyScalar(SKY_RADIUS);
    tail.multiplyScalar(SKY_RADIUS);

    const p = this.shootPositions;
    this.v4.copy(tail).sub(across).toArray(p, 0);
    this.v4.copy(tail).add(across).toArray(p, 3);
    this.v4.copy(head).sub(across).toArray(p, 6);
    this.v4.copy(head).add(across).toArray(p, 9);
    this.shootMesh.geometry.attributes.position.needsUpdate = true;

    // Fade in fast, fade out slow; brighter when the sky is fully dark.
    const fade = Math.min(1, t * 6) * (1 - t) * (1 - t);
    this.shootMaterial.uniforms.uAlpha.value = fade * 1.6 * Math.max(cycle.stars, 0.5);
  }
}
