/** Pace fixed simulation ticks independently of rendering. Zero means maximum throughput. */
export class StepPacer {
  private previous = 0;
  private credit = 0;
  reset(now: number): void { this.previous = now; this.credit = 0; }
  budget(now: number, multiplier: number): number {
    const elapsed = Math.max(0, Math.min(.25, (now - this.previous) / 1000)); this.previous = now;
    if (multiplier === 0) { this.credit = 0; return 512; }
    this.credit = Math.min(512, this.credit + elapsed * 30 * multiplier);
    return Math.floor(this.credit + 1e-9);
  }
  consume(): void { this.credit = Math.max(0, this.credit - 1); }
}
