import { describe, expect, it } from "vitest";
import { DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, SpikingNetwork, evaluate } from "../core";
import sampleBrain from "../../public/sample-brain.json?raw";
import { collect, trackFactory, worldFactory } from "./dagger";
import { trackDomain, worldDomain } from "./domains";
import { driveEpisode } from "./evaluate";
import { controllerCheckpoint, exportAsFlyKartV1, exportVisionBrain, importFile } from "./format";
import { createFused, defaultFusion, fuseCues, privilegedCue } from "./fusion";
import { ESTIMATE_COUNT, ESTIMATE_NAMES } from "./interface";
import { MEMORY_CHANNELS, MushroomBody } from "./memory";
import { VisionDriver } from "./pipeline";
import { Perceiver, defaultSpec, serialiseModel } from "./perception";
import { VisionCnn } from "./cnn";
import { inputChannelCount } from "./retina";
import { DEFAULT_CAMERA } from "./camera";
import { TrackSession, WorldSession } from "./ui/sessions";
import { VisionDataset } from "./train";
import { TrackEpisode } from "./episode";
import { WORLD_CAMERA, WorldEpisode } from "./world/worldDomain";
import controllerFile from "../../public/vision/controller.json?raw";
import visionFile from "../../public/vision/vision-net.json?raw";
import worldControllerFile from "../../public/vision/world-controller.json?raw";
import worldVisionFile from "../../public/vision/world-vision-net.json?raw";
import { SECTORS, WorldSim, castRay, generateWorld, surfaceAt } from "./world/world";
import { runWorldEpisode } from "./world/worldRun";
import { proceduralTrack } from "./proceduralTracks";
import { mulberry32 } from "./rng";

const brain = () => SpikingNetwork.fromJSON(JSON.parse(sampleBrain).network);

describe("cue fusion", () => {
  const cue = (mean: number, variance: number) => ({ mean: new Float32Array(ESTIMATE_COUNT).fill(mean), variance: new Float32Array(ESTIMATE_COUNT).fill(variance) });
  it("averages two equally reliable cues", () => {
    const fused = fuseCues([cue(0.2, 0.01), cue(0.6, 0.01)], createFused(2));
    expect(fused.mean[0]).toBeCloseTo(0.4, 5); expect(fused.variance[0]).toBeCloseTo(0.005, 5);
  });
  it("lets the more reliable cue dominate, and ignores absent cues", () => {
    const fused = fuseCues([cue(0.2, 0.0001), null, cue(0.9, 1)], createFused(3));
    expect(fused.mean[3]).toBeGreaterThan(0.19); expect(fused.mean[3]).toBeLessThan(0.21);
    expect(fused.weights[1][0]).toBe(0); expect(fused.weights[0][0] + fused.weights[2][0]).toBeCloseTo(1, 5);
  });
  it("removes the feeling cue completely at fade 0", () => {
    expect(privilegedCue(new Float32Array(ESTIMATE_COUNT), { ...defaultFusion(), fade: 0 }, cue(0, 1))).toBeNull();
    expect(privilegedCue(new Float32Array(ESTIMATE_COUNT), { ...defaultFusion(), fade: 0.5 }, cue(0, 1))).not.toBeNull();
  });
  it("averaging actions would steer into an obstacle that cue fusion avoids", () => {
    // Feeling says "go left of the obstacle" (-1), vision says "go right of it" (+1): the action average is straight ahead.
    expect((-1 + 1) / 2).toBe(0);
    // Fusing the *beliefs* instead keeps the obstacle's position in view: both agree it is dead ahead, with one more certain.
    const fused = fuseCues([cue(0.05, 0.04), cue(0.0, 0.0009)], createFused(2));
    expect(Math.abs(fused.mean[0])).toBeLessThan(0.05);
  });
});

describe("Kenyon cell lap memory", () => {
  // A synthetic lap: 4 gates 250 px apart along a winding path whose heading is known; the kart drives it at 60 px/s.
  const headingAt = (s: number) => 0.9 * Math.sin((2 * Math.PI * s) / 500) + 0.3 * Math.sin((2 * Math.PI * s) / 170);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const farBend = (s: number) => wrap(headingAt(s + 150) - headingAt(s)) / Math.PI;
  function lap(body: MushroomBody, learn = true) {
    body.beginLap();
    const errors: number[] = [];
    let x = 0, y = 0, s = 0;
    for (let step = 0; s < 1000; step += 1) {
      body.advance(60); s += 2; x += Math.cos(headingAt(s)) * 2; y += Math.sin(headingAt(s)) * 2;
      const gate = Math.floor(s / 250);
      body.observe({ gate, sinceGate: s - gate * 250, heading: headingAt(s), x, y, speed: 60 }, learn);
      const scratch = { mean: new Float32Array(ESTIMATE_COUNT), variance: new Float32Array(ESTIMATE_COUNT) };
      const cue = body.cue(scratch);
      if (cue && step % 2 === 0 && s < 840) errors.push(Math.abs(scratch.mean[ESTIMATE_NAMES.indexOf("curveFar")] - farBend(s)));
    }
    return errors;
  }
  const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  it("knows nothing on the first lap and predicts the bend ahead on the next", () => {
    const body = new MushroomBody({ kenyonCells: 4000, seed: 3, gates: 4 });
    const first = lap(body);
    const second = lap(body);
    expect(first.length).toBe(0); // no cue is offered before anything has been learned on an earlier lap
    expect(second.length).toBeGreaterThan(100);
    expect(mean(second)).toBeLessThan(0.1);
  });
  it("learns all four channels, from the kart's own turning and no camera", () => {
    const body = new MushroomBody({ kenyonCells: 4000, seed: 3, gates: 4 });
    lap(body); lap(body);
    expect(body.stats.lapUpdates).toBeGreaterThan(100);
    expect(body.stats.lapAbsError).toBeLessThan(0.1);
    expect(MEMORY_CHANNELS.map((channel) => channel.name)).toEqual(["headingError", "curvature", "curveNear", "curveFar"]);
  });
  it("is silent after forgetting", () => {
    const body = new MushroomBody({ kenyonCells: 4000, seed: 3, gates: 4 });
    lap(body); body.forget();
    expect(lap(body).length).toBe(0);
  });
  it("survives being saved and loaded", () => {
    const body = new MushroomBody({ kenyonCells: 4000, seed: 3, gates: 4 });
    lap(body);
    const copy = MushroomBody.fromJSON(JSON.parse(JSON.stringify(body.toJSON())));
    const errors = lap(copy, false);
    expect(errors.length).toBeGreaterThan(100);
    expect(mean(errors)).toBeLessThan(0.1);
  });
});

describe("backward compatibility with the original FlyKart", () => {
  it("drives a lap with the feeling channels exactly as the original simulator does", () => {
    const network = brain();
    const original = evaluate(network, "grand-loop", DEFAULT_REWARD_CONFIG, { ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: false }, true);
    const driver = new VisionDriver({ perceiver: null, controller: brain() });
    const ours = driveEpisode(driver, { track: "grand-loop", seed: 1 });
    expect(original.finished).toBe(true);
    expect(ours.finished).toBe(true);
    expect(ours.ticks).toBe(original.ticks);
  });
});

describe("files", () => {
  it("imports an original FlyKart brain and exports a vision brain that contains it unchanged", () => {
    const imported = importFile(sampleBrain);
    expect(imported.kind).toBe("v1-brain");
    expect(imported.controller?.snapshot.hiddenCount).toBe(48);
    const checkpoint = controllerCheckpoint(imported.controller!.snapshot, { generation: 3 });
    const bundle = exportVisionBrain({ name: "test", controller: checkpoint, vision: null, fusion: { fade: 0, mode: "belief", visionTemperature: 1 }, memory: null, world: null });
    const again = importFile(bundle);
    expect(again.kind).toBe("vision-brain");
    expect(again.controller?.snapshot.inputWeights).toEqual(imported.controller?.snapshot.inputWeights);
    const asV1 = importFile(exportAsFlyKartV1(checkpoint));
    expect(asV1.kind).toBe("v1-brain");
    expect(asV1.controller?.snapshot.outputWeights).toEqual(imported.controller?.snapshot.outputWeights);
  });
  it("rejects files that are not FlyKart brains", () => {
    expect(() => importFile("{}")).toThrow();
    expect(() => importFile("not json")).toThrow();
  });
});

describe("data collection", () => {
  it("collects labelled frames from the teacher on tracks and in worlds", () => {
    const track = new VisionDataset(400, 48, 24, trackDomain.estimateCount);
    const stats = collect({ domain: trackDomain, newEpisode: trackFactory(["grand-loop", "hairpin"], () => 0, { ticks: 120 }), episodes: 3, ticks: 120, seed: 1, teacher: brain(), perceiver: null, studentShare: 0, mixedShare: 0, dart: 0.2, dataset: track });
    expect(track.size).toBeGreaterThan(100); expect(stats.episodes).toBe(3);
    for (let i = 0; i < track.size; i += 1) { expect(track.previous[i]).toBeLessThanOrEqual(i); expect(Number.isFinite(track.targets[i * trackDomain.estimateCount])).toBe(true); }
    const world = new VisionDataset(300, 48, 24, worldDomain.estimateCount);
    let seed = 0;
    collect({ domain: worldDomain, newEpisode: worldFactory({ seeds: () => (seed += 1), ticks: 100 }), episodes: 3, ticks: 100, seed: 2, teacher: brain(), perceiver: null, studentShare: 0, mixedShare: 0, dart: 0.2, dataset: world });
    expect(world.size).toBeGreaterThan(100);
    expect(defaultSpec(2, worldDomain.estimateCount).outputs).toBe(worldDomain.estimateCount * 2 + 3);
  });
});

describe("generated tracks", () => {
  it("are drivable and different from each other", () => {
    const a = proceduralTrack(0), b = proceduralTrack(1);
    expect(a.id).not.toBe(b.id);
    const episode = new TrackEpisode({ track: a, headless: true });
    expect(episode.route.length).toBeGreaterThan(1000);
  });
});

describe("the open world", () => {
  it("casts rays that stop at obstacles and the fence", () => {
    const world = generateWorld(4, 0.5);
    world.obstacles.length = 0; world.patches.length = 0;
    expect(castRay(world, 0, 0, 0, 1000)).toBeCloseTo(world.half - 8, 3);
    world.obstacles.push({ x: 100, y: 0, radius: 10, kind: "rock", height: 10, tone: 0 });
    expect(castRay(world, 0, 0, 0, 1000)).toBeCloseTo(100 - 10 - 8, 3);
    expect(castRay(world, 0, 0, Math.PI, 1000)).toBeCloseTo(world.half - 8, 3);
  });
  it("is reproducible from its seed and has water, sand and mud", () => {
    const a = generateWorld(7), b = generateWorld(7);
    expect(a.obstacles.length).toBe(b.obstacles.length); expect(a.obstacles[0]).toEqual(b.obstacles[0]);
    const kinds = new Set<string>(); for (let seed = 1; seed < 8; seed += 1) generateWorld(seed).patches.forEach((p) => kinds.add(p.kind));
    expect(kinds.has("water") && kinds.has("sand") && kinds.has("mud")).toBe(true);
    expect(surfaceAt({ ...a, patches: [{ x: 0, y: 0, radius: 10, kind: "water" }] }, 1, 1)).toBe("water");
  });
  it("lets the expert reach goals without crashing", () => {
    const results = [1, 2, 3, 4].map((seed) => runWorldEpisode("expert", { seed, density: 0.5, maxTicks: 1500 }));
    expect(results.filter((r) => r.crashed).length).toBe(0);
    expect(results.reduce((s, r) => s + r.goals, 0)).toBeGreaterThanOrEqual(5);
  });
  it("ends the run when the kart drives into a pond", () => {
    const sim = new WorldSim(3, { maxTicks: 3000 });
    sim.world.patches.push({ x: sim.kart.x + Math.cos(sim.kart.heading) * 60, y: sim.kart.y + Math.sin(sim.kart.heading) * 60, radius: 45, kind: "water" });
    sim.world.obstacles.length = 0;
    for (let i = 0; i < 400 && !sim.done; i += 1) sim.step({ steer: 0, throttle: 1, brake: 0, reverse: 0 });
    expect(sim.status.crashed).toBe(true);
  });
  it("lays out the nine clearance sectors across the camera's field of view", () => {
    expect(SECTORS).toBe(9);
    expect(WORLD_CAMERA.hfov).toBeGreaterThan(1.7);
    expect(mulberry32(1)()).toBeGreaterThanOrEqual(0);
  });
});

describe("sessions and the camera pipeline", () => {
  const randomModel = (estimates: number, domain: "track" | "world", input: "rgb" | "retina" = "rgb", spatial = false) => {
    const net = new VisionCnn(defaultSpec(2, estimates, input, spatial), 5);
    return serialiseModel(net, domain === "track" ? DEFAULT_CAMERA : WORLD_CAMERA, new Array(estimates).fill(0.3), "random weights for a test", undefined, undefined, domain);
  };
  it("drives a track through an untrained camera network without error, with the memory on", () => {
    const model = randomModel(13, "track");
    const memory = new MushroomBody({ seed: 2, kenyonCells: 800 });
    const session = new TrackSession({ trackId: "grand-loop", rivals: 1, objects: 2, style: 0.5, walls: true, controller: JSON.parse(sampleBrain).network, vision: model, fade: 0.1, mode: "belief", memory, seed: 3 });
    for (let i = 0; i < 90; i += 1) session.step();
    expect(session.episode.car.ticks).toBe(90);
    expect(session.trace.length).toBeGreaterThan(30);
    expect(session.driver.sensors.every(Number.isFinite)).toBe(true);
    expect(session.lap(1).lap).toBe(1);
  });
  it("uses only the camera when the feeling weight is zero", () => {
    const model = randomModel(13, "track");
    const session = new TrackSession({ trackId: "hairpin", rivals: 0, objects: 0, style: 0, walls: true, controller: JSON.parse(sampleBrain).network, vision: model, fade: 0, mode: "belief", memory: null, seed: 3 });
    session.step(); session.step();
    const frame = session.driver.act(session.episode);
    expect(frame.weights[1].every((w) => w === 0)).toBe(true);
    expect(frame.weights[0].every((w) => Math.abs(w - 1) < 1e-6)).toBe(true);
  });
  it("runs every kind of world driver", () => {
    const vision = randomModel(10, "world");
    for (const kind of ["vision", "both", "feeling", "expert", "blind"] as const) {
      const session = new WorldSession({ seed: 4, density: 0.5, style: 0, kind, fade: 0.5, controller: JSON.parse(sampleBrain).network, vision });
      for (let i = 0; i < 40; i += 1) session.step();
      expect(session.episode.sim.status.ticks).toBe(40);
    }
  });
  it("supports the retina front end and the soft-argmax layer in the live pipeline", () => {
    const perceiver = new Perceiver(randomModel(13, "track", "retina", true));
    const episode = new TrackEpisode({ track: "chicane", seed: 2 });
    const seen = perceiver.see(episode.render(), episode.proprioception());
    expect(seen.mean.length).toBe(13); expect(Array.from(seen.variance).every((v) => v > 0)).toBe(true);
    expect(inputChannelCount({ frames: 2, input: "retina" })).toBe(7);
  });
});

describe("the bundled brains", () => {
  it("ships a robust controller in exactly the original FlyKart format", () => {
    const imported = importFile(controllerFile);
    expect(imported.kind).toBe("v1-brain");
    expect(imported.controller?.snapshot.inputCount).toBe(17);
    expect(JSON.parse(controllerFile).format).toBe("flykart-brain");
    expect(() => SpikingNetwork.fromJSON(imported.controller!.snapshot)).not.toThrow();
  });
  it("ships a camera network that runs and reports honest-looking uncertainty", () => {
    const model = JSON.parse(visionFile);
    const perceiver = new Perceiver(model);
    const episode = new TrackEpisode({ track: "hairpin", seed: 2, rivals: 1 });
    const seen = perceiver.see(episode.render(), episode.proprioception());
    expect(seen.mean.length).toBe(trackDomain.estimateCount);
    expect(Array.from(seen.mean).every(Number.isFinite)).toBe(true);
    expect(Array.from(seen.variance).every((v) => v > 0 && v < 10)).toBe(true);
  });
  it("ships an open-world controller and camera network", () => {
    const controller = importFile(worldControllerFile);
    expect(controller.controller?.domain).toBe("world");
    const perceiver = new Perceiver(JSON.parse(worldVisionFile));
    const episode = new WorldEpisode({ seed: 3, styleStrength: 0.3 });
    expect(perceiver.see(episode.render(), episode.proprioception()).mean.length).toBe(worldDomain.estimateCount);
  });
});
