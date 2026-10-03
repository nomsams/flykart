import { readFileSync } from "node:fs";
import { SpikingNetwork } from "../src/core";
import { NOISE_LEVELS } from "../src/vision/interface";
import { runWorldEpisode } from "../src/vision/world/worldRun";
const file = process.argv[2] ?? "public/vision/world-controller.json";
const network = SpikingNetwork.fromJSON(JSON.parse(readFileSync(file, "utf8")).network);
for (const [name, brain] of [["expert (hand-written)", "expert"], ["spiking controller", network]] as const) {
  console.log(name);
  for (const level of NOISE_LEVELS.slice(0, 4)) {
    const results = Array.from({ length: 24 }, (_, i) => runWorldEpisode(brain, { seed: 20000 + i, density: 0.3 + (i % 4) * 0.2, maxTicks: 1800, noise: level.spec }));
    const goals = results.reduce((s, r) => s + r.goals, 0) / results.length;
    console.log(`  ${level.id.padEnd(7)} goals/run ${goals.toFixed(2)}  crashes ${results.filter((r) => r.crashed).length}/${results.length}  collisions/run ${(results.reduce((s, r) => s + r.collisions, 0) / results.length).toFixed(1)}`);
  }
}
