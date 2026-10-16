// FlyKart Evolve, headless and resumable. Start it before bed:
//
//   npm run evolve -- --name=night1 --hours=8                (resource-sparse profile: the default, gentle on the laptop)
//   npm run evolve -- --name=night1 --hours=8                (the same command resumes where it stopped)
//   npm run evolve -- --name=night1 --profile=standard       (or thorough; --duty=1 --workers=3 override individually)
//   npm run evolve -- --name=night2 --from=public/vision/robot/world-controller.json --last-stage=3
//   npm run evolve -- --name=night3 --from=bundled,visual,mybrains/            (several founders: "bundled", "visual", files, folders)
//   npm run evolve -- --name=night4 --from=bundled,https://github.com/owner/repo/blob/main/brain.json   (GitHub links work too)
//
// A stage is mastered before the next begins. When one cannot be (40 climbs, or 8 in a row with no better result) the run
// stops and says so. Decide, then run the same command again with one of:
//   --more-climbs=6            allow 6 more climbs on that stage
//   --goals=2:60,3:50          set goals (stage:percent of flags); a lowered goal that was already reached moves on
//   --move-on                  take the stage's best brain as it is and begin the next stage
//   --rerun-stage=2 [--rerun-from=L7]   climb stage 2 again from its best brain (or from L7), dropping later stages' results
// Other switches: --keep-per-stage=3 (best maxima kept per stage), --max-climbs=40, --stage-stall=8, --advance-anyway
// (the older rule: a couple more climbs, then on regardless).
//
// It writes runs/<name>/{state.json, progress.json, best-brain.json, best-brain-48.json, log.txt} and keeps going
// until the time budget is spent, the last stage is finished, or a file called STOP appears in that folder.
// Open evolve.html and choose "Load run" (or let it poll runs/<name>/progress.json) to watch without disturbing it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { cpus, setPriority, constants as osConstants } from "node:os";
import { DEFAULT_PROFILE, PROFILES, type ProfileId } from "../src/evolve/profiles";
import { validateRanges } from "../src/evolve/reality";
import type { BrainSnapshot } from "../src/core";
import { EvolutionEngine, DEFAULT_CONFIG, type EngineConfig, type EngineState } from "../src/evolve/engine";
import { PoolBackend, type WorkerHandle, type WorkerJob, type WorkerReply } from "../src/evolve/backend";
import { prepareFounders, readFounder, type Founder } from "../src/evolve/founders";
import { fetchBrainText, listFolder, parseGithubLink } from "../src/evolve/github";
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
const numeric: [string, keyof EngineConfig][] = [["seed", "runSeed"], ["pop", "population"], ["parents", "parents"], ["battery", "battery"], ["exam", "examSize"], ["exam-every", "examEvery"], ["tournament", "tournamentSize"], ["patience", "patience"], ["branches", "branchesPerStage"], ["max-gens", "maxGenerationsPerBranch"], ["keep-per-stage", "keepPerStage"], ["max-climbs", "maxClimbsPerStage"], ["stage-stall", "stageStall"], ["grow-by", "growBy"], ["max-hidden", "maxHidden"], ["last-stage", "lastStage"], ["ray-step", "rayStepDeg"], ["layer-per-stage", "layerPerStage"], ["layer-from-stage", "layerFromStage"], ["protect", "protect"], ["hard-share", "hardShare"], ["pocket-share", "pocketShare"]];
for (const [flag, key] of numeric) if (args.has(flag)) (config as Record<string, number>)[key] = Number(args.get(flag));
if (args.get("two-phase") === "false") config.twoPhase = false;
if (args.get("advance-anyway") === "true") config.advanceAnyway = true;
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
  engine.tidyArchive();
  log(`Resuming ${name}: generation ${state.generation}, stage ${state.stage + 1}, ${state.archive.length} local maxima, ${(state.counters.elapsedMs / 3600000).toFixed(2)} h already used.`);
} else {
  // --from takes one or several comma-separated brains: files, folders of .json files, or the words bundled / visual.
  const shortcuts: Record<string, string> = { bundled: "public/vision/robot/world-controller.json", visual: "assets/flykart-visual.json" };
  const paths: string[] = [];
  for (const part of from.split(",").map((p) => p.trim()).filter(Boolean)) {
    const path = shortcuts[part] ?? part;
    if (existsSync(path) && statSync(path).isDirectory()) for (const f of readdirSync(path).sort()) { if (f.toLowerCase().endsWith(".json")) paths.push(resolve(path, f)); }
    else paths.push(path);
  }
  const found: Founder[] = [];
  for (const path of paths) {
    try {
      if (/^https:\/\//.test(path)) {
        // A GitHub link to one brain, or to a folder of them (the .json files in it are all tried).
        const target = parseGithubLink(path);
        const files = target.kind === "file" ? [{ name: target.name, url: target.url }] : await listFolder(target);
        for (const file of files) {
          try { found.push(readFounder(await fetchBrainText(file.url), `GitHub: ${file.name}`)); } catch (error) { log(`Skipped ${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } else found.push(readFounder(readFileSync(path, "utf8"), path));
    } catch (error) { log(`Skipped ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const founders = prepareFounders(found);
  for (const line of founders.report) log(`Founder: ${line}`);
  const seed: BrainSnapshot = founders.seed;
  engine = EvolutionEngine.fresh(seed, { ...DEFAULT_CONFIG, ...config }, backend, founders.others);
  log(`Starting ${name} from ${1 + founders.others.length} brain(s) (${seed.inputCount} inputs, ${seed.hiddenCount} neurons) on ${workers} worker(s) for ${hours} h · profile ${profile.id}, ${Math.round(duty * 100)}% duty.`);
}

// What the person decided about a stopped or finished stage (see the header). Applied to a resumed run, in this order.
{
  const off = engine.on((event) => { if (event.type === "log") log(event.text); });
  const state = engine.state;
  for (const [flag, key] of [["keep-per-stage", "keepPerStage"], ["max-climbs", "maxClimbsPerStage"], ["stage-stall", "stageStall"]] as const) if (args.has(flag)) state.config[key] = Number(args.get(flag));
  if (args.get("advance-anyway") === "true") state.config.advanceAnyway = true;
  for (const part of (args.get("goals") ?? "").split(",").filter(Boolean)) {
    const [stage, percent] = part.split(":").map(Number);
    engine.setGoal(stage - 1, percent / 100);
  }
  if (args.has("rerun-stage")) engine.rerunStage(Number(args.get("rerun-stage")) - 1, { fromId: args.get("rerun-from") });
  if (state.stalled) {
    if (args.get("move-on") === "true") engine.moveOn();
    else if (args.has("more-climbs")) engine.continueStage(Number(args.get("more-climbs")));
    else if (state.stalled.reach >= engine.goalFor(state.stalled.stage)) engine.moveOn(); // the goal was lowered to what was already reached
  }
  off();
}

engine.on((event) => {
  if (event.type === "log") log(event.text);
  if (event.type === "generation") {
    const r = event.record;
    if (r.gen % 5 === 0 || r.event) log(`gen ${r.gen} · stage ${r.stage + 1} climb ${r.branch + 1} (${r.branchType}) · best ${r.best.toFixed(1)} mean ${r.mean.toFixed(1)} leader ${r.champion.toFixed(1)}${r.exam ? ` · exam ${r.exam.score.toFixed(1)} ± ${r.exam.se.toFixed(1)} flags ${(r.exam.reach * 100).toFixed(0)}%${r.exam.reverse !== undefined ? ` · back ${(r.exam.reverse * 100).toFixed(0)}% walls ${((r.exam.wall ?? 0) * 100).toFixed(0)}% stuck ${(r.exam.pinned ?? 0).toFixed(1)}s` : ""}` : ""}${r.event ? ` · ${r.event}` : ""}`);
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
if (engine.state.stalled) {
  const st = engine.state.stalled;
  log(`Stage ${st.stage + 1} stopped at ${(st.reach * 100).toFixed(0)}% of flags, goal ${(st.goal * 100).toFixed(0)}% (${st.why}). Run the same command again with --more-climbs=6, --goals=${st.stage + 1}:${Math.max(5, Math.floor(st.reach * 100))}, --move-on or --rerun-stage=${st.stage + 1}.`);
} else if (engine.state.finished) {
  log("All requested stages finished. Comparing every local maximum on one fresh battery…");
  const table = await engine.finalComparison(6);
  for (const row of table.slice(0, 8)) log(`  ${row.id.padEnd(14)} score ${row.score.toFixed(1)} · flags ${(row.reach * 100).toFixed(0)}%`);
  writeAtomic(resolve(dir, "final-comparison.json"), JSON.stringify(table));
}
log(`Stopped at generation ${engine.state.generation} (${engine.state.archive.length} local maxima, ${engine.state.counters.episodes} trials, ${(engine.state.counters.elapsedMs / 3600000).toFixed(2)} h).`);
backend.close();
process.exit(0);
