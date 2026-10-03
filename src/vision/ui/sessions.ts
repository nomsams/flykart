// A running drive: the simulation, the driver and the little bits of history the dashboards plot.
import { Action, BrainSnapshot, SpikingNetwork, TRACKS, TrackDefinition } from "../../core";
import { trackDomain, worldDomain } from "../domains";
import { TrackEpisode } from "../episode";
import { ESTIMATE_NAMES } from "../interface";
import { MushroomBody } from "../memory";
import { Perceiver, VisionModel } from "../perception";
import { DriverMode, VisionDriver } from "../pipeline";
import { WORLD_CAMERA, WorldEpisode, worldExpert } from "../world/worldDomain";
import { SECTORS } from "../world/world";
import type { SonarSample, TraceSample } from "./draw";
import { CM_PER_PIXEL, SensorProfile } from "../robot";

export type TrackSettings = {
  trackId: string; rivals: number; objects: number; style: number; walls: boolean;
  controller: BrainSnapshot; vision: VisionModel | null; fade: number; mode: DriverMode; memory: MushroomBody | null;
  seed: number;
  /** Sensor head. Omitted means the camera-only kart. */
  profile?: SensorProfile; sonarOn?: boolean;
};

const FAR = ESTIMATE_NAMES.indexOf("curveFar");
/** The four road-geometry estimates the lap memory supplies. */
const GEOMETRY = ["headingError", "curvature", "curveNear", "curveFar"].map((name) => ESTIMATE_NAMES.indexOf(name as never));

export type LapRecord = { lap: number; finished: boolean; seconds: number; progress: number; offRoad: number; memoryError: number | null; errorCamera: number; errorUsed: number; remembering: boolean };

export class TrackSession {
  readonly route: TrackDefinition;
  readonly episode: TrackEpisode;
  readonly driver: VisionDriver;
  readonly controller: SpikingNetwork;
  readonly perceiver: Perceiver | null;
  readonly trace: TraceSample[] = [];
  readonly sonarTrace: SonarSample[] = [];
  lastTruth: number[] = new Array(13).fill(0);
  private cameraErrorSum = 0; private usedErrorSum = 0; private errorCount = 0;

  constructor(readonly settings: TrackSettings) {
    this.route = TRACKS.find((track) => track.id === settings.trackId) ?? TRACKS[0];
    this.controller = SpikingNetwork.fromJSON(settings.controller);
    this.perceiver = settings.vision ? new Perceiver(settings.vision) : null;
    this.episode = new TrackEpisode({ track: this.route, rivals: settings.rivals, roadObjects: settings.objects, objectKind: "mixed", seed: settings.seed, styleStrength: settings.style, walls: settings.walls, maxTicks: 7000, headless: false, profile: settings.profile });
    this.episode.car.network = this.controller;
    this.driver = new VisionDriver({
      perceiver: this.perceiver, controller: this.controller, domain: trackDomain, mode: settings.mode, fusion: { fade: settings.fade },
      memory: this.perceiver ? settings.memory : null, feelingController: this.controller.clone(), sonarOff: settings.sonarOn === false,
    });
    this.driver.reset();
    this.lastTruth = this.episode.truth();
    this.episode.render();
  }

  get done(): boolean { return this.episode.done; }

  step(): void {
    const frame = this.driver.act(this.episode);
    if (frame.seen && frame.perception) {
      const truth = this.episode.truth(this.lastTruth);
      const memory = this.driver.memoryCue;
      this.trace.push({ truth: truth[FAR], camera: frame.perception.mean[FAR], memory: memory && memory.variance[FAR] < 1e5 ? memory.mean[FAR] : null, used: frame.fused.mean[FAR] });
      if (this.trace.length > 240) this.trace.shift();
      for (const c of GEOMETRY) { this.cameraErrorSum += Math.abs(frame.perception.mean[c] - truth[c]); this.usedErrorSum += Math.abs(frame.fused.mean[c] - truth[c]); }
      this.errorCount += GEOMETRY.length;
    }
    this.episode.step(frame.action);
    const reading = this.episode.sonar();
    if (reading) { this.sonarTrace.push({ cm: reading.range * CM_PER_PIXEL, echo: reading.echo, strength: reading.strength }); if (this.sonarTrace.length > 240) this.sonarTrace.shift(); }
  }

  lap(lapNumber: number): LapRecord {
    const car = this.episode.car; const memory = this.settings.memory;
    return {
      lap: lapNumber, finished: car.finished, seconds: car.ticks / 30, progress: car.totalProgress, offRoad: car.offTrackTicks / Math.max(1, car.ticks),
      memoryError: memory && this.perceiver ? memory.stats.lapAbsError : null,
      errorCamera: this.cameraErrorSum / Math.max(1, this.errorCount), errorUsed: this.usedErrorSum / Math.max(1, this.errorCount), remembering: Boolean(memory && memory.remembering),
    };
  }
}

export type WorldDriverKind = "vision" | "both" | "feeling" | "expert" | "blind";
export type WorldSettings = { seed: number; density: number; style: number; kind: WorldDriverKind; fade: number; controller: BrainSnapshot; vision: VisionModel | null; profile?: SensorProfile; sonarOn?: boolean };

export class WorldSession {
  readonly episode: WorldEpisode;
  readonly controller: SpikingNetwork;
  readonly driver: VisionDriver | null;
  lastTruth: number[] = new Array(SECTORS + 1).fill(0);
  lastAction: Action = { steer: 0, throttle: 0, brake: 0, reverse: 0 };

  constructor(readonly settings: WorldSettings) {
    this.controller = SpikingNetwork.fromJSON(settings.controller);
    this.episode = new WorldEpisode({ seed: settings.seed, density: settings.density, styleStrength: settings.style, camera: WORLD_CAMERA, maxTicks: 4200, profile: settings.profile });
    const needsEyes = settings.kind === "vision" || settings.kind === "both";
    const perceiver = needsEyes && settings.vision ? new Perceiver(settings.vision) : null;
    this.driver = settings.kind === "expert" ? null : new VisionDriver({
      perceiver, controller: this.controller, domain: worldDomain, blind: settings.kind === "blind", mode: "belief", sonarOff: settings.sonarOn === false,
      fusion: { fade: settings.kind === "both" ? settings.fade : 0 },
    });
    this.driver?.reset();
    this.lastTruth = this.episode.truth();
    this.episode.render();
  }

  get done(): boolean { return this.episode.done; }

  step(): void {
    if (this.driver) {
      const frame = this.driver.act(this.episode);
      this.lastAction = frame.action; this.episode.step(frame.action);
    } else {
      const sensors = worldDomain.sensors(this.episode.truth(this.lastTruth), this.episode.mission(), this.episode.proprioception());
      this.lastAction = worldExpert(sensors); this.episode.step(this.lastAction);
    }
  }
}
