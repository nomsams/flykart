import { readFileSync } from "node:fs";
import { DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, TRACKS, SpikingNetwork, evaluate } from "../src/core";
const file = JSON.parse(readFileSync(process.argv[2] ?? "public/sample-brain.json", "utf8"));
const network = SpikingNetwork.fromJSON(file.network);
const physics = { ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: true, maxAdaptiveExtensions: 3 };
for (const track of TRACKS) {
  const alone = evaluate(network, track, DEFAULT_REWARD_CONFIG, physics, true);
  const traffic = evaluate(network, track, DEFAULT_REWARD_CONFIG, physics, false);
  console.log(track.id.padEnd(14), `alone ${(alone.progress * 100).toFixed(0).padStart(3)}% ${alone.finished ? "lap" : alone.crashed ? "crash" : "----"}  |  with bots ${(traffic.progress * 100).toFixed(0).padStart(3)}% ${traffic.finished ? "lap" : traffic.crashed ? "crash" : "----"}`);
}
