// Open-world controller: teach the spiking network from the hand-written expert, then evolve it
// on goals reached, through estimates that are sometimes noisy and delayed.
//   npx vite-node scripts/world-controller.ts --out=public/vision/world-controller.json --gens=30
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BrainSnapshot, SpikingNetwork, createMutationPopulation } from "../src/core";
import { NOISE_LEVELS, NoiseSpec } from "../src/vision/interface";
import { mulberry32 } from "../src/vision/rng";
import { WorldEpisode, worldDomain, worldExpert } from "../src/vision/world/worldDomain";
import { WorldRunResult, WorldRunSpec, worldScore } from "../src/vision/world/worldRun";
import { Pool } from "./pool";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const out = args.get("out") ?? "public/vision/world-controller.json";
const generations = Number(args.get("gens") ?? 30), populationSize = Number(args.get("pop") ?? 20), worldsPerGeneration = Number(args.get("worlds") ?? 8), workers = Number(args.get("workers") ?? 3);
const maxTicks = 1500;

// 1. Imitation warm start with DAgger: the spiking network drives more and more of each run itself while the expert keeps
//    labelling, so it also learns how to recover from its own mistakes.
function imitate(seed: number): SpikingNetwork {
  const network = new SpikingNetwork(seed); const sensors = new Array(17).fill(0); const random = mulberry32(seed);
  const betas = [1, 0.5, 0.2, 0];
  betas.forEach((beta, round) => {
    for (let world = 0; world < 12; world += 1) {
      const episode = new WorldEpisode({ seed: 5000 + world * 13 + round * 211, density: 0.3 + (world % 4) * 0.2, headless: true, maxTicks: 800 });
      network.reset();
      while (!episode.done) {
        worldDomain.sensors(episode.truth(), episode.mission(), episode.proprioception(), sensors);
        const teacher = worldExpert(sensors);
        network.trainActionReadout(sensors, teacher, 0.02 / (1 + round * 0.4));
        const out = network.activity().outputs; const drive = out[1] - out[2]; const reverse = Math.max(0, Math.min(1, (out[3] - 0.25) / 0.75));
        const own = { steer: out[0], throttle: reverse > 0 ? 0 : Math.max(0, Math.min(1, drive)), brake: Math.max(0, Math.min(1, -drive)), reverse };
        episode.step(random() < beta ? teacher : own);
      }
    }
  });
  network.reset(); return network;
}

function noisy(spec: NoiseSpec, random: () => number): NoiseSpec {
  const k = 0.6 + random() * 0.8;
  return { ...spec, white: spec.white * k, correlated: spec.correlated * k, bias: spec.bias * k };
}

const pool = await Pool.create("scripts/worker-tasks.ts", "worker-tasks", workers);
const evaluateAll = (networks: SpikingNetwork[], specs: WorldRunSpec[]) => Promise.all(networks.map((network) => pool.run<WorldRunResult[]>({ type: "world", network: network.toJSON() as BrainSnapshot, specs })));

let champion = imitate(11);
const started = performance.now();
{
  const baseline = await pool.run<WorldRunResult[]>({ type: "world", network: "expert", specs: Array.from({ length: 12 }, (_, i) => ({ seed: 900 + i, density: 0.3 + (i % 4) * 0.2, maxTicks })) });
  const imitated = await pool.run<WorldRunResult[]>({ type: "world", network: champion.toJSON() as BrainSnapshot, specs: Array.from({ length: 12 }, (_, i) => ({ seed: 900 + i, density: 0.3 + (i % 4) * 0.2, maxTicks })) });
  const goals = (r: WorldRunResult[]) => (r.reduce((s, x) => s + x.goals, 0) / r.length).toFixed(1);
  console.log(`expert: ${goals(baseline)} goals per run; spiking network after imitation: ${goals(imitated)} goals, ${imitated.filter((r) => r.crashed).length} crashes`);
}
// Selection: candidates are ranked on a training set that stays fixed for five generations; a winner only replaces the champion
// if it also beats it on a fixed validation set, so luck on one set of worlds cannot make the champion drift.
const validationSpecs: WorldRunSpec[] = Array.from({ length: 16 }, (_, i) => ({ seed: 777000 + i, density: 0.3 + (i % 4) * 0.2, maxTicks, noise: i % 3 === 0 ? NOISE_LEVELS[0].spec : NOISE_LEVELS[1 + (i % 3)].spec }));
const validate = async (network: SpikingNetwork): Promise<number> => worldScore(await pool.run<WorldRunResult[]>({ type: "world", network: network.toJSON() as BrainSnapshot, specs: validationSpecs }));
let championScore = await validate(champion);
console.log(`champion after imitation: validation score ${championScore.toFixed(2)}`);
let stagnant = 0; let lastScore = championScore;
for (let generation = 1; generation <= generations; generation += 1) {
  const block = Math.floor((generation - 1) / 5);
  const random = mulberry32(block * 71 + 3);
  const specs: WorldRunSpec[] = Array.from({ length: worldsPerGeneration }, (_, i) => ({
    seed: 100 + block * 53 + i, density: 0.25 + random() * 0.65, maxTicks,
    noise: i % 3 === 0 ? NOISE_LEVELS[0].spec : noisy(NOISE_LEVELS[1 + Math.floor(random() * 3)].spec, random),
  }));
  const population = createMutationPopulation(populationSize, champion, generation * 101, 0.08 + Math.min(0.1, stagnant * 0.01), 0.1 + Math.min(0.14, stagnant * 0.015), { plateauStreak: stagnant, plateauPatience: 6 });
  const results = await evaluateAll(population, specs);
  const scores = results.map(worldScore);
  let best = 1; scores.forEach((score, index) => { if (index > 0 && score > scores[best]) best = index; });
  const challenger = population[best]; const challengerScore = await validate(challenger);
  const accepted = challengerScore > championScore + 0.25;
  if (accepted) { champion = challenger; championScore = challengerScore; stagnant = 0; } else stagnant += 1;
  lastScore = championScore;
  console.log(`gen ${String(generation).padStart(3)}  train best ${scores[best].toFixed(2)} (incumbent ${scores[0].toFixed(2)})  validation: challenger ${challengerScore.toFixed(2)} vs champion ${championScore.toFixed(2)} ${accepted ? "ACCEPTED" : "kept"}  ${((performance.now() - started) / 1000).toFixed(0)}s`);
}
champion.reset();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ format: "flykart-brain", version: 2, domain: "world", savedAt: new Date().toISOString(), fitness: lastScore, generation: generations, track: "open world", provenance: [{ context: "vision-world", trained: true, source: "FlyKart Vision open world: imitation of a hand-written expert, then evolution on goals reached through noisy estimates", bestFitness: lastScore }], network: champion.toJSON() }));
console.log("wrote", out);
await pool.close();
