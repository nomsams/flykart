// Write a labelled camera dataset to disk so any other framework can train on it.
//   npx vite-node scripts/dump-dataset.ts --out=datasets/track --frames=20000 [--controller=public/vision/controller.json]
//
// Files (little-endian, row-major):
//   frames.u8        N × 3 × 24 × 48   planar R,G,B bytes
//   previous.i32     N                 index of the frame two camera steps earlier in the same episode (itself at the start)
//   body.f32         N × 3             speed/90, last steer, last gas minus brake
//   targets.f32      N × 13            the camera estimates (see meta.json for names)
//   teacher.f32      N × 3             what the exact-number controller did: steer, gas minus brake, reverse
//   meta.json        shapes, names, which tracks, how the labels are defined
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SpikingNetwork, TRACKS } from "../src/core";
import { collect, collectTrafficBursts, trackFactory } from "../src/vision/dagger";
import { trackDomain } from "../src/vision/domains";
import { DEFAULT_CAMERA } from "../src/vision/camera";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { VisionDataset } from "../src/vision/train";
import { montage, writePng } from "./png";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const out = args.get("out") ?? "datasets/track";
const frames = Number(args.get("frames") ?? 20000);
const teacher = SpikingNetwork.fromJSON(JSON.parse(readFileSync(args.get("controller") ?? "public/vision/controller.json", "utf8")).network);
const tracks = [...TRACKS.filter((t) => !t.id.startsWith("gen-")), ...Array.from({ length: 24 }, (_, i) => proceduralTrack(i))];
const groups = new Map(tracks.map((t, i) => [t.id, i] as const));
const groupOf = (track: unknown) => groups.get(typeof track === "string" ? track : (track as { id: string }).id) ?? -1;

const data = new VisionDataset(frames, DEFAULT_CAMERA.width, DEFAULT_CAMERA.height, trackDomain.estimateCount);
collect({ domain: trackDomain, newEpisode: trackFactory(tracks, groupOf, { ticks: 420 }), episodes: Math.ceil(frames / 400), ticks: 420, seed: 1, teacher, perceiver: null, studentShare: 0, mixedShare: 0, dart: 0.25, dataset: data });
collectTrafficBursts({ tracks, groupOf, bursts: Math.ceil((frames - data.size) / 3), seed: 2, teacher, dataset: data });
mkdirSync(out, { recursive: true });
const n = data.size, plane = DEFAULT_CAMERA.width * DEFAULT_CAMERA.height * 3;
const bytes = new Uint8Array(n * plane); for (let i = 0; i < n; i += 1) bytes.set(data.frameBytes(i), i * plane);
writeFileSync(`${out}/frames.u8`, bytes);
writeFileSync(`${out}/previous.i32`, new Uint8Array(data.previous.buffer, 0, n * 4));
writeFileSync(`${out}/body.f32`, new Uint8Array(data.body.buffer, 0, n * 3 * 4));
writeFileSync(`${out}/targets.f32`, new Uint8Array(data.targets.buffer, 0, n * trackDomain.estimateCount * 4));
writeFileSync(`${out}/teacher.f32`, new Uint8Array(data.action.buffer, 0, n * 3 * 4));
writeFileSync(`${out}/meta.json`, JSON.stringify({
  samples: n, frame: { channels: 3, height: DEFAULT_CAMERA.height, width: DEFAULT_CAMERA.width, layout: "planar RGB, uint8" }, estimateNames: trackDomain.estimateNames,
  note: "Camera frames are rendered at 30 Hz and sampled every 2 ticks. `previous` points two samples back in the same episode. Traffic labels refer to the nearest thing the camera can see within 180 px.",
  tracks: tracks.map((t) => t.id),
}, null, 1));
const images = Array.from({ length: 24 }, (_, i) => { const frame = data.frameBytes(Math.floor((i * n) / 24)); const rgba = new Uint8ClampedArray(DEFAULT_CAMERA.width * DEFAULT_CAMERA.height * 4); const pl = DEFAULT_CAMERA.width * DEFAULT_CAMERA.height; for (let p = 0; p < pl; p += 1) { rgba[p * 4] = frame[p]; rgba[p * 4 + 1] = frame[pl + p]; rgba[p * 4 + 2] = frame[2 * pl + p]; rgba[p * 4 + 3] = 255; } return { rgba, width: DEFAULT_CAMERA.width, height: DEFAULT_CAMERA.height }; });
const sheet = montage(images, 6, 4); writePng(`${out}/sample.png`, sheet.width, sheet.height, sheet.rgba);
console.log(`wrote ${n} frames (${(bytes.length / 1e6).toFixed(0)} MB) to ${out}`);
