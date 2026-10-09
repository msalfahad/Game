import { TICK_RATE } from './protocol';

const TICK_MS = 1000 / TICK_RATE;
const MIN_MS = TICK_MS * 1.5; // always keep >1 snapshot of buffer to lerp across
const MAX_MS = 180;

/**
 * Adaptive interpolation delay. Remote entities are drawn this many ms in the
 * past so there are always two snapshots to blend between. A clean connection
 * needs only ~1.5 ticks (50ms at 30Hz); a jittery one needs more or remote
 * players stutter. Tracks how irregularly snapshots arrive and sizes the
 * buffer to match, easing toward the target so it never visibly jumps.
 */
export class InterpDelay {
  private ms = 100;
  private jitter = 10;
  private last = 0;

  /** Call once per received snapshot. */
  onSnapshot(now = performance.now()) {
    if (this.last) {
      const dev = Math.abs(now - this.last - TICK_MS);
      this.jitter = this.jitter * 0.9 + Math.min(dev, 200) * 0.1;
      const target = Math.max(MIN_MS, Math.min(MAX_MS, TICK_MS + this.jitter * 2.5));
      this.ms += (target - this.ms) * 0.06;
    }
    this.last = now;
  }

  get delay(): number {
    return this.ms;
  }
}
