// One drive on a track: the unchanged FlyKart physics (stepCar), plus a camera
// and the ground-truth numbers that a camera network should learn to estimate.
import {
  Car, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, PhysicsConfig, RewardConfig, RoadObjectKind, STEP, TrackDefinition,
  TrackRef, Action, clamp, createRoadObstacles, heuristicAction, nearestTrack, physicsForEpisode, pointAtDistance, resolveTrack, sensorValues, startLine, startPosition, stepCar, trackCheckpoint, wrapAngle,
} from "../core";
import type { VisionEpisode } from "./domain";
import { CameraConfig, DEFAULT_CAMERA, Style, DEFAULT_STYLE, frameLength, randomStyle, renderFrame } from "./camera";
import { ESTIMATE_COUNT, Proprioception, estimatesFromSensors } from "./interface";
import { Random, mulberry32 } from "./rng";
import { registerTrack } from "./proceduralTracks";
import { SONAR_USEFUL_RANGE_PX, SensorProfile } from "./robot";
import { Sonar, SonarReading, SonarTarget, sonarInputs } from "./sonar";
import { TrackScene } from "./trackScene";

export type TrackEpisodeOptions = {
  track: TrackRef;
  /** 0, 1 or 2 heuristic rival karts that start just ahead of the kart. */
  rivals?: number;
  roadObjects?: number; objectKind?: RoadObjectKind | "mixed";
  seed?: number;
  /** 0 = canonical colours, 1 = fully randomised look. */
  styleStrength?: number;
  /** An exact look, overriding `styleStrength` (for example a dark, noisy camera). */
  style?: Style;
  /** Fractional grip / engine / steering variation, as in the simulator's domain randomisation. */
  physicsVariation?: number;
  maxTicks?: number;
  camera?: CameraConfig;
  /** The sensor head: camera geometry, sonar, gantry height. Overrides `camera`. Default: the original kart (camera only). */
  profile?: SensorProfile;
  /** Skip building a scene (faster) when only numbers are needed. */
  headless?: boolean;
  rewardConfig?: RewardConfig;
  /** Road-side walls (the simulator default). Without them, a kart that leaves the road really is lost, which is a much stricter test of perception. */
  walls?: boolean;
  lapTarget?: number; impactPain?: boolean; checkpointCount?: number;
  cameraNoise?:number; cameraBrightness?:number;
};

export type Placement = { distance: number; lateral?: number; headingOffset?: number; speed?: number };

/** How wide a view the camera has, for deciding what counts as visible. */
const VISIBLE_RANGE = 180;

export type VisibleThing = { distance: number; forward: number; side: number; relativeSpeed: number; isObstacle: boolean };

export function nearestVisible(car: Car, cars: Car[], hfov: number): VisibleThing | null {
  const fx = Math.cos(car.heading), fy = Math.sin(car.heading); const sx = -fy, sy = fx;
  const limit = Math.cos(hfov / 2 + 0.12);
  let best: VisibleThing | null = null;
  for (const other of cars) {
    if (other === car || other.crashed || other.finished || other.timedOut || other.eliminated || other.trackId !== car.trackId) continue;
    const dx = other.position.x - car.position.x, dy = other.position.y - car.position.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-6 || distance > VISIBLE_RANGE) continue;
    const forward = (dx * fx + dy * fy) / distance;
    if (forward < limit) continue;
    if (!best || distance < best.distance) best = { distance, forward, side: (dx * sx + dy * sy) / distance, relativeSpeed: (other.speed - car.speed) / 90, isObstacle: other.isObstacle };
  }
  return best;
}

export class TrackEpisode implements VisionEpisode {
  readonly route: TrackDefinition;
  readonly car: Car;
  readonly rivals: Car[] = [];
  readonly roadObjects: Car[] = [];
  readonly cars: Car[];
  readonly camera: CameraConfig;
  readonly scene: TrackScene | null;
  readonly style: Style;
  readonly random: Random;
  readonly frame: Float32Array;
  physics: PhysicsConfig;
  readonly rewardConfig: RewardConfig;
  tick = 0;
  /** The sonar, if this robot has one. It has its own random stream so the camera's noise is unaffected. */
  readonly sonarUnit: Sonar | null;
  private lastSensors: number[] | null = null;
  private lastSensorTick = -1;

  constructor(readonly options: TrackEpisodeOptions) {
    // The physics looks tracks up by id, so a track passed as an object (a generated one) is registered first.
    this.route = resolveTrack(typeof options.track === "string" ? options.track : registerTrack(options.track));
    const seed = options.seed ?? 1;
    this.random = mulberry32(seed * 7919 + 13);
    this.camera = options.profile?.camera ?? options.camera ?? DEFAULT_CAMERA;
    this.style = options.style ? options.style : (options.styleStrength ?? 0) > 0 ? randomStyle(this.random, options.styleStrength ?? 0) : { ...DEFAULT_STYLE };
    if(options.cameraNoise!==undefined)this.style.noise=clamp(this.style.noise+options.cameraNoise,0,.2);
    if(options.cameraBrightness!==undefined)this.style.brightness*=clamp(options.cameraBrightness,.1,2);
    this.scene = options.headless ? null : new TrackScene(this.route, this.style, options.checkpointCount ?? 8, options.profile?.gantry);
    this.frame = new Float32Array(options.headless ? 0 : frameLength(this.camera));
    this.rewardConfig = options.rewardConfig ?? DEFAULT_REWARD_CONFIG;
    this.physics = physicsForEpisode({ ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: false, wallsEnabled: options.walls ?? true, lapTarget: options.lapTarget, impactPain: options.impactPain, checkpointCount: options.checkpointCount ?? 8, domainRandomization: options.physicsVariation ?? 0 }, seed, this.route);
    this.car = startPosition(0, this.route);
    this.car.timeLimit = (options.maxTicks ?? 4500) * Math.max(1, Math.min(5, Math.floor(options.lapTarget ?? 1)));
    this.car.name = "vision kart"; this.car.color = "#ffd166";
    const line = startLine(this.route);
    const count = Math.max(0, Math.min(2, Math.floor(options.rivals ?? 0)));
    for (let i = 0; i < count; i += 1) {
      const bot = startPosition(i === 0 ? -1 : 1, this.route);
      bot.position = { x: bot.position.x + line.tangent.x * (55 + 60 * i), y: bot.position.y + line.tangent.y * (55 + 60 * i) };
      bot.name = `rival ${i + 1}`; bot.timeLimit = Number.MAX_SAFE_INTEGER;
      this.rivals.push(bot);
    }
    this.roadObjects.push(...createRoadObstacles(options.roadObjects ?? 0, this.route, seed, options.objectKind ?? "mixed"));
    this.cars = [this.car, ...this.rivals, ...this.roadObjects];
    this.sonarUnit = options.profile?.sonar ? new Sonar(options.profile.sonar, mulberry32(seed * 104729 + 7)) : null;
    this.ping();
  }

  sonar(): SonarReading | null { return this.sonarUnit ? this.sonarUnit.reading : null; }

  /** What a ping could bounce off right now: other karts, cones, barriers. Paint, kerbs and oil are flat on the floor and invisible to it. */
  sonarTargets(): SonarTarget[] {
    const targets: SonarTarget[] = [];
    for (const other of this.cars) {
      if (other === this.car || other.crashed || other.finished || other.timedOut || other.eliminated) continue;
      const kind = other.isObstacle ? other.obstacleKind : "kart";
      if (kind === "oil") continue;
      const { x, y } = other.position;
      if (kind === 'wall') targets.push({ kind:'box',x,y,heading:other.heading,halfLength:4,halfWidth:19,z0:0,z1:40 });
      else if (kind === 'bush') targets.push({ kind:'circle',x,y,radius:12,z0:0,z1:28 });
      else if (kind === "cone") targets.push({ kind: "circle", x, y, radius: 3, z0: 0, z1: 10 });
      else if (kind === "barrier") targets.push({ kind: "box", x, y, heading: other.heading + Math.PI / 2, halfLength: 19, halfWidth: 3.5, z0: 0, z1: 9 });
      else targets.push({ kind: "box", x, y, heading: other.heading, halfLength: 12, halfWidth: 7, z0: 0, z1: 9 });
    }
    return targets;
  }

  /** Take a sonar reading if one is due this tick. */
  private ping(): void {
    if (this.sonarUnit) this.sonarUnit.update(this.tick, { x: this.car.position.x, y: this.car.position.y, heading: this.car.heading }, this.sonarTargets());
  }

  /** Take a reading now, whatever the ping cycle says (after objects have been moved by hand). */
  refreshSonar(): void {
    if (this.sonarUnit) this.sonarUnit.update(this.tick, { x: this.car.position.x, y: this.car.position.y, heading: this.car.heading }, this.sonarTargets(),true);
  }

  /** Put the kart somewhere other than the start line (for diverse training data). */
  placeAt(placement: Placement): void {
    const route = this.route; const car = this.car;
    const sample = pointAtDistance(placement.distance, route); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
    const offset = (placement.lateral ?? 0) * route.width / 2;
    car.position = { x: sample.point.x + normal.x * offset, y: sample.point.y + normal.y * offset };
    car.heading = Math.atan2(sample.tangent.y, sample.tangent.x) + (placement.headingOffset ?? 0);
    car.speed = placement.speed ?? 0; car.steering = 0;
    const near = nearestTrack(car.position, route);
    car.progress = near.progress; car.distanceAlong = near.distanceAlong; car.totalProgress = near.progress; car.netProgress = near.progress; car.bestProgress = near.progress;
    car.progressWindowStart = near.progress; car.rewardWindowProgressStart = near.progress;
    const gates=this.physics.checkpointCount??8;
    car.nextCheckpoint = (Math.floor(near.progress * gates) + 1) % gates;
    // Anything that starts behind or on top of the kart would be an unfair hit; clear the neighbourhood.
    for (const other of [...this.rivals, ...this.roadObjects]) {
      if (Math.hypot(other.position.x - car.position.x, other.position.y - car.position.y) < 60) {
        const ahead = pointAtDistance(near.distanceAlong + 180, route); other.position = { ...ahead.point };
        const n = nearestTrack(other.position, route); other.progress = n.progress; other.distanceAlong = n.distanceAlong;
      }
    }
    this.lastSensorTick = -1;
    this.refreshSonar();
  }

  get done(): boolean { const car = this.car; return car.crashed || car.finished || car.timedOut || car.eliminated; }

  /** The 17 numbers the simulator hands the original controller. */
  privileged(): number[] {
    if (this.lastSensors && this.lastSensorTick === this.tick) return this.lastSensors;
    this.lastSensors = sensorValues(this.car, this.cars, this.route, this.physics.checkpointCount); this.lastSensorTick = this.tick;
    return this.lastSensors;
  }

  /** What the kart's own body reports: speed and its last commands. Cheap, and not privileged information. */
  proprioception(): Proprioception {
    const car = this.car;
    const body: Proprioception = { speed: clamp(car.speed / 90, -1, 1), lastSteer: clamp(car.action.steer, -1, 1), lastDrive: clamp(car.action.throttle - car.action.brake, -1, 1) };
    if (this.sonarUnit) { const pair = sonarInputs(this.sonarUnit.reading, SONAR_USEFUL_RANGE_PX); body.sonarCloseness = pair[0]; body.sonarStrength = pair[1]; }
    return body;
  }

  /** What the camera should report, in the 13-number estimate space. Traffic is limited to what a forward camera can see. */
  truth(out: number[] = new Array(ESTIMATE_COUNT).fill(0)): number[] {
    const car = this.car; const sensors = this.privileged();
    const closest = nearestTrack(car.position, this.route, car.ticks > 0 ? car.distanceAlong : undefined, car.speed < -0.5 ? -1 : 1);
    const roadAngle = wrapAngle(Math.atan2(closest.tangent.y, closest.tangent.x) - car.heading) / Math.PI;
    estimatesFromSensors(sensors, clamp(roadAngle, -1, 1), out);
    const seen = nearestVisible(car, this.cars, this.camera.hfov);
    if (seen) { out[8] = seen.distance < 180 ? 1 - seen.distance / 180 : 0; out[9] = seen.distance < 180 ? clamp(seen.side, -1, 1) : 0; out[10] = clamp(seen.forward, -1, 1); out[11] = clamp(seen.relativeSpeed, -1, 1); out[12] = seen.isObstacle ? 1 : 0; }
    else { out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0; out[12] = 0; }
    return out;
  }

  mission(): number[] { return []; }
  lapContext(): { gate: number; heading: number; x: number; y: number; speed: number } { return { gate: this.car.checkpointsPassed, heading: this.car.heading, x: this.car.position.x, y: this.car.position.y, speed: this.car.speed }; }
  summary(): { progress: number; finished: boolean; crashed: boolean } { return { progress: this.car.totalProgress, finished: this.car.finished, crashed: this.car.crashed }; }

  /** Render the camera view into `this.frame` (and return it). */
  render(): Float32Array {
    if (!this.scene) throw new Error("this episode was created headless");
    this.scene.setTraffic(this.cars, this.car);
    return renderFrame(this.scene, { x: this.car.position.x, y: this.car.position.y, heading: this.car.heading }, this.camera, this.frame, this.random);
  }

  /** Advance one tick: rivals decide first so every kart sees the same world. */
  step(action: Action): void {
    const botActions = this.rivals.map((bot) => heuristicAction(bot, this.cars, this.route, this.physics.checkpointCount));
    stepCar(this.car, action, this.cars, this.route, this.rewardConfig, this.physics);
    this.rivals.forEach((bot, index) => stepCar(bot, botActions[index], this.cars, this.route, this.rewardConfig, { ...this.physics, ruthlessCulling: false }));
    this.tick += 1;
    this.ping();
  }

  get seconds(): number { return this.tick * STEP; }
  get progress(): number { return this.car.totalProgress; }
  /** Gate the kart is heading for, as a world point (for overlays). */
  nextGate(): { x: number; y: number } { const n=this.physics.checkpointCount??8;return trackCheckpoint(this.car.nextCheckpoint % n, this.route, n).point; }
}
