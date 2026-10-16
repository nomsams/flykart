import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { analyseBrain, silenceNeurons } from "../lab";
import { validateArena } from "../vision/world/arena";
import { PoolBackend, type WorkerHandle, type WorkerJob, type WorkerReply } from "./backend";
import { caseFor } from "./cases";
import { defaultRepo } from "./github";
import { buildScenario } from "./scenario";

describe("brain analysis helpers on a grown brain", () => {
  it("silence the neuron asked for and no other, whatever the brain's size", () => {
    const net = new SpikingNetwork(4, 17, 64).toJSON(), H = 64;
    for (let k = 0; k < net.outputWeights.length; k += 1) net.outputWeights[k] = 1;
    net.recurrentWeights.fill(1);
    const silenced = silenceNeurons(net, [60]);
    for (let output = 0; output < 4; output += 1) {
      expect(silenced.outputWeights[output * H + 60]).toBe(0);
      expect(silenced.outputWeights[output * H + 59]).toBe(1);
    }
    for (let target = 0; target < H; target += 1) { expect(silenced.recurrentWeights[target * H + 60]).toBe(0); expect(silenced.recurrentWeights[target * H + 61]).toBe(1); }
    // Out-of-range ids are ignored, and 48 + something is a real neuron now.
    expect(silenceNeurons(net, [64, 100]).outputWeights).toEqual(net.outputWeights);
    expect(silenceNeurons(net, [50]).outputWeights[50]).toBe(0);
  });

  it("analyse every neuron of a 64-neuron brain", () => {
    const analysis = analyseBrain(new SpikingNetwork(4, 17, 64).toJSON());
    expect(JSON.stringify(analysis)).not.toMatch(/NaN|null/);
  });
});

describe("where a page was served from", () => {
  it("never mistakes a page name for a repository", () => {
    expect(defaultRepo({ hostname: "someone.github.io", pathname: "/evolve.html" })).toEqual({ owner: "nomsams", repo: "flykart" });
    expect(defaultRepo({ hostname: "someone.github.io", pathname: "/their-project/evolve.html" })).toEqual({ owner: "someone", repo: "their-project" });
  });
});

describe("the worker pool", () => {
  const fake = () => {
    let listener: (r: WorkerReply) => void = () => undefined;
    const posted: WorkerJob[] = [];
    const handle: WorkerHandle = { post: (job) => { posted.push(job); }, onReply: (l) => { listener = l; }, terminate: () => undefined };
    return { handle, posted, reply: (r: WorkerReply) => listener(r) };
  };
  const brain = new SpikingNetwork(1, 19).toJSON();

  it("hands a worker out once, however many stray messages it sends", async () => {
    const w = fake(), pool = new PoolBackend([w.handle]);
    const first = pool.evaluate([brain], []), second = pool.evaluate([brain], []);
    expect(w.posted.length).toBe(1);
    w.reply({ id: w.posted[0].id, outcomes: [] });
    await first;
    w.reply({ id: 999, outcomes: [] }); // nothing is pending on this worker now except the second job: it must not be taken as an answer twice
    expect(w.posted.length).toBe(2);
    await expect(second).rejects.toThrow(/different job/);
    // A message when nothing was asked changes nothing.
    const idleBefore = w.posted.length;
    w.reply({ id: 1, outcomes: [] });
    const third = pool.evaluate([brain], []);
    expect(w.posted.length).toBe(idleBefore + 1);
    w.reply({ id: w.posted[w.posted.length - 1].id, outcomes: [] });
    await third;
  });

  it("fails a job when its worker reports an error", async () => {
    const w = fake(), pool = new PoolBackend([w.handle]);
    const job = pool.evaluate([brain], []);
    w.reply({ id: -1, error: "boom" });
    await expect(job).rejects.toThrow(/boom/);
  });
});

describe("saved scenes with compound props", () => {
  it("accept a generated habitat, and refuse a prop whose solid part lies outside its stated radius", () => {
    const scenario = buildScenario(caseFor(1, 5).scenario);
    const file = { format: "flykart-world", version: 1, world: JSON.parse(JSON.stringify(scenario.world)), start: scenario.start };
    expect(() => validateArena(file)).not.toThrow();
    const prop = file.world.obstacles.find((o: { parts?: { z0: number; z1: number; x: number }[] }) => o.parts?.some((p) => p.z0 < 4 && p.z1 > 3));
    expect(prop).toBeTruthy();
    const part = prop.parts.find((p: { z0: number; z1: number }) => p.z0 < 4 && p.z1 > 3);
    part.x += prop.radius + 30; // far outside the prop's own circle, which is all the simulator looks at when it asks "is the kart touching this?"
    expect(() => validateArena(file)).toThrow();
  });
});
