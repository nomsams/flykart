// A fly walks with opposing pairs of legs: left versus right to turn, a forward versus a backward push to go and stop.
// Does giving the controller that push-pull motor layout beat the original steer / throttle / brake / reverse outputs?
// Both variants share the *same* random hidden layer and the same imitation lessons, so only the meaning of the four
// readouts differs. This is the cheap version of the question (imitation only, no evolution).
//   npx vite-node scripts/pushpull.ts [--seeds=6] [--out=public/vision/results-pushpull.json]
import { writeFileSync } from "node:fs";
import { Action, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, SpikingNetwork, TRACKS, clamp, heuristicAction, sensorValues, startPosition, stepCar } from "../src/core";
import { proceduralTrack } from "../src/vision/proceduralTracks";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const seeds = Number(args.get("seeds") ?? 6);
const trainIds = ["grand-loop", "switchback", "zigzag", "hairpin", "chicane", "mountain-pass", "tight-corners"];
const trainTracks = trainIds.map((id) => TRACKS.find((t) => t.id === id)!);
const unseen = [...TRACKS.filter((t) => !t.id.startsWith("gen-") && !trainIds.includes(t.id)), ...Array.from({ length: 3 }, (_, i) => proceduralTrack(40 + i))];
const physics = { ...DEFAULT_PHYSICS_CONFIG, adaptiveTimeLimit: false };

type Layout = "standard" | "push-pull";
/** Outputs 0..3 as the controller reads them under each layout. */
function toAction(layout: Layout, out: ArrayLike<number>, fallback: Action): Action {
  if (layout === "standard") return fallback;
  const drive = clamp(out[2], 0, 1) - clamp(out[3], 0, 1);
  return { steer: clamp(out[1] - out[0], -1, 1), throttle: clamp(drive, 0, 1), brake: clamp(-drive, 0, 1), reverse: 0 };
}

function pushPullTargets(teacher: Action): number[] {
  return [Math.max(0, -teacher.steer), Math.max(0, teacher.steer), clamp(teacher.throttle, 0, 1), clamp(Math.max(teacher.brake, teacher.reverse ?? 0), 0, 1)];
}

function imitate(layout: Layout, seed: number): SpikingNetwork {
  const network = new SpikingNetwork(seed);
  for (let epoch = 0; epoch < 3; epoch += 1) for (const route of trainTracks) {
    const car = startPosition(0, route); network.reset(); car.network = network;
    for (let tick = 0; tick < 300 && !car.finished && !car.crashed; tick += 1) {
      const sensors = sensorValues(car, [car], route); const teacher = heuristicAction(car, [car], route);
      const rate = 0.018 / (epoch + 1);
      if (layout === "standard") network.trainActionReadout(sensors, teacher, rate);
      else {
        network.step(sensors);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const internals = network as any; const spikes: number[] = internals.spikes; const weights: number[] = internals.outputWeights; const outputs = network.activity().outputs;
        pushPullTargets(teacher).forEach((target, k) => { const error = target - outputs[k]; for (let n = 0; n < 48; n += 1) weights[k * 48 + n] = clamp(weights[k * 48 + n] + rate * error * spikes[n], -3, 3); });
      }
      stepCar(car, teacher, [car], route, DEFAULT_REWARD_CONFIG, physics);
    }
  }
  network.reset(); return network;
}

function drive(layout: Layout, network: SpikingNetwork, route: (typeof TRACKS)[number]): { finished: boolean; progress: number; seconds: number } {
  const car = startPosition(0, route); car.network = network; car.timeLimit = 3000; network.reset();
  while (!car.crashed && !car.finished && !car.timedOut) {
    const standard = network.step(sensorValues(car, [car], route));
    stepCar(car, toAction(layout, network.activity().outputs, standard), [car], route, DEFAULT_REWARD_CONFIG, physics);
  }
  return { finished: car.finished, progress: car.totalProgress, seconds: car.ticks / 30 };
}

const rows: Record<string, { trained: { laps: number; progress: number; episodes: number }; unseen: { laps: number; progress: number; episodes: number } }> = {};
for (const layout of ["standard", "push-pull"] as const) {
  const stats = { trained: { laps: 0, progress: 0, episodes: 0 }, unseen: { laps: 0, progress: 0, episodes: 0 } };
  for (let s = 1; s <= seeds; s += 1) {
    const network = imitate(layout, s * 17);
    for (const [group, tracks] of [["trained", trainTracks], ["unseen", unseen]] as const) for (const route of tracks) {
      const r = drive(layout, network, route); stats[group].episodes += 1; stats[group].laps += r.finished ? 1 : 0; stats[group].progress += r.progress;
    }
  }
  rows[layout] = stats;
  console.log(layout.padEnd(10), `trained tracks: ${stats.trained.laps}/${stats.trained.episodes} laps, ${(stats.trained.progress / stats.trained.episodes * 100).toFixed(0)}% progress   unseen: ${stats.unseen.laps}/${stats.unseen.episodes} laps, ${(stats.unseen.progress / stats.unseen.episodes * 100).toFixed(0)}% progress`);
}
if (args.get("out")) writeFileSync(args.get("out")!, JSON.stringify({ generatedAt: new Date().toISOString(), seeds, description: "Imitation of the built-in heuristic driver only (3 passes over 7 tracks), no evolution; the same random hidden layer for both layouts.", rows }, null, 1));
