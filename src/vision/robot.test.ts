import { describe, expect, it } from "vitest";
import { SpikingNetwork, createMutationPopulation } from "../core";
import sampleBrain from "../../public/sample-brain.json?raw";
import { driveEpisode } from "./evaluate";
import { controllerCheckpoint, exportAsFlyKartV1, exportVisionBrain, importFile } from "./format";
import { BASE_INPUTS, SONAR_INPUT_COUNT, narrowBrain, wireSonarReflex, widenBrain } from "./inputs";
import { VisionDriver } from "./pipeline";
import { CM_PER_PIXEL, MOUNT, ROBOT, ROBOT_PROFILE, KART_PROFILE, profileById } from "./robot";
import { TrackEpisode } from "./episode";
import { WorldEpisode } from "./world/worldDomain";
import { defaultFusion } from "./fusion";
import { BODY_INPUTS_WITH_SONAR, Perceiver, defaultSpec, fillBody, serialiseModel } from "./perception";
import { VisionCnn } from "./cnn";
import { VisionDataset } from "./train";

const snapshot = () => JSON.parse(sampleBrain).network;
const brain = () => SpikingNetwork.fromJSON(snapshot());
const feed = (network: SpikingNetwork, inputs: number[], ticks = 30) => { network.reset(); let last = network.step(inputs); for (let i = 0; i < ticks; i += 1) last = network.step(inputs); return last; };

describe("robot scale", () => {
  it("maps the real robot onto the simulated kart", () => {
    expect(24 * CM_PER_PIXEL).toBeGreaterThan(ROBOT.lengthCm * 0.9); expect(24 * CM_PER_PIXEL).toBeLessThan(ROBOT.lengthCm * 1.1);
    expect(14 * CM_PER_PIXEL).toBeGreaterThan(ROBOT.widthCm * 0.85); expect(14 * CM_PER_PIXEL).toBeLessThan(ROBOT.widthCm * 1.0);
    expect(MOUNT.height * CM_PER_PIXEL).toBeCloseTo(ROBOT.mountHeightCm, 5);
  });
  it("puts a sonar only on the robot profile", () => {
    expect(profileById("robot")).toBe(ROBOT_PROFILE); expect(profileById(undefined)).toBe(KART_PROFILE);
    expect(ROBOT_PROFILE.sonar).not.toBeNull(); expect(KART_PROFILE.sonar).toBeNull();
    expect(ROBOT_PROFILE.camera.mountHeight).toBeLessThan(KART_PROFILE.camera.mountHeight);
  });
});

describe("19-input controllers", () => {
  it("widening changes nothing until the sonar inputs are used, and narrowing undoes it", () => {
    const plain = brain(); const wide = SpikingNetwork.fromJSON(widenBrain(snapshot()));
    expect(wide.inputCount).toBe(SONAR_INPUT_COUNT);
    const base = Array.from({ length: BASE_INPUTS }, (_, i) => Math.sin(i + 1) * 0.5);
    const a = feed(plain, base); const b = feed(wide, [...base, 0.9, 0.7]);
    expect(b).toEqual(a);
    const back = SpikingNetwork.fromJSON(narrowBrain(widenBrain(snapshot())));
    expect(feed(back, base)).toEqual(a);
  });
  it("survives clone, mutation, crossover and populations", () => {
    const wide = SpikingNetwork.fromJSON(widenBrain(snapshot()));
    expect(wide.clone().inputCount).toBe(SONAR_INPUT_COUNT);
    expect(wide.mutate(0.2, 0.2, 3).inputCount).toBe(SONAR_INPUT_COUNT);
    expect(wide.crossover(wide.mutate(0.2, 0.2, 4), 5).inputCount).toBe(SONAR_INPUT_COUNT);
    for (const member of createMutationPopulation(10, wide, 9, 0.1, 0.1, { plateauStreak: 8, plateauPatience: 5 })) expect(member.inputCount).toBe(SONAR_INPUT_COUNT);
  });
  it("the innate reflex makes a close echo slow the kart down", () => {
    const reflex = SpikingNetwork.fromJSON(wireSonarReflex(snapshot()));
    const base = Array.from({ length: BASE_INPUTS }, (_, i) => (i === 0 ? 0.5 : 0));
    const clear = feed(reflex, [...base, 0, 0]); const near = feed(reflex, [...base, 1, 1]);
    expect(near.throttle - near.brake).toBeLessThan(clear.throttle - clear.brake);
  });
});

describe("files with a sonar", () => {
  const wide = widenBrain(snapshot());
  const checkpoint = controllerCheckpoint(wide, { fitness: 1 });
  it("imports a 19-input brain and marks it for the robot", () => {
    const imported = importFile(JSON.stringify(checkpoint));
    expect(imported.controller?.snapshot.inputCount).toBe(19); expect(imported.profile).toBe("robot");
  });
  it("keeps the profile of a vision brain and exports a v1-readable file without the sonar", () => {
    const text = exportVisionBrain({ name: "r", profile: "robot", controller: checkpoint, vision: null, fusion: { fade: 1, mode: "belief", visionTemperature: 1 }, memory: null, world: null });
    expect(importFile(text).profile).toBe("robot");
    const v1 = JSON.parse(exportAsFlyKartV1(checkpoint));
    expect(v1.network.inputCount).toBe(17); expect(SpikingNetwork.fromJSON(v1.network).inputCount).toBe(17);
  });
});

describe("sonar in the episodes", () => {
  it("is absent on the kart and present on the robot", () => {
    expect(new TrackEpisode({ track: "grand-loop", seed: 1, headless: true }).sonar()).toBeNull();
    const robot = new TrackEpisode({ track: "grand-loop", seed: 1, headless: true, profile: ROBOT_PROFILE });
    expect(robot.sonar()).not.toBeNull();
  });
  it("hears nothing on an empty road", () => {
    const empty = new TrackEpisode({ track: "grand-loop", seed: 2, headless: true, profile: ROBOT_PROFILE });
    for (let i = 0; i < 4; i += 1) empty.step({ steer: 0, throttle: 0, brake: 0, boost: 0 } as never);
    expect(empty.sonar()!.echo).toBe(false);
  });
  it("drives a lap of the robot track with a 19-input brain, and a sonar-blind driver is still legal", () => {
    const network = SpikingNetwork.fromJSON(widenBrain(snapshot()));
    const driver = new VisionDriver({ perceiver: null, controller: network, fusion: defaultFusion() } as never);
    const result = driveEpisode(driver, { track: "grand-loop", seed: 1, maxTicks: 600, profile: ROBOT_PROFILE });
    expect(result.progress).toBeGreaterThan(0.05);
  });
  it("gives the open world a sonar on the robot profile", () => {
    const world = new WorldEpisode({ seed: 3, headless: true, profile: ROBOT_PROFILE });
    expect(world.sonar()).not.toBeNull();
  });
});

describe("the camera network hears the sonar too", () => {
  it("carries the echo in the body signals only on the robot", () => {
    const kart = new TrackEpisode({ track: "grand-loop", seed: 1, headless: true }).proprioception();
    expect(kart.sonarCloseness).toBeUndefined();
    const robot = new TrackEpisode({ track: "grand-loop", seed: 1, headless: true, profile: ROBOT_PROFILE }).proprioception();
    expect(robot.sonarCloseness).toBeGreaterThanOrEqual(0); expect(robot.sonarStrength).toBeGreaterThanOrEqual(0);
  });
  it("fills a 3-wide or 5-wide input vector, and stores it in the dataset", () => {
    const body = { speed: 0.5, lastSteer: -0.2, lastDrive: 1, sonarCloseness: 0.7, sonarStrength: 0.4 };
    expect(Array.from(fillBody(body, new Float32Array(3)))).toEqual([0.5, -0.2, 1].map((v) => Math.fround(v)));
    const wide = fillBody(body, new Float32Array(BODY_INPUTS_WITH_SONAR));
    expect(wide[3]).toBeCloseTo(0.7, 5); expect(wide[4]).toBeCloseTo(0.4, 5);
    const data = new VisionDataset(4, 48, 24, 13, BODY_INPUTS_WITH_SONAR);
    data.add(new Float32Array(3 * 48 * 24), -1, wide, new Float32Array(13), new Float32Array(3), 0, 0);
    expect(data.body[3]).toBeCloseTo(0.7, 5); expect(data.body[4]).toBeCloseTo(0.4, 5);
  });
  it("a network built for the sonar runs, and silencing the sonar changes what it says", () => {
    const net = new VisionCnn(defaultSpec(2, 13, "rgb", false, BODY_INPUTS_WITH_SONAR), 3);
    for (let i = 0; i < net.params.length; i += 7) net.params[i] += 0.01 * Math.sin(i);
    const perceiver = new Perceiver(serialiseModel(net, ROBOT_PROFILE.camera, new Array(13).fill(1), "test"), net);
    const frame = new Float32Array(3 * 48 * 24).fill(0.5);
    const base = { speed: 0.3, lastSteer: 0, lastDrive: 0.5 };
    const quiet = Array.from(perceiver.see(frame, { ...base, sonarCloseness: 0, sonarStrength: 0 }).mean);
    perceiver.reset();
    const loud = Array.from(perceiver.see(frame, { ...base, sonarCloseness: 1, sonarStrength: 1 }).mean);
    expect(loud.some((v, i) => Math.abs(v - quiet[i]) > 1e-6)).toBe(true);
  });
});
