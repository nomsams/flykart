// Random closed tracks, so the camera network sees many more road shapes than
// the fifteen hand-built ones, and can be tested on shapes it never trained on.
//
// A track is a radial curve r(θ) = 1 + Σ aₖ cos(kθ + φₖ) sampled at 16-24
// points, which guarantees it never crosses itself. Candidates are rejected
// when a bend is too tight for the road width or when the built-in heuristic
// driver cannot get around them.
import { DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, TRACKS, TrackDefinition, TrackId, Vec, heuristicAction, startPosition, stepCar, wrapAngle } from "../core";
import { mulberry32 } from "./rng";

export function buildTrack(id: string, name: string, points: Vec[], width: number): TrackDefinition {
  const segmentLengths = points.map((point, index) => Math.hypot(point.x - points[(index + 1) % points.length].x, point.y - points[(index + 1) % points.length].y));
  const cumulativeLengths: number[] = [0];
  segmentLengths.forEach((length) => cumulativeLengths.push(cumulativeLengths[cumulativeLengths.length - 1] + length));
  return { id: id as TrackId, name, points, width, segmentLengths, cumulativeLengths, length: cumulativeLengths[cumulativeLengths.length - 1] };
}

export function candidate(seed: number): TrackDefinition | null {
  const random = mulberry32(seed * 2654435761 + 17);
  const count = 16 + Math.floor(random() * 9);
  const rx = 285 + random() * 55, ry = 150 + random() * 65;
  const harmonics = [2, 3, 4, 5, 6, 7].map((k) => ({ k, amplitude: random() * (0.2 / Math.sqrt(k - 1)), phase: random() * Math.PI * 2 }));
  const width = 92 + random() * 36;
  const points: Vec[] = [];
  for (let i = 0; i < count; i += 1) {
    const theta = ((i + (random() - 0.5) * 0.3) / count) * Math.PI * 2;
    let radius = 1; for (const h of harmonics) radius += h.amplitude * Math.cos(h.k * theta + h.phase);
    radius = Math.max(0.5, radius);
    points.push({ x: Math.max(-362, Math.min(362, rx * radius * Math.cos(theta))), y: Math.max(-228, Math.min(228, ry * radius * Math.sin(theta))) });
  }
  if (random() < 0.5) points.reverse();
  const rotate = Math.floor(random() * count); const ordered = [...points.slice(rotate), ...points.slice(0, rotate)];
  const track = buildTrack(`gen-${seed}`, `Generated ${seed}`, ordered, width);
  if (Math.min(...track.segmentLengths) < 22) return null;
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[(i - 1 + count) % count], b = ordered[i], c = ordered[(i + 1) % count];
    const turn = Math.abs(wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
    if (turn > 1.55) return null;
  }
  // Two stretches of road that are far apart along the lap must never be closer than a road width.
  for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
    const forward = track.cumulativeLengths[j] - track.cumulativeLengths[i]; const arc = Math.min(forward, track.length - forward);
    if (arc < width * 2.4) continue;
    if (segmentDistance(ordered[i], ordered[(i + 1) % count], ordered[j], ordered[(j + 1) % count]) < width * 0.95) return null;
  }
  return track;
}

function pointSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
function segmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number { return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b)); }

/** Register with the core's track table (the physics looks tracks up by id) and return it. */
export function registerTrack(track: TrackDefinition): TrackDefinition {
  if (!TRACKS.some((existing) => existing.id === track.id)) TRACKS.push(track);
  return TRACKS.find((existing) => existing.id === track.id)!;
}

const cache = new Map<number, TrackDefinition | null>();

/** The heuristic driver is the referee: a track is only kept if it can lap it. */
function drivable(track: TrackDefinition): boolean {
  registerTrack(track);
  const car = startPosition(0, track); car.timeLimit = 4500;
  const physics = { ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: false };
  for (let tick = 0; tick < 4500 && !car.crashed && !car.finished && !car.timedOut; tick += 1) stepCar(car, heuristicAction(car, [car], track), [car], track, DEFAULT_REWARD_CONFIG, physics);
  return car.finished;
}

const byIndex = new Map<string, TrackDefinition>();

/** The `index`-th usable generated track for a base seed; deterministic. Each index scans its own block of 400 seeds. */
export function proceduralTrack(index: number, baseSeed = 1000): TrackDefinition {
  const key = `${baseSeed}:${index}`;
  const known = byIndex.get(key);
  if (known) return registerTrack(known);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const seed = baseSeed + index * 400 + attempt;
    if (!cache.has(seed)) { const made = candidate(seed); cache.set(seed, made && drivable(made) ? made : null); }
    const found = cache.get(seed);
    if (found) { byIndex.set(key, found); return registerTrack(found); }
  }
  throw new Error("could not generate a drivable track");
}
