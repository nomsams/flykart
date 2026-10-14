// One headless trial of a brain with a camera, a sonar and no compass.
//
// The controller sees exactly what the real robot's controller would see:
//   * nine clearance sectors and the surface ahead, as the camera network would estimate them (here: the true
//     geometry, minus anything too thin or far for 48 x 24 pixels, plus the estimator's noise and lag);
//   * where the pink flag is in the image and how large it looks, only when it is in view, not hidden behind
//     something, and big enough to cover two pixels (otherwise 0, 0: "I see nothing");
//   * the HC-SR04's echo, with its dropouts and ghosts;
//   * its own commanded speed and last pedals (no encoders, no compass, no map, no position).
// The flag's position, the distance to it, the pose and the score are never inputs.
import { SpikingNetwork, clamp, STEP } from "../core";
import { EstimateCorruptor, NoiseSpec } from "../vision/interface";
import { gaussian, mulberry32 } from "../vision/rng";
import { ROBOT_PROFILE, MOUNT } from "../vision/robot";
import { assembleInputs } from "../vision/inputs";
import { worldDomain, WorldEpisode } from "../vision/world/worldDomain";
import { SECTORS, SURFACE_VALUE, surfaceAt } from "../vision/world/world";
import { SearchJudge, validateSearchJudge } from "../vision/world/search-judge";
import { SolidIndex } from "./solid-index";
import type { Reality } from "./reality";
import type { Scenario } from "./scenario";

/** Camera focal length in pixels: a 48-pixel-wide image over a 104 degree field of view. */
export const CAMERA = { width: 48, height: 24, hfov: (104 * Math.PI) / 180 };
const FOCAL = CAMERA.width / 2 / Math.tan(CAMERA.hfov / 2);
/** The pink pennant on the flag: 7 px wide, from 28 to 46 px up (the world's flag sprite), in world pixels. */
const PENNANT = { width: 7, z0: 28.5, z1: 46 };
/** Pixels of pennant at a distance of 1 px, so that pixels = K / D^2 (before exposure). */
export const FLAG_K = FOCAL * FOCAL * PENNANT.width * (PENNANT.z1 - PENNANT.z0);
/** The tracker needs a component of at least this many pixels. */
export const FLAG_MIN_PIXELS = 2;

export type EpisodeOptions = {
  seed: number;
  /** Keep a pose trace (every `traceEvery` ticks) for drawing. */
  trace?: boolean; traceEvery?: number;
  /** Judge settings; defaults are the open world's loop / jitter guard with zero chill off. */
  judge?: Partial<import("../vision/world/search-judge").SearchJudgeSettings>;
  /** Draw per-tick sensor values for the inspector. */
  inputs?: boolean;
  /** End a trial after this many seconds with no new ground, no approach and no flag (default 25; 0 = never). */
  stallCutoffSeconds?: number;
  /** Keep every (inputs, action) pair of the trial, for lifetime learning from a successful run. */
  record?: boolean;
};

export type EpisodeResult = {
  goals: number; goalTarget: number; ticks: number; maxTicks: number; goalTicks: number[];
  crashed: boolean; crashReason?: string; collisions: number; pain: number;
  judgePenalty: number; cells: number; loopSeconds: number; jitterSeconds: number; blindReverseSeconds: number;
  reverseTicks: number; idleTicks: number; path: number; net: number; turn: number; meanSpeed: number;
  firstSeenTick: number | null; visibleTicks: number; bestSize: number;
  /** Where the kart was every so often (x, y, heading), when requested. */
  trace?: number[];
  goalsAt?: { x: number; y: number }[];
  /** With `record`: the controller's inputs and the action it took at every tick. */
  samples?: { input: number[]; action: { steer: number; throttle: number; brake: number; reverse: number } }[];
};

export type FlagCue = { visible: boolean; bearing: number; size: number; pixels: number; forward: number };
const NO_CUE: FlagCue = { visible: false, bearing: 0, size: 0, pixels: 0, forward: 0 };
/** What the controller reads when the sonar is not answering. */
const DEAD_ECHO = { range: 400 / 1.1, echo: false, strength: 0, validityOnly: true };

/** What a flag at (gx, gy) looks like from the camera: bearing and apparent size, or nothing. */
export function flagCue(index: SolidIndex, x: number, y: number, heading: number, gx: number, gy: number, flagGain: number, bearingSigmaPx: number, random: () => number): FlagCue {
  const lx = x + Math.cos(heading) * MOUNT.forward, ly = y + Math.sin(heading) * MOUNT.forward;
  const dx = gx - lx, dy = gy - ly;
  const forward = dx * Math.cos(heading) + dy * Math.sin(heading), right = -dx * Math.sin(heading) + dy * Math.cos(heading);
  if (forward < 4) return NO_CUE;
  const column = CAMERA.width / 2 + (FOCAL * right) / forward;
  if (column < 1 || column > CAMERA.width - 1) return NO_CUE;
  // Rows the pennant covers, from the same pinhole model the software camera uses; the part above the top row is lost,
  // which is why a flag disappears when the robot gets close.
  const pitch = ROBOT_PROFILE.worldCamera.pitch, cosP = Math.cos(pitch), sinP = Math.sin(pitch), h = MOUNT.height;
  const rowOf = (z: number): number => CAMERA.height / 2 + (FOCAL * ((h - z) * cosP - forward * sinP)) / (forward * cosP + (h - z) * sinP);
  const rows = Math.max(0, Math.min(CAMERA.height, rowOf(PENNANT.z0)) - Math.max(0, rowOf(PENNANT.z1)));
  // Measured against the real renderer (calibration test): detected pixels are about 0.75 of the geometric area, and a
  // blob of 1-3 pixels is found only some of the time as it falls across the pixel grid.
  const pixelsFloat = ((FOCAL * PENNANT.width) / forward) * rows * 0.75 * flagGain;
  const found = clamp((pixelsFloat - 1) / 2, 0, 1);
  if (found <= 0 || random() >= found) return NO_CUE;
  const pixels = Math.max(FLAG_MIN_PIXELS, Math.round(pixelsFloat));
  // Sight line to the middle of the pennant, from the lens.
  if (!index.lineOfSight(lx, ly, MOUNT.height, gx, gy, (PENNANT.z0 + PENNANT.z1) / 2)) return NO_CUE;
  const u = clamp(column + gaussian(random) * bearingSigmaPx, 0.5, CAMERA.width - 0.5);
  const normalised = ((Math.floor(u) + 0.5 - 0.5) / (CAMERA.width - 1)) * 2 - 1;
  const bearing = Math.atan(normalised * Math.tan(CAMERA.hfov / 2)) / Math.PI;
  const size = Math.min(1, Math.sqrt(pixels / (CAMERA.width * CAMERA.height)) * 4);
  return { visible: true, bearing, size, pixels, forward };
}

/** Scale a noise spec from simulation ticks to camera frames (the estimator only runs when a frame arrives). */
function perFrame(spec: NoiseSpec, camEvery: number): NoiseSpec {
  return { ...spec, correlationTicks: Math.max(1, spec.correlationTicks / camEvery), delayTicks: Math.round(spec.delayTicks / camEvery) };
}

export function runEpisode(brain: SpikingNetwork, scenario: Scenario, reality: Reality, options: EpisodeOptions): EpisodeResult {
  const seed = options.seed, random = mulberry32(seed * 7919 + 13);
  const maxTicks = scenario.spec.maxTicks;
  const episode = new WorldEpisode({
    seed, world: scenario.world, start: scenario.start, goals: scenario.goals, goalLimit: scenario.goals.length, maxTicks, headless: true,
    profile: ROBOT_PROFILE, sonar: reality.sonar, sonarFeedback: "echo-valid", speedFeedback: reality.speedFeedback, plant: reality.plant, goalRadius: 24,
  });
  const sim = episode.sim, kart = sim.kart;
  const index = new SolidIndex(sim.world, mulberry32(seed * 31 + 7));
  const judge = new SearchJudge(validateSearchJudge({ ...{ enabled: true, zeroChill: false, delaySeconds: 6, cutoffSeconds: 12, weight: 1, loopGuard: true, blindReverse: true, antiJitter: true, jitterWindowSeconds: 4, jitterWeight: 2 }, ...options.judge }));
  judge.reset(kart.x, kart.y);
  const corruptor = new EstimateCorruptor(perFrame(reality.noise, reality.camEvery), random, worldDomain.noiseScale);
  const truth = new Array(SECTORS + 1).fill(0), estimates = new Array(SECTORS + 1).fill(0), sensors = new Array(brain.inputCount).fill(0);
  let cue: FlagCue = NO_CUE;
  brain.reset();
  const result: EpisodeResult = {
    goals: 0, goalTarget: scenario.goals.length, ticks: 0, maxTicks, goalTicks: [], crashed: false, collisions: 0, pain: 0, judgePenalty: 0, cells: 0,
    loopSeconds: 0, jitterSeconds: 0, blindReverseSeconds: 0, reverseTicks: 0, idleTicks: 0, path: 0, net: 0, turn: 0, meanSpeed: 0, firstSeenTick: null, visibleTicks: 0, bestSize: 0,
  };
  if (options.trace) { result.trace = []; result.goalsAt = scenario.goals.map((g) => ({ ...g })); }
  const traceEvery = options.traceEvery ?? 3, stallCutoff = options.stallCutoffSeconds ?? 25;
  const start = { x: kart.x, y: kart.y };
  let goalsBefore = 0, speedSum = 0, previousHeading = kart.heading, idleRun = 0;
  while (!episode.done) {
    const tick = sim.status.ticks;
    // The camera delivers a frame every `camEvery` ticks; between frames the controller holds the last estimate.
    const frozen = reality.faults.cameraFreeze.some(([from, length]) => tick >= from && tick < from + length);
    if (!frozen && tick % reality.camEvery === 0 && random() >= reality.camDrop) {
      index.clearance(kart.x, kart.y, kart.heading, truth, true);
      truth[SECTORS] = SURFACE_VALUE[surfaceAt(sim.world, kart.x + Math.cos(kart.heading) * 28, kart.y + Math.sin(kart.heading) * 28)];
      corruptor.apply(truth, estimates);
      // The nearest flag still on the field that the camera can see.
      cue = NO_CUE;
      for (const g of sim.goals) {
        const c = flagCue(index, kart.x, kart.y, kart.heading, g.x, g.y, reality.flagGain, reality.bearingSigmaPx, random);
        if (c.visible && (!cue.visible || c.forward < cue.forward)) cue = c;
      }
      if (cue.visible && random() < reality.flagMiss) cue = NO_CUE;
    }
    if (cue.visible) { result.visibleTicks += 1; result.bestSize = Math.max(result.bestSize, cue.size); if (result.firstSeenTick === null) result.firstSeenTick = tick; }
    const silent = reality.faults.sonarOut.some(([from, length]) => tick >= from && tick < from + length);
    assembleInputs(worldDomain, estimates, [cue.visible ? cue.bearing : 0, cue.visible ? cue.size : 0], episode.proprioception(), silent ? DEAD_ECHO : episode.sonar(), brain.inputCount, sensors);
    const action = brain.step(sensors);
    if (options.record) (result.samples ??= []).push({ input: sensors.slice(), action: { steer: action.steer, throttle: action.throttle, brake: action.brake, reverse: action.reverse ?? 0 } });
    const x0 = kart.x, y0 = kart.y;
    episode.step(action);
    const goalsNow = sim.status.goals;
    if (goalsNow > goalsBefore) { for (let g = goalsBefore; g < goalsNow; g += 1) result.goalTicks.push(sim.status.ticks); goalsBefore = goalsNow; cue = NO_CUE; }
    const moved = Math.hypot(kart.x - x0, kart.y - y0);
    result.path += moved; speedSum += Math.abs(kart.speed);
    const dh = Math.atan2(Math.sin(kart.heading - previousHeading), Math.cos(kart.heading - previousHeading)); result.turn += Math.abs(dh); previousHeading = kart.heading;
    if ((action.reverse ?? 0) > action.throttle + 0.1 || kart.speed < -0.5) result.reverseTicks += 1;
    idleRun = Math.abs(kart.speed) < 2 ? idleRun + 1 : 0; if (idleRun > 0) result.idleTicks += 1;
    const feedback = judge.observe(kart.x, kart.y, sim.status.ticks, cue.size, goalsNow, goalsNow >= scenario.goals.length, sim.status.collisions, {
      visualSearch: true, reverse: kart.speed < -0.5 || (action.reverse ?? 0) > action.throttle + 0.1, targetVisible: cue.visible, heading: kart.heading, drive: action.throttle - (action.reverse ?? 0),
    });
    result.judgePenalty += feedback.penalty;
    if (options.trace && sim.status.ticks % traceEvery === 0) result.trace!.push(kart.x, kart.y, kart.heading);
    if (options.inputs && sim.status.ticks === 1) void 0;
    // A robot that has stopped for ten seconds and is not reaching anything is out of the running: end the trial.
    if (idleRun > 300) break;
    // Likewise one that has covered no new ground and not neared the flag for a long time (circling, rocking): the judge
    // has already charged it, and the rest of the trial would only repeat the same loop.
    if (stallCutoff > 0 && judge.seconds >= stallCutoff && goalsNow < scenario.goals.length) break;
  }
  const status = sim.status;
  result.ticks = status.ticks; result.goals = status.goals; result.crashed = status.crashed; result.crashReason = status.crashReason;
  result.collisions = status.collisions; result.pain = status.pain;
  result.cells = judge.cells; result.loopSeconds = judge.looping ? judge.seconds : 0; result.jitterSeconds = judge.jitterSeconds; result.blindReverseSeconds = judge.blindReverseSeconds;
  result.net = Math.hypot(kart.x - start.x, kart.y - start.y); result.meanSpeed = speedSum / Math.max(1, status.ticks);
  void STEP;
  return result;
}
