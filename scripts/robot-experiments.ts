// The measurements behind the "Robot scale" part of the Evidence tab: what does the HC-SR04 add to a camera that sits 6.5 cm up?
// Everything runs on tracks and worlds the networks never trained on, with the robot sensor head.
//   npx vite-node scripts/robot-experiments.ts --out=public/vision/robot/results.json [--quick] [--only=track,world]
//
// "Sonar off" is the same brain with the sonar input held at zero, so the comparison is deaf versus hearing, not two different brains.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SpikingNetwork, TRACKS } from "../src/core";
import { DEFAULT_STYLE, Style } from "../src/vision/camera";
import { driveEpisode, summarise } from "../src/vision/evaluate";
import type { Summary } from "../src/vision/evaluate";
import { Perceiver, VisionModel } from "../src/vision/perception";
import { VisionDriver } from "../src/vision/pipeline";
import { proceduralTrack } from "../src/vision/proceduralTracks";
import { trackDomain, worldDomain } from "../src/vision/domains";
import { ROBOT_PROFILE } from "../src/vision/robot";
import { driveWorldEpisode } from "../src/vision/world/worldRun";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const quick = args.has("quick");
const out = args.get("out") ?? "public/vision/robot/results.json";
const only = (args.get("only") ?? "track,world").split(",");
const folder = "public/vision/robot/";
const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const maybe = <T>(path: string): T | null => (existsSync(path) ? (load(path) as T) : null);
const stamp = (() => { const t0 = performance.now(); return () => `${((performance.now() - t0) / 1000).toFixed(0)}s`; })();

const robotController = SpikingNetwork.fromJSON(load(args.get("controller") ?? folder + "controller.json").network);
const kartController = SpikingNetwork.fromJSON(load(args.get("kart") ?? "public/vision/controller.json").network);
const eyes = maybe<VisionModel>(args.get("vision") ?? folder + "vision-net.json");

const named = TRACKS.filter((t) => !t.id.startsWith("gen-"));
const heldNamed = ["mountain-pass", "needle-eye", "rainbow-rally", "oval-sprint"].map((id) => named.find((t) => t.id === id)!);
const heldGenerated = Array.from({ length: 4 }, (_, i) => proceduralTrack(40 + i));
const suite = quick ? [heldNamed[0], heldGenerated[0]] : [...heldNamed, ...heldGenerated];
const seedsPerTrack = quick ? 1 : 2;
const maxTicks = quick ? 1500 : 3600;
const NIGHT: Style = { ...DEFAULT_STYLE, brightness: 0.42, contrast: 0.85, noise: 0.1 };

type Row = { label: string; laps: number; episodes: number; progress: number; meanLapSeconds: number | null; collisions: number; crashes: number };
const toRow = (label: string, s: Summary): Row => ({ label, laps: s.laps, episodes: s.episodes, progress: s.meanProgress, meanLapSeconds: s.meanLapSeconds, collisions: s.collisions, crashes: s.crashes });

type Scenario = { id: string; label: string; roadObjects: number; rivals: number; objectKind: "mixed" | "oil" | "cone" | "barrier" | "stalled-car"; style?: Style; note: string };
const scenarios: Scenario[] = [
  { id: "empty", label: "Empty road", roadObjects: 0, rivals: 0, objectKind: "mixed", note: "No obstacles: does the sonar get in the way?" },
  { id: "obstacles", label: "Cones, barriers and stalled cars", roadObjects: 3, rivals: 1, objectKind: "mixed", note: "Three objects and one moving rival per lap." },
  { id: "obstacles-night", label: "The same, at night", roadObjects: 3, rivals: 1, objectKind: "mixed", style: NIGHT, note: "The camera is dim and noisy; the sonar does not care about light." },
  { id: "flat", label: "Oil slicks (flat, invisible to sound)", roadObjects: 3, rivals: 0, objectKind: "oil", note: "Control: a hazard the sonar cannot hear, so it should not help." },
];

type Condition = { id: string; label: string; controller: SpikingNetwork; eyes: boolean; sonar: boolean };
const conditions: Condition[] = [
  { id: "feel-kart", label: "Exact numbers · kart controller (no sonar inputs)", controller: kartController, eyes: false, sonar: false },
  { id: "feel-deaf", label: "Exact numbers · robot controller, sonar off", controller: robotController, eyes: false, sonar: false },
  { id: "feel-sonar", label: "Exact numbers · robot controller, sonar on", controller: robotController, eyes: false, sonar: true },
  ...(eyes ? [
    { id: "cam-kart", label: "Camera only · kart controller", controller: kartController, eyes: true, sonar: false },
    { id: "cam-deaf", label: "Camera only · robot controller, sonar off", controller: robotController, eyes: true, sonar: false },
    { id: "cam-sonar", label: "Camera + sonar · robot controller", controller: robotController, eyes: true, sonar: true },
  ] : []),
];

function driveTracks(condition: Condition, scenario: Scenario): Summary {
  const driver = new VisionDriver({
    perceiver: condition.eyes && eyes ? new Perceiver(eyes) : null, controller: condition.controller.clone(), domain: trackDomain, mode: "belief",
    fusion: { fade: 0 }, feelingController: condition.controller.clone(), sonarOff: !condition.sonar,
  });
  const results = [];
  for (const [index, track] of suite.entries()) for (let k = 0; k < seedsPerTrack; k += 1) {
    results.push(driveEpisode(driver, {
      track, seed: 7 + index + 31 * k, styleStrength: 0, style: scenario.style, maxTicks, walls: true, profile: ROBOT_PROFILE,
      rivals: scenario.rivals, roadObjects: scenario.roadObjects, objectKind: scenario.objectKind,
    }));
  }
  return summarise(results);
}

const results: Record<string, any> = { generatedAt: new Date().toISOString(), profile: "robot", note: quick ? "quick run" : "full run" };
try { Object.assign(results, JSON.parse(readFileSync(out, "utf8"))); } catch { /* first run */ }
results.generatedAt = new Date().toISOString(); results.note = quick ? "quick run" : "full run";

if (only.includes("track")) {
  const table: { id: string; label: string; note: string; rows: Row[] }[] = [];
  for (const scenario of scenarios) {
    const rows: Row[] = [];
    for (const condition of conditions) {
      if (scenario.style && !condition.eyes) continue; // the look of the world only reaches the camera
      const row =toRow(condition.label, driveTracks(condition, scenario));
      rows.push(row);
      console.log(`${scenario.id.padEnd(16)} ${condition.label.padEnd(54)} laps ${row.laps}/${row.episodes}  progress ${(row.progress * 100).toFixed(0)}%  collisions ${row.collisions}  crashes ${row.crashes}  (${stamp()})`);
    }
    table.push({ id: scenario.id, label: scenario.label, note: scenario.note, rows });
  }
  results.track = { suite: suite.map((t) => t.id), episodesPerCell: suite.length * seedsPerTrack, scenarios: table, hasEyes: Boolean(eyes) };
  writeFileSync(out, JSON.stringify(results, null, 1));
}

/* ---- the open world: trees, rocks, ponds and a fence, no road ---- */
if (only.includes("world")) {
  const worldController = maybe<{ network: any }>(folder + "world-controller.json");
  const worldEyes = maybe<VisionModel>(folder + "world-vision-net.json");
  if (worldController) {
    const controller = SpikingNetwork.fromJSON(worldController.network);
    const worlds = quick ? 4 : 16;
    const cells: { id: string; label: string; eyes: boolean; sonar: boolean }[] = [
      { id: "feel-deaf", label: "Exact numbers · sonar off", eyes: false, sonar: false },
      { id: "feel-sonar", label: "Exact numbers · sonar on", eyes: false, sonar: true },
      ...(worldEyes ? [{ id: "cam-deaf", label: "Camera only", eyes: true, sonar: false }, { id: "cam-sonar", label: "Camera + sonar", eyes: true, sonar: true }] : []),
    ];
    const rows: any[] = [];
    for (const cell of cells) {
      const driver = new VisionDriver({ perceiver: cell.eyes && worldEyes ? new Perceiver(worldEyes) : null, controller: controller.clone(), domain: worldDomain, mode: "belief", fusion: { fade: 0 }, sonarOff: !cell.sonar });
      const runs = Array.from({ length: worlds }, (_, i) => driveWorldEpisode(driver, { seed: 60000 + i, density: 0.35 + (i % 4) * 0.18, maxTicks: quick ? 900 : 1800, styleStrength: 0.4, profile: ROBOT_PROFILE }));
      const mean = (f: (r: (typeof runs)[number]) => number) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
      const row = { id: cell.id, label: cell.label, worlds, goals: mean((r) => r.goals), collisions: mean((r) => r.collisions), crashes: runs.filter((r) => r.crashed).length, pondCrashes: runs.filter((r) => r.crashed && /water|pond/i.test(r.crashReason ?? "")).length };
      rows.push(row);
      console.log(`world ${cell.label.padEnd(30)} goals ${row.goals.toFixed(2)}  collisions ${row.collisions.toFixed(2)}  crashes ${row.crashes}/${worlds} (ponds ${row.pondCrashes})  (${stamp()})`);
    }
    results.world = { rows, hasEyes: Boolean(worldEyes) };
    writeFileSync(out, JSON.stringify(results, null, 1));
  } else console.log("no robot world controller yet; skipped the world");
}
writeFileSync(out, JSON.stringify(results, null, 1));
console.log("wrote", out, stamp());
