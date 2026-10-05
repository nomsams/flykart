import { RoomMemory } from '../robot/memory';
import { visualFeatures } from '../robot/vision-workbench';
// The whole nervous system for one tick:
//
//   camera -> vision net -> estimates (+ variance) ─┐
//   privileged "feeling" channels (optional) ───────┼─> cue fusion -> 17 inputs -> spiking controller -> action
//   lap memory (Kenyon cells, optional) ────────────┘                 ↑
//   body feedback + mission values (speed, last commands, goal) ──────┘
import { Action, STEP, SpikingNetwork } from "../core";
import type { Domain, VisionEpisode } from "./domain";
import { trackDomain } from "./domains";
import { Cue, FusionConfig, Fused, createFused, defaultFusion, fuseCues, privilegedCue, visionCue } from "./fusion";
import { MushroomBody } from "./memory";
import { Perceiver, Perception, VISION_STRIDE } from "./perception";
import { VisionEnsemble } from "./ensemble";
import type { RacingSettings } from "./racing-settings";
import { assembleInputs } from "./inputs";

/**
 * belief          - fuse the cues first, then decide once (the recommended design)
 * action-average  - run a feeling-only brain and a vision-only brain and average their actions (the naive design, kept for comparison)
 * vision-action   - ignore the controller and use the camera network's own guess at the action
 */
export type DriverMode = "belief" | "action-average" | "vision-action";

export type DriverOptions = {
  /** Deployment rehearsal: require pixels and exclude privileged cues, goal coordinates and pose-indexed lap memory. */
  sensorOnly?: boolean;
  /** Explicit goal compass/localization cue; rewards and collision labels remain excluded. */
  missionCue?: boolean;
  roomMemory?: RoomMemory | null;
  visual?: RacingSettings["visual"]; resolution?: RacingSettings["resolution"];
  perceiver: Perceiver | null;
  controller: SpikingNetwork;
  domain?: Domain;
  fusion?: Partial<FusionConfig>;
  mode?: DriverMode;
  memory?: MushroomBody | null;
  learnMemory?: boolean;
  /** Give the controller no information about the surroundings at all (all estimates zero): the baseline that shows how much the walls alone achieve. */
  blind?: boolean;
  /** Ignore the sonar even if the controller has sonar inputs (they are fed zeros): the camera-only control. */
  sonarOff?: boolean;
  /** Needed by "action-average": a second controller that reads the privileged channels only. */
  feelingController?: SpikingNetwork | null;
};

export type DriverFrame = {
  action: Action;
  /** The 17 numbers the controller was given. */
  sensors: number[];
  /** True on ticks where the camera network ran. */
  seen: boolean;
  perception: Perception | null;
  fused: Fused;
  /** Share of precision supplied by [camera, feeling, memory] for each estimate. */
  weights: Float32Array[];
};

export class VisionDriver {
  readonly options: DriverOptions;
  readonly ensemble: VisionEnsemble | null;
  readonly domain: Domain;
  fusion: FusionConfig;
  mode: DriverMode;
  readonly fused: Fused;
  readonly sensors: number[];
  perception: Perception | null = null;
  /** The lap memory's opinion at the last camera frame (null when it has nothing to say). */
  memoryCue: { mean: Float32Array; variance: Float32Array } | null = null;
  private readonly visionScratch: { mean: Float32Array; variance: Float32Array };
  private readonly feelingScratch: { mean: Float32Array; variance: Float32Array };
  private readonly memoryScratch: { mean: Float32Array; variance: Float32Array };
  private readonly provisional: Fused;
  private readonly feelingSensors: number[];
  private lastGates = 0; private sinceGate = 0;
  private started = false;

  constructor(options: DriverOptions) {
    if(options.sensorOnly&&(!options.perceiver||options.mode==='action-average'))throw new Error('Sensor-only driving requires a camera and forbids privileged action averaging.');
    this.options = options;
    this.ensemble = options.perceiver && options.visual ? new VisionEnsemble(options.perceiver, options.visual, options.resolution ?? "native") : null;
    this.domain = options.domain ?? trackDomain;
    const n = this.domain.estimateCount;
    const scratch = () => ({ mean: new Float32Array(n), variance: new Float32Array(n) });
    this.visionScratch = scratch(); this.feelingScratch = scratch(); this.memoryScratch = scratch();
    this.sensors = new Array<number>(options.controller.inputCount).fill(0); this.feelingSensors = new Array<number>(options.controller.inputCount).fill(0);
    this.fused = createFused(3, n); this.provisional = createFused(2, n);
    this.fusion = { ...defaultFusion(n), ...options.fusion };
    this.mode = options.mode ?? "belief";
  }

  /** Begin a new drive. The lap memory, if any, is kept: that is the point of it. */
  reset(): void {
    this.options.controller.reset(); this.options.feelingController?.reset(); this.options.perceiver?.reset();
    this.ensemble?.reset();
    this.perception = null; this.memoryCue = null; this.lastGates = 0; this.sinceGate = 0; this.started = false;
    this.options.memory?.beginLap();
  }

  act(episode: VisionEpisode): DriverFrame {
    const { perceiver, controller, memory } = this.options;
    if(this.options.sensorOnly&&(!perceiver||this.mode==='action-average'))throw new Error('Sensor-only driving cannot enable privileged action averaging or remove its camera.');
    const body = episode.proprioception(); const lap = this.options.sensorOnly?null:episode.lapContext();
    if (lap) {
      if (lap.gate !== this.lastGates) { this.lastGates = lap.gate; this.sinceGate = 0; } else this.sinceGate += Math.abs(lap.speed) * STEP;
      memory?.advance(lap.speed);
    }
    let seen = false;
    const n = this.domain.estimateCount;
    if (this.options.blind) { this.fused.mean.fill(0); this.fused.variance.fill(1); }
    else if (perceiver && (!this.started || episode.tick % VISION_STRIDE === 0)) {
      this.started = true; seen = true;
      this.memoryCue=null;
      const pixels=episode.render();
      this.perception = (this.ensemble ?? perceiver).see(pixels, this.options.sonarOff && body.sonarCloseness !== undefined ? { ...body, sonarCloseness: 0, sonarStrength: 0 } : body);
      const cues: (Cue | null)[] = [visionCue(this.perception.mean, this.perception.variance, this.fusion, this.visionScratch), this.mode === "belief"&&!this.options.sensorOnly&&this.fusion.fade>0 ? privilegedCue(episode.truth(), this.fusion, this.feelingScratch) : null];
      if (memory && lap) {
        fuseCues(cues, this.provisional);
        memory.observe({ gate: lap.gate, sinceGate: this.sinceGate, heading: lap.heading, x: lap.x, y: lap.y, speed: lap.speed }, this.options.learnMemory !== false);
        const remembered = memory.cue(this.memoryScratch);
        cues.push(remembered); this.memoryCue = remembered ? this.memoryScratch : null;
      }
      if(this.options.roomMemory&&this.domain.id==='world'){
        const camera=perceiver.model.spec;
        const image=this.ensemble?.frames[0]??pixels;
        const recall=this.options.roomMemory.observe(visualFeatures(image,camera.width,camera.height),this.perception.mean,this.options.learnMemory!==false);
        if(recall){this.memoryScratch.mean.set(recall);for(let i=0;i<n;i++)this.memoryScratch.variance[i]=Math.max(.04,this.perception.variance[i]*2);cues.push(this.memoryScratch);this.memoryCue=this.memoryScratch;}
      }
      fuseCues(cues, this.fused);
    } else if (!perceiver) {
      // No camera at all: the controller runs on the privileged channels, exactly like the original FlyKart.
      const truth = episode.truth();
      for (let c = 0; c < n; c += 1) { this.fused.mean[c] = truth[c]; this.fused.variance[c] = 1e-3; }
    }
    const sonar = this.options.sonarOff ? null : episode.sonar();
    assembleInputs(this.domain, this.fused.mean, this.options.sensorOnly&&!this.options.missionCue?[0,0]:episode.mission(), body, sonar, controller.inputCount, this.sensors);
    let action: Action;
    if (this.mode === "vision-action" && this.perception) {
      const [steer, drive, reverse] = this.perception.action;
      const gate = Math.max(0, Math.min(1, (reverse - 0.25) / 0.75));
      action = { steer: Math.max(-1, Math.min(1, steer)), throttle: gate > 0 ? 0 : Math.max(0, Math.min(1, drive)), brake: Math.max(0, Math.min(1, -drive)), reverse: gate };
      controller.step(this.sensors); // keep its state warm so switching modes is seamless
    } else {
      action = controller.step(this.sensors);
      if (this.mode === "action-average" && this.options.feelingController) {
        const feeling = this.options.feelingController.step(assembleInputs(this.domain, episode.truth(), episode.mission(), body, sonar, this.options.feelingController.inputCount, this.feelingSensors));
        const w = Math.max(0, Math.min(1, this.fusion.fade));
        action = { steer: feeling.steer * w + action.steer * (1 - w), throttle: feeling.throttle * w + action.throttle * (1 - w), brake: feeling.brake * w + action.brake * (1 - w), reverse: (feeling.reverse ?? 0) * w + (action.reverse ?? 0) * (1 - w) };
      }
    }
    return { action, sensors: this.sensors, seen, perception: this.perception, fused: this.fused, weights: this.fused.weights };
  }
}
