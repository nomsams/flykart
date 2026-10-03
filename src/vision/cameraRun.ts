// Evolving a controller with the real camera pipeline (and the sonar) in the loop, instead of synthetic noise.
//
// Used by scripts/robust-evolve.ts --eyes=...: each candidate drives whole episodes through the camera network, so it is
// judged on the errors the camera really makes, in the light it really has, with the sonar it really hears.
import { RoadObjectKind, SpikingNetwork, TrackRef } from "../core";
import { DEFAULT_STYLE, Style } from "./camera";
import { trackDomain } from "./domains";
import { driveEpisode } from "./evaluate";
import { Perceiver, VisionModel } from "./perception";
import { VisionDriver } from "./pipeline";
import { EpisodeSummary } from "./robust";
import { profileById } from "./robot";

export type Look = "day" | "night" | "varied";
export type CameraEpisodeSpec = {
  track: TrackRef; seed: number; maxTicks: number;
  rivals: number; roadObjects: number; objectKind: RoadObjectKind | "mixed";
  look: Look; profile?: "kart" | "robot"; physicsVariation?: number;
};

export const NIGHT: Style = { ...DEFAULT_STYLE, brightness: 0.42, contrast: 0.85, noise: 0.1 };

export function runCameraEpisode(network: SpikingNetwork, perceiver: Perceiver, spec: CameraEpisodeSpec): EpisodeSummary {
  const driver = new VisionDriver({ perceiver, controller: network, domain: trackDomain, mode: "belief", fusion: { fade: 0 } });
  const result = driveEpisode(driver, {
    track: spec.track, seed: spec.seed, rivals: spec.rivals, roadObjects: spec.roadObjects, objectKind: spec.objectKind, maxTicks: spec.maxTicks,
    walls: true, physicsVariation: spec.physicsVariation, profile: profileById(spec.profile),
    style: spec.look === "night" ? NIGHT : undefined, styleStrength: spec.look === "varied" ? 0.6 : 0,
  });
  return { track: result.track, progress: result.progress, finished: result.finished, crashed: result.crashed, ticks: result.ticks, fitness: 0, collisions: result.collisions, offTrackTicks: Math.round(result.offTrackShare * result.ticks), meanSpeed: result.meanSpeed };
}

export const perceiverFrom = (model: VisionModel): Perceiver => new Perceiver(model);
