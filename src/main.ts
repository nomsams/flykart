import "./style.css";
import {
  BrainSnapshot, Car, MAX_TICKS, STEP, TAU, TRACK_WIDTH, SpikingNetwork, clamp, createNetworkPopulation,
  evaluate, heuristicAction, sensorValues, startPosition, stepCar, track,
} from "./core";

const WIDTH = 960;
const HEIGHT = 600;
const MODEL_STORAGE_KEY = "flykart.best-brain.v1";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("Game canvas is missing");
const context = canvas.getContext("2d")!;
if (!context) throw new Error("Canvas rendering is unavailable");

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
}

const ui = {
  raceButton: required<HTMLButtonElement>("#race-btn"), visualButton: required<HTMLButtonElement>("#visual-train-btn"),
  headlessButton: required<HTMLButtonElement>("#headless-train-btn"), stopButton: required<HTMLButtonElement>("#stop-btn"),
  resetButton: required<HTMLButtonElement>("#reset-btn"), saveButton: required<HTMLButtonElement>("#save-btn"), loadButton: required<HTMLButtonElement>("#load-btn"),
  population: required<HTMLInputElement>("#population"), generations: required<HTMLInputElement>("#generations"),
  mode: required<HTMLElement>("#mode-label"), hint: required<HTMLElement>("#hint-label"), status: required<HTMLElement>("#training-status"),
  generation: required<HTMLElement>("#generation"), fitness: required<HTMLElement>("#fitness"), progress: required<HTMLElement>("#progress"),
  speed: required<HTMLElement>("#speed"), bars: required<HTMLElement>("#neural-bars"),
  runState: required<HTMLElement>("#run-state"), runDetail: required<HTMLElement>("#run-detail"),
  runProgressTrack: required<HTMLElement>("#run-progress-track"), runProgressBar: required<HTMLElement>("#run-progress-bar"),
  runProgressText: required<HTMLElement>("#run-progress-text"), runStepText: required<HTMLElement>("#run-step-text"),
  runElapsed: required<HTMLElement>("#run-elapsed"), eventLog: required<HTMLOListElement>("#event-log"),
};
const bars = Array.from({ length: 16 }, () => document.createElement("i"));
bars.forEach((bar) => ui.bars.appendChild(bar));

let bestNetwork: SpikingNetwork | undefined;
let bestFitness = -Infinity;
let generation = 0;
let raceCars: Car[] = [];
let fly: Car | undefined;
let running = false;
let training = false;
let visualTraining = false;
let trainingPopulation: Car[] = [];
let trainingIndex = 0;
let trainingGeneration = 0;
let trainingNetworks: SpikingNetwork[] = [];
let visualTimer: number | undefined;
let trainingSession = 0;
let trainingPopulationSize = 0;
let requestedGenerations = 0;
let runStartedAt: number | undefined;
let raceAccumulator = 0;
let lastFrameTime = performance.now();

type StatusTone = "idle" | "ready" | "running" | "paused" | "error";

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function setStatusTone(tone: StatusTone): void {
  ui.status.className = `status-dot ${tone}`;
  ui.status.textContent = tone;
}

function appendEvent(message: string): void {
  const item = document.createElement("li");
  item.textContent = `${runStartedAt === undefined ? "--:--" : formatDuration(performance.now() - runStartedAt)}  ${message}`;
  ui.eventLog.appendChild(item);
  while (ui.eventLog.children.length > 8) ui.eventLog.firstElementChild?.remove();
  ui.eventLog.scrollTop = ui.eventLog.scrollHeight;
}

function setProgress(fraction: number, label: string, step = "fixed 30 Hz simulator"): void {
  const percent = Math.round(clamp(fraction, 0, 1) * 100);
  ui.runProgressBar.style.width = `${percent}%`;
  ui.runProgressTrack.setAttribute("aria-valuenow", `${percent}`);
  ui.runProgressText.textContent = `${percent}% · ${label}`;
  ui.runStepText.textContent = step;
}

function setRunState(mode: string, detail: string, tone: StatusTone, canvasMode = mode): void {
  ui.mode.textContent = canvasMode;
  ui.hint.textContent = detail;
  ui.runState.textContent = mode;
  ui.runDetail.textContent = detail;
  setStatusTone(tone);
}

function beginRun(mode: string, detail: string, canvasMode = mode): void {
  runStartedAt = performance.now();
  setRunState(mode, detail, "running", canvasMode);
  setProgress(0, "starting…");
  appendEvent(`${mode} started`);
}

function updateElapsed(): void {
  if (runStartedAt !== undefined && (training || running)) ui.runElapsed.textContent = formatDuration(performance.now() - runStartedAt);
}

function clearVisualTimer(): void {
  if (visualTimer !== undefined) { window.clearTimeout(visualTimer); visualTimer = undefined; }
}

function readInteger(input: HTMLInputElement, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(input.value, 10); const value = Number.isFinite(parsed) ? parsed : fallback; const safe = Math.max(min, Math.min(max, value));
  input.value = `${safe}`; return safe;
}

function setBusy(value: boolean): void {
  [ui.raceButton, ui.visualButton, ui.headlessButton, ui.resetButton, ui.saveButton, ui.loadButton].forEach((button) => { button.disabled = value; });
  ui.stopButton.disabled = !(value || running);
}

function launchRace(): void {
  training = false; running = true; visualTraining = false; trainingPopulation = []; raceAccumulator = 0; runStartedAt = performance.now();
  fly = startPosition(); fly.color = "#74c0ff"; fly.name = "fly"; fly.isFly = true; fly.network = bestNetwork?.clone() ?? new SpikingNetwork(77);
  raceCars = [fly, ...[-1, 1, -2].map((lane, index) => { const car = startPosition(lane); car.position.x += index * 15; car.color = ["#f19a69", "#e9d26d", "#b48cff"][index]; car.name = `bot ${index + 1}`; return car; })];
  const detail = bestNetwork ? "best trained fly pilot deployed against three heuristic bots" : "demo brain deployed — train a controller to improve it";
  setRunState("Racing", detail, "running", "RACE MODE");
  setProgress(0, "lap 0%", "fixed 30 Hz simulator · press Stop to pause");
  appendEvent("race started · fly pilot and three bots are on the track");
  setBusy(false);
}

function resetBrain(): void {
  bestNetwork = undefined; bestFitness = -Infinity; generation = 0; ui.generation.textContent = "0"; ui.fitness.textContent = "—"; ui.progress.textContent = "0%";
  appendEvent("controller reset; returning to demo brain"); launchRace();
}

function saveBrain(): void {
  if (!bestNetwork) { setRunState("No checkpoint", "Train a brain before saving a checkpoint.", "paused", "RACE MODE"); appendEvent("save skipped: no trained controller yet"); return; }
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ fitness: bestFitness, generation, network: bestNetwork.toJSON() }));
    const detail = `checkpoint saved at generation ${generation} with fitness ${bestFitness.toFixed(1)}`;
    setRunState("Checkpoint saved", detail, "ready", "RACE MODE"); appendEvent(detail);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "could not save checkpoint";
    setRunState("Save error", detail, "error", "RACE MODE"); appendEvent(`save failed: ${detail}`);
  }
}

function loadBrain(): void {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY); if (!raw) { setRunState("No checkpoint", "No saved controller was found in this browser.", "paused", "RACE MODE"); appendEvent("load skipped: no checkpoint found"); return; }
    const saved = JSON.parse(raw) as { fitness?: unknown; generation?: unknown; network?: BrainSnapshot }; if (!saved.network) throw new Error("saved checkpoint is incomplete");
    bestNetwork = SpikingNetwork.fromJSON(saved.network); bestFitness = typeof saved.fitness === "number" && Number.isFinite(saved.fitness) ? saved.fitness : -Infinity;
    generation = typeof saved.generation === "number" && Number.isInteger(saved.generation) && saved.generation >= 0 ? saved.generation : 0;
    ui.generation.textContent = `${generation}`; ui.fitness.textContent = Number.isFinite(bestFitness) ? bestFitness.toFixed(1) : "—"; launchRace();
    const detail = `checkpoint loaded from generation ${generation}; fly pilot is ready`;
    setRunState("Checkpoint loaded", detail, "ready", "RACE MODE"); appendEvent(detail);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "could not load checkpoint";
    setRunState("Load error", detail, "error", "RACE MODE"); appendEvent(`load failed: ${detail}`);
  }
}

function renderTrack(): void {
  context.save(); context.translate(WIDTH / 2, HEIGHT / 2); context.fillStyle = "#111a1c"; context.fillRect(-WIDTH / 2, -HEIGHT / 2, WIDTH, HEIGHT); context.lineJoin = "round"; context.lineCap = "round";
  const drawPath = () => { context.beginPath(); track.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)); context.closePath(); };
  drawPath(); context.strokeStyle = "#38454b"; context.lineWidth = TRACK_WIDTH + 14; context.stroke(); drawPath(); context.strokeStyle = "#18272b"; context.lineWidth = TRACK_WIDTH; context.stroke();
  drawPath(); context.strokeStyle = "#5a6c67"; context.lineWidth = 2; context.setLineDash([12, 12]); context.stroke(); context.setLineDash([]);
  const start = track[0]; context.strokeStyle = "#9ed5ff"; context.lineWidth = 5; context.beginPath(); context.moveTo(start.x, start.y - 28); context.lineTo(start.x, start.y + 28); context.stroke();
  for (let index = 0; index < track.length; index += 2) { const marker = track[index]; context.fillStyle = "#7aa18c"; context.globalAlpha = 0.28; context.beginPath(); context.arc(marker.x, marker.y, 3, 0, TAU); context.fill(); }
  context.restore();
}

function drawCar(car: Car, alpha = 1): void {
  context.save(); context.translate(WIDTH / 2 + car.position.x, HEIGHT / 2 + car.position.y); context.rotate(car.heading); context.globalAlpha = alpha;
  context.fillStyle = "rgba(0,0,0,.35)"; context.beginPath(); context.ellipse(2, 3, 15, 8, 0, 0, TAU); context.fill(); context.fillStyle = car.color; context.fillRect(-12, -7, 24, 14); context.fillStyle = "#d8e4ed"; context.fillRect(2, -5, 7, 10); context.fillStyle = "#0e1419"; context.fillRect(-9, -9, 6, 3); context.fillRect(-9, 6, 6, 3);
  if (car.isFly) { context.strokeStyle = "#b6e0ff"; context.lineWidth = 1.5; context.beginPath(); context.arc(-1, -11, 7, Math.PI, TAU); context.stroke(); context.fillStyle = "#d7efff"; context.beginPath(); context.arc(-3, 0, 3, 0, TAU); context.fill(); }
  context.restore();
  if (car.trail.length > 1) { context.save(); context.translate(WIDTH / 2, HEIGHT / 2); context.strokeStyle = car.color; context.globalAlpha = alpha * 0.2; context.lineWidth = 2; context.beginPath(); car.trail.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)); context.stroke(); context.restore(); }
}

function updateNeural(network: SpikingNetwork | undefined): void {
  const activity = network?.activity().spikes ?? []; bars.forEach((bar, index) => { bar.style.height = `${Math.max(6, (activity[index * 3] ?? 0) * 100)}%`; });
}

function render(): void {
  context.clearRect(0, 0, WIDTH, HEIGHT); renderTrack(); trainingPopulation.forEach((car) => drawCar(car, 0.18)); raceCars.forEach((car) => drawCar(car));
  if (training && trainingPopulation[trainingIndex]) drawCar(trainingPopulation[trainingIndex], 0.9); updateNeural(fly?.network ?? trainingPopulation[trainingIndex]?.network);
}

function updateRace(): void {
  if (!running || training) return;
  raceCars.forEach((car) => { const action = car.isFly && car.network ? car.network.step(sensorValues(car, raceCars)) : heuristicAction(car, raceCars); car.action = action; stepCar(car, action, raceCars); });
  if (fly) {
    const lapPercent = Math.round(fly.progress * 100);
    ui.progress.textContent = `${lapPercent}%`;
    ui.speed.textContent = fly.speed.toFixed(1);
    setProgress(fly.progress, `lap ${lapPercent}%`, `speed ${fly.speed.toFixed(1)} · collisions ${fly.collisions}`);
  }
}

function makeTrainingCar(network: SpikingNetwork, lane = 0): Car { const car = startPosition(lane); car.network = network; car.color = "#8191aa"; car.isFly = true; return car; }

function trainPopulationStep(): void {
  const car = trainingPopulation[trainingIndex]; if (!car?.network) return;
  const cars = [car, ...trainingPopulation.filter((other) => other !== car)]; car.action = car.network.step(sensorValues(car, cars)); stepCar(car, car.action, cars);
  const totalCandidates = Math.max(1, trainingPopulationSize * requestedGenerations);
  const completedCandidates = (trainingGeneration - 1) * trainingPopulationSize + trainingIndex;
  const candidateFraction = car.ticks / MAX_TICKS;
  setProgress((completedCandidates + candidateFraction) / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex + 1}/${trainingPopulationSize}`, `visual · tick ${car.ticks}/${MAX_TICKS} · candidate progress ${Math.round(car.progress * 100)}%`);
  if (car.crashed || car.ticks >= MAX_TICKS) {
    appendEvent(`candidate ${trainingIndex + 1}/${trainingPopulationSize} finished · fitness ${car.score.toFixed(1)}${car.crashed ? " · crashed" : ""}`);
    trainingIndex += 1;
    if (trainingIndex >= trainingPopulation.length) finishVisualGeneration();
  }
}

function startVisualGeneration(): void {
  trainingPopulation = trainingNetworks.map((network, index) => makeTrainingCar(network, (index % 3) - 1));
  trainingIndex = 0;
  trainingPopulation.forEach((car) => car.network?.reset());
  setProgress(((trainingGeneration - 1) * trainingPopulationSize) / Math.max(1, trainingPopulationSize * requestedGenerations), `generation ${trainingGeneration}/${requestedGenerations} · candidate 1/${trainingPopulationSize}`, "visual · preparing candidate");
}

function breed(): void {
  const ranked = [...trainingNetworks].map((network, index) => ({ network, score: trainingPopulation[index]?.score ?? -Infinity })).sort((a, b) => b.score - a.score);
  const eliteCount = Math.max(2, Math.floor(ranked.length * 0.2)); bestNetwork = ranked[0].network.clone(); bestFitness = ranked[0].score; generation = trainingGeneration;
  ui.generation.textContent = `${generation}`; ui.fitness.textContent = bestFitness.toFixed(1); ui.progress.textContent = `${Math.round((trainingPopulation.find((car) => car.network === ranked[0].network)?.progress ?? 0) * 100)}%`;
  appendEvent(`generation ${trainingGeneration} complete · best fitness ${bestFitness.toFixed(1)} · breeding ${ranked.length - eliteCount} mutations`);
  trainingNetworks = ranked.map((entry, index) => index < eliteCount ? entry.network.clone() : ranked[index % eliteCount].network.mutate(0.12, 0.22, generation * 1000 + index));
}

function finishVisualGeneration(): void { breed(); if (trainingGeneration >= requestedGenerations) finishTraining(); else { trainingGeneration += 1; startVisualGeneration(); } }

async function runHeadless(): Promise<void> {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = false; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 24, 4, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingNetworks = createNetworkPopulation(trainingPopulationSize);
  beginRun("Headless training", `Evaluating ${trainingPopulationSize} controllers across ${requestedGenerations} generations. The browser is yielding between candidates so this page stays responsive.`, "HEADLESS TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—";
  try {
    for (; trainingGeneration <= requestedGenerations && training && trainingSession === session; trainingGeneration += 1) {
      trainingPopulation = trainingNetworks.map((network) => makeTrainingCar(network));
      trainingIndex = 0;
      setRunState("Headless training", `Generation ${trainingGeneration}/${requestedGenerations}: evaluating candidate controllers without drawing each simulation step.`, "running", "HEADLESS TRAINING");
      for (const [index, car] of trainingPopulation.entries()) {
        if (!training || trainingSession !== session) return;
        trainingIndex = index;
        const totalCandidates = Math.max(1, trainingPopulationSize * requestedGenerations);
        const startedCandidates = (trainingGeneration - 1) * trainingPopulationSize + index;
        setProgress(startedCandidates / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${index + 1}/${trainingPopulationSize}`, "headless · evaluating deterministic simulator…");
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const result = evaluate(car.network as SpikingNetwork); car.score = result.fitness; car.progress = result.progress;
        trainingIndex = index + 1;
        const completedCandidates = (trainingGeneration - 1) * trainingPopulationSize + trainingIndex;
        ui.fitness.textContent = result.fitness.toFixed(1);
        ui.progress.textContent = `${Math.round(result.progress * 100)}%`;
        setProgress(completedCandidates / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex}/${trainingPopulationSize}`, `headless · ${result.ticks} simulator ticks · fitness ${result.fitness.toFixed(1)}`);
        if (index === 0 || index === trainingPopulation.length - 1 || (index + 1) % Math.max(1, Math.floor(trainingPopulationSize / 4)) === 0) appendEvent(`generation ${trainingGeneration}: candidate ${index + 1}/${trainingPopulationSize} scored ${result.fitness.toFixed(1)}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      breed();
    }
    if (training && trainingSession === session) finishTraining();
  } catch (error) { if (training && trainingSession === session) failTraining(error); }
}

function startVisualTraining(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 24, 4, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingNetworks = createNetworkPopulation(trainingPopulationSize);
  beginRun("Visual training", `Watching ${trainingPopulationSize} candidates drive one at a time across ${requestedGenerations} generations.`, "VISUAL TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function scheduleVisualBatch(session: number): void {
  if (!visualTraining || trainingSession !== session) return;
  try { for (let index = 0; index < 24 && visualTraining; index += 1) trainPopulationStep(); }
  catch (error) { if (trainingSession === session) failTraining(error); return; }
  visualTimer = window.setTimeout(() => scheduleVisualBatch(session), 16);
}

function finishTraining(): void {
  training = false; visualTraining = false; clearVisualTimer(); trainingPopulation = []; setBusy(false); launchRace();
  const detail = `training complete — best fitness ${bestFitness.toFixed(1)} at generation ${generation}; the trained fly is now racing`;
  setRunState("Training complete", detail, "ready", "RACE MODE"); setProgress(1, "100% · complete", "trained controller deployed in race mode"); appendEvent(detail);
}

function failTraining(error: unknown): void {
  training = false; visualTraining = false; clearVisualTimer(); trainingPopulation = []; setBusy(false);
  const detail = error instanceof Error ? error.message : "unknown training error";
  setRunState("Training error", detail, "error", "TRAINING ERROR"); appendEvent(`training failed: ${detail}`); console.error("FlyKart training failed", error);
}

function stopAll(): void {
  trainingSession += 1; const wasTraining = training; training = false; visualTraining = false; running = false; clearVisualTimer(); trainingPopulation = []; setBusy(false);
  const detail = wasTraining ? "training stopped before completion; the best controller found so far is kept" : "race paused; press Start race or train again to continue";
  setRunState("Paused", detail, "paused", "PAUSED"); appendEvent(wasTraining ? "training stopped by user" : "race paused by user");
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" ? error : "unknown application error"; }

function failApplication(error: unknown): void {
  trainingSession += 1; training = false; visualTraining = false; running = false; clearVisualTimer(); trainingPopulation = []; setBusy(false);
  const detail = describeError(error);
  setRunState("Application error", `${detail} Refresh the page and try again.`, "error", "APPLICATION ERROR"); appendEvent(`error: ${detail}`); console.error("FlyKart application error", error);
}

function safely(action: () => void): void { try { action(); } catch (error) { failApplication(error); } }

ui.raceButton.addEventListener("click", () => safely(launchRace));
ui.visualButton.addEventListener("click", () => safely(startVisualTraining));
ui.headlessButton.addEventListener("click", () => { void runHeadless(); });
ui.stopButton.addEventListener("click", () => safely(stopAll));
ui.resetButton.addEventListener("click", () => safely(resetBrain));
ui.saveButton.addEventListener("click", () => safely(saveBrain));
ui.loadButton.addEventListener("click", () => safely(loadBrain));
window.addEventListener("error", (event) => { if (event.error) failApplication(event.error); });
window.addEventListener("unhandledrejection", (event) => { failApplication(event.reason); });

function frame(now: number): void {
  const elapsed = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000)); lastFrameTime = now;
  if (running && !training) { raceAccumulator += elapsed; let steps = 0; while (raceAccumulator >= STEP && steps < 8) { updateRace(); raceAccumulator -= STEP; steps += 1; } if (steps === 8) raceAccumulator = 0; }
  updateElapsed(); render(); requestAnimationFrame(frame);
}

try {
  launchRace();
  setRunState("Ready to race", "The demo brain is driving now. Choose a training mode to evolve a better fly pilot.", "ready", "RACE MODE");
  appendEvent("application ready · choose a command to begin");
  window.dispatchEvent(new Event("flykart:ready"));
  requestAnimationFrame(frame);
} catch (error) {
  failApplication(error);
}
