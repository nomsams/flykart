// Gate 1: does a controller still lap through imperfect eyes, and has it lost anything on clean inputs?
//   npx vite-node scripts/eval-controller.ts --brains=public/sample-brain.json,public/vision/controller.json --out=public/vision/results-controller.json
import { readFileSync, writeFileSync } from "node:fs";
import { TRACKS } from "../src/core";
import { NOISE_LEVELS } from "../src/vision/interface";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { EpisodeSummary, RobustEpisodeSpec } from "../src/vision/robust";
import { Pool } from "./pool";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const files = (args.get("brains") ?? "public/sample-brain.json,public/vision/controller.json").split(",");
const out = args.get("out");
const trainTracks = new Set(["grand-loop", "switchback", "zigzag", "hairpin", "chicane", "mountain-pass", "tight-corners"]);
const pool = await Pool.create("scripts/worker-tasks.ts", "worker-tasks", Number(args.get("workers") ?? 3));
const generated = Array.from({ length: 4 }, (_, i) => proceduralTrack(40 + i));
const named = TRACKS.filter((track) => !track.id.startsWith("gen-"));
const suite = [...named.map((track) => ({ id: track.id, group: trainTracks.has(track.id) ? "trained" : "unseen", definition: undefined as unknown })), ...generated.map((track) => ({ id: track.id, group: "generated", definition: track as unknown }))];

type Row = { brain: string; level: string; traffic: boolean; group: string; laps: number; episodes: number; progress: number; meanLapSeconds: number | null; crashes: number };
const rows: Row[] = [];
for (const file of files) {
  const brain = JSON.parse(readFileSync(file, "utf8")).network;
  for (const traffic of [false, true]) for (const level of NOISE_LEVELS) {
    const specs: RobustEpisodeSpec[] = suite.map((entry, i) => ({ track: (entry.definition ?? entry.id) as never, noise: level.spec, rivals: traffic ? 1 : 0, roadObjects: traffic ? 2 : 0, objectKind: "mixed", seed: 11 + i, maxTicks: 4500 }));
    // Split the suite across workers by sending the same network with slices of the specs.
    const chunks = [0, 1, 2].map((k) => specs.filter((_, i) => i % 3 === k));
    const results = (await Promise.all(chunks.map((chunk) => pool.run<EpisodeSummary[]>({ type: "robust", network: brain, specs: chunk })))).flatMap((r, k) => r.map((summary, j) => ({ summary, entry: suite[k + j * 3] })));
    for (const group of ["trained", "unseen", "generated"]) {
      const subset = results.filter((r) => r.entry.group === group);
      const laps = subset.filter((r) => r.summary.finished);
      rows.push({ brain: file, level: level.id, traffic, group, laps: laps.length, episodes: subset.length, progress: subset.reduce((s, r) => s + r.summary.progress, 0) / subset.length, meanLapSeconds: laps.length ? laps.reduce((s, r) => s + r.summary.ticks / 30, 0) / laps.length : null, crashes: subset.filter((r) => r.summary.crashed).length });
    }
  }
}
await pool.close();
for (const traffic of [false, true]) {
  console.log(`\n${traffic ? "WITH rivals + road objects" : "alone"}   (laps / episodes, mean progress, mean lap seconds)`);
  for (const group of ["trained", "unseen", "generated"]) {
    console.log(`  ${group} tracks`);
    for (const file of files) {
      console.log("    " + file.split("/").pop()!.padEnd(24) + NOISE_LEVELS.map((level) => { const r = rows.find((x) => x.brain === file && x.level === level.id && x.traffic === traffic && x.group === group)!; return `${level.id} ${r.laps}/${r.episodes} ${(r.progress * 100).toFixed(0)}%${r.meanLapSeconds ? " " + r.meanLapSeconds.toFixed(0) + "s" : ""}`.padEnd(22); }).join(""));
    }
  }
}
if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), suite: suite.map((entry) => ({ id: entry.id, group: entry.group })), rows }, null, 1));
