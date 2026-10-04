// The two worlds FlyKart Vision knows how to drive in.
import type { Domain } from "./domain";
import { ESTIMATE_COUNT, ESTIMATE_LABELS, ESTIMATE_NAMES, MIRROR_SIGN, NOISE_SCALE, sensorsFromEstimates } from "./interface";
import { worldDomain } from "./world/worldDomain";

export const trackDomain: Domain = {
  id: "track", title: "Race track",
  estimateNames: ESTIMATE_NAMES, estimateLabels: ESTIMATE_NAMES.map((name) => ESTIMATE_LABELS[name]), estimateCount: ESTIMATE_COUNT,
  noiseScale: NOISE_SCALE,
  trainingWeights: ESTIMATE_NAMES.map((name) => (name.startsWith("traffic") || name === "obstacle" || name === "closingSpeed" ? 1.5 : 1)),
  sensors(estimates, _mission, body, out) { return sensorsFromEstimates(estimates, body, out); },
  mirror(estimates, out) { for (let i = 0; i < ESTIMATE_COUNT; i += 1) out[i] = estimates[i] * MIRROR_SIGN[i]; },
};

export { worldDomain };
export const domains: Record<string, Domain> = { track: trackDomain, world: worldDomain };
