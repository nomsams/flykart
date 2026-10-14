// What "good" means: reaching flags it has to find on its own, quickly, without hitting things, without circling.
import type { EpisodeResult } from "./drive";

export type Objective = {
  /** Points for the fraction of flags reached. */
  reach: number;
  /** Points for reaching them early (fraction of the time limit left). */
  speed: number;
  /** Shaping for having seen the flag at all, and for how big it got: only the camera's own view, never the flag's position. */
  sight: number;
  /** New ground covered while still looking (cells of the judge's coarse grid, capped). */
  explore: number;
  crash: number; pain: number; judge: number; reverse: number; idle: number;
};

export const BASE_OBJECTIVE: Objective = { reach: 100, speed: 35, sight: 12, explore: 15, crash: 45, pain: 5, judge: 1, reverse: 8, idle: 10 };

/** Variations used to climb out of a local maximum in a different direction. */
export const EMPHASES: { id: string; label: string; patch: Partial<Objective> }[] = [
  { id: "balanced", label: "balanced", patch: {} },
  { id: "search", label: "search harder", patch: { explore: 28, sight: 18, idle: 14 } },
  { id: "careful", label: "careful", patch: { crash: 70, pain: 9, speed: 20 } },
  { id: "fast", label: "fast", patch: { speed: 60, explore: 10 } },
  { id: "smooth", label: "no jitter, no reversing", patch: { reverse: 18, judge: 1.6, idle: 18 } },
];

export function objectiveWith(emphasis: string | undefined): Objective {
  const e = EMPHASES.find((x) => x.id === emphasis);
  return { ...BASE_OBJECTIVE, ...(e?.patch ?? {}) };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function scoreEpisode(r: EpisodeResult, o: Objective): number {
  const target = Math.max(1, r.goalTarget), limit = Math.max(1, r.maxTicks);
  const reach = r.goals / target;
  const speed = r.goalTicks.reduce((s, t) => s + Math.max(0, 1 - t / limit), 0) / target;
  const sight = clamp01(0.6 * Math.min(1, r.bestSize * 2.5) + (r.firstSeenTick === null ? 0 : 0.4 * (1 - r.firstSeenTick / limit)));
  const explore = clamp01(r.cells / 40);
  return o.reach * reach + o.speed * speed + o.sight * sight * (1 - reach) + o.explore * explore * (1 - reach)
    - o.crash * (r.crashed ? 1 : 0) - o.pain * Math.min(6, r.pain) - o.judge * Math.min(40, r.judgePenalty)
    - o.reverse * (r.reverseTicks / Math.max(1, r.ticks)) - o.idle * (r.idleTicks / Math.max(1, r.ticks));
}

/** Skills a breeder can reason about separately from the single score (each 0..1). */
export type Traits = { search: number; safety: number; speed: number; smooth: number };
export const TRAIT_NAMES: (keyof Traits)[] = ["search", "safety", "speed", "smooth"];

export function episodeTraits(r: EpisodeResult): Traits {
  const target = Math.max(1, r.goalTarget), limit = Math.max(1, r.maxTicks), reach = r.goals / target;
  const sight = clamp01(0.6 * Math.min(1, r.bestSize * 2.5) + (r.firstSeenTick === null ? 0 : 0.4 * (1 - r.firstSeenTick / limit)));
  return {
    search: clamp01(0.75 * reach + 0.15 * sight + 0.1 * clamp01(r.cells / 40)),
    safety: clamp01(1 - 0.6 * (r.crashed ? 1 : 0) - 0.4 * Math.min(1, r.pain / 6)),
    speed: clamp01(r.goalTicks.reduce((s, t) => s + Math.max(0, 1 - t / limit), 0) / target),
    smooth: clamp01(1 - r.jitterSeconds / 8 - 2 * (r.reverseTicks / Math.max(1, r.ticks)) - r.loopSeconds / 10 - r.idleTicks / Math.max(1, r.ticks)),
  };
}

/** What the robot did, in six numbers that do not say how well: used to tell one local maximum from another. */
export function episodeDescriptor(r: EpisodeResult): number[] {
  const seconds = Math.max(1, r.ticks) / 30;
  return [
    r.goals / Math.max(1, r.goalTarget),
    clamp01(r.meanSpeed / 90),
    clamp01(r.net / Math.max(20, r.path)),
    clamp01(r.turn / (2 * Math.PI) / seconds / 0.5),
    clamp01(r.reverseTicks / Math.max(1, r.ticks)),
    clamp01(r.cells / 40),
  ];
}
export const DESCRIPTOR_NAMES = ["flags found", "speed", "straightness", "turning", "reversing", "ground covered"];
