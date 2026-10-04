// Closed-loop evaluation: let a driver actually drive.
import { RoadObjectKind, TrackRef } from "../core";
import type { Style } from "./camera";
import { TrackEpisode } from "./episode";
import { VisionDriver } from "./pipeline";
import { SensorProfile } from "./robot";

export type DriveSpec = {
  track: TrackRef; seed: number;
  rivals?: number; roadObjects?: number; objectKind?: RoadObjectKind | "mixed";
  styleStrength?: number; style?: Style; physicsVariation?: number; maxTicks?: number; walls?: boolean;
  /** Record how far the estimates the controller used were from the truth (costs a little time). */
  measureError?: boolean;
  /** Sensor head: omit for the original camera-only kart. */
  profile?: SensorProfile;
  /** Called every tick with the live episode (for dashboards and tracing). */
  onTick?: (episode: TrackEpisode, driver: VisionDriver) => void;
  /** Called before each tick to change the driver (for example to fade the feeling channels during a lap). */
  beforeTick?: (episode: TrackEpisode, driver: VisionDriver) => void;
};

export type DriveResult = {
  track: string; finished: boolean; crashed: boolean; progress: number; ticks: number; seconds: number;
  offTrackShare: number; meanAbsLateral: number; collisions: number; meanSpeed: number;
  /** Mean absolute error of the estimates the controller used, per estimate (if measured). */
  estimateError?: number[];
};

export function driveEpisode(driver: VisionDriver, spec: DriveSpec): DriveResult {
  const episode = new TrackEpisode({
    track: spec.track, seed: spec.seed, rivals: spec.rivals, roadObjects: spec.roadObjects, objectKind: spec.objectKind ?? "mixed",
    styleStrength: spec.styleStrength ?? 0, style: spec.style, physicsVariation: spec.physicsVariation, maxTicks: spec.maxTicks ?? 4500, walls: spec.walls, headless: driver.options.perceiver === null, profile: spec.profile,
  });
  episode.car.network = driver.options.controller;
  driver.reset();
  let lateral = 0, speed = 0; let samples = 0;
  const error = spec.measureError ? new Array(driver.domain.estimateCount).fill(0) : null;
  while (!episode.done) {
    spec.beforeTick?.(episode, driver);
    const frame = driver.act(episode);
    if (error && frame.seen) { const truth = episode.truth(); for (let c = 0; c < error.length; c += 1) error[c] += Math.abs(frame.fused.mean[c] - truth[c]); samples += 1; }
    episode.step(frame.action);
    lateral += Math.abs(episode.car.lateralOffset); speed += episode.car.speed;
    spec.onTick?.(episode, driver);
  }
  const car = episode.car; const ticks = Math.max(1, car.ticks);
  return {
    track: episode.route.id, finished: car.finished, crashed: car.crashed, progress: car.totalProgress, ticks: car.ticks, seconds: car.ticks / 30,
    offTrackShare: car.offTrackTicks / ticks, meanAbsLateral: lateral / ticks, collisions: car.collisions, meanSpeed: speed / ticks,
    ...(error ? { estimateError: error.map((v) => v / Math.max(1, samples)) } : {}),
  };
}

export type Summary = { episodes: number; laps: number; crashes: number; meanProgress: number; meanLapSeconds: number | null; meanOffTrack: number; collisions: number; meanAbsLateral: number };

export function summarise(results: DriveResult[]): Summary {
  const laps = results.filter((r) => r.finished);
  return {
    episodes: results.length, laps: laps.length, crashes: results.filter((r) => r.crashed).length, meanProgress: results.reduce((s, r) => s + r.progress, 0) / Math.max(1, results.length),
    meanLapSeconds: laps.length ? laps.reduce((s, r) => s + r.seconds, 0) / laps.length : null, meanOffTrack: results.reduce((s, r) => s + r.offTrackShare, 0) / Math.max(1, results.length), collisions: results.reduce((s, r) => s + r.collisions, 0),
    meanAbsLateral: results.reduce((s, r) => s + r.meanAbsLateral, 0) / Math.max(1, results.length),
  };
}

export const formatSummary = (s: Summary): string => `${s.laps}/${s.episodes} laps, ${(s.meanProgress * 100).toFixed(0)}% progress${s.meanLapSeconds ? `, ${s.meanLapSeconds.toFixed(0)}s per lap` : ""}, off-road ${(s.meanOffTrack * 100).toFixed(1)}%${s.crashes ? `, ${s.crashes} crashes` : ""}`;
