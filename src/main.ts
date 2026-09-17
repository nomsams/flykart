import "./style.css";
import {
  BrainSnapshot, Car, MAX_TICKS, STEP, TAU, TRACK_WIDTH, SpikingNetwork, createNetworkPopulation,
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
let raceAccumulator = 0;
let lastFrameTime = performance.now();

function clearVisualTimer(): void {
  if (visualTimer !== undefined) { window.clearTimeout(visualTimer); visualTimer = undefined; }
}

function readInteger(input: HTMLInputElement, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(input.value, 10); const value = Number.isFinite(parsed) ? parsed : fallback; const safe = Math.max(min, Math.min(max, value));
  input.value = `${safe}`; return safe;
}

function setBusy(value: boolean): void {
  [ui.raceButton, ui.visualButton, ui.headlessButton, ui.resetButton, ui.saveButton, ui.loadButton].forEach((button) => { button.disabled = value; });
  ui.status.textContent = value ? "running" : "idle"; ui.status.className = value ? "status-dot running" : "status-dot idle";
}

function launchRace(): void {
  training = false; running = true; visualTraining = false; trainingPopulation = []; raceAccumulator = 0;
  fly = startPosition(); fly.color = "#74c0ff"; fly.name = "fly"; fly.isFly = true; fly.network = bestNetwork?.clone() ?? new SpikingNetwork(77);
  raceCars = [fly, ...[-1, 1, -2].map((lane, index) => { const car = startPosition(lane); car.position.x += index * 15; car.color = ["#f19a69", "#e9d26d", "#b48cff"][index]; car.name = `bot ${index + 1}`; return car; })];
  ui.mode.textContent = "RACE MODE"; ui.hint.textContent = bestNetwork ? "best trained fly pilot deployed" : "demo brain deployed — train to improve it"; setBusy(false);
}

function resetBrain(): void {
  bestNetwork = undefined; bestFitness = -Infinity; generation = 0; ui.generation.textContent = "0"; ui.fitness.textContent = "—"; ui.progress.textContent = "0%"; launchRace();
}

function saveBrain(): void {
  if (!bestNetwork) { ui.hint.textContent = "train a brain before saving a checkpoint"; return; }
  try { localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ fitness: bestFitness, generation, network: bestNetwork.toJSON() })); ui.hint.textContent = `checkpoint saved at generation ${generation}`; }
  catch (error) { ui.hint.textContent = error instanceof Error ? error.message : "could not save checkpoint"; }
}

function loadBrain(): void {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY); if (!raw) { ui.hint.textContent = "no saved checkpoint found"; return; }
    const saved = JSON.parse(raw) as { fitness?: unknown; generation?: unknown; network?: BrainSnapshot }; if (!saved.network) throw new Error("saved checkpoint is incomplete");
    bestNetwork = SpikingNetwork.fromJSON(saved.network); bestFitness = typeof saved.fitness === "number" && Number.isFinite(saved.fitness) ? saved.fitness : -Infinity;
    generation = typeof saved.generation === "number" && Number.isInteger(saved.generation) && saved.generation >= 0 ? saved.generation : 0;
    ui.generation.textContent = `${generation}`; ui.fitness.textContent = Number.isFinite(bestFitness) ? bestFitness.toFixed(1) : "—"; launchRace(); ui.hint.textContent = `checkpoint loaded from generation ${generation}`;
  } catch (error) { ui.hint.textContent = error instanceof Error ? error.message : "could not load checkpoint"; }
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
  if (fly) { ui.progress.textContent = `${Math.round(fly.progress * 100)}%`; ui.speed.textContent = fly.speed.toFixed(1); }
}

function makeTrainingCar(network: SpikingNetwork, lane = 0): Car { const car = startPosition(lane); car.network = network; car.color = "#8191aa"; car.isFly = true; return car; }

function trainPopulationStep(): void {
  const car = trainingPopulation[trainingIndex]; if (!car?.network) return;
  const cars = [car, ...trainingPopulation.filter((other) => other !== car)]; car.action = car.network.step(sensorValues(car, cars)); stepCar(car, car.action, cars);
  if (car.crashed || car.ticks >= MAX_TICKS) { trainingIndex += 1; if (trainingIndex >= trainingPopulation.length) finishVisualGeneration(); }
}

function startVisualGeneration(): void { trainingPopulation = trainingNetworks.map((network, index) => makeTrainingCar(network, (index % 3) - 1)); trainingIndex = 0; trainingPopulation[0]?.network?.reset(); }

function breed(): void {
  const ranked = [...trainingNetworks].map((network, index) => ({ network, score: trainingPopulation[index]?.score ?? -Infinity })).sort((a, b) => b.score - a.score);
  const eliteCount = Math.max(2, Math.floor(ranked.length * 0.2)); bestNetwork = ranked[0].network.clone(); bestFitness = ranked[0].score; generation = trainingGeneration;
  ui.generation.textContent = `${generation}`; ui.fitness.textContent = bestFitness.toFixed(1); ui.progress.textContent = `${Math.round((trainingPopulation.find((car) => car.network === ranked[0].network)?.progress ?? 0) * 100)}%`;
  trainingNetworks = ranked.map((entry, index) => index < eliteCount ? entry.network.clone() : ranked[index % eliteCount].network.mutate(0.12, 0.22, generation * 1000 + index));
}

function finishVisualGeneration(): void { breed(); if (trainingGeneration >= readInteger(ui.generations, 100, 1, 10000)) finishTraining(); else { trainingGeneration += 1; startVisualGeneration(); } }

async function runHeadless(): Promise<void> {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = false; trainingGeneration = 1; setBusy(true);
  const populationSize = readInteger(ui.population, 24, 4, 80); const requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingNetworks = createNetworkPopulation(populationSize);
  try {
    for (; trainingGeneration <= requestedGenerations && training && trainingSession === session; trainingGeneration += 1) {
      trainingPopulation = trainingNetworks.map((network) => makeTrainingCar(network));
      for (const car of trainingPopulation) { if (!training || trainingSession !== session) return; const result = evaluate(car.network as SpikingNetwork); car.score = result.fitness; car.progress = result.progress; await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
      breed();
    }
    if (training && trainingSession === session) finishTraining();
  } catch (error) { if (training && trainingSession === session) failTraining(error); }
}

function startVisualTraining(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; trainingGeneration = 1; setBusy(true);
  trainingNetworks = createNetworkPopulation(readInteger(ui.population, 24, 4, 80)); startVisualGeneration(); ui.mode.textContent = "VISUAL TRAINING"; ui.hint.textContent = "watching candidate controllers learn"; scheduleVisualBatch(session);
}

function scheduleVisualBatch(session: number): void {
  if (!visualTraining || trainingSession !== session) return;
  try { for (let index = 0; index < 24 && visualTraining; index += 1) trainPopulationStep(); }
  catch (error) { if (trainingSession === session) failTraining(error); return; }
  visualTimer = window.setTimeout(() => scheduleVisualBatch(session), 16);
}

function finishTraining(): void { training = false; visualTraining = false; clearVisualTimer(); trainingPopulation = []; setBusy(false); launchRace(); ui.hint.textContent = `training complete — best fitness ${bestFitness.toFixed(1)}`; }
function failTraining(error: unknown): void { training = false; visualTraining = false; clearVisualTimer(); trainingPopulation = []; setBusy(false); ui.mode.textContent = "TRAINING ERROR"; ui.hint.textContent = error instanceof Error ? error.message : "unknown training error"; console.error("FlyKart training failed", error); }
function stopAll(): void { trainingSession += 1; training = false; visualTraining = false; running = false; clearVisualTimer(); trainingPopulation = []; setBusy(false); ui.mode.textContent = "PAUSED"; ui.hint.textContent = "press Start race or train again"; }

ui.raceButton.addEventListener("click", launchRace); ui.visualButton.addEventListener("click", startVisualTraining); ui.headlessButton.addEventListener("click", () => { void runHeadless(); }); ui.stopButton.addEventListener("click", stopAll); ui.resetButton.addEventListener("click", resetBrain); ui.saveButton.addEventListener("click", saveBrain); ui.loadButton.addEventListener("click", loadBrain);

function frame(now: number): void {
  const elapsed = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000)); lastFrameTime = now;
  if (running && !training) { raceAccumulator += elapsed; let steps = 0; while (raceAccumulator >= STEP && steps < 8) { updateRace(); raceAccumulator -= STEP; steps += 1; } if (steps === 8) raceAccumulator = 0; }
  render(); requestAnimationFrame(frame);
}

launchRace(); requestAnimationFrame(frame);
