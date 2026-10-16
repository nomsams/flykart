// A brain that is built in layers, oldest first.
//
// A person's brain is not one homogeneous lump: old structures that every mammal shares keep their reflexes, newer
// structures sit on top and add analysis, and evolution rarely rewrites the old ones. Here that is a plan over the
// hidden neurons of one ordinary spiking network:
//
//   layer 0  the core: everything the brain could do before (steer, brake, avoid)
//   layer 1  added later: reads the same inputs and the core's spikes, and adds its own pull on the outputs
//   layer 2  ...
//
// Two rules make it a hierarchy. (1) A neuron may listen to its own layer and to older layers, never to newer ones, so
// an older layer stays a complete little brain that the newer one rides on. (2) Each layer has a plasticity between 0
// and 1: a mutation of a neuron in a layer with plasticity 0.2 moves only a fifth as far, and 0 leaves it exactly as it
// was. When a layer is added the older ones are made stiffer, so learning a new skill does not overwrite the old ones
// (the "forgot how to navigate" problem). The result is still one 19 -> N -> 4 network and a normal brain file.
import type { BrainSnapshot } from "../core";
import { growBrain } from "./brain-size";

export type Layer = { name: string; start: number; end: number; plasticity: number };
export type BrainPlan = { layers: Layer[] };

export const singleLayer = (hidden: number): BrainPlan => ({ layers: [{ name: "core", start: 0, end: hidden, plasticity: 1 }] });

export function validatePlan(plan: BrainPlan, hidden: number): BrainPlan {
  const layers = plan?.layers;
  if (!Array.isArray(layers) || !layers.length) return singleLayer(hidden);
  let at = 0;
  for (const l of layers) { if (l.start !== at || l.end <= l.start || !(l.plasticity >= 0 && l.plasticity <= 1)) return singleLayer(hidden); at = l.end; }
  return at === hidden ? plan : singleLayer(hidden);
}

/** Add a layer of `extra` neurons on top; every older layer becomes at most `protect` times as plastic as it was. */
export function addLayer(plan: BrainPlan, brain: BrainSnapshot, extra: number, seed: number, protect: number, name?: string, kenyonShare = 0): { plan: BrainPlan; brain: BrainSnapshot } {
  const hidden = brain.hiddenCount, grown = growBrain(brain, extra, seed, Math.round(extra * Math.max(0, Math.min(1, kenyonShare))));
  const layers = validatePlan(plan, hidden).layers.map((l) => ({ ...l, plasticity: l.plasticity * protect }));
  layers.push({ name: name ?? `layer ${layers.length}`, start: hidden, end: hidden + extra, plasticity: 1 });
  return { plan: { layers }, brain: constrain(grown, grown, { layers }) };
}

/**
 * Make a candidate obey the plan, relative to the brain it came from: older layers do not listen to newer ones, and a
 * layer with plasticity s keeps only s of the change. Pass the same brain twice to enforce the hierarchy alone.
 */
export function constrain(child: BrainSnapshot, parent: BrainSnapshot, plan: BrainPlan): BrainSnapshot {
  const H = child.hiddenCount, I = child.inputCount, O = child.outputCount ?? 4;
  if (parent.hiddenCount !== H || plan.layers.length < 2 && plan.layers[0]?.plasticity === 1 && plan.layers[0].end === H) return child;
  const layerOf = new Int32Array(H);
  plan.layers.forEach((l, k) => { for (let n = l.start; n < l.end && n < H; n += 1) layerOf[n] = k; });
  const out: BrainSnapshot = { ...child, inputWeights: [...child.inputWeights], recurrentWeights: [...child.recurrentWeights], outputWeights: [...child.outputWeights], bias: [...child.bias] };
  const blend = (c: number, p: number, s: number): number => (s >= 1 ? c : s <= 0 ? p : p + s * (c - p));
  for (let n = 0; n < H; n += 1) {
    const layer = plan.layers[layerOf[n]], s = layer.plasticity;
    for (let i = 0; i < I; i += 1) { const k = n * I + i; out.inputWeights[k] = blend(child.inputWeights[k], parent.inputWeights[k], s); }
    for (let p = 0; p < H; p += 1) {
      const k = n * H + p;
      // Older layers never listen to newer ones.
      out.recurrentWeights[k] = p >= layer.end ? 0 : blend(child.recurrentWeights[k], parent.recurrentWeights[k], s);
    }
    out.bias[n] = blend(child.bias[n], parent.bias[n], s);
    for (let o = 0; o < O; o += 1) { const k = o * H + n; out.outputWeights[k] = blend(child.outputWeights[k], parent.outputWeights[k], s); }
  }
  return out;
}

/** One line for logs and the page. */
export function describePlan(plan: BrainPlan): string {
  return plan.layers.map((l) => `${l.name} ${l.end - l.start}${l.plasticity < 1 ? ` (plasticity ${l.plasticity.toFixed(2)})` : ""}`).join(" + ");
}
