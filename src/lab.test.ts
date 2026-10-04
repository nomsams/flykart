import { describe, expect, it } from "vitest";
import sampleBrain from "../public/sample-brain.json?raw";
import { SpikingNetwork, TRACKS, createHeuristicImitationNetwork, DEFAULT_TRACK } from "./core";
import { DriveSession, HIDDEN_COUNT, INPUT_COUNT, OUTPUT_INFO, Probe, REWARD_INFO, SENSOR_INFO, analyseBrain, parseBrainFile, responseCurves, silenceNeurons } from "./lab";

const network = new SpikingNetwork(42);
const snapshot = network.toJSON();
const checkpoint = { format: "flykart-brain", version: 2, savedAt: "2026-01-01T00:00:00Z", fitness: 123.4, generation: 7, track: "all", provenance: [{ source: "unit test" }], network: snapshot };

describe("parseBrainFile", () => {
  it("reads a downloaded checkpoint with its metadata", () => {
    const file = parseBrainFile(JSON.stringify(checkpoint));
    expect(file.meta.generation).toBe(7);
    expect(file.meta.fitness).toBeCloseTo(123.4);
    expect(file.meta.sources).toEqual(["unit test"]);
    expect(file.meta.upgradedFromLegacy).toBe(false);
    expect(file.snapshot.inputWeights).toHaveLength(INPUT_COUNT * HIDDEN_COUNT);
  });
  it("reads the localStorage wrapper and a bare snapshot", () => {
    expect(parseBrainFile(JSON.stringify({ fitness: 5, generation: 2, network: snapshot })).meta.format).toBe("network snapshot");
    expect(parseBrainFile(JSON.stringify(snapshot)).snapshot.bias).toHaveLength(HIDDEN_COUNT);
  });
  it("upgrades a nine-sensor brain the way the simulator does", () => {
    const legacy = { ...snapshot, version: 1 as const, inputCount: 9, inputWeights: snapshot.inputWeights.slice(0, 9 * HIDDEN_COUNT), outputWeights: snapshot.outputWeights.slice(0, 3 * HIDDEN_COUNT) };
    const file = parseBrainFile(JSON.stringify({ network: legacy }));
    expect(file.meta.upgradedFromLegacy).toBe(true);
    expect(file.snapshot.inputWeights).toHaveLength(INPUT_COUNT * HIDDEN_COUNT);
    expect(file.snapshot.inputWeights.slice(9, 17)).toEqual(new Array(8).fill(0));
  });
  it("rejects files that are not brains, with a readable message", () => {
    expect(() => parseBrainFile("not json")).toThrow(/valid JSON/);
    expect(() => parseBrainFile(JSON.stringify({ format: "something-else", network: snapshot }))).toThrow(/not a FlyKart brain/);
    expect(() => parseBrainFile(JSON.stringify({ hello: "world" }))).toThrow(/No network found/);
    expect(() => parseBrainFile(JSON.stringify({ network: { ...snapshot, bias: [1, 2, 3] } }))).toThrow();
  });
});

describe("analyseBrain", () => {
  const analysis = analyseBrain(snapshot);
  it("counts every parameter and assigns every neuron exactly one role", () => {
    expect(analysis.parameterCount).toBe(17 * 48 + 48 * 48 + 4 * 48 + 48);
    expect(analysis.neurons).toHaveLength(HIDDEN_COUNT);
    expect(Object.values(analysis.roleCounts).reduce((sum, count) => sum + count, 0)).toBe(HIDDEN_COUNT);
    expect(analysis.sensorShare.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 6);
  });
  it("reads weights from the right places", () => {
    const j = 5;
    expect(analysis.neurons[j].effect.steer).toBe(snapshot.outputWeights[j]);
    expect(analysis.neurons[j].effect.drive).toBeCloseTo(snapshot.outputWeights[48 + j] - snapshot.outputWeights[96 + j]);
    const expected = Array.from({ length: HIDDEN_COUNT }, (_, k) => snapshot.inputWeights[k * 17 + 3] * snapshot.outputWeights[k]).reduce((sum, value) => sum + value, 0);
    expect(analysis.pathway.steer[3]).toBeCloseTo(expected);
  });
  it("labels a hand-built steering neuron as steering", () => {
    const custom = { ...snapshot, outputWeights: snapshot.outputWeights.map(() => 0), recurrentWeights: snapshot.recurrentWeights.map(() => 0) };
    custom.outputWeights[0] = 1; custom.outputWeights[1] = -1; custom.outputWeights[48 + 2] = 1;
    const roles = analyseBrain(custom).neurons;
    expect(roles[0].role).toBe("steer-right");
    expect(roles[1].role).toBe("steer-left");
    expect(roles[2].role).toBe("gas");
  });
});

describe("silenceNeurons", () => {
  it("cuts a neuron's outgoing influence and nothing else", () => {
    const cut = silenceNeurons(snapshot, [3, 10]);
    for (let o = 0; o < 4; o += 1) expect(cut.outputWeights[o * 48 + 3]).toBe(0);
    for (let j = 0; j < 48; j += 1) expect(cut.recurrentWeights[j * 48 + 10]).toBe(0);
    expect(cut.inputWeights).toEqual(snapshot.inputWeights);
    expect(cut.outputWeights[4]).toBe(snapshot.outputWeights[4]);
    expect(snapshot.outputWeights[3]).not.toBe(0);
  });
});

describe("Probe and response curves", () => {
  it("matches the real network tick for tick", () => {
    const probe = new Probe(snapshot); const reference = SpikingNetwork.fromJSON(snapshot);
    const sensors = Array.from({ length: 17 }, (_, i) => Math.sin(i));
    for (let tick = 0; tick < 20; tick += 1) {
      const frame = probe.step(sensors); const action = reference.step(sensors);
      expect(frame.action.steer).toBeCloseTo(action.steer, 12);
      expect(Array.from(frame.spikes)).toEqual(Array.from(reference.activity().spikes));
    }
  });
  it("sweeps every sensor deterministically", () => {
    const base = new Array(17).fill(0);
    const a = responseCurves(snapshot, base, 5); const b = responseCurves(snapshot, base, 5);
    expect(a.steer).toHaveLength(17);
    expect(a.steer[0]).toHaveLength(5);
    expect(a.steer).toEqual(b.steer);
    expect(a.swing.steer[0]).toBeCloseTo(Math.max(...a.steer[0]) - Math.min(...a.steer[0]));
  });
});

describe("static descriptions", () => {
  it("describe every sensor, output and reward term once", () => {
    expect(SENSOR_INFO.map((sensor) => sensor.index)).toEqual(Array.from({ length: 17 }, (_, i) => i));
    expect(OUTPUT_INFO).toHaveLength(3);
    expect(new Set(REWARD_INFO.map((reward) => reward.key)).size).toBe(REWARD_INFO.length);
    REWARD_INFO.forEach((reward) => reward.sensors.forEach((index) => expect(index).toBeLessThan(17)));
  });
});

describe("DriveSession", () => {
  const driver = createHeuristicImitationNetwork([DEFAULT_TRACK], 3, 200, 1).toJSON();
  it("runs the real physics and reports each reward term", () => {
    const session = new DriveSession(driver, { trackId: "grand-loop", rivals: 0, roadObjects: 0, objectKind: "stalled-car", seed: 1, walls: true });
    let sum = 0, last = session.step();
    sum += last.reward.total;
    for (let i = 0; i < 240; i += 1) { last = session.step(); sum += last.reward.total; }
    expect(last.sensors).toHaveLength(17);
    expect(last.car.speed).toBeGreaterThan(5);
    expect(last.totals.total).toBeCloseTo(sum, 6);
    expect(last.car.progress).toBeGreaterThan(0.02);
  });
  it("moves the kart where poking says it should", () => {
    const session = new DriveSession(driver, { trackId: "grand-loop", rivals: 0, roadObjects: 0, objectKind: "stalled-car", seed: 1, walls: true });
    for (let i = 0; i < 200; i += 1) session.step();
    session.placeAcrossRoad(0.7);
    expect(session.step().car.lateral).toBeGreaterThan(0.5);
    session.placeAcrossRoad(-0.7);
    expect(session.step().car.lateral).toBeLessThan(-0.5);
    session.dropObject("cone", 120, 0);
    expect(session.step().others.some((other) => other.kind === "cone")).toBe(true);
  });
  it("sees traffic in its sensors when a kart is close", () => {
    const session = new DriveSession(driver, { trackId: "grand-loop", rivals: 2, roadObjects: 0, objectKind: "stalled-car", seed: 1, walls: true });
    const frame = session.step();
    expect(frame.sensors[5]).toBeGreaterThan(0);
  });
});

describe("the bundled sample brain", () => {
  it("is a valid checkpoint that finishes the grand loop", () => {
    const file = parseBrainFile(sampleBrain);
    expect(file.meta.generation).toBeGreaterThan(0);
    const track = TRACKS.find((candidate) => candidate.id === "grand-loop")!;
    const session = new DriveSession(file.snapshot, { trackId: track.id, rivals: 0, roadObjects: 0, objectKind: "stalled-car", seed: 1, walls: true });
    let last = session.step();
    for (let i = 0; i < 2600 && !last.car.finished && !last.car.crashed; i += 1) last = session.step();
    expect(last.car.finished).toBe(true);
  });
});
