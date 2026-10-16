import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { InlineBackend } from "./backend";
import { EvolutionEngine } from "./engine";
import { parseProgress, toProgress } from "./persist";

const seed = new SpikingNetwork(21, 19).toJSON();
/** Tiny climbs (three generations each) with a tournament after every one, so a stage's whole life takes seconds. */
const config = {
  population: 6, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 1, patience: 2, tournamentSize: 2,
  branchesPerStage: 1, maxGenerationsPerBranch: 3, lastStage: 1, runSeed: 5, keepPerStage: 2, maxClimbsPerStage: 3, stageStall: 99,
};
/** A goal nobody can reach, so that the stage can only end by the gate. */
const impossible = (engine: EvolutionEngine): void => { engine.state.goals = { 0: 2 }; };

describe("mastering a stage before the next begins", () => {
  it("keeps climbing, then stops and says so instead of moving on, and keeps only the best few maxima", async () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend());
    impossible(engine);
    await engine.run(() => engine.state.generation > 80);
    const s = engine.state;
    expect(s.stalled).toBeTruthy();
    expect(s.finished).toBe(true);
    expect(s.stage).toBe(0);
    expect(s.stageResults.length).toBe(0);
    expect(s.stalled!.climbs).toBe(3);
    expect(s.stalled!.why).toMatch(/3 climbs/);
    // Three climbs were filed; only the best two remain.
    expect(s.archive.filter((m) => m.stage === 0).length).toBe(2);
    expect(s.counters.retired).toBe(1);
    // The progress file carries the stop, without any weights.
    const progress = parseProgress(JSON.stringify(toProgress(s, "t")));
    expect(progress.stalled?.stage).toBe(0);
    expect(JSON.stringify(progress.stalled)).not.toMatch(/inputWeights/);
    expect(progress.retired).toBe(1);
  }, 180000);

  it("stops early when a stage has stopped improving, even with climbs to spare", async () => {
    const engine = EvolutionEngine.fresh(seed, { ...config, maxClimbsPerStage: 40, stageStall: 2, growBy: 0 }, new InlineBackend());
    impossible(engine);
    await engine.run(() => engine.state.generation > 80);
    expect(engine.state.stalled?.why).toMatch(/no better result for \d+ climbs/);
    expect(engine.state.stalled!.climbs).toBeLessThan(40);
  }, 180000);

  it("carries on with more climbs, or moves on with what it has, when asked", async () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend());
    impossible(engine);
    await engine.run(() => engine.state.generation > 80);
    expect(engine.state.stalled).toBeTruthy();
    engine.continueStage(2);
    expect(engine.state.stalled).toBeNull();
    expect(engine.state.finished).toBe(false);
    await engine.run(() => engine.state.generation > 160);
    expect(engine.state.stalled!.climbs).toBe(5);
    engine.moveOn();
    const s = engine.state;
    expect(s.stage).toBe(1);
    expect(s.finished).toBe(false);
    expect(s.stageResults.length).toBe(1);
    expect(s.stageResults[0].mastered).toBe(false);
    expect(s.population.length).toBe(1);
    expect(s.population[0].origin).toBe("stage winner");
  }, 240000);

  it("moves on at once when the goal is lowered to what was already reached", async () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend());
    impossible(engine);
    await engine.run(() => engine.state.generation > 80);
    engine.state.stalled!.reach = 0.8;
    engine.setGoal(0, 0.5);
    expect(engine.goalFor(0)).toBe(0.5);
    engine.continueStage();
    expect(engine.state.stage).toBe(1);
    expect(engine.state.stageResults[0].mastered).toBe(true);
    expect(() => engine.setGoal(0, 1.5)).toThrow(/between 5 % and 100 %/);
    expect(() => engine.setGoal(9, 0.5)).toThrow(/no such stage/);
  }, 180000);

  it("moves on regardless when told to (the older rule), and records that it did not master the stage", async () => {
    const engine = EvolutionEngine.fresh(seed, { ...config, advanceAnyway: true }, new InlineBackend());
    impossible(engine);
    await engine.run(() => engine.state.stage >= 1 || engine.state.generation > 80);
    expect(engine.state.stalled ?? null).toBeNull();
    expect(engine.state.stage).toBe(1);
    expect(engine.state.stageResults[0].mastered).toBe(false);
  }, 180000);

  it("gives a run saved before the gate existed its limits, so that it stops instead of climbing for ever", async () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend());
    impossible(engine);
    const old = JSON.parse(JSON.stringify(engine.state));
    for (const key of ["keepPerStage", "maxClimbsPerStage", "stageStall", "advanceAnyway"]) delete old.config[key];
    old.config.maxClimbsPerStage = undefined;
    const resumed = new EvolutionEngine(old, new InlineBackend());
    expect(resumed.state.config.maxClimbsPerStage).toBe(40);
    expect(resumed.state.config.stageStall).toBe(8);
    expect(resumed.state.config.keepPerStage).toBe(3);
    expect(resumed.state.config.advanceAnyway).toBe(false);
    // Hand it a small limit through the normal field and it stops there.
    resumed.state.config.maxClimbsPerStage = 2;
    await resumed.run(() => resumed.state.generation > 80);
    expect(resumed.state.stalled?.climbs).toBe(2);
  }, 180000);

  it("tidies an opened run down to the best few maxima of each stage, never retiring a stage's winner", async () => {
    const engine = EvolutionEngine.fresh(seed, { ...config, keepPerStage: 2 }, new InlineBackend());
    impossible(engine);
    await engine.run(() => engine.state.generation > 80);
    engine.continueStage(3);
    await engine.run(() => engine.state.generation > 200);
    // Pretend an older engine kept them all: put five weak, untested maxima back for stage 1.
    const template = engine.state.archive[0];
    for (let k = 0; k < 5; k += 1) engine.state.archive.push({ ...template, id: `old${k}`, exam: { ...template.exam, score: -100 - k }, tournament: undefined });
    engine.state.stageResults.push({ stage: 0, winner: "old4", score: 0, se: 0, reach: 0, mastered: false, ranking: [], generation: 1 });
    const before = engine.state.archive.length;
    const retired = engine.tidyArchive();
    expect(retired).toBeGreaterThan(0);
    expect(engine.state.archive.length).toBe(before - retired);
    expect(engine.state.archive.filter((m) => m.stage === template.stage).length).toBeLessThanOrEqual(3); // two kept, plus the winner protected
    expect(engine.state.archive.some((m) => m.id === "old4")).toBe(true);
  }, 240000);

  it("reruns a stage from its best brain with a new goal, and drops the results that depended on it", async () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend());
    expect(() => engine.rerunStage(0)).toThrow(/no saved brain/);
    impossible(engine);
    await engine.run(() => engine.state.generation > 80);
    engine.moveOn();
    expect(engine.state.stage).toBe(1);
    const best = [...engine.state.archive.filter((m) => m.stage === 0)].sort((a, b) => (b.tournament?.score ?? b.exam.score) - (a.tournament?.score ?? a.exam.score))[0];
    engine.rerunStage(0, { goal: 0.9 });
    const s = engine.state;
    expect(s.stage).toBe(0);
    expect(s.finished).toBe(false);
    expect(s.stageResults.length).toBe(0);
    expect(engine.goalFor(0)).toBe(0.9);
    expect(s.population.length).toBe(1);
    expect(s.population[0].origin).toBe("rerun");
    expect(s.population[0].parent).toBe(best.id);
    expect(s.branchesThisStage).toBe(0);
    expect(() => engine.rerunStage(0, { fromId: "L999" })).toThrow(/L999/);
    // It climbs again from there.
    await engine.generation();
    expect(engine.state.generation).toBeGreaterThan(0);
  }, 240000);
});
