// The open world as a FlyKart Vision domain: the camera estimates what is in
// front of the kart, a compass supplies where the goal is, and the same
// 17 -> 48 -> 4 spiking controller body drives.
//
//   inputs  0 goal bearing   1 goal closeness   2-10 nine clearance sectors across the view
//           11 speed   12 last steer   13 last gas-brake   14 surface ahead
//           15 open heading (the freest direction that is also close to the goal)   16 speed advisory (how fast the view ahead allows going)
//
// Inputs 15 and 16 are small fixed computations on the estimates (the freest direction, and how much to ease off for what is
// ahead): the job the fly's central complex does for its motor system. The spiking controller still has to turn them, with
// the rest, into smooth steering and pedals.
import { Action, clamp, wrapAngle } from "../../core";
import { CameraConfig, DEFAULT_STYLE, Style, frameLength, randomStyle, renderFrame } from "../camera";
import type { Domain, VisionEpisode } from "../domain";
import { Proprioception } from "../interface";
import { Random, mulberry32 } from "../rng";
import { SECTORS, SECTOR_ANGLES, SECTOR_SPAN, SURFACE_VALUE, WorldSim, clearanceScan, surfaceAt } from "./world";
import { WorldScene } from "./worldScene";

export const WORLD_CAMERA: CameraConfig = { width: 48, height: 24, hfov: (104 * Math.PI) / 180, mountHeight: 15, pitch: 0.16, mountForward: 8 };

export const WORLD_ESTIMATE_NAMES = [...Array.from({ length: SECTORS }, (_, k) => `sector${k + 1}`), "surface"] as const;
export const WORLD_ESTIMATE_LABELS = [...Array.from({ length: SECTORS }, (_, k) => `Clearance ${k < 4 ? "left" : k > 4 ? "right" : "centre"} ${k + 1}`), "Surface ahead"] as const;

/** The direction (relative to the heading, radians) that is both open and close to the goal. */
export function openHeading(clearance: ArrayLike<number>, bearing: number): number {
  let best = 0, bestCost = Infinity;
  for (let k = 0; k < SECTORS; k += 1) {
    const blocked = Math.max(clearance[k], 0.7 * (clearance[k - 1] ?? 0), 0.7 * (clearance[k + 1] ?? 0));
    const cost = 1.6 * Math.abs(wrapAngle(SECTOR_ANGLES[k] - bearing)) / Math.PI + 2.4 * Math.pow(Math.max(0, blocked), 1.5) + (clearance[k] > 0.85 ? 3 : 0);
    if (cost < bestCost) { bestCost = cost; best = k; }
  }
  return SECTOR_ANGLES[best];
}

export const worldDomain: Domain = {
  id: "world", title: "Open world",
  estimateNames: WORLD_ESTIMATE_NAMES, estimateLabels: WORLD_ESTIMATE_LABELS, estimateCount: SECTORS + 1,
  noiseScale: [...new Array(SECTORS).fill(1), 0.5],
  trainingWeights: [...new Array(SECTORS).fill(1), 0.6],
  sensors(estimates, mission, body, out = new Array(17).fill(0)) {
    for (let k = 0; k < SECTORS; k += 1) out[2 + k] = clamp(estimates[k], 0, 1);
    out[0] = clamp(mission[0], -1, 1); out[1] = clamp(mission[1], 0, 1);
    out[11] = clamp(body.speed, -1, 1); out[12] = clamp(body.lastSteer, -1, 1); out[13] = clamp(body.lastDrive, -1, 1);
    out[14] = clamp(estimates[SECTORS], -1.5, 1.5);
    const heading = openHeading(out.slice(2, 2 + SECTORS), mission[0] * Math.PI);
    out[15] = clamp(heading / SECTOR_SPAN, -1, 1);
    const front = Math.max(out[5], out[6], out[7]);
    let target = 84 * (1 - 0.88 * Math.pow(front, 1.1)) * (1 - 0.45 * Math.min(1, Math.abs(heading) / 0.5));
    if (out[1] > 0.9) target *= 0.55;
    if (out[14] < 0) target *= 0.8;
    out[16] = clamp(target / 90, 0, 1);
    return out;
  },
  mirror(estimates, out) { for (let k = 0; k < SECTORS; k += 1) out[k] = estimates[SECTORS - 1 - k]; out[SECTORS] = estimates[SECTORS]; },
};

/** A hand-written driver that reads the same 17 numbers: the teacher the controller is first taught from. */
export function worldExpert(s: ArrayLike<number>): Action {
  const desired = s[15] * SECTOR_SPAN;
  const steer = clamp(desired / 0.5, -1, 1);
  const front = Math.max(s[5], s[6], s[7]);
  const target = s[16] * 90;
  const speed = s[11] * 90;
  const stuck = speed < 4 && front > 0.92;
  if (stuck) return { steer: -Math.sign(s[15] || 1), throttle: 0, brake: 0, reverse: 0.6 };
  const throttle = speed < target - 3 ? clamp(0.45 + (target - speed) / 55, 0.3, 1) : 0;
  const brake = speed > target + 7 ? clamp((speed - target) / 40, 0, 1) : 0;
  return { steer, throttle, brake, reverse: 0 };
}

export type WorldEpisodeOptions = { seed: number; density?: number; styleStrength?: number; maxTicks?: number; camera?: CameraConfig; headless?: boolean };

export class WorldEpisode implements VisionEpisode {
  readonly sim: WorldSim;
  readonly scene: WorldScene | null;
  readonly style: Style;
  readonly camera: CameraConfig;
  readonly frame: Float32Array;
  private readonly random: Random;
  private readonly scan = new Array(SECTORS).fill(0);

  constructor(readonly options: WorldEpisodeOptions) {
    this.sim = new WorldSim(options.seed, { density: options.density, maxTicks: options.maxTicks });
    this.random = mulberry32(options.seed * 31 + 3);
    this.camera = options.camera ?? WORLD_CAMERA;
    this.style = (options.styleStrength ?? 0) > 0 ? randomStyle(this.random, options.styleStrength ?? 0) : { ...DEFAULT_STYLE };
    this.scene = options.headless ? null : new WorldScene(this.sim.world, this.style);
    this.frame = new Float32Array(options.headless ? 0 : frameLength(this.camera));
  }

  get done(): boolean { return this.sim.done; }
  get tick(): number { return this.sim.status.ticks; }
  mission(): number[] { return this.sim.mission(); }
  lapContext(): null { return null; }
  summary(): { progress: number; finished: boolean; crashed: boolean } { return { progress: this.sim.status.goals, finished: this.sim.status.timedOut, crashed: this.sim.status.crashed }; }

  proprioception(): Proprioception {
    const { kart } = this.sim;
    return { speed: clamp(kart.speed / 90, -1, 1), lastSteer: clamp(kart.action.steer, -1, 1), lastDrive: clamp(kart.action.throttle - kart.action.brake, -1, 1) };
  }

  truth(out: number[] = new Array(SECTORS + 1).fill(0)): number[] {
    const { kart, world } = this.sim;
    clearanceScan(world, kart.x, kart.y, kart.heading, this.scan);
    for (let k = 0; k < SECTORS; k += 1) out[k] = this.scan[k];
    out[SECTORS] = SURFACE_VALUE[surfaceAt(world, kart.x + Math.cos(kart.heading) * 28, kart.y + Math.sin(kart.heading) * 28)];
    return out;
  }

  render(): Float32Array {
    if (!this.scene) throw new Error("this episode was created headless");
    const { kart, status } = this.sim;
    this.scene.setGoal(status.goalX, status.goalY);
    return renderFrame(this.scene, { x: kart.x, y: kart.y, heading: kart.heading }, this.camera, this.frame, this.random);
  }

  step(action: Action): void { this.sim.step(action); }
}
