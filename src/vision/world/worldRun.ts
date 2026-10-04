// Headless runs of the open world, for training and testing the controller
// through exact or deliberately degraded estimates.
import { SpikingNetwork } from "../../core";
import { EstimateCorruptor, NO_NOISE, NoiseSpec } from "../interface";
import { mulberry32 } from "../rng";
import type { VisionDriver } from "../pipeline";
import { assembleInputs } from "../inputs";
import { SensorProfile, profileById } from "../robot";
import { WorldEpisode, worldDomain, worldExpert } from "./worldDomain";

export type WorldRunSpec = { seed: number; density?: number; maxTicks?: number; noise?: NoiseSpec; /** Sensor head by id (so the spec crosses to a worker thread as plain data). */ profile?: "kart" | "robot" };
export type WorldRunResult = { seed: number; goals: number; collisions: number; crashed: boolean; crashReason?: string; score: number; ticks: number };

export function runWorldEpisode(network: SpikingNetwork | "expert", spec: WorldRunSpec): WorldRunResult {
  const episode = new WorldEpisode({ seed: spec.seed, density: spec.density, maxTicks: spec.maxTicks ?? 1800, headless: true, profile: profileById(spec.profile) });
  const noise = spec.noise ?? NO_NOISE;
  const corruptor = new EstimateCorruptor(noise, mulberry32(spec.seed * 17 + 1), worldDomain.noiseScale);
  if (network !== "expert") network.reset();
  const noisy = new Array(worldDomain.estimateCount).fill(0); const sensors = new Array(network === "expert" ? 17 : network.inputCount).fill(0);
  while (!episode.done) {
    const truth = episode.truth();
    const estimates = noise.white + noise.correlated + noise.bias + noise.delayTicks === 0 ? truth : corruptor.apply(truth, noisy);
    assembleInputs(worldDomain, estimates, episode.mission(), episode.proprioception(), episode.sonar(), sensors.length, sensors);
    episode.step(network === "expert" ? worldExpert(sensors) : network.step(sensors));
  }
  const { status } = episode.sim;
  return { seed: spec.seed, goals: status.goals, collisions: status.collisions, crashed: status.crashed, crashReason: status.crashReason, score: status.score, ticks: status.ticks };
}

/** Goals first, then staying alive and tidy. */
export function worldScore(results: WorldRunResult[]): number {
  if (results.length === 0) return 0;
  const goals = results.reduce((s, r) => s + r.goals, 0) / results.length;
  const crashes = results.filter((r) => r.crashed).length / results.length;
  const collisions = results.reduce((s, r) => s + r.collisions, 0) / results.length;
  const score = results.reduce((s, r) => s + r.score, 0) / results.length;
  return goals * 10 - crashes * 14 - collisions * 0.8 + score * 0.01;
}

export { NO_NOISE };

export type WorldDriveSpec = { seed: number; density?: number; maxTicks?: number; styleStrength?: number; profile?: SensorProfile; onTick?: (episode: WorldEpisode, driver: VisionDriver) => void };

/** Let a vision driver (camera, fusion, controller) drive a world. */
export function driveWorldEpisode(driver: VisionDriver, spec: WorldDriveSpec): WorldRunResult {
  const episode = new WorldEpisode({ seed: spec.seed, density: spec.density, maxTicks: spec.maxTicks ?? 1800, styleStrength: spec.styleStrength ?? 0, headless: driver.options.perceiver === null, profile: spec.profile });
  driver.reset();
  while (!episode.done) {
    const frame = driver.act(episode);
    episode.step(frame.action);
    spec.onTick?.(episode, driver);
  }
  const { status } = episode.sim;
  return { seed: spec.seed, goals: status.goals, collisions: status.collisions, crashed: status.crashed, crashReason: status.crashReason, score: status.score, ticks: status.ticks };
}
