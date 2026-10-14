// Lifetime learning: a few supervised passes of the brain's own readout on its own best trials.
//
// Selection finds a good brain by luck in mutation; the brain itself never learns from what it just did. This step
// replays trials the brain solved, records what it saw and did at every tick, and nudges its output weights toward
// those actions (the delta rule the network already has, `trainActionReadout`). It keeps the successful, steady
// choices and averages out the twitches. The result is only a candidate: it is entered in the confirmation round
// against the unpolished brain on trials neither has seen, and adopted only if it wins there.
import { SpikingNetwork, type BrainSnapshot } from "../core";
import { mulberry32 } from "../vision/rng";
import { caseFor } from "./cases";
import { runEpisode } from "./drive";
import { constrain, type BrainPlan } from "./layers";
import { sampleReality } from "./reality";
import { buildScenario } from "./scenario";

export type PolishOptions = {
  stage: number; seed: number;
  /** Trials to try (only the ones that reach every flag are learned from). */
  trials?: number; epochs?: number; rate?: number;
  plan?: BrainPlan;
};

export type PolishResult = { brain: BrainSnapshot; samples: number; solved: number } | null;

export function polish(snapshot: BrainSnapshot, o: PolishOptions): PolishResult {
  const trials = o.trials ?? 8, epochs = o.epochs ?? 2, rate = o.rate ?? 0.004;
  const sequences: { input: number[]; action: { steer: number; throttle: number; brake: number; reverse: number } }[][] = [];
  const driver = SpikingNetwork.fromJSON(snapshot);
  for (let k = 0; k < trials; k += 1) {
    const spec = caseFor(o.stage, 6_500_000 + o.seed * 31 + k);
    const scenario = buildScenario(spec.scenario);
    const reality = sampleReality(mulberry32(spec.seed + 4), spec.severity, spec.speedFeedback);
    const result = runEpisode(driver, scenario, reality, { seed: spec.seed, record: true, stallCutoffSeconds: 0 });
    if (result.goals >= result.goalTarget && !result.crashed && result.samples && result.samples.length > 60) sequences.push(result.samples);
  }
  if (!sequences.length) return null;
  const student = SpikingNetwork.fromJSON(snapshot);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const sequence of sequences) {
      // Each trial is a separate life: the network's own state starts clean, as it did when the data was recorded.
      student.reset();
      for (const s of sequence) student.trainActionReadout(s.input, s.action, rate / (1 + epoch));
    }
  }
  student.reset();
  const trained = student.toJSON();
  return { brain: o.plan ? constrain(trained, snapshot, o.plan) : trained, samples: sequences.reduce((a, s) => a + s.length, 0), solved: sequences.length };
}
