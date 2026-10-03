// Training and testing the controller through an imperfect interface.
//
// The controller (a SpikingNetwork) never sees the simulator directly here:
// it sees the 13 camera-style estimates after they have been delayed, biased
// and noised by an EstimateCorruptor, then converted back to its 17 inputs.
// A controller that drives well through this is one a vision network can
// plausibly feed.
import { Action, RewardConfig, RoadObjectKind, SpikingNetwork, TrackRef } from "../core";
import { EstimateCorruptor, NO_NOISE, NoiseSpec, sensorsFromEstimates } from "./interface";
import { TrackEpisode } from "./episode";
import { mulberry32 } from "./rng";

export type RobustEpisodeSpec = {
  track: TrackRef;
  noise: NoiseSpec;
  rivals: number; roadObjects: number; objectKind: RoadObjectKind | "mixed";
  seed: number;
  maxTicks: number;
  physicsVariation?: number;
  rewardConfig?: RewardConfig;
  /** Starting point other than the line, to see recoveries. */
  placement?: { distance: number; lateral?: number; headingOffset?: number; speed?: number };
};

export type EpisodeSummary = { track: string; progress: number; finished: boolean; crashed: boolean; ticks: number; fitness: number; collisions: number; offTrackTicks: number; meanSpeed: number };

export function runRobustEpisode(network: SpikingNetwork, spec: RobustEpisodeSpec): EpisodeSummary {
  const episode = new TrackEpisode({ track: spec.track, headless: true, rivals: spec.rivals, roadObjects: spec.roadObjects, objectKind: spec.objectKind, seed: spec.seed, maxTicks: spec.maxTicks, physicsVariation: spec.physicsVariation, rewardConfig: spec.rewardConfig });
  if (spec.placement) episode.placeAt(spec.placement);
  const car = episode.car; car.network = network; network.reset();
  const corruptor = new EstimateCorruptor(spec.noise, mulberry32(spec.seed * 31 + 7));
  const estimates = new Array(13).fill(0); const sensors = new Array(17).fill(0);
  let speedSum = 0;
  while (!episode.done) {
    const truth = episode.truth();
    const noisy = spec.noise === NO_NOISE ? truth : corruptor.apply(truth, estimates);
    const action: Action = network.step(sensorsFromEstimates(noisy, episode.proprioception(), sensors));
    episode.step(action);
    speedSum += car.speed;
  }
  return { track: episode.route.id, progress: car.totalProgress, finished: car.finished, crashed: car.crashed, ticks: car.ticks, fitness: car.score, collisions: car.collisions, offTrackTicks: car.offTrackTicks, meanSpeed: speedSum / Math.max(1, car.ticks) };
}

/** Collapse a batch of episodes into one number evolution can rank: laps first, then coverage, with the weakest quarter weighted in. */
export function robustScore(results: EpisodeSummary[], finishWeight = 1): number {
  if (results.length === 0) return 0;
  const progress = results.map((r) => r.progress + (r.finished ? finishWeight : 0)).sort((a, b) => a - b);
  const mean = progress.reduce((s, v) => s + v, 0) / progress.length;
  const tail = Math.max(1, Math.ceil(progress.length / 4));
  const worst = progress.slice(0, tail).reduce((s, v) => s + v, 0) / tail;
  const reward = results.reduce((s, r) => s + r.fitness, 0) / results.length;
  const speed = results.filter((r) => r.finished).reduce((s, r) => s + 1500 / Math.max(300, r.ticks), 0) / results.length;
  return 0.7 * mean + 0.3 * worst + 0.15 * speed + 0.00005 * reward;
}
