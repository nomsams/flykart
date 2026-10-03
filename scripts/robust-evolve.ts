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
import { NOISE_LEVELS, NO_NOISE, NoiseSpec } from "../src/vision/interface";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { EpisodeSummary, RobustEpisodeSpec, robustScore } from "../src/vision/robust";
import { mulberry32, pick } from "../src/vision/rng";
import { Pool } from "./pool";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const from = args.get("from") ?? "public/sample-brain.json";
const out = args.get("out") ?? "public/vision/controller.json";
const generations = Number(args.get("gens") ?? 30);
const populationSize = Number(args.get("pop") ?? 20);
const noisyEpisodes = Number(args.get("noisy") ?? 8);
const workers = Number(args.get("workers") ?? 3);
const maxTicks = Number(args.get("maxTicks") ?? 2400);
const trainTracks = ["grand-loop", "switchback", "zigzag", "hairpin", "chicane", "mountain-pass", "tight-corners"];
const generatedPool = 20;

function jitterNoise(spec: NoiseSpec, random: () => number): NoiseSpec {
  const k = 0.65 + random() * 0.7;
  return { white: spec.white * k, correlated: spec.correlated * (0.65 + random() * 0.7), correlationTicks: spec.correlationTicks, bias: spec.bias * (0.5 + random()), delayTicks: Math.max(0, spec.delayTicks + Math.round((random() - 0.5) * 2)) };
}

type Suite = { clean: RobustEpisodeSpec[]; noisy: RobustEpisodeSpec[] };

function suiteFor(generation: number): Suite {
  const random = mulberry32(generation * 977 + 11);
  const t = Math.min(1, generation / Math.max(1, generations));
  const weights = [0, 0.3 - 0.05 * t, 0.3 + 0.05 * t, 0.25 + 0.05 * t, 0.15 - 0.05 * t];
  const generated = () => proceduralTrack(Math.floor(random() * generatedPool));
  const clean: RobustEpisodeSpec[] = [
    ...trainTracks.map((track, i) => ({ track: track as never, noise: NO_NOISE, rivals: 0, roadObjects: 0, objectKind: "mixed" as const, seed: 100 + generation * 7 + i, maxTicks })),
    ...[0, 1].map((i) => ({ track: generated() as never, noise: NO_NOISE, rivals: 0, roadObjects: 0, objectKind: "mixed" as const, seed: 300 + generation * 3 + i, maxTicks })),
    { track: pick(random, trainTracks) as never, noise: NO_NOISE, rivals: 1 + Math.floor(random() * 2), roadObjects: 1 + Math.floor(random() * 3), objectKind: "mixed", seed: 500 + generation, maxTicks },
  ];
  const noisy: RobustEpisodeSpec[] = Array.from({ length: noisyEpisodes }, (_, index) => {
    let roll = random(); let level = NOISE_LEVELS[1];
    for (let i = 0; i < weights.length; i += 1) { if (roll < weights[i]) { level = NOISE_LEVELS[i]; break; } roll -= weights[i]; }
    const traffic = random() < 0.4;
    return {
      track: (index % 3 === 2 ? generated() : trainTracks[(index + generation) % trainTracks.length]) as never, noise: jitterNoise(level.spec, random),
      rivals: traffic ? 1 + Math.floor(random() * 2) : 0, roadObjects: traffic ? Math.floor(random() * 4) : 0, objectKind: pick(random, ["mixed", "mixed", "cone", "stalled-car"] as const),
      seed: Math.floor(random() * 1e6), maxTicks, physicsVariation: random() < 0.4 ? 0.1 : 0,
    };
  });
  return { clean, noisy };
}

const pool = await Pool.create("scripts/worker-tasks.ts", "worker-tasks", workers);
const source = JSON.parse(readFileSync(existsSync(out) && args.has("resume") ? out : from, "utf8"));
let champion = SpikingNetwork.fromJSON(source.network);
let stagnant = 0; const startGeneration = Number(source.generation ?? 0);
const t0 = performance.now();
mkdirSync(dirname(out), { recursive: true });

type Evaluated = { cleanLaps: number; cleanProgress: number; noisyLaps: number; score: number; clean: EpisodeSummary[]; noisy: EpisodeSummary[] };

async function evaluateAll(networks: SpikingNetwork[], suite: Suite): Promise<Evaluated[]> {
  const all = [...suite.clean, ...suite.noisy];
  const raw = await Promise.all(networks.map((network) => pool.run<EpisodeSummary[]>({ type: "robust", network: network.toJSON(), specs: all })));
  return raw.map((results) => {
    const clean = results.slice(0, suite.clean.length), noisy = results.slice(suite.clean.length);
    return { clean, noisy, cleanLaps: clean.filter((r) => r.finished).length, cleanProgress: clean.reduce((s, r) => s + r.progress, 0) / clean.length, noisyLaps: noisy.filter((r) => r.finished).length, score: 0.5 * robustScore(clean, 2) + 0.5 * robustScore(noisy, 2) };
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
  console.log(`gen ${String(generation).padStart(3)}  incumbent ${incumbent.score.toFixed(3)} (clean laps ${incumbent.cleanLaps}/${suite.clean.length}) best ${last.score.toFixed(3)} ${best === 0 ? "(held)" : "(NEW)"}  clean laps ${last.cleanLaps}/${suite.clean.length} noisy laps ${last.noisyLaps}/${suite.noisy.length}  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  if (generation % 3 === 0 || generation === generations) save();
}
function save(): void {
  champion.reset();
  const checkpoint = {
    format: "flykart-brain", version: 2, savedAt: new Date().toISOString(), fitness: Math.round((last?.score ?? 0) * 1000) / 1000, generation: startGeneration + generations, track: "all",
    provenance: [...(source.provenance ?? []), { context: "vision", trained: true, source: `FlyKart Vision step 1: robust evolution through a noisy, delayed 13-estimate interface, started from ${from}`, bestFitness: last?.score ?? 0, bestProgress: last?.cleanProgress ?? 0, finished: last ? last.cleanLaps === last.clean.length : false }],
    network: champion.toJSON(),
  };
  writeFileSync(out, JSON.stringify(checkpoint));
}
save();
console.log("wrote", out, "after", ((performance.now() - t0) / 1000).toFixed(0), "s");
await pool.close();
