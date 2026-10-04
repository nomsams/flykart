// Combining what the eyes say with what the "feeling" channels say.
//
// The tempting recipe, running both pathways to the end and averaging their
// actions, fails whenever the two disagree about a decision with two good
// answers (pass an obstacle on the left or on the right): the average steers
// straight at it. Animals instead combine *cues* before deciding, each weighted
// by its reliability (Ernst & Banks 2002). That is what this does, per estimate:
//
//     fused = Σ pᵢ·μᵢ / Σ pᵢ        pᵢ = 1 / variance of cue i
//
// A cue is the camera network (its variance is learned), the privileged
// "feeling" measurement (a small fixed variance, scaled by `fade`), and
// optionally the lap memory. Turning `fade` down to 0 removes the feeling cue
// completely, which is the "reduce the feeling component" step.
import { ESTIMATE_COUNT } from "./interface";

export type FusionConfig = {
  /** 1 = full trust in the privileged channels, 0 = ignore them. */
  fade: number;
  /** Assumed standard deviation of each privileged estimate (they are exact in the simulator, but a real sensor is not). */
  privilegedSigma: number[];
  /** Smallest variance the camera may claim, so an overconfident output cannot dominate. */
  visionFloor: number;
  /** Multiplies the camera's predicted variance (above 1 = be more sceptical of it). */
  visionTemperature: number;
};

export const defaultFusion = (estimateCount: number = ESTIMATE_COUNT): FusionConfig => ({
  fade: 0,
  privilegedSigma: new Array(estimateCount).fill(0.03),
  visionFloor: 0.012 ** 2,
  // The camera network's error bars were stretched on hard held-out frames (see varianceScale), which makes them pessimistic on typical ones;
  // when it competes with another cue this puts them back (about 2.5 times less variance).
  visionTemperature: 0.45,
});
export const DEFAULT_FUSION: FusionConfig = defaultFusion();

export type Cue = { mean: ArrayLike<number>; variance: ArrayLike<number> };
export type Fused = { mean: Float32Array; variance: Float32Array; /** Share of the total precision that came from each cue, per estimate. */ weights: Float32Array[] };

export function createFused(cueCount: number, estimateCount: number = ESTIMATE_COUNT): Fused {
  return { mean: new Float32Array(estimateCount), variance: new Float32Array(estimateCount), weights: Array.from({ length: cueCount }, () => new Float32Array(estimateCount)) };
}

/**
 * Combine independent cues. `cues` entries may be null (absent). The first
 * cue is the camera, the second the privileged channels, the third the memory.
 */
export function fuseCues(cues: (Cue | null)[], out: Fused): Fused {
  const count = out.mean.length;
  for (let c = 0; c < count; c += 1) {
    let precision = 0, weighted = 0;
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i]; if (!cue) continue;
      const variance = cue.variance[c]; if (!(variance > 0) || !Number.isFinite(variance)) continue;
      const p = 1 / variance; precision += p; weighted += p * cue.mean[c];
    }
    if (precision <= 0) { out.mean[c] = 0; out.variance[c] = 1; for (const w of out.weights) w[c] = 0; continue; }
    out.mean[c] = weighted / precision; out.variance[c] = 1 / precision;
    for (let i = 0; i < out.weights.length; i += 1) { const cue = cues[i]; out.weights[i][c] = cue && cue.variance[c] > 0 && Number.isFinite(cue.variance[c]) ? (1 / cue.variance[c]) / precision : 0; }
  }
  return out;
}

/** Turn the privileged measurement and `fade` into a cue. With fade 0 the cue is absent. */
export function privilegedCue(truth: ArrayLike<number>, config: FusionConfig, scratch: { mean: Float32Array; variance: Float32Array }): Cue | null {
  if (config.fade <= 1e-9) return null;
  for (let c = 0; c < scratch.mean.length; c += 1) { scratch.mean[c] = truth[c]; scratch.variance[c] = (config.privilegedSigma[c] ?? 0.03) ** 2 / config.fade; }
  return scratch;
}

/** The camera's output as a cue, with the floor and temperature applied. */
export function visionCue(mean: ArrayLike<number>, variance: ArrayLike<number>, config: FusionConfig, scratch: { mean: Float32Array; variance: Float32Array }): Cue {
  for (let c = 0; c < scratch.mean.length; c += 1) { scratch.mean[c] = mean[c]; scratch.variance[c] = Math.max(config.visionFloor, variance[c] * config.visionTemperature); }
  return scratch;
}

/**
 * The schedule used when "fading out the feeling": full trust early, none at the end,
 * on a log scale so each step removes the same *factor* of precision.
 */
export function fadeSchedule(progress: number, floor = 1e-3): number {
  const t = Math.min(1, Math.max(0, progress));
  return t >= 1 ? 0 : Math.pow(floor, t);
}
