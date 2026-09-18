export type Vec = { x: number; y: number };
export type Action = { steer: number; throttle: number; brake: number; reverse?: number };
export type Sensors = number[];
export type TrackId = "grand-loop" | "switchback" | "zigzag" | "hairpin" | "oval-sprint" | "sharp-turn" | "deep-hairpin" | "chicane" | "corkscrew" | "mountain-pass" | "tight-corners";
export type TrackRef = TrackDefinition | TrackId;
export type PhysicsConfig = { wallsEnabled: boolean; adaptiveTimeLimit?: boolean; maxAdaptiveExtensions?: number; checkpointCount?: number };

export type TrackDefinition = {
  id: TrackId;
  name: string;
  points: Vec[];
  width: number;
  segmentLengths: number[];
  cumulativeLengths: number[];
  length: number;
};

export const TRACK_WIDTH = 112;
export const CAR_LENGTH = 24;
export const CAR_WIDTH = 14;
export const CAR_COLLISION_DIAMETER = Math.hypot(CAR_LENGTH, CAR_WIDTH) * 0.78;
export const LANE_SPACING = 32;
export const STEP = 1 / 30;
export const MAX_TICKS = 1500;
export const TAU = Math.PI * 2;
export const CHECKPOINT_COUNT = 8;
export const ADAPTIVE_REWARD_WINDOW_TICKS = 300;
export const MAX_ADAPTIVE_EXTENSIONS = 6;
export const CLOSE_PROXIMITY_DISTANCE = CAR_COLLISION_DIAMETER * 2.75;
export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = { wallsEnabled: true, adaptiveTimeLimit: false, maxAdaptiveExtensions: MAX_ADAPTIVE_EXTENSIONS };

function createTrack(id: TrackId, name: string, points: Vec[], width = TRACK_WIDTH): TrackDefinition {
  const segmentLengths = points.map((point, index) => Math.hypot(point.x - points[(index + 1) % points.length].x, point.y - points[(index + 1) % points.length].y));
  const cumulativeLengths: number[] = [0];
  segmentLengths.forEach((segmentLength) => cumulativeLengths.push(cumulativeLengths[cumulativeLengths.length - 1] + segmentLength));
  return { id, name, points, width, segmentLengths, cumulativeLengths, length: cumulativeLengths[cumulativeLengths.length - 1] };
}

export const TRACKS: TrackDefinition[] = [
  createTrack("grand-loop", "Grand loop", [
    { x: -310, y: -100 }, { x: -205, y: -165 }, { x: -30, y: -185 },
    { x: 170, y: -155 }, { x: 305, y: -65 }, { x: 315, y: 70 },
    { x: 195, y: 155 }, { x: 5, y: 180 }, { x: -190, y: 145 },
    { x: -315, y: 50 },
  ]),
  createTrack("switchback", "Switchback", [
    { x: -325, y: -120 }, { x: -205, y: -185 }, { x: 45, y: -185 },
    { x: 300, y: -120 }, { x: 330, y: -20 }, { x: 90, y: 20 },
    { x: -160, y: 30 }, { x: -285, y: 105 }, { x: -130, y: 180 },
    { x: 135, y: 175 }, { x: 320, y: 105 }, { x: 275, y: 20 },
    { x: 30, y: -20 }, { x: -220, y: -35 },
  ]),
  createTrack("zigzag", "Zigzag", [
    { x: -325, y: -80 }, { x: -245, y: -175 }, { x: -40, y: -135 },
    { x: 100, y: -205 }, { x: 290, y: -135 }, { x: 325, y: -10 },
    { x: 180, y: 55 }, { x: 300, y: 150 }, { x: 115, y: 190 },
    { x: -65, y: 125 }, { x: -210, y: 190 }, { x: -330, y: 95 },
  ]),
  createTrack("hairpin", "Hairpin", [
    { x: -205, y: -155 }, { x: 180, y: -155 }, { x: 230, y: -145 }, { x: 270, y: -115 },
    { x: 300, y: -70 }, { x: 315, y: -15 }, { x: 310, y: 40 }, { x: 285, y: 90 },
    { x: 245, y: 125 }, { x: 185, y: 150 }, { x: -180, y: 150 }, { x: -235, y: 135 },
    { x: -280, y: 105 }, { x: -310, y: 60 }, { x: -325, y: 5 }, { x: -320, y: -50 },
    { x: -295, y: -100 }, { x: -250, y: -135 },
  ]),
  createTrack("oval-sprint", "Oval sprint", [
    { x: -325, y: -125 }, { x: -235, y: -190 }, { x: 160, y: -190 }, { x: 315, y: -105 },
    { x: 325, y: 95 }, { x: 215, y: 180 }, { x: -180, y: 180 }, { x: -325, y: 90 },
  ]),
  createTrack("sharp-turn", "Sharp turn", [
    { x: -330, y: -145 }, { x: 225, y: -145 }, { x: 295, y: -90 }, { x: 295, y: 125 },
    { x: 240, y: 165 }, { x: -285, y: 165 }, { x: -345, y: 105 }, { x: -345, y: -85 },
  ]),
  createTrack("deep-hairpin", "Deep hairpin", [
    { x: -210, y: -150 }, { x: 170, y: -150 }, { x: 235, y: -145 }, { x: 285, y: -120 },
    { x: 320, y: -65 }, { x: 325, y: 5 }, { x: 300, y: 70 }, { x: 245, y: 120 },
    { x: 170, y: 145 }, { x: 95, y: 120 }, { x: -190, y: 100 }, { x: -245, y: 95 },
    { x: -295, y: 65 }, { x: -325, y: 10 }, { x: -325, y: -55 }, { x: -295, y: -110 },
    { x: -245, y: -145 },
  ]),
  createTrack("chicane", "Chicane", [
    { x: -340, y: -160 }, { x: -270, y: -205 }, { x: -150, y: -190 }, { x: -50, y: -115 },
    { x: 50, y: -60 }, { x: 150, y: -95 }, { x: 250, y: -170 }, { x: 325, y: -105 },
    { x: 340, y: -15 }, { x: 285, y: 55 }, { x: 190, y: 35 }, { x: 100, y: 90 },
    { x: 20, y: 180 }, { x: -100, y: 205 }, { x: -210, y: 155 }, { x: -300, y: 190 },
    { x: -350, y: 110 }, { x: -300, y: 30 }, { x: -345, y: -25 },
  ]),
  createTrack("corkscrew", "Corkscrew", [
    { x: -315, y: -125 }, { x: -250, y: -195 }, { x: -105, y: -215 }, { x: 20, y: -165 },
    { x: 80, y: -75 }, { x: 190, y: -35 }, { x: 300, y: -80 }, { x: 335, y: 10 },
    { x: 285, y: 90 }, { x: 200, y: 70 }, { x: 140, y: 125 }, { x: 185, y: 195 },
    { x: 70, y: 215 }, { x: -30, y: 165 }, { x: -115, y: 100 }, { x: -210, y: 145 },
    { x: -325, y: 95 }, { x: -340, y: 10 }, { x: -275, y: -45 },
  ]),
  createTrack("mountain-pass", "Mountain pass", [
    { x: -340, y: -120 }, { x: -285, y: -195 }, { x: -180, y: -145 }, { x: -80, y: -215 },
    { x: 30, y: -150 }, { x: 130, y: -215 }, { x: 260, y: -160 }, { x: 335, y: -75 },
    { x: 280, y: -10 }, { x: 335, y: 65 }, { x: 255, y: 145 }, { x: 320, y: 190 },
    { x: 185, y: 215 }, { x: 85, y: 155 }, { x: -20, y: 215 }, { x: -135, y: 155 },
    { x: -255, y: 205 }, { x: -340, y: 135 }, { x: -290, y: 55 }, { x: -350, y: 10 },
  ]),
  createTrack("tight-corners", "Tight corners", [
    { x: -315, y: -170 }, { x: -70, y: -170 }, { x: -15, y: -125 }, { x: 55, y: -170 },
    { x: 250, y: -170 }, { x: 325, y: -100 }, { x: 315, y: -25 }, { x: 250, y: 25 },
    { x: 315, y: 85 }, { x: 280, y: 165 }, { x: 80, y: 165 }, { x: 20, y: 110 },
    { x: -55, y: 165 }, { x: -275, y: 165 }, { x: -345, y: 95 }, { x: -330, y: 20 },
    { x: -270, y: -25 }, { x: -330, y: -95 },
  ]),
];

export const DEFAULT_TRACK = TRACKS[0];
// Kept as a point array for the original public API and existing experiments.
export const track: Vec[] = DEFAULT_TRACK.points;

export function resolveTrack(trackRef: TrackRef = DEFAULT_TRACK): TrackDefinition {
  if (typeof trackRef !== "string") return trackRef;
  const result = TRACKS.find((candidate) => candidate.id === trackRef);
  if (!result) throw new Error(`unknown track id: ${trackRef}`);
  return result;
}

export type TrackDiagnostics = {
  length: number;
  cornerCount: number;
  hardTurnCount: number;
  maxTurnDegrees: number;
  maxTurnSweepDegrees: number;
  averageTurnDegrees: number;
  minSegmentLength: number;
};

export function trackDiagnostics(trackRef: TrackRef = DEFAULT_TRACK): TrackDiagnostics {
  const route = resolveTrack(trackRef);
  const signedTurns = route.points.map((point, index) => {
    const previous = route.points[(index - 1 + route.points.length) % route.points.length];
    const next = route.points[(index + 1) % route.points.length];
    const incoming = Math.atan2(point.y - previous.y, point.x - previous.x);
    const outgoing = Math.atan2(next.y - point.y, next.x - point.x);
    return wrapAngle(outgoing - incoming) * 180 / Math.PI;
  });
  const turns = signedTurns.map(Math.abs);
  const hardTurns = turns.filter((turn) => turn >= 60);
  // A hairpin can be made from many gentle vertices, so the largest local
  // angle alone hides how much steering is required. Start after a straight
  // section when possible and accumulate contiguous turns in the same
  // direction; this reports a useful sweep without counting both sides of a
  // whole closed lap as one corner.
  const turnSamples = signedTurns.map((turn, index) => ({
    turn,
    // Sparse route definitions represent long straights as one segment, so
    // they may have no explicit zero-angle vertex. Treat either side of a
    // long segment as a sweep boundary as well.
    isStraight: Math.abs(turn) < 4
      || route.segmentLengths[index] >= 180
      || route.segmentLengths[(index - 1 + route.points.length) % route.points.length] >= 180,
  }));
  const straightIndex = turnSamples.findIndex((sample) => sample.isStraight);
  const orderedTurns = straightIndex >= 0
    ? [...turnSamples.slice(straightIndex + 1), ...turnSamples.slice(0, straightIndex + 1)]
    : turnSamples;
  let activeDirection = 0;
  let activeSweep = 0;
  let maxTurnSweep = 0;
  orderedTurns.forEach((sample) => {
    const magnitude = Math.abs(sample.turn);
    const direction = Math.sign(sample.turn);
    if (sample.isStraight || magnitude < 4 || direction === 0) {
      maxTurnSweep = Math.max(maxTurnSweep, activeSweep);
      activeDirection = 0;
      activeSweep = 0;
    } else if (activeDirection === direction) {
      activeSweep += magnitude;
    } else {
      maxTurnSweep = Math.max(maxTurnSweep, activeSweep);
      activeDirection = direction;
      activeSweep = magnitude;
    }
  });
  maxTurnSweep = Math.max(maxTurnSweep, activeSweep);
  return {
    length: route.length,
    cornerCount: turns.filter((turn) => turn >= 8).length,
    hardTurnCount: hardTurns.length,
    maxTurnDegrees: Math.max(...turns),
    maxTurnSweepDegrees: maxTurnSweep,
    averageTurnDegrees: turns.reduce((sum, turn) => sum + turn, 0) / turns.length,
    minSegmentLength: Math.min(...route.segmentLengths),
  };
}

export type RewardConfig = {
  progressPerSecond: number;
  correctDirectionPerSecond: number;
  movementPerSecond: number;
  standingStillPerSecond: number;
  wrongDirectionPerSecond: number;
  reverseProgressPerSecond: number;
  offTrackPerSecond: number;
  edgePenaltyPerSecond: number;
  proximityPenaltyPerSecond: number;
  centerlinePerSecond?: number;
  collision: number;
  crash: number;
  checkpoint: number;
  finish: number;
};

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  progressPerSecond: 14,
  correctDirectionPerSecond: 1.25,
  movementPerSecond: 0.2,
  standingStillPerSecond: 0.85,
  wrongDirectionPerSecond: 2.5,
  reverseProgressPerSecond: 3,
  offTrackPerSecond: 24,
  edgePenaltyPerSecond: 1.2,
  proximityPenaltyPerSecond: 10,
  centerlinePerSecond: 0.35,
  collision: 10,
  crash: 75,
  checkpoint: 100,
  finish: 300,
};

export type RewardBreakdown = {
  progress: number;
  direction: number;
  movement: number;
  standingStill: number;
  wrongDirection: number;
  reverseProgress: number;
  offTrack: number;
  edge: number;
  proximity: number;
  centerline: number;
  collision: number;
  crash: number;
  checkpoint: number;
  finish: number;
  total: number;
};

export type RewardTotals = RewardBreakdown;

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
const hash = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec, amount: number): Vec => ({ x: a.x * amount, y: a.y * amount });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const normalize = (a: Vec): Vec => scale(a, 1 / (Math.hypot(a.x, a.y) || 1));

export type NeuronSnapshot = { spikes: number[]; outputs: number[] };
export type BrainSnapshot = {
  version: 1;
  inputCount: number;
  hiddenCount: number;
  inputWeights: number[];
  recurrentWeights: number[];
  outputWeights: number[];
  bias: number[];
  outputCount?: number;
};

export class SpikingNetwork {
  readonly inputCount = 9;
  readonly hiddenCount = 48;
  private readonly inputWeights: number[];
  private readonly recurrentWeights: number[];
  private readonly outputWeights: number[];
  private readonly bias: number[];
  private voltage: number[];
  private spikes: number[];
  private readonly snapshot: NeuronSnapshot;

  constructor(seed = Math.random()) {
    const random = () => hash(seed += 1.234567) * 2 - 1;
    this.inputWeights = Array.from({ length: this.hiddenCount * this.inputCount }, () => random() * 0.8);
    this.recurrentWeights = Array.from({ length: this.hiddenCount * this.hiddenCount }, () => random() * 0.16);
    // Four outputs: steer, throttle, brake, and a gated reverse request.
    // fromJSON still accepts the original three-output checkpoints.
    this.outputWeights = Array.from({ length: 4 * this.hiddenCount }, () => random() * 0.5);
    this.bias = Array.from({ length: this.hiddenCount }, () => random() * 0.06);
    this.voltage = new Array(this.hiddenCount).fill(0);
    this.spikes = new Array(this.hiddenCount).fill(0);
    this.snapshot = { spikes: [...this.spikes], outputs: [0, 0, 0, 0] };
  }

  clone(): SpikingNetwork {
    const result = new SpikingNetwork(0.5);
    result.inputWeights.splice(0, result.inputWeights.length, ...this.inputWeights);
    result.recurrentWeights.splice(0, result.recurrentWeights.length, ...this.recurrentWeights);
    result.outputWeights.splice(0, result.outputWeights.length, ...this.outputWeights);
    result.bias.splice(0, result.bias.length, ...this.bias);
    return result;
  }

  mutate(rate: number, amount: number, seed: number): SpikingNetwork {
    const result = this.clone();
    let cursor = seed;
    const noise = () => {
      cursor += 1; const a = hash(cursor) * 2 - 1;
      cursor += 1; const b = hash(cursor) * 2 - 1;
      return Math.sqrt(-2 * Math.log(Math.max(0.0001, (a + 1) / 2))) * Math.cos(TAU * (b + 1) / 2);
    };
    const change = (weights: number[]) => weights.forEach((value, index) => {
      if (hash(cursor += 1) < rate) weights[index] = value + noise() * amount;
    });
    change(result.inputWeights); change(result.recurrentWeights); change(result.outputWeights); change(result.bias);
    return result;
  }

  crossover(partner: SpikingNetwork, seed: number, partnerProbability = 0.5): SpikingNetwork {
    const result = this.clone(); let cursor = seed;
    const choose = (first: number, second: number): number => { cursor += 1; return hash(cursor) < partnerProbability ? second : first; };
    const combine = (target: number[], first: number[], second: number[]): void => target.forEach((_, index) => { target[index] = choose(first[index], second[index]); });
    combine(result.inputWeights, this.inputWeights, partner.inputWeights);
    combine(result.recurrentWeights, this.recurrentWeights, partner.recurrentWeights);
    combine(result.outputWeights, this.outputWeights, partner.outputWeights);
    combine(result.bias, this.bias, partner.bias);
    result.reset(); return result;
  }

  reset(): void {
    this.voltage.fill(0); this.spikes.fill(0); this.snapshot.spikes.fill(0); this.snapshot.outputs.fill(0);
  }

  step(inputs: Sensors): Action {
    if (inputs.length !== this.inputCount || inputs.some((value) => !Number.isFinite(value))) throw new Error("invalid neural input vector");
    const nextSpikes = new Array(this.hiddenCount).fill(0);
    for (let neuron = 0; neuron < this.hiddenCount; neuron += 1) {
      let current = this.bias[neuron];
      for (let input = 0; input < this.inputCount; input += 1) current += this.inputWeights[neuron * this.inputCount + input] * inputs[input];
      for (let previous = 0; previous < this.hiddenCount; previous += 1) current += this.recurrentWeights[neuron * this.hiddenCount + previous] * this.spikes[previous];
      const voltage = this.voltage[neuron] * 0.86 + current * 0.22;
      nextSpikes[neuron] = voltage > 0.42 ? 1 : 0;
      this.voltage[neuron] = nextSpikes[neuron] === 1 ? 0 : voltage;
    }
    this.spikes = nextSpikes;
    const outputs = [0, 0, 0, 0];
    for (let output = 0; output < outputs.length; output += 1) {
      for (let neuron = 0; neuron < this.hiddenCount; neuron += 1) outputs[output] += this.outputWeights[output * this.hiddenCount + neuron] * this.spikes[neuron];
      outputs[output] = Math.tanh(outputs[output]);
    }
    this.snapshot.spikes = [...this.spikes]; this.snapshot.outputs = outputs;
    // Reverse is deliberately gated: a neutral/legacy brain keeps reverse at zero,
    // while evolution can learn a distinct reverse signal when it is useful.
    const reverse = clamp((outputs[3] - 0.25) / 0.75, 0, 1);
    return { steer: outputs[0], throttle: (outputs[1] + 1) / 2, brake: (outputs[2] + 1) / 2, reverse };
  }

  activity(): NeuronSnapshot { return this.snapshot; }

  toJSON(): BrainSnapshot {
    return { version: 1, inputCount: this.inputCount, hiddenCount: this.hiddenCount, outputCount: 4,
      inputWeights: [...this.inputWeights], recurrentWeights: [...this.recurrentWeights], outputWeights: [...this.outputWeights], bias: [...this.bias] };
  }

  static fromJSON(snapshot: BrainSnapshot): SpikingNetwork {
    const arrays = [snapshot.inputWeights, snapshot.recurrentWeights, snapshot.outputWeights, snapshot.bias];
    if (snapshot.version !== 1 || snapshot.inputCount !== 9 || snapshot.hiddenCount !== 48 || arrays.some((value) => !Array.isArray(value) || value.some((item) => !Number.isFinite(item)))) throw new Error("checkpoint format does not match this FlyKart build");
    const legacyOutputLength = snapshot.hiddenCount * 3;
    const currentOutputLength = snapshot.hiddenCount * 4;
    if (snapshot.inputWeights.length !== snapshot.inputCount * snapshot.hiddenCount || snapshot.recurrentWeights.length !== snapshot.hiddenCount ** 2 || (snapshot.outputWeights.length !== legacyOutputLength && snapshot.outputWeights.length !== currentOutputLength) || snapshot.bias.length !== snapshot.hiddenCount) throw new Error("checkpoint dimensions are invalid");
    const result = new SpikingNetwork(0.5);
    result.inputWeights.splice(0, result.inputWeights.length, ...snapshot.inputWeights);
    result.recurrentWeights.splice(0, result.recurrentWeights.length, ...snapshot.recurrentWeights);
    const outputWeights = snapshot.outputWeights.length === legacyOutputLength ? [...snapshot.outputWeights, ...new Array(result.hiddenCount).fill(0)] : snapshot.outputWeights;
    result.outputWeights.splice(0, result.outputWeights.length, ...outputWeights);
    result.bias.splice(0, result.bias.length, ...snapshot.bias);
    result.reset(); return result;
  }
}

export type MutationPopulationOptions = {
  plateauStreak?: number;
  plateauPatience?: number;
  immigrantFraction?: number;
  breedingPool?: SpikingNetwork[];
};

/**
 * Build the next generation while preserving the exact incumbent in slot 1.
 * During a plateau, the tail of the population becomes deterministic random
 * immigrants and the remaining scouts use larger mutations. This creates a
 * real escape route from a local optimum without ever replacing the parent
 * with a lower-scoring candidate.
 */
export function createMutationPopulation(size: number, parent: SpikingNetwork | undefined, seed: number, rate = 0.12, amount = 0.22, options: MutationPopulationOptions = {}): SpikingNetwork[] {
  const safeSize = Math.max(1, Math.floor(size));
  const stableParent = parent?.clone() ?? new SpikingNetwork(seed);
  const plateauStreak = Math.max(0, Math.floor(options.plateauStreak ?? 0));
  const plateauPatience = Math.max(1, Math.floor(options.plateauPatience ?? 3));
  const exploring = plateauStreak >= plateauPatience;
  const immigrantFraction = clamp(options.immigrantFraction ?? 0.2, 0, 1);
  const immigrantCount = exploring ? Math.min(safeSize - 1, Math.max(1, Math.floor((safeSize - 1) * immigrantFraction))) : 0;
  const immigrantStart = safeSize - immigrantCount;
  const breedingPool = (options.breedingPool ?? []).filter((network) => network instanceof SpikingNetwork);
  const children: SpikingNetwork[] = [stableParent];
  for (let index = 1; index < safeSize; index += 1) {
    if (exploring && index >= immigrantStart) {
      children.push(new SpikingNetwork(seed + 90000 + index * 17));
      continue;
    }
    if (breedingPool.length > 1 && index <= Math.min(2, safeSize - 1)) {
      const partner = breedingPool[index % breedingPool.length];
      const crossed = stableParent.crossover(partner, seed + 30000 + index * 19, 0.5);
      children.push(crossed.mutate(clamp(rate * 0.75, 0, 0.95), clamp(amount * 0.75, 0, 2), seed + index + 1));
      continue;
    }
    const scoutMultiplier = exploring ? 1.25 + (index % 3) * 0.2 : 1;
    children.push(stableParent.mutate(clamp(rate * scoutMultiplier, 0, 0.95), clamp(amount * scoutMultiplier, 0, 2), seed + index + 1));
  }
  return children;
}

export type Car = {
  position: Vec; heading: number; speed: number; progress: number; totalProgress: number; laps: number; bestProgress: number;
  trackId: TrackId; distanceAlong: number; nearestDistance: number; offTrackTicks: number; collisions: number; ticks: number; score: number;
  crashed: boolean; timedOut: boolean; finished: boolean; timeLimit: number; timeExtensions: number; rewardWindowScore: number; rewardWindowTicks: number; previousRewardRate: number; nextCheckpoint: number; checkpointsPassed: number; stationaryTicks: number; wrongDirectionTicks: number; forwardAlignment: number; lastReward: number;
  lateralOffset: number; collisionCooldown: number;
  rewardBreakdown: RewardBreakdown; rewardTotals: RewardTotals; nearestOpponentDistance: number;
  color: string; name: string; network?: SpikingNetwork; action: Action; trail: Vec[]; isFly: boolean; isObstacle: boolean;
};

function emptyRewards(): RewardBreakdown {
  return { progress: 0, direction: 0, movement: 0, standingStill: 0, wrongDirection: 0, reverseProgress: 0, offTrack: 0, edge: 0, proximity: 0, centerline: 0, collision: 0, crash: 0, checkpoint: 0, finish: 0, total: 0 };
}

function addRewards(target: RewardTotals, current: RewardBreakdown): void {
  (Object.keys(target) as (keyof RewardBreakdown)[]).forEach((key) => { target[key] += current[key]; });
}

export type StartLine = { point: Vec; tangent: Vec; normal: Vec; distanceAlong: number };

export function startLine(trackRef: TrackRef = DEFAULT_TRACK): StartLine {
  const route = resolveTrack(trackRef); const point = route.points[0]; const tangent = gateTangentAtDistance(0, route);
  return { point, tangent, normal: { x: -tangent.y, y: tangent.x }, distanceAlong: 0 };
}

export function startPosition(lane = 0, trackRef: TrackRef = DEFAULT_TRACK): Car {
  const route = resolveTrack(trackRef); const line = startLine(route); const point = add(line.point, scale(line.normal, lane * LANE_SPACING));
  const rewardBreakdown = emptyRewards();
  return { position: point, heading: Math.atan2(line.tangent.y, line.tangent.x), speed: 0, progress: 0, distanceAlong: 0,
    totalProgress: 0, laps: 0, bestProgress: 0, trackId: route.id, nearestDistance: 0, offTrackTicks: 0, collisions: 0, ticks: 0, score: 0,
    crashed: false, timedOut: false, finished: false, timeLimit: MAX_TICKS, timeExtensions: 0, rewardWindowScore: 0, rewardWindowTicks: 0, previousRewardRate: 0, nextCheckpoint: 1, checkpointsPassed: 0, stationaryTicks: 0, wrongDirectionTicks: 0, forwardAlignment: 1, lastReward: 0, lateralOffset: 0, collisionCooldown: 0, nearestOpponentDistance: Infinity,
    rewardBreakdown, rewardTotals: { ...rewardBreakdown }, color: "#f19a69", name: "bot", action: { steer: 0, throttle: 1, brake: 0 }, trail: [], isFly: false, isObstacle: false };
}

export function createRoadObstacles(count: number, trackRef: TrackRef = DEFAULT_TRACK, seed = 1): Car[] {
  const route = resolveTrack(trackRef); const safeCount = clamp(Math.floor(count), 0, 64); const obstacles: Car[] = [];
  for (let index = 0; index < safeCount; index += 1) {
    const distanceSeed = hash(seed * 17.31 + index * 7.19); const laneSeed = hash(seed * 3.71 + index * 11.47);
    const distance = 120 + distanceSeed * Math.max(80, route.length - 260); const lane = Math.floor(laneSeed * 3) - 1;
    const sample = pointAtDistance(distance, route); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
    const car = startPosition(lane * 0.92, route);
    car.position = add(sample.point, scale(normal, lane * LANE_SPACING * 0.92)); car.heading = Math.atan2(sample.tangent.y, sample.tangent.x);
    const nearest = nearestTrack(car.position, route); car.progress = nearest.progress; car.distanceAlong = nearest.distanceAlong; car.bestProgress = nearest.progress;
    car.speed = 0; car.action = { steer: 0, throttle: 0, brake: 1, reverse: 0 }; car.color = "#d07c72"; car.name = `road object ${index + 1}`; car.isObstacle = true;
    obstacles.push(car);
  }
  return obstacles;
}

export function pointAtDistance(distanceAlong: number, trackRef: TrackRef = DEFAULT_TRACK): { point: Vec; tangent: Vec; distanceAlong: number } {
  const route = resolveTrack(trackRef);
  const wrapped = ((distanceAlong % route.length) + route.length) % route.length;
  let segmentIndex = route.segmentLengths.length - 1;
  for (let index = 0; index < route.segmentLengths.length; index += 1) {
    if (wrapped <= route.cumulativeLengths[index + 1]) { segmentIndex = index; break; }
  }
  const segmentLength = Math.max(1, route.segmentLengths[segmentIndex]);
  const t = clamp((wrapped - route.cumulativeLengths[segmentIndex]) / segmentLength, 0, 1);
  const a = route.points[segmentIndex]; const b = route.points[(segmentIndex + 1) % route.points.length];
  return { point: add(a, scale(sub(b, a), t)), tangent: normalize(sub(b, a)), distanceAlong: wrapped };
}

function gateTangentAtDistance(distanceAlong: number, route: TrackDefinition): Vec {
  const sample = pointAtDistance(distanceAlong, route);
  // A checkpoint can land exactly on a polygon corner. Averaging a short
  // sample on either side makes the gate bisect that corner instead of using
  // whichever segment happened to win the boundary comparison.
  const blendDistance = Math.min(22, Math.max(4, route.width * 0.18));
  const before = pointAtDistance(distanceAlong - blendDistance, route);
  const after = pointAtDistance(distanceAlong + blendDistance, route);
  const blended = add(before.tangent, after.tangent);
  return Math.hypot(blended.x, blended.y) > 0.2 ? normalize(blended) : sample.tangent;
}

export type TrackCheckpoint = { index: number; progress: number; point: Vec; tangent: Vec; normal: Vec; distanceAlong: number };

export function trackCheckpoint(index: number, trackRef: TrackRef = DEFAULT_TRACK, checkpointCount = CHECKPOINT_COUNT): TrackCheckpoint {
  const route = resolveTrack(trackRef); const count = clamp(Math.floor(checkpointCount), 2, 64); const safeIndex = ((Math.round(index) % count) + count) % count;
  const sample = pointAtDistance(route.length * safeIndex / count, route);
  const tangent = gateTangentAtDistance(sample.distanceAlong, route);
  return { index: safeIndex, progress: safeIndex / count, point: sample.point, tangent, normal: { x: -tangent.y, y: tangent.x }, distanceAlong: sample.distanceAlong };
}

function cross(a: Vec, b: Vec): number { return a.x * b.y - a.y * b.x; }

function lateralOffset(position: Vec, closest: { point: Vec; tangent: Vec }, route: TrackDefinition): number {
  return clamp(cross(closest.tangent, sub(position, closest.point)) / Math.max(1, route.width / 2), -1.5, 1.5);
}

type OpponentInfo = { other: Car; distance: number; forward: number; side: number };

function nearestOpponent(car: Car, others: Car[]): OpponentInfo | undefined {
  const forward = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
  const side = { x: -forward.y, y: forward.x };
  return others.filter((other) => other !== car && !other.crashed && !other.finished && !other.timedOut && other.trackId === car.trackId).map((other) => {
    const offset = sub(other.position, car.position); const distance = Math.hypot(offset.x, offset.y); const direction = normalize(offset);
    return { other, distance, forward: dot(direction, forward), side: dot(direction, side) };
  }).sort((a, b) => a.distance - b.distance)[0];
}

export function nearestTrack(position: Vec, trackRef: TrackRef = DEFAULT_TRACK): { point: Vec; tangent: Vec; distance: number; progress: number; distanceAlong: number; segmentIndex: number; segmentT: number } {
  const route = resolveTrack(trackRef);
  let best = { point: route.points[0], tangent: normalize(sub(route.points[1], route.points[0])), distance: Infinity, progress: 0, distanceAlong: 0, segmentIndex: 0, segmentT: 0 };
  for (let index = 0; index < route.points.length; index += 1) {
    const a = route.points[index]; const b = route.points[(index + 1) % route.points.length]; const segment = sub(b, a);
    const t = clamp(dot(sub(position, a), segment) / Math.max(1, dot(segment, segment)), 0, 1);
    const point = add(a, scale(segment, t)); const distance = dist(position, point);
    if (distance < best.distance) {
      const distanceAlong = route.cumulativeLengths[index] + route.segmentLengths[index] * t;
      best = { point, tangent: normalize(segment), distance, progress: distanceAlong / route.length, distanceAlong, segmentIndex: index, segmentT: t };
    }
  }
  return best;
}

export function sensorValues(car: Car, others: Car[], trackRef?: TrackRef): Sensors {
  const route = resolveTrack(trackRef ?? car.trackId); const closest = nearestTrack(car.position, route);
  // At low speed, a shorter lookahead lets the controller commit to a tight
  // corner. At high speed, the horizon grows so it begins braking and turning
  // before the apex instead of reacting after it has left the road.
  const lookaheadDistance = clamp(56 + Math.abs(car.speed) * 0.42, 56, 112);
  const lookahead = pointAtDistance(closest.distanceAlong + lookaheadDistance, route); const desiredHeading = Math.atan2(lookahead.point.y - car.position.y, lookahead.point.x - car.position.x);
  const headingError = wrapAngle(desiredHeading - car.heading) / Math.PI;
  const tangentHeading = Math.atan2(lookahead.tangent.y, lookahead.tangent.x); const curvature = wrapAngle(tangentHeading - car.heading) / Math.PI;
  const opponent = nearestOpponent(car, others);
  const signedLateral = lateralOffset(car.position, closest, route);
  const centerlineProximity = clamp(1 - Math.abs(signedLateral), -1, 1);
  const edgeClearance = clamp(1 - closest.distance / Math.max(1, route.width / 2), -1, 1);
  const forward = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
  const forwardAlignment = dot(forward, closest.tangent);
  return [clamp(headingError, -1, 1), clamp(curvature, -1, 1), clamp(signedLateral, -1, 1),
    clamp(car.speed / 90, -1, 1), centerlineProximity,
    opponent && opponent.distance < 180 ? clamp(1 - opponent.distance / 180, 0, 1) : 0, opponent && opponent.distance < 180 ? clamp(opponent.side, -1, 1) : 0,
    edgeClearance, clamp(forwardAlignment, -1, 1)];
}

export function heuristicAction(car: Car, others: Car[], trackRef?: TrackRef): Action {
  const sensors = sensorValues(car, others, trackRef); const lateral = sensors[2]; const opponentPressure = sensors[5];
  const opponent = nearestOpponent(car, others); const opponentIsAhead = Boolean(opponent && opponent.forward > 0.12);
  const closeTraffic = Boolean(opponent && opponent.distance < CLOSE_PROXIMITY_DISTANCE);
  const avoid = opponentPressure > 0 ? -sensors[6] * opponentPressure * (closeTraffic ? 2.2 : 1.35) : 0;
  const steer = clamp(sensors[0] * 1.55 + sensors[1] * 0.7 - lateral * 1.85 + avoid, -1, 1);
  const targetSpeed = clamp(82 - Math.abs(sensors[1]) * 44 - Math.abs(lateral) * 30 - (opponentIsAhead ? opponentPressure * 25 : 0), 18, 82);
  const emergencyBrake = opponentIsAhead && closeTraffic ? 0.8 : 0;
  const brake = emergencyBrake > 0 ? emergencyBrake : car.speed > targetSpeed + 5 ? clamp((car.speed - targetSpeed) / 35, 0, 1) : Math.abs(steer) > 0.94 ? 0.18 : 0;
  // If a stopped car has a close obstacle in front, briefly back away rather
  // than feeding another stationary car into the collision chain.
  const reverse = opponentIsAhead && closeTraffic && car.speed < 5 ? 0.48 : Math.abs(lateral) > 1.05 && car.speed < 6 && sensors[0] * car.forwardAlignment < -0.2 ? 0.32 : 0;
  return { steer, throttle: reverse > 0 ? 0 : clamp(0.45 + (targetSpeed - Math.max(0, car.speed)) / 85, 0.25, 1), brake, reverse };
}

export function stepCar(car: Car, action: Action, others: Car[], trackRef?: TrackRef, rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG, physicsConfig: PhysicsConfig = DEFAULT_PHYSICS_CONFIG): void {
  if (car.crashed || car.finished || car.timedOut) return;
  const route = resolveTrack(trackRef ?? car.trackId); const checkpointCount = clamp(Math.floor(physicsConfig.checkpointCount ?? CHECKPOINT_COUNT), 2, 64); const nearby = nearestTrack(car.position, route); const offTrackBefore = nearby.distance > route.width / 2; const grip = offTrackBefore ? 0.35 : 1;
  const steeringDirection = car.speed < -0.5 ? -1 : 1;
  car.heading += clamp(action.steer, -1, 1) * (0.65 + Math.abs(car.speed) / 150) * grip * steeringDirection * STEP;
  const forwardThrottle = clamp(action.throttle, 0, 1); const reverseThrottle = clamp(action.reverse ?? 0, 0, 1); const brake = clamp(action.brake, 0, 1);
  let acceleration = forwardThrottle * 55 - reverseThrottle * 45 - car.speed * 0.23;
  if (car.speed > 0) acceleration -= brake * 75; else if (car.speed < 0) acceleration += brake * 75;
  car.speed = clamp(car.speed + acceleration * STEP, -48, 90);
  const previousPosition = { ...car.position };
  car.position = add(car.position, { x: Math.cos(car.heading) * car.speed * STEP, y: Math.sin(car.heading) * car.speed * STEP });
  let updated = nearestTrack(car.position, route); const rawOffTrackDistance = updated.distance; const wasOffTrack = rawOffTrackDistance > route.width / 2;
  if (wasOffTrack && physicsConfig.wallsEnabled) {
    const offset = sub(car.position, updated.point); const offsetDirection = normalize(offset);
    const safeCenterDistance = route.width / 2 - CAR_WIDTH * 0.65;
    const pull = clamp((updated.distance - safeCenterDistance) * (updated.distance > route.width * 1.25 ? 0.5 : 0.2), 1.5, 18);
    car.position = sub(car.position, scale(offsetDirection, pull));
    updated = nearestTrack(car.position, route);
  }
  // Leaving the road should be survivable, but it must be an unattractive
  // strategy. The first pixels outside the asphalt cut speed to about half;
  // deeper excursions apply progressively stronger drag. Use the largest
  // observed distance this tick so wall recovery cannot erase the consequence
  // of an excursion before the vehicle's dynamics are updated.
  const outsideDistance = Math.max(nearby.distance, rawOffTrackDistance, updated.distance);
  const outsideDepth = Math.max(0, outsideDistance - route.width / 2);
  if (outsideDepth > 0) {
    const outsideRatio = outsideDepth / Math.max(1, route.width / 2);
    const outsideSpeedFactor = clamp(0.5 / (1 + outsideRatio * 0.75), 0.08, 0.5);
    car.speed *= outsideSpeedFactor;
  }
  const rawDelta = updated.progress - car.progress; let localDelta = rawDelta;
  if (localDelta < -0.5) localDelta += 1; else if (localDelta > 0.5) localDelta -= 1;
  const forward = { x: Math.cos(car.heading), y: Math.sin(car.heading) }; const alignment = dot(forward, updated.tangent);
  const line = startLine(route); const movement = sub(car.position, previousPosition);
  const crossesGate = (gate: { point: Vec; tangent: Vec; normal: Vec; distanceAlong?: number }): boolean => {
    const previousSide = dot(sub(previousPosition, gate.point), gate.tangent); const currentSide = dot(sub(car.position, gate.point), gate.tangent);
    if (!(previousSide < 0 && currentSide >= 0 && dot(movement, gate.tangent) > 0.01)) return false;
    const denominator = previousSide - currentSide; const crossingFraction = clamp(previousSide / denominator, 0, 1);
    const crossingPoint = add(previousPosition, scale(movement, crossingFraction));
    const crossingOffset = Math.abs(dot(sub(crossingPoint, gate.point), gate.normal));
    // A wide gate at a hairpin can geometrically reach a nearby parallel
    // section of road. Confirm that the crossing point is also near the gate's
    // intended arc-length position, otherwise a car on the return lane could
    // collect a checkpoint by crossing the wrong physical lane.
    if (gate.distanceAlong !== undefined) {
      const crossingTrack = nearestTrack(crossingPoint, route);
      const directError = Math.abs(crossingTrack.distanceAlong - gate.distanceAlong);
      const wrappedError = Math.min(directError, route.length - directError);
      if (wrappedError > Math.max(route.width * 0.8, CAR_LENGTH * 3)) return false;
    }
    return crossingOffset <= route.width * 0.5 + CAR_WIDTH;
  };
  const directedStartCross = crossesGate(line);
  const expectedCheckpoint = car.nextCheckpoint;
  const expectedGate = trackCheckpoint(expectedCheckpoint, route, checkpointCount);
  const intermediateCheckpointCrossed = expectedCheckpoint > 0 && crossesGate(expectedGate) && alignment > 0.15 && car.speed > 2;
  // The start gate is also the finish gate, but it is only valid after all
  // intermediate gates were crossed in order and nearly one full lap elapsed.
  const lapCrossed = expectedCheckpoint === 0 && directedStartCross && car.totalProgress >= 0.95 && alignment > 0.15 && car.speed > 2;
  const checkpointCrossed = intermediateCheckpointCrossed || lapCrossed;
  if (intermediateCheckpointCrossed) {
    car.checkpointsPassed += 1;
    car.nextCheckpoint = expectedCheckpoint === checkpointCount - 1 ? 0 : expectedCheckpoint + 1;
  } else if (lapCrossed) {
    car.checkpointsPassed += 1;
    car.nextCheckpoint = checkpointCount;
  }
  const firstFinish = lapCrossed && !car.finished;
  const validForwardDelta = localDelta > 0 && alignment > -0.35 ? localDelta : 0;
  if (lapCrossed) { car.laps += 1; car.finished = true; }
  car.totalProgress += validForwardDelta; car.progress = updated.progress; car.distanceAlong = updated.distanceAlong; car.bestProgress = Math.max(car.bestProgress, car.progress);
  car.nearestDistance = updated.distance; const offTrackDistance = outsideDistance; const offTrack = offTrackDistance > route.width / 2; if (offTrack) car.offTrackTicks += 1;
  const offTrackSeverity = offTrack ? 1 + clamp((offTrackDistance - route.width / 2) / Math.max(1, route.width / 2), 0, 3) : 0;
  car.lateralOffset = lateralOffset(car.position, updated, route);
  car.ticks += 1; if (car.ticks % 8 === 0) car.trail.push({ ...car.position }); if (car.trail.length > 38) car.trail.shift();
  const collisionsBefore = car.collisions;
  let contact = false;
  const carIndex = others.indexOf(car);
  const clampToRoad = (target: Car): void => {
    if (!physicsConfig.wallsEnabled) return;
    const targetTrack = nearestTrack(target.position, route);
    const maxCenterDistance = route.width / 2 - CAR_WIDTH * 0.65;
    if (targetTrack.distance > maxCenterDistance) target.position = add(targetTrack.point, scale(normalize(sub(target.position, targetTrack.point)), maxCenterDistance));
  };
  const setCollisionSpeed = (target: Car, velocity: Vec): void => {
    const forward = { x: Math.cos(target.heading), y: Math.sin(target.heading) };
    target.speed = clamp(dot(velocity, forward) * 0.86, -48, 90);
  };
  others.forEach((other, otherIndex) => {
    if (other === car || other.crashed || other.finished || other.timedOut || other.trackId !== car.trackId) return;
    const offset = sub(car.position, other.position); const distance = Math.hypot(offset.x, offset.y);
    if (distance >= CAR_COLLISION_DIAMETER) return;
    contact = true;
    const tangent = updated.tangent; const fallback = { x: -tangent.y, y: tangent.x };
    const direction = distance > 0.0001 ? scale(offset, 1 / distance) : scale(fallback, carIndex < otherIndex ? 1 : -1);
    const separation = (CAR_COLLISION_DIAMETER - distance) + 0.75;
    // Equal-mass separation keeps both cars movable. The old one-sided push
    // made a stopped car behave like a wall and created traffic pileups.
    car.position = add(car.position, scale(direction, separation * 0.5));
    other.position = sub(other.position, scale(direction, separation * 0.5));
    const carForward = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
    const otherForward = { x: Math.cos(other.heading), y: Math.sin(other.heading) };
    const carVelocity = scale(carForward, car.speed); const otherVelocity = scale(otherForward, other.speed);
    const relativeNormalSpeed = dot(sub(carVelocity, otherVelocity), direction);
    if (relativeNormalSpeed < 0) {
      const impulse = -(1 + 0.42) * relativeNormalSpeed * 0.5;
      setCollisionSpeed(car, add(carVelocity, scale(direction, impulse)));
      setCollisionSpeed(other, sub(otherVelocity, scale(direction, impulse)));
    } else {
      car.speed *= 0.82; other.speed *= 0.94;
    }
    if (car.collisionCooldown <= 0) car.collisions += 1;
    if (other.collisionCooldown <= 0) other.collisions += 1;
    car.collisionCooldown = 6; other.collisionCooldown = Math.max(other.collisionCooldown, 6);
    clampToRoad(car); clampToRoad(other);
  });
  if (contact) {
    car.speed *= 0.38;
    if (car.collisionCooldown <= 0) car.collisions += 1;
    car.collisionCooldown = 6;
    clampToRoad(car);
  } else car.collisionCooldown = Math.max(0, car.collisionCooldown - 1);
  const collisionDelta = car.collisions - collisionsBefore;
  const standingStill = car.speed < 3; if (standingStill) car.stationaryTicks += 1; if (alignment < -0.25) car.wrongDirectionTicks += 1;
  const reward = emptyRewards();
  reward.progress = (validForwardDelta / STEP) * rewardConfig.progressPerSecond;
  reward.direction = Math.max(0, alignment) * rewardConfig.correctDirectionPerSecond * STEP;
  reward.movement = offTrack ? 0 : clamp(car.speed / 60, 0, 1) * rewardConfig.movementPerSecond * STEP;
  reward.standingStill = standingStill ? rewardConfig.standingStillPerSecond * STEP : 0;
  reward.wrongDirection = Math.max(0, -alignment) * rewardConfig.wrongDirectionPerSecond * STEP;
  reward.reverseProgress = (Math.max(0, -localDelta) / STEP) * rewardConfig.reverseProgressPerSecond;
  reward.offTrack = offTrack ? rewardConfig.offTrackPerSecond * offTrackSeverity * STEP : 0;
  const edgeRisk = clamp((Math.abs(car.lateralOffset) - 0.55) / 0.45, 0, 1);
  reward.edge = edgeRisk * rewardConfig.edgePenaltyPerSecond * STEP;
  const opponent = nearestOpponent(car, others);
  car.nearestOpponentDistance = opponent?.distance ?? Infinity;
  const proximityDenominator = Math.max(1, CLOSE_PROXIMITY_DISTANCE - CAR_COLLISION_DIAMETER * 1.05);
  const proximityRisk = opponent ? clamp((CLOSE_PROXIMITY_DISTANCE - opponent.distance) / proximityDenominator, 0, 1) : 0;
  reward.proximity = proximityRisk * rewardConfig.proximityPenaltyPerSecond * STEP;
  reward.centerline = Math.max(0, 1 - Math.abs(car.lateralOffset)) * (rewardConfig.centerlinePerSecond ?? 0) * STEP;
  reward.collision = collisionDelta * rewardConfig.collision;
  reward.crash = car.crashed ? rewardConfig.crash : 0;
  reward.checkpoint = checkpointCrossed ? rewardConfig.checkpoint : 0;
  reward.finish = firstFinish ? rewardConfig.finish : 0;
  reward.total = reward.progress + reward.direction + reward.movement + reward.centerline + reward.checkpoint + reward.finish - reward.standingStill - reward.wrongDirection - reward.reverseProgress - reward.offTrack - reward.edge - reward.proximity - reward.collision - reward.crash;
  car.rewardWindowScore += reward.total; car.rewardWindowTicks += 1;
  const windowSeconds = Math.max(STEP, car.rewardWindowTicks * STEP); const windowRate = car.rewardWindowScore / windowSeconds;
  const maxExtensions = clamp(Math.floor(physicsConfig.maxAdaptiveExtensions ?? MAX_ADAPTIVE_EXTENSIONS), 0, MAX_ADAPTIVE_EXTENSIONS);
  const atTimeLimit = car.ticks >= car.timeLimit;
  if (atTimeLimit && !car.finished) {
    // The first extension requires a non-negative recent rate. A second
    // extension is stricter: the newest rate must improve on the previous
    // completed window, so stalled or degrading candidates still terminate.
    const rateIsImproving = car.timeExtensions === 0 || windowRate > car.previousRewardRate;
    const canExtend = physicsConfig.adaptiveTimeLimit === true && car.timeExtensions < maxExtensions && windowRate >= 0 && rateIsImproving;
    if (canExtend) {
      car.timeExtensions += 1; car.timeLimit *= 2; car.previousRewardRate = windowRate; car.rewardWindowScore = 0; car.rewardWindowTicks = 0;
    } else {
      car.timedOut = true; car.previousRewardRate = windowRate; car.rewardWindowScore = 0; car.rewardWindowTicks = 0;
    }
  } else if (car.rewardWindowTicks >= ADAPTIVE_REWARD_WINDOW_TICKS) {
    car.previousRewardRate = windowRate; car.rewardWindowScore = 0; car.rewardWindowTicks = 0;
  }
  car.forwardAlignment = alignment; car.lastReward = reward.total; car.rewardBreakdown = reward; addRewards(car.rewardTotals, reward); car.score += reward.total;
}

export type EvaluationResult = { fitness: number; progress: number; ticks: number; laps: number; finished: boolean; trackId: TrackId; rewardTotals: RewardTotals };

export function evaluate(network: SpikingNetwork, trackRef: TrackRef = DEFAULT_TRACK, rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG, physicsConfig: PhysicsConfig = DEFAULT_PHYSICS_CONFIG, ghost = false, obstacleCount = 0, obstacleSeed = 1): EvaluationResult {
  const route = resolveTrack(trackRef); const car = startPosition(0, route); car.network = network; network.reset();
  const line = startLine(route); const obstacles = [startPosition(-1, route), startPosition(1, route)]; obstacles[0].position = add(obstacles[0].position, scale(line.tangent, 55)); obstacles[1].position = add(obstacles[1].position, scale(line.tangent, 115));
  const roadObjects = createRoadObstacles(obstacleCount, route, obstacleSeed);
  const cars = ghost ? [car, ...roadObjects] : [car, ...obstacles, ...roadObjects];
  const maxExtensions = clamp(Math.floor(physicsConfig.maxAdaptiveExtensions ?? MAX_ADAPTIVE_EXTENSIONS), 0, MAX_ADAPTIVE_EXTENSIONS);
  const simulationLimit = MAX_TICKS * (physicsConfig.adaptiveTimeLimit === true ? 2 ** maxExtensions : 1);
  for (let tick = 0; tick < simulationLimit && !car.crashed && !car.finished && !car.timedOut; tick += 1) {
    stepCar(car, network.step(sensorValues(car, cars, route)), cars, route, rewardConfig, physicsConfig);
    if (!ghost) obstacles.forEach((bot) => stepCar(bot, heuristicAction(bot, cars, route), cars, route, rewardConfig, physicsConfig));
  }
  return { fitness: car.score, progress: car.totalProgress, ticks: car.ticks, laps: car.laps, finished: car.finished, trackId: route.id, rewardTotals: { ...car.rewardTotals } };
}

export type GeneralistEvaluation = { fitness: number; progress: number; ticks: number; laps: number; finished: boolean; rewardTotals: RewardTotals; episodes: EvaluationResult[] };

export function evaluateGeneralist(network: SpikingNetwork, trackRefs: TrackRef[] = TRACKS, rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG, physicsConfig: PhysicsConfig = DEFAULT_PHYSICS_CONFIG, ghost = false, obstacleCount = 0, obstacleSeed = 1): GeneralistEvaluation {
  const routes = trackRefs.length > 0 ? trackRefs.map(resolveTrack) : [DEFAULT_TRACK]; const episodes = routes.map((route, index) => evaluate(network, route, rewardConfig, physicsConfig, ghost, obstacleCount, obstacleSeed + index * 97));
  const average = (selector: (episode: EvaluationResult) => number): number => episodes.reduce((sum, episode) => sum + selector(episode), 0) / episodes.length;
  const rewardTotals = emptyRewards();
  (Object.keys(rewardTotals) as (keyof RewardBreakdown)[]).forEach((key) => { rewardTotals[key] = average((episode) => episode.rewardTotals[key]); });
  return { fitness: average((episode) => episode.fitness), progress: average((episode) => episode.progress), ticks: episodes.reduce((sum, episode) => sum + episode.ticks, 0), laps: episodes.reduce((sum, episode) => sum + episode.laps, 0), finished: episodes.every((episode) => episode.finished), rewardTotals, episodes };
}

export function createNetworkPopulation(size: number): SpikingNetwork[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("population size must be a positive integer");
  return Array.from({ length: size }, (_, index) => new SpikingNetwork(index + 1));
}
