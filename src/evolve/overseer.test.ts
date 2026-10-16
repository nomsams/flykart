import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { mulberry32 } from "../vision/rng";
import type { WorldDef } from "../vision/world/world";
import { InlineBackend } from "./backend";
import { BASE_OBJECTIVE, creditedGoals, episodeTraits, overseer, scoreEpisode } from "./objective";
import { EvolutionEngine, type Individual } from "./engine";
import { caseFor } from "./cases";
import { PIN_GRACE_SECONDS, pinCost, runEpisode, type EpisodeResult } from "./drive";
import { MAX_FOUNDERS, prepareFounders, readFounder } from "./founders";
import { brainFile } from "./persist";
import { IDEAL_REALITY } from "./reality";
import { buildScenario } from "./scenario";
import { SolidIndex } from "./solid-index";

/** A controller that ignores its senses and holds the given pedals, enough to test what the overseer sees. */
const holding = (pedals: { steer?: number; throttle?: number; reverse?: number }): SpikingNetwork =>
  ({ inputCount: 19, reset() { /* stateless */ }, step: () => ({ steer: pedals.steer ?? 0, throttle: pedals.throttle ?? 0, brake: 0, reverse: pedals.reverse ?? 0 }) }) as unknown as SpikingNetwork;

const pocketTrial = (seed: number) => {
  const spec = caseFor(1, seed, BASE_OBJECTIVE, { pocket: true });
  return { scenario: buildScenario(spec.scenario), seed: spec.seed };
};

const result = (extra: Partial<EpisodeResult> = {}): EpisodeResult => ({
  goals: 1, goalTarget: 1, ticks: 900, maxTicks: 1800, goalTicks: [600], crashed: false, collisions: 0, pain: 0, judgePenalty: 0, cells: 20,
  loopSeconds: 0, jitterSeconds: 0, blindReverseSeconds: 0, reverseTicks: 0, idleTicks: 0, path: 400, net: 300, turn: 3, meanSpeed: 40,
  firstSeenTick: 100, visibleTicks: 300, bestSize: 0.4, wallTicks: 0, pinSeconds: 0, pinEvents: 0, pinPain: 0, recoveries: 0, ...extra,
});

describe("free space beside the body", () => {
  const world: WorldDef = { seed: 1, half: 200, obstacles: [{ kind: "tree", x: 0, y: 0, radius: 10, height: 40, tone: 0.5 }], patches: [] };
  const index = new SolidIndex(world, mulberry32(1));

  it("is the distance between the body and the nearest wall or thing, 0 when touching", () => {
    // KART_RADIUS is 8 and the trunk 10: a centre 30 px away leaves 12 px between body and trunk.
    expect(index.gap(30, 0, 40)).toBeCloseTo(12, 5);
    // Beside the east wall (half 200): centre 180 px out leaves 200 - 180 - 8 = 12.
    expect(index.gap(180, 100, 40)).toBeCloseTo(12, 5);
    expect(index.gap(18, 0, 40)).toBe(0);
    // Capped at the range asked for.
    expect(index.gap(-100, -100, 24)).toBe(24);
  });
});

describe("delayed pain", () => {
  it("costs nothing inside the grace period and grows faster than linearly after it", () => {
    expect(pinCost(0.5)).toBe(0);
    expect(pinCost(PIN_GRACE_SECONDS)).toBe(0);
    const three = pinCost(PIN_GRACE_SECONDS + 3), six = pinCost(PIN_GRACE_SECONDS + 6);
    expect(three).toBeGreaterThan(0);
    expect(six).toBeGreaterThan(2.5 * three);
    expect(pinCost(100)).toBeLessThanOrEqual(1.5);
  });

  it("charges a kart that sits against the closed end of a pocket, and ends its trial early", () => {
    const { scenario, seed } = pocketTrial(7);
    const r = runEpisode(holding({ throttle: 1 }), scenario, IDEAL_REALITY, { seed, stallCutoffSeconds: 0 });
    expect(r.pinSeconds).toBeGreaterThan(PIN_GRACE_SECONDS);
    expect(r.pinPain).toBeGreaterThan(0);
    expect(r.ticks).toBeLessThan(r.maxTicks);
    const kind = scoreEpisode(r, { ...BASE_OBJECTIVE, pin: 0 });
    expect(scoreEpisode(r, BASE_OBJECTIVE)).toBeLessThan(kind - 1);
  });

  it("charges a kart that backs out of the pocket far less than one that stays in it", () => {
    const { scenario, seed } = pocketTrial(7);
    const stuck = runEpisode(holding({ throttle: 1 }), scenario, IDEAL_REALITY, { seed, stallCutoffSeconds: 0 });
    // Reversing is slow in a tight pocket (a few seconds to clear it): back out for ten seconds, then sit still in the open.
    let t = 0;
    const backsOut = { inputCount: 19, reset() { t = 0; }, step: () => ({ steer: 0, throttle: 0, brake: 0, reverse: t++ < 300 ? 1 : 0 }) } as unknown as SpikingNetwork;
    const freed = runEpisode(backsOut, scenario, IDEAL_REALITY, { seed, stallCutoffSeconds: 0 });
    expect(freed.recoveries).toBeGreaterThanOrEqual(1);
    expect(freed.pinPain).toBeLessThan(0.1);
    expect(stuck.pinPain).toBeGreaterThan(10 * Math.max(freed.pinPain, 0.02));
  });
});

describe("the overseer", () => {
  it("halves the credit for flags found while mostly driving backwards, and says so in the traits", () => {
    const forward = result({ reverseTicks: 90 }), backward = result({ reverseTicks: 600 });
    expect(overseer(forward).backwards).toBe(false);
    expect(overseer(backward).backwards).toBe(true);
    expect(creditedGoals(forward)).toBe(1);
    expect(creditedGoals(backward)).toBe(0.5);
    expect(scoreEpisode(backward, BASE_OBJECTIVE)).toBeLessThan(scoreEpisode(forward, BASE_OBJECTIVE) - 40);
    expect(episodeTraits(backward).tidy).toBeLessThan(episodeTraits(forward).tidy);
  });

  it("charges for hugging walls only past a small share, and a clean run pays nothing extra", () => {
    const clean = result(), a_little = result({ wallTicks: 40 }), a_lot = result({ wallTicks: 450 });
    expect(scoreEpisode(a_little, BASE_OBJECTIVE)).toBe(scoreEpisode(clean, BASE_OBJECTIVE));
    expect(scoreEpisode(a_lot, BASE_OBJECTIVE)).toBeLessThan(scoreEpisode(clean, BASE_OBJECTIVE) - 5);
    expect(episodeTraits(clean).tidy).toBe(1);
    expect(episodeTraits(a_lot).tidy).toBeLessThan(0.5);
  });

  it("reports what it saw in the exam of a real trial", () => {
    const { scenario, seed } = pocketTrial(11);
    const r = runEpisode(holding({ throttle: 1 }), scenario, IDEAL_REALITY, { seed, stallCutoffSeconds: 0 });
    const w = overseer(r);
    expect(w.reverse).toBe(0);
    expect(w.pinSeconds).toBe(r.pinSeconds);
  });
});

describe("starting from several brains", () => {
  const brainA = new SpikingNetwork(11, 19).toJSON();
  const brainB = new SpikingNetwork(12, 19).toJSON();

  it("reads Evolve downloads, bare networks and 17-input brains, and refuses the rest in plain words", () => {
    const download = brainFile(brainA, { fitness: 1, generation: 2, label: "test", run: "r" });
    expect(readFounder(download, "a.json").brain.inputCount).toBe(19);
    expect(readFounder(JSON.stringify(brainB), "bare.json").brain.hiddenCount).toBe(48);
    const old = readFounder(JSON.stringify(new SpikingNetwork(3, 17).toJSON()), "old.json");
    expect(old.brain.inputCount).toBe(19);
    expect(old.note).toMatch(/widened/);
    expect(() => readFounder("not json", "x.json")).toThrow(/x\.json.*JSON/);
    expect(() => readFounder(JSON.stringify({ hello: 1 }), "y.json")).toThrow(/y\.json/);
  });

  it("keeps one copy of a repeated brain and grows smaller ones to the size of the biggest", () => {
    const small = new SpikingNetwork(5, 19, 32).toJSON(), big = new SpikingNetwork(6, 19, 64).toJSON();
    const set = prepareFounders([
      { name: "a", brain: brainA, note: "" }, { name: "a again", brain: structuredClone(brainA), note: "" },
      { name: "small", brain: small, note: "" }, { name: "big", brain: big, note: "" },
    ]);
    expect(set.seed.hiddenCount).toBe(64);
    expect(set.others.length).toBe(2);
    expect(set.others.every((b) => b.hiddenCount === 64)).toBe(true);
    expect(set.report.some((line) => /identical/.test(line))).toBe(true);
    expect(() => prepareFounders([])).toThrow();
    const many = prepareFounders(Array.from({ length: MAX_FOUNDERS + 5 }, (_, k) => ({ name: `n${k}`, brain: new SpikingNetwork(100 + k, 19).toJSON(), note: "" })));
    expect(1 + many.others.length).toBe(MAX_FOUNDERS);
  });

  it("scores every founder in the first generation and breeds from all of them", async () => {
    const config = { population: 6, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 1, patience: 2, tournamentSize: 2, branchesPerStage: 2, maxGenerationsPerBranch: 3, lastStage: 0, runSeed: 5 };
    const alone = EvolutionEngine.fresh(brainA, config, new InlineBackend());
    expect(alone.state.population.length).toBe(1);
    const engine = EvolutionEngine.fresh(brainA, config, new InlineBackend(), [brainB]);
    expect(engine.state.population.map((i) => [i.id, i.origin])).toEqual([["g0", "seed"], ["g1", "founder"]]);
    await engine.generation();
    const founders = engine.state.population.filter((i: Individual) => i.id === "g0" || i.id === "g1");
    expect(founders.length).toBe(2);
    expect(founders.every((i) => Number.isFinite(i.fitNow))).toBe(true);
    expect(engine.state.population.length).toBe(config.population);
    expect(engine.state.population.some((i) => i.parent === "g1")).toBe(true);
  }, 120000);
});
