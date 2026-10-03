import { mulberry32 } from "../vision/rng";
import { Pose } from "./model";

export type RoomMemorySnapshot = { format: "robot-kenyon-memory"; version: 1; counts: number[]; means: number[][]; prototypes: (number[] | null)[]; map: [string, number][] };
/** Sparse visual Kenyon code. Learns only observed camera estimates, never world meshes. */
export class RoomMemory {
  readonly count = 512;
  readonly active: number[] = [];
  readonly counts = new Float32Array(this.count);
  private readonly projections: Float32Array[];
  private readonly means = Array.from({ length: this.count }, () => new Float32Array(10));
  private readonly prototypes: (Float32Array | null)[] = Array(this.count).fill(null);
  readonly map = new Map<string, number>();
  recalled = false;
  constructor() { const random = mulberry32(751); this.projections = Array.from({ length: this.count }, () => Float32Array.from({ length: 27 }, () => random() * 2 - 1)); }
  get taught(): number { return this.counts.filter(n => n > 0).length; }
  observe(visual: Float32Array, estimates: ArrayLike<number>, learn = true): Float32Array | null {
    if (visual.length !== 24) throw new Error("Room memory expects 24 visual features.");
    const feature = new Float32Array(27); feature.set(visual); feature[24] = 1; feature[25] = visual[0] * visual[12]; feature[26] = visual[5] * visual[17];
    const candidates = this.projections.map((weights, id) => { let value = 0; for (let k = 0; k < feature.length; k++) value += weights[k] * feature[k]; return { id, value }; }).sort((a, b) => b.value - a.value).slice(0, 16);
    this.active.splice(0, this.active.length, ...candidates.map(c => c.id));
    const recall = new Float32Array(10); let n = 0;
    for (const { id } of candidates) {
      const prototype = this.prototypes[id]; let error = 0;
      if (prototype) for (let k = 0; k < 24; k++) error += (visual[k] - prototype[k]) ** 2;
      if (this.counts[id] >= 3 && prototype && error / 24 < .012) { for (let k = 0; k < 10; k++) recall[k] += this.means[id][k]; n++; }
    }
    this.recalled = n >= 6;
    if (learn) for (const { id } of candidates) {
      const rate = 1 / (Math.min(this.counts[id], 50) + 1);
      this.prototypes[id] ??= visual.slice();
      for (let k = 0; k < 24; k++) this.prototypes[id]![k] += rate * (visual[k] - this.prototypes[id]![k]);
      for (let k = 0; k < 10; k++) this.means[id][k] += rate * (estimates[k] - this.means[id][k]);
      this.counts[id]++;
    }
    if (!this.recalled) return null;
    return recall.map(v => v / n);
  }
  /** Sonar bearing is ambiguous, so map hits are marked uncertain. Pose is dead reckoning. */
  mapPing(pose: Pose, mountForward: number, distance: number, echo: boolean): void {
    const max = echo ? distance : 4;
    const startX = pose.x + Math.cos(pose.heading) * mountForward, startZ = pose.z + Math.sin(pose.heading) * mountForward;
    for (let r = .04; r < max - .06; r += .07) {
      const key = `${Math.floor((startX + Math.cos(pose.heading) * r) / .1)},${Math.floor((startZ + Math.sin(pose.heading) * r) / .1)}`;
      this.map.set(key, Math.max(-5, (this.map.get(key) ?? 0) - .25));
    }
    if (echo) { const key = `${Math.floor((startX + Math.cos(pose.heading) * distance) / .1)},${Math.floor((startZ + Math.sin(pose.heading) * distance) / .1)}`; this.map.set(key, Math.min(5, (this.map.get(key) ?? 0) + .8)); }
    if (this.map.size > 12000) this.map.delete(this.map.keys().next().value!);
  }
  toJSON(): RoomMemorySnapshot { return { format: "robot-kenyon-memory", version: 1, counts: Array.from(this.counts), means: this.means.map(m => Array.from(m)), prototypes: this.prototypes.map(m => m ? Array.from(m) : null), map: [...this.map] }; }
  static fromJSON(raw: unknown): RoomMemory {
    const s = raw as RoomMemorySnapshot;
    if (!s || s.format !== "robot-kenyon-memory" || s.version !== 1 || s.counts?.length !== 512 || s.means?.length !== 512 || s.prototypes?.length !== 512 || !Array.isArray(s.map) || s.map.length > 12000) throw new Error("Invalid room memory.");
    const finiteRow = (r: number[], n: number) => Array.isArray(r) && r.length === n && r.every(Number.isFinite);
    if (!finiteRow(s.counts, 512) || s.counts.some(v => v < 0) || s.means.some(r => !finiteRow(r, 10)) || s.prototypes.some(r => r !== null && !finiteRow(r, 24)) || s.map.some(r => !Array.isArray(r) || !/^-?\d+,-?\d+$/.test(r[0]) || !Number.isFinite(r[1]))) throw new Error("Invalid room memory values.");
    const memory = new RoomMemory(); memory.counts.set(s.counts); s.means.forEach((r, i) => memory.means[i].set(r)); memory.prototypes.splice(0, 512, ...s.prototypes.map(r => r ? Float32Array.from(r) : null)); s.map.forEach(([key, value]) => memory.map.set(key, value)); return memory;
  }
}
