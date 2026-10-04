// A simulated HC-SR04, with the behaviour of the cheap module.
//
// What it does well: a flat, large target squarely in front, 5 cm to ~3 m away,
// reported to about a centimetre.
// What it does badly, all modelled here:
//   * a wide, soft beam (about 15 degrees), so it reports the nearest thing anywhere
//     in a cone and cannot say where in the cone;
//   * thin or small things (a cone, a pole, a far kart) return a weak echo and
//     disappear beyond a metre or two, and flicker near that limit;
//   * flat surfaces seen at a slant bounce the ping away and return nothing;
//   * it looks along the floor 6.5 cm up, so anything lower (road paint, kerbs,
//     oil, ponds) does not exist for it, and anything high above the beam is missed;
//   * range noise, a speed-of-sound scale error, an occasional false echo, and
//     a new reading only every ~66 ms.
// Echo strength follows the sonar equation in simplified form: the part of the
// two-way beam pattern the target fills, times how much of it is at the right
// height, times how squarely the surface faces the sensor, times 1/range^2.
import { clamp } from "../core";
import { CM_PER_PIXEL, SonarSpec } from "./robot";
import { Random, gaussian } from "./rng";

export type SonarTarget =
  | { kind: "circle"; x: number; y: number; radius: number; z0: number; z1: number }
  | { kind: "box"; x: number; y: number; heading: number; halfLength: number; halfWidth: number; z0: number; z1: number };

export type SonarPose = { x: number; y: number; heading: number };

export type SonarReading = {
  /** Distance in pixels; the maximum range when no echo came back. */
  range: number;
  /** Whether an echo was heard. */
  echo: boolean;
  /** Echo strength, relative to the detection threshold (1 = just heard). */
  strength: number;
};

const SLICE = (2 * Math.PI) / 180;
const SPAN = 30; // degrees either side of the axis that are worth tracing
const REFERENCE = 60; // px: range at which a perfect flat target returns an echo of 1
const BIN = 3;
/** Anything whose top is lower than this (about 1.6 cm) is paint or a puddle on the floor, not a surface that can reflect a ping. */
const FLOOR_LEVEL = 1.5;

/** Error function (Abramowitz and Stegun 7.1.26). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1; const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

type Hit = { distance: number; roundish: boolean; incidence: number; z0: number; z1: number };

function rayCircle(ox: number, oy: number, dx: number, dy: number, target: Extract<SonarTarget, { kind: "circle" }>): Hit | null {
  const fx = target.x - ox, fy = target.y - oy; const along = fx * dx + fy * dy;
  if (along <= 0) return null;
  const d2 = fx * fx + fy * fy - along * along; const r2 = target.radius * target.radius;
  if (d2 > r2) return null;
  return { distance: along - Math.sqrt(r2 - d2), roundish: true, incidence: 0, z0: target.z0, z1: target.z1 };
}

function rayBox(ox: number, oy: number, dx: number, dy: number, target: Extract<SonarTarget, { kind: "box" }>): Hit | null {
  const c = Math.cos(target.heading), s = Math.sin(target.heading);
  // Into the box's frame.
  const px = (ox - target.x) * c + (oy - target.y) * s, py = -(ox - target.x) * s + (oy - target.y) * c;
  const vx = dx * c + dy * s, vy = -dx * s + dy * c;
  let tMin = -Infinity, tMax = Infinity; let axis = 0;
  for (const [p, v, half, which] of [[px, vx, target.halfLength, 1], [py, vy, target.halfWidth, 2]] as const) {
    if (Math.abs(v) < 1e-9) { if (Math.abs(p) > half) return null; continue; }
    let t1 = (-half - p) / v, t2 = (half - p) / v; if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) { tMin = t1; axis = which; }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMin <= 0) return null;
  // Angle between the ray (reversed) and the face that was hit.
  const cosIncidence = Math.abs(axis === 1 ? vx : vy);
  return { distance: tMin, roundish: false, incidence: Math.acos(clamp(cosIncidence, 0, 1)), z0: target.z0, z1: target.z1 };
}

/** One ping. `random` supplies speckle, noise and false echoes; `soundScale` is the run's speed-of-sound error. */
export function ping(spec: SonarSpec, pose: SonarPose, targets: readonly SonarTarget[], random: Random, soundScale = 1): SonarReading {
  const maxPx = spec.maxRangeCm / CM_PER_PIXEL, minPx = spec.minRangeCm / CM_PER_PIXEL;
  const sigma = (spec.lobeSigmaDeg * Math.PI) / 180;
  const ox = pose.x + Math.cos(pose.heading) * spec.mountForward, oy = pose.y + Math.sin(pose.heading) * spec.mountForward;
  const near = targets.filter((t) => Math.hypot(t.x - ox, t.y - oy) < maxPx + (t.kind === "circle" ? t.radius : Math.hypot(t.halfLength, t.halfWidth)));
  const bins = new Float32Array(Math.ceil(maxPx / BIN) + 2); const weighted = new Float32Array(bins.length);
  const norm = sigma * Math.sqrt(Math.PI / 2);
  for (let degrees = -SPAN; degrees <= SPAN; degrees += 2) {
    const azimuth = degrees * (Math.PI / 180);
    const dx = Math.cos(pose.heading + azimuth), dy = Math.sin(pose.heading + azimuth);
    let best: Hit | null = null;
    for (const target of near) {
      const hit = target.kind === "circle" ? rayCircle(ox, oy, dx, dy, target) : rayBox(ox, oy, dx, dy, target);
      if (hit && hit.distance > minPx && hit.distance < maxPx && (!best || hit.distance < best.distance)) best = hit;
    }
    if (!best || best.z1 < FLOOR_LEVEL) continue;
    const r = best.distance;
    // How much of the beam's vertical lobe the target fills at this range.
    const a = Math.sqrt(2) / sigma;
    const low = Math.atan2(best.z0 - spec.mountHeight, r), high = Math.atan2(best.z1 - spec.mountHeight, r);
    const vertical = 0.5 * (erf(a * high) - erf(a * low));
    if (vertical <= 0) continue;
    const horizontal = (Math.exp(-2 * (azimuth / sigma) ** 2) * SLICE) / norm;
    const slant = best.roundish ? 1 : Math.exp(-((Math.max(0, best.incidence - 0.26) / 0.31) ** 2));
    const amplitude = horizontal * vertical * slant * Math.min(1.6, (REFERENCE / r) ** 2);
    const bin = Math.floor(r / BIN);
    bins[bin] += amplitude; weighted[bin] += amplitude * r;
  }
  let reading: SonarReading = { range: maxPx, echo: false, strength: 0 };
  for (let b = 0; b < bins.length; b += 1) {
    // Echoes from neighbouring ranges overlap in time, so they add; a fading, flickering echo is common near the limit.
    const sum = bins[b] + 0.5 * ((bins[b - 1] ?? 0) + (bins[b + 1] ?? 0));
    if (sum <= 0) continue;
    const heard = sum * Math.exp(gaussian(random) * spec.speckleSigma);
    if (heard >= spec.threshold) {
      const mass = bins[b] + (bins[b - 1] ?? 0) + (bins[b + 1] ?? 0);
      const mean = (weighted[b] + (weighted[b - 1] ?? 0) + (weighted[b + 1] ?? 0)) / Math.max(1e-9, mass);
      reading = { range: mean, echo: true, strength: heard / spec.threshold };
      break;
    }
  }
  if (reading.echo) {
    const cm = reading.range * CM_PER_PIXEL * soundScale;
    const noisy = cm + gaussian(random) * (spec.noiseBaseCm + spec.noiseProportional * cm);
    const quantised = Math.round(noisy / spec.resolutionCm) * spec.resolutionCm;
    reading.range = clamp(quantised / CM_PER_PIXEL, minPx, maxPx);
  }
  if (random() < spec.ghostProbability) reading = { range: (spec.minRangeCm + random() * (spec.maxRangeCm - spec.minRangeCm)) / CM_PER_PIXEL, echo: true, strength: 1 };
  return reading;
}

/** A sonar on a moving robot: it pings every few ticks and holds the last reading in between. */
export class Sonar {
  reading: SonarReading;
  private readonly soundScale: number;
  private pings = 0;
  constructor(readonly spec: SonarSpec, private readonly random: Random) {
    this.soundScale = 1 + gaussian(random) * spec.soundScaleSigma;
    this.reading = { range: spec.maxRangeCm / CM_PER_PIXEL, echo: false, strength: 0 };
  }
  get count(): number { return this.pings; }
  /** Call once per tick; returns true when a fresh reading was taken. */
  update(tick: number, pose: SonarPose, targets: readonly SonarTarget[]): boolean {
    if (tick % this.spec.cycleTicks !== 0) return false;
    this.reading = ping(this.spec, pose, targets, this.random, this.soundScale); this.pings += 1;
    return true;
  }
}

/** The two numbers the controller reads: closeness of the echo (0 when none) and its strength (0..1). */
export function sonarInputs(reading: SonarReading, usefulRangePx: number, out: number[] = [0, 0]): number[] {
  out[0] = reading.echo ? clamp(1 - reading.range / usefulRangePx, 0, 1) : 0;
  out[1] = reading.echo ? clamp(Math.log(Math.max(1, reading.strength)) / Math.log(40), 0, 1) : 0;
  return out;
}

