import { describe, expect, it } from "vitest";
import {
  CAR_COLLISION_DIAMETER, CHECKPOINT_COUNT, CLOSE_PROXIMITY_DISTANCE, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, STEP, TRACKS, TRACK_WIDTH, BrainSnapshot, SpikingNetwork, createMutationPopulation, createNetworkPopulation, createRoadObstacles,
  evaluate, evaluateGeneralist, heuristicAction, nearestTrack, pointAtDistance, resolveTrack, sensorValues, startLine, startPosition, stepCar, track, trackCheckpoint,
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

  it("keeps the incumbent first and adds deterministic exploration immigrants after a plateau", () => {
    const parent = new SpikingNetwork(12);
    const partner = new SpikingNetwork(13);
    const local = createMutationPopulation(10, parent, 300, 0.12, 0.22);
    const exploratory = createMutationPopulation(10, parent, 300, 0.12, 0.22, { plateauStreak: 3, plateauPatience: 3 });
    const bred = createMutationPopulation(4, parent, 301, 0.12, 0.22, { breedingPool: [parent, partner] });
    expect(local[0].toJSON()).toEqual(parent.toJSON());
    expect(exploratory[0].toJSON()).toEqual(parent.toJSON());
    expect(bred[0].toJSON()).toEqual(parent.toJSON());
    expect(createMutationPopulation(10, parent, 300, 0.12, 0.22, { plateauStreak: 3, plateauPatience: 3 }).map((network) => network.toJSON())).toEqual(exploratory.map((network) => network.toJSON()));
    expect(exploratory.slice(1).some((network) => network.toJSON().inputWeights.join(",") !== parent.toJSON().inputWeights.join(","))).toBe(true);
    expect(bred[1].toJSON()).not.toEqual(parent.toJSON());
  });

  it("resets hidden state and exposes bounded actions", () => {
    const network = new SpikingNetwork(7);
    for (let index = 0; index < 40; index += 1) finiteAction(network.step([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    network.reset();
    expect(network.activity().spikes.every((value) => value === 0)).toBe(true);
    expect(network.activity().outputs).toEqual([0, 0, 0, 0]);
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
    expect(a.outputWeights).toHaveLength(48 * 4);
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

  it("loads older three-output checkpoints and keeps their reverse output neutral", () => {
    const source = new SpikingNetwork(13).toJSON();
    const legacy = { ...source, outputCount: undefined, outputWeights: source.outputWeights.slice(0, 48 * 3) } as BrainSnapshot;
    const loaded = SpikingNetwork.fromJSON(legacy);
    expect(loaded.toJSON().outputWeights).toHaveLength(48 * 4);
    expect(loaded.step([0, 0, 0, 0, 0, 0, 0, 0, 0]).reverse).toBe(0);
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

  it("exposes forward cars, edge clearance, and travel alignment to the controller", () => {
    const car = startPosition(); const obstacle = startPosition(); const sample = pointAtDistance(80, DEFAULT_TRACK);
    obstacle.position = sample.point; obstacle.heading = Math.atan2(sample.tangent.y, sample.tangent.x);
    const sensors = sensorValues(car, [car, obstacle]);
    expect(sensors[5]).toBeGreaterThan(0);
    expect(sensors[7]).toBeGreaterThan(0.9);
    expect(sensors[8]).toBeGreaterThan(0.5);
  });

  it("reports nearby traffic even before a collision", () => {
    const car = startPosition(); const other = startPosition();
    const tangent = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
    other.position = { x: car.position.x + tangent.x * (CAR_COLLISION_DIAMETER * 1.35), y: car.position.y + tangent.y * (CAR_COLLISION_DIAMETER * 1.35) };
    const sensors = sensorValues(car, [car, other]);
    expect(sensors[5]).toBeGreaterThan(0.7);
    expect(Number.isFinite(CLOSE_PROXIMITY_DISTANCE)).toBe(true);
  });

  it("does not mutate the track when sensing", () => {
    const before = JSON.stringify(track);
    sensorValues(startPosition(), [startPosition()]);
    expect(JSON.stringify(track)).toBe(before);
  });

  it("supports independent track geometries with a valid start line", () => {
    expect(TRACKS).toHaveLength(6);
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

  it("creates deterministic stalled road objects on every track", () => {
    TRACKS.forEach((route) => {
      const first = createRoadObstacles(6, route, 11); const second = createRoadObstacles(6, route, 11);
      expect(first.map((car) => car.position)).toEqual(second.map((car) => car.position));
      expect(first).toHaveLength(6);
      expect(first.every((car) => car.isObstacle && car.speed === 0 && car.trackId === route.id)).toBe(true);
    });
  });

  it("supports more than the default eight ordered checkpoint gates", () => {
    const checkpoint = trackCheckpoint(15, DEFAULT_TRACK, 16);
    expect(checkpoint.index).toBe(15);
    expect(checkpoint.progress).toBeCloseTo(15 / 16, 5);
    const car = startPosition();
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { ...DEFAULT_PHYSICS_CONFIG, checkpointCount: 16 });
    expect(car.nextCheckpoint).toBe(1);
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

  it("shares collision separation and momentum so a stopped car is not an immovable wall", () => {
    const first = startPosition(); const second = startPosition();
    const tangent = { x: Math.cos(first.heading), y: Math.sin(first.heading) };
    second.position = { x: first.position.x + tangent.x * (CAR_COLLISION_DIAMETER - 2), y: first.position.y + tangent.y * (CAR_COLLISION_DIAMETER - 2) };
    first.speed = 50;
    stepCar(first, { steer: 0, throttle: 0, brake: 0 }, [first, second]);
    expect(second.speed).toBeGreaterThan(0);
    expect(Math.hypot(first.position.x - second.position.x, first.position.y - second.position.y)).toBeGreaterThanOrEqual(CAR_COLLISION_DIAMETER);
  });

  it("penalizes close traffic before contact and includes it in the total", () => {
    const car = startPosition(); const other = startPosition();
    const tangent = { x: Math.cos(car.heading), y: Math.sin(car.heading) };
    other.position = { x: car.position.x + tangent.x * (CAR_COLLISION_DIAMETER * 1.2), y: car.position.y + tangent.y * (CAR_COLLISION_DIAMETER * 1.2) };
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car, other]);
    expect(car.rewardBreakdown.proximity).toBeGreaterThan(0);
    expect(car.lastReward).toBeLessThan(0);
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

  it("uses a stronger penalty the farther a car leaves the road", () => {
    const sample = pointAtDistance(200, DEFAULT_TRACK); const normal = { x: -sample.tangent.y, y: sample.tangent.x }; const near = startPosition(); const far = startPosition();
    near.position = { x: sample.point.x + normal.x * (DEFAULT_TRACK.width / 2 + 4), y: sample.point.y + normal.y * (DEFAULT_TRACK.width / 2 + 4) };
    far.position = { x: sample.point.x + normal.x * (DEFAULT_TRACK.width * 2), y: sample.point.y + normal.y * (DEFAULT_TRACK.width * 2) };
    stepCar(near, { steer: 0, throttle: 0, brake: 0 }, [near], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { wallsEnabled: false });
    stepCar(far, { steer: 0, throttle: 0, brake: 0 }, [far], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { wallsEnabled: false });
    expect(far.rewardBreakdown.offTrack).toBeGreaterThan(near.rewardBreakdown.offTrack);
  });

  it("cuts outside-track speed roughly in half and slows farther excursions more", () => {
    const sample = pointAtDistance(200, DEFAULT_TRACK); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
    const onRoad = startPosition(); const near = startPosition(); const far = startPosition();
    onRoad.position = sample.point; near.position = { x: sample.point.x + normal.x * (DEFAULT_TRACK.width / 2 + 4), y: sample.point.y + normal.y * (DEFAULT_TRACK.width / 2 + 4) }; far.position = { x: sample.point.x + normal.x * (DEFAULT_TRACK.width * 2), y: sample.point.y + normal.y * (DEFAULT_TRACK.width * 2) };
    [onRoad, near, far].forEach((car) => { car.heading = Math.atan2(sample.tangent.y, sample.tangent.x); car.speed = 60; stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { wallsEnabled: false }); });
    expect(onRoad.speed).toBeGreaterThan(50);
    expect(near.speed).toBeLessThan(onRoad.speed * 0.6);
    expect(far.speed).toBeLessThan(near.speed);
    expect(Number.isFinite(far.speed)).toBe(true);
  });

  it("uses normalized gate directions around sharp turns", () => {
    const route = resolveTrack("sharp-turn"); const line = startLine(route);
    expect(Math.hypot(line.tangent.x, line.tangent.y)).toBeCloseTo(1, 5);
    expect(Math.hypot(line.normal.x, line.normal.y)).toBeCloseTo(1, 5);
    for (let index = 0; index < 16; index += 1) {
      const checkpoint = trackCheckpoint(index, route, 16);
      expect(Math.hypot(checkpoint.tangent.x, checkpoint.tangent.y)).toBeCloseTo(1, 5);
      expect(Math.hypot(checkpoint.normal.x, checkpoint.normal.y)).toBeCloseTo(1, 5);
    }
  });

  it("penalizes the road edge while rewarding the centerline", () => {
    const sample = pointAtDistance(200, DEFAULT_TRACK); const normal = { x: -sample.tangent.y, y: sample.tangent.x }; const center = startPosition(); const edge = startPosition();
    edge.position = { x: sample.point.x + normal.x * DEFAULT_TRACK.width * 0.45, y: sample.point.y + normal.y * DEFAULT_TRACK.width * 0.45 };
    stepCar(center, { steer: 0, throttle: 0, brake: 0 }, [center]);
    stepCar(edge, { steer: 0, throttle: 0, brake: 0 }, [edge]);
    expect(edge.rewardBreakdown.edge).toBeGreaterThan(0);
    expect(center.rewardBreakdown.centerline).toBeGreaterThan(edge.rewardBreakdown.centerline);
  });

  it("rewards each ordered checkpoint and rejects a wrong-direction crossing", () => {
    const distance = DEFAULT_TRACK.length / CHECKPOINT_COUNT; const checkpoint = trackCheckpoint(1, DEFAULT_TRACK);
    const before = pointAtDistance(distance - 0.7, DEFAULT_TRACK); const car = startPosition();
    car.position = before.point; car.heading = Math.atan2(checkpoint.tangent.y, checkpoint.tangent.x); car.speed = 40; car.progress = before.distanceAlong / DEFAULT_TRACK.length; car.totalProgress = car.progress;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK);
    expect(car.checkpointsPassed).toBe(1);
    expect(car.nextCheckpoint).toBe(2);
    expect(car.rewardBreakdown.checkpoint).toBe(DEFAULT_REWARD_CONFIG.checkpoint);

    const wrongWay = startPosition(); const after = pointAtDistance(distance + 0.7, DEFAULT_TRACK);
    wrongWay.position = after.point; wrongWay.heading = Math.atan2(checkpoint.tangent.y, checkpoint.tangent.x) + Math.PI; wrongWay.speed = 40; wrongWay.progress = after.distanceAlong / DEFAULT_TRACK.length;
    stepCar(wrongWay, { steer: 0, throttle: 0, brake: 0 }, [wrongWay], DEFAULT_TRACK);
    expect(wrongWay.checkpointsPassed).toBe(0);
    expect(wrongWay.nextCheckpoint).toBe(1);
    expect(wrongWay.rewardBreakdown.checkpoint).toBe(0);
  });

  it("accepts high-speed checkpoint crossings on irregular tracks", () => {
    (['zigzag', 'hairpin'] as const).forEach((trackId) => {
      const route = resolveTrack(trackId); const checkpoint = trackCheckpoint(1, route); const before = pointAtDistance(route.length / CHECKPOINT_COUNT - 0.5, route); const car = startPosition(0, route);
      car.position = before.point; car.heading = Math.atan2(checkpoint.tangent.y, checkpoint.tangent.x); car.speed = 90; car.progress = nearestTrack(car.position, route).progress; car.totalProgress = car.progress;
      stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], route);
      expect(car.checkpointsPassed, `${trackId} checkpoint`).toBe(1);
      expect(car.rewardBreakdown.checkpoint).toBe(DEFAULT_REWARD_CONFIG.checkpoint);
    });
  });

  it("times out without mislabeling a non-crashed car as crashed", () => {
    const car = startPosition(); car.ticks = MAX_TICKS - 1;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car]);
    expect(car.timedOut).toBe(true);
    expect(car.crashed).toBe(false);
    const position = { ...car.position };
    stepCar(car, { steer: 1, throttle: 1, brake: 0 }, [car]);
    expect(car.position).toEqual(position);
  });

  it("doubles the time limit only while reward rate remains viable and improving", () => {
    const adaptive = { wallsEnabled: true, adaptiveTimeLimit: true, maxAdaptiveExtensions: 2 };
    const car = startPosition(); car.ticks = MAX_TICKS - 1; car.rewardWindowTicks = 299; car.rewardWindowScore = 0;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, adaptive);
    expect(car.timeExtensions).toBe(1);
    expect(car.timeLimit).toBe(MAX_TICKS * 2);
    expect(car.timedOut).toBe(false);

    car.ticks = car.timeLimit - 1; car.rewardWindowTicks = 299; car.rewardWindowScore = 10; car.previousRewardRate = 0;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, adaptive);
    expect(car.timeExtensions).toBe(2);
    expect(car.timeLimit).toBe(MAX_TICKS * 4);
    expect(car.timedOut).toBe(false);

    const stalled = startPosition(); stalled.ticks = MAX_TICKS - 1; stalled.rewardWindowTicks = 299; stalled.rewardWindowScore = -100;
    stepCar(stalled, { steer: 0, throttle: 0, brake: 0 }, [stalled], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, adaptive);
    expect(stalled.timeExtensions).toBe(0);
    expect(stalled.timedOut).toBe(true);
    expect(stalled.crashed).toBe(false);
  });

  it("allows adaptive time to extend beyond the old two-extension limit", () => {
    const adaptive = { wallsEnabled: true, adaptiveTimeLimit: true, maxAdaptiveExtensions: 4 };
    const car = startPosition();
    for (let extension = 0; extension < 3; extension += 1) {
      car.ticks = car.timeLimit - 1; car.rewardWindowTicks = 299; car.rewardWindowScore = extension * 10; car.previousRewardRate = extension === 0 ? 0 : extension - 1;
      stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, adaptive);
      expect(car.timedOut).toBe(false);
      expect(car.timeExtensions).toBe(extension + 1);
    }
    expect(car.timeLimit).toBe(MAX_TICKS * 8);
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
    car.totalProgress = car.progress;
    car.checkpointsPassed = CHECKPOINT_COUNT - 1;
    car.nextCheckpoint = 0;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK);
    expect(car.finished).toBe(true);
    expect(car.laps).toBe(1);
    expect(car.rewardBreakdown.finish).toBeGreaterThan(0);
  });

  it("does not award a lap for a tiny start-line loop", () => {
    const car = startPosition(0, DEFAULT_TRACK);
    car.position = { x: DEFAULT_TRACK.points[0].x - 2, y: DEFAULT_TRACK.points[0].y };
    car.heading = startPosition(0, DEFAULT_TRACK).heading;
    car.speed = 20;
    car.progress = nearestTrack(car.position, DEFAULT_TRACK).progress;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK);
    expect(car.finished).toBe(false);
    expect(car.laps).toBe(0);
    expect(car.rewardBreakdown.finish).toBe(0);
    expect(car.totalProgress).toBeLessThan(0.95);
  });

  it("requires nearly a complete lap before a directed finish crossing", () => {
    const car = startPosition(0, DEFAULT_TRACK);
    const last = DEFAULT_TRACK.points[DEFAULT_TRACK.points.length - 1];
    const start = DEFAULT_TRACK.points[0];
    const blend = 0.995;
    car.position = { x: last.x + (start.x - last.x) * blend, y: last.y + (start.y - last.y) * blend };
    car.heading = Math.atan2(start.y - last.y, start.x - last.x);
    car.speed = 40;
    car.progress = nearestTrack(car.position, DEFAULT_TRACK).progress;
    car.totalProgress = 0.90;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK);
    expect(car.finished).toBe(false);
    expect(car.laps).toBe(0);
    expect(car.rewardBreakdown.finish).toBe(0);
  });

  it("lets an open-track car leave the road without wall recovery", () => {
    const car = startPosition();
    car.position.x += TRACK_WIDTH * 1.5;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { wallsEnabled: false });
    expect(car.crashed).toBe(false);
    expect(car.offTrackTicks).toBeGreaterThan(0);
    expect(car.nearestDistance).toBeGreaterThan(DEFAULT_TRACK.width / 2);
    expect(DEFAULT_PHYSICS_CONFIG.wallsEnabled).toBe(true);
  });

  it("applies the outside-track penalty on every racing tick while outside", () => {
    const car = startPosition(); car.position.x += TRACK_WIDTH * 1.5;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { wallsEnabled: false });
    const firstPenalty = car.rewardBreakdown.offTrack;
    stepCar(car, { steer: 0, throttle: 0, brake: 0 }, [car], DEFAULT_TRACK, DEFAULT_REWARD_CONFIG, { wallsEnabled: false });
    expect(firstPenalty).toBeGreaterThan(0);
    expect(car.rewardBreakdown.offTrack).toBeGreaterThan(0);
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
