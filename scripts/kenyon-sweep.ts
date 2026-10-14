// How many Kenyon cells does the robot's visual memory need, and how sparse should their code be?
//
//   npx vite-node scripts/kenyon-sweep.ts [--out=public/vision/robot/kenyon-sweep.json]
//
// For three evolved places the robot drives a route and the memory is taught what its 24 camera features looked like
// together with the ten clearance numbers there. The route is then driven again from slightly different poses, in a
// slightly different light, and the memory is asked what it remembers. We score how often it answers, how wrong the
// answer is compared with answering the route's average, and what one observation costs.
import { readFileSync, writeFileSync } from "node:fs";
import { SpikingNetwork } from "../src/core";
import { DEFAULT_STYLE, renderFrame } from "../src/vision/camera";
import { ROBOT_PROFILE } from "../src/vision/robot";
import { mulberry32, gaussian } from "../src/vision/rng";
import { SECTORS, SURFACE_VALUE, surfaceAt } from "../src/vision/world/world";
import { WorldScene } from "../src/vision/world/worldScene";
import { RoomMemory, MEMORY_SIZES } from "../src/robot/memory";
import { buildScenario } from "../src/evolve/scenario";
import { runEpisode } from "../src/evolve/drive";
import { sampleReality } from "../src/evolve/reality";
import { SolidIndex } from "../src/evolve/solid-index";
import type { HabitatKind } from "../src/evolve/habitats";

const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"] as const; }));
const out = args.get("out");
const brain = SpikingNetwork.fromJSON(JSON.parse(readFileSync("public/vision/robot/world-controller.json", "utf8")).network);
const camera = ROBOT_PROFILE.worldCamera, frame = new Float32Array(3 * 48 * 24);

type Sample = { visual: Float32Array; truth: number[] };

function features(pixels: Float32Array, gain: number, noise: number, random: () => number): Float32Array {
  const w = 48, h = 24, n = w * h, feats = new Float32Array(24), counts = new Float32Array(8);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const cell = Math.min(1, Math.floor((y / h) * 2)) * 4 + Math.min(3, Math.floor((x / w) * 4));
    for (let k = 0; k < 3; k += 1) feats[cell * 3 + k] += Math.min(1, Math.max(0, pixels[k * n + y * w + x] * gain + gaussian(random) * noise));
    counts[cell] += 1;
  }
  for (let cell = 0; cell < 8; cell += 1) for (let k = 0; k < 3; k += 1) feats[cell * 3 + k] /= counts[cell];
  return feats;
}

function route(kind: HabitatKind, seed: number): { world: ReturnType<typeof buildScenario>["world"]; poses: { x: number; y: number; heading: number }[] } {
  const scenario = buildScenario({ habitat: kind, seed, difficulty: 0.5, goals: 3, minPath: 120, maxPath: 420, maxTicks: 2400 });
  const result = runEpisode(brain, scenario, sampleReality(mulberry32(seed), 0.5), { seed, trace: true, traceEvery: 6 });
  const poses: { x: number; y: number; heading: number }[] = [];
  for (let i = 0; i + 2 < (result.trace?.length ?? 0); i += 3) poses.push({ x: result.trace![i], y: result.trace![i + 1], heading: result.trace![i + 2] });
  return { world: scenario.world, poses };
}

function sample(world: ReturnType<typeof route>["world"], scene: WorldScene, index: SolidIndex, pose: { x: number; y: number; heading: number }, gain: number, noise: number, random: () => number): Sample {
  renderFrame(scene, pose, camera, frame, random);
  const truth = new Array(SECTORS + 1).fill(0);
  index.clearance(pose.x, pose.y, pose.heading, truth, false);
  truth[SECTORS] = SURFACE_VALUE[surfaceAt(world, pose.x + Math.cos(pose.heading) * 28, pose.y + Math.sin(pose.heading) * 28)];
  return { visual: features(frame, gain, noise, random), truth };
}

const places: { kind: HabitatKind; seed: number }[] = [{ kind: "apartment", seed: 4 }, { kind: "apartment", seed: 9 }, { kind: "lawn", seed: 4 }, { kind: "street", seed: 6 }];
const prepared = places.map((p) => {
  const r = route(p.kind, p.seed), random = mulberry32(p.seed + 100);
  const scene = new WorldScene(r.world, { ...DEFAULT_STYLE });
  const index = new SolidIndex(r.world, mulberry32(1));
  const teach = r.poses.map((pose) => sample(r.world, scene, index, pose, 1, 0, random));
  // Second pass: a few pixels and a few degrees off, dimmer or brighter, with sensor noise.
  const test = r.poses.map((pose) => {
    const jittered = { x: pose.x + gaussian(random) * 5, y: pose.y + gaussian(random) * 5, heading: pose.heading + gaussian(random) * 0.12 };
    return sample(r.world, scene, index, jittered, 0.85 + random() * 0.3, 0.02, random);
  });
  return { ...p, teach, test };
});
console.log(`routes: ${prepared.map((p) => `${p.kind}#${p.seed}:${p.teach.length} poses`).join(", ")}`);

const rows: { count: number; sparsity: number; recall: number; maeMemory: number; maeMean: number; gain: number; occupancy: number; microseconds: number; falseRecall: number }[] = [];
for (const count of MEMORY_SIZES) for (const sparsity of [0.005, 0.01, 0.02, 0.05]) {
  let asked = 0, answered = 0, errMemory = 0, errMean = 0, occupancy = 0, micros = 0, answeredWrong = 0;
  for (const p of prepared) {
    const memory = new RoomMemory({ count, sparsity, rareWeighting: true });
    for (const s of p.teach) memory.observe(s.visual, s.truth, true);
    const meanTruth = p.teach[0].truth.map((_, k) => p.teach.reduce((a, s) => a + s.truth[k], 0) / p.teach.length);
    const t0 = performance.now();
    for (const s of p.test) {
      asked += 1;
      const recall = memory.observe(s.visual, s.truth, false);
      const baseline = s.truth.reduce((a, v, k) => a + Math.abs(v - meanTruth[k]), 0) / s.truth.length;
      if (recall) {
        answered += 1;
        const e = s.truth.reduce((a, v, k) => a + Math.abs(v - recall[k]), 0) / s.truth.length;
        errMemory += e; errMean += baseline;
        if (e > baseline) answeredWrong += 1;
      }
    }
    micros += ((performance.now() - t0) / p.test.length) * 1000;
    occupancy += memory.occupancy;
  }
  rows.push({
    count, sparsity, recall: answered / asked, maeMemory: answered ? errMemory / answered : NaN, maeMean: answered ? errMean / answered : NaN,
    gain: answered ? 1 - errMemory / errMean : 0, occupancy: occupancy / prepared.length, microseconds: micros / prepared.length, falseRecall: answered ? answeredWrong / answered : 0,
  });
}
console.log("cells   sparsity  answers   error(memory)  error(route mean)  gain    answers worse than mean  occupancy  us/obs");
for (const r of rows) console.log(`${String(r.count).padStart(6)}  ${r.sparsity.toFixed(3)}    ${(r.recall * 100).toFixed(0).padStart(5)}%    ${r.maeMemory.toFixed(3).padStart(8)}       ${r.maeMean.toFixed(3).padStart(8)}        ${(r.gain * 100).toFixed(0).padStart(4)}%   ${(r.falseRecall * 100).toFixed(0).padStart(6)}%             ${(r.occupancy * 100).toFixed(0).padStart(5)}%    ${r.microseconds.toFixed(0).padStart(6)}`);
if (out) { writeFileSync(out, JSON.stringify({ format: "flykart-kenyon-sweep", version: 1, places, rows }, null, 1)); console.log("wrote", out); }
