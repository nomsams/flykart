// Stages of the curriculum, how trial batteries are drawn from them, and how one trial is run and scored.
import { SpikingNetwork, type BrainSnapshot } from "../core";
import { mulberry32 } from "../vision/rng";
import { runEpisode, type EpisodeResult } from "./drive";
import { BASE_OBJECTIVE, episodeDescriptor, episodeTraits, scoreEpisode, type Objective, type Traits } from "./objective";
import { sampleReality } from "./reality";
import { runScreen } from "./screen";
import { buildScenario, type ScenarioSpec } from "./scenario";
import { DEFAULT_RANGES, type RealityRanges } from "./reality";
import type { HabitatKind } from "./habitats";

export type StageDef = {
  id: string; title: string; blurb: string;
  habitat: HabitatKind | "mixed";
  /** Clutter range drawn per trial. */
  difficulty: [number, number];
  goals: number; minPath: number; maxPath: number; maxTicks: number; empty?: boolean;
  /** Reality severity range drawn per trial (see reality.ts), and what the robot may know about its own speed. */
  severity: [number, number];
  speedFeedback: "measured" | "command";
  /** Success rate (flags reached / flags) on the exam at which the stage counts as mastered. */
  mastery: number;
};

export const STAGES: StageDef[] = [
  { id: "meadow", title: "1 · Find the flag on an empty lawn", blurb: "No obstacles, an ideal drivetrain. Learn to turn until the pink flag appears, then drive to it.",
    habitat: "lawn", difficulty: [0, 0], empty: true, goals: 1, minPath: 60, maxPath: 220, maxTicks: 1100, severity: [0, 0.2], speedFeedback: "measured", mastery: 0.85 },
  { id: "search", title: "2 · Search a lightly cluttered place", blurb: "A few trees, tables and bollards; two flags in a row. Searching, not just steering.",
    habitat: "mixed", difficulty: [0.1, 0.35], goals: 2, minPath: 90, maxPath: 340, maxTicks: 1500, severity: [0.2, 0.5], speedFeedback: "measured", mastery: 0.75 },
  { id: "outdoors", title: "3 · Lawn and pavement with branches and kerbs", blurb: "Thin twigs, kerbs, bollards, mud and sand; grass to paving to tarmac.",
    habitat: "lawn", difficulty: [0.4, 0.8], goals: 2, minPath: 100, maxPath: 380, maxTicks: 1700, severity: [0.4, 0.8], speedFeedback: "measured", mastery: 0.65 },
  { id: "indoors", title: "4 · A flat: legs, feet, doors and two floors", blurb: "Table and chair legs, sofa feet, rugs, parquet and tile, doorways between rooms.",
    habitat: "apartment", difficulty: [0.4, 0.8], goals: 2, minPath: 100, maxPath: 420, maxTicks: 1900, severity: [0.5, 0.9], speedFeedback: "measured", mastery: 0.6 },
  { id: "everywhere", title: "5 · Everywhere, with the real robot's flaws", blurb: "Any of the three places, a motor dead zone and lag, noisy eyes, no speed sensor. Three flags.",
    habitat: "mixed", difficulty: [0.3, 0.9], goals: 3, minPath: 100, maxPath: 420, maxTicks: 2100, severity: [0.8, 1.3], speedFeedback: "command", mastery: 0.55 },
  { id: "gauntlet", title: "6 · A bad day", blurb: "Flat battery, low light, wet floor, crowded rooms: the stage that decides what is worth carrying to hardware.",
    habitat: "mixed", difficulty: [0.5, 1], goals: 3, minPath: 120, maxPath: 460, maxTicks: 2300, severity: [1.2, 1.9], speedFeedback: "command", mastery: 0.45 },
];

export type CaseSpec = {
  stage: number;
  scenario: ScenarioSpec;
  /** Seed for noise, sonar speckle and flag aliasing in this trial. */
  seed: number;
  severity: number;
  speedFeedback: "measured" | "command";
  objective: Objective;
  trace?: boolean;
  /** Echo-model beam sampling in degrees; 2 is the reference, 3 the resource-sparse setting. */
  rayStepDeg?: number;
  /** Run this genetic screen instead of a scored trial (see screen.ts). */
  screen?: import("./screen").ScreenKind;
  /** The seed this case was drawn with (so a hard case can be drawn again). */
  key?: number;
  /** Flaw ranges to draw the reality from, when they come from a measured robot. */
  realityRanges?: RealityRanges;
};

export type CaseOutcome = {
  stage: number; score: number; traits: Traits; descriptor: number[];
  goals: number; goalTarget: number; ticks: number; crashed: boolean; collisions: number; pain: number;
  reachFrac: number; kind: HabitatKind; trace?: number[]; goalsAt?: { x: number; y: number }[];
  /** Present when the case was a genetic screen. */
  screen?: { kind: import("./screen").ScreenKind; failed: boolean; note: string };
};

const hash = (...values: number[]): number => {
  let h = 2166136261;
  for (const v of values) { h ^= Math.floor(v) & 0xffffffff; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return h >>> 0;
};

/** Draw one case from a stage with a given seed. Everything about it is a function of (stage, seed). */
export function caseFor(stageIndex: number, seed: number, objective: Objective = BASE_OBJECTIVE, fixed?: { severity?: number; difficulty?: number; pocket?: boolean }): CaseSpec {
  const stage = STAGES[stageIndex], r = mulberry32(hash(stageIndex, seed, 77));
  const difficulty = fixed?.difficulty ?? stage.difficulty[0] + (stage.difficulty[1] - stage.difficulty[0]) * r();
  const severity = fixed?.severity ?? stage.severity[0] + (stage.severity[1] - stage.severity[0]) * r();
  return {
    stage: stageIndex, seed: hash(seed, 31), severity, speedFeedback: stage.speedFeedback, objective, key: seed,
    scenario: { habitat: stage.habitat, seed: hash(stageIndex, seed, 5) % 1000003, difficulty, goals: stage.goals, minPath: stage.minPath, maxPath: stage.maxPath, maxTicks: stage.maxTicks, empty: stage.empty, ...(fixed?.pocket ? { pocket: true } : {}) },
  };
}

/** Fresh trials for training: `size` of them, a share replayed from earlier stages so skills are not forgotten. */
export type HardCase = { stage: number; key: number; pocket?: boolean; solved: number };
export type BatteryExtras = {
  /** Cases the leader has failed before; `hardShare` of the battery is drawn from them. */
  hard?: HardCase[]; hardShare?: number;
  /** Share of current-or-later-stage trials that start in a dead-end pocket. */
  pocketShare?: number;
};
export function trainingBattery(stageIndex: number, generation: number, runSeed: number, size: number, objective: Objective, replayShare = 0.3, extras: BatteryExtras = {}): CaseSpec[] {
  const r = mulberry32(hash(runSeed, generation, 9));
  const cases: CaseSpec[] = [];
  // Hard-example mining draws from its own stream, so turning it off leaves the other draws as they were.
  const rh = mulberry32(hash(runSeed, generation, 21));
  for (let i = 0; i < size; i += 1) {
    const replay = stageIndex > 0 && r() < replayShare;
    const stage = replay ? Math.floor(r() * stageIndex) : stageIndex;
    const pocket = stageIndex >= 1 && (extras.pocketShare ?? 0) > 0 && rh() < (extras.pocketShare ?? 0);
    const useHard = (extras.hard?.length ?? 0) > 0 && rh() < (extras.hardShare ?? 0);
    if (useHard) {
      const h = extras.hard![Math.floor(rh() * extras.hard!.length)];
      cases.push(caseFor(h.stage, h.key, h.stage === stageIndex ? objective : BASE_OBJECTIVE, h.pocket ? { pocket: true } : undefined));
      continue;
    }
    cases.push(caseFor(stage, hash(runSeed, generation, i), BASE_OBJECTIVE, pocket && stage === stageIndex ? { pocket: true } : undefined));
  }
  // The current stage uses the emphasis currently being tried; replayed stages are always scored the base way.
  return cases.map((c) => (c.stage === stageIndex ? { ...c, objective } : c));
}

/** A fixed set of trials per stage, the same every time, so exam scores are comparable across the whole run. */
export function examBattery(stageIndex: number, size: number, tag = 0): CaseSpec[] {
  const stage = STAGES[stageIndex], mid = (stage.severity[0] + stage.severity[1]) / 2;
  return Array.from({ length: size }, (_, i) => caseFor(stageIndex, 9_000_000 + tag * 100_000 + i, BASE_OBJECTIVE, { severity: mid }));
}

export function runCase(snapshot: BrainSnapshot, spec: CaseSpec): CaseOutcome {
  if (spec.screen) {
    const r = runScreen(snapshot, spec.screen, spec.seed);
    return { stage: spec.stage, score: r.failed ? -1 : 0, traits: { search: 0, safety: 0, speed: 0, smooth: 0 }, descriptor: [], goals: 0, goalTarget: 0, ticks: 0, crashed: false, collisions: 0, pain: 0, reachFrac: 0, kind: "lawn", screen: r };
  }
  const brain = SpikingNetwork.fromJSON(snapshot);
  const scenario = buildScenario(spec.scenario);
  const reality = sampleReality(mulberry32(hash(spec.seed, 4)), spec.severity, spec.speedFeedback, spec.realityRanges ?? DEFAULT_RANGES);
  if (spec.rayStepDeg && spec.rayStepDeg !== 2) reality.sonar = { ...reality.sonar, rayStepDeg: spec.rayStepDeg };
  const result: EpisodeResult = runEpisode(brain, scenario, reality, { seed: spec.seed, trace: spec.trace });
  return {
    stage: spec.stage, score: scoreEpisode(result, spec.objective), traits: episodeTraits(result), descriptor: episodeDescriptor(result),
    goals: result.goals, goalTarget: result.goalTarget, ticks: result.ticks, crashed: result.crashed, collisions: result.collisions, pain: result.pain,
    reachFrac: result.goals / Math.max(1, result.goalTarget), kind: scenario.kind, trace: result.trace, goalsAt: result.goalsAt,
  };
}

export function runCases(snapshot: BrainSnapshot, specs: CaseSpec[]): CaseOutcome[] {
  // Parse the brain once and reuse it across trials (each trial resets its state).
  return specs.map((spec) => runCase(snapshot, spec));
}

export type Aggregate = {
  n: number; score: number; se: number; reach: number; crash: number; pain: number; traits: Traits; descriptor: number[];
  perStage: Record<number, { n: number; score: number; reach: number }>;
};

/** Mean score, its standard error across trials, and the trait / behaviour averages. */
export function aggregate(outcomes: CaseOutcome[]): Aggregate {
  const n = Math.max(1, outcomes.length), mean = (f: (o: CaseOutcome) => number): number => outcomes.reduce((s, o) => s + f(o), 0) / n;
  const score = mean((o) => o.score);
  const variance = outcomes.reduce((s, o) => s + (o.score - score) ** 2, 0) / Math.max(1, n - 1);
  const traits: Traits = { search: mean((o) => o.traits.search), safety: mean((o) => o.traits.safety), speed: mean((o) => o.traits.speed), smooth: mean((o) => o.traits.smooth) };
  const descriptor = outcomes[0]?.descriptor.map((_, k) => mean((o) => o.descriptor[k])) ?? [];
  const perStage: Aggregate["perStage"] = {};
  for (const o of outcomes) {
    const e = (perStage[o.stage] ??= { n: 0, score: 0, reach: 0 });
    e.n += 1; e.score += o.score; e.reach += o.reachFrac;
  }
  for (const e of Object.values(perStage)) { e.score /= e.n; e.reach /= e.n; }
  return { n: outcomes.length, score, se: Math.sqrt(variance / n), reach: mean((o) => o.reachFrac), crash: mean((o) => (o.crashed ? 1 : 0)), pain: mean((o) => o.pain), traits, descriptor, perStage };
}
