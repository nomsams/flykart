// FlyKart Evolve: the page. Press play, leave it, look in when you like.
import "./evolve.css";
import { SpikingNetwork, type BrainSnapshot } from "../core";
import { mulberry32 } from "../vision/rng";
import { ROBOT_PROFILE } from "../vision/robot";
import { PoolBackend, type WorkerHandle, type WorkerJob, type WorkerReply } from "./backend";
import { brainCost } from "./brain-size";
import { STAGES, aggregate, caseFor, runCase, type CaseSpec } from "./cases";
import { DEFAULT_VIEW, drawLandscape, drawProgress, stageColor, type LandscapeView } from "./charts";
import { DEFAULT_CONFIG, EvolutionEngine, type EngineState } from "./engine";
import { DEFAULT_PROFILE, PROFILES, type ProfileId } from "./profiles";
import { generateHabitat, HABITATS, type HabitatKind } from "./habitats";
import { TRAIT_NAMES, DESCRIPTOR_NAMES, BASE_OBJECTIVE } from "./objective";
import { brainFile, brainFile48, parseProgress, toProgress, type Progress } from "./persist";
import { RealityGapNote, sampleReality } from "./reality";
import { CameraView, drawTopDown } from "./replay";
import { buildScenario } from "./scenario";
import { runEpisode } from "./drive";
import { deleteRun, listRuns, loadRun, saveRun } from "./store";
import { Habitat3D } from "./view3d";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};
const fmtTime = (ms: number): string => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const pct = (v: number): string => `${Math.round(v * 100)}%`;

type Mode = "headless" | "watch";
const app = {
  engine: null as EvolutionEngine | null,
  backend: null as PoolBackend | null,
  progress: null as Progress | null,
  seedBrain: null as BrainSnapshot | null,
  running: false, stopRequested: false,
  mode: "headless" as Mode,
  log: [] as string[],
  selected: null as string | null,
  view: { ...DEFAULT_VIEW } as LandscapeView,
  picks: [] as { id: string; x: number; y: number }[],
  viewOnly: false,
  lastDraw: 0, lastSave: 0, lastStatus: 0,
  wakeLock: null as { release(): Promise<void> } | null,
  releaseLock: null as (() => void) | null,
  poll: null as number | null,
  workers: 3,
};

/* ------------------------------------------------------------------ */
/* Logging, status                                                     */
/* ------------------------------------------------------------------ */

function log(text: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  app.log.push(line); if (app.log.length > 400) app.log.shift();
  const el = $("evo-log"); el.textContent = app.log.slice(-120).join("\n"); el.scrollTop = el.scrollHeight;
}

function setStatus(text: string): void { $("evo-status").textContent = text; }

function currentState(): EngineState | null { return app.engine?.state ?? null; }

function renderSummary(): void {
  const p = app.progress, s = currentState();
  if (!p) return;
  $("s-stage").textContent = `${p.stage + 1} of ${p.stages.length}`;
  $("s-branch").textContent = `${p.branch + 1} · ${p.branchType}${p.emphasis !== "balanced" ? ` · ${p.emphasis}` : ""}`;
  $("s-gen").textContent = String(p.generation);
  $("s-max").textContent = String(p.maxima.length);
  const last = [...p.history].reverse().find((r) => r.exam);
  $("s-reach").textContent = last?.exam ? `${pct(last.exam.reach)} · ${last.exam.score.toFixed(0)} pts` : "—";
  const hidden = last?.hidden ?? p.history[p.history.length - 1]?.hidden ?? 48, cost = brainCost(hidden);
  const layers = p.layers?.length > 1 ? ` · layers ${p.layers.map((l) => `${l[1]}${l[2] < 1 ? `@${l[2].toFixed(2)}` : ""}`).join(" + ")}` : "";
  $("s-brain").textContent = `${hidden} neurons · ${(cost.weightBytes / 1024).toFixed(0)} KB${layers}`;
  $("s-trials").textContent = p.episodes.toLocaleString();
  $("s-time").textContent = fmtTime(p.elapsedMs);
  void s;
}

function renderStages(): void {
  const p = app.progress;
  if (!p) return;
  const list = $("evo-stages"); list.innerHTML = "";
  p.stages.forEach((st, i) => {
    const result = p.stageResults.find((r) => r.stage === i);
    const li = document.createElement("li");
    li.dataset.state = result ? "done" : i === p.stage && !p.finished ? "current" : "todo";
    const maxima = p.maxima.filter((m) => m.stage === i);
    const best = maxima.length ? Math.max(...maxima.map((m) => m.exam.reach)) : null;
    li.innerHTML = `<span><strong style="color:${stageColor(i)}">${st.title}</strong></span><span>${result ? `${result.mastered ? "mastered" : "moved on"} · winner ${result.winner} · ${pct(result.reach)} flags` : i === p.stage && !p.finished ? `climbing · ${maxima.length} local maxima` : "waiting"}</span><small>Goal ${pct(st.mastery)} of flags found on fresh trials. ${best !== null ? `Best exam so far ${pct(best)}.` : ""} ${STAGES[i]?.blurb ?? ""}</small>`;
    list.append(li);
  });
}

function renderTable(): void {
  const p = app.progress;
  const body = document.querySelector<HTMLTableSectionElement>("#evo-maxima tbody")!;
  body.innerHTML = "";
  if (!p) return;
  for (const m of p.maxima) {
    const tr = document.createElement("tr");
    tr.dataset.selected = String(m.id === app.selected);
    tr.innerHTML = `<td style="color:${stageColor(m.stage)}">${m.id}</td><td>${m.stage + 1}</td><td>${m.branchType}${m.emphasis !== "balanced" ? ` · ${m.emphasis}` : ""}</td><td>${m.hidden}</td><td>${m.exam.score.toFixed(0)} ± ${m.exam.se.toFixed(0)}</td><td>${pct(m.exam.reach)}</td><td>${m.tournament ? `${m.tournament.score.toFixed(0)} · ${pct(m.tournament.reach)}` : "—"}</td>`;
    tr.addEventListener("click", () => select(m.id));
    body.append(tr);
  }
}

function select(id: string | null): void {
  app.selected = id;
  renderTable(); drawMap();
  const box = $("evo-selected"), m = app.progress?.maxima.find((x) => x.id === id);
  if (!m) { box.hidden = true; return; }
  box.hidden = false;
  const bars = TRAIT_NAMES.map((t) => `<span>${t}</span><span class="evo-bar"><i style="width:${Math.round(m.traits[t] * 100)}%"></i></span>`).join("")
    + m.descriptor.map((v, k) => `<span>${DESCRIPTOR_NAMES[k]}</span><span class="evo-bar"><i style="width:${Math.round(v * 100)}%;background:#c4a2ff"></i></span>`).join("");
  box.innerHTML = `<strong>${m.id}</strong> · stage ${m.stage + 1} · ${m.note}<div class="evo-bars">${bars}</div><div class="evo-run-row"><button id="sel-watch" type="button">Watch it</button><button id="sel-dl" type="button">Download this brain</button></div>`;
  $("sel-watch").addEventListener("click", () => { setMode("watch"); ($("w-brain") as HTMLSelectElement).value = m.id; runWatch(); });
  $("sel-dl").addEventListener("click", () => { const brain = brainOf(m.id); if (brain) download(`flykart-evolve-${m.id}.json`, brainFile(brain, { fitness: m.exam.score, generation: m.generation, label: m.note, run: $<HTMLInputElement>("evo-name").value })); });
}

function brainOf(id: string): BrainSnapshot | null {
  const s = currentState();
  if (!s) return null;
  if (id === "champion") return s.champion?.brain ?? app.engine!.best().brain;
  if (id === "seed") return app.seedBrain;
  return s.archive.find((m) => m.id === id)?.brain ?? null;
}

function download(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function drawMap(): void {
  if (app.mode !== "watch" && app.running) return;
  drawProgress($<HTMLCanvasElement>("evo-progress"), app.progress);
  app.picks = drawLandscape($<HTMLCanvasElement>("evo-landscape"), app.progress, app.view, app.selected, app.progress?.champion?.id ?? null);
}

function renderAll(): void {
  renderSummary(); renderTable(); renderStages(); renderNotes(); populateWatchBrains();
  drawMap();
}

function renderNotes(): void {
  const p = app.progress;
  const cost = brainCost(p?.history[p.history.length - 1]?.hidden ?? 48);
  let verdict = "No growth experiment has finished yet.";
  if (p) {
    const grown = p.maxima.filter((m) => m.branchType === "grow"), others = p.maxima.filter((m) => m.branchType !== "grow" && m.branchType !== "seed");
    if (grown.length && others.length) {
      const mean = (a: typeof p.maxima) => a.reduce((s, m) => s + (m.tournament?.score ?? m.exam.score), 0) / a.length;
      verdict = `Growing the brain gave ${grown.length} local maximum${grown.length > 1 ? "a" : ""} averaging ${mean(grown).toFixed(1)} points against ${mean(others).toFixed(1)} for climbs at the old size (${grown.map((m) => m.hidden).join(", ")} neurons). That is a measurement from this run only; the standard error of one exam is ${(grown[0].exam.se).toFixed(0)} points.`;
    }
  }
  $("evo-size-note").textContent = `This brain runs ${cost.macsPerTick.toLocaleString()} multiply-adds per 33 ms tick and holds ${(cost.weightBytes / 1024).toFixed(1)} KB of weights: trivial for an ESP32 (240 MHz, 520 KB), so size is limited by how hard the search gets, not by the chip. At a plateau the run tries +${DEFAULT_CONFIG.growBy} neurons that start with no influence and keeps them only if they earn it. ${verdict}`;
  $("evo-reality-note").textContent = `${RealityGapNote} Later stages draw: motor dead zone 4–26 % duty, motor lag 80–350 ms, a sagging battery, a 3–10 Hz camera that sometimes drops frames, estimates with latency, a noisier and sometimes ghostly HC-SR04, and no speed sensor (the controller sees its own commanded speed only).`;
}

/* ------------------------------------------------------------------ */
/* Workers and the run loop                                            */
/* ------------------------------------------------------------------ */

function makeBackend(count: number): PoolBackend {
  const handles: WorkerHandle[] = Array.from({ length: count }, () => {
    const worker = new Worker(new URL("./evolve.worker.ts", import.meta.url), { type: "module", name: "FlyKart evolve" });
    return {
      post: (job: WorkerJob) => worker.postMessage(job),
      onReply: (listener: (reply: WorkerReply) => void) => { worker.onmessage = (e: MessageEvent<WorkerReply>) => listener(e.data); worker.onerror = (e) => listener({ id: -1, error: e.message }); },
      terminate: () => worker.terminate(),
    };
  });
  return new PoolBackend(handles);
}

async function loadBundledBrain(): Promise<BrainSnapshot> {
  const response = await fetch(new URL("./vision/robot/world-controller.json", location.href));
  const text = await response.text();
  if (text.trimStart().startsWith("<")) throw new Error("The bundled robot brain is missing from this build.");
  return (JSON.parse(text) as { network: BrainSnapshot }).network;
}

async function readSeedBrain(): Promise<BrainSnapshot> {
  if ($<HTMLSelectElement>("evo-from").value === "file") {
    const file = $<HTMLInputElement>("evo-file").files?.[0];
    if (!file) throw new Error("Choose a brain file first.");
    const raw = JSON.parse(await file.text());
    const network = (raw.network ?? raw.controller?.network ?? raw) as BrainSnapshot;
    SpikingNetwork.fromJSON(network); // validates
    if (network.inputCount !== 19) throw new Error("This brain has no sonar inputs. FlyKart Evolve breeds 19-input (camera + sonar) brains; widen it in FlyKart Vision first.");
    return network;
  }
  return loadBundledBrain();
}

function engineConfig(): Partial<typeof DEFAULT_CONFIG> {
  const last = Number($<HTMLSelectElement>("evo-last").value);
  const profile = PROFILES[$<HTMLSelectElement>("evo-profile").value as ProfileId] ?? PROFILES[DEFAULT_PROFILE];
  return {
    ...profile.config,
    population: Math.max(6, Number($<HTMLInputElement>("evo-pop").value) || profile.config.population || 20),
    battery: Math.max(2, Number($<HTMLInputElement>("evo-battery").value) || profile.config.battery || 6),
    layerPerStage: Math.max(0, Number($<HTMLInputElement>("evo-layer").value) || 0),
    lastStage: last, runSeed: (Date.now() % 100000) + 1,
  };
}

async function acquireKeepAwake(): Promise<void> {
  try {
    if ($<HTMLInputElement>("evo-keep").checked && "wakeLock" in navigator) app.wakeLock = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request("screen");
  } catch { /* some browsers refuse; the run continues */ }
  // A held Web Lock keeps the browser from freezing the tab while it is in the background.
  try {
    const locks = (navigator as unknown as { locks?: { request(name: string, cb: () => Promise<void>): Promise<void> } }).locks;
    if (locks && !app.releaseLock) void locks.request("flykart-evolve-run", () => new Promise<void>((resolve) => { app.releaseLock = resolve; }));
  } catch { /* optional */ }
}
function releaseKeepAwake(): void {
  void app.wakeLock?.release().catch(() => undefined); app.wakeLock = null;
  app.releaseLock?.(); app.releaseLock = null;
}

async function ensureEngine(): Promise<EvolutionEngine> {
  const workers = Math.max(1, Math.min(16, Number($<HTMLInputElement>("evo-workers").value) || 3));
  if (app.backend && app.workers !== workers) { app.backend.close(); app.backend = null; }
  if (!app.backend) { app.backend = makeBackend(workers); app.workers = workers; }
  if (app.engine) {
    // Keep the engine's state but point it at the current pool.
    app.engine = new EvolutionEngine(app.engine.state, app.backend);
    attach(app.engine);
    return app.engine;
  }
  const seed = await readSeedBrain();
  app.seedBrain = seed;
  app.engine = EvolutionEngine.fresh(seed, engineConfig(), app.backend);
  attach(app.engine);
  log(`Run started from ${seed.inputCount} → ${seed.hiddenCount} → 4 brain, ${workers} worker(s), population ${app.engine.config.population}.`);
  return app.engine;
}

function attach(engine: EvolutionEngine): void {
  engine.on((event) => {
    if (event.type === "log") log(event.text);
    if (event.type === "finished") log("All requested stages are finished.");
  });
}

async function play(): Promise<void> {
  if (app.running) { app.stopRequested = true; setStatus("Pausing after this generation…"); return; }
  if (app.viewOnly) { setStatus("This is a view of a run file; open a saved run or start a new one to evolve."); return; }
  let engine: EvolutionEngine;
  try { engine = await ensureEngine(); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); return; }
  app.running = true; app.stopRequested = false;
  const button = $("evo-play"); button.textContent = "⏸ Pause"; button.dataset.running = "true";
  await acquireKeepAwake();
  const hours = Number($<HTMLInputElement>("evo-hours").value) || 0;
  const startElapsed = engine.state.counters.elapsedMs;
  const name = $<HTMLInputElement>("evo-name").value.trim() || "run";
  app.lastSave = Date.now();
  try {
    while (!engine.state.finished && !app.stopRequested && !(hours > 0 && engine.state.counters.elapsedMs - startElapsed > hours * 3600_000)) {
      const record = await engine.generation();
      app.progress = toProgress(engine.state, name, app.log);
      const now = performance.now();
      if (app.mode === "watch" && now - app.lastDraw > 250) { app.lastDraw = now; renderAll(); }
      else if (now - app.lastStatus > 1500) { app.lastStatus = now; renderSummary(); }
      if (record.event) { renderAll(); }
      setStatus(`${app.mode === "headless" ? "Headless · " : ""}generation ${record.gen} · stage ${record.stage + 1} · climb ${record.branch + 1} (${record.branchType}) · ${app.workers} workers`);
      if (Date.now() - app.lastSave > 30_000) { app.lastSave = Date.now(); void saveRun(name, engine.state).catch(() => undefined); }
    }
  } catch (error) {
    log(`Stopped by an error: ${error instanceof Error ? error.message : String(error)}`);
  }
  app.running = false; app.stopRequested = false; releaseKeepAwake();
  button.textContent = "▶ Continue"; button.dataset.running = "false";
  app.progress = toProgress(engine.state, name, app.log);
  void saveRun(name, engine.state).catch(() => undefined);
  renderAll();
  setStatus(engine.state.finished ? "Finished. Every requested stage is done; the champion is ready to download." : `Paused at generation ${engine.state.generation}. Saved in this browser.`);
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */

function setMode(mode: Mode): void {
  app.mode = mode;
  $("evo-mode-headless").setAttribute("aria-pressed", String(mode === "headless"));
  $("evo-mode-watch").setAttribute("aria-pressed", String(mode === "watch"));
  $("evo-watch").hidden = mode !== "watch";
  if (mode === "watch") { renderAll(); } else setStatus(app.running ? "Headless · nothing is drawn, all the processor time goes to evolution." : $("evo-status").textContent ?? "");
}

/* ------------------------------------------------------------------ */
/* Watching a trial                                                    */
/* ------------------------------------------------------------------ */

const camera = new CameraView();
let habitat3d: Habitat3D | null = null, watchTimer = 0;

function populateWatchBrains(): void {
  const select = $<HTMLSelectElement>("w-brain"), keep = select.value;
  const s = currentState();
  const options: [string, string][] = [["champion", "Champion / current leader"]];
  if (app.seedBrain || s) options.push(["seed", "The brain it started from"]);
  for (const m of s?.archive ?? []) options.push([m.id, `${m.id} · stage ${m.stage + 1} · exam ${m.exam.score.toFixed(0)}`]);
  select.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  if (options.some(([v]) => v === keep)) select.value = keep;
}

async function runWatch(): Promise<void> {
  const id = $<HTMLSelectElement>("w-brain").value;
  let brain = brainOf(id);
  if (!brain) {
    try { brain = app.seedBrain ?? (await loadBundledBrain()); app.seedBrain = brain; } catch { setStatus("No brain to watch yet."); return; }
  }
  const stageIndex = Number($<HTMLSelectElement>("w-stage").value);
  const habitatChoice = $<HTMLSelectElement>("w-habitat").value;
  const seed = Math.max(1, Number($<HTMLInputElement>("w-seed").value) || 1), severity = Number($<HTMLInputElement>("w-severity").value) || 0;
  const spec = caseFor(stageIndex, seed, BASE_OBJECTIVE, { severity });
  if (habitatChoice !== "auto") spec.scenario = { ...spec.scenario, habitat: habitatChoice as HabitatKind };
  $("w-run").setAttribute("disabled", "true");
  $("evo-watch-status").textContent = "Running the trial…";
  await new Promise((r) => setTimeout(r, 20));
  const scenario = buildScenario(spec.scenario);
  const reality = sampleReality(mulberry32(spec.seed + 4), spec.severity, spec.speedFeedback);
  const result = runEpisode(SpikingNetwork.fromJSON(brain), scenario, reality, { seed: spec.seed, trace: true, traceEvery: 2 });
  $("w-run").removeAttribute("disabled");
  camera.setWorld(scenario.world, scenario.goals);
  const use3d = $<HTMLInputElement>("w-3d").checked;
  const top = $<HTMLCanvasElement>("w-top"), eye = $<HTMLCanvasElement>("w-eye"), canvas3d = $<HTMLCanvasElement>("w-3d-canvas");
  top.hidden = use3d; canvas3d.hidden = !use3d;
  if (use3d) {
    if (!habitat3d) habitat3d = new Habitat3D(canvas3d);
    habitat3d.setWorld(scenario.world, scenario.goals); habitat3d.resize(); habitat3d.start();
  } else habitat3d?.stop();
  const trace = result.trace ?? [], frames = trace.length / 3, speed = Number($<HTMLSelectElement>("w-speed").value);
  const goalTicks = result.goalTicks;
  let index = 0;
  window.clearInterval(watchTimer);
  const step = (): void => {
    const i = Math.min(frames - 1, Math.floor(index));
    const pose = { x: trace[i * 3], y: trace[i * 3 + 1], heading: trace[i * 3 + 2] };
    const tick = i * 2, reached = goalTicks.filter((t) => t <= tick).length;
    if (use3d && habitat3d) { habitat3d.setRobot(pose); habitat3d.setTrail(trace, i); habitat3d.follow(pose); }
    else drawTopDown(top, scenario.world, { trace, upto: i, goals: scenario.goals, pose, reached });
    camera.draw(eye, pose);
    $("w-readout").textContent = [
      `${scenario.kind} · ${scenario.world.name ?? ""} · severity ${spec.severity.toFixed(1)} · seed ${seed}`,
      `time      ${(tick / 30).toFixed(1)} s of ${(result.maxTicks / 30).toFixed(0)} s`,
      `flags     ${reached} of ${result.goalTarget}`,
      `contacts  ${result.collisions}${result.crashed ? " · CRASHED: " + result.crashReason : ""}`,
      `sensors   camera ${reality.camEvery === 1 ? "every tick" : "every " + reality.camEvery + " ticks"}, sonar HC-SR04, motor lag ${(1000 / 30 / Math.max(0.01, -Math.log(Math.max(1e-3, reality.plant.motorLag)))).toFixed(0)} ms, dead zone ${(reality.plant.deadband * 100).toFixed(0)}%`,
    ].join("\n");
    if (index >= frames - 1) { window.clearInterval(watchTimer); $("evo-watch-status").textContent = `${result.goals} of ${result.goalTarget} flags · ${result.collisions} contacts · ${(result.ticks / 30).toFixed(0)} s`; return; }
    index += speed / 2;
  };
  watchTimer = window.setInterval(step, 66);
  step();
}

/* ------------------------------------------------------------------ */
/* Habitat gallery                                                     */
/* ------------------------------------------------------------------ */

let gallerySeed = 3, gallery3d: Habitat3D | null = null;
function renderGallery(): void {
  const host = $("evo-gallery"); host.innerHTML = "";
  HABITATS.forEach((h, k) => {
    const world = generateHabitat(h.kind, gallerySeed + k * 17, 0.6);
    const fig = document.createElement("figure"), canvas = document.createElement("canvas");
    canvas.width = canvas.height = 280; drawTopDown(canvas, world, {});
    fig.append(canvas); const cap = document.createElement("figcaption"); cap.textContent = `${h.title} · ${h.floors}`; fig.append(cap);
    fig.style.cursor = "pointer"; fig.addEventListener("click", () => show3d(h.kind));
    host.append(fig);
  });
}
function show3d(kind: HabitatKind): void {
  const canvas = $<HTMLCanvasElement>("g-3d-canvas");
  canvas.hidden = false; $<HTMLInputElement>("g-3d").checked = true;
  if (!gallery3d) gallery3d = new Habitat3D(canvas);
  gallery3d.setWorld(generateHabitat(kind, gallerySeed + HABITATS.findIndex((h) => h.kind === kind) * 17, 0.6));
  gallery3d.setRobot({ x: 0, y: 0, heading: 0 }); gallery3d.resize(); gallery3d.start();
}

/* ------------------------------------------------------------------ */
/* Gauntlet                                                            */
/* ------------------------------------------------------------------ */

async function runGauntlet(): Promise<void> {
  const out = $("evo-gauntlet-out");
  const brain = app.engine ? app.engine.best().brain : app.seedBrain;
  if (!brain) { out.textContent = "Start a run (or load a brain) first."; return; }
  if (!app.backend) app.backend = makeBackend(Math.max(1, Math.min(4, app.workers)));
  out.textContent = "Running the champion through every severity and place…";
  const severities = [0, 0.5, 1, 1.5, 2];
  const places: HabitatKind[] = ["lawn", "street", "apartment"];
  const cases: CaseSpec[] = [], keys: { severity: number; place: HabitatKind }[] = [];
  for (const severity of severities) for (const place of places) for (let k = 0; k < 6; k += 1) {
    const c = caseFor(4, 880000 + k, BASE_OBJECTIVE, { severity, difficulty: 0.5 });
    c.scenario = { ...c.scenario, habitat: place }; cases.push(c); keys.push({ severity, place });
  }
  const [outcomes] = await app.backend.evaluate([brain], cases);
  const rows = severities.map((severity) => {
    const mine = outcomes.filter((_, i) => keys[i].severity === severity);
    const perPlace = places.map((p) => aggregate(outcomes.filter((_, i) => keys[i].severity === severity && keys[i].place === p)).reach);
    return { severity, reach: aggregate(mine).reach, perPlace };
  });
  out.innerHTML = rows.map((r) => `<div class="row"><span>severity ${r.severity.toFixed(1)}</span><span class="evo-bar"><i style="width:${Math.round(r.reach * 100)}%"></i></span><span>${pct(r.reach)}</span></div><div class="evo-muted" style="margin:-2px 0 4px 128px">lawn ${pct(r.perPlace[0])} · street ${pct(r.perPlace[1])} · flat ${pct(r.perPlace[2])}</div>`).join("")
    + `<p class="evo-note">Share of flags found, 6 trials per place and severity, three flags each. Severity 0 is the ideal simulator, 1 a typical cheap robot, 2 a bad day. A big drop from 0 to 1 is the simulator-to-reality gap this robot has not learned to close.</p>`;
}

/* ------------------------------------------------------------------ */
/* Final comparison                                                    */
/* ------------------------------------------------------------------ */

async function finalComparison(): Promise<void> {
  const out = $("evo-final-out"); out.hidden = false;
  if (!app.engine) { out.textContent = "No local maxima yet."; return; }
  if (!app.backend) app.backend = makeBackend(app.workers);
  const engine = new EvolutionEngine(app.engine.state, app.backend);
  out.textContent = "Comparing every local maximum on one fresh battery covering all stages reached…";
  const table = await engine.finalComparison(6);
  out.textContent = ["id              score   flags", ...table.map((r) => `${r.id.padEnd(16)}${r.score.toFixed(1).padStart(6)}  ${pct(r.reach).padStart(5)}`)].join("\n");
  log(`Final comparison: best is ${table[0]?.id} with ${table[0]?.score.toFixed(1)}.`);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

async function resumeSaved(): Promise<void> {
  const select = $<HTMLSelectElement>("evo-saved");
  const runs = await listRuns().catch(() => []);
  if (!runs.length) { setStatus("No saved runs in this browser yet."); return; }
  select.hidden = false;
  select.innerHTML = runs.map((r) => `<option value="${r.name}">${r.name} · generation ${r.generation} · stage ${r.stage + 1} · ${new Date(r.savedAt).toLocaleString()}</option>`).join("");
  select.onchange = async () => {
    const state = await loadRun(select.value);
    if (!state) return;
    adopt(state, select.value);
  };
  if (runs.length === 1) { const state = await loadRun(runs[0].name); if (state) adopt(state, runs[0].name); }
}

function adopt(state: EngineState, name: string): void {
  if (app.running) { setStatus("Pause the current run first."); return; }
  if (!app.backend) app.backend = makeBackend(app.workers);
  app.engine = new EvolutionEngine(state, app.backend); attach(app.engine);
  app.viewOnly = false; $<HTMLInputElement>("evo-name").value = name;
  app.seedBrain = state.stageEntry ?? app.seedBrain;
  app.progress = toProgress(state, name, app.log);
  $("evo-play").textContent = "▶ Continue";
  renderAll(); setStatus(`Loaded ${name}: generation ${state.generation}, stage ${state.stage + 1}, ${state.archive.length} local maxima. Press Continue.`);
  log(`Loaded saved run ${name} at generation ${state.generation}.`);
}

async function importFile(file: File): Promise<void> {
  const text = await file.text();
  const raw = JSON.parse(text);
  if (raw?.format === "flykart-evolve-run") { app.progress = parseProgress(text); app.viewOnly = true; renderAll(); setStatus(`Viewing ${raw.name}: generation ${app.progress.generation} (progress file; no weights, so it cannot be continued here).`); return; }
  if (raw?.version === 1 && raw?.population && raw?.config) { adopt(raw as EngineState, $<HTMLInputElement>("evo-name").value); return; }
  setStatus("That file is neither a run state nor a run progress file.");
}

function startPolling(): void {
  stopPolling();
  const name = $<HTMLInputElement>("evo-name").value.trim() || "run";
  $("evo-poll-name").textContent = name;
  const tick = async (): Promise<void> => {
    try {
      const response = await fetch(`./runs/${encodeURIComponent(name)}/progress.json?t=${Date.now()}`);
      const text = await response.text();
      if (text.trimStart().startsWith("<")) { setStatus(`runs/${name}/progress.json was not found next to this page.`); return; }
      app.progress = parseProgress(text); app.viewOnly = true;
      renderAll(); setStatus(`Following the command-line run "${name}": generation ${app.progress.generation}, ${app.progress.maxima.length} local maxima, ${fmtTime(app.progress.elapsedMs)} of work.`);
    } catch (error) { setStatus(`Cannot read the run: ${error instanceof Error ? error.message : String(error)}`); }
  };
  void tick(); app.poll = window.setInterval(() => void tick(), 5000);
}
function stopPolling(): void { if (app.poll !== null) { window.clearInterval(app.poll); app.poll = null; } }

function wire(): void {
  const lastSelect = $<HTMLSelectElement>("evo-last"), stageSelect = $<HTMLSelectElement>("w-stage");
  STAGES.forEach((s, i) => { lastSelect.add(new Option(`up to ${s.title}`, String(i))); stageSelect.add(new Option(s.title, String(i))); });
  lastSelect.value = String(STAGES.length - 1); stageSelect.value = String(STAGES.length - 1);
  const applyProfile = (): void => {
    const profile = PROFILES[$<HTMLSelectElement>("evo-profile").value as ProfileId];
    const cores = navigator.hardwareConcurrency || 4, config = { ...DEFAULT_CONFIG, ...profile.config };
    $<HTMLInputElement>("evo-workers").value = String(profile.workers(cores));
    $<HTMLInputElement>("evo-pop").value = String(config.population); $<HTMLInputElement>("evo-battery").value = String(config.battery);
    $<HTMLInputElement>("evo-layer").value = String(config.layerPerStage);
    $("evo-profile-note").textContent = profile.blurb;
  };
  $("evo-profile").addEventListener("change", applyProfile);
  $<HTMLSelectElement>("evo-profile").value = DEFAULT_PROFILE;
  applyProfile();
  $("evo-play").addEventListener("click", () => void play());
  $("evo-mode-headless").addEventListener("click", () => setMode("headless"));
  $("evo-mode-watch").addEventListener("click", () => setMode("watch"));
  $("evo-from").addEventListener("change", () => { $("evo-file-wrap").hidden = $<HTMLSelectElement>("evo-from").value !== "file"; });
  $("evo-resume").addEventListener("click", () => void resumeSaved());
  $("evo-save").addEventListener("click", () => { const s = currentState(); if (s) { void saveRun($<HTMLInputElement>("evo-name").value, s).then(() => setStatus("Saved in this browser.")); } else setStatus("Nothing to save yet."); });
  $("evo-import").addEventListener("click", () => $<HTMLInputElement>("evo-import-file").click());
  $<HTMLInputElement>("evo-import-file").addEventListener("change", (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importFile(f).catch((err) => setStatus(String(err.message ?? err))); });
  $<HTMLInputElement>("evo-poll").addEventListener("change", (e) => ((e.target as HTMLInputElement).checked ? startPolling() : stopPolling()));
  $("evo-export-best").addEventListener("click", () => {
    const s = currentState();
    if (s && app.engine) { const best = app.engine.best(); download(`flykart-evolve-${$<HTMLInputElement>("evo-name").value}-best.json`, brainFile(best.brain, { fitness: s.champion?.score ?? 0, generation: s.generation, label: best.label, run: $<HTMLInputElement>("evo-name").value })); }
    else if (app.viewOnly) { const name = $<HTMLInputElement>("evo-name").value; void fetch(`./runs/${name}/best-brain.json`).then((r) => r.text()).then((t) => download(`flykart-evolve-${name}-best.json`, t)); }
  });
  $("evo-export-48").addEventListener("click", () => {
    const s = currentState();
    if (s && app.engine) { const best = app.engine.best(); download(`flykart-evolve-${$<HTMLInputElement>("evo-name").value}-best-48.json`, brainFile48(best.brain, { fitness: s.champion?.score ?? 0, generation: s.generation, label: best.label, run: $<HTMLInputElement>("evo-name").value })); }
    else if (app.viewOnly) { const name = $<HTMLInputElement>("evo-name").value; void fetch(`./runs/${name}/best-brain-48.json`).then((r) => r.text()).then((t) => download(`flykart-evolve-${name}-best-48.json`, t)); }
  });
  $("evo-export-run").addEventListener("click", () => { const s = currentState(); if (s) download(`flykart-evolve-${$<HTMLInputElement>("evo-name").value}-run.json`, JSON.stringify(s)); });
  $("evo-final").addEventListener("click", () => void finalComparison());
  $("evo-gauntlet").addEventListener("click", () => void runGauntlet());
  $("w-run").addEventListener("click", () => void runWatch());
  $("w-next").addEventListener("click", () => { const el = $<HTMLInputElement>("w-seed"); el.value = String((Number(el.value) || 1) + 1); void runWatch(); });
  $("g-reroll").addEventListener("click", () => { gallerySeed += 5; renderGallery(); });
  $("g-3d").addEventListener("change", (e) => { const on = (e.target as HTMLInputElement).checked; $("g-3d-canvas").hidden = !on; if (on) show3d("apartment"); else gallery3d?.stop(); });
  $("evo-view-reset").addEventListener("click", () => { app.view = { ...DEFAULT_VIEW }; drawMap(); });
  // Landscape interaction.
  const land = $<HTMLCanvasElement>("evo-landscape");
  let dragging = false, moved = 0, lastX = 0, lastY = 0;
  land.addEventListener("pointerdown", (e) => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; land.setPointerCapture(e.pointerId); });
  land.addEventListener("pointermove", (e) => { if (!dragging) return; moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY); app.view.yaw += (e.clientX - lastX) * 0.01; app.view.pitch = Math.max(0.15, Math.min(1.45, app.view.pitch + (e.clientY - lastY) * 0.008)); lastX = e.clientX; lastY = e.clientY; drawMap(); });
  land.addEventListener("pointerup", (e) => {
    dragging = false;
    if (moved < 5) {
      const rect = land.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
      const hit = app.picks.map((p) => ({ p, d: Math.hypot(p.x - x, p.y - y) })).sort((a, b) => a.d - b.d)[0];
      if (hit && hit.d < 28) select(hit.p.id);
    }
  });
  land.addEventListener("wheel", (e) => { e.preventDefault(); app.view.zoom = Math.max(0.5, Math.min(3, app.view.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); drawMap(); }, { passive: false });
  window.setInterval(() => { if ($<HTMLInputElement>("evo-spin").checked && !dragging && (app.mode === "watch" || !app.running)) { app.view.yaw += 0.01; drawMap(); } }, 60);
  window.addEventListener("resize", () => { drawMap(); habitat3d?.resize(); gallery3d?.resize(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && app.running) void acquireKeepAwake(); });
  window.addEventListener("beforeunload", () => { const s = currentState(); if (s) { try { void saveRun($<HTMLInputElement>("evo-name").value, s); } catch { /* best effort */ } } });
  renderGallery(); renderNotes(); populateWatchBrains(); drawMap();
  void deleteRun; // exported for the console; not wired to a button on purpose
}

wire();
// Test hooks for the headless checks (no effect in normal use).
(window as unknown as { __evolve: unknown }).__evolve = { app, play, setMode, runWatch, select, finalComparison, runCase, ROBOT_PROFILE };
