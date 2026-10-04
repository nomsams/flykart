// Check the open world: how well does the hand-written expert drive it, and what does the camera see?
//   npx vite-node scripts/preview-world.ts <out.png>
import { frameToRgba } from "../src/vision/camera";
import { WorldEpisode, worldDomain, worldExpert } from "../src/vision/world/worldDomain";
import { runWorldEpisode } from "../src/vision/world/worldRun";
import { montage, writePng } from "./png";

const out = process.argv[2] ?? "world-preview.png";
let total = 0; const rows: string[] = [];
for (let seed = 1; seed <= 12; seed += 1) {
  const r = runWorldEpisode("expert", { seed, density: 0.3 + (seed % 4) * 0.2, maxTicks: 1800 });
  total += r.goals; rows.push(`seed ${seed}: goals ${r.goals}, collisions ${r.collisions}${r.crashed ? ", CRASH: " + r.crashReason : ""}`);
}
console.log(rows.join("\n")); console.log("mean goals", (total / 12).toFixed(1));

const images: { rgba: Uint8ClampedArray; width: number; height: number }[] = [];
for (const [seed, styleStrength, skip] of [[3, 0, 120], [3, 0, 330], [5, 0, 80], [7, 1, 200], [9, 0, 400], [11, 1, 150]] as const) {
  const episode = new WorldEpisode({ seed, density: 0.8, styleStrength, maxTicks: 1800 });
  const sensors = new Array(17).fill(0);
  for (let t = 0; t < skip && !episode.done; t += 1) { worldDomain.sensors(episode.truth(), episode.mission(), episode.proprioception(), sensors); episode.step(worldExpert(sensors)); }
  const frame = episode.render();
  images.push({ rgba: frameToRgba(frame, episode.camera), width: episode.camera.width, height: episode.camera.height });
}
const sheet = montage(images, 3, 8);
writePng(out, sheet.width, sheet.height, sheet.rgba);
console.log("wrote", out);
