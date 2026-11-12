import { PerspectiveCamera, Vector3 } from 'three';
import { CAMERA, COMFORT, type ComfortSettings } from '../config';

export interface FollowTarget {
  x: number;
  z: number;
  /** Radians; 0 faces -Z, positive turns toward +X. */
  heading: number;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Third-person camera: low and behind the boat, slightly to one side.
 *
 * Built to be easy on the stomach: the horizon never tilts, there is no yaw
 * sway, and when the boat turns the view swings round at a capped, smoothly
 * eased rate rather than snapping after it. The pitch is derived from the FOV
 * so the horizon always sits about one third up the screen.
 */
export class CameraRig {
  readonly camera = new PerspectiveCamera(CAMERA.fovLandscape, 1, CAMERA.near, CAMERA.far);
  comfort: ComfortSettings = COMFORT.normal;

  private heading = 0;
  private yawVelocity = 0;
  private readonly position = new Vector3();
  private readonly desired = new Vector3();
  private readonly look = new Vector3();
  private pitch = 0;
  private initialised = false;

  setAspect(aspect: number): void {
    // Wider vertical FOV in portrait so the view does not feel like a keyhole.
    const t = Math.min(1, Math.max(0, (1.3 - aspect) / (1.3 - 0.6)));
    const fov = CAMERA.fovLandscape + (CAMERA.fovPortrait - CAMERA.fovLandscape) * t;
    this.camera.fov = fov;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const halfTan = Math.tan((fov * Math.PI) / 360);
    this.pitch = Math.atan((1 - 2 * CAMERA.horizon) * halfTan);
  }

  update(dt: number, elapsed: number, target: FollowTarget): void {
    if (!this.initialised) {
      this.heading = target.heading;
    } else {
      // Aim for a turn rate proportional to how far behind the view is, never
      // more than the cap, and ease into it so the swing has no sudden start or stop.
      const cap = this.comfort.cameraYawRate;
      const error = wrapAngle(target.heading - this.heading);
      const wanted = Math.max(-cap, Math.min(cap, error * CAMERA.headingStiffness));
      this.yawVelocity += (wanted - this.yawVelocity) * (1 - Math.exp(-2.5 * dt));
      this.heading = wrapAngle(this.heading + this.yawVelocity * dt);
    }

    // A very slow sideways drift so the frame is not dead still (off in Reduce motion).
    const sway = this.comfort.sway;
    const swayX = (Math.sin(elapsed * 0.071) * 0.38 + Math.sin(elapsed * 0.113 + 1.7) * 0.16) * sway;
    const swayY = Math.sin(elapsed * 0.093 + 0.6) * 0.1 * sway;

    const h = this.heading;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    const side = CAMERA.side + swayX;
    this.desired.set(
      target.x - fx * CAMERA.distance + rx * side,
      CAMERA.height + swayY,
      target.z - fz * CAMERA.distance + rz * side,
    );

    if (!this.initialised) {
      this.position.copy(this.desired);
      this.initialised = true;
    } else {
      const k = 1 - Math.exp(-CAMERA.followStiffness * dt);
      this.position.lerp(this.desired, k);
    }

    const cp = Math.cos(this.pitch);
    this.look.set(
      this.position.x + Math.sin(h) * cp,
      this.position.y + Math.sin(this.pitch),
      this.position.z - Math.cos(h) * cp,
    );
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld();
  }
}
