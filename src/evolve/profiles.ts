// How much of the machine a run may use. "Resource sparse" is the default: it lets the laptop stay usable and cool
// overnight and still gets through the same stages, just with fewer candidates per generation.
import type { EngineConfig } from "./engine";

export type ProfileId = "sparse" | "standard" | "thorough";

export type RunProfile = {
  id: ProfileId; title: string; blurb: string;
  config: Partial<EngineConfig>;
  /** Worker count for a machine with this many logical cores. */
  workers: (cores: number) => number;
  /** Share of wall-clock time the command-line runner spends computing (the rest it sleeps), and whether it lowers its priority. */
  duty: number; lowPriority: boolean;
};

export const PROFILES: Record<ProfileId, RunProfile> = {
  sparse: {
    id: "sparse", title: "Resource sparse (default)",
    blurb: "One worker at low priority and about 60% duty; 12 candidates, 4 trials per generation, exams of 12, a 3-degree echo beam, layers capped at 80 neurons. The laptop stays usable.",
    config: { population: 12, parents: 4, elites: 1, battery: 4, examSize: 12, tournamentSize: 24, examEvery: 5, patience: 4, branchesPerStage: 3, maxGenerationsPerBranch: 90, rayStepDeg: 3, layerPerStage: 8, maxHidden: 80, growBy: 8 },
    workers: (cores) => Math.max(1, Math.floor(cores / 4)), duty: 0.6, lowPriority: true,
  },
  standard: {
    id: "standard", title: "Standard",
    blurb: "Most of the cores, 20 candidates, 6 trials per generation, exams of 16, the reference 2-degree echo beam.",
    config: {},
    workers: (cores) => Math.max(1, Math.min(cores - 1, 3)), duty: 1, lowPriority: false,
  },
  thorough: {
    id: "thorough", title: "Thorough",
    blurb: "Every core but one, 28 candidates, 8 trials per generation, exams of 24 and five maxima per stage: slower to run, steadier to read.",
    config: { population: 28, parents: 6, elites: 2, battery: 8, examSize: 24, tournamentSize: 48, branchesPerStage: 5, maxGenerationsPerBranch: 180, maxHidden: 112 },
    workers: (cores) => Math.max(1, cores - 1), duty: 1, lowPriority: false,
  },
};

export const DEFAULT_PROFILE: ProfileId = "sparse";
