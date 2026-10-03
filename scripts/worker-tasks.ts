// Code that runs inside pool workers (bundled by scripts/pool.ts).
import { parentPort } from "node:worker_threads";
import { BrainSnapshot, SpikingNetwork } from "../src/core";
import { RobustEpisodeSpec, runRobustEpisode } from "../src/vision/robust";
import { WorldRunSpec, runWorldEpisode } from "../src/vision/world/worldRun";

type RobustTask = { type: "robust"; network: BrainSnapshot; specs: RobustEpisodeSpec[] };
type WorldTask = { type: "world"; network: BrainSnapshot | "expert"; specs: WorldRunSpec[] };
parentPort!.on("message", (task: RobustTask | WorldTask) => {
  if (task.type === "robust") {
    const network = SpikingNetwork.fromJSON(task.network);
    parentPort!.postMessage(task.specs.map((spec) => runRobustEpisode(network, spec)));
  } else if (task.type === "world") {
    const network = task.network === "expert" ? "expert" : SpikingNetwork.fromJSON(task.network);
    parentPort!.postMessage(task.specs.map((spec) => runWorldEpisode(network, spec)));
  }
});
