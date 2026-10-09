import { TargetTracker } from '../../robot/target-tracker';
import type { ColourTarget } from '../../robot/sensor-contract';

/** An explicit colour detector, not a learned target head or a simulator compass. */
const FLAG: ColourTarget = { hue: 328.5, tolerance: 18, minSaturation: .35, minValue: .18, diameter: .14 };
export type SearchWin = 'sight' | 'reach';

export class FlagDiscovery {
  // The distant 48×24 flag can occupy just two adjacent pixels. The 3D tracker keeps its default threshold.
  readonly tracker: TargetTracker;
  firstSightTick: number | null = null;
  private lastTick = -Infinity;
  private consecutive = 0;
  private trackId: number | null = null;
  private readonly views = new Set<string>();
  constructor(readonly width: number, readonly height: number, readonly hfov: number) {
    this.tracker = new TargetTracker(Math.max(2, Math.ceil(width * height * .0015)));
  }
  get visualViews(): number { return this.views.size; }
  /** Timestamp of the most recent processed camera frame, not simulator target data. */
  get sampleTick(): number | null { return Number.isFinite(this.lastTick) ? this.lastTick : null; }
  reset(): void {
    this.tracker.reset(); this.firstSightTick = null; this.lastTick = -Infinity;
    this.consecutive = 0; this.trackId = null; this.views.clear();
  }
  observe(pixels: Float32Array, tick: number): void {
    if (tick === this.lastTick) return; // Held camera frames cannot confirm a sighting twice.
    if (tick < this.lastTick) this.reset();
    this.lastTick = tick;
    const sight = this.tracker.see(pixels, this.width, this.height, FLAG, tick);
    this.consecutive = sight.visible ? (sight.id === this.trackId ? this.consecutive + 1 : 1) : 0;
    this.trackId = sight.id;
    if (this.consecutive >= 2 && this.firstSightTick === null) this.firstSightTick = tick;
    // A small external tie-break for unsuccessful trials, based only on coarse camera views.
    // Bounded: it can never outweigh finding the target, and is not fed to the controller.
    if (this.views.size < 64) {
      const n = this.width * this.height, signature: number[] = [];
      for (let channel = 0; channel < 3; channel++) for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
        let sum = 0, count = 0;
        for (let py = Math.floor(y * this.height / 2); py < Math.floor((y + 1) * this.height / 2); py++)
          for (let px = Math.floor(x * this.width / 4); px < Math.floor((x + 1) * this.width / 4); px++) { sum += pixels[channel * n + py * this.width + px]; count++; }
        signature.push(Math.round(sum / Math.max(1, count) * 7));
      }
      this.views.add(signature.join(','));
    }
  }
  /** Bearing from the image and apparent size. Neither value uses world position or true range. */
  cue(): number[] {
    const s = this.tracker.current;
    return s.visible ? [Math.atan(s.bearing * Math.tan(this.hfov / 2)) / Math.PI, Math.min(1, Math.sqrt(s.area) * 4)] : [0, 0];
  }
}
