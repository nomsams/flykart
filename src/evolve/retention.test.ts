import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { mulberry32 } from "../vision/rng";
import { InlineBackend } from "./backend";
import { growBrain, KENYON_CLAWS } from "./brain-size";
import { BASE_OBJECTIVE } from "./objective";
import { caseFor, trainingBattery } from "./cases";
import { runEpisode } from "./drive";
import { EvolutionEngine, type Individual } from "./engine";
import { sampleReality } from "./reality";
import { buildScenario } from "./scenario";

const seed = new SpikingNetwork(21, 19).toJSON();
const config = {
  population: 6, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 1, patience: 2, tournamentSize: 2,
  branchesPerStage: 1, maxGenerationsPerBranch: 3, lastStage: 2, runSeed: 5, keepPerStage: 2, maxClimbsPerStage: 3, stageStall: 99,
};
type Hidden = { assignBreedingValues(c: Individual[], p: Individual[]): void; replayPlan(): { share: number; weights?: number[] } };

describe("rehearsal of earlier stages", () => {
  it("favours the stage being forgotten, and changes nothing when no weights are given", () => {
    const count = (weights?: number[]): number[] => {
      const by = [0, 0, 0];
      for (let g = 1; g <= 120; g += 1) for (const c of trainingBattery(3, g, 7, 8, BASE_OBJECTIVE, 0.5, { replayWeights: weights })) if (c.stage < 3) by[c.stage] += 1;
      return by;
    };
    const even = count(), weighted = count([0.1, 0.1, 6]);
    expect(Math.max(...even) / Math.min(...even)).toBeLessThan(1.5);
    expect(weighted[2]).toBeGreaterThan(5 * (weighted[0] + weighted[1]));
    const plain = trainingBattery(3, 4, 7, 8, BASE_OBJECTIVE, 0.4), withUndefined = trainingBattery(3, 4, 7, 8, BASE_OBJECTIVE, 0.4, { replayWeights: undefined });
    expect(withUndefined).toEqual(plain);
  });

  it("raises the share of rehearsal, and aims it, while a skill is slipping", () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend()), hidden = engine as unknown as Hidden;
    engine.state.stage = 2;
    expect(hidden.replayPlan()).toEqual({ share: 0.3 }); // nothing measured yet
    engine.state.retention = { 0: { reach: 0.1, target: 0.8 }, 1: { reach: 0.8, target: 0.8 } };
    const plan = hidden.replayPlan();
    expect(plan.share).toBeGreaterThan(0.6);
    expect(plan.weights![0]).toBeGreaterThan(5 * plan.weights![1]);
    engine.state.config.retainShare = 0;
    expect(hidden.replayPlan()).toEqual({ share: 0.3 });
  });
});

describe("keeping earlier stages as a condition of moving on", () => {
  it("does not move on while the brain has forgotten an earlier stage, then does once the check is off", async () => {
    const engine = EvolutionEngine.fresh(seed, { ...config, retainShare: 1 }, new InlineBackend());
    engine.state.goals = { 0: 2 };
    await engine.run(() => engine.state.generation > 80);
    engine.moveOn();
    expect(engine.state.stage).toBe(1);
    // Stage 1 once ended at 100 % of flags; stage 2's goal is trivially reached. Keeping 100 % of that is not.
    engine.state.stageResults[0].reach = 1; engine.state.goals = { 0: 1, 1: 0 };
    await engine.run(() => engine.state.generation > 200);
    const stalled = engine.state.stalled!;
    expect(stalled).toBeTruthy();
    expect(engine.state.stage).toBe(1);
    expect(stalled.forgot).toEqual([0]);
    expect(stalled.why).toMatch(/forgets stage 1/);
    expect(engine.state.retention?.[0]?.target).toBe(1);
    // Asking to carry on does not slip past the check just because the new stage's goal is met.
    engine.continueStage(2);
    expect(engine.state.stage).toBe(1);
    expect(engine.state.stalled).toBeNull();
    engine.state.config.retainShare = 0;
    await engine.run(() => engine.state.generation > 320);
    expect(engine.state.stage).toBe(2);
    expect(engine.state.stageResults.find((r) => r.stage === 1)?.mastered).toBe(true);
  }, 400000);
});

describe("estimated breeding value", () => {
  const make = (id: string, fitNow: number, extra: Partial<Individual> = {}): Individual =>
    ({ id, brain: seed, parent: null, mate: null, origin: "test", born: 1, fit: fitNow, fitNow, age: 0, traits: { search: 0, safety: 0, speed: 0, smooth: 0, tidy: 0 }, crashRate: 0, reach: 0, partial: false, ...extra });

  it("gives a child its parents' value, and a parent the value of what it has sired", () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend()), hidden = engine as unknown as Hidden;
    const previous = [make("P1", 0, { ebv: 20 }), make("P2", 0, { ebv: -20 })];
    const children = [make("c1", 5, { parent: "P1" }), make("c2", 5, { parent: "P2" })];
    hidden.assignBreedingValues(children, previous);
    expect(children[0].ebv!).toBeGreaterThan(children[1].ebv! + 10);
    // Two elites with the same score today: the one whose children did well in earlier generations ranks higher.
    engine.state.progeny = { good: [4, 60], bad: [4, -60] };
    const elites = [make("good", 10, { age: 3 }), make("bad", 10, { age: 3 }), make("filler", 0)];
    hidden.assignBreedingValues(elites, elites);
    expect(elites[0].ebv!).toBeGreaterThan(elites[1].ebv!);
    // Only parents that are still alive keep a record.
    expect(Object.keys(engine.state.progeny!).sort()).toEqual(["bad", "good"]);
  });
});

describe("Kenyon-style neurons in a new layer", () => {
  const base = new SpikingNetwork(7, 19).toJSON();

  it("start as quiet pattern detectors that change nothing, listen to a few inputs and hear nothing from the old neurons", () => {
    const grown = growBrain(base, 8, 3, 8), H = base.hiddenCount;
    for (let n = H; n < H + 8; n += 1) {
      const heard = grown.inputWeights.slice(n * 19, (n + 1) * 19).filter((w) => w !== 0).length;
      expect(heard).toBeGreaterThan(0); expect(heard).toBeLessThanOrEqual(KENYON_CLAWS);
      expect(grown.bias[n]).toBeLessThan(0);
      for (let p = 0; p < H; p += 1) expect(grown.recurrentWeights[n * (H + 8) + p]).toBe(0);
    }
    expect(grown.outputWeights.slice(0).filter((_, k) => k % (H + 8) >= H).every((w) => w === 0)).toBe(true);
    const a = SpikingNetwork.fromJSON(base), b = SpikingNetwork.fromJSON(grown);
    for (let t = 0; t < 60; t += 1) {
      const x = Array.from({ length: 19 }, (_, i) => Math.sin(t * 0.37 + i));
      expect(b.step(x)).toEqual(a.step(x));
    }
  });

  it("fire rarely, and disturb what the old neurons do far less than dense neurons once they have learned something", () => {
    const driver = SpikingNetwork.fromJSON(base), inputs: number[][] = [];
    for (let k = 0; k < 3; k += 1) {
      const spec = caseFor(0, 8800 + k), scenario = buildScenario(spec.scenario);
      const r = runEpisode(driver, scenario, sampleReality(mulberry32(spec.seed + 4), spec.severity, spec.speedFeedback), { seed: spec.seed, record: true, stallCutoffSeconds: 0 });
      for (const s of r.samples ?? []) inputs.push(s.input);
    }
    expect(inputs.length).toBeGreaterThan(300);
    const EXTRA = 16, H = base.hiddenCount;
    const measure = (kenyon: number): { rate: number; moved: number } => {
      const grown = growBrain(base, EXTRA, 11, kenyon), taught = JSON.parse(JSON.stringify(grown));
      const random = mulberry32(5);
      for (let o = 0; o < 4; o += 1) for (let n = H; n < H + EXTRA; n += 1) taught.outputWeights[o * (H + EXTRA) + n] = (random() * 2 - 1) * 0.8;
      const reference = SpikingNetwork.fromJSON(base), probe = SpikingNetwork.fromJSON(grown), changed = SpikingNetwork.fromJSON(taught);
      let fired = 0, delta = 0;
      for (const x of inputs) {
        const r = reference.step(x), c = changed.step(x); probe.step(x);
        const spikes = probe.activity().spikes; for (let n = H; n < H + EXTRA; n += 1) fired += spikes[n] ? 1 : 0;
        delta += Math.abs(r.steer - c.steer) + Math.abs(r.throttle - c.throttle) + Math.abs(r.brake - c.brake) + Math.abs((r.reverse ?? 0) - (c.reverse ?? 0));
      }
      return { rate: fired / (inputs.length * EXTRA), moved: delta / (inputs.length * 4) };
    };
    const dense = measure(0), kenyon = measure(EXTRA);
    expect(kenyon.rate).toBeLessThan(0.05);
    expect(kenyon.rate).toBeLessThan(dense.rate);
    expect(kenyon.moved).toBeLessThan(0.7 * dense.moved);
  });
});

describe("more capacity before giving up", () => {
  it("tries a grown layer once when a stage has stopped improving, before it stops the run", async () => {
    const engine = EvolutionEngine.fresh(seed, { ...config, stageStall: 1, maxClimbsPerStage: 40, growBy: 8, maxHidden: 128, lastStage: 0 }, new InlineBackend());
    const lines: string[] = []; engine.on((e) => { if (e.type === "log") lines.push(e.text); });
    engine.state.goals = { 0: 2 };
    await engine.run(() => engine.state.generation > 200);
    expect(lines.some((l) => /trying \+8 neurons before giving up/.test(l))).toBe(true);
    expect(engine.state.stalled).toBeTruthy();
    expect(engine.state.archive.some((m) => m.hidden === 56)).toBe(true);
    expect(lines.filter((l) => /trying \+8 neurons before giving up/.test(l)).length).toBe(1);
  }, 400000);
});
