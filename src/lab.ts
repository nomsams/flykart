// Typed helpers behind the compendium's "Open a trained brain" chapter.
// Everything here runs the real controller and physics from core.ts; the page
// (public/brain-inspector.js) only draws. Bundled to public/flykart-core.js
// with `npm run build:lab` and exposed as the global FlyKartCore.
import {
  Action, BrainSnapshot, CAR_LENGTH, CAR_WIDTH, Car, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, LANE_SPACING, PhysicsConfig, RewardBreakdown, RewardConfig, RoadObjectKind,
  SpikingNetwork, STEP, TRACKS, TrackDefinition, TrackId, Vec, createRoadObstacles, heuristicAction, nearestTrack, pointAtDistance, resolveTrack, sensorValues, startLine, startPosition, stepCar, trackCheckpoint,
} from "./core";

export { STEP, DEFAULT_REWARD_CONFIG };
export const INPUT_COUNT = 17;
export const HIDDEN_COUNT = 48;
export const READOUT_COUNT = 4;

/* ------------------------------------------------------------------ */
/* Static descriptions: what every sensor, readout and reward term is  */
/* ------------------------------------------------------------------ */

export type SensorGroup = "road" | "position" | "motion" | "traffic" | "self";
export type SensorInfo = { index: number; key: string; label: string; group: SensorGroup; description: string; low: string; high: string; neutral: number };

export const SENSOR_INFO: SensorInfo[] = [
  { index: 0, key: "headingError", label: "Heading error", group: "road", neutral: 0, description: "Angle from the kart's heading to a point 56–112 px down the road (farther when fast), divided by π.", low: "look-ahead point is to the left", high: "look-ahead point is to the right" },
  { index: 1, key: "curvature", label: "Curvature ahead", group: "road", neutral: 0, description: "How far the road direction at that look-ahead point is rotated relative to the kart's heading.", low: "road turns left", high: "road turns right" },
  { index: 2, key: "lateral", label: "Lateral offset", group: "position", neutral: 0, description: "Signed distance from the centre line in half-road-widths. ±1 is the edge of the asphalt.", low: "kart is left of centre", high: "kart is right of centre" },
  { index: 3, key: "speed", label: "Speed", group: "motion", neutral: 0.4, description: "Forward speed ÷ 90 px/s. Negative while reversing.", low: "reversing", high: "flat out" },
  { index: 4, key: "centerline", label: "Centre-line closeness", group: "position", neutral: 1, description: "1 − |lateral|: 1 on the centre line, 0 at the edge, negative once off the asphalt.", low: "off the road", high: "on the centre line" },
  { index: 5, key: "trafficClose", label: "Traffic closeness", group: "traffic", neutral: 0, description: "1 − distance ÷ 180 px to the nearest kart or road object. Zero when nothing is within 180 px.", low: "nothing near", high: "about to touch" },
  { index: 6, key: "trafficSide", label: "Traffic side", group: "traffic", neutral: 0, description: "Which side the nearest kart or object is on.", low: "on the left", high: "on the right" },
  { index: 7, key: "edgeClearance", label: "Edge clearance", group: "position", neutral: 1, description: "1 − distance from the centre line ÷ half-width. 1 means centred, 0 means touching the edge, negative means outside.", low: "outside the road", high: "centred" },
  { index: 8, key: "alignment", label: "Alignment", group: "position", neutral: 1, description: "cosine of the angle between the kart's heading and the road direction.", low: "facing backwards", high: "facing along the road" },
  { index: 9, key: "trafficAhead", label: "Traffic ahead / behind", group: "traffic", neutral: 0, description: "Where the nearest kart lies along the kart's heading.", low: "directly behind", high: "directly ahead" },
  { index: 10, key: "closingSpeed", label: "Closing speed", group: "traffic", neutral: 0, description: "(other speed − own speed) ÷ 90 for the nearest kart.", low: "closing in fast", high: "pulling away" },
  { index: 11, key: "curveNear", label: "Curvature at +30 px", group: "road", neutral: 0, description: "Road direction 30 px ahead, relative to the kart's heading.", low: "sharp left right ahead", high: "sharp right right ahead" },
  { index: 12, key: "curveFar", label: "Curvature at +150 px", group: "road", neutral: 0, description: "Road direction 150 px ahead: an early warning for bends the kart is not in yet.", low: "left bend coming", high: "right bend coming" },
  { index: 13, key: "checkpoint", label: "Checkpoint bearing", group: "road", neutral: 0, description: "Angle to the next checkpoint gate, divided by π.", low: "gate is to the left", high: "gate is to the right" },
  { index: 14, key: "lastSteer", label: "Last steering", group: "self", neutral: 0, description: "The kart's own steering command on the previous tick.", low: "was steering left", high: "was steering right" },
  { index: 15, key: "lastDrive", label: "Last gas − brake", group: "self", neutral: 0, description: "The kart's own throttle minus brake on the previous tick.", low: "was braking", high: "was accelerating" },
  { index: 16, key: "obstacle", label: "Obstacle flag", group: "traffic", neutral: 0, description: "1 when the nearest thing is a stalled car, barrier, cone or oil patch rather than a racing kart.", low: "racing kart or nothing", high: "static road object" },
];

export const SENSOR_GROUPS: Record<SensorGroup, string> = { road: "Road ahead", position: "Position on the road", motion: "Motion", traffic: "Traffic and objects", self: "Own last action" };

export type OutputKey = "steer" | "drive" | "reverse";
export const OUTPUT_INFO: { key: OutputKey; label: string; low: string; high: string; blurb: string }[] = [
  { key: "steer", label: "Steer", low: "left", high: "right", blurb: "Readout 0, from −1 (full left) to +1 (full right). The kart's steering rack then smooths it (about 0.24 per tick)." },
  { key: "drive", label: "Gas − brake", low: "brake", high: "gas", blurb: "Readout 1 minus readout 2. Positive becomes throttle, negative becomes brake, so the two can never fight." },
  { key: "reverse", label: "Reverse", low: "off", high: "reverse", blurb: "Readout 3, gated: nothing happens below 0.25; above it the kart reverses and cuts throttle. Used to get unstuck." },
];

export type RewardKey = Exclude<keyof RewardBreakdown, "total">;
export type RewardInfo = { key: RewardKey; label: string; kind: "gain" | "penalty"; config: keyof RewardConfig; unit: "per second" | "per event" | "per lap"; what: string; sensors: number[] };

export const REWARD_INFO: RewardInfo[] = [
  { key: "progress", label: "Progress", kind: "gain", config: "progressPerSecond", unit: "per lap", what: "Paid only for route the kart has never reached before, so reversing and replaying asphalt earns nothing. A full lap of new ground is worth this many points.", sensors: [13, 12, 0, 8] },
  { key: "direction", label: "Facing forward", kind: "gain", config: "correctDirectionPerSecond", unit: "per second", what: "Points for pointing along the road, scaled by alignment.", sensors: [8, 0] },
  { key: "movement", label: "Moving", kind: "gain", config: "movementPerSecond", unit: "per second", what: "Full credit at 60 px/s on the road; none while off the asphalt.", sensors: [3] },
  { key: "centerline", label: "Centre line", kind: "gain", config: "centerlinePerSecond", unit: "per second", what: "Pays 1 − |lateral offset|, so driving down the middle earns the most.", sensors: [4, 2] },
  { key: "checkpoint", label: "Checkpoint", kind: "gain", config: "checkpoint", unit: "per event", what: "One-off bonus for crossing the next gate, in order and facing forward.", sensors: [13] },
  { key: "finish", label: "Finish", kind: "gain", config: "finish", unit: "per event", what: "One-off bonus for completing the lap.", sensors: [13] },
  { key: "standingStill", label: "Standing still", kind: "penalty", config: "standingStillPerSecond", unit: "per second", what: "Charged while speed is under 3 px/s.", sensors: [3] },
  { key: "wrongDirection", label: "Wrong way", kind: "penalty", config: "wrongDirectionPerSecond", unit: "per second", what: "Scaled by how far the kart faces against the road direction.", sensors: [8, 0] },
  { key: "reverseProgress", label: "Backwards progress", kind: "penalty", config: "reverseProgressPerSecond", unit: "per lap", what: "Charged for sliding backwards along the route.", sensors: [3, 8] },
  { key: "offTrack", label: "Off track", kind: "penalty", config: "offTrackPerSecond", unit: "per second", what: "Charged while outside the asphalt, up to 4× worse the deeper the excursion.", sensors: [2, 7, 4] },
  { key: "edge", label: "Edge risk", kind: "penalty", config: "edgePenaltyPerSecond", unit: "per second", what: "Ramps up once the kart is more than 55% of the way to an edge, before it has left the road.", sensors: [2, 7, 4] },
  { key: "proximity", label: "Too close", kind: "penalty", config: "proximityPenaltyPerSecond", unit: "per second", what: "Charged when another kart or object is within roughly 2.75 car diameters.", sensors: [5, 6, 9, 10] },
  { key: "hazard", label: "Oil hazard", kind: "penalty", config: "hazardPenaltyPerSecond", unit: "per second", what: "Charged while driving over an oil patch (which also slows the kart).", sensors: [16, 5] },
  { key: "controlChange", label: "Jerky controls", kind: "penalty", config: "controlChangePerSecond", unit: "per second", what: "Charged for the total change in steering, throttle, brake and reverse between ticks.", sensors: [14, 15] },
  { key: "controlConflict", label: "Gas and brake together", kind: "penalty", config: "controlConflictPerSecond", unit: "per second", what: "Charged for pressing throttle and brake at the same time.", sensors: [15] },
  { key: "spikeEnergy", label: "Spike energy", kind: "penalty", config: "spikeEnergyPerSecond", unit: "per second", what: "Charged in proportion to the fraction of neurons spiking: the compute budget from Chapter 7.", sensors: [] },
  { key: "collision", label: "Collision", kind: "penalty", config: "collision", unit: "per event", what: "One-off charge each time the kart touches another kart or object.", sensors: [5, 6, 16] },
  { key: "crash", label: "Crash", kind: "penalty", config: "crash", unit: "per event", what: "One-off charge when the run ends in a crash.", sensors: [3, 7] },
];

/* ------------------------------------------------------------------ */
/* Reading brain files                                                 */
/* ------------------------------------------------------------------ */

export type BrainMeta = {
  format: string; version: number; generation: number | null; fitness: number | null; savedAt: string | null; track: string | null;
  sources: string[]; lineage: { name: string; generation: number; parents: string[] } | null; upgradedFromLegacy: boolean;
};
export type BrainFile = { snapshot: BrainSnapshot; meta: BrainMeta };

const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Accepts a downloaded "flykart-brain" checkpoint, the wrapper stored in
 * localStorage, or a bare network snapshot. Older 9-sensor brains are upgraded
 * exactly as the simulator does it. */
export function parseBrainFile(text: string, options: { allowSonar?: boolean } = {}): BrainFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("That file is not valid JSON."); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Expected a JSON object with a FlyKart network in it.");
  const object = raw as Record<string, unknown>;
  if (object.format !== undefined && object.format !== "flykart-brain") throw new Error(`This file's format is "${String(object.format)}", not a FlyKart brain checkpoint.`);
  const networkRaw = typeof object.network === "object" && object.network !== null ? object.network : Array.isArray(object.inputWeights) ? object : null;
  if (!networkRaw) throw new Error("No network found. Use \"Download brain\" in the simulator, or a raw network snapshot with inputWeights, recurrentWeights, outputWeights and bias.");
  const source = networkRaw as BrainSnapshot;
  let network: SpikingNetwork;
  try { network = SpikingNetwork.fromJSON(source); } catch (error) { throw new Error(error instanceof Error ? error.message : "The network weights could not be read."); }
  if (network.inputCount !== INPUT_COUNT && !options.allowSonar) throw new Error("This brain reads a sonar as well as the 17 usual sensors; open it in FlyKart Vision.");
  const provenance = Array.isArray(object.provenance) ? (object.provenance as Record<string, unknown>[]) : [];
  const lineage = typeof object.lineage === "object" && object.lineage !== null ? (object.lineage as { name?: unknown; generation?: unknown; parents?: unknown }) : null;
  return {
    snapshot: network.toJSON(),
    meta: {
      format: typeof object.format === "string" ? object.format : "network snapshot",
      version: source.version,
      generation: finiteOrNull(object.generation),
      fitness: finiteOrNull(object.fitness),
      savedAt: typeof object.savedAt === "string" ? object.savedAt : null,
      track: typeof object.track === "string" ? object.track : null,
      sources: provenance.map((entry) => (typeof entry.source === "string" ? entry.source : "")).filter(Boolean),
      lineage: lineage && typeof lineage.name === "string" ? { name: lineage.name, generation: finiteOrNull(lineage.generation) ?? 0, parents: Array.isArray(lineage.parents) ? lineage.parents.map(String) : [] } : null,
      upgradedFromLegacy: source.version === 1 || source.inputCount !== INPUT_COUNT || (Array.isArray(source.outputWeights) && source.outputWeights.length !== HIDDEN_COUNT * READOUT_COUNT),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Reading the weights                                                 */
/* ------------------------------------------------------------------ */

export type NeuronRole = "steer-right" | "steer-left" | "gas" | "brake" | "reverse" | "relay" | "silent";
export const ROLE_INFO: Record<NeuronRole, { label: string; color: string; blurb: string }> = {
  "steer-right": { label: "Steer right", color: "#ef6f61", blurb: "Spiking pushes the steering readout toward the right." },
  "steer-left": { label: "Steer left", color: "#67e8f9", blurb: "Spiking pushes the steering readout toward the left." },
  gas: { label: "Gas", color: "#d8e985", blurb: "Spiking raises gas minus brake." },
  brake: { label: "Brake", color: "#fbbf24", blurb: "Spiking lowers gas minus brake." },
  reverse: { label: "Reverse", color: "#c4b5fd", blurb: "Spiking feeds the gated reverse readout." },
  relay: { label: "Relay", color: "#8ca397", blurb: "Barely touches the readouts directly but drives other neurons through recurrent links." },
  silent: { label: "Weak", color: "#456054", blurb: "Little influence on the readouts or on other neurons." },
};

export type LayerStats = { count: number; meanAbs: number; maxAbs: number; positive: number; negative: number; nearZero: number };
export type NeuronSummary = {
  index: number; bias: number; role: NeuronRole; roleStrength: number;
  effect: { steer: number; drive: number; reverse: number };
  inputTop: { sensor: number; weight: number }[]; inputAbs: number;
  recurrentIn: number; recurrentOut: number; self: number;
  inTop: { neuron: number; weight: number }[]; outTop: { neuron: number; weight: number }[];
};
export type BrainAnalysis = {
  layers: { input: LayerStats; recurrent: LayerStats; output: LayerStats; bias: LayerStats };
  neurons: NeuronSummary[]; roleCounts: Record<NeuronRole, number>;
  /** First-order sensor → readout influence: Σ over neurons of (input weight × output weight). Ignores thresholds and recurrence. */
  pathway: Record<OutputKey, number[]>;
  /** Share of all input-weight magnitude that lands on each sensor. */
  sensorShare: number[];
  parameterCount: number; kilobytes: number; excitatoryShare: number;
};

function layerStats(values: ArrayLike<number>): LayerStats {
  let sumAbs = 0, maxAbs = 0, positive = 0, negative = 0, nearZero = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]; const abs = Math.abs(value);
    sumAbs += abs; if (abs > maxAbs) maxAbs = abs;
    if (abs < 0.02) nearZero += 1; else if (value > 0) positive += 1; else negative += 1;
  }
  return { count: values.length, meanAbs: values.length ? sumAbs / values.length : 0, maxAbs, positive, negative, nearZero };
}

const topBy = <T extends { weight: number }>(items: T[], count: number): T[] => [...items].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, count);

export function analyseBrain(snapshot: BrainSnapshot): BrainAnalysis {
  const { inputWeights, recurrentWeights, outputWeights, bias } = snapshot;
  const N = HIDDEN_COUNT, I = INPUT_COUNT;
  const effect = (j: number) => ({ steer: outputWeights[j], drive: outputWeights[N + j] - outputWeights[2 * N + j], reverse: outputWeights[3 * N + j] });
  const pathway: Record<OutputKey, number[]> = { steer: new Array(I).fill(0), drive: new Array(I).fill(0), reverse: new Array(I).fill(0) };
  const sensorAbs = new Array(I).fill(0); let totalAbs = 0;
  for (let j = 0; j < N; j += 1) {
    const e = effect(j);
    for (let i = 0; i < I; i += 1) {
      const w = inputWeights[j * I + i];
      pathway.steer[i] += w * e.steer; pathway.drive[i] += w * e.drive; pathway.reverse[i] += w * e.reverse;
      sensorAbs[i] += Math.abs(w); totalAbs += Math.abs(w);
    }
  }
  const strengths = Array.from({ length: N }, (_, j) => { const e = effect(j); return Math.max(Math.abs(e.steer), Math.abs(e.drive), Math.abs(e.reverse)); });
  const sortedStrengths = [...strengths].sort((a, b) => a - b);
  const reference = Math.max(1e-6, sortedStrengths[Math.floor(sortedStrengths.length * 0.9)] ?? 0);
  const outAbs = Array.from({ length: N }, (_, k) => { let sum = 0; for (let j = 0; j < N; j += 1) sum += Math.abs(recurrentWeights[j * N + k]); return sum; });
  const sortedOut = [...outAbs].sort((a, b) => a - b);
  const outReference = Math.max(1e-6, sortedOut[Math.floor(sortedOut.length * 0.75)] ?? 0);
  const roleCounts: Record<NeuronRole, number> = { "steer-right": 0, "steer-left": 0, gas: 0, brake: 0, reverse: 0, relay: 0, silent: 0 };
  const neurons: NeuronSummary[] = Array.from({ length: N }, (_, j) => {
    const e = effect(j);
    const inputs = Array.from({ length: I }, (_, i) => ({ sensor: i, weight: inputWeights[j * I + i] }));
    const ins = Array.from({ length: N }, (_, k) => ({ neuron: k, weight: recurrentWeights[j * N + k] })).filter((entry) => entry.neuron !== j);
    const outs = Array.from({ length: N }, (_, target) => ({ neuron: target, weight: recurrentWeights[target * N + j] })).filter((entry) => entry.neuron !== j);
    const magnitudes: [NeuronRole, number][] = [
      [e.steer >= 0 ? "steer-right" : "steer-left", Math.abs(e.steer)],
      [e.drive >= 0 ? "gas" : "brake", Math.abs(e.drive)],
      [e.reverse >= 0 ? "reverse" : "silent", e.reverse >= 0 ? Math.abs(e.reverse) : 0],
    ];
    const dominant = magnitudes.reduce((best, entry) => (entry[1] > best[1] ? entry : best), magnitudes[0]);
    let role: NeuronRole;
    if (dominant[1] >= reference * 0.3) role = dominant[0];
    else role = outAbs[j] >= outReference ? "relay" : "silent";
    roleCounts[role] += 1;
    return {
      index: j, bias: bias[j], role, roleStrength: dominant[1], effect: e,
      inputTop: topBy(inputs, 4), inputAbs: inputs.reduce((sum, entry) => sum + Math.abs(entry.weight), 0),
      recurrentIn: ins.reduce((sum, entry) => sum + Math.abs(entry.weight), 0), recurrentOut: outAbs[j] - Math.abs(recurrentWeights[j * N + j]), self: recurrentWeights[j * N + j],
      inTop: topBy(ins, 4), outTop: topBy(outs, 4),
    };
  });
  const recurrent = layerStats(recurrentWeights);
  return {
    layers: { input: layerStats(inputWeights), recurrent, output: layerStats(outputWeights), bias: layerStats(bias) },
    neurons, roleCounts, pathway, sensorShare: sensorAbs.map((value) => (totalAbs > 0 ? value / totalAbs : 0)),
    parameterCount: inputWeights.length + recurrentWeights.length + outputWeights.length + bias.length,
    kilobytes: (inputWeights.length + recurrentWeights.length + outputWeights.length + bias.length) * 4 / 1024,
    excitatoryShare: recurrent.positive + recurrent.negative > 0 ? recurrent.positive / (recurrent.positive + recurrent.negative) : 0,
  };
}

/** Cut a neuron's axon: it still integrates and spikes, but nothing it sends reaches a readout or another neuron. */
export function silenceNeurons(snapshot: BrainSnapshot, ids: number[]): BrainSnapshot {
  const copy: BrainSnapshot = { ...snapshot, inputWeights: [...snapshot.inputWeights], recurrentWeights: [...snapshot.recurrentWeights], outputWeights: [...snapshot.outputWeights], bias: [...snapshot.bias] };
  ids.forEach((id) => {
    if (id < 0 || id >= HIDDEN_COUNT) return;
    for (let output = 0; output < READOUT_COUNT; output += 1) copy.outputWeights[output * HIDDEN_COUNT + id] = 0;
    for (let target = 0; target < HIDDEN_COUNT; target += 1) copy.recurrentWeights[target * HIDDEN_COUNT + id] = 0;
  });
  return copy;
}

/* ------------------------------------------------------------------ */
/* Poking the brain with chosen sensor values                          */
/* ------------------------------------------------------------------ */

export type ProbeFrame = { action: Action; readouts: number[]; steer: number; drive: number; reverse: number; spikes: Uint8Array; potentials: number[] };

export class Probe {
  private readonly network: SpikingNetwork;
  constructor(snapshot: BrainSnapshot) { this.network = SpikingNetwork.fromJSON(snapshot); }
  reset(): void { this.network.reset(); }
  step(sensors: number[]): ProbeFrame {
    const action = this.network.step(sensors);
    const activity = this.network.activity();
    const readouts = [...activity.outputs];
    return { action, readouts, steer: readouts[0], drive: readouts[1] - readouts[2], reverse: readouts[3], spikes: Uint8Array.from(activity.spikes), potentials: [...this.network.potentials()] };
  }
  /** Hold the sensors steady and average the last few ticks once the smoothed readouts have settled. */
  settle(sensors: number[], ticks = 34, average = 12): { steer: number; drive: number; reverse: number; spikeFraction: number } {
    this.network.reset();
    let steer = 0, drive = 0, reverse = 0, spikes = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      const frame = this.step(sensors);
      if (tick >= ticks - average) { steer += frame.steer; drive += frame.drive; reverse += frame.reverse; spikes += frame.spikes.reduce((sum, value) => sum + value, 0); }
    }
    return { steer: steer / average, drive: drive / average, reverse: reverse / average, spikeFraction: spikes / (average * HIDDEN_COUNT) };
  }
}

export type ResponseCurves = {
  xs: number[];
  steer: number[][]; drive: number[][]; reverse: number[][]; spikeFraction: number[][];
  /** Range of each output across the sweep, per sensor. */
  swing: Record<OutputKey, number[]>;
};

/** Sweep each sensor from −1 to +1 while the others stay at `base`, letting the brain settle at every step. */
export function responseCurves(snapshot: BrainSnapshot, base: number[], points = 21): ResponseCurves {
  const probe = new Probe(snapshot);
  const xs = Array.from({ length: points }, (_, index) => -1 + (2 * index) / (points - 1));
  const out: ResponseCurves = { xs, steer: [], drive: [], reverse: [], spikeFraction: [], swing: { steer: [], drive: [], reverse: [] } };
  for (let sensor = 0; sensor < INPUT_COUNT; sensor += 1) {
    const rows = { steer: [] as number[], drive: [] as number[], reverse: [] as number[], spikeFraction: [] as number[] };
    xs.forEach((x) => {
      const sensors = [...base]; sensors[sensor] = x;
      const result = probe.settle(sensors);
      rows.steer.push(result.steer); rows.drive.push(result.drive); rows.reverse.push(result.reverse); rows.spikeFraction.push(result.spikeFraction);
    });
    out.steer.push(rows.steer); out.drive.push(rows.drive); out.reverse.push(rows.reverse); out.spikeFraction.push(rows.spikeFraction);
    (["steer", "drive", "reverse"] as OutputKey[]).forEach((key) => out.swing[key].push(Math.max(...rows[key]) - Math.min(...rows[key])));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Driving the real simulator                                          */
/* ------------------------------------------------------------------ */

export type TrackSummary = { id: TrackId; name: string; length: number; width: number; points: Vec[] };
export const trackList = (): TrackSummary[] => TRACKS.map((track) => ({ id: track.id, name: track.name, length: track.length, width: track.width, points: track.points.map((p) => ({ x: p.x, y: p.y })) }));
export function checkpointGates(trackId: TrackId, count = 8): { point: Vec; tangent: Vec }[] {
  return Array.from({ length: count }, (_, index) => { const gate = trackCheckpoint(index, trackId, count); return { point: gate.point, tangent: gate.tangent }; });
}

export type DriveOptions = { trackId: TrackId; rivals: number; roadObjects: number; objectKind: RoadObjectKind | "mixed"; seed: number; walls: boolean };
export type CarView = { x: number; y: number; heading: number; speed: number; isObstacle: boolean; kind?: RoadObjectKind; color: string; name: string };
export type DriveFrame = {
  tick: number; seconds: number;
  car: CarView & { progress: number; lateral: number; alignment: number; laps: number; checkpoints: number; nextCheckpoint: number; finished: boolean; crashed: boolean; crashReason?: string; steering: number; offTrack: boolean; collisions: number; nearestOpponent: number };
  others: CarView[];
  sensors: number[]; action: Action; readouts: number[]; spikes: Uint8Array; potentials: number[];
  reward: RewardBreakdown; totals: RewardBreakdown; events: string[];
  /** Points on the road that the sensors are looking at: nearest centre-line point, +30 px, look-ahead, +150 px, and the next checkpoint. */
  guides: { center: Vec; tangent: Vec; near: Vec; look: Vec; far: Vec; checkpoint: Vec };
};

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const scaleVec = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });

function makeRoadObject(route: TrackDefinition, distanceAlong: number, lane: number, kind: RoadObjectKind, label: number): Car {
  const sample = pointAtDistance(distanceAlong, route); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
  const car = startPosition(lane * 0.92, route);
  car.position = add(sample.point, scaleVec(normal, lane * LANE_SPACING * 0.92)); car.heading = Math.atan2(sample.tangent.y, sample.tangent.x);
  const nearest = nearestTrack(car.position, route); car.progress = nearest.progress; car.distanceAlong = nearest.distanceAlong; car.bestProgress = nearest.progress;
  car.speed = 0; car.action = { steer: 0, throttle: 0, brake: 1, reverse: 0 };
  car.color = kind === "barrier" ? "#e0a15b" : kind === "cone" ? "#f08b47" : kind === "oil" ? "#8275c8" : "#d07c72";
  car.name = `${kind} ${label}`; car.isObstacle = true; car.obstacleKind = kind;
  return car;
}

const view = (car: Car): CarView => ({ x: car.position.x, y: car.position.y, heading: car.heading, speed: car.speed, isObstacle: car.isObstacle, kind: car.obstacleKind, color: car.color, name: car.name });
const copyReward = (reward: RewardBreakdown): RewardBreakdown => ({ ...reward });

export class DriveSession {
  readonly route: TrackDefinition;
  readonly options: DriveOptions;
  private snapshot: BrainSnapshot;
  private network: SpikingNetwork;
  private car!: Car;
  private rivals: Car[] = [];
  private roadObjects: Car[] = [];
  private physics: PhysicsConfig;
  private tick = 0;
  private extraObjects = 0;

  constructor(snapshot: BrainSnapshot, options: DriveOptions) {
    this.snapshot = snapshot;
    this.options = options;
    this.route = resolveTrack(options.trackId);
    this.network = SpikingNetwork.fromJSON(snapshot);
    this.physics = { ...DEFAULT_PHYSICS_CONFIG, wallsEnabled: options.walls, adaptiveTimeLimit: false };
    this.reset();
  }

  private get cars(): Car[] { return [this.car, ...this.rivals, ...this.roadObjects]; }

  reset(): void {
    const route = this.route;
    this.car = startPosition(0, route); this.car.network = this.network; this.network.reset();
    this.car.timeLimit = Number.MAX_SAFE_INTEGER; this.car.name = "your brain"; this.car.color = "#ffd166";
    const line = startLine(route);
    const rivals = [startPosition(-1, route), startPosition(1, route)];
    rivals[0].position = add(rivals[0].position, scaleVec(line.tangent, 55)); rivals[1].position = add(rivals[1].position, scaleVec(line.tangent, 115));
    rivals.forEach((rival, index) => { rival.name = `rival ${index + 1}`; rival.timeLimit = Number.MAX_SAFE_INTEGER; });
    this.rivals = rivals.slice(0, Math.max(0, Math.min(2, Math.floor(this.options.rivals))));
    this.roadObjects = createRoadObstacles(this.options.roadObjects, route, this.options.seed, this.options.objectKind);
    this.tick = 0; this.extraObjects = 0;
  }

  /** Swap in a different set of weights (for example with neurons silenced) without moving the kart. */
  setSnapshot(snapshot: BrainSnapshot): void {
    this.snapshot = snapshot;
    this.network = SpikingNetwork.fromJSON(snapshot);
    this.car.network = this.network;
  }
  getSnapshot(): BrainSnapshot { return this.snapshot; }

  /** Put the kart at a chosen position across the road: −1 is the left edge, +1 the right edge, 0 the centre line. */
  placeAcrossRoad(fraction: number): void {
    const target = Math.max(-1.4, Math.min(1.4, fraction)), half = this.route.width / 2;
    // Near a polygon corner the closest road segment changes as the kart moves, so
    // nudge repeatedly until the measured offset matches what was asked for.
    for (let pass = 0; pass < 6; pass += 1) {
      const near = nearestTrack(this.car.position, this.route, this.car.distanceAlong);
      const offset = { x: this.car.position.x - near.point.x, y: this.car.position.y - near.point.y };
      const current = (near.tangent.x * offset.y - near.tangent.y * offset.x) / half;
      const error = target - current;
      if (Math.abs(error) < 0.01) break;
      this.car.position = add(this.car.position, scaleVec({ x: -near.tangent.y, y: near.tangent.x }, error * half));
    }
    this.car.steering = 0;
  }
  /** Rotate the kart relative to the road direction, in degrees (positive turns right). */
  aimRelativeToRoad(degrees: number): void {
    const near = nearestTrack(this.car.position, this.route, this.car.distanceAlong);
    this.car.heading = Math.atan2(near.tangent.y, near.tangent.x) + (degrees * Math.PI) / 180;
    this.car.steering = 0;
  }
  setSpeed(speed: number): void { this.car.speed = Math.max(-48, Math.min(90, speed)); }
  dropObject(kind: RoadObjectKind, distanceAhead = 150, lane = 0): void {
    this.extraObjects += 1;
    this.roadObjects.push(makeRoadObject(this.route, this.car.distanceAlong + distanceAhead, lane, kind, 100 + this.extraObjects));
  }
  clearObjects(): void { this.roadObjects = []; }

  step(): DriveFrame {
    const car = this.car; const cars = this.cars; const route = this.route;
    const before = { checkpoints: car.checkpointsPassed, collisions: car.collisions, offTrack: car.nearestDistance > route.width / 2 };
    const sensors = sensorValues(car, cars, route);
    const action = this.network.step(sensors);
    const botActions = this.rivals.map((bot) => heuristicAction(bot, cars, route));
    stepCar(car, action, cars, route, DEFAULT_REWARD_CONFIG, this.physics);
    this.rivals.forEach((bot, index) => stepCar(bot, botActions[index], cars, route, DEFAULT_REWARD_CONFIG, { ...this.physics, ruthlessCulling: false }));
    this.tick += 1;
    const activity = this.network.activity();
    const offTrack = car.nearestDistance > route.width / 2;
    const events: string[] = [];
    if (car.checkpointsPassed > before.checkpoints) events.push(car.finished ? "lap complete" : `checkpoint ${car.checkpointsPassed}`);
    if (car.collisions > before.collisions) events.push("contact");
    if (offTrack && !before.offTrack) events.push("left the asphalt");
    if (!offTrack && before.offTrack) events.push("back on the road");
    if (car.crashed) events.push(`crash: ${car.crashReason ?? "unknown"}`);
    const here = nearestTrack(car.position, route, car.distanceAlong);
    const lookDistance = Math.max(56, Math.min(112, 56 + Math.abs(car.speed) * 0.42));
    const guides = {
      center: here.point, tangent: here.tangent,
      near: pointAtDistance(here.distanceAlong + 30, route).point, look: pointAtDistance(here.distanceAlong + lookDistance, route).point, far: pointAtDistance(here.distanceAlong + 150, route).point,
      checkpoint: trackCheckpoint(car.nextCheckpoint % 8, route, 8).point,
    };
    return {
      tick: this.tick, seconds: this.tick * STEP, guides,
      car: { ...view(car), progress: car.totalProgress, lateral: car.lateralOffset, alignment: car.forwardAlignment, laps: car.laps, checkpoints: car.checkpointsPassed, nextCheckpoint: car.nextCheckpoint, finished: car.finished, crashed: car.crashed, crashReason: car.crashReason, steering: car.steering, offTrack, collisions: car.collisions, nearestOpponent: car.nearestOpponentDistance },
      others: [...this.rivals, ...this.roadObjects].map(view),
      sensors, action, readouts: [...activity.outputs], spikes: Uint8Array.from(activity.spikes), potentials: [...this.network.potentials()],
      reward: copyReward(car.rewardBreakdown), totals: copyReward(car.rewardTotals), events,
    };
  }
}

export const CAR_SIZE = { length: CAR_LENGTH, width: CAR_WIDTH };
