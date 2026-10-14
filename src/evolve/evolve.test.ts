import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { mulberry32 } from "../vision/rng";
import { contact } from "../vision/world/objects";
import { IDEAL_PLANT, WorldSim, castRay, clearanceScan, type WorldDef } from "../vision/world/world";
import { validateArena } from "../vision/world/arena";
import { HC_SR04 } from "../vision/robot";
import { ping, type SonarTarget } from "../vision/sonar";
import { InlineBackend } from "./backend";
import { growBrain, projectGenome, projectionDistance, shrinkBrain } from "./brain-size";
import { EvolutionEngine } from "./engine";
import { generateHabitat, HABITAT_HALF, type HabitatKind } from "./habitats";
import { flagCue } from "./drive";
import { IDEAL_REALITY, sampleReality } from "./reality";
import { buildScenario } from "./scenario";
import { SolidIndex } from "./solid-index";
import { placeProp, PROP_MAKERS, type PropName } from "./props";
import { runCase, caseFor, STAGES } from "./cases";
import { toProgress, parseProgress, brainFile48 } from "./persist";

const emptyWorld = (extra: Partial<WorldDef> = {}): WorldDef => ({ seed: 1, half: 316, obstacles: [], patches: [], ...extra });

describe("oriented solids", () => {
  it("leaves axis-aligned contact unchanged and rotates the normal for a tilted box", () => {
    const plain = contact({ x: 0, y: 0, radius: 0, halfLength: 10, halfWidth: 4 }, 0, 9, 8)!;
    expect(plain.nx).toBeCloseTo(0, 6); expect(plain.ny).toBeCloseTo(1, 6); expect(plain.depth).toBeCloseTo(3, 6);
    const tilted = contact({ x: 0, y: 0, radius: 0, halfLength: 10, halfWidth: 4, heading: Math.PI / 4 }, 0, 9, 8)!;
    // Probe on the +y axis sees the corner region of a 45 degree box.
    expect(tilted).not.toBeNull();
    expect(Math.hypot(tilted.nx, tilted.ny)).toBeCloseTo(1, 6);
    const quarter = contact({ x: 0, y: 0, radius: 0, halfLength: 10, halfWidth: 4, heading: Math.PI / 2 }, 9, 0, 8)!;
    // A box turned a quarter-turn is 4 long along y and 10 wide along x: a probe at x = 9 is 1 inside its 10 half-extent.
    expect(quarter.nx).toBeCloseTo(1, 6); expect(quarter.ny).toBeCloseTo(0, 6); expect(quarter.depth).toBeCloseTo(3, 6);
    expect(contact({ x: 0, y: 0, radius: 0, halfLength: 10, halfWidth: 4, heading: Math.PI / 2 }, 0, 19, 8)).toBeNull();
  });

  it("casts rays at a tilted box like at the equivalent box turned by hand", () => {
    const heading = 0.7;
    const world = emptyWorld({ obstacles: [{ kind: "prop", x: 40, y: 10, radius: 20, height: 20, tone: 0.5, parts: [{ shape: "box", x: 40, y: 10, heading, halfLength: 18, halfWidth: 5, z0: 0, z1: 20 }] }] });
    // The same box, built from its four corners as the union of axis-free checks: compare with the index (independent code path).
    const index = new SolidIndex(world, mulberry32(1));
    for (let angle = -0.6; angle <= 0.6; angle += 0.1) {
      const a = castRay(world, 0, 0, angle, 300), b = index.castRay(0, 0, angle, 300, index.collect(0, 0, 308, SolidIndex.COLLIDES), false);
      expect(b).toBeCloseTo(a, 5);
    }
  });
});

describe("habitats", () => {
  const kinds: HabitatKind[] = ["lawn", "street", "apartment"];
  it("generate valid, bounded scenes with real floors and reachable flags", () => {
    for (const kind of kinds) for (const seed of [1, 2, 3]) {
      const world = generateHabitat(kind, seed, 0.7);
      expect(world.half).toBe(HABITAT_HALF);
      expect(world.obstacles.some((o) => o.kind === "prop")).toBe(true);
      const scenario = buildScenario({ habitat: kind, seed, difficulty: 0.7, goals: 2, minPath: 80, maxPath: 360, maxTicks: 1000 });
      expect(scenario.goals.length).toBeGreaterThan(0);
      const index = new SolidIndex(scenario.world, mulberry32(1));
      expect(index.free(scenario.start.x, scenario.start.y, 10)).toBe(true);
      for (const g of scenario.goals) expect(index.free(g.x, g.y, 24)).toBe(true);
      // Accepted by the scene-file validator the Vision page uses.
      expect(() => validateArena({ format: "flykart-world", version: 1, world: scenario.world, start: { x: scenario.start.x, y: scenario.start.y, heading: 0 } })).not.toThrow();
    }
  });

  it("builds the three floor styles the robot has to cross", () => {
    expect(generateHabitat("apartment", 4, 0.5).zones!.some((z) => z.kind === "parquet") || generateHabitat("apartment", 4, 0.5).base === "parquet").toBe(true);
    expect(generateHabitat("apartment", 4, 0.5).zones!.some((z) => z.kind === "tile")).toBe(true);
    expect(generateHabitat("street", 4, 0.5).zones!.some((z) => z.kind === "asphalt")).toBe(true);
    expect(generateHabitat("lawn", 4, 0.5).base).toBe("grass");
  });

  it("is reproducible from the seed and varies with it", () => {
    const a = JSON.stringify(generateHabitat("apartment", 9, 0.6)), b = JSON.stringify(generateHabitat("apartment", 9, 0.6)), c = JSON.stringify(generateHabitat("apartment", 10, 0.6));
    expect(a).toBe(b); expect(a).not.toBe(c);
  });

  it("has props with legs, feet and branches that are not squares or circles", () => {
    const names = Object.keys(PROP_MAKERS) as PropName[];
    const random = mulberry32(5);
    const sofa = placeProp("sofa", random, 0, 0, 0);
    const feet = sofa.parts!.filter((p) => p.name === "sofa foot");
    expect(feet.length).toBeGreaterThanOrEqual(4);
    // Feet lift the body: the robot (6 px tall) rolls under the sofa between them.
    const body = sofa.parts!.find((p) => p.name === "sofa base")!;
    expect(body.z0).toBeGreaterThan(6);
    const tree = placeProp("tree", mulberry32(8), 0, 0, 0);
    expect(tree.parts!.some((p) => p.name === "branch" && Math.abs(Math.sin(((p.heading ?? 0) % Math.PI) * 2)) > 0.1)).toBe(true);
    expect(names.length).toBeGreaterThan(30);
  });
});

describe("drivetrain imperfections", () => {
  it("leave the original kart untouched at their neutral values", () => {
    const world = generateHabitat("lawn", 3, 0.4);
    const run = (plant: typeof IDEAL_PLANT | null): number[] => {
      const sim = new WorldSim(1, { world, start: { x: 0, y: 0, heading: 0.4 }, goal: { x: 200, y: 100 }, plant });
      for (let t = 0; t < 120; t += 1) sim.step({ steer: Math.sin(t / 15) * 0.5, throttle: 0.6, brake: 0, reverse: 0 });
      return [sim.kart.x, sim.kart.y, sim.kart.heading, sim.kart.speed];
    };
    const a = run(null), b = run({ ...IDEAL_PLANT });
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i], 9));
  });

  it("a dead zone and motor lag slow the kart down", () => {
    const world = emptyWorld();
    const speedAfter = (plant: typeof IDEAL_PLANT): number => {
      const sim = new WorldSim(1, { world, start: { x: -200, y: 0, heading: 0 }, goal: { x: 250, y: 0 }, plant });
      for (let t = 0; t < 40; t += 1) sim.step({ steer: 0, throttle: 0.25, brake: 0, reverse: 0 });
      return sim.kart.speed;
    };
    expect(speedAfter({ ...IDEAL_PLANT, deadband: 0.3 })).toBeLessThan(0.5);
    expect(speedAfter({ ...IDEAL_PLANT, motorLag: 0.9 })).toBeLessThan(speedAfter(IDEAL_PLANT));
  });
});

describe("spatial index", () => {
  it("returns the open world's own clearance numbers when the camera filter is off", () => {
    for (const kind of ["lawn", "apartment"] as HabitatKind[]) {
      const world = generateHabitat(kind, 11, 0.8), index = new SolidIndex(world, mulberry32(3));
      const random = mulberry32(7), a = new Array(9).fill(0), b = new Array(9).fill(0);
      let checked = 0;
      for (let k = 0; k < 40; k += 1) {
        const x = (random() * 2 - 1) * 280, y = (random() * 2 - 1) * 280, heading = random() * 6.28;
        if (!index.free(x, y, 9)) continue;
        clearanceScan(world, x, y, heading, a); index.clearance(x, y, heading, b, false);
        for (let i = 0; i < 9; i += 1) expect(b[i]).toBeCloseTo(a[i], 5);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(10);
    }
  });

  it("hides thin twigs from the camera at range but not from a close look", () => {
    const twig = { kind: "prop" as const, x: 120, y: 0, radius: 8, height: 3, tone: 0.5, parts: [{ shape: "box" as const, x: 120, y: 0, heading: Math.PI / 2, halfLength: 12, halfWidth: 0.8, z0: 0, z1: 3 }] };
    const hidden = new Set<number>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const index = new SolidIndex(emptyWorld({ obstacles: [twig] }), mulberry32(seed)), out = new Array(9).fill(0);
      index.clearance(0, 0, 0, out, true);
      if (out[4] === 0) hidden.add(seed);
    }
    expect(hidden.size).toBeGreaterThan(20);
    const close = new SolidIndex(emptyWorld({ obstacles: [{ ...twig, x: 30, parts: [{ ...twig.parts[0], x: 30 }] }] }), mulberry32(2)), out = new Array(9).fill(0);
    close.clearance(0, 0, 0, out, true);
    expect(out[4]).toBeGreaterThan(0.4);
  });
});

describe("flag cue (no compass)", () => {
  const open = new SolidIndex(emptyWorld(), mulberry32(1));
  const always = () => 0;
  it("sees a flag ahead within range, with the bearing on the right side", () => {
    const left = flagCue(open, 0, 0, 0, 100, -20, 1, 0, always), right = flagCue(open, 0, 0, 0, 100, 20, 1, 0, always);
    expect(left.visible && right.visible).toBe(true);
    expect(left.bearing).toBeLessThan(0); expect(right.bearing).toBeGreaterThan(0);
  });
  it("is blind to flags behind, far away, too close and behind a wall", () => {
    expect(flagCue(open, 0, 0, 0, -100, 0, 1, 0, always).visible).toBe(false);
    expect(flagCue(open, 0, 0, 0, 300, 0, 1, 0, always).visible).toBe(false);
    expect(flagCue(open, 0, 0, 0, 22, 0, 1, 0, always).visible).toBe(false);
    const wall = new SolidIndex(emptyWorld({ obstacles: [{ kind: "prop", x: 60, y: 0, radius: 40, height: 60, tone: 0.5, parts: [{ shape: "box", x: 60, y: 0, heading: Math.PI / 2, halfLength: 40, halfWidth: 3, z0: 0, z1: 60 }] }] }), mulberry32(1));
    expect(flagCue(wall, 0, 0, 0, 110, 0, 1, 0, always).visible).toBe(false);
    expect(flagCue(open, 0, 0, 0, 110, 0, 1, 0, always).visible).toBe(true);
  });
});

describe("sonar with props", () => {
  it("is not blinded by a canopy that is far above the beam", () => {
    const rock: SonarTarget = { kind: "circle", x: 100, y: 0, radius: 12, z0: 0, z1: 20 };
    const canopy: SonarTarget = { kind: "circle", x: 40, y: 0, radius: 60, z0: 160, z1: 290 };
    const random = () => 0.5;
    const alone = ping({ ...HC_SR04, ghostProbability: 0, noiseBaseCm: 0, noiseProportional: 0, soundScaleSigma: 0 }, { x: 0, y: 0, heading: 0 }, [rock], random);
    const shaded = ping({ ...HC_SR04, ghostProbability: 0, noiseBaseCm: 0, noiseProportional: 0, soundScaleSigma: 0 }, { x: 0, y: 0, heading: 0 }, [canopy, rock], random);
    expect(alone.echo).toBe(true);
    expect(shaded.echo).toBe(true);
    expect(shaded.range).toBeCloseTo(alone.range, 0);
  });
});

describe("reality", () => {
  it("is the ideal simulator at severity zero and harsher as severity rises", () => {
    const ideal = sampleReality(mulberry32(1), 0);
    expect(ideal.plant).toEqual(IDEAL_REALITY.plant);
    expect(ideal.noise).toEqual(IDEAL_REALITY.noise);
    const mean = (s: number, f: (r: ReturnType<typeof sampleReality>) => number) => Array.from({ length: 60 }, (_, i) => f(sampleReality(mulberry32(i + 5), s))).reduce((a, b) => a + b, 0) / 60;
    expect(mean(1.5, (r) => r.noise.white)).toBeGreaterThan(mean(0.5, (r) => r.noise.white));
    expect(mean(1.5, (r) => r.plant.deadband)).toBeGreaterThan(mean(0.5, (r) => r.plant.deadband));
    expect(mean(1.5, (r) => r.camEvery)).toBeGreaterThan(mean(0.1, (r) => r.camEvery));
  });
});

describe("brain size", () => {
  const random = mulberry32(3);
  const base = new SpikingNetwork(7, 19).toJSON();
  it("grows without changing behaviour, then keeps working at the new size", () => {
    const grown = growBrain(base, 16, 5);
    expect(grown.hiddenCount).toBe(64);
    const a = SpikingNetwork.fromJSON(base), b = SpikingNetwork.fromJSON(grown);
    for (let t = 0; t < 80; t += 1) {
      const input = Array.from({ length: 19 }, () => random() * 2 - 1);
      const x = a.step(input), y = b.step(input);
      expect(y.steer).toBeCloseTo(x.steer, 9); expect(y.throttle).toBeCloseTo(x.throttle, 9); expect(y.brake).toBeCloseTo(x.brake, 9);
    }
    // And the grown net mutates, mates with itself and serialises.
    const child = b.mutate(0.2, 0.2, 9).crossover(b, 3);
    expect(SpikingNetwork.fromJSON(child.toJSON()).hiddenCount).toBe(64);
  });
  it("shrinks to a loadable 48-neuron brain and projects consistently", () => {
    const small = shrinkBrain(growBrain(base, 16, 1), 48);
    expect(small.hiddenCount).toBe(48);
    expect(() => SpikingNetwork.fromJSON(small)).not.toThrow();
    const p0 = projectGenome(base), p1 = projectGenome(growBrain(base, 16, 2));
    expect(projectionDistance(p0, p1)).toBeLessThan(projectionDistance(p0, projectGenome(new SpikingNetwork(99, 19).toJSON())));
  });
  it("is refused by the racer but accepted by Vision and the habitat importer, with a message that says what to do", async () => {
    const { parseBrainFile } = await import("../lab");
    const file = JSON.stringify({ format: "flykart-brain", network: growBrain(base, 8, 1) });
    expect(() => parseBrainFile(file, { allowSonar: true })).toThrow(/48-neuron/);
    expect(parseBrainFile(file, { allowSonar: true, allowLarge: true }).snapshot.hiddenCount).toBe(56);
    expect(() => parseBrainFile(brainFile48(growBrain(base, 8, 1), { fitness: 0, generation: 0, label: "t", run: "t" }), { allowSonar: true })).not.toThrow();
  });
});

describe("the evolution engine", () => {
  const seed = new SpikingNetwork(21, 19).toJSON();
  const config = { population: 6, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 1, patience: 2, tournamentSize: 2, branchesPerStage: 2, maxGenerationsPerBranch: 3, lastStage: 0, runSeed: 5 };

  it("scores a trial deterministically", () => {
    const spec = caseFor(0, 123);
    const a = runCase(seed, spec), b = runCase(seed, spec);
    expect(b.score).toBe(a.score); expect(b.ticks).toBe(a.ticks);
    expect(STAGES.length).toBeGreaterThanOrEqual(5);
  });

  it("files local maxima, holds a tournament and finishes a stage", async () => {
    const engine = EvolutionEngine.fresh(seed, config, new InlineBackend());
    await engine.run(() => engine.state.generation > 30);
    expect(engine.state.archive.length).toBeGreaterThanOrEqual(2);
    expect(engine.state.stageResults.length).toBe(1);
    expect(engine.state.finished).toBe(true);
    const progress = parseProgress(JSON.stringify(toProgress(engine.state, "test")));
    expect(progress.maxima.length).toBe(engine.state.archive.length);
    expect(progress.maxima.every((m) => !("brain" in m))).toBe(true);
    expect(engine.best().brain.inputCount).toBe(19);
  }, 120000);

  it("resumes from a saved state exactly where an uninterrupted run would be", async () => {
    const straight = EvolutionEngine.fresh(seed, { ...config, lastStage: 1 }, new InlineBackend());
    for (let g = 0; g < 4; g += 1) await straight.generation();
    const first = EvolutionEngine.fresh(seed, { ...config, lastStage: 1 }, new InlineBackend());
    for (let g = 0; g < 2; g += 1) await first.generation();
    const resumed = new EvolutionEngine(JSON.parse(JSON.stringify(first.state)), new InlineBackend());
    for (let g = 0; g < 2; g += 1) await resumed.generation();
    const a = straight.state.population.map((i) => i.fit), b = resumed.state.population.map((i) => i.fit);
    expect(b).toEqual(a);
  }, 120000);
});

describe("layered brains", () => {
  const base = new SpikingNetwork(7, 19).toJSON();
  it("add a layer that changes nothing at first, listens to the core but is not heard by it", async () => {
    const { addLayer, singleLayer } = await import("./layers");
    const { plan, brain } = addLayer(singleLayer(48), base, 8, 3, 0.2);
    expect(brain.hiddenCount).toBe(56);
    expect(plan.layers.map((l) => [l.start, l.end, l.plasticity])).toEqual([[0, 48, 0.2], [48, 56, 1]]);
    const a = SpikingNetwork.fromJSON(base), b = SpikingNetwork.fromJSON(brain), random = mulberry32(9);
    for (let t = 0; t < 60; t += 1) {
      const input = Array.from({ length: 19 }, () => random() * 2 - 1), x = a.step(input), y = b.step(input);
      expect(y.steer).toBeCloseTo(x.steer, 9); expect(y.throttle).toBeCloseTo(x.throttle, 9);
    }
    // No core neuron listens to a new-layer neuron.
    for (let n = 0; n < 48; n += 1) for (let p = 48; p < 56; p += 1) expect(brain.recurrentWeights[n * 56 + p]).toBe(0);
  });

  it("keep older layers nearly still while the new layer learns, and obey the hierarchy after crossover", async () => {
    const { addLayer, singleLayer, constrain } = await import("./layers");
    const layered = addLayer(singleLayer(48), base, 8, 3, 0.1);
    const parent = SpikingNetwork.fromJSON(layered.brain);
    const child = constrain(parent.mutate(0.5, 0.5, 11).toJSON(), layered.brain, layered.plan);
    let coreMove = 0, topMove = 0, coreN = 0, topN = 0;
    for (let n = 0; n < 56; n += 1) for (let i = 0; i < 19; i += 1) { const d = Math.abs(child.inputWeights[n * 19 + i] - layered.brain.inputWeights[n * 19 + i]); if (n < 48) { coreMove += d; coreN += 1; } else { topMove += d; topN += 1; } }
    expect(topMove / topN).toBeGreaterThan(4 * (coreMove / coreN));
    // A mating that scrambles recurrent rows still cannot let the core hear the top layer.
    const crossed = constrain(parent.crossover(SpikingNetwork.fromJSON(addLayer(singleLayer(48), new SpikingNetwork(8, 19).toJSON(), 8, 5, 0.1).brain), 5, 0.5).toJSON(), layered.brain, layered.plan);
    for (let n = 0; n < 48; n += 1) for (let p = 48; p < 56; p += 1) expect(crossed.recurrentWeights[n * 56 + p]).toBe(0);
    const frozen = constrain(parent.mutate(0.9, 1, 3).toJSON(), layered.brain, { layers: [{ name: "core", start: 0, end: 48, plasticity: 0 }, { name: "top", start: 48, end: 56, plasticity: 1 }] });
    for (let n = 0; n < 48; n += 1) expect(frozen.bias[n]).toBe(layered.brain.bias[n]);
  });

  it("are added at the start of a later stage by the engine, as one ordinary brain", async () => {
    const seed = new SpikingNetwork(21, 19).toJSON();
    const engine = EvolutionEngine.fresh(seed, { population: 6, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 1, patience: 2, tournamentSize: 2, branchesPerStage: 2, maxGenerationsPerBranch: 3, lastStage: 1, runSeed: 5, layerFromStage: 0, layerPerStage: 8 }, new InlineBackend());
    await engine.run(() => engine.state.stage >= 1 || engine.state.generation > 40);
    expect(engine.state.stage).toBe(1);
    expect(engine.state.plan!.layers.length).toBe(2);
    expect(engine.state.population[0].brain.hiddenCount).toBe(56);
    expect(SpikingNetwork.fromJSON(engine.best().brain).hiddenCount).toBeGreaterThanOrEqual(48);
  }, 120000);
});

describe("genetic screening and the inbreeding guard", () => {
  it("fail a brain that drives straight into a wall, and keep failures out of the breeding pool", async () => {
    const { runScreen } = await import("./screen");
    // Throttle straight ahead and never brake: all weights zero but a strong constant drive bias on the throttle pool.
    const net = new SpikingNetwork(3, 19).toJSON(), H = net.hiddenCount;
    net.inputWeights.fill(0); net.recurrentWeights.fill(0); net.bias.fill(1); net.outputWeights.fill(0);
    for (let n = 0; n < H; n += 1) net.outputWeights[H + n] = 0.5;
    expect(runScreen(net, "wall").failed).toBe(true);
  });

  it("are applied by the engine, recorded per generation, and bred around", async () => {
    const seed = new SpikingNetwork(21, 19).toJSON();
    const engine = EvolutionEngine.fresh(seed, { population: 8, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 2, patience: 2, tournamentSize: 2, branchesPerStage: 1, maxGenerationsPerBranch: 4, lastStage: 0, runSeed: 7 }, new InlineBackend());
    for (let g = 0; g < 3; g += 1) await engine.generation();
    const last = engine.state.history[engine.state.history.length - 1];
    expect(last.screened).toBeGreaterThan(0);
    expect(engine.state.population.some((i) => i.screens !== undefined)).toBe(true);
    expect(engine.state.population.some((i) => (i.kin ?? []).length > 0)).toBe(true);
    expect(last.kinship).toBeGreaterThanOrEqual(0);
  }, 120000);
});

describe("long-run improvements", () => {
  it("builds a dead-end pocket that the start sits inside and the flag lies outside of", async () => {
    const { buildScenario } = await import("./scenario");
    const { SolidIndex } = await import("./solid-index");
    let pockets = 0;
    for (let seed = 1; seed <= 6; seed += 1) {
      const sc = buildScenario({ habitat: "lawn", seed, difficulty: 0.2, goals: 1, minPath: 100, maxPath: 360, maxTicks: 800, pocket: true });
      const wall = sc.world.obstacles.find((o) => o.label === "pocket");
      if (!wall) continue;
      pockets += 1;
      const index = new SolidIndex(sc.world, mulberry32(1));
      expect(index.free(sc.start.x, sc.start.y, 10)).toBe(true);
      // Straight ahead of the start is the closed end of the pocket.
      const ahead = { x: sc.start.x + Math.cos(sc.start.heading) * 56, y: sc.start.y + Math.sin(sc.start.heading) * 56 };
      expect(index.free(ahead.x, ahead.y, 8)).toBe(false);
      expect(Math.hypot(sc.goals[0].x - sc.start.x, sc.goals[0].y - sc.start.y)).toBeGreaterThan(60);
    }
    expect(pockets).toBeGreaterThan(0);
  });

  it("keeps hard cases, draws them again, and keeps the default draws unchanged", async () => {
    const { trainingBattery, caseFor } = await import("./cases");
    const { BASE_OBJECTIVE } = await import("./objective");
    const plain = trainingBattery(1, 5, 9, 6, BASE_OBJECTIVE, 0.3);
    const same = trainingBattery(1, 5, 9, 6, BASE_OBJECTIVE, 0.3, { hard: [], hardShare: 0.5, pocketShare: 0 });
    expect(JSON.stringify(same)).toBe(JSON.stringify(plain));
    const hard = [{ stage: 1, key: 424242, solved: 0 }];
    const mined = trainingBattery(1, 5, 9, 40, BASE_OBJECTIVE, 0.3, { hard, hardShare: 0.5 });
    const target = caseFor(1, 424242).scenario.seed;
    expect(mined.filter((c) => c.scenario.seed === target).length).toBeGreaterThan(8);
  });

  it("has sensor outages that only appear on a rough day, and reality ranges that can be measured", async () => {
    const { validateRanges } = await import("./reality");
    expect(sampleReality(mulberry32(3), 0.8).faults).toEqual({ sonarOut: [], cameraFreeze: [] });
    const outages = Array.from({ length: 60 }, (_, i) => sampleReality(mulberry32(i + 1), 1.6).faults).filter((f) => f.sonarOut.length || f.cameraFreeze.length);
    expect(outages.length).toBeGreaterThan(8);
    expect(() => validateRanges({ deadband: [0.3, 0.1] })).toThrow();
    const slow = validateRanges({ tau: [0.3, 0.5], camEvery: [6] });
    const tau = (r: number) => -1 / 30 / Math.log(sampleReality(mulberry32(r), 1, "command", slow).plant.motorLag);
    expect(Array.from({ length: 20 }, (_, i) => tau(i + 1)).every((t) => t > 0.25)).toBe(true);
  });

  it("polishes a brain only from trials it solved, and returns a loadable brain", async () => {
    const { polish } = await import("./polish");
    const { readFileSync } = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(path: string, encoding: string): string };
    const brain = JSON.parse(readFileSync("public/vision/robot/world-controller.json", "utf8")).network;
    const result = polish(brain, { stage: 0, seed: 1, trials: 6 });
    expect(result).not.toBeNull();
    expect(result!.solved).toBeGreaterThan(0);
    expect(SpikingNetwork.fromJSON(result!.brain).hiddenCount).toBe(48);
    expect(result!.brain.inputWeights).toEqual(brain.inputWeights); // only the readout moves
  }, 120000);

  it("fills the behaviour archive and the hard pool while it runs", async () => {
    const seed = new SpikingNetwork(21, 19).toJSON();
    const engine = EvolutionEngine.fresh(seed, { population: 8, parents: 3, elites: 1, battery: 3, examSize: 2, examEvery: 2, patience: 2, tournamentSize: 2, branchesPerStage: 1, maxGenerationsPerBranch: 8, lastStage: 0, runSeed: 3 }, new InlineBackend());
    for (let g = 0; g < 4; g += 1) await engine.generation();
    expect(Object.keys(engine.state.qd ?? {}).length).toBeGreaterThan(0);
    expect((engine.state.hard ?? []).length).toBeGreaterThan(0);
    const last = engine.state.history[engine.state.history.length - 1];
    expect(last.qdCells).toBeGreaterThan(0);
  }, 120000);
});
