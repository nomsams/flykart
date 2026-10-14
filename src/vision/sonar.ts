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
import { SonarSurface, reflectionGain } from './sonar-surfaces';

export type SonarTarget = ({surface?:SonarSurface} & (
  | { kind: "circle"; x: number; y: number; radius: number; z0: number; z1: number }
  | { kind: "box"; x: number; y: number; heading: number; halfLength: number; halfWidth: number; z0: number; z1: number }));

export type SonarPose = { x: number; y: number; heading: number };

export type SonarReading = {
  /** Distance in pixels; the maximum range when no echo came back. */
  range: number;
  /** HC-SR04 provides pulse timing / detection, not analogue amplitude. */
  validityOnly?:boolean;
  /** Whether an echo was heard. */
  echo: boolean;
  /** Echo strength, relative to the detection threshold (1 = just heard). */
  strength: number;
};

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

type Hit = { surface?:SonarSurface; distance: number; roundish: boolean; incidence: number; z0: number; z1: number };

function rayCircle(ox: number, oy: number, dx: number, dy: number, target: Extract<SonarTarget, { kind: "circle" }>): Hit | null {
  const fx = target.x - ox, fy = target.y - oy; const along = fx * dx + fy * dy;
  if (fx*fx+fy*fy<=target.radius*target.radius) return {surface:target.surface,distance:0,roundish:true,incidence:0,z0:target.z0,z1:target.z1};
  if (along <= 0) return null;
  const d2 = fx * fx + fy * fy - along * along; const r2 = target.radius * target.radius;
  if (d2 > r2) return null;
  return { surface:target.surface,distance: along - Math.sqrt(r2 - d2), roundish: true, incidence: Math.asin(Math.sqrt(clamp(d2/r2,0,1))), z0: target.z0, z1: target.z1 };
}

function rayBox(ox: number, oy: number, dx: number, dy: number, target: Extract<SonarTarget, { kind: "box" }>, c = Math.cos(target.heading), s = Math.sin(target.heading)): Hit | null {
  // Into the box's frame.
  const px = (ox - target.x) * c + (oy - target.y) * s, py = -(ox - target.x) * s + (oy - target.y) * c;
  const vx = dx * c + dy * s, vy = -dx * s + dy * c;
  let tMin = -Infinity, tMax = Infinity; let axis = 0;
  // The two box axes, unrolled (this runs for every beam ray against every nearby target).
  if (Math.abs(vx) < 1e-9) { if (Math.abs(px) > target.halfLength) return null; }
  else {
    let t1 = (-target.halfLength - px) / vx, t2 = (target.halfLength - px) / vx; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) { tMin = t1; axis = 1; }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (Math.abs(vy) < 1e-9) { if (Math.abs(py) > target.halfWidth) return null; }
  else {
    let t1 = (-target.halfWidth - py) / vy, t2 = (target.halfWidth - py) / vy; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tMin) { tMin = t1; axis = 2; }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  if (tMin <= 0) return {surface:target.surface,distance:0,roundish:false,incidence:0,z0:target.z0,z1:target.z1};
  // Angle between the ray (reversed) and the face that was hit.
  const cosIncidence = Math.abs(axis === 1 ? vx : vy);
  return { surface:target.surface,distance: tMin, roundish: false, incidence: Math.acos(clamp(cosIncidence, 0, 1)), z0: target.z0, z1: target.z1 };
}

let scratchBins = new Float32Array(0), scratchWeighted = new Float32Array(0);
/** One ping. `random` supplies speckle, noise and false echoes; `soundScale` is the run's speed-of-sound error. */
export function ping(spec: SonarSpec, pose: SonarPose, targets: readonly SonarTarget[], random: Random, soundScale = 1): SonarReading {
  const maxPx = spec.maxRangeCm / CM_PER_PIXEL, minPx = spec.minRangeCm / CM_PER_PIXEL;
  const sigma = (spec.lobeSigmaDeg * Math.PI) / 180;
  const ox = pose.x + Math.cos(pose.heading) * spec.mountForward, oy = pose.y + Math.sin(pose.heading) * spec.mountForward;
  // Only targets that can touch the beam: in range, inside the swept cone and not wholly above its vertical lobe.
  const axis = pose.heading + (spec.yawDeg ?? 0) * Math.PI / 180, sweep = (Math.min(60, Math.max(SPAN, spec.lobeSigmaDeg * 2.5)) * Math.PI) / 180;
  const pitch0 = (spec.pitchDeg ?? 0) * Math.PI / 180, lobeLimit = 2.5 * sigma;
  let near: SonarTarget[] = [], lowAngle: number[] = [], highAngle: number[] = [], closest: number[] = [];
  const cosAxis = Math.cos(axis), sinAxis = Math.sin(axis), cosSweep = Math.cos(sweep), sinSweep = Math.sin(sweep);
  for (const t of targets) {
    const bound = t.kind === "circle" ? t.radius : Math.hypot(t.halfLength, t.halfWidth);
    const tx = t.x - ox, ty = t.y - oy, d2 = tx * tx + ty * ty, reach = maxPx + bound;
    if (d2 >= reach * reach) continue;
    // The angular interval (relative to the beam axis) this target covers; rays outside it cannot hit it.
    let lo = -Math.PI, hi = Math.PI;
    if (d2 > (bound + 1e-6) * (bound + 1e-6)) {
      const dist = Math.sqrt(d2), forward = tx * cosAxis + ty * sinAxis, side = -tx * sinAxis + ty * cosAxis;
      // Cheap reject first: is the circle clear of the swept cone's nearer edge?
      if (Math.abs(side) * cosSweep - forward * sinSweep > bound) continue;
      const off = Math.atan2(side, forward), half = Math.asin(Math.min(1, bound / dist));
      if (Math.abs(off) > sweep + half) continue;
      lo = off - half; hi = off + half;
    }
    if (Math.atan2(t.z0 - spec.mountHeight, Math.max(minPx, Math.sqrt(d2) - bound)) + pitch0 > lobeLimit) continue;
    near.push(t); lowAngle.push(lo); highAngle.push(hi); closest.push(Math.max(0, Math.sqrt(d2) - bound));
  }
  // Nearest first: a ray skips every target that cannot be nearer than the hit it already holds. The order only affects speed
  // (skipped targets are still compared with the exact distance), so packing index and rounded distance into one number is safe.
  if (near.length > 1 && near.length < 1024) {
    const keys = new Float64Array(near.length);
    for (let i = 0; i < near.length; i += 1) keys[i] = Math.round(closest[i] * 16) * 1024 + i;
    keys.sort();
    const nextNear: SonarTarget[] = new Array(near.length), nextLow: number[] = new Array(near.length), nextHigh: number[] = new Array(near.length), nextClosest: number[] = new Array(near.length);
    for (let k = 0; k < keys.length; k += 1) { const i = keys[k] % 1024; nextNear[k] = near[i]; nextLow[k] = lowAngle[i]; nextHigh[k] = highAngle[i]; nextClosest[k] = closest[i]; }
    near = nextNear; lowAngle = nextLow; highAngle = nextHigh; closest = nextClosest;
  }
  const cosines = new Float64Array(near.length), sines = new Float64Array(near.length);
  for (let n = 0; n < near.length; n += 1) { const t = near[n]; if (t.kind === "box") { cosines[n] = Math.cos(t.heading); sines[n] = Math.sin(t.heading); } }
  const binCount = Math.ceil(maxPx / BIN) + 2;
  if (scratchBins.length !== binCount) { scratchBins = new Float32Array(binCount); scratchWeighted = new Float32Array(binCount); } else { scratchBins.fill(0); scratchWeighted.fill(0); }
  const bins = scratchBins, weighted = scratchWeighted;
  const norm = sigma * Math.sqrt(Math.PI / 2);
  const span=Math.min(60,Math.max(SPAN,spec.lobeSigmaDeg*2.5));
  // The beam is sampled every `rayStepDeg` (2 by default); the lobe is 12 degrees wide, so 3 is a close, cheaper stand-in.
  const step = Math.max(1, spec.rayStepDeg ?? 2), slice = (step * Math.PI) / 180;
  for (let degrees = -span; degrees <= span; degrees += step) {
    const azimuth = degrees * (Math.PI / 180);
    const dx = Math.cos(pose.heading + (spec.yawDeg ?? 0) * Math.PI / 180 + azimuth), dy = Math.sin(pose.heading + (spec.yawDeg ?? 0) * Math.PI / 180 + azimuth);
    let best: Hit | null = null;
    for (let n = 0; n < near.length; n += 1) {
      if (best !== null && closest[n] > best.distance) continue;
      if (azimuth < lowAngle[n] || azimuth > highAngle[n]) continue;
      const target = near[n];
      const hit = target.kind === "circle" ? rayCircle(ox, oy, dx, dy, target) : rayBox(ox, oy, dx, dy, target, cosines[n], sines[n]);
      if(!hit||hit.distance<0||hit.distance>=maxPx||hit.z1<FLOOR_LEVEL)continue;
      // Something far above the lobe (a canopy, a ceiling lamp) cannot echo and must not hide what is behind it.
      if(hit.distance>minPx&&Math.atan2(hit.z0-spec.mountHeight,hit.distance)+pitch0>lobeLimit)continue;
      if(hit.distance<=minPx){
        // A blind-zone obstacle can still block a farther reflector. Ignore only
        // near geometry outside the vertical beam (e.g. a tabletop above it).
        const a=Math.sqrt(2)/sigma,pitch=(spec.pitchDeg??0)*Math.PI/180;
        const vertical=.5*(erf(a*(Math.atan2(hit.z1-spec.mountHeight,Math.max(1e-9,hit.distance))+pitch))-erf(a*(Math.atan2(hit.z0-spec.mountHeight,Math.max(1e-9,hit.distance))+pitch)));
        if(vertical<=0)continue;
      }
      if(!best||hit.distance<best.distance)best=hit;
    }
    // Below 2 cm the module cannot measure range. Do not trace through that
    // obstacle and report a false distant opening instead.
    if (!best || best.distance <= minPx) continue;
    const r = best.distance;
    // How much of the beam's vertical lobe the target fills at this range.
    const a = Math.sqrt(2) / sigma;
    const pitch = (spec.pitchDeg ?? 0) * Math.PI / 180;
    const low = Math.atan2(best.z0 - spec.mountHeight, r) + pitch, high = Math.atan2(best.z1 - spec.mountHeight, r) + pitch;
    const vertical = 0.5 * (erf(a * high) - erf(a * low));
    if (vertical <= 0) continue;
    const horizontal = (Math.exp(-2 * (azimuth / sigma) ** 2) * slice) / norm;
    const slant = reflectionGain(best.surface,best.incidence,best.roundish);
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
    const cm = reading.range * CM_PER_PIXEL * soundScale * (spec.rangeScale ?? 1) + (spec.rangeOffsetCm ?? 0);
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
  /** Robot pose at acquisition, retained while the reading is held. */
  samplePose: SonarPose | null = null;
  private readonly soundScale: number;
  private pings = 0;
  lastTick = -1;
  constructor(readonly spec: SonarSpec, private readonly random: Random) {
    this.soundScale = 1 + gaussian(random) * spec.soundScaleSigma;
    this.reading = { range: spec.maxRangeCm / CM_PER_PIXEL, echo: false, strength: 0 };
  }
  get count(): number { return this.pings; }
  /** Call once per tick; returns true when a fresh reading was taken. */
  update(tick: number, pose: SonarPose, targets: readonly SonarTarget[], force=false): boolean {
    if (!force && (tick === this.lastTick || tick % this.spec.cycleTicks !== 0)) return false;
    this.lastTick = tick;
    this.samplePose = {...pose};
    this.reading = ping(this.spec, pose, targets, this.random, this.soundScale); this.pings += 1;
    return true;
  }
}

/** The two numbers the controller reads: closeness of the echo (0 when none) and its strength (0..1). */
export function sonarInputs(reading: SonarReading, usefulRangePx: number, out: number[] = [0, 0]): number[] {
  out[0] = reading.echo ? clamp(1 - reading.range / usefulRangePx, 0, 1) : 0;
  out[1] = reading.echo ? reading.validityOnly?1:clamp(Math.log(Math.max(1, reading.strength)) / Math.log(40), 0, 1) : 0;
  return out;
}
