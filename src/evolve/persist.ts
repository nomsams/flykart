// Saving a run: a full resumable state, a light progress file for dashboards, and brain files other pages open.
import type { BrainSnapshot } from "../core";
import { shrinkBrain } from "./brain-size";
import type { EngineState, GenerationRecord, LocalMax, StageResult } from "./engine";
import { STAGES } from "./cases";

export const RUN_FORMAT = "flykart-evolve-run";

/** What a dashboard needs to draw every graph, without any weights. */
export type Progress = {
  format: typeof RUN_FORMAT; version: 1; savedAt: string; name: string;
  config: EngineState["config"];
  stage: number; stageTitle: string; branch: number; branchType: string; emphasis: string; generation: number;
  finished: boolean; elapsedMs: number; episodes: number;
  history: GenerationRecord[];
  maxima: Omit<LocalMax, "brain">[];
  stageResults: StageResult[];
  champion: { id: string; stage: number; score: number; note: string; hidden: number } | null;
  /** The brain's layers now: [name, neurons, plasticity]. */
  layers: [string, number, number][];
  log: string[];
  stages: { id: string; title: string; mastery: number }[];
};

export function toProgress(state: EngineState, name: string, log: string[] = []): Progress {
  return {
    format: RUN_FORMAT, version: 1, savedAt: new Date().toISOString(), name, config: state.config,
    stage: state.stage, stageTitle: STAGES[state.stage]?.title ?? "", branch: state.branch, branchType: state.branchType, emphasis: state.emphasis, generation: state.generation,
    finished: state.finished, elapsedMs: state.counters.elapsedMs, episodes: state.counters.episodes,
    history: state.history, maxima: state.archive.map(({ brain, ...rest }) => { void brain; return rest; }), stageResults: state.stageResults,
    champion: state.champion ? { id: state.champion.id, stage: state.champion.stage, score: state.champion.score, note: state.champion.note, hidden: state.champion.brain.hiddenCount } : null,
    layers: (state.plan?.layers ?? []).map((l) => [l.name, l.end - l.start, l.plasticity] as [string, number, number]), log: log.slice(-200), stages: STAGES.map((s) => ({ id: s.id, title: s.title, mastery: s.mastery })),
  };
}

/** A checkpoint in the plain `flykart-brain` format the racer, Vision and the 3D habitat import. */
export function brainFile(brain: BrainSnapshot, meta: { fitness: number; generation: number; label: string; run: string }): string {
  return JSON.stringify({
    format: "flykart-brain", version: 2, domain: "world", savedAt: new Date().toISOString(), fitness: meta.fitness, generation: meta.generation, track: "open world",
    provenance: [{ context: "flykart-evolve", trained: true, source: meta.label, run: meta.run, note: "Evolved in simulation (no compass; camera cue + HC-SR04). Not hardware validated." }],
    network: brain,
  });
}

/** A 48-neuron version for pages that only run 48 neurons (the weights of the least influential neurons are dropped). */
export function brainFile48(brain: BrainSnapshot, meta: { fitness: number; generation: number; label: string; run: string }): string {
  return brainFile(brain.hiddenCount === 48 ? brain : shrinkBrain(brain, 48), meta);
}

export function parseProgress(text: string): Progress {
  const p = JSON.parse(text) as Progress;
  if (p?.format !== RUN_FORMAT || p.version !== 1 || !Array.isArray(p.history) || !Array.isArray(p.maxima)) throw new Error("Not a FlyKart Evolve run file.");
  return p;
}
