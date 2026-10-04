// Step 1 of the vision pipeline: take a controller trained on exact sensors
// (for example a v1 brain) and keep evolving it while the interface is
// degraded with correlated noise, bias and delay, so it learns to expect
// imperfect eyes. The result is still a plain 17 -> 48 -> 4 FlyKart brain.
//
// Every generation each candidate is scored on two suites that share the same
// episodes for all candidates:
//   clean  - every training track with exact inputs (+ two fresh generated tracks and a traffic run)
//   noisy  - a mix of tracks under noise, bias and delay, with and without traffic
// and a candidate may only replace the incumbent if it does not lap fewer
// clean tracks, so robustness is never bought with the original skill.
//
//   npx vite-node scripts/robust-evolve.ts --from=public/sample-brain.json --out=public/vision/controller.json --gens=30
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SpikingNetwork, createMutationPopulation } from "../src/core";
import { widenBrain, wireSonarReflex } from "../src/vision/inputs";
import { NOISE_LEVELS, NO_NOISE, NoiseSpec, TRAFFIC_ESTIMATES } from "../src/vision/interface";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { EpisodeSummary, RobustEpisodeSpec, robustScore } from "../src/vision/robust";
import { mulberry32, pick } from "../src/vision/rng";
import { Pool } from "./pool";
import type { CameraEpisodeSpec } from "../src/vision/cameraRun";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const from = args.get("from") ?? "public/sample-brain.json";
const out = args.get("out") ?? "public/vision/controller.json";
const generations = Number(args.get("gens") ?? 30);
const populationSize = Number(args.get("pop") ?? 20);
const noisyEpisodes = Number(args.get("noisy") ?? 8);
const workers = Number(args.get("workers") ?? 3);
const maxTicks = Number(args.get("maxTicks") ?? 2400);
const profile = (args.get("profile") ?? "kart") as "kart" | "robot";
const sonarInit = args.get("sonar-init") ?? "reflex";
const obstacleShare = Number(args.get("obstacles") ?? (profile === "robot" ? 0.6 : 0.4));
// Share of the noisy episodes in which the camera misses every traffic estimate (a dark, low or hidden object): only the sonar warns of it.
const missShare = Number(args.get("miss") ?? (profile === "robot" ? 0.3 : 0));
// With --eyes the candidates also drive whole episodes through that camera network (and the sonar), so evolution sees the camera's real mistakes.
const eyesFile = args.get("eyes");
const cameraEpisodes = Number(args.get("camera") ?? 8);
const cameraTicks = Number(args.get("cameraTicks") ?? 1800);
const collisionPenalty = Number(args.get("penalty") ?? (profile === "robot" ? 0.12 : 0));
const trainTracks = ["grand-loop", "switchback", "zigzag", "hairpin", "chicane", "mountain-pass", "tight-corners"];
const generatedPool = 20;

function jitterNoise(spec: NoiseSpec, random: () => number): NoiseSpec {
  const k = 0.65 + random() * 0.7;
  return { white: spec.white * k, correlated: spec.correlated * (0.65 + random() * 0.7), correlationTicks: spec.correlationTicks, bias: spec.bias * (0.5 + random()), delayTicks: Math.max(0, spec.delayTicks + Math.round((random() - 0.5) * 2)) };
}

type Suite = { clean: RobustEpisodeSpec[]; noisy: RobustEpisodeSpec[]; camera: CameraEpisodeSpec[] };

function suiteFor(generation: number): Suite {
  const random = mulberry32(generation * 977 + 11);
  const t = Math.min(1, generation / Math.max(1, generations));
  const weights = [0, 0.3 - 0.05 * t, 0.3 + 0.05 * t, 0.25 + 0.05 * t, 0.15 - 0.05 * t];
  const generated = () => proceduralTrack(Math.floor(random() * generatedPool));
  const clean: RobustEpisodeSpec[] = [
    ...trainTracks.map((track, i) => ({ track: track as never, noise: NO_NOISE, rivals: 0, roadObjects: profile === "robot" ? 1 + (i % 3) : 0, objectKind: pick(random, ["mixed", "cone", "stalled-car", "barrier"] as const), seed: 100 + generation * 7 + i, maxTicks, profile })),
    ...[0, 1].map((i) => ({ track: generated() as never, noise: NO_NOISE, rivals: 0, roadObjects: profile === "robot" ? 2 : 0, objectKind: "mixed" as const, seed: 300 + generation * 3 + i, maxTicks, profile })),
    { track: pick(random, trainTracks) as never, noise: NO_NOISE, rivals: 1 + Math.floor(random() * 2), roadObjects: 1 + Math.floor(random() * 3), objectKind: "mixed", seed: 500 + generation, maxTicks, profile },
  ];
  const noisy: RobustEpisodeSpec[] = Array.from({ length: noisyEpisodes }, (_, index) => {
    let roll = random(); let level = NOISE_LEVELS[1];
    for (let i = 0; i < weights.length; i += 1) { if (roll < weights[i]) { level = NOISE_LEVELS[i]; break; } roll -= weights[i]; }
    const missed = missShare > 0 && random() < missShare;
    const traffic = missed || random() < obstacleShare;
    return {
      track: (index % 3 === 2 ? generated() : trainTracks[(index + generation) % trainTracks.length]) as never, noise: jitterNoise(level.spec, random),
      rivals: traffic ? 1 + Math.floor(random() * 2) : 0, roadObjects: traffic ? (profile === "robot" ? 1 : 0) + Math.floor(random() * 4) + (missed ? 1 : 0) : 0, missing: missed ? [...TRAFFIC_ESTIMATES] : undefined, objectKind: pick(random, ["mixed", "mixed", "cone", "stalled-car", "barrier"] as const),
      seed: Math.floor(random() * 1e6), maxTicks, physicsVariation: random() < 0.4 ? 0.1 : 0, profile,
    };
  });
  const looks = ["day", "night", "varied", "day", "night", "varied"] as const;
  const camera: CameraEpisodeSpec[] = eyesFile ? Array.from({ length: cameraEpisodes }, (_, i) => ({
    track: (i % 3 === 2 ? generated() : trainTracks[(i * 3 + generation) % trainTracks.length]) as never, seed: Math.floor(random() * 1e6) + 1, maxTicks: cameraTicks,
    rivals: random() < 0.4 ? 1 : 0, roadObjects: 1 + Math.floor(random() * 3), objectKind: pick(random, ["mixed", "cone", "stalled-car", "barrier"] as const), look: looks[i % looks.length], profile, physicsVariation: random() < 0.3 ? 0.1 : 0,
  })) : [];
  return { clean, noisy, camera };
}

const pool = await Pool.create("scripts/worker-tasks.ts", "worker-tasks", workers);
const source = JSON.parse(readFileSync(existsSync(out) && args.has("resume") ? out : from, "utf8"));
let champion = SpikingNetwork.fromJSON(profile === "robot" && source.network.inputCount === 17 ? (sonarInit === "zero" ? widenBrain(source.network) : wireSonarReflex(source.network)) : source.network);
let stagnant = 0; const startGeneration = Number(source.generation ?? 0);
const t0 = performance.now();
mkdirSync(dirname(out), { recursive: true });

type Evaluated = { cameraLaps: number; cleanLaps: number; cleanProgress: number; noisyLaps: number; score: number; clean: EpisodeSummary[]; noisy: EpisodeSummary[] };

async function evaluateAll(networks: SpikingNetwork[], suite: Suite): Promise<Evaluated[]> {
  const all = [...suite.clean, ...suite.noisy];
  const raw = await Promise.all(networks.map((network) => pool.run<EpisodeSummary[]>({ type: "robust", network: network.toJSON(), specs: all })));
  const seen = suite.camera.length ? await Promise.all(networks.map((network) => pool.run<EpisodeSummary[]>({ type: "camera", network: network.toJSON(), eyesFile, specs: suite.camera }))) : networks.map(() => [] as EpisodeSummary[]);
  return raw.map((results, index) => {
    const camera = seen[index];
    const clean = results.slice(0, suite.clean.length), noisy = results.slice(suite.clean.length);
    return { clean, noisy, cleanLaps: clean.filter((r) => r.finished).length, cleanProgress: clean.reduce((s, r) => s + r.progress, 0) / clean.length, noisyLaps: noisy.filter((r) => r.finished).length, cameraLaps: camera.filter((r) => r.finished).length,
      score: camera.length ? (robustScore(clean, 2, collisionPenalty) + robustScore(noisy, 2, collisionPenalty) + robustScore(camera, 2, collisionPenalty)) / 3 : 0.5 * robustScore(clean, 2, collisionPenalty) + 0.5 * robustScore(noisy, 2, collisionPenalty) };
  });
}

let last: Evaluated | null = null;
for (let generation = 1; generation <= generations; generation += 1) {
  const suite = suiteFor(startGeneration + generation);
  const population = createMutationPopulation(populationSize, champion, (startGeneration + generation) * 101, 0.1 + Math.min(0.1, stagnant * 0.01), 0.14 + Math.min(0.16, stagnant * 0.015), { plateauStreak: stagnant, plateauPatience: 5 });
  const evaluated = await evaluateAll(population, suite);
  const incumbent = evaluated[0];
  let best = 0;
  evaluated.forEach((entry, index) => { if (entry.cleanLaps >= incumbent.cleanLaps && entry.score > evaluated[best].score) best = index; });
  if (best !== 0 && evaluated[best].score > incumbent.score + 1e-9) { champion = population[best]; stagnant = 0; } else { best = 0; stagnant += 1; }
  last = evaluated[best];
  console.log(`gen ${String(generation).padStart(3)}  incumbent ${incumbent.score.toFixed(3)} (clean laps ${incumbent.cleanLaps}/${suite.clean.length}) best ${last.score.toFixed(3)} ${best === 0 ? "(held)" : "(NEW)"}  clean laps ${last.cleanLaps}/${suite.clean.length} noisy laps ${last.noisyLaps}/${suite.noisy.length}${suite.camera.length ? `  camera laps ${last.cameraLaps}/${suite.camera.length}` : ""}  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  if (generation % 3 === 0 || generation === generations) save();
}
function save(): void {
  champion.reset();
  const checkpoint = {
    format: "flykart-brain", version: 2, savedAt: new Date().toISOString(), fitness: Math.round((last?.score ?? 0) * 1000) / 1000, generation: startGeneration + generations, track: "all",
    provenance: [...(source.provenance ?? []), { context: "vision", trained: true, source: `FlyKart Vision ${profile === "robot" ? "robot scale with a sonar" : "step 1"}: robust evolution through a noisy, delayed 13-estimate interface, started from ${from}`, bestFitness: last?.score ?? 0, bestProgress: last?.cleanProgress ?? 0, finished: last ? last.cleanLaps === last.clean.length : false }],
    network: champion.toJSON(),
  };
  writeFileSync(out, JSON.stringify(checkpoint));
}
save();
console.log("wrote", out, "after", ((performance.now() - t0) / 1000).toFixed(0), "s");
await pool.close();
