// Code that runs inside pool workers (bundled by scripts/pool.ts).
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { BrainSnapshot, SpikingNetwork } from "../src/core";
import { RobustEpisodeSpec, runRobustEpisode } from "../src/vision/robust";
import { WorldRunSpec, driveWorldEpisode, runWorldEpisode } from "../src/vision/world/worldRun";
import { VisionDriver } from "../src/vision/pipeline";
import { worldDomain } from "../src/vision/domains";
import { profileById } from "../src/vision/robot";
import { CameraEpisodeSpec, runCameraEpisode } from "../src/vision/cameraRun";
import { Perceiver, VisionModel } from "../src/vision/perception";

type RobustTask = { type: "robust"; network: BrainSnapshot; specs: RobustEpisodeSpec[] };
type WorldTask = { type: "world"; network: BrainSnapshot | "expert"; specs: WorldRunSpec[] };
type CameraTask = { type: "camera"; network: BrainSnapshot; eyesFile: string; specs: CameraEpisodeSpec[] };
const eyes = new Map<string, Perceiver>();
type WorldCameraTask = { type: "worldcam"; network: BrainSnapshot; eyesFile: string; specs: WorldRunSpec[] };
parentPort!.on("message", (task: RobustTask | WorldTask | CameraTask | WorldCameraTask) => {
  if (task.type === "worldcam") {
    let perceiver = eyes.get(task.eyesFile);
    if (!perceiver) { perceiver = new Perceiver(JSON.parse(readFileSync(task.eyesFile, "utf8")) as VisionModel); eyes.set(task.eyesFile, perceiver); }
    const network = SpikingNetwork.fromJSON(task.network);
    parentPort!.postMessage(task.specs.map((spec) => driveWorldEpisode(new VisionDriver({ perceiver, controller: network, domain: worldDomain, mode: "belief", fusion: { fade: 0 } }), { seed: spec.seed, density: spec.density, maxTicks: spec.maxTicks, styleStrength: 0.4, profile: profileById(spec.profile) })));
    return;
  }
  if (task.type === "camera") {
    let perceiver = eyes.get(task.eyesFile);
    if (!perceiver) { perceiver = new Perceiver(JSON.parse(readFileSync(task.eyesFile, "utf8")) as VisionModel); eyes.set(task.eyesFile, perceiver); }
    const network = SpikingNetwork.fromJSON(task.network);
    parentPort!.postMessage(task.specs.map((spec) => runCameraEpisode(network, perceiver!, spec)));
    return;
  }
  if (task.type === "robust") {
    const network = SpikingNetwork.fromJSON(task.network);
    parentPort!.postMessage(task.specs.map((spec) => runRobustEpisode(network, spec)));
  } else if (task.type === "world") {
    const network = task.network === "expert" ? "expert" : SpikingNetwork.fromJSON(task.network);
    parentPort!.postMessage(task.specs.map((spec) => runWorldEpisode(network, spec)));
  }
});
