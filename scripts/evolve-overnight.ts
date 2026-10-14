// FlyKart Evolve, headless and resumable. Start it before bed:
//
//   npm run evolve -- --name=night1 --hours=8                (resource-sparse profile: the default, gentle on the laptop)
//   npm run evolve -- --name=night1 --hours=8                (the same command resumes where it stopped)
//   npm run evolve -- --name=night1 --profile=standard       (or thorough; --duty=1 --workers=3 override individually)
//   npm run evolve -- --name=night2 --from=public/vision/robot/world-controller.json --last-stage=3
//
// It writes runs/<name>/{state.json, progress.json, best-brain.json, best-brain-48.json, log.txt} and keeps going
// until the time budget is spent, the last stage is finished, or a file called STOP appears in that folder.
// Open evolve.html and choose "Load run" (or let it poll runs/<name>/progress.json) to watch without disturbing it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { cpus, setPriority, constants as osConstants } from "node:os";
import { DEFAULT_PROFILE, PROFILES, type ProfileId } from "../src/evolve/profiles";
import { validateRanges } from "../src/evolve/reality";
import type { BrainSnapshot } from "../src/core";
import { EvolutionEngine, DEFAULT_CONFIG, type EngineConfig, type EngineState } from "../src/evolve/engine";
import { PoolBackend, type WorkerHandle, type WorkerJob, type WorkerReply } from "../src/evolve/backend";
import { brainFile, brainFile48, toProgress } from "../src/evolve/persist";
import { bundleWorker } from "./pool";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, value] = arg.replace(/^--/, "").split("="); return [key, value ?? "true"] as const; }));
const name = args.get("name") ?? "run";
const dir = resolve("runs", name);
mkdirSync(dir, { recursive: true });
// --profile=sparse (default) | standard | thorough; individual flags below override the profile.
const profileId = (args.get("profile") ?? DEFAULT_PROFILE) as ProfileId;
if (!PROFILES[profileId]) throw new Error(`Unknown profile "${profileId}". Use sparse, standard or thorough.`);
const profile = PROFILES[profileId];
const workers = Number(args.get("workers") ?? profile.workers(cpus().length));
const duty = Math.max(0.1, Math.min(1, Number(args.get("duty") ?? profile.duty)));
if (profile.lowPriority && args.get("normal-priority") !== "true") { try { setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: carry on at normal priority */ } }
const hours = Number(args.get("hours") ?? 8);
const from = args.get("from") ?? "public/vision/robot/world-controller.json";
const config: Partial<EngineConfig> = { ...profile.config };
const numeric: [string, keyof EngineConfig][] = [["seed", "runSeed"], ["pop", "population"], ["parents", "parents"], ["battery", "battery"], ["exam", "examSize"], ["exam-every", "examEvery"], ["tournament", "tournamentSize"], ["patience", "patience"], ["branches", "branchesPerStage"], ["max-gens", "maxGenerationsPerBranch"], ["grow-by", "growBy"], ["max-hidden", "maxHidden"], ["last-stage", "lastStage"], ["ray-step", "rayStepDeg"], ["layer-per-stage", "layerPerStage"], ["layer-from-stage", "layerFromStage"], ["protect", "protect"], ["hard-share", "hardShare"], ["pocket-share", "pocketShare"]];
for (const [flag, key] of numeric) if (args.has(flag)) (config as Record<string, number>)[key] = Number(args.get(flag));
if (args.get("two-phase") === "false") config.twoPhase = false;
// Switches for the long-run helpers (all on by default): --no-polish, --no-qd, --no-extra-trials.
if (args.get("no-polish") === "true") config.polish = false;
if (args.get("no-qd") === "true") config.qd = false;
if (args.get("no-extra-trials") === "true") config.extraTrials = false;
// Flaws measured on the real robot: --reality=measured.json holding { "deadband": [lo, hi], "tau": [lo, hi], "camEvery": [3, 6] } (see src/evolve/reality.ts).
if (args.get("reality")) config.realityRanges = validateRanges(JSON.parse(readFileSync(args.get("reality")!, "utf8")));

const statePath = resolve(dir, "state.json");
const logPath = resolve(dir, "log.txt");
const logLines: string[] = [];
const log = (text: string): void => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${text}`;
  console.log(line); logLines.push(line); appendFileSync(logPath, line + "\n");
};
const writeAtomic = (path: string, text: string): void => { const tmp = path + ".tmp"; writeFileSync(tmp, text); renameSync(tmp, path); };

// A laptop that goes to sleep stops the run. On Windows, ask for the system to stay awake for as long as this process lives
// (the display may still turn off). Pass --allow-sleep to opt out. Elsewhere, use your system's own setting or caffeinate / systemd-inhibit.
if (process.platform === "win32" && args.get("allow-sleep") !== "true") {
  const script = [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "Add-Type -MemberDefinition $sig -Name Power -Namespace FlyKart",
    "[void][FlyKart.Power]::SetThreadExecutionState(0x80000001)",
    `Wait-Process -Id ${process.pid}`,
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  process.on("exit", () => child.kill());
  log("Keeping the system awake while this runs (the screen may still turn off).");
}

const file = await bundleWorker("scripts/evolve-worker.ts", "evolve-worker");
const handles: WorkerHandle[] = Array.from({ length: workers }, () => {
  const worker = new Worker(file);
  return {
    post: (job: WorkerJob) => worker.postMessage(job),
    onReply: (listener: (reply: WorkerReply) => void) => { worker.on("message", listener); worker.on("error", (error) => listener({ id: -1, error: String(error) })); },
    terminate: () => { void worker.terminate(); },
  };
});
const backend = new PoolBackend(handles);

let engine: EvolutionEngine;
if (existsSync(statePath)) {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as EngineState;
  engine = new EvolutionEngine(state, backend);
  log(`Resuming ${name}: generation ${state.generation}, stage ${state.stage + 1}, ${state.archive.length} local maxima, ${(state.counters.elapsedMs / 3600000).toFixed(2)} h already used.`);
} else {
  const seed = JSON.parse(readFileSync(from, "utf8")).network as BrainSnapshot;
  engine = EvolutionEngine.fresh(seed, { ...DEFAULT_CONFIG, ...config }, backend);
  log(`Starting ${name} from ${from} (${seed.inputCount} inputs, ${seed.hiddenCount} neurons) on ${workers} worker(s) for ${hours} h · profile ${profile.id}, ${Math.round(duty * 100)}% duty.`);
}

engine.on((event) => {
  if (event.type === "log") log(event.text);
  if (event.type === "generation") {
    const r = event.record;
    if (r.gen % 5 === 0 || r.event) log(`gen ${r.gen} · stage ${r.stage + 1} climb ${r.branch + 1} (${r.branchType}) · best ${r.best.toFixed(1)} mean ${r.mean.toFixed(1)} leader ${r.champion.toFixed(1)}${r.exam ? ` · exam ${r.exam.score.toFixed(1)} ± ${r.exam.se.toFixed(1)} flags ${(r.exam.reach * 100).toFixed(0)}%` : ""}${r.event ? ` · ${r.event}` : ""}`);
  }
});

let saved = 0, stopRequested = false;
process.on("SIGINT", () => { stopRequested = true; log("Interrupt received: finishing this generation, then saving."); });
const save = (): void => {
  const state = engine.state;
  writeAtomic(statePath, JSON.stringify(state));
  writeAtomic(resolve(dir, "progress.json"), JSON.stringify(toProgress(state, name, logLines)));
  const best = engine.best();
  const meta = { fitness: state.champion?.score ?? 0, generation: state.generation, label: best.label, run: name };
  writeAtomic(resolve(dir, "best-brain.json"), brainFile(best.brain, meta));
  writeAtomic(resolve(dir, "best-brain-48.json"), brainFile48(best.brain, meta));
  saved = Date.now();
};

// The budget is working time (the sum of generation times), so a laptop that sleeps mid-run does not spend it.
const startElapsed = engine.state.counters.elapsedMs;
const stop = (): boolean => stopRequested || engine.state.counters.elapsedMs - startElapsed > hours * 3600_000 || existsSync(resolve(dir, "STOP"));
while (!engine.state.finished && !stop()) {
  const began = Date.now();
  await engine.generation();
  // Resource-sparse: rest between generations so the machine is not pinned the whole night.
  if (duty < 1) await new Promise((r) => setTimeout(r, (Date.now() - began) * (1 / duty - 1)));
  if (Date.now() - saved > 60_000 || engine.state.generation % 10 === 0) save();
}
save();
if (engine.state.finished) {
  log("All requested stages finished. Comparing every local maximum on one fresh battery…");
  const table = await engine.finalComparison(6);
  for (const row of table.slice(0, 8)) log(`  ${row.id.padEnd(14)} score ${row.score.toFixed(1)} · flags ${(row.reach * 100).toFixed(0)}%`);
  writeAtomic(resolve(dir, "final-comparison.json"), JSON.stringify(table));
}
log(`Stopped at generation ${engine.state.generation} (${engine.state.archive.length} local maxima, ${engine.state.counters.episodes} trials, ${(engine.state.counters.elapsedMs / 3600000).toFixed(2)} h).`);
backend.close();
process.exit(0);
