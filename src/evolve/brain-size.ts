// Growing, pruning and mapping brains.
//
// The controller is a ring of leaky spiking neurons with a recurrent weight matrix, read out by four output
// pools. More hidden neurons means more parameters to evolve (a bigger, harder search) and more capacity for
// distinct manoeuvres. `growBrain` adds neurons that change nothing at first, so a grown brain starts out
// driving exactly like its parent and evolution then decides whether to use the room.
import type { BrainSnapshot } from "../core";
import { mulberry32 } from "../vision/rng";

const clone = (s: BrainSnapshot): BrainSnapshot => ({ ...s, inputWeights: [...s.inputWeights], recurrentWeights: [...s.recurrentWeights], outputWeights: [...s.outputWeights], bias: [...s.bias] });

/** How many inputs each Kenyon-style neuron listens to (a fly's Kenyon cell has about six dendritic claws). */
export const KENYON_CLAWS = 4;

/**
 * Add `extra` hidden neurons that start with no influence on anything (function preserving). The first `kenyon` of them
 * are Kenyon-style: each listens to only a few inputs (with a mix of signs, so it is a small pattern detector), hears
 * nothing from the older neurons, and sits below threshold unless most of its pattern is present at once. Few of them
 * fire at any moment, so what a new layer learns about one kind of situation does not leak into the others, which is
 * how an insect's mushroom body keeps one memory from overwriting another. The rest are the ordinary dense neurons.
 */
export function growBrain(snapshot: BrainSnapshot, extra: number, seed: number, kenyon = 0): BrainSnapshot {
  if (extra <= 0) return clone(snapshot);
  const H = snapshot.hiddenCount, I = snapshot.inputCount, G = H + extra, random = mulberry32(seed);
  const gauss = (): number => (random() + random() + random() - 1.5) * 2;
  const sparse = Math.max(0, Math.min(extra, Math.round(kenyon)));
  const inputWeights: number[] = [], recurrentWeights: number[] = [], outputWeights: number[] = [], bias: number[] = [];
  const kenyonBias: number[] = [];
  for (let n = 0; n < G; n += 1) {
    if (n < H) { for (let i = 0; i < I; i += 1) inputWeights.push(snapshot.inputWeights[n * I + i]); continue; }
    if (n - H >= sparse) { for (let i = 0; i < I; i += 1) inputWeights.push(gauss() * 0.3); continue; }
    // A pattern over a few inputs: the positive claws want their input high, the negative ones low.
    const claws = new Set<number>(); while (claws.size < Math.min(KENYON_CLAWS, I)) claws.add(Math.floor(random() * I));
    let positive = 0;
    for (let i = 0; i < I; i += 1) {
      if (!claws.has(i)) { inputWeights.push(0); continue; }
      const w = (0.25 + 0.3 * random()) * (random() < 0.6 ? 1 : -1);
      if (w > 0) positive += w;
      inputWeights.push(w);
    }
    kenyonBias[n] = -0.25 * positive;
  }
  for (let n = 0; n < G; n += 1) for (let p = 0; p < G; p += 1) {
    if (n < H && p < H) recurrentWeights.push(snapshot.recurrentWeights[n * H + p]);
    else if (n < H) recurrentWeights.push(0); // new neurons do not drive old ones yet
    else if (n - H < sparse) recurrentWeights.push(0); // a Kenyon-style neuron hears only its inputs
    else recurrentWeights.push(gauss() * 0.05); // old neurons feed the dense new ones
  }
  for (let o = 0; o < (snapshot.outputCount ?? 4); o += 1) for (let n = 0; n < G; n += 1) outputWeights.push(n < H ? snapshot.outputWeights[o * H + n] : 0);
  for (let n = 0; n < G; n += 1) bias.push(n < H ? snapshot.bias[n] : kenyonBias[n] ?? random() * 0.04);
  return { ...snapshot, hiddenCount: G, inputWeights, recurrentWeights, outputWeights, bias };
}

/** How much each hidden neuron matters, from its weights alone: its pull on the outputs and on its neighbours. */
export function neuronImportance(s: BrainSnapshot): number[] {
  const H = s.hiddenCount, out = new Array(H).fill(0);
  for (let n = 0; n < H; n += 1) {
    for (let o = 0; o < (s.outputCount ?? 4); o += 1) out[n] += Math.abs(s.outputWeights[o * H + n]);
    for (let m = 0; m < H; m += 1) out[n] += 0.25 * Math.abs(s.recurrentWeights[m * H + n]);
  }
  return out;
}

/** Keep the `keep` most influential neurons. The result drives differently; score it before trusting it. */
export function shrinkBrain(snapshot: BrainSnapshot, keep: number): BrainSnapshot {
  const H = snapshot.hiddenCount;
  if (keep >= H) return clone(snapshot);
  const importance = neuronImportance(snapshot);
  const kept = importance.map((v, n) => ({ v, n })).sort((a, b) => b.v - a.v).slice(0, keep).map((e) => e.n).sort((a, b) => a - b);
  const I = snapshot.inputCount;
  const inputWeights: number[] = [], recurrentWeights: number[] = [], outputWeights: number[] = [], bias: number[] = [];
  for (const n of kept) for (let i = 0; i < I; i += 1) inputWeights.push(snapshot.inputWeights[n * I + i]);
  for (const n of kept) for (const p of kept) recurrentWeights.push(snapshot.recurrentWeights[n * H + p]);
  for (let o = 0; o < (snapshot.outputCount ?? 4); o += 1) for (const n of kept) outputWeights.push(snapshot.outputWeights[o * H + n]);
  for (const n of kept) bias.push(snapshot.bias[n]);
  return { ...snapshot, hiddenCount: keep, inputWeights, recurrentWeights, outputWeights, bias };
}

const PROJECTION_DIMS = 8;
const mixHash = (a: number, b: number, c: number, d: number): number => {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 0x165667b1, 0x27d4eb2f) ^ Math.imul(d + 0x1b873593, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
};
const gaussFromHash = (h: number): number => {
  const u = ((h & 0xffff) + 0.5) / 65536, v = ((h >>> 16) + 0.5) / 65536;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/**
 * A fixed random projection of the weights to 8 numbers. Each weight keeps the same random direction whatever the brain's
 * size, so a grown brain lands near its parent, and distances between brains mean something across the whole run.
 */
export function projectGenome(s: BrainSnapshot): number[] {
  const out = new Array(PROJECTION_DIMS).fill(0), H = s.hiddenCount, I = s.inputCount;
  const add = (layer: number, i: number, j: number, w: number): void => {
    if (w === 0) return;
    for (let k = 0; k < PROJECTION_DIMS; k += 1) out[k] += w * gaussFromHash(mixHash(layer, i, j, k));
  };
  for (let n = 0; n < H; n += 1) {
    for (let i = 0; i < I; i += 1) add(1, n, i, s.inputWeights[n * I + i]);
    for (let p = 0; p < H; p += 1) add(2, n, p, s.recurrentWeights[n * H + p] * 2);
    for (let o = 0; o < (s.outputCount ?? 4); o += 1) add(3, o, n, s.outputWeights[o * H + n]);
    add(4, n, 0, s.bias[n] * 4);
  }
  const scale = 1 / Math.sqrt(Math.max(1, s.inputWeights.length));
  return out.map((v) => v * scale);
}

export function projectionDistance(a: number[], b: number[]): number {
  let s = 0; for (let k = 0; k < a.length; k += 1) s += (a[k] - b[k]) ** 2;
  return Math.sqrt(s);
}

/** Per-tick cost on the ESP32, in multiply-accumulates, and weight memory in bytes (float32). */
export function brainCost(hidden: number, inputs = 19, outputs = 4): { macsPerTick: number; weightBytes: number; weights: number } {
  const weights = hidden * inputs + hidden * hidden + outputs * hidden + hidden;
  return { macsPerTick: hidden * inputs + hidden * hidden + outputs * hidden, weightBytes: weights * 4, weights };
}
