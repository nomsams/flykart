export type Vec = { x: number; y: number };
export type Action = { steer: number; throttle: number; brake: number };
export type Sensors = number[];

export const TRACK_WIDTH = 112;
export const STEP = 1 / 30;
export const MAX_TICKS = 1500;
export const TAU = Math.PI * 2;

export const track: Vec[] = [
  { x: -310, y: -100 }, { x: -205, y: -165 }, { x: -30, y: -185 },
  { x: 170, y: -155 }, { x: 305, y: -65 }, { x: 315, y: 70 },
  { x: 195, y: 155 }, { x: 5, y: 180 }, { x: -190, y: 145 },
  { x: -315, y: 50 },
];

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
  nearestDistance: number; offTrackTicks: number; collisions: number; ticks: number; score: number; crashed: boolean;
  color: string; name: string; network?: SpikingNetwork; action: Action; trail: Vec[]; isFly: boolean;
};

export function startPosition(lane = 0): Car {
  const point = track[0]; const tangent = normalize(sub(track[1], point)); const normal = { x: -tangent.y, y: tangent.x };
  return { position: add(point, scale(normal, lane * 23)), heading: Math.atan2(tangent.y, tangent.x), speed: 0, progress: 0,
    totalProgress: 0, laps: 0, bestProgress: 0, nearestDistance: 0, offTrackTicks: 0, collisions: 0, ticks: 0, score: 0,
    crashed: false, color: "#f19a69", name: "bot", action: { steer: 0, throttle: 1, brake: 0 }, trail: [], isFly: false };
}

export function nearestTrack(position: Vec): { point: Vec; tangent: Vec; distance: number; progress: number } {
  let best = { point: track[0], tangent: normalize(sub(track[1], track[0])), distance: Infinity, progress: 0 };
  for (let index = 0; index < track.length; index += 1) {
    const a = track[index]; const b = track[(index + 1) % track.length]; const segment = sub(b, a);
    const t = clamp(dot(sub(position, a), segment) / Math.max(1, dot(segment, segment)), 0, 1);
    const point = add(a, scale(segment, t)); const distance = dist(position, point);
    if (distance < best.distance) best = { point, tangent: normalize(segment), distance, progress: (index + t) / track.length };
  }
  return best;
}

export function sensorValues(car: Car, others: Car[]): Sensors {
  const closest = nearestTrack(car.position); const next = track[Math.floor((closest.progress * track.length + 2) % track.length)];
  const desiredHeading = Math.atan2(next.y - car.position.y, next.x - car.position.x);
  const headingError = wrapAngle(desiredHeading - car.heading) / Math.PI;
  const tangentHeading = Math.atan2(closest.tangent.y, closest.tangent.x); const curvature = wrapAngle(tangentHeading - car.heading) / Math.PI;
  const forward = { x: Math.cos(car.heading), y: Math.sin(car.heading) }; const side = { x: -forward.y, y: forward.x };
  const opponent = others.filter((other) => other !== car).map((other) => {
    const offset = sub(other.position, car.position); const distance = Math.hypot(offset.x, offset.y); const direction = normalize(offset);
    return { distance, forward: dot(direction, forward), side: dot(direction, side) };
  }).filter((item) => item.distance < 180 && item.forward > 0).sort((a, b) => a.distance - b.distance)[0];
  return [clamp(headingError, -1, 1), clamp(curvature, -1, 1), clamp(closest.distance / (TRACK_WIDTH / 2), -1, 1),
    clamp(car.speed / 95, 0, 1), clamp(1 - closest.distance / (TRACK_WIDTH / 2), -1, 1),
    opponent ? clamp(1 - opponent.distance / 180, 0, 1) : 0, opponent ? clamp(opponent.side, -1, 1) : 0,
    Math.sin(car.ticks * 0.025), 1];
}

export function heuristicAction(car: Car, others: Car[]): Action {
  const sensors = sensorValues(car, others); const steer = clamp(sensors[0] * 1.8 + sensors[1] * 0.8 + sensors[2] * 1.2, -1, 1);
  return { steer, throttle: clamp(1 - Math.abs(steer) * 0.45, 0.35, 1), brake: Math.abs(steer) > 0.85 ? 0.12 : 0 };
}

export function stepCar(car: Car, action: Action, others: Car[]): void {
  if (car.crashed) return;
  const nearby = nearestTrack(car.position); const offTrack = nearby.distance > TRACK_WIDTH / 2; const grip = offTrack ? 0.35 : 1;
  car.heading += action.steer * (0.65 + car.speed / 150) * grip * STEP;
  car.speed = clamp(car.speed + (action.throttle * 55 - action.brake * 75 - car.speed * 0.23) * STEP, 0, 90);
  car.position = add(car.position, { x: Math.cos(car.heading) * car.speed * STEP, y: Math.sin(car.heading) * car.speed * STEP });
  const updated = nearestTrack(car.position); const rawDelta = updated.progress - car.progress; let forwardDelta = rawDelta;
  if (rawDelta < -0.5) { forwardDelta += 1; car.laps += 1; } else if (rawDelta > 0.5) forwardDelta -= 1;
  if (forwardDelta > 0) car.totalProgress += forwardDelta; car.progress = updated.progress; car.bestProgress = Math.max(car.bestProgress, car.progress);
  car.nearestDistance = updated.distance; if (offTrack) car.offTrackTicks += 1;
  car.ticks += 1; if (car.ticks % 8 === 0) car.trail.push({ ...car.position }); if (car.trail.length > 38) car.trail.shift();
  if (others.some((other) => other !== car && dist(car.position, other.position) < 21)) { car.speed *= 0.55; car.collisions += 1; }
  car.score = car.totalProgress * 1000 + car.speed * 0.2 - car.offTrackTicks * 0.08 - car.collisions * 7;
  if (car.ticks > MAX_TICKS || (car.nearestDistance > TRACK_WIDTH * 1.25 && car.speed < 2)) car.crashed = true;
}

export function evaluate(network: SpikingNetwork): { fitness: number; progress: number; ticks: number } {
  const car = startPosition(); car.network = network; network.reset();
  const obstacles = [startPosition(-1), startPosition(1)]; obstacles[0].position = add(obstacles[0].position, { x: 55, y: 25 }); obstacles[1].position = add(obstacles[1].position, { x: 115, y: -35 });
  const cars = [car, ...obstacles];
  for (let tick = 0; tick < MAX_TICKS && !car.crashed; tick += 1) {
    stepCar(car, network.step(sensorValues(car, cars)), cars);
    obstacles.forEach((bot) => stepCar(bot, heuristicAction(bot, cars), cars));
  }
  return { fitness: car.score - (car.crashed ? 25 : 0), progress: car.totalProgress, ticks: car.ticks };
}

export function createNetworkPopulation(size: number): SpikingNetwork[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("population size must be a positive integer");
  return Array.from({ length: size }, (_, index) => new SpikingNetwork(index + 1));
}
