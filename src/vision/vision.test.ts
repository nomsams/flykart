import { describe, expect, it } from "vitest";
import { SpikingNetwork, TRACKS } from "../core";
import sampleBrain from "../../public/sample-brain.json?raw";
import { DEFAULT_CAMERA, frameLength, groundDistanceAtRow, renderFrame } from "./camera";
import { ESTIMATE_COUNT, EstimateCorruptor, NO_NOISE, NOISE_LEVELS, bodyFromSensors, estimatesFromSensors, sensorsFromEstimates } from "./interface";
import { TrackEpisode } from "./episode";
import { mulberry32 } from "./rng";

const brain = () => SpikingNetwork.fromJSON(JSON.parse(sampleBrain).network);

describe("camera", () => {
  it("is deterministic and keeps every pixel in range", () => {
    const render = () => { const episode = new TrackEpisode({ track: "grand-loop", rivals: 1, roadObjects: 2, seed: 4, styleStrength: 1 }); return episode.render().slice(); };
    const a = render(), b = render();
    expect(a.length).toBe(frameLength(DEFAULT_CAMERA));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0); expect(Math.max(...a)).toBeLessThanOrEqual(1);
  });

  it("looks farther the closer a row is to the horizon", () => {
    const distances = Array.from({ length: DEFAULT_CAMERA.height }, (_, row) => groundDistanceAtRow(DEFAULT_CAMERA, row)).filter((d) => d > 0);
    for (let i = 1; i < distances.length; i += 1) expect(distances[i]).toBeLessThan(distances[i - 1]);
    expect(distances[0]).toBeGreaterThan(100);
    expect(distances[distances.length - 1]).toBeLessThan(30);
  });

  it("shows a kart that sits ahead and not the same scene without it", () => {
    const without = new TrackEpisode({ track: "grand-loop", seed: 1 });
    const withRival = new TrackEpisode({ track: "grand-loop", seed: 1, rivals: 1 });
    const frameA = without.render().slice(), frameB = withRival.render().slice();
    let changed = 0; for (let i = 0; i < frameA.length; i += 1) if (Math.abs(frameA[i] - frameB[i]) > 0.05) changed += 1;
    expect(changed).toBeGreaterThan(8);
  });

  it("renders in place without allocating a new frame", () => {
    const episode = new TrackEpisode({ track: "hairpin" });
    const frame = new Float32Array(frameLength(DEFAULT_CAMERA));
    const out = renderFrame(episode.scene!, { x: episode.car.position.x, y: episode.car.position.y, heading: episode.car.heading }, DEFAULT_CAMERA, frame);
    expect(out).toBe(frame);
  });
});

describe("the estimate interface is the simulator's own sensor vector", () => {
  it("round-trips the simulator sensors on a clean lap", () => {
    const network = brain(); const episode = new TrackEpisode({ track: "chicane", headless: true, seed: 2 });
    let worst = 0;
    for (let tick = 0; tick < 700 && !episode.done; tick += 1) {
      const sensors = episode.privileged();
      const rebuilt = sensorsFromEstimates(episode.truth(), bodyFromSensors(sensors));
      sensors.forEach((value, index) => { worst = Math.max(worst, Math.abs(value - rebuilt[index])); });
      episode.step(network.step(sensors));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("keeps the camera-visible traffic equal to the simulator's when the nearest kart is in view", () => {
    const episode = new TrackEpisode({ track: "grand-loop", headless: true, rivals: 2, seed: 3 });
    const truth = episode.truth(); const sensors = episode.privileged();
    expect(truth[8]).toBeCloseTo(sensors[5], 6); expect(truth[10]).toBeCloseTo(sensors[9], 6);
  });

  it("estimatesFromSensors undoes sensorsFromEstimates for the road channels", () => {
    const sensors = [0.1, -0.2, 0.4, 0.5, 0.6, 0, 0, 0.6, 0.98, 0, 0, 0.05, -0.3, 0.2, 0.1, 0.3, 0];
    const estimates = estimatesFromSensors(sensors, Math.acos(0.98) / Math.PI);
    const back = sensorsFromEstimates(estimates, bodyFromSensors(sensors));
    back.forEach((value, index) => expect(value).toBeCloseTo(sensors[index], 6));
  });
});

describe("estimate corruption", () => {
  it("leaves clean estimates alone", () => {
    const corruptor = new EstimateCorruptor(NO_NOISE, mulberry32(1));
    const input = Array.from({ length: ESTIMATE_COUNT }, (_, i) => i / 20);
    expect(corruptor.apply(input)).toEqual(input);
  });

  it("delays by the requested number of ticks", () => {
    const corruptor = new EstimateCorruptor({ ...NO_NOISE, delayTicks: 3 }, mulberry32(1));
    const outputs = [0, 1, 2, 3, 4, 5].map((v) => corruptor.apply(new Array(ESTIMATE_COUNT).fill(v))[0]);
    expect(outputs).toEqual([0, 0, 0, 0, 1, 2]);
  });

  it("gets noisier as the level rises", () => {
    const spread = NOISE_LEVELS.map((level) => {
      const corruptor = new EstimateCorruptor(level.spec, mulberry32(9)); let sum = 0;
      for (let i = 0; i < 400; i += 1) sum += corruptor.apply(new Array(ESTIMATE_COUNT).fill(0)).reduce((a, v) => a + v * v, 0);
      return sum;
    });
    for (let i = 1; i < spread.length; i += 1) expect(spread[i]).toBeGreaterThan(spread[i - 1]);
  });
});

describe("tracks", () => { it("are all defined", () => expect(TRACKS.length).toBeGreaterThan(10)); });
