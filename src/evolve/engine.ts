// Staged, long-horizon evolution with plateau detection and a catalogue of local maxima.
//
// The loop, in plain terms:
//   1. Breed a population from the best brains of the last generation (mutation, mating of complementary
//      parents, a few outsiders), keeping the exact elites.
//   2. Test every candidate on the same fresh trials (so luck is shared) with a share replayed from earlier stages.
//   3. Every few generations, give the leader a fixed exam. When the exam stops improving for `patience` exams the
//      climb has reached a local maximum: file it away, then go looking for a different one (kick, restart from an
//      ancestor under a different emphasis, cross-breed two maxima, grow the brain, send scouts).
//   4. After a handful of maxima, hold a tournament on unseen trials (with earlier stages mixed in so forgetting
//      costs points). The winner starts the next stage; the losers stay in the archive.
// Everything random derives from (run seed, generation, slot), so a saved state resumes bit-for-bit.
import { SpikingNetwork, type BrainSnapshot } from "../core";
import { mulberry32, type Random } from "../vision/rng";
import { projectGenome, projectionDistance } from "./brain-size";
import { addLayer, constrain, describePlan, singleLayer, validatePlan, type BrainPlan } from "./layers";
import { GATING, SCREENS, type ScreenKind } from "./screen";
import { STAGES, aggregate, examBattery, trainingBattery, caseFor, type Aggregate, type CaseOutcome, type CaseSpec, type HardCase } from "./cases";
import { polish } from "./polish";
import type { RealityRanges } from "./reality";
import { BASE_OBJECTIVE, EMPHASES, NO_TRAITS, TRAIT_NAMES, objectiveWith, type Traits } from "./objective";

export interface EvalBackend {
  readonly size: number;
  /** outcomes[i][c] is brain i on case c. */
  evaluate(brains: BrainSnapshot[], cases: CaseSpec[]): Promise<CaseOutcome[][]>;
  close?(): void;
}

export type EngineConfig = {
  runSeed: number;
  population: number; parents: number; elites: number;
  battery: number; examSize: number; examEvery: number; tournamentSize: number;
  patience: number; minGain: number;
  branchesPerStage: number; maxGenerationsPerBranch: number;
  replayShare: number;
  growBy: number; maxHidden: number;
  mutationRate: number; mutationSize: number;
  /** Pre-screen candidates on half the battery and finish only the better ones. */
  twoPhase: boolean;
  /** Only run stages up to and including this one (-1 = all). */
  lastStage: number;
  /** Beam sampling of the echo model in trials, degrees: 2 (reference) or 3 (resource-sparse). */
  rayStepDeg: number;
  /** Layered growth: from stage `layerFromStage` (0-based) every stage adds a layer of `layerPerStage` neurons on top, and older layers keep only `protect` of their plasticity. 0 turns it off. */
  layerPerStage: number; layerFromStage: number; protect: number;
  /** Share of each battery drawn from trials the leader has failed (hard-example mining), and of trials that start in a dead-end pocket. */
  hardShare: number; pocketShare: number;
  /** Give close contenders extra trials; keep a best-per-behaviour archive; polish the best brain of a climb by lifetime learning. */
  extraTrials: boolean; qd: boolean; polish: boolean;
  /** Local maxima kept per stage (the best by tournament score, else exam score); weaker ones are retired so the archive and the map stay readable. */
  keepPerStage: number;
  /**
   * A stage is mastered before the next one begins. When it cannot be (this many climbs, or `stageStall` climbs in a row
   * without a better result), the run stops and says so, and a person decides: more climbs, a lower goal, or move on.
   * `advanceAnyway` brings back the older behaviour: a couple more climbs, then on to the next stage regardless.
   */
  maxClimbsPerStage: number; stageStall: number; advanceAnyway: boolean;
  /**
   * Keeping what was learned: a stage is only mastered if its winner still finds at least this share of what the
   * earlier stages' winners found (against the goal or the result they left with, whichever is lower) on fresh trials of
   * those stages. 0 turns the check off. While an earlier stage is being forgotten it is rehearsed more.
   */
  retainShare: number;
  /** Share of every new layer's neurons that are Kenyon-style (sparse, pattern-detecting, quiet) rather than dense; 0 gives the older all-dense layers. */
  kenyonShare: number;
  /** Flaw ranges measured on a real robot (replaces the plausible defaults). */
  realityRanges?: RealityRanges;
};

export const DEFAULT_CONFIG: EngineConfig = {
  runSeed: 1, population: 20, parents: 5, elites: 2, battery: 6, examSize: 16, examEvery: 4, tournamentSize: 36,
  patience: 5, minGain: 1.5, branchesPerStage: 4, maxGenerationsPerBranch: 150, replayShare: 0.3,
  growBy: 8, maxHidden: 128, mutationRate: 0.1, mutationSize: 0.16, twoPhase: true, lastStage: -1, rayStepDeg: 2, layerPerStage: 8, layerFromStage: 2, protect: 0.25, hardShare: 0.3, pocketShare: 0.15, extraTrials: true, qd: true, polish: true,
  keepPerStage: 3, maxClimbsPerStage: 40, stageStall: 8, advanceAnyway: false, retainShare: 0.8, kenyonShare: 0.5,
};

export type BranchType = "seed" | "kick" | "ancestor" | "crossbreed" | "grow" | "scout";

export type Individual = {
  id: string; brain: BrainSnapshot; parent: string | null; mate: string | null; origin: string; born: number;
  fit: number; fitNow: number; age: number; traits: Traits; crashRate: number; reach: number; partial: boolean;
  /** Ancestors of the last few generations (ids), for the inbreeding guard. */
  kin?: string[];
  /** Screens failed (gating or not); undefined = not screened yet. */
  screens?: ScreenKind[];
  /** Behaviour of the last battery (see objective.ts) */
  desc?: number[];
  /** Estimated breeding value: points above this generation's mean, from the brain's own score, its parents' values and how its offspring did. */
  ebv?: number;
};

export type LocalMax = {
  id: string; stage: number; branch: number; branchType: BranchType; emphasis: string; generation: number; hidden: number;
  /** Exam result when it was filed, and (later) the tournament result. */
  exam: { score: number; se: number; reach: number; crash: number };
  tournament?: { score: number; se: number; reach: number; crash: number; retention: number };
  traits: Traits; descriptor: number[]; proj: number[]; parentId: string | null;
  /** The layer plan this brain was bred under (older records have none and mean a single layer). */
  plan?: BrainPlan;
  brain: BrainSnapshot;
  note: string;
};

export type GenerationRecord = {
  gen: number; stage: number; branch: number; branchType: BranchType; best: number; mean: number; worst: number; champion: number;
  diversity: number; scale: number; stale: number;
  /** Mean relatedness of the breeding pool (0 unrelated, 1 siblings) and how many screened candidates failed a gating screen. */
  kinship?: number; defective?: number; screened?: number;
  /** Hard cases in the pool, filled cells of the behaviour archive, and trials spent on close contenders. */
  hard?: number; qdCells?: number; extra?: number;
  /**
   * Exam of the leader, when one was held this generation, with what the overseer saw in it: share of time spent
   * reversing and along walls, seconds pinned per trial, and times it freed itself from a pin per trial.
   */
  exam?: { score: number; se: number; reach: number; crash: number; reverse?: number; wall?: number; pinned?: number; recovered?: number };
  proj: number[]; hidden: number; elapsed: number; evals: number;
  event?: string;
};

export type StageResult = { stage: number; winner: string; score: number; se: number; reach: number; mastered: boolean; retained?: Record<number, number>; ranking: { id: string; score: number; reach: number; retention: number }[]; generation: number };

export type StallInfo = { stage: number; reach: number; goal: number; climbs: number; why: string; forgot?: number[]; winnerId: string; brain: BrainSnapshot; plan?: BrainPlan; traits: Traits; score: number; se: number };

export type EngineState = {
  version: 1; config: EngineConfig;
  generation: number; stage: number; stageGeneration: number; branch: number; branchGeneration: number;
  branchType: BranchType; emphasis: string;
  population: Individual[];
  exams: { gen: number; score: number; se: number; reach: number }[];
  /** Best moving-average exam score of this climb, and the leaders that earned the exams (for the confirmation round). */
  bestMean: number;
  hall: { gen: number; score: number; se: number; reach: number; crash: number; brain: BrainSnapshot; id: string; traits: Traits; descriptor: number[] }[];
  bestExam: { gen: number; score: number; se: number; reach: number; crash: number; brain: BrainSnapshot; id: string; traits: Traits; descriptor: number[] } | null;
  staleExams: number;
  archive: LocalMax[]; stageResults: StageResult[];
  stageEntry: BrainSnapshot | null; stageEntryId: string | null;
  /** Mastery goals set by the person (share of flags found, 0..1), by stage; a stage without one uses its default. */
  goals?: Record<number, number>;
  /** Set when the run stopped because the stage could not be mastered; carries what is needed to move on. */
  stalled?: StallInfo | null;
  /** Best tournament reach of this stage, climbs since it last improved, and extra climbs granted by the person. */
  stageBest?: number; stageStale?: number; climbBonus?: number;
  /** Smallest total shortfall in retention seen this stage (for telling whether climbing still helps), and the latest measured retention per earlier stage. */
  stageBestDeficit?: number; grewOnStall?: boolean;
  retention?: Record<number, { reach: number; target: number }>;
  /** How the offspring of each surviving parent turned out, relative to their generation: [count, sum of deviations]. */
  progeny?: Record<string, [number, number]>;
  /** Layers of the population now being bred, and of the brain the stage began with. */
  plan?: BrainPlan; stageEntryPlan?: BrainPlan;
  /** Trials the leader failed (drawn again for a while), and the best brain found per behaviour cell in this stage. */
  hard?: HardCase[];
  qd?: Record<string, { score: number; id: string; brain: BrainSnapshot; gen: number }>; qdStage?: number;
  champion: { id: string; stage: number; score: number; brain: BrainSnapshot; note: string } | null;
  history: GenerationRecord[];
  counters: { episodes: number; evaluations: number; elapsedMs: number; maxima: number; tournaments: number; kicks: number; retired?: number };
  nextId: number; usedEmphasis: string[]; branchesThisStage: number; extraBranches: number;
  finished: boolean;
};

export type EngineEvent =
  | { type: "generation"; record: GenerationRecord }
  | { type: "localMax"; max: LocalMax }
  | { type: "branch"; stage: number; branch: number; branchType: BranchType; emphasis: string; from: string | null }
  | { type: "tournament"; stage: number; ranking: StageResult["ranking"] }
  | { type: "stage"; result: StageResult }
  | { type: "stalled"; stage: number; reach: number; goal: number; why: string }
  | { type: "log"; text: string }
  | { type: "finished" };

const BRANCH_ORDER: BranchType[] = ["kick", "crossbreed", "ancestor", "grow", "scout"];

function hashSeed(...values: number[]): number {
  let h = 2166136261;
  for (const v of values) { h ^= Math.floor(v) & 0xffffffff; h = Math.imul(h, 16777619); h ^= h >>> 15; }
  return h >>> 0;
}

export class EvolutionEngine {
  state: EngineState;
  private listeners: ((e: EngineEvent) => void)[] = [];
  private exact: Map<string, SpikingNetwork> = new Map();

  readonly backend: EvalBackend;
  constructor(state: EngineState, backend: EvalBackend) {
    this.state = state;
    // A run saved before the stage gate existed has none of its settings: give it the defaults (without them a resumed run
    // would never reach its climb limit and could climb one stage for ever).
    for (const key of ["keepPerStage", "maxClimbsPerStage", "stageStall", "advanceAnyway", "retainShare", "kenyonShare"] as const) {
      if (state.config[key] === undefined) (state.config as Record<string, unknown>)[key] = DEFAULT_CONFIG[key];
    }
    // Every trial the engine asks for is stamped with the run's echo-model setting, so exams and tournaments agree with training.
    this.backend = {
      get size() { return backend.size; },
      evaluate: (brains, cases) => backend.evaluate(brains, state.config.rayStepDeg && state.config.rayStepDeg !== 2 || state.config.realityRanges
        ? cases.map((c) => ({ ...c, ...(state.config.rayStepDeg && state.config.rayStepDeg !== 2 ? { rayStepDeg: state.config.rayStepDeg } : {}), ...(state.config.realityRanges ? { realityRanges: state.config.realityRanges } : {}) }))
        : cases),
      close: () => backend.close?.(),
    };
  }

  /**
   * A new run. `founders` are further brains that start beside the seed in the first population (the caller makes them
   * the same size and shape; see founders.ts): each is scored as it is and then bred from, so the run begins from the
   * best of them and the others stay available as mates.
   */
  static fresh(seedBrain: BrainSnapshot, config: Partial<EngineConfig> = {}, backend: EvalBackend, founders: BrainSnapshot[] = []): EvolutionEngine {
    const cfg: EngineConfig = { ...DEFAULT_CONFIG, ...config };
    const first: Individual = { id: "g0", brain: seedBrain, parent: null, mate: null, origin: "seed", born: 0, fit: -Infinity, fitNow: -Infinity, age: 0, traits: { ...NO_TRAITS }, crashRate: 0, reach: 0, partial: false };
    const more: Individual[] = founders.slice(0, Math.max(0, cfg.population - 1)).map((brain, k) => ({ ...first, id: `g${k + 1}`, brain, origin: "founder" }));
    const state: EngineState = {
      version: 1, config: cfg, generation: 0, stage: 0, stageGeneration: 0, branch: 0, branchGeneration: 0, branchType: "seed", emphasis: "balanced",
      population: [first, ...more], exams: [], bestMean: -1e9, hall: [], bestExam: null, staleExams: 0, archive: [], stageResults: [], stageEntry: seedBrain, stageEntryId: "g0", plan: singleLayer(seedBrain.hiddenCount), stageEntryPlan: singleLayer(seedBrain.hiddenCount), champion: null, history: [],
      counters: { episodes: 0, evaluations: 0, elapsedMs: 0, maxima: 0, tournaments: 0, kicks: 0 }, nextId: 1, usedEmphasis: ["balanced"], branchesThisStage: 0, extraBranches: 0, finished: false,
    };
    return new EvolutionEngine(state, backend);
  }

  on(listener: (e: EngineEvent) => void): () => void { this.listeners.push(listener); return () => { this.listeners = this.listeners.filter((l) => l !== listener); }; }
  private emit(e: EngineEvent): void { for (const l of this.listeners) l(e); }
  private log(text: string): void { this.emit({ type: "log", text }); }

  get config(): EngineConfig { return this.state.config; }
  get lastStage(): number { return this.config.lastStage >= 0 ? Math.min(STAGES.length - 1, this.config.lastStage) : STAGES.length - 1; }

  private net(i: Individual): SpikingNetwork {
    let n = this.exact.get(i.id);
    if (!n) { n = SpikingNetwork.fromJSON(i.brain); if (this.exact.size > 80) this.exact.clear(); this.exact.set(i.id, n); }
    return n;
  }
  /** The layer plan of the population being bred (a single layer for runs saved before layers existed). */
  private plan(hidden: number): BrainPlan { return validatePlan(this.state.plan ?? singleLayer(hidden), hidden); }
  private lastKinship = 0;
  private newId(prefix: string): string { return `${prefix}${this.state.nextId++}`; }

  /** Build the candidates for the coming generation from the surviving parents. */
  private breed(): Individual[] {
    const s = this.state, c = s.config, gen = s.generation + 1;
    const random = mulberry32(hashSeed(c.runSeed, gen, 4242));
    // Farm-style selection: parents are ranked by estimated breeding value, not by one noisy score (see assignBreedingValues).
    const ranked = [...s.population].sort((a, b) => (a.ebv !== undefined && b.ebv !== undefined ? b.ebv - a.ebv : b.fit - a.fit));
    // Eugenics: lines that crash most of the time, or twitch, do not breed while there are better parents.
    // Screened-clean first; then the older rules (crash rate, twitching); the pool never falls below two parents.
    const clean = (i: Individual): boolean => !(i.screens ?? []).some((k) => GATING.includes(k));
    // Lines that mostly reverse, hug the walls or sit pinned in corners (tidy near 0) do not breed while there are better parents.
    let pool = ranked.filter((i) => !i.partial && i.crashRate <= 0.5 && i.traits.smooth > 0.2 && (i.traits.tidy ?? 1) > 0.15 && clean(i)).slice(0, c.parents);
    if (pool.length < 2) pool = ranked.filter((i) => !i.partial && clean(i)).slice(0, c.parents);
    if (pool.length < 2) pool = ranked.slice(0, Math.max(2, Math.min(c.parents, ranked.length)));
    const related = (x: Individual, y: Individual): number => {
      const a = new Set([x.id, ...(x.kin ?? [])]), b = [y.id, ...(y.kin ?? [])];
      const shared = b.filter((id) => a.has(id)).length;
      return shared / Math.max(1, Math.min(a.size, b.length));
    };
    // Gene flow comes from other local maxima of this stage (different lineages, same size), used when the pool has become a family.
    const wanted = pool[0]?.brain.hiddenCount ?? 0;
    const donors: { id: string; brain: BrainSnapshot }[] = s.archive.filter((m) => m.stage === s.stage && m.brain.hiddenCount === wanted);
    // Plus the best brains of other behaviour cells: parents that behave differently from the leader.
    for (const cell of Object.values(s.qd ?? {})) if (cell.brain.hiddenCount === wanted && !pool.some((p) => p.id === cell.id)) donors.push({ id: `cell:${cell.id}`, brain: cell.brain });
    const out: Individual[] = [];
    const plan = this.plan(pool[0]?.brain.hiddenCount ?? 48);
    const elites = pool.slice(0, c.elites);
    for (const e of elites) out.push({ ...e, partial: false, age: e.age + 1 });
    const scale = Math.min(3, 1 + 0.35 * s.staleExams) * (s.branchGeneration < 3 && s.branchType === "kick" ? 2.2 : 1);
    const rate = Math.min(0.5, c.mutationRate * scale), amount = Math.min(1.2, c.mutationSize * scale);
    const pick = (): Individual => {
      // Rank-weighted: the best parent is chosen about twice as often as the worst.
      const weights = pool.map((_, k) => pool.length - k + 0.5), total = weights.reduce((a, b) => a + b, 0);
      let r = random() * total; for (let k = 0; k < pool.length; k += 1) { r -= weights[k]; if (r <= 0) return pool[k]; }
      return pool[0];
    };
    const mateFor = (a: Individual): Individual => {
      // Choose the partner that adds the most of what `a` lacks, with some chance.
      let best = pool[0], bestGain = -Infinity;
      for (const m of pool) {
        if (m.id === a.id) continue;
        // Avoid mating close relatives while any other partner exists.
        let gain = random() * 0.15 - (related(a, m) > 0.5 ? 1 : 0);
        for (const t of TRAIT_NAMES) gain += Math.max(0, (m.traits[t] ?? 0) - (a.traits[t] ?? 0));
        if (gain > bestGain) { bestGain = gain; best = m; }
      }
      return best;
    };
    const stale = s.staleExams >= 2;
    for (let slot = out.length; slot < c.population; slot += 1) {
      const seed = hashSeed(c.runSeed, gen, slot);
      const roll = random();
      const a = pick();
      let brain: BrainSnapshot, mate: string | null = null, origin = "mutant", reference = a.brain;
      let kin: string[] = [a.id, ...(a.kin ?? []).slice(0, 7)];
      if (roll < 0.52) brain = this.net(a).mutate(rate, amount, seed).toJSON();
      else if (roll >= 0.8 && roll < 0.88 && donors.length) {
        // Outbreeding: a pool member crossed with a local maximum from another climb.
        const donor = donors[Math.floor(random() * donors.length)];
        brain = this.net(a).crossover(SpikingNetwork.fromJSON(donor.brain), seed, 0.35).mutate(rate * 0.5, amount * 0.6, seed + 1).toJSON(); mate = donor.id; origin = `gene flow from ${donor.id}`; kin = [...kin, donor.id];
      } else if (roll < 0.88) {
        const m = mateFor(a);
        if (m.brain.hiddenCount !== a.brain.hiddenCount) brain = this.net(a).mutate(rate, amount, seed).toJSON();
        else { brain = this.net(a).crossover(this.net(m), seed, 0.5).mutate(rate * 0.5, amount * 0.6, seed + 1).toJSON(); mate = m.id; origin = "mating"; kin = [...kin, m.id, ...(m.kin ?? []).slice(0, 3)]; }
      } else {
        // An outsider: a heavy mutant of the leader, or (when climbing has stalled) a stranger.
        brain = this.net(pool[0]).mutate(Math.min(0.6, rate * 2.2), Math.min(1.5, amount * 2.2), seed).toJSON(); origin = stale ? "immigrant" : "bold mutant"; reference = pool[0].brain;
      }
      // Older layers change by only their share, and never listen to newer ones.
      brain = constrain(brain, reference, plan);
      out.push({ id: this.newId("c"), brain, parent: a.id, mate, origin, born: gen, fit: -Infinity, fitNow: -Infinity, age: 0, traits: a.traits, crashRate: 0, reach: 0, partial: false, kin });
    }
    // When the pool is nearly one family, say so: the next generation's immigrants and gene flow matter more.
    let pairs = 0, sum = 0;
    for (let i = 0; i < pool.length; i += 1) for (let j = i + 1; j < pool.length; j += 1) { sum += related(pool[i], pool[j]); pairs += 1; }
    this.lastKinship = pairs ? sum / pairs : 0;
    return out;
  }

  /** Evaluate a population on this generation's battery, two-phase if configured. Mutates the individuals. */
  private async score(population: Individual[], cases: CaseSpec[]): Promise<{ sums: CaseOutcome[][]; extra: number }> {
    const s = this.state, backend = this.backend;
    const half = Math.max(1, Math.ceil(cases.length / 2));
    const phases = s.config.twoPhase && cases.length >= 4 ? [cases.slice(0, half), cases.slice(half)] : [cases];
    const sums = population.map(() => [] as CaseOutcome[]);
    let active = population.map((_, i) => i);
    for (let p = 0; p < phases.length; p += 1) {
      const outcomes = await backend.evaluate(active.map((i) => population[i].brain), phases[p]);
      s.counters.episodes += active.length * phases[p].length;
      active.forEach((index, k) => { sums[index].push(...outcomes[k]); });
      if (p === 0 && phases.length > 1) {
        // Racing: keep the better 60% (and carried-over elites), plus anyone who cannot yet be told apart from the front-runner
        // on the same trials (paired difference, one standard error); only the clearly worse stop here.
        const means = active.map((index) => sums[index].reduce((a, o) => a + o.score, 0) / Math.max(1, sums[index].length));
        const order = active.map((index, k) => ({ index, m: means[k] })).sort((a, b) => b.m - a.m);
        const keep = new Set(order.slice(0, Math.max(s.config.elites + 2, Math.ceil(order.length * 0.6))).map((e) => e.index));
        const front = order[0].index, seen = sums[front].length;
        for (const { index } of order) {
          if (keep.has(index) || seen < 2) { keep.add(index); continue; }
          const d = sums[index].map((o, c) => o.score - sums[front][c].score), md = d.reduce((a, v) => a + v, 0) / d.length;
          const se = Math.sqrt(d.reduce((a, v) => a + (v - md) ** 2, 0) / Math.max(1, d.length - 1) / d.length);
          if (md + se >= 0) keep.add(index);
        }
        population.forEach((ind, i) => { if (ind.age > 0 && ind.fit > -Infinity) keep.add(i); });
        active = active.filter((i) => keep.has(i));
        population.forEach((ind, i) => { ind.partial = !keep.has(i); });
      }
    }
    // Close contenders get more trials: when the top three are within a standard error of each other, run them on fresh cases.
    let extra = 0;
    if (s.config.extraTrials && cases.length >= 3) {
      const ranked = population.map((_, i) => ({ i, m: sums[i].reduce((a, o) => a + o.score, 0) / Math.max(1, sums[i].length), full: sums[i].length >= cases.length })).filter((e) => e.full).sort((a, b) => b.m - a.m);
      if (ranked.length >= 3) {
        const gaps = ranked.slice(0, 3).map((e) => sums[e.i].map((o) => o.score));
        const diff = gaps[0].map((v, c) => v - gaps[1][c]), md = diff.reduce((a, v) => a + v, 0) / diff.length;
        const se = Math.sqrt(diff.reduce((a, v) => a + (v - md) ** 2, 0) / Math.max(1, diff.length - 1) / diff.length);
        if (Math.abs(md) < se) {
          const plan = this.replayPlan();
          const more = trainingBattery(s.stage, s.generation + 500_000, s.config.runSeed, Math.max(2, Math.ceil(cases.length / 2)), objectiveWith(s.emphasis), plan.share, { hard: s.hard, hardShare: s.config.hardShare, pocketShare: s.config.pocketShare, replayWeights: plan.weights });
          const picks = ranked.slice(0, 3).map((e) => e.i);
          const extraOut = await backend.evaluate(picks.map((i) => population[i].brain), more);
          s.counters.episodes += picks.length * more.length; extra = picks.length * more.length;
          picks.forEach((idx, k) => { sums[idx].push(...extraOut[k]); });
        }
      }
    }
    s.counters.evaluations += 1;
    population.forEach((ind, i) => {
      const agg = aggregate(sums[i]);
      ind.desc = agg.descriptor;
      ind.fitNow = agg.score; ind.traits = agg.traits; ind.crashRate = agg.crash; ind.reach = agg.reach;
      // Smooth across generations for individuals that survive, so one lucky battery does not crown a brain.
      ind.fit = ind.age > 0 && Number.isFinite(ind.fit) ? 0.5 * ind.fit + 0.5 * agg.score : agg.score;
    });
    return { sums, extra };
  }

  /** Remember trials the leader failed (and forget ones it now solves twice), up to 40. */
  private mineHard(population: Individual[], cases: CaseSpec[], sums: CaseOutcome[][]): void {
    const s = this.state, pool = (s.hard ??= []);
    let best = -1;
    population.forEach((ind, i) => { if (!ind.partial && sums[i].length >= cases.length && (best < 0 || ind.fitNow > population[best].fitNow)) best = i; });
    if (best < 0) return;
    cases.forEach((spec, c) => {
      if (spec.key === undefined) return;
      const outcome = sums[best][c], at = pool.findIndex((h) => h.stage === spec.stage && h.key === spec.key);
      const failed = outcome.reachFrac < 1 || outcome.crashed;
      if (failed && at < 0) pool.push({ stage: spec.stage, key: spec.key, ...(spec.scenario.pocket ? { pocket: true } : {}), solved: 0 });
      else if (!failed && at >= 0 && ++pool[at].solved >= 2) pool.splice(at, 1);
    });
    while (pool.length > 40) pool.shift();
  }

  /** Behaviour cell of a candidate: speed, straightness, turning, ground covered, each in three bins. */
  private qdUpdate(population: Individual[]): void {
    const s = this.state;
    if (!s.config.qd) return;
    if (s.qdStage !== s.stage || !s.qd) { s.qd = {}; s.qdStage = s.stage; }
    const median = [...population].filter((i) => !i.partial).map((i) => i.fitNow).sort((a, b) => a - b);
    const cut = median[Math.floor(median.length / 2)] ?? -Infinity;
    for (const ind of population) {
      if (ind.partial || !ind.desc || ind.fitNow < cut) continue;
      const bin = (v: number): number => (v < 0.34 ? 0 : v < 0.67 ? 1 : 2);
      const key = [ind.desc[1], ind.desc[2], ind.desc[3], ind.desc[5]].map(bin).join("");
      const held = s.qd[key];
      if (!held || ind.fitNow > held.score || s.generation - held.gen > 60) s.qd[key] = { score: ind.fitNow, id: ind.id, brain: ind.brain, gen: s.generation };
    }
  }

  private async exam(ind: Individual, tag = 0, size = this.state.config.examSize): Promise<Aggregate> {
    const cases = examBattery(this.state.stage, size, tag);
    const [outcomes] = await this.backend.evaluate([ind.brain], cases);
    this.state.counters.episodes += cases.length;
    return aggregate(outcomes);
  }

  /** One full generation. Returns its record (also appended to the history). */
  async generation(): Promise<GenerationRecord> {
    const s = this.state, c = s.config, started = Date.now();
    // A fresh population (first generation, or just after a new climb or stage began) is scored as it stands;
    // otherwise the next one is bred from the last.
    const unscored = s.population.every((i) => !Number.isFinite(i.fit));
    const candidates = unscored ? (s.population.length < Math.ceil(c.population / 2) ? this.seedPopulation() : s.population) : this.breed();
    s.generation += 1; s.stageGeneration += 1; s.branchGeneration += 1;
    const plan = this.replayPlan();
    const cases = trainingBattery(s.stage, s.generation, c.runSeed, c.battery, objectiveWith(s.emphasis), plan.share, { hard: s.hard, hardShare: c.hardShare, pocketShare: c.pocketShare, replayWeights: plan.weights });
    const scored = await this.score(candidates, cases);
    if (c.hardShare > 0) this.mineHard(candidates, cases, scored.sums);
    this.qdUpdate(candidates);
    const screened = await this.screen(candidates);
    this.assignBreedingValues(candidates, s.population);
    s.population = candidates;
    const ranked = [...candidates].sort((a, b) => b.fit - a.fit);
    const leader = ranked[0];
    const fits = candidates.map((i) => i.fitNow);
    const record: GenerationRecord = {
      gen: s.generation, stage: s.stage, branch: s.branch, branchType: s.branchType,
      best: Math.max(...fits), mean: fits.reduce((a, b) => a + b, 0) / fits.length, worst: Math.min(...fits), champion: leader.fit,
      diversity: this.diversity(candidates), scale: Math.min(3, 1 + 0.35 * s.staleExams), stale: s.staleExams,
      kinship: this.lastKinship, defective: screened.defective, screened: screened.count,
      hard: s.hard?.length ?? 0, qdCells: s.qd ? Object.keys(s.qd).length : 0, extra: scored.extra,
      proj: projectGenome(leader.brain), hidden: leader.brain.hiddenCount, elapsed: 0, evals: s.counters.episodes,
    };
    let event: string | undefined;
    if (s.branchGeneration === 1 || s.branchGeneration % c.examEvery === 0) {
      // A fresh set of trials every time: the leader cannot be selected for luck on one fixed set.
      const agg = await this.exam(leader, 10 + s.generation);
      const exam = { gen: s.generation, score: agg.score, se: agg.se, reach: agg.reach };
      s.exams.push(exam);
      record.exam = { score: agg.score, se: agg.se, reach: agg.reach, crash: agg.crash, reverse: agg.watch.reverse, wall: agg.watch.wall, pinned: agg.watch.pinSeconds, recovered: agg.watch.recoveries };
      await this.probeRetention(leader.brain);
      const entry = { ...exam, crash: agg.crash, brain: leader.brain, id: leader.id, traits: agg.traits, descriptor: agg.descriptor };
      s.hall.push(entry); if (s.hall.length > 12) s.hall.shift();
      if (!s.bestExam || agg.score > s.bestExam.score) s.bestExam = entry;
      // Plateau test on a three-exam moving average, so one lucky or unlucky exam moves it a third as far.
      const recent = s.exams.slice(-3), mean = recent.reduce((a, e) => a + e.score, 0) / recent.length;
      const improved = s.exams.length >= 3 ? mean > s.bestMean + Math.max(c.minGain, 0.35 * agg.se) : true;
      if (s.exams.length >= 3 && mean > s.bestMean) s.bestMean = mean;
      s.staleExams = improved ? 0 : s.staleExams + 1;
      if (s.staleExams >= c.patience || s.branchGeneration >= c.maxGenerationsPerBranch) event = await this.finishBranch(s.branchGeneration >= c.maxGenerationsPerBranch ? "generation budget" : `no gain for ${c.patience} exams`);
    }
    record.event = event;
    // A generation that spans a laptop sleep must not count the night as working time: cap what one can add.
    s.counters.elapsedMs += Math.min(Date.now() - started, 15 * 60_000); record.elapsed = s.counters.elapsedMs;
    s.history.push(record);
    if (s.history.length > 8000) s.history = s.history.filter((_, k) => k % 2 === 0 || k > s.history.length - 2000);
    this.emit({ type: "generation", record });
    return record;
  }

  /** Screen the candidates that could become parents (best by smoothed score), once each. */
  private async screen(candidates: Individual[]): Promise<{ count: number; defective: number }> {
    const c = this.state.config;
    const top = [...candidates].filter((i) => !i.partial).sort((a, b) => b.fit - a.fit).slice(0, c.parents * 2);
    const todo = top.filter((i) => i.screens === undefined);
    if (todo.length) {
      const cases: CaseSpec[] = SCREENS.map((kind, k) => ({ ...caseFor(0, 31337 + k), screen: kind }));
      const outcomes = await this.backend.evaluate(todo.map((i) => i.brain), cases);
      this.state.counters.episodes += todo.length * cases.length;
      todo.forEach((ind, i) => { ind.screens = outcomes[i].filter((o) => o.screen?.failed).map((o) => o.screen!.kind); });
    }
    const defective = top.filter((i) => (i.screens ?? []).some((k) => GATING.includes(k))).length;
    return { count: top.length, defective };
  }

  private diversity(pop: Individual[]): number {
    const proj = pop.map((i) => projectGenome(i.brain)), mean = proj[0].map((_, k) => proj.reduce((a, p) => a + p[k], 0) / proj.length);
    return proj.reduce((a, p) => a + projectionDistance(p, mean), 0) / proj.length;
  }

  /** Spread the seed (and any founders) into a first population: each founder as it is, then mutants dealt out among them. */
  private seedPopulation(): Individual[] {
    const s = this.state, c = s.config, founders = s.population;
    const out: Individual[] = founders.map((f) => ({ ...f }));
    for (let k = out.length; k < c.population; k += 1) {
      const base = founders[k % founders.length];
      const brain = constrain(this.net(base).mutate(Math.min(0.5, c.mutationRate * (1 + (k % 4) * 0.5)), c.mutationSize * (1 + (k % 3) * 0.5), hashSeed(c.runSeed, 1, k)).toJSON(), base.brain, this.plan(base.brain.hiddenCount));
      out.push({ id: this.newId("c"), brain, parent: base.id, mate: null, origin: "mutant", born: 1, fit: -Infinity, fitNow: -Infinity, age: 0, traits: base.traits, crashRate: 0, reach: 0, partial: false });
    }
    return out;
  }

  /** File the best brain of this climb as a local maximum, then decide where to look next. */
  private async finishBranch(reason: string): Promise<string> {
    const s = this.state, c = s.config;
    if (!s.bestExam) return "no exam";
    // Winner's curse guard: the exam leaders of this climb meet again on trials none of them was picked on.
    const finalists = [...s.hall].sort((a, b) => b.score - a.score).slice(0, 4);
    const lastLeader = s.hall[s.hall.length - 1];
    if (lastLeader && !finalists.includes(lastLeader)) finalists.push(lastLeader);
    // Lifetime learning: the best of the climb, polished on its own successful trials, stands against the unpolished brains.
    let polishedAt = -1;
    if (c.polish && finalists.length) {
      const top = finalists[0], p = polish(top.brain, { stage: s.stage, seed: s.counters.maxima, plan: this.plan(top.brain.hiddenCount) });
      if (p) { finalists.push({ ...top, brain: p.brain, id: `${top.id}+polish` }); polishedAt = finalists.length - 1; }
    }
    const confirmCases = examBattery(s.stage, c.examSize * 2, 5000 + s.counters.maxima);
    const confirmed = await this.backend.evaluate(finalists.map((f) => f.brain), confirmCases);
    s.counters.episodes += finalists.length * confirmCases.length;
    let pick = 0, pickScore = -Infinity, pickAgg: Aggregate | null = null;
    confirmed.forEach((outcomes, i) => { const a = aggregate(outcomes); if (a.score > pickScore) { pickScore = a.score; pick = i; pickAgg = a; } });
    const winner = finalists[pick], confirmedAgg = pickAgg as Aggregate | null;
    const be = confirmedAgg ? { ...winner, score: confirmedAgg.score, se: confirmedAgg.se, reach: confirmedAgg.reach, crash: confirmedAgg.crash, traits: confirmedAgg.traits, descriptor: confirmedAgg.descriptor } : s.bestExam;
    const max: LocalMax = {
      id: `L${s.counters.maxima + 1}`, stage: s.stage, branch: s.branch, branchType: s.branchType, emphasis: s.emphasis, generation: be.gen, hidden: be.brain.hiddenCount,
      exam: { score: be.score, se: be.se, reach: be.reach, crash: be.crash }, traits: be.traits, descriptor: be.descriptor, proj: projectGenome(be.brain), parentId: null, brain: be.brain, plan: this.plan(be.brain.hiddenCount),
      note: `${s.branchType} climb, ${s.emphasis}; stopped: ${reason}${polishedAt >= 0 && finalists[pick]?.id.endsWith("+polish") ? "; polished by lifetime learning" : ""}`,
    };
    s.counters.maxima += 1; s.archive.push(max); s.branchesThisStage += 1;
    this.emit({ type: "localMax", max });
    this.log(`Local maximum ${max.id} · stage ${s.stage + 1} · ${max.branchType}/${max.emphasis} · exam ${max.exam.score.toFixed(1)} ± ${max.exam.se.toFixed(1)} · flags ${(max.exam.reach * 100).toFixed(0)}% · ${max.hidden} neurons`);
    const stageMaxima = s.archive.filter((m) => m.stage === s.stage);
    const budget = c.branchesPerStage + s.extraBranches;
    if (s.branchesThisStage >= budget) await this.holdTournament();
    else this.startBranch(stageMaxima);
    return `local maximum ${max.id}`;
  }

  /** Begin a new climb from the archive, trying a new direction each time. */
  private startBranch(stageMaxima: LocalMax[], force?: BranchType): void {
    const s = this.state, c = s.config;
    const ranked = [...stageMaxima].sort((a, b) => b.exam.score - a.exam.score);
    const best = ranked[0];
    // Rotate through the strategies; skip any that are not possible yet.
    let type: BranchType = force ?? BRANCH_ORDER[(s.branch) % BRANCH_ORDER.length];
    if (type === "crossbreed" && ranked.length < 2) type = "kick";
    if (type === "grow" && best.hidden + c.growBy > c.maxHidden) type = "ancestor";
    // Each source carries the layer plan it was bred under; the new climb adopts the plan of what it starts from.
    let plan: BrainPlan = validatePlan(best.plan ?? singleLayer(best.hidden), best.hidden);
    const unused = EMPHASES.filter((e) => !s.usedEmphasis.includes(e.id));
    let emphasis = s.emphasis;
    let from: string | null = best.id;
    let seedBrains: { brain: BrainSnapshot; origin: string }[] = [];
    const seed = hashSeed(c.runSeed, s.counters.maxima, 17);
    const random = mulberry32(seed);
    const net = (b: BrainSnapshot): SpikingNetwork => SpikingNetwork.fromJSON(b);
    if (type === "kick") {
      seedBrains = [{ brain: best.brain, origin: "kick source" }];
    } else if (type === "ancestor") {
      // Go back to where this stage began and try again under a different emphasis.
      emphasis = (unused[0] ?? EMPHASES[Math.floor(random() * EMPHASES.length)]).id;
      const early = s.stageEntry ?? best.brain;
      plan = validatePlan(s.stageEntryPlan ?? singleLayer(early.hiddenCount), early.hiddenCount);
      seedBrains = [{ brain: early, origin: "stage start" }];
      if (best.brain.hiddenCount === early.hiddenCount) seedBrains.push({ brain: best.brain, origin: "best max" });
      from = s.stageEntryId;
    } else if (type === "crossbreed") {
      const [a, b] = ranked;
      const A = net(a.brain), B = net(b.brain);
      if (a.brain.hiddenCount === b.brain.hiddenCount) seedBrains = Array.from({ length: 6 }, (_, k) => ({ brain: A.crossover(B, seed + k, 0.5).toJSON(), origin: `cross ${a.id}×${b.id}` }));
      else seedBrains = [{ brain: a.brain, origin: "bigger parent" }];
      from = `${a.id}×${b.id}`;
    } else if (type === "grow") {
      // A new layer on top of the best maximum; what it already does is protected from large changes.
      const layered = addLayer(plan, best.brain, c.growBy, seed, c.protect, `layer ${plan.layers.length}`, c.kenyonShare);
      plan = layered.plan;
      seedBrains = [{ brain: layered.brain, origin: `new layer +${c.growBy}` }];
    } else {
      // Scouts: unrelated random brains of the same size, with a couple of the best's mutants so the climb can still be won.
      seedBrains = [{ brain: best.brain, origin: "best max" }];
      for (let k = 0; k < 8; k += 1) {
        const fresh = new SpikingNetwork(hashSeed(seed, k) / 1e6, best.brain.inputCount, best.brain.hiddenCount).toJSON();
        // A scout still wants to move forward: damp the random reverse pool the way the open world's scouts do.
        const H = fresh.hiddenCount;
        for (let n = 0; n < H; n += 1) { fresh.outputWeights[n] *= 0.8; fresh.outputWeights[H + n] = Math.abs(fresh.outputWeights[H + n]) * 0.4; fresh.outputWeights[2 * H + n] = -Math.abs(fresh.outputWeights[2 * H + n]) * 0.2; fresh.outputWeights[3 * H + n] = -Math.abs(fresh.outputWeights[3 * H + n]) * 0.2; }
        seedBrains.push({ brain: fresh, origin: "scout" });
      }
    }
    s.plan = plan;
    s.branch += 1; s.branchType = type; s.emphasis = emphasis; s.branchGeneration = 0; s.exams = []; s.bestExam = null; s.staleExams = 0; s.hall = []; s.bestMean = -1e9;
    if (!s.usedEmphasis.includes(emphasis)) s.usedEmphasis.push(emphasis);
    s.counters.kicks += 1;
    // Fill the population with the sources and their mutants.
    const pop: Individual[] = [];
    let slot = 0;
    for (const source of seedBrains) {
      if (pop.length >= c.population) break;
      pop.push({ id: this.newId("c"), brain: source.brain, parent: from, mate: null, origin: source.origin, born: s.generation, fit: -Infinity, fitNow: -Infinity, age: 0, traits: best.traits, crashRate: 0, reach: 0, partial: false });
    }
    while (pop.length < c.population) {
      const source = seedBrains[slot % seedBrains.length]; slot += 1;
      const mutant = constrain(net(source.brain).mutate(Math.min(0.5, c.mutationRate * 2), c.mutationSize * 1.8, hashSeed(seed, slot, 3)).toJSON(), source.brain, plan);
      pop.push({ id: this.newId("c"), brain: mutant, parent: from, mate: null, origin: `${source.origin} mutant`, born: s.generation, fit: -Infinity, fitNow: -Infinity, age: 0, traits: best.traits, crashRate: 0, reach: 0, partial: false });
    }
    s.population = pop;
    this.emit({ type: "branch", stage: s.stage, branch: s.branch, branchType: type, emphasis, from });
    this.log(`New climb ${s.branch + 1} in stage ${s.stage + 1}: ${type}${type === "ancestor" ? ` (${emphasis})` : ""}${type === "grow" ? ` +${c.growBy} neurons as a new layer` : ""} · ${describePlan(plan)}`);
  }

  /** Compare the stage's local maxima on trials none of them has seen, with earlier stages mixed in. */
  private async holdTournament(): Promise<void> {
    const s = this.state, c = s.config;
    const maxima = s.archive.filter((m) => m.stage === s.stage);
    const entries = maxima.map((m) => ({ id: m.id, brain: m.brain, max: m as LocalMax | null }));
    if (s.stageEntry && s.stage > 0) entries.push({ id: s.stageEntryId ?? "entry", brain: s.stageEntry, max: null });
    // Current stage: fresh seeds (tag 1). Earlier stages: a retention check on their own exam trials.
    const current = examBattery(s.stage, c.tournamentSize, 1000 + s.counters.tournaments);
    const earlier: CaseSpec[] = [];
    for (let st = 0; st < s.stage; st += 1) earlier.push(...examBattery(st, Math.max(8, Math.round(c.tournamentSize / 6)), 2));
    const brains = entries.map((e) => e.brain);
    const [now, before] = await Promise.all([this.backend.evaluate(brains, current), earlier.length ? this.backend.evaluate(brains, earlier) : Promise.resolve(entries.map(() => [] as CaseOutcome[]))]);
    s.counters.episodes += brains.length * (current.length + earlier.length);
    const rows = entries.map((e, i) => {
      const a = aggregate(now[i]), b = before[i].length ? aggregate(before[i]) : null;
      return { entry: e, a, retention: b ? b.reach : 1, retentionScore: b ? b.score : 0, byStage: (b?.perStage ?? {}) as Record<number, { reach: number }> };
    });
    // Mixed score: three quarters current stage, one quarter retention of earlier stages (scaled to the same points).
    const mixed = (r: typeof rows[number]): number => (earlier.length ? 0.75 * r.a.score + 0.25 * r.retentionScore : r.a.score);
    rows.sort((x, y) => mixed(y) - mixed(x));
    const ranking = rows.map((r) => ({ id: r.entry.id, score: mixed(r), reach: r.a.reach, retention: r.retention }));
    for (const r of rows) if (r.entry.max) r.entry.max.tournament = { score: r.a.score, se: r.a.se, reach: r.a.reach, crash: r.a.crash, retention: r.retention };
    // Skills that were learned and are now gone: earlier stages whose fresh-trial reach fell below what they must keep.
    const shortfalls = (r: typeof rows[number]): { stage: number; got: number; target: number }[] => {
      const out: { stage: number; got: number; target: number }[] = [];
      if (!(c.retainShare > 0)) return out;
      for (let st = 0; st < s.stage; st += 1) { const got = r.byStage[st]?.reach, target = this.retentionTarget(st); if (got !== undefined && got < target) out.push({ stage: st, got, target }); }
      return out;
    };
    const goal = this.goalFor(s.stage);
    // The winner is the best brain that has both mastered this stage and kept the earlier ones, if there is one.
    const qualified = rows.filter((r) => r.a.reach >= goal && shortfalls(r).length === 0);
    const winner = !c.advanceAnyway && qualified.length ? qualified[0] : rows[0];
    const lost = shortfalls(winner), reached = winner.a.reach >= goal;
    const mastered = c.advanceAnyway ? reached : reached && lost.length === 0;
    this.noteRetention((st) => winner.byStage[st]?.reach, 0.3);
    s.counters.tournaments += 1;
    this.emit({ type: "tournament", stage: s.stage, ranking });
    const retained: Record<number, number> = {};
    for (let st = 0; st < s.stage; st += 1) { const got = winner.byStage[st]?.reach; if (got !== undefined) retained[st] = got; }
    const result: StageResult = { stage: s.stage, winner: winner.entry.id, score: winner.a.score, se: winner.a.se, reach: winner.a.reach, mastered, retained, ranking, generation: s.generation };
    this.log(`Tournament, stage ${s.stage + 1}: winner ${winner.entry.id} · ${winner.a.score.toFixed(1)} ± ${winner.a.se.toFixed(1)} · flags ${(winner.a.reach * 100).toFixed(0)}% · retention ${(winner.retention * 100).toFixed(0)}%${mastered ? " · MASTERED" : ""}`);
    this.tidyArchive();
    const win = { id: winner.entry.id, brain: winner.entry.brain, plan: winner.entry.max?.plan, traits: winner.a.traits, score: winner.a.score, se: winner.a.se, reach: winner.a.reach };
    if (!mastered && !c.advanceAnyway) {
      // A stage is mastered before the next one begins, with the earlier ones kept: climb until it is, or until it is plain that it will not be.
      const deficit = lost.reduce((a, l) => a + (1 - l.got / Math.max(1e-6, l.target)), 0);
      const better = win.reach > (s.stageBest ?? -1) + 0.02 || deficit < (s.stageBestDeficit ?? Infinity) - 0.05;
      if (better) { s.stageBest = Math.max(s.stageBest ?? -1, win.reach); s.stageBestDeficit = Math.min(s.stageBestDeficit ?? Infinity, deficit); s.stageStale = 0; } else s.stageStale = (s.stageStale ?? 0) + 1;
      const cap = c.maxClimbsPerStage + (s.climbBonus ?? 0), stuck = (s.stageStale ?? 0) >= c.stageStall;
      const forgetting = lost.map((l) => `stage ${l.stage + 1} (${(l.got * 100).toFixed(0)}% against ${(l.target * 100).toFixed(0)}% to keep)`).join(", ");
      // Out of ideas at this size? Try more capacity once before giving up: a new layer, and a fresh window of patience for it.
      if (stuck && !s.grewOnStall && c.growBy > 0) {
        const top = s.archive.filter((m) => m.stage === s.stage).sort((a, b) => (b.tournament?.score ?? b.exam.score) - (a.tournament?.score ?? a.exam.score))[0];
        if (top && top.hidden + c.growBy <= c.maxHidden) {
          s.grewOnStall = true; s.stageStale = 0;
          this.log(`Stage ${s.stage + 1} has stopped improving at ${top.hidden} neurons: trying +${c.growBy} neurons before giving up.`);
          this.startBranch(s.archive.filter((m) => m.stage === s.stage), "grow");
          return;
        }
      }
      if (s.branchesThisStage >= cap || stuck) {
        const why = (stuck ? `no better result for ${s.stageStale} climbs in a row` : `${s.branchesThisStage} climbs without reaching it`) + (lost.length ? `; it forgets ${forgetting}` : "");
        s.stalled = { stage: s.stage, reach: win.reach, goal, climbs: s.branchesThisStage, why, forgot: lost.map((l) => l.stage), winnerId: win.id, brain: win.brain, plan: win.plan, traits: win.traits, score: win.score, se: win.se };
        s.finished = true;
        if (!s.champion || s.stage >= s.champion.stage) s.champion = { id: win.id, stage: s.stage, score: win.score, brain: win.brain, note: `stage ${s.stage + 1} best so far (not mastered)` };
        this.log(`Stage ${s.stage + 1} stopped: best ${(win.reach * 100).toFixed(0)}% of flags against a goal of ${(goal * 100).toFixed(0)}% (${why}). The run waits for you: more climbs, a lower goal, or move on.`);
        this.emit({ type: "stalled", stage: s.stage, reach: win.reach, goal, why });
        return;
      }
      this.log(reached
        ? `Stage ${s.stage + 1} reached its goal (${(win.reach * 100).toFixed(0)}%) but forgot ${forgetting}: another climb, rehearsing what was lost (${s.branchesThisStage} so far).`
        : `Stage ${s.stage + 1} not mastered (${(win.reach * 100).toFixed(0)}% < ${(goal * 100).toFixed(0)}%)${lost.length ? `, and it forgets ${forgetting}` : ""}: another climb (${s.branchesThisStage} so far, best ${((s.stageBest ?? win.reach) * 100).toFixed(0)}%).`);
      this.startBranch(s.archive.filter((m) => m.stage === s.stage));
      return;
    }
    // The older rule, for anyone who asks for it (advanceAnyway): two more climbs, then on to the next stage regardless.
    if (!mastered && s.extraBranches < 2 && c.branchesPerStage > 0) {
      s.extraBranches += 1;
      this.log(`Stage ${s.stage + 1} not mastered (${(win.reach * 100).toFixed(0)}% < ${(goal * 100).toFixed(0)}%): ${s.extraBranches === 1 ? "one" : "two"} more climb(s).`);
      this.startBranch(s.archive.filter((m) => m.stage === s.stage));
      return;
    }
    s.stageResults.push(result);
    this.emit({ type: "stage", result });
    this.moveToNext(win.id, win.brain, win.plan, win.traits, win.score);
  }

  /** The stage is done: its winner starts the next one, with a new layer on top from the configured stage on. */
  private moveToNext(winnerId: string, bestBrain: BrainSnapshot, winnerPlan: BrainPlan | undefined, traits: Traits, score: number): void {
    const s = this.state, c = s.config;
    const challenger = { id: winnerId, stage: s.stage, score, brain: bestBrain, note: `stage ${s.stage + 1} tournament winner` };
    if (!s.champion || s.stage >= s.champion.stage) s.champion = challenger;
    if (s.stage >= this.lastStage) { s.finished = true; this.emit({ type: "finished" }); return; }
    s.stage += 1; this.resetStageCounters();
    let startBrain = bestBrain;
    let startPlan = validatePlan(winnerPlan ?? singleLayer(bestBrain.hiddenCount), bestBrain.hiddenCount);
    // Afterwards, a more advanced layer: the winner keeps what it can do (made stiffer) and a new layer on top learns the next skill.
    if (c.layerPerStage > 0 && s.stage >= c.layerFromStage && bestBrain.hiddenCount + c.layerPerStage <= c.maxHidden) {
      const layered = addLayer(startPlan, bestBrain, c.layerPerStage, hashSeed(c.runSeed, s.stage, 91), c.protect, `stage ${s.stage + 1} layer`, c.kenyonShare);
      startBrain = layered.brain; startPlan = layered.plan;
    }
    s.plan = startPlan; s.stageEntryPlan = startPlan;
    s.stageEntry = startBrain; s.stageEntryId = winnerId;
    const base: Individual = { id: this.newId("c"), brain: startBrain, parent: winnerId, mate: null, origin: "stage winner", born: s.generation, fit: -Infinity, fitNow: -Infinity, age: 0, traits, crashRate: 0, reach: 0, partial: false };
    s.population = [base];
    this.log(`Stage ${s.stage + 1} begins: ${STAGES[s.stage].title} · brain ${describePlan(startPlan)}`);
  }

  private resetStageCounters(): void {
    const s = this.state;
    s.stageGeneration = 0; s.branch = 0; s.branchGeneration = 0; s.branchType = "seed"; s.emphasis = "balanced"; s.usedEmphasis = ["balanced"];
    s.exams = []; s.bestExam = null; s.staleExams = 0; s.hall = []; s.bestMean = -1e9; s.branchesThisStage = 0; s.extraBranches = 0;
    s.stageBest = undefined; s.stageBestDeficit = undefined; s.grewOnStall = false; s.stageStale = 0; s.climbBonus = 0; s.stalled = null; s.retention = undefined;
  }

  /**
   * Estimated breeding value, as a stock breeder would: not one animal's own record, but its record together with its
   * pedigree (the mean value of its parents) and its progeny (how the offspring it has already sired scored against their
   * generation), each weighted by how much it can be trusted. A parent that scores well by luck but whose children do not
   * is demoted; a brain that is only average itself but keeps siring good offspring is promoted. A simple index, not a
   * full BLUP: the weights are choices (pedigree counts for half, each offspring for half, at most two), not estimates.
   */
  private assignBreedingValues(candidates: Individual[], previous: Individual[]): void {
    const s = this.state, book = (s.progeny ??= {});
    const full = candidates.filter((i) => !i.partial);
    if (!full.length) return;
    const mean = full.reduce((a, i) => a + i.fitNow, 0) / full.length;
    const before = new Map(previous.map((i) => [i.id, i.ebv ?? 0]));
    // Offspring born this generation report to their parents; elites carried over are not anyone's offspring.
    for (const ind of full) {
      if (ind.age > 0) continue;
      for (const id of [ind.parent, ind.mate]) if (id && before.has(id)) { const e = (book[id] ??= [0, 0]); e[0] += 1; e[1] += ind.fitNow - mean; }
    }
    for (const ind of candidates) {
      const own = ind.fitNow - mean;
      const parents = [ind.parent, ind.mate].filter((id): id is string => !!id && before.has(id));
      const pedigree = parents.length ? parents.reduce((a, id) => a + (before.get(id) ?? 0), 0) / parents.length : null;
      const record = book[ind.id], progeny = record && record[0] ? record[1] / record[0] : 0, wProgeny = record ? Math.min(2, 0.5 * record[0]) : 0, wPedigree = pedigree === null ? 0 : 0.5;
      ind.ebv = (own + wPedigree * (pedigree ?? 0) + wProgeny * progeny) / (1 + wPedigree + wProgeny);
    }
    const alive = new Set(candidates.map((i) => i.id));
    for (const id of Object.keys(book)) if (!alive.has(id)) delete book[id];
  }

  /** What an earlier stage's winner kept, in the share of flags it found then, to count as still knowing the stage. */
  retentionTarget(stage: number): number {
    const s = this.state, result = s.stageResults.find((r) => r.stage === stage);
    return (s.config.retainShare ?? 0) * Math.min(this.goalFor(stage), result ? result.reach : this.goalFor(stage));
  }

  /** Note how much of each earlier stage the brain keeps, blended with what was noted before. */
  private noteRetention(read: (stage: number) => number | undefined, blend: number): void {
    const s = this.state;
    if (!(s.config.retainShare > 0)) return;
    const book = (s.retention ??= {});
    for (let st = 0; st < s.stage; st += 1) {
      const reach = read(st);
      if (reach === undefined) continue;
      const old = book[st];
      book[st] = { reach: old ? blend * old.reach + (1 - blend) * reach : reach, target: this.retentionTarget(st) };
    }
  }

  /** A few fresh trials of every earlier stage for the leader, to see which skills are slipping before the tournament says so. */
  private async probeRetention(brain: BrainSnapshot): Promise<void> {
    const s = this.state;
    if (s.stage === 0 || !(s.config.retainShare > 0)) return;
    const cases: CaseSpec[] = [];
    for (let st = 0; st < s.stage; st += 1) cases.push(...examBattery(st, 3, 7000 + s.generation));
    const [outcomes] = await this.backend.evaluate([brain], cases);
    s.counters.episodes += cases.length;
    const by = aggregate(outcomes).perStage;
    this.noteRetention((st) => by[st]?.reach, 0.5);
  }

  /** How much of the training battery rehearses earlier stages, and which: more, and the most-forgotten first, while a skill is slipping. */
  private replayPlan(): { share: number; weights?: number[] } {
    const s = this.state, base = s.config.replayShare;
    if (s.stage === 0 || !(s.config.retainShare > 0) || !s.retention) return { share: base };
    const weights: number[] = []; let worst = 0;
    for (let st = 0; st < s.stage; st += 1) {
      const r = s.retention[st], deficit = r && r.target > 0 ? Math.max(0, Math.min(1, 1 - r.reach / r.target)) : 0;
      worst = Math.max(worst, deficit); weights.push(0.2 + 3 * deficit);
    }
    return { share: Math.min(0.7, base + 0.5 * worst), weights };
  }

  /**
   * Keep the best `keepPerStage` local maxima of every stage (by tournament score when it has one, else exam score) and
   * retire the rest. Runs after every tournament, and when an older run is opened. Returns how many were retired.
   */
  tidyArchive(): number {
    const s = this.state, keep = Math.max(1, s.config.keepPerStage ?? DEFAULT_CONFIG.keepPerStage);
    const winners = new Set(s.stageResults.map((r) => r.winner));
    const value = (m: LocalMax): number => m.tournament?.score ?? m.exam.score;
    const drop = new Set<string>();
    for (let st = 0; st < STAGES.length; st += 1) {
      const mine = s.archive.filter((m) => m.stage === st);
      if (mine.length <= keep) continue;
      for (const m of [...mine].sort((a, b) => value(b) - value(a)).slice(keep)) if (!winners.has(m.id)) drop.add(m.id);
    }
    if (!drop.size) return 0;
    s.archive = s.archive.filter((m) => !drop.has(m.id));
    s.counters.retired = (s.counters.retired ?? 0) + drop.size;
    this.log(`Retired ${drop.size} weaker local maxima (the best ${keep} of each stage are kept).`);
    return drop.size;
  }

  /** The share of flags a stage's winner has to find on fresh trials before the next stage begins. */
  goalFor(stage: number): number { return this.state.goals?.[stage] ?? STAGES[stage]?.mastery ?? 1; }

  setGoal(stage: number, goal: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= STAGES.length) throw new Error("There is no such stage.");
    if (!Number.isFinite(goal) || goal < 0.05 || goal > 1) throw new Error("A goal is a share of flags between 5 % and 100 %.");
    (this.state.goals ??= {})[stage] = goal;
    this.log(`Goal of stage ${stage + 1} set to ${(goal * 100).toFixed(0)}% of flags.`);
  }

  /** After a stop: grant more climbs and carry on (or, if the goal was lowered to what was reached, move on at once). */
  continueStage(climbs = 6): void {
    const s = this.state, st = s.stalled;
    if (!st) return;
    if (st.reach >= this.goalFor(st.stage) && !st.forgot?.length) { this.moveOn(); return; }
    s.climbBonus = (s.climbBonus ?? 0) + Math.max(1, climbs); s.stageStale = 0; s.stalled = null; s.finished = false;
    this.log(`Stage ${s.stage + 1}: ${Math.max(1, climbs)} more climbs allowed.`);
    this.startBranch(s.archive.filter((m) => m.stage === s.stage));
  }

  /** After a stop: take the best brain of the stage as it is and begin the next stage from it. */
  moveOn(): void {
    const s = this.state, st = s.stalled;
    if (!st) return;
    const result: StageResult = { stage: st.stage, winner: st.winnerId, score: st.score, se: st.se, reach: st.reach, mastered: st.reach >= this.goalFor(st.stage) && !(st.forgot?.length), ranking: [], generation: s.generation };
    s.stalled = null; s.finished = false;
    s.stageResults.push(result);
    this.emit({ type: "stage", result });
    this.log(`Stage ${st.stage + 1}: moving on with ${(st.reach * 100).toFixed(0)}% of flags found.`);
    this.moveToNext(st.winnerId, st.brain, st.plan, st.traits, st.score);
  }

  /**
   * Go back to a stage and climb it again, starting from its best brain (or from the local maximum `fromId`), optionally
   * with a new goal. The results of this stage and of later ones are dropped: later stages are rebuilt from the new winner.
   */
  rerunStage(stage: number, o: { goal?: number; fromId?: string } = {}): void {
    const s = this.state;
    if (!Number.isInteger(stage) || stage < 0 || stage >= STAGES.length) throw new Error("There is no such stage.");
    const value = (m: LocalMax): number => m.tournament?.score ?? m.exam.score;
    const mine = s.archive.filter((m) => m.stage === stage);
    const winnerId = s.stageResults.find((r) => r.stage === stage)?.winner;
    let pick: LocalMax | undefined;
    if (o.fromId) { pick = s.archive.find((m) => m.id === o.fromId); if (!pick) throw new Error(`There is no saved maximum called ${o.fromId}.`); }
    else pick = mine.find((m) => m.id === winnerId) ?? [...mine].sort((a, b) => value(b) - value(a))[0];
    if (!pick) throw new Error(`Stage ${stage + 1} has no saved brain to start again from.`);
    if (o.goal !== undefined) this.setGoal(stage, o.goal);
    s.stageResults = s.stageResults.filter((r) => r.stage < stage);
    s.stage = stage; this.resetStageCounters(); s.finished = false;
    const plan = validatePlan(pick.plan ?? singleLayer(pick.hidden), pick.hidden);
    s.plan = plan; s.stageEntryPlan = plan; s.stageEntry = null; s.stageEntryId = null;
    s.population = [{ id: this.newId("c"), brain: pick.brain, parent: pick.id, mate: null, origin: "rerun", born: s.generation, fit: -Infinity, fitNow: -Infinity, age: 0, traits: pick.traits, crashRate: 0, reach: 0, partial: false }];
    this.log(`Stage ${stage + 1} again, from ${pick.id}, goal ${(this.goalFor(stage) * 100).toFixed(0)}% of flags.`);
  }

  /** Run until `shouldStop` or the final stage is finished. */
  async run(shouldStop: () => boolean = () => false): Promise<void> {
    while (!this.state.finished && !shouldStop()) await this.generation();
  }

  /** Re-test every archived maximum and the champion on one common, fresh battery spanning all stages. */
  async finalComparison(perStage = 6): Promise<{ id: string; score: number; reach: number; perStage: Record<number, number> }[]> {
    const s = this.state, upto = Math.max(s.stage, this.lastStage);
    const cases: CaseSpec[] = [];
    for (let st = 0; st <= upto; st += 1) for (let k = 0; k < perStage; k += 1) cases.push(caseFor(st, 7_000_000 + k, BASE_OBJECTIVE));
    const finalists = s.archive.map((m) => ({ id: m.id, brain: m.brain }));
    if (s.champion) finalists.push({ id: `champion:${s.champion.id}`, brain: s.champion.brain });
    const outcomes = await this.backend.evaluate(finalists.map((f) => f.brain), cases);
    s.counters.episodes += finalists.length * cases.length;
    return finalists.map((f, i) => {
      const agg = aggregate(outcomes[i]);
      return { id: f.id, score: agg.score, reach: agg.reach, perStage: Object.fromEntries(Object.entries(agg.perStage).map(([k, v]) => [k, v.score])) as Record<number, number> };
    }).sort((a, b) => b.score - a.score);
  }

  /** The brain to hand over: the champion if any, otherwise the best archived exam, otherwise the current leader. */
  best(): { brain: BrainSnapshot; label: string } {
    const s = this.state;
    if (s.champion) return { brain: s.champion.brain, label: s.champion.note };
    const ranked = [...s.archive].sort((a, b) => b.stage - a.stage || b.exam.score - a.exam.score);
    if (ranked[0]) return { brain: ranked[0].brain, label: `local maximum ${ranked[0].id}` };
    const leader = [...s.population].sort((a, b) => b.fit - a.fit)[0];
    return { brain: leader.brain, label: "current leader" };
  }
}

export type { Random };
