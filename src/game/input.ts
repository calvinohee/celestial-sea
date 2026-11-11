import { Vector3, type PerspectiveCamera } from 'three';
import { INPUT } from '../config';
import type { SteerState } from '../render/boat';

export interface InputEvents {
  /** A touch/click landed on the water. World x/z plus normalised screen x/y (0..1). */
  onWaterTouch(x: number, z: number, screenX: number, screenY: number): void;
  /** Short tap, or Space: release a lantern. */
  onRelease(): void;
  /** Any other key, for debug shortcuts. */
  onKey?(code: string): void;
}

const FORWARD_KEYS = new Set(['KeyW', 'ArrowUp']);
const BACK_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);

/**
 * Touch, mouse and keyboard.
 * - Hold / drag: steer toward the touched point on the water.
 * - Short tap (or Space): release a lantern.
 * - WASD / arrows: steer.
 * Also shuts down every browser gesture that would scroll, zoom or select.
 */
export class Input {
  private active = false;
  readonly steer: SteerState = { active: false, targetX: 0, targetZ: 0, thrust: 0, turn: 0 };

  private pointerId: number | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private moved = false;
  private readonly keys = new Set<string>();

  /** Off until the title card has gone, and while the settings panel is open. */
  get enabled(): boolean {
    return this.active;
  }

  set enabled(value: boolean) {
    this.active = value;
    if (!value) this.releaseAll();
  }

  private readonly ray = new Vector3();
  private readonly hit = new Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: PerspectiveCamera,
    private readonly events: InputEvents,
  ) {
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseAll);

    // No scroll, pinch-zoom, double-tap zoom, context menu, selection or rubber-banding.
    const block = (e: Event) => e.preventDefault();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'contextmenu', 'dblclick', 'selectstart']) {
      document.addEventListener(type, block, { passive: false });
    }
    // The settings panel opts back in to native touch (sliders, scrolling).
    document.addEventListener(
      'touchmove',
      (e) => {
        const target = e.target as Element | null;
        if (!target?.closest?.('[data-allow-touch]')) e.preventDefault();
      },
      { passive: false },
    );
    let lastTouchEnd = 0;
    document.addEventListener(
      'touchend',
      (e) => {
        const now = performance.now();
        if (now - lastTouchEnd < 350 && e.target === canvas) e.preventDefault();
        lastTouchEnd = now;
      },
      { passive: false },
    );
  }

  /**
   * Project a client position onto the water plane. Returns false when the ray
   * points at the sky; `hit` then holds a far point in that direction instead.
   */
  private project(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const cam = this.camera;
    this.ray.set(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize();
    const o = cam.position;
    if (this.ray.y < -0.012) {
      const t = Math.min(-o.y / this.ray.y, INPUT.targetMax);
      this.hit.set(o.x + this.ray.x * t, 0, o.z + this.ray.z * t);
      return true;
    }
    const l = Math.hypot(this.ray.x, this.ray.z) || 1;
    this.hit.set(o.x + (this.ray.x / l) * INPUT.targetMax, 0, o.z + (this.ray.z / l) * INPUT.targetMax);
    return false;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    if (this.project(e.clientX, e.clientY)) {
      this.events.onWaterTouch(
        this.hit.x,
        this.hit.z,
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
      );
    }
    // The first finger steers; extra fingers only make ripples.
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety, not a requirement */
    }
    this.pointerX = this.downX = e.clientX;
    this.pointerY = this.downY = e.clientY;
    this.downTime = performance.now();
    this.moved = false;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > INPUT.tapMaxMovePx) this.moved = true;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const quick = performance.now() - this.downTime <= INPUT.tapMaxMs;
    this.pointerId = null;
    this.steer.active = false;
    if (this.enabled && quick && !this.moved) this.events.onRelease();
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.steer.active = false;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const steering = FORWARD_KEYS.has(e.code) || BACK_KEYS.has(e.code) || LEFT_KEYS.has(e.code) || RIGHT_KEYS.has(e.code);
    // While disabled (title card, settings panel) keys keep their normal meaning.
    if (!this.enabled) return;
    if (steering || e.code === 'Space') e.preventDefault();
    if (steering) {
      this.keys.add(e.code);
    } else if (!e.repeat) {
      if (e.code === 'Space') this.events.onRelease();
      else this.events.onKey?.(e.code);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly releaseAll = (): void => {
    this.keys.clear();
    this.pointerId = null;
    this.steer.active = false;
  };

  private any(set: Set<string>): boolean {
    for (const k of this.keys) if (set.has(k)) return true;
    return false;
  }

  /** Call once per frame, after the camera has been updated. */
  update(): void {
    const s = this.steer;
    if (!this.enabled) {
      s.active = false;
      s.thrust = 0;
      s.turn = 0;
      return;
    }
    s.thrust = (this.any(FORWARD_KEYS) ? 1 : 0) - (this.any(BACK_KEYS) ? 1 : 0);
    s.turn = (this.any(RIGHT_KEYS) ? 1 : 0) - (this.any(LEFT_KEYS) ? 1 : 0);

    // A press only becomes steering once it is clearly not a tap.
    const held = this.pointerId !== null && (this.moved || performance.now() - this.downTime > INPUT.tapMaxMs * 0.7);
    s.active = held;
    if (held) {
      this.project(this.pointerX, this.pointerY);
      s.targetX = this.hit.x;
      s.targetZ = this.hit.z;
    }
  }
}
