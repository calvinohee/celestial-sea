import { AUTO_QUALITY, QUALITY_ORDER, type QualityMode, type QualityTier } from '../config';

/**
 * Frame limiter: is it time to render again? Rendering is capped at `fps` even
 * when the display refreshes faster (60 on a 120 Hz screen, 30 in battery
 * mode). The 3 ms of slack stops timer jitter from halving the rate on a
 * display that refreshes at exactly the target.
 */
export function frameDue(sinceLastRenderMs: number, fps: number): boolean {
  return sinceLastRenderMs >= 1000 / fps - 3;
}

/**
 * Chooses the quality tier.
 *
 * In High or Low it simply holds that tier. In Auto it watches rendered frame
 * times over a rolling window: sustained slowness steps down one tier; a long
 * calm spell earns one cautious step back up. Because a vsynced frame can
 * never be *faster* than the target, stepping up is a trial: if it turns slow
 * again straight away the controller steps back down and waits twice as long
 * before the next try.
 *
 * Pure logic (no rendering), so it is unit-tested with synthetic frame times.
 */
export class AutoQuality {
  mode: QualityMode;
  tier: QualityTier;

  private readonly times = new Float32Array(AUTO_QUALITY.window);
  private count = 0;
  private next = 0;
  private sum = 0;

  private settle: number = AUTO_QUALITY.settleSeconds;
  private slowFor = 0;
  private goodFor = 0;
  private upWait: number = AUTO_QUALITY.upSeconds;
  /** Seconds since the last step up; Infinity when not on trial. */
  private trial = Infinity;

  /**
   * @param mode the player's setting
   * @param autoStart tier Auto begins on (phones start a notch lower and earn their way up)
   */
  constructor(mode: QualityMode, autoStart: QualityTier = 'high') {
    this.mode = mode;
    this.tier = mode === 'auto' ? autoStart : mode;
  }

  /** Change the player's setting. Returns the tier now in force. */
  setMode(mode: QualityMode): QualityTier {
    this.mode = mode;
    if (mode !== 'auto') this.tier = mode;
    this.reset();
    this.upWait = AUTO_QUALITY.upSeconds;
    this.trial = Infinity;
    return this.tier;
  }

  /** Forget recent history (after a pause, resize or tier change). */
  reset(): void {
    this.count = 0;
    this.next = 0;
    this.sum = 0;
    this.slowFor = 0;
    this.goodFor = 0;
    this.settle = AUTO_QUALITY.settleSeconds;
  }

  /** Average of the rolling window in seconds (0 until there is data). */
  get average(): number {
    return this.count > 0 ? this.sum / this.count : 0;
  }

  /**
   * Feed one rendered frame.
   * @param frameSeconds time since the previous rendered frame
   * @param targetSeconds the frame time being aimed for (1/60, or 1/30 in battery mode)
   * @returns the new tier if it changed, otherwise null
   */
  sample(frameSeconds: number, targetSeconds: number): QualityTier | null {
    if (this.mode !== 'auto') return null;
    // A huge gap is a stall (tab switch, system dialog), not a slow GPU.
    if (frameSeconds > 0.5) {
      this.reset();
      return null;
    }
    if (this.settle > 0) {
      this.settle -= frameSeconds;
      return null;
    }

    if (this.count === this.times.length) this.sum -= this.times[this.next];
    else this.count++;
    this.times[this.next] = frameSeconds;
    this.sum += frameSeconds;
    this.next = (this.next + 1) % this.times.length;
    if (this.count < this.times.length / 2) return null;

    const ratio = this.average / targetSeconds;
    this.trial += frameSeconds;
    const index = QUALITY_ORDER.indexOf(this.tier);

    if (ratio > AUTO_QUALITY.slowRatio) {
      this.goodFor = 0;
      this.slowFor += frameSeconds;
      if (this.slowFor >= AUTO_QUALITY.downSeconds && index < QUALITY_ORDER.length - 1) {
        // Turning slow right after a step up means that tier is too much for now.
        if (this.trial < AUTO_QUALITY.trialSeconds) {
          this.upWait = Math.min(AUTO_QUALITY.maxUpSeconds, this.upWait * 2);
        }
        this.trial = Infinity;
        return this.change(QUALITY_ORDER[index + 1]);
      }
    } else {
      this.slowFor = 0;
      if (ratio < AUTO_QUALITY.goodRatio) this.goodFor += frameSeconds;
      else this.goodFor = 0;
      if (this.goodFor >= this.upWait && index > 0) {
        this.trial = 0;
        return this.change(QUALITY_ORDER[index - 1]);
      }
    }
    return null;
  }

  private change(tier: QualityTier): QualityTier {
    this.tier = tier;
    this.reset();
    return tier;
  }
}
