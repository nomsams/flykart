export type Vec = { x: number; y: number };
export type Action = { steer: number; throttle: number; brake: number; reverse?: number };
export type Sensors = number[];
export type TrackId = "grand-loop" | "switchback" | "zigzag";
export type TrackRef = TrackDefinition | TrackId;

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

export type RewardConfig = {
  progressPerSecond: number;
  correctDirectionPerSecond: number;
  movementPerSecond: number;
  standingStillPerSecond: number;
  wrongDirectionPerSecond: number;
  reverseProgressPerSecond: number;
  offTrackPerSecond: number;
  centerlinePerSecond?: number;
  collision: number;
  crash: number;
  finish: number;
};

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  progressPerSecond: 12,
  correctDirectionPerSecond: 0.45,
  movementPerSecond: 0.12,
  standingStillPerSecond: 0.55,
  wrongDirectionPerSecond: 1.25,
  reverseProgressPerSecond: 1.5,
  offTrackPerSecond: 1.1,
  centerlinePerSecond: 0.18,
  collision: 7,
  crash: 25,
  finish: 250,
};

export type RewardBreakdown = {
  progress: number;
  direction: number;
  movement: number;
  standingStill: number;
  wrongDirection: number;
  reverseProgress: number;
  offTrack: number;
  centerline: number;
  collision: number;
  crash: number;
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
    this.outputWeights = Array.from({ length: 3 * this.hiddenCount }, () => random() * 0.5);
    this.bias = Array.from({ length: this.hiddenCount }, () => random() * 0.06);
    this.voltage = new Array(this.hiddenCount).fill(0);
    this.spikes = new Array(this.hiddenCount).fill(0);
    this.snapshot = { spikes: [...this.spikes], outputs: [0, 0, 0] };
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
    const outputs = [0, 0, 0];
    for (let output = 0; output < 3; output += 1) {
      for (let neuron = 0; neuron < this.hiddenCount; neuron += 1) outputs[output] += this.outputWeights[output * this.hiddenCount + neuron] * this.spikes[neuron];
      outputs[output] = Math.tanh(outputs[output]);
    }
    this.snapshot.spikes = [...this.spikes]; this.snapshot.outputs = outputs;
    return { steer: outputs[0], throttle: (outputs[1] + 1) / 2, brake: (outputs[2] + 1) / 2 };
  }

  activity(): NeuronSnapshot { return this.snapshot; }

  toJSON(): BrainSnapshot {
    return { version: 1, inputCount: this.inputCount, hiddenCount: this.hiddenCount,
      inputWeights: [...this.inputWeights], recurrentWeights: [...this.recurrentWeights], outputWeights: [...this.outputWeights], bias: [...this.bias] };
  }

  static fromJSON(snapshot: BrainSnapshot): SpikingNetwork {
    const arrays = [snapshot.inputWeights, snapshot.recurrentWeights, snapshot.outputWeights, snapshot.bias];
    if (snapshot.version !== 1 || snapshot.inputCount !== 9 || snapshot.hiddenCount !== 48 || arrays.some((value) => !Array.isArray(value) || value.some((item) => !Number.isFinite(item)))) throw new Error("checkpoint format does not match this FlyKart build");
    if (snapshot.inputWeights.length !== snapshot.inputCount * snapshot.hiddenCount || snapshot.recurrentWeights.length !== snapshot.hiddenCount ** 2 || snapshot.outputWeights.length !== snapshot.hiddenCount * 3 || snapshot.bias.length !== snapshot.hiddenCount) throw new Error("checkpoint dimensions are invalid");
    const result = new SpikingNetwork(0.5);
    result.inputWeights.splice(0, result.inputWeights.length, ...snapshot.inputWeights);
    result.recurrentWeights.splice(0, result.recurrentWeights.length, ...snapshot.recurrentWeights);
    result.outputWeights.splice(0, result.outputWeights.length, ...snapshot.outputWeights);
    result.bias.splice(0, result.bias.length, ...snapshot.bias);
    result.reset(); return result;
  }
}

export type Car = {
  position: Vec; heading: number; speed: number; progress: number; totalProgress: number; laps: number; bestProgress: number;
  trackId: TrackId; distanceAlong: number; nearestDistance: number; offTrackTicks: number; collisions: number; ticks: number; score: number;
  crashed: boolean; finished: boolean; stationaryTicks: number; wrongDirectionTicks: number; forwardAlignment: number; lastReward: number;
  lateralOffset: number; collisionCooldown: number;
  rewardBreakdown: RewardBreakdown; rewardTotals: RewardTotals;
  color: string; name: string; network?: SpikingNetwork; action: Action; trail: Vec[]; isFly: boolean;
};

function emptyRewards(): RewardBreakdown {
  return { progress: 0, direction: 0, movement: 0, standingStill: 0, wrongDirection: 0, reverseProgress: 0, offTrack: 0, centerline: 0, collision: 0, crash: 0, finish: 0, total: 0 };
}

function addRewards(target: RewardTotals, current: RewardBreakdown): void {
  (Object.keys(target) as (keyof RewardBreakdown)[]).forEach((key) => { target[key] += current[key]; });
}

export type StartLine = { point: Vec; tangent: Vec; normal: Vec };

export function startLine(trackRef: TrackRef = DEFAULT_TRACK): StartLine {
  const route = resolveTrack(trackRef); const point = route.points[0]; const tangent = normalize(sub(route.points[1], point));
  return { point, tangent, normal: { x: -tangent.y, y: tangent.x } };
}

export function startPosition(lane = 0, trackRef: TrackRef = DEFAULT_TRACK): Car {
  const route = resolveTrack(trackRef); const line = startLine(route); const point = add(line.point, scale(line.normal, lane * LANE_SPACING));
  const rewardBreakdown = emptyRewards();
  return { position: point, heading: Math.atan2(line.tangent.y, line.tangent.x), speed: 0, progress: 0, distanceAlong: 0,
    totalProgress: 0, laps: 0, bestProgress: 0, trackId: route.id, nearestDistance: 0, offTrackTicks: 0, collisions: 0, ticks: 0, score: 0,
    crashed: false, finished: false, stationaryTicks: 0, wrongDirectionTicks: 0, forwardAlignment: 1, lastReward: 0, lateralOffset: 0, collisionCooldown: 0,
    rewardBreakdown, rewardTotals: { ...rewardBreakdown }, color: "#f19a69", name: "bot", action: { steer: 0, throttle: 1, brake: 0 }, trail: [], isFly: false };
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

function cross(a: Vec, b: Vec): number { return a.x * b.y - a.y * b.x; }

function lateralOffset(position: Vec, closest: { point: Vec; tangent: Vec }, route: TrackDefinition): number {
  return clamp(cross(closest.tangent, sub(position, closest.point)) / Math.max(1, route.width / 2), -1.5, 1.5);
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
  const lookahead = pointAtDistance(closest.distanceAlong + 86, route); const desiredHeading = Math.atan2(lookahead.point.y - car.position.y, lookahead.point.x - car.position.x);
  const headingError = wrapAngle(desiredHeading - car.heading) / Math.PI;
  const tangentHeading = Math.atan2(lookahead.tangent.y, lookahead.tangent.x); const curvature = wrapAngle(tangentHeading - car.heading) / Math.PI;
  const forward = { x: Math.cos(car.heading), y: Math.sin(car.heading) }; const side = { x: -forward.y, y: forward.x };
  const opponent = others.filter((other) => other !== car).map((other) => {
    const offset = sub(other.position, car.position); const distance = Math.hypot(offset.x, offset.y); const direction = normalize(offset);
    return { distance, forward: dot(direction, forward), side: dot(direction, side) };
  }).filter((item) => item.distance < 180 && item.forward > 0).sort((a, b) => a.distance - b.distance)[0];
  const signedLateral = lateralOffset(car.position, closest, route);
  return [clamp(headingError, -1, 1), clamp(curvature, -1, 1), clamp(signedLateral, -1, 1),
    clamp(car.speed / 90, -1, 1), clamp(1 - Math.abs(signedLateral), -1, 1),
    opponent ? clamp(1 - opponent.distance / 180, 0, 1) : 0, opponent ? clamp(opponent.side, -1, 1) : 0,
    Math.sin(car.ticks * 0.025), 1];
}

export function heuristicAction(car: Car, others: Car[], trackRef?: TrackRef): Action {
  const sensors = sensorValues(car, others, trackRef); const lateral = sensors[2]; const opponentPressure = sensors[5];
  const avoid = opponentPressure > 0 ? -sensors[6] * opponentPressure * 1.35 : 0;
  const steer = clamp(sensors[0] * 1.55 + sensors[1] * 0.7 - lateral * 1.85 + avoid, -1, 1);
  const targetSpeed = clamp(82 - Math.abs(sensors[1]) * 44 - Math.abs(lateral) * 30 - opponentPressure * 17, 22, 82);
  const brake = car.speed > targetSpeed + 5 ? clamp((car.speed - targetSpeed) / 35, 0, 1) : Math.abs(steer) > 0.94 ? 0.18 : 0;
  const reverse = Math.abs(lateral) > 1.05 && car.speed < 6 && sensors[0] * car.forwardAlignment < -0.2 ? 0.32 : 0;
  return { steer, throttle: reverse > 0 ? 0 : clamp(0.45 + (targetSpeed - Math.max(0, car.speed)) / 85, 0.38, 1), brake, reverse };
}

export function stepCar(car: Car, action: Action, others: Car[], trackRef?: TrackRef, rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG): void {
  if (car.crashed) return;
  const route = resolveTrack(trackRef ?? car.trackId); const nearby = nearestTrack(car.position, route); const offTrackBefore = nearby.distance > route.width / 2; const grip = offTrackBefore ? 0.35 : 1;
  const steeringDirection = car.speed < -0.5 ? -1 : 1;
  car.heading += clamp(action.steer, -1, 1) * (0.65 + Math.abs(car.speed) / 150) * grip * steeringDirection * STEP;
  const forwardThrottle = clamp(action.throttle, 0, 1); const reverseThrottle = clamp(action.reverse ?? 0, 0, 1); const brake = clamp(action.brake, 0, 1);
  let acceleration = forwardThrottle * 55 - reverseThrottle * 45 - car.speed * 0.23;
  if (car.speed > 0) acceleration -= brake * 75; else if (car.speed < 0) acceleration += brake * 75;
  car.speed = clamp(car.speed + acceleration * STEP, -48, 90);
  car.position = add(car.position, { x: Math.cos(car.heading) * car.speed * STEP, y: Math.sin(car.heading) * car.speed * STEP });
  let updated = nearestTrack(car.position, route); const wasOffTrack = updated.distance > route.width / 2;
  if (wasOffTrack) {
    const offset = sub(car.position, updated.point); const offsetDirection = normalize(offset);
    const safeCenterDistance = route.width / 2 - CAR_WIDTH * 0.65;
    const pull = clamp((updated.distance - safeCenterDistance) * (updated.distance > route.width * 1.25 ? 0.5 : 0.2), 1.5, 18);
    car.position = sub(car.position, scale(offsetDirection, pull));
    if (updated.distance > route.width * 1.25) car.speed *= 0.55;
    updated = nearestTrack(car.position, route);
  }
  const rawDelta = updated.progress - car.progress; let localDelta = rawDelta;
  if (localDelta < -0.5) localDelta += 1; else if (localDelta > 0.5) localDelta -= 1;
  const forward = { x: Math.cos(car.heading), y: Math.sin(car.heading) }; const alignment = dot(forward, updated.tangent);
  const lapCrossed = rawDelta < -0.5 && alignment > 0.15 && car.speed > 2;
  const firstFinish = lapCrossed && !car.finished;
  const continuousDelta = localDelta + (lapCrossed ? 1 : 0);
  const validForwardDelta = continuousDelta > 0 && alignment > -0.35 ? continuousDelta : 0;
  if (lapCrossed) { car.laps += 1; car.finished = true; }
  car.totalProgress += validForwardDelta; car.progress = updated.progress; car.distanceAlong = updated.distanceAlong; car.bestProgress = Math.max(car.bestProgress, car.progress);
  car.nearestDistance = updated.distance; const offTrack = wasOffTrack || updated.distance > route.width / 2; if (offTrack) car.offTrackTicks += 1;
  car.lateralOffset = lateralOffset(car.position, updated, route);
  car.ticks += 1; if (car.ticks % 8 === 0) car.trail.push({ ...car.position }); if (car.trail.length > 38) car.trail.shift();
  const collisionsBefore = car.collisions;
  let contact = false;
  const carIndex = others.indexOf(car);
  others.forEach((other, otherIndex) => {
    if (other === car || other.crashed || other.trackId !== car.trackId) return;
    const offset = sub(car.position, other.position); const distance = Math.hypot(offset.x, offset.y);
    if (distance >= CAR_COLLISION_DIAMETER) return;
    contact = true;
    const tangent = updated.tangent; const fallback = { x: -tangent.y, y: tangent.x };
    const direction = distance > 0.0001 ? scale(offset, 1 / distance) : scale(fallback, carIndex < otherIndex ? 1 : -1);
    const separation = (CAR_COLLISION_DIAMETER - distance) + 0.75;
    car.position = add(car.position, scale(direction, separation));
  });
  if (contact) {
    car.speed *= 0.38;
    if (car.collisionCooldown <= 0) car.collisions += 1;
    car.collisionCooldown = 6;
    const afterContact = nearestTrack(car.position, route);
    const maxCenterDistance = route.width / 2 - CAR_WIDTH * 0.65;
    if (afterContact.distance > maxCenterDistance) car.position = add(afterContact.point, scale(normalize(sub(car.position, afterContact.point)), maxCenterDistance));
  } else car.collisionCooldown = Math.max(0, car.collisionCooldown - 1);
  const collisionDelta = car.collisions - collisionsBefore;
  const standingStill = car.speed < 3; if (standingStill) car.stationaryTicks += 1; if (alignment < -0.25) car.wrongDirectionTicks += 1;
  if (car.ticks >= MAX_TICKS) car.crashed = true;
  const reward = emptyRewards();
  reward.progress = (validForwardDelta / STEP) * rewardConfig.progressPerSecond;
  reward.direction = Math.max(0, alignment) * rewardConfig.correctDirectionPerSecond * STEP;
  reward.movement = offTrack ? 0 : clamp(car.speed / 60, 0, 1) * rewardConfig.movementPerSecond * STEP;
  reward.standingStill = standingStill ? rewardConfig.standingStillPerSecond * STEP : 0;
  reward.wrongDirection = Math.max(0, -alignment) * rewardConfig.wrongDirectionPerSecond * STEP;
  reward.reverseProgress = (Math.max(0, -localDelta) / STEP) * rewardConfig.reverseProgressPerSecond;
  reward.offTrack = offTrack ? rewardConfig.offTrackPerSecond * STEP : 0;
  reward.centerline = Math.max(0, 1 - Math.abs(car.lateralOffset)) * (rewardConfig.centerlinePerSecond ?? 0) * STEP;
  reward.collision = collisionDelta * rewardConfig.collision;
  reward.crash = car.crashed ? rewardConfig.crash : 0;
  reward.finish = firstFinish ? rewardConfig.finish : 0;
  reward.total = reward.progress + reward.direction + reward.movement + reward.centerline + reward.finish - reward.standingStill - reward.wrongDirection - reward.reverseProgress - reward.offTrack - reward.collision - reward.crash;
  car.forwardAlignment = alignment; car.lastReward = reward.total; car.rewardBreakdown = reward; addRewards(car.rewardTotals, reward); car.score += reward.total;
}

export type EvaluationResult = { fitness: number; progress: number; ticks: number; laps: number; finished: boolean; trackId: TrackId; rewardTotals: RewardTotals };

export function evaluate(network: SpikingNetwork, trackRef: TrackRef = DEFAULT_TRACK, rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG): EvaluationResult {
  const route = resolveTrack(trackRef); const car = startPosition(0, route); car.network = network; network.reset();
  const line = startLine(route); const obstacles = [startPosition(-1, route), startPosition(1, route)]; obstacles[0].position = add(obstacles[0].position, scale(line.tangent, 55)); obstacles[1].position = add(obstacles[1].position, scale(line.tangent, 115));
  const cars = [car, ...obstacles];
  for (let tick = 0; tick < MAX_TICKS && !car.crashed && !car.finished; tick += 1) {
    stepCar(car, network.step(sensorValues(car, cars, route)), cars, route, rewardConfig);
    obstacles.forEach((bot) => stepCar(bot, heuristicAction(bot, cars), cars, route, rewardConfig));
  }
  return { fitness: car.score, progress: car.totalProgress, ticks: car.ticks, laps: car.laps, finished: car.finished, trackId: route.id, rewardTotals: { ...car.rewardTotals } };
}

export type GeneralistEvaluation = { fitness: number; progress: number; ticks: number; laps: number; finished: boolean; rewardTotals: RewardTotals; episodes: EvaluationResult[] };

export function evaluateGeneralist(network: SpikingNetwork, trackRefs: TrackRef[] = TRACKS, rewardConfig: RewardConfig = DEFAULT_REWARD_CONFIG): GeneralistEvaluation {
  const routes = trackRefs.length > 0 ? trackRefs.map(resolveTrack) : [DEFAULT_TRACK]; const episodes = routes.map((route) => evaluate(network, route, rewardConfig));
  const average = (selector: (episode: EvaluationResult) => number): number => episodes.reduce((sum, episode) => sum + selector(episode), 0) / episodes.length;
  const rewardTotals = emptyRewards();
  (Object.keys(rewardTotals) as (keyof RewardBreakdown)[]).forEach((key) => { rewardTotals[key] = average((episode) => episode.rewardTotals[key]); });
  return { fitness: average((episode) => episode.fitness), progress: average((episode) => episode.progress), ticks: episodes.reduce((sum, episode) => sum + episode.ticks, 0), laps: episodes.reduce((sum, episode) => sum + episode.laps, 0), finished: episodes.every((episode) => episode.finished), rewardTotals, episodes };
}

export function createNetworkPopulation(size: number): SpikingNetwork[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("population size must be a positive integer");
  return Array.from({ length: size }, (_, index) => new SpikingNetwork(index + 1));
}
