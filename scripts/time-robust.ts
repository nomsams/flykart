import { readFileSync } from "node:fs";
import { SpikingNetwork } from "../src/core";
import { NOISE_LEVELS } from "../src/vision/interface";
import { runRobustEpisode } from "../src/vision/robust";
const network = SpikingNetwork.fromJSON(JSON.parse(readFileSync("public/sample-brain.json", "utf8")).network);
for (const level of NOISE_LEVELS) {
  const started = performance.now(); let ticks = 0; const rows: string[] = [];
  for (const track of ["grand-loop", "chicane", "mountain-pass", "needle-eye"]) {
    const result = runRobustEpisode(network, { track, noise: level.spec, rivals: 0, roadObjects: 0, objectKind: "mixed", seed: 3, maxTicks: 3000 });
    ticks += result.ticks; rows.push(`${track}:${result.finished ? "LAP" : (result.progress * 100).toFixed(0) + "%"}/${result.ticks}`);
  }
  const ms = performance.now() - started;
  console.log(level.id.padEnd(8), rows.join("  "), `${(ms / ticks * 1000).toFixed(0)} µs/tick`);
}
