// The reality gap, as numbers that can be drawn from a distribution.
//
// A brain evolved against a perfect simulator learns the simulator. Every episode here draws a fresh "reality":
// how rough the camera's estimates are, how often a frame is lost, how late the motors answer, how weak the
// battery is, how noisy this particular HC-SR04 is. `severity` 0 is the ideal simulator, 1 is a typical cheap
// robot, 2 is a bad day (low light, flat battery, wet floor). None of this is measured from hardware; the
// ranges are plausible engineering values, and `RealityGapNote` says so wherever they are shown.
import { Random, gaussian } from "../vision/rng";
import { NOISE_LEVELS, NoiseSpec, blendNoise } from "../vision/interface";
import { HC_SR04, type SonarSpec } from "../vision/robot";
import { IDEAL_PLANT, type PlantSpec } from "../vision/world/world";

export type Reality = {
  severity: number;
  /** Error of the camera's clearance estimates, in sensor units, with latency in ticks. */
  noise: NoiseSpec;
  /** Ticks between camera frames, and the chance a frame is lost and the last one held. */
  camEvery: number; camDrop: number;
  /** Multiplier on how many pixels the flag covers (exposure, white balance), and chance per frame it is missed. */
  flagGain: number; flagMiss: number;
  /** Error of the flag's pixel column, in pixels. */
  bearingSigmaPx: number;
  sonar: SonarSpec;
  plant: PlantSpec;
  /** "command" is what the real ESP32 has (no encoders); "measured" is the simulator's true speed. */
  speedFeedback: "command" | "measured";
  /** Stretches of a trial (start tick, length) when the sonar returns nothing, or the camera delivers the same frame. */
  faults: { sonarOut: [number, number][]; cameraFreeze: [number, number][] };
};

/**
 * The ranges the drivetrain and camera flaws are drawn from. The defaults are plausible values; replace them with
 * what a real robot logged (`--reality=measured.json`) and the whole run is bred against that robot instead.
 */
export type RealityRanges = {
  /** Duty below which the motors do not turn, as a fraction (at severity 1). */
  deadband: [number, number];
  /** Motor response time constant, seconds. */
  tau: [number, number];
  /** Camera frame intervals to choose among, in 30 Hz ticks. */
  camEvery: number[];
};
export const DEFAULT_RANGES: RealityRanges = { deadband: [0.04, 0.2], tau: [0.08, 0.25], camEvery: [3, 4, 6] };

export function validateRanges(raw: unknown): RealityRanges {
  const r = raw as Partial<RealityRanges>, pair = (v: unknown, lo: number, hi: number): [number, number] => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi) || v[0] > v[1]) throw new Error(`Expected a [low, high] pair between ${lo} and ${hi}.`);
    return [v[0], v[1]];
  };
  const camEvery = r.camEvery === undefined ? DEFAULT_RANGES.camEvery : r.camEvery;
  if (!Array.isArray(camEvery) || !camEvery.length || camEvery.some((v) => !Number.isInteger(v) || v < 1 || v > 30)) throw new Error("camEvery must list whole numbers of ticks between 1 and 30.");
  return { deadband: r.deadband === undefined ? DEFAULT_RANGES.deadband : pair(r.deadband, 0, 0.5), tau: r.tau === undefined ? DEFAULT_RANGES.tau : pair(r.tau, 0.01, 1), camEvery };
}

export const IDEAL_REALITY: Reality = {
  severity: 0, noise: NOISE_LEVELS[0].spec, camEvery: 1, camDrop: 0, flagGain: 1, flagMiss: 0, bearingSigmaPx: 0, sonar: HC_SR04, plant: { ...IDEAL_PLANT }, speedFeedback: "measured", faults: { sonarOut: [], cameraFreeze: [] },
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const between = (r: Random, lo: number, hi: number): number => lo + (hi - lo) * r();

/** Draw one reality at the given severity (0 ideal, 1 typical, 2 harsh). */
export function sampleReality(random: Random, severity: number, speedFeedback: "command" | "measured" = "command", ranges: RealityRanges = DEFAULT_RANGES): Reality {
  const s = Math.max(0, Math.min(2.5, severity));
  if (s <= 0) return { ...IDEAL_REALITY, speedFeedback };
  // Camera estimate noise walks up the named ladder (clean, mild, rough, harsh, brutal) and then jitters around it.
  const level = Math.min(3.99, s * 1.5), index = Math.floor(level);
  const base = blendNoise(NOISE_LEVELS[index].spec, NOISE_LEVELS[index + 1].spec, level - index);
  const jitter = 0.7 + random() * 0.6;
  const noise: NoiseSpec = { ...base, white: base.white * jitter, correlated: base.correlated * jitter, bias: base.bias * (0.6 + random() * 0.8) };
  const sonar: SonarSpec = {
    ...HC_SR04,
    noiseBaseCm: HC_SR04.noiseBaseCm * lerp(1, between(random, 1.5, 3), Math.min(1, s)),
    noiseProportional: HC_SR04.noiseProportional * lerp(1, between(random, 1.5, 3), Math.min(1, s)),
    ghostProbability: Math.min(0.03, HC_SR04.ghostProbability * lerp(1, between(random, 2, 8), Math.min(1, s))),
    soundScaleSigma: HC_SR04.soundScaleSigma * lerp(1, 2, Math.min(1, s)),
    threshold: HC_SR04.threshold * lerp(1, between(random, 1, 2), Math.min(1, s)),
    lobeSigmaDeg: HC_SR04.lobeSigmaDeg + gaussian(random) * 1.5 * Math.min(1, s),
  };
  // Drivetrain: dead zone at low duty, first-order motor response (tau 0.08-0.25 s at severity 1), unequal sides, a sagging battery.
  const tau = Math.max(0.02, between(random, ranges.tau[0], ranges.tau[1]) * Math.min(1.4, s));
  const plant: PlantSpec = {
    steerGain: 1 + gaussian(random) * 0.07 * s,
    steerBias: gaussian(random) * 0.045 * s,
    powerScale: Math.max(0.55, 1 - Math.abs(gaussian(random)) * 0.12 * s - 0.04 * s),
    brakeScale: Math.max(0.5, 1 - Math.abs(gaussian(random)) * 0.1 * s),
    deadband: Math.min(0.35, between(random, ranges.deadband[0], ranges.deadband[1]) * Math.min(1.3, s)),
    motorLag: Math.exp(-1 / 30 / tau),
    delayTicks: Math.round(random() * 2.5 * Math.min(1.5, s)),
    gripScale: Math.max(0.6, 1 - Math.abs(gaussian(random)) * 0.1 * s),
    dragScale: 1 + Math.abs(gaussian(random)) * 0.15 * s,
  };
  const isDefaultFrames = ranges.camEvery.length === 3 && ranges.camEvery[0] === 3 && ranges.camEvery[1] === 4 && ranges.camEvery[2] === 6;
  const camEvery = s < 0.3 ? 1 : isDefaultFrames ? (random() < 0.5 ? 3 : random() < 0.6 ? 4 : 6) : ranges.camEvery[Math.floor(random() * ranges.camEvery.length)];
  const reality: Reality = {
    severity: s, noise, sonar, plant, speedFeedback, camEvery,
    camDrop: Math.min(0.3, between(random, 0, 0.1) * s),
    flagGain: Math.max(0.35, 1 + gaussian(random) * 0.22 * s),
    flagMiss: Math.min(0.4, between(random, 0.01, 0.1) * s),
    bearingSigmaPx: between(random, 0.25, 0.8) * Math.min(1.5, s),
    faults: { sonarOut: [], cameraFreeze: [] },
  };
  // From a rough day upward, a sensor sometimes goes quiet for a few seconds (a loose wire, a dropped frame stream). Drawn last,
  // so nothing about a milder reality changes.
  if (s >= 1.2) {
    const stretch = (): [number, number][] => random() < 0.4 ? Array.from({ length: 1 + Math.floor(random() * 2) }, () => [90 + Math.floor(random() * 700), 45 + Math.floor(random() * 120)] as [number, number]) : [];
    reality.faults = { sonarOut: stretch(), cameraFreeze: stretch() };
  }
  return reality;
}

export const RealityGapNote = "Reality is a distribution of plausible values, not a measurement of any one robot: wheel dead zone, motor lag, battery sag, sensor noise, frame rate and lighting are drawn per episode.";
