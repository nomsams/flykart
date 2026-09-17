import { describe, expect, it } from "vitest";
import {
  CAR_COLLISION_DIAMETER, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, STEP, TRACKS, TRACK_WIDTH, BrainSnapshot, SpikingNetwork, createNetworkPopulation,
  evaluate, evaluateGeneralist, heuristicAction, nearestTrack, pointAtDistance, sensorValues, startPosition, stepCar, track,
} from "./core";

const finiteAction = (action: ReturnType<SpikingNetwork["step"]>) => {
  expect(action.steer).toBeGreaterThanOrEqual(-1);
  expect(action.steer).toBeLessThanOrEqual(1);
  expect(action.throttle).toBeGreaterThanOrEqual(0);
  expect(action.throttle).toBeLessThanOrEqual(1);
  expect(action.brake).toBeGreaterThanOrEqual(0);
  expect(action.brake).toBeLessThanOrEqual(1);
};

describe("SpikingNetwork", () => {
  it("is deterministic for the same seed and inputs", () => {
    const first = new SpikingNetwork(42);
    const second = new SpikingNetwork(42);
    const inputs = [0.2, -0.3, 0.1, 0.4, 0.8, 0, -0.2, 0.5, 1];
    for (let index = 0; index < 20; index += 1) expect(first.step(inputs)).toEqual(second.step(inputs));
  });

  it("resets hidden state and exposes bounded actions", () => {
    const network = new SpikingNetwork(7);
    for (let index = 0; index < 40; index += 1) finiteAction(network.step([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    network.reset();
    expect(network.activity().spikes.every((value) => value === 0)).toBe(true);
    expect(network.activity().outputs).toEqual([0, 0, 0]);
  });

  it("rejects malformed input vectors", () => {
    const network = new SpikingNetwork(1);
    expect(() => network.step([0, 1])).toThrow("invalid neural input vector");
    expect(() => network.step([NaN, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow("invalid neural input vector");
  });

  it("clones weights without sharing mutable neural state", () => {
    const original = new SpikingNetwork(3);
    const clone = original.clone();
    expect(clone.toJSON()).toEqual(original.toJSON());
    original.step([1, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(clone.activity().spikes.every((value) => value === 0)).toBe(true);
  });

  it("mutates deterministically and preserves dimensions", () => {
    const original = new SpikingNetwork(3);
    const a = original.mutate(0.15, 0.2, 99).toJSON();
    const b = original.mutate(0.15, 0.2, 99).toJSON();
    expect(a).toEqual(b);
    expect(a.inputWeights).toHaveLength(48 * 9);
    expect(a.recurrentWeights).toHaveLength(48 * 48);
    expect(a.outputWeights).toHaveLength(48 * 3);
    expect(a.bias).toHaveLength(48);
  });

  it("round-trips a checkpoint and rejects bad dimensions", () => {
    const source = new SpikingNetwork(12);
    const snapshot = source.toJSON();
    expect(SpikingNetwork.fromJSON(snapshot).toJSON()).toEqual(snapshot);
    const malformed = { ...snapshot, inputWeights: snapshot.inputWeights.slice(1) } as BrainSnapshot;
    expect(() => SpikingNetwork.fromJSON(malformed)).toThrow("checkpoint dimensions are invalid");
    expect(() => SpikingNetwork.fromJSON({ ...snapshot, version: 9 } as unknown as BrainSnapshot)).toThrow("checkpoint format");
  });
});

describe("track geometry and sensors", () => {
  it("keeps the start point on the centerline", () => {
    const car = startPosition();
    const nearest = nearestTrack(car.position);
    expect(nearest.distance).toBeLessThan(0.001);
    expect(nearest.progress).toBeCloseTo(0, 4);
  });

  it("produces a finite, bounded sensor vector", () => {
    const car = startPosition();
    const sensors = sensorValues(car, [car, startPosition(1)]);
    expect(sensors).toHaveLength(9);
    sensors.forEach((value) => expect(Number.isFinite(value)).toBe(true));
    expect(sensors.every((value) => value >= -1 && value <= 1)).toBe(true);
  });

  it("does not mutate the track when sensing", () => {
    const before = JSON.stringify(track);
    sensorValues(startPosition(), [startPosition()]);
    expect(JSON.stringify(track)).toBe(before);
  });

  it("supports independent track geometries with a valid start line", () => {
    expect(TRACKS).toHaveLength(3);
    expect(new Set(TRACKS.map((route) => route.id)).size).toBe(TRACKS.length);
    TRACKS.forEach((route) => {
      const car = startPosition(0, route);
      const nearest = nearestTrack(car.position, route);
      expect(nearest.distance).toBeLessThan(0.001);
      expect(nearest.progress).toBeCloseTo(0, 4);
      expect(car.trackId).toBe(route.id);
      expect(route.length).toBeGreaterThan(500);
    });
  });

  it("wraps distance samples around every track", () => {
    TRACKS.forEach((route) => {
      const start = pointAtDistance(0, route);
      const wrapped = pointAtDistance(route.length, route);
      expect(wrapped.point.x).toBeCloseTo(start.point.x, 5);
      expect(wrapped.point.y).toBeCloseTo(start.point.y, 5);
      expect(Math.hypot(wrapped.tangent.x, wrapped.tangent.y)).toBeCloseTo(1, 5);
    });
  });
});

describe("vehicle physics and fitness", () => {
  it("advances a car with throttle and fixed simulation steps", () => {
    const car = startPosition();
    const initial = { ...car.position };
    for (let index = 0; index < 30; index += 1) stepCar(car, { steer: 0, throttle: 1, brake: 0 }, [car]);
    expect(car.ticks).toBe(30);
    expect(car.speed).toBeGreaterThan(0);
    expect(Math.hypot(car.position.x - initial.x, car.position.y - initial.y)).toBeGreaterThan(0);
    expect(STEP).toBeCloseTo(1 / 30);
  });

  it("does not reward reverse travel as forward progress", () => {
    const car = startPosition();
    for (let index = 0; index < 90; index += 1) stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car]);
    expect(car.totalProgress).toBe(0);
  });

  it("supports deliberate reverse driving without creating forward progress", () => {
    const car = startPosition(); const initial = { ...car.position }; const tangent = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
    for (let index = 0; index < 60; index += 1) stepCar(car, { steer: 0, throttle: 0, reverse: 1, brake: 0 }, [car]);
    const displacement = { x: car.position.x - initial.x, y: car.position.y - initial.y };
    expect(car.speed).toBeLessThan(0);
    expect(displacement.x * tangent.x + displacement.y * tangent.y).toBeLessThan(0);
    expect(car.totalProgress).toBe(0);
    expect(car.crashed).toBe(false);
  });

  it("counts collisions and applies off-track penalties", () => {
    const first = startPosition();
    const second = startPosition();
    const initialScore = first.score;
    stepCar(first, { steer: 0, throttle: 1, brake: 0 }, [first, second]);
    expect(first.collisions).toBeGreaterThan(0);
    expect(first.score).toBeLessThanOrEqual(initialScore + first.speed * 0.2);
    const offTrack = startPosition(); offTrack.position.x += TRACK_WIDTH * 2;
    stepCar(offTrack, { steer: 0, throttle: 0, brake: 0 }, [offTrack]);
    expect(offTrack.offTrackTicks).toBe(1);
  });

  it("separates overlapping car footprints instead of leaving them stacked", () => {
    const first = startPosition(); const second = startPosition();
    stepCar(first, { steer: 0, throttle: 0, brake: 0 }, [first, second]);
    expect(first.collisions).toBe(1);
    expect(Math.hypot(first.position.x - second.position.x, first.position.y - second.position.y)).toBeGreaterThanOrEqual(CAR_COLLISION_DIAMETER);
    expect(first.speed).toBe(0);
  });

  it("recovers a car from a far edge excursion without killing it", () => {
    const car = startPosition(); car.position.x += TRACK_WIDTH * 2;
    const before = nearestTrack(car.position).distance;
    for (let index = 0; index < 12; index += 1) stepCar(car, heuristicAction(car, [car]), [car]);
    expect(car.crashed).toBe(false);
    expect(car.offTrackTicks).toBeGreaterThan(0);
    expect(car.nearestDistance).toBeLessThan(before);
  });

  it("gives the centerline a larger bonus than an edge lane", () => {
    const center = startPosition(0); const edge = startPosition(1);
    stepCar(center, { steer: 0, throttle: 0, brake: 0 }, [center]);
    stepCar(edge, { steer: 0, throttle: 0, brake: 0 }, [edge]);
    expect(center.rewardBreakdown.centerline).toBeGreaterThan(edge.rewardBreakdown.centerline);
    expect(center.rewardBreakdown.centerline).toBeGreaterThan(0);
    expect(DEFAULT_REWARD_CONFIG.centerlinePerSecond).toBeGreaterThan(0);
  });

  it("keeps evaluation finite and bounded in time", () => {
    const result = evaluate(new SpikingNetwork(21));
    expect(Number.isFinite(result.fitness)).toBe(true);
    expect(Number.isFinite(result.progress)).toBe(true);
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.ticks).toBeLessThanOrEqual(MAX_TICKS);
  });

  it("creates the requested deterministic population", () => {
    const first = createNetworkPopulation(5).map((network) => network.toJSON());
    const second = createNetworkPopulation(5).map((network) => network.toJSON());
    expect(first).toEqual(second);
    expect(() => createNetworkPopulation(0)).toThrow("population size");
    expect(() => createNetworkPopulation(1.5)).toThrow("population size");
  });

  it("keeps the heuristic driver outputs safe", () => {
    const car = startPosition();
    finiteAction(heuristicAction(car, [car, startPosition(1)]));
  });

  it("is repeatable for the same evaluated network", () => {
    const first = evaluate(new SpikingNetwork(31));
    const second = evaluate(new SpikingNetwork(31));
    expect(second).toEqual(first);
  });

  it("keeps cars in separate lanes at the starting grid", () => {
    const center = startPosition(0);
    const left = startPosition(-1);
    const right = startPosition(1);
    expect(Math.hypot(center.position.x - left.position.x, center.position.y - left.position.y)).toBeGreaterThan(20);
    expect(Math.hypot(center.position.x - right.position.x, center.position.y - right.position.y)).toBeGreaterThan(20);
  });

  it("does not move a crashed car", () => {
    const car = startPosition();
    car.crashed = true;
    const before = { ...car.position };
    stepCar(car, { steer: 1, throttle: 1, brake: 0 }, [car]);
    expect(car.position).toEqual(before);
    expect(car.ticks).toBe(0);
  });

  it("rewards forward progress and correct heading", () => {
    const car = startPosition();
    stepCar(car, { steer: 0, throttle: 1, brake: 0 }, [car]);
    expect(car.rewardBreakdown.progress).toBeGreaterThan(0);
    expect(car.rewardBreakdown.direction).toBeGreaterThan(0);
    expect(car.rewardBreakdown.total).toBe(car.lastReward);
  });

  it("penalizes standing still and facing against the track", () => {
    const car = startPosition();
    car.heading += Math.PI;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car]);
    expect(car.rewardBreakdown.standingStill).toBeGreaterThan(0);
    expect(car.rewardBreakdown.wrongDirection).toBeGreaterThan(0);
    expect(car.lastReward).toBeLessThan(0);
  });

  it("penalizes time spent outside the track", () => {
    const car = startPosition();
    car.position.x += TRACK_WIDTH * 2;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car]);
    expect(car.rewardBreakdown.offTrack).toBeGreaterThan(0);
    expect(car.offTrackTicks).toBe(1);
  });

  it("detects a forward finish-line crossing exactly once", () => {
    const car = startPosition(0, DEFAULT_TRACK);
    const last = DEFAULT_TRACK.points[DEFAULT_TRACK.points.length - 1];
    const start = DEFAULT_TRACK.points[0];
    const blend = 0.995;
    car.position = { x: last.x + (start.x - last.x) * blend, y: last.y + (start.y - last.y) * blend };
    car.heading = Math.atan2(start.y - last.y, start.x - last.x);
    car.speed = 40;
    car.progress = nearestTrack(car.position, DEFAULT_TRACK).progress;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK);
    expect(car.finished).toBe(true);
    expect(car.laps).toBe(1);
    expect(car.rewardBreakdown.finish).toBeGreaterThan(0);
  });

  it("evaluates a controller across every track for a generalist score", () => {
    const result = evaluateGeneralist(new SpikingNetwork(44), TRACKS);
    expect(result.episodes.map((episode) => episode.trackId)).toEqual(TRACKS.map((route) => route.id));
    expect(result.episodes).toHaveLength(TRACKS.length);
    expect(Number.isFinite(result.fitness)).toBe(true);
    expect(Number.isFinite(result.rewardTotals.total)).toBe(true);
    expect(result.ticks).toBeGreaterThan(0);
  });
});
