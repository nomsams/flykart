// Steps 2-3 of the vision pipeline: build the camera network by imitation with DAgger.
//   round 0   the privileged controller drives (with steering noise) and labels every frame
//   round 1+  the camera pipeline drives, the privileged controller keeps labelling, we retrain on everything
// Evaluation always uses tracks / worlds the network never trained on.
//   npx vite-node scripts/vision-train.ts --domain=track --teacher=public/vision/controller.json --out=public/vision/vision-net.json
//   npx vite-node scripts/vision-train.ts --domain=world --teacher=public/vision/world-controller.json --out=public/vision/world-vision-net.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SpikingNetwork, TRACKS } from "../src/core";
import { DEFAULT_CAMERA } from "../src/vision/camera";
import { VisionCnn } from "../src/vision/cnn";
import { collect, collectTrafficBursts, collectWorldBursts, trackFactory, worldFactory } from "../src/vision/dagger";
import type { Domain } from "../src/vision/domain";
import { trackDomain, worldDomain } from "../src/vision/domains";
import { driveEpisode, formatSummary, summarise } from "../src/vision/evaluate";
import { Perceiver, defaultSpec, netFromModel, serialiseModel } from "../src/vision/perception";
import { VisionDriver } from "../src/vision/pipeline";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { VisionDataset, computeTargetScale, evaluateVision, trainVision } from "../src/vision/train";
import { WORLD_CAMERA } from "../src/vision/world/worldDomain";
import { driveWorldEpisode } from "../src/vision/world/worldRun";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const num = (key: string, fallback: number): number => Number(args.get(key) ?? fallback);
const kind = args.get("domain") ?? "track";
const domain: Domain = kind === "world" ? worldDomain : trackDomain;
const camera = kind === "world" ? WORLD_CAMERA : DEFAULT_CAMERA;
const teacherFile = args.get("teacher") ?? (kind === "world" ? "public/vision/world-controller.json" : "public/vision/controller.json");
const out = args.get("out") ?? (kind === "world" ? "public/vision/world-vision-net.json" : "public/vision/vision-net.json");
const capacity = num("capacity", 34000), rounds = num("rounds", 3), episodes0 = num("episodes0", 60), episodesN = num("episodes", 36), ticks = num("ticks", 420);
const epochs0 = num("epochs0", 6), epochsN = num("epochs", 4), frames = num("frames", 2);
const bursts0 = num("bursts0", 4500), burstsN = num("bursts", 1500), proceduralCount = num("generated", 36);
const inputMode = (args.get("input") ?? "rgb") as "rgb" | "retina"; const spatial = args.has("spatial");
const resume = args.get("resume");

const teacher = SpikingNetwork.fromJSON(JSON.parse(readFileSync(teacherFile, "utf8")).network);
const started = performance.now();
const stamp = () => `${((performance.now() - started) / 1000).toFixed(0)}s`;

// What counts as training material and what is held out.
const heldOutNamed = ["mountain-pass", "needle-eye", "rainbow-rally", "oval-sprint"];
const named = TRACKS.filter((track) => !track.id.startsWith("gen-"));
const trainTracks = [...named.filter((track) => !heldOutNamed.includes(track.id)), ...Array.from({ length: proceduralCount }, (_, i) => proceduralTrack(i))];
const testTracks = [...heldOutNamed.map((id) => named.find((track) => track.id === id)!), ...Array.from({ length: 4 }, (_, i) => proceduralTrack(40 + i))];
const groupIds = new Map([...trainTracks, ...testTracks].map((track, index) => [track.id, index] as const));
const groupOf = (track: unknown) => groupIds.get(typeof track === "string" ? track : (track as { id: string }).id) ?? -1;
let worldSeed = 1000; const trainSeed = () => (worldSeed += 1); let validationSeed = 90000; const testSeed = () => (validationSeed += 1);
const makeTrain = kind === "world" ? worldFactory({ seeds: trainSeed, ticks }) : trackFactory(trainTracks, groupOf, { ticks });
const makeValidation = kind === "world" ? worldFactory({ seeds: testSeed, ticks }) : trackFactory(testTracks, groupOf, { ticks });

const data = new VisionDataset(capacity, camera.width, camera.height, domain.estimateCount);
const validation = new VisionDataset(8000, camera.width, camera.height, domain.estimateCount);
const spec = defaultSpec(frames, domain.estimateCount, inputMode, spatial);
const net = resume ? netFromModel(JSON.parse(readFileSync(resume, "utf8"))) : new VisionCnn(spec, 3);
const log: unknown[] = [];

/** Closed loop: the camera pipeline drives alone, with no feeling channels at all. */
function closedLoop(perceiver: Perceiver | null, options: { blind?: boolean; strict?: boolean }): unknown {
  const controller = teacher.clone();
  const driver = new VisionDriver({ perceiver, controller, domain, blind: options.blind, fusion: { fade: 0 } });
  if (kind === "world") {
    const results = Array.from({ length: 10 }, (_, i) => driveWorldEpisode(driver, { seed: 70000 + i, density: 0.3 + (i % 4) * 0.2, maxTicks: 1500, styleStrength: 0.4 }));
    return { goalsPerRun: results.reduce((s, r) => s + r.goals, 0) / results.length, crashes: results.filter((r) => r.crashed).length, collisions: results.reduce((s, r) => s + r.collisions, 0) / results.length };
  }
  return summarise(testTracks.map((track, i) => driveEpisode(driver, { track, seed: 7 + i, styleStrength: 0.4, maxTicks: 3000, walls: !options.strict })));
}
const show = (value: unknown): string => (kind === "world" ? (() => { const v = value as { goalsPerRun: number; crashes: number; collisions: number }; return `${v.goalsPerRun.toFixed(1)} goals per run, ${v.crashes}/10 crashes, ${v.collisions.toFixed(1)} collisions`; })() : formatSummary(value as ReturnType<typeof summarise>));

{
  const blind = closedLoop(null, { blind: true }); const blindStrict = kind === "world" ? blind : closedLoop(null, { blind: true, strict: true });
  console.log(`baseline, blind (zero estimates): ${show(blind)}${kind === "world" ? "" : `; walls off: ${show(blindStrict)}`}`);
  const feeling = closedLoop(null, {}); const feelingStrict = kind === "world" ? feeling : closedLoop(null, { strict: true });
  console.log(`reference, feeling only (exact numbers): ${show(feeling)}${kind === "world" ? "" : `; walls off: ${show(feelingStrict)}`}`);
  log.push({ label: "baselines", blind, blindStrict, feeling, feelingStrict });
}
console.log(`${domain.title}: teacher ${teacherFile}; net ${net.parameterCount} params, ${net.macs} MACs/frame`);

collect({ domain, newEpisode: makeValidation, episodes: kind === "world" ? 20 : 22, ticks, seed: 99, teacher, perceiver: null, studentShare: 0, mixedShare: 0, dart: 0.25, dataset: validation });
if (kind === "track") collectTrafficBursts({ tracks: testTracks, groupOf, bursts: 700, seed: 98, teacher, dataset: validation });
else collectWorldBursts({ bursts: 600, seed: 98, teacher, dataset: validation });
console.log(`validation: ${validation.size} frames from held-out ${kind === "world" ? "worlds" : "tracks"} (${stamp()})`);

let stats = collect({ domain, newEpisode: makeTrain, episodes: episodes0, ticks, seed: 1, teacher, perceiver: null, studentShare: 0, mixedShare: 0, dart: 0.25, dataset: data });
if (kind === "track") collectTrafficBursts({ tracks: trainTracks, groupOf, bursts: bursts0, seed: 2, teacher, dataset: data });
else collectWorldBursts({ bursts: bursts0, seed: 2, teacher, dataset: data });
console.log(`round 0: ${data.size} frames from ${stats.episodes} teacher episodes and ${bursts0} short scenes (${stamp()})`);
let targetScale = computeTargetScale(data);

function report(label: string, perceiver: Perceiver): void {
  const indices = Array.from({ length: validation.size }, (_, i) => i);
  const metrics = evaluateVision(net, validation, indices, targetScale, kind === "world" ? "unseen worlds" : testTracks.map((t) => t.id).join(","));
  console.log(`  held-out accuracy (${label}):`);
  domain.estimateNames.forEach((name, c) => console.log(`    ${name.padEnd(14)} rmse ${metrics.rmse[c].toFixed(3)}  R² ${metrics.r2[c].toFixed(2).padStart(5)}  calibration ${metrics.calibration[c].toFixed(2)}  2σ coverage ${(metrics.coverage[c] * 100).toFixed(0)}%`));
  const model = serialiseModel(net, camera, targetScale, `${teacherFile}; DAgger ${label}`, metrics, undefined, kind === "world" ? "world" : "track");
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(model));
  const closed = closedLoop(perceiver, {});
  console.log(`  closed loop, vision only, held out${kind === "world" ? "" : ", walls on"}: ${show(closed)}  (${stamp()})`);
  const strict = kind === "world" ? null : closedLoop(perceiver, { strict: true });
  if (strict) console.log(`  closed loop, vision only, held out, walls OFF: ${show(strict)}  (${stamp()})`);
  log.push({ label, metrics, closedLoop: closed, strict });
}

function fit(label: string, epochCount: number, learningRate: number): Perceiver {
  targetScale = computeTargetScale(data);
  trainVision(net, data, { domain, epochs: epochCount, batch: 32, learningRate, seed: 11 + data.size, targetScale, mirror: true, log: (message) => console.log(`  ${message}  ${stamp()}`) });
  const perceiver = new Perceiver(serialiseModel(net, camera, targetScale, `${teacherFile}; DAgger ${label}`, undefined, undefined, kind === "world" ? "world" : "track"), net);
  report(label, perceiver);
  return perceiver;
}

let perceiver = fit("round 0", epochs0, 2e-3);
for (let round = 1; round <= rounds && !data.full; round += 1) {
  stats = collect({ domain, newEpisode: makeTrain, episodes: episodesN, ticks, seed: 100 + round, teacher, perceiver, studentShare: 0.85, mixedShare: 0.3, dart: 0.25, dataset: data });
  console.log(`round ${round}: ${data.size} frames; the student drove ${stats.student.episodes} episodes: ${stats.student.laps} finished, mean progress ${(stats.student.meanProgress * 100).toFixed(0)}%, ${stats.student.crashes} crashes (${stamp()})`);
  if (kind === "track") collectTrafficBursts({ tracks: trainTracks, groupOf, bursts: burstsN, seed: 200 + round, teacher, dataset: data });
  else collectWorldBursts({ bursts: burstsN, seed: 200 + round, teacher, dataset: data });
  perceiver = fit(`round ${round}`, epochsN, 1.2e-3);
}
// Make the network's own error bars honest: stretch each predicted variance by how overconfident it was on tracks it never saw.
const finalMetrics = evaluateVision(net, validation, Array.from({ length: validation.size }, (_, i) => i), targetScale, kind === "world" ? "unseen worlds" : testTracks.map((t) => t.id).join(","));
const varianceScale = finalMetrics.calibration.map((v) => Math.max(1, Math.min(60, v)));
console.log("variance scale", varianceScale.map((v) => v.toFixed(1)).join(" "));
const final = JSON.parse(readFileSync(out, "utf8"));
final.varianceScale = varianceScale; final.metrics = finalMetrics;
final.notes = `Trained on ${data.size} frames over ${rounds + 1} DAgger rounds; evaluated on held-out ${kind === "world" ? "worlds" : "tracks " + testTracks.map((t) => t.id).join(", ")}.`;
final.history = log;
writeFileSync(out, JSON.stringify(final));
console.log("wrote", out, `(${(JSON.stringify(final).length / 1024).toFixed(0)} KB)`, stamp());
