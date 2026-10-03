// Which input stage and architecture sees best for the same data and training budget?
//   npx vite-node scripts/ab-vision.ts
import { readFileSync } from "node:fs";
import { SpikingNetwork, TRACKS } from "../src/core";
import { VisionCnn } from "../src/vision/cnn";
import { collect, collectTrafficBursts, trackFactory } from "../src/vision/dagger";
import { trackDomain } from "../src/vision/domains";
import { defaultSpec } from "../src/vision/perception";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { VisionDataset, computeTargetScale, evaluateVision, trainVision } from "../src/vision/train";
const teacher = SpikingNetwork.fromJSON(JSON.parse(readFileSync("public/vision/controller.json", "utf8")).network);
const held = ["mountain-pass", "needle-eye", "rainbow-rally", "oval-sprint"];
const named = TRACKS.filter((t) => !t.id.startsWith("gen-"));
const trainTracks = [...named.filter((t) => !held.includes(t.id)), ...Array.from({ length: 24 }, (_, i) => proceduralTrack(i))];
const testTracks = [...named.filter((t) => held.includes(t.id)), ...Array.from({ length: 4 }, (_, i) => proceduralTrack(40 + i))];
const groupOf = () => 0;
const build = (tracks: typeof trainTracks, episodes: number, bursts: number, capacity: number, seed: number) => {
  const d = new VisionDataset(capacity, 48, 24, 13);
  collect({ domain: trackDomain, newEpisode: trackFactory(tracks, groupOf, { ticks: 420 }), episodes, ticks: 420, seed, teacher, perceiver: null, studentShare: 0, mixedShare: 0, dart: 0.25, dataset: d });
  collectTrafficBursts({ tracks, groupOf, bursts, seed: seed + 1, teacher, dataset: d });
  return d;
};
const t0 = performance.now();
const train = build(trainTracks, 45, 3000, 20000, 1), val = build(testTracks, 12, 800, 6000, 2);
console.log(`train ${train.size} frames, validation ${val.size} (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
const scale = computeTargetScale(train);
const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
const names = trackDomain.estimateNames;
const variants: [string, "rgb" | "retina", boolean][] = [["rgb, flatten only", "rgb", false], ["retina, flatten only", "retina", false], ["retina + soft-argmax", "retina", true]];
for (const [label, input, spatial] of variants) {
  const net = new VisionCnn(defaultSpec(2, 13, input, spatial), 3);
  for (let round = 0; round < 3; round += 1) {
    trainVision(net, train, { domain: trackDomain, epochs: 2, batch: 32, learningRate: round === 0 ? 2e-3 : 1.2e-3, seed: round, targetScale: scale, mirror: true });
    const m = evaluateVision(net, val, idx(val.size), scale, "held-out");
    if (round === 2) console.log(`\n${label} after 6 epochs (${net.parameterCount} params, ${net.macs} MACs; ${((performance.now() - t0) / 1000).toFixed(0)}s)\n  ` + names.map((n, c) => `${n} ${m.r2[c].toFixed(2)}`).join("  "));
  }
}
