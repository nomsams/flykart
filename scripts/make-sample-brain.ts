// Evolve a small demo brain with the same building blocks the simulator uses
// and write it as a flykart-brain checkpoint for the compendium's brain
// inspector.
//   npx vite-node scripts/make-sample-brain.ts --gens=40 [--traffic] [--from=public/sample-brain.json]
import { readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, TRACKS, SpikingNetwork, createHeuristicImitationNetwork, createMutationPopulation, evaluate, evolutionSelectionScore,
} from "../src/core";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const generations = Number(args.get("gens") ?? 40);
const traffic = args.has("traffic");
const populationSize = 32;
const trainTracks = ["grand-loop", "switchback", "zigzag", "hairpin", "chicane", "mountain-pass", "tight-corners"].map((id) => TRACKS.find((track) => track.id === id)!);
const physics = { ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: true, maxAdaptiveExtensions: 3 };
const seeds = traffic ? [1, 2] : [1];

function score(network: SpikingNetwork) {
  let fitness = 0, progress = 0, finished = 0, episodes = 0;
  trainTracks.forEach((track) => seeds.forEach((seed) => {
    const result = evaluate(network, track, DEFAULT_REWARD_CONFIG, physics, !traffic, traffic ? 2 : 0, seed, "mixed");
    fitness += result.fitness; progress += result.progress; if (result.finished) finished += 1; episodes += 1;
  }));
  fitness /= episodes; progress /= episodes;
  return { fitness, progress, finished, episodes, rank: evolutionSelectionScore(progress, fitness, finished === episodes) };
}

const from = args.get("from");
let champion = from ? SpikingNetwork.fromJSON(JSON.parse(readFileSync(from, "utf8")).network) : createHeuristicImitationNetwork(trainTracks, 7, 240, 2);
let best = score(champion);
const startGeneration = from ? Number(JSON.parse(readFileSync(from, "utf8")).generation ?? 0) : 0;
console.log(`start: progress ${(best.progress * 100).toFixed(1)}% fitness ${best.fitness.toFixed(0)} finished ${best.finished}/${best.episodes}`);
let stagnant = 0, reached = 0;
for (let generation = 1; generation <= generations; generation += 1) {
  reached = generation;
  const population = createMutationPopulation(populationSize, champion, (startGeneration + generation) * 101, 0.12 + Math.min(0.1, stagnant * 0.01), 0.16 + Math.min(0.2, stagnant * 0.02), { plateauStreak: stagnant, plateauPatience: 6 });
  let roundBest = { network: champion, result: best };
  population.forEach((candidate) => { const result = score(candidate); if (result.rank > roundBest.result.rank) roundBest = { network: candidate, result }; });
  if (roundBest.result.rank > best.rank) { champion = roundBest.network; best = roundBest.result; stagnant = 0; } else stagnant += 1;
  if (generation % 2 === 0 || generation === generations) console.log(`gen ${generation}: progress ${(best.progress * 100).toFixed(1)}% fitness ${best.fitness.toFixed(0)} finished ${best.finished}/${best.episodes}`);
  if (best.finished === best.episodes) break;
}
champion.reset();
const checkpoint = {
  format: "flykart-brain", version: 2, savedAt: new Date("2026-09-30T00:00:00Z").toISOString(), fitness: Math.round(best.fitness * 10) / 10, generation: startGeneration + reached,
  track: "all", provenance: [{ context: "all", trained: true, source: `compendium demo: heuristic warm start, then evolution on seven tracks${traffic ? " with rival karts and road objects" : " alone"}`, bestFitness: best.fitness, bestProgress: best.progress, finished: best.finished === best.episodes }],
  network: champion.toJSON(),
};
writeFileSync(args.get("out") ?? "public/sample-brain.json", JSON.stringify(checkpoint));
console.log(`wrote ${args.get("out") ?? "public/sample-brain.json"} (generation ${checkpoint.generation})`);
