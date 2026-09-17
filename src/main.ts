import "./style.css";
import {
  BrainSnapshot, Car, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, RewardConfig, STEP, TAU, TRACKS, TrackDefinition,
  SpikingNetwork, clamp, createNetworkPopulation, evaluateGeneralist, heuristicAction, resolveTrack, sensorValues, startLine, startPosition, stepCar,
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
  trackSelect: required<HTMLSelectElement>("#track-select"),
  rewardProgress: required<HTMLInputElement>("#reward-progress"), rewardDirection: required<HTMLInputElement>("#reward-direction"), rewardMoving: required<HTMLInputElement>("#reward-moving"),
  rewardStanding: required<HTMLInputElement>("#reward-standing"), rewardWrong: required<HTMLInputElement>("#reward-wrong"), rewardReverse: required<HTMLInputElement>("#reward-reverse"),
  rewardOffTrack: required<HTMLInputElement>("#reward-offtrack"), rewardCollision: required<HTMLInputElement>("#reward-collision"), rewardCrash: required<HTMLInputElement>("#reward-crash"), rewardFinish: required<HTMLInputElement>("#reward-finish"),
  mode: required<HTMLElement>("#mode-label"), hint: required<HTMLElement>("#hint-label"), status: required<HTMLElement>("#training-status"),
  generation: required<HTMLElement>("#generation"), fitness: required<HTMLElement>("#fitness"), progress: required<HTMLElement>("#progress"),
  speed: required<HTMLElement>("#speed"), reward: required<HTMLElement>("#reward"), direction: required<HTMLElement>("#direction"), penalties: required<HTMLElement>("#penalties"), bars: required<HTMLElement>("#neural-bars"),
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
let trainingTracks: TrackDefinition[] = [DEFAULT_TRACK];
let trainingScores: number[] = [];
let trainingProgresses: number[] = [];
let trainingTrackIndex = 0;
let visualTimer: number | undefined;
let trainingSession = 0;
let trainingPopulationSize = 0;
let requestedGenerations = 0;
let rewardConfig: RewardConfig = { ...DEFAULT_REWARD_CONFIG };
let activeTrack: TrackDefinition = DEFAULT_TRACK;
let flyFinishAnnounced = false;
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

function readNumber(input: HTMLInputElement, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(input.value); const value = Number.isFinite(parsed) ? parsed : fallback; const safe = Math.max(min, Math.min(max, value));
  input.value = `${safe}`; return safe;
}

function readRewardConfig(): RewardConfig {
  rewardConfig = {
    progressPerSecond: readNumber(ui.rewardProgress, DEFAULT_REWARD_CONFIG.progressPerSecond, 0, 100),
    correctDirectionPerSecond: readNumber(ui.rewardDirection, DEFAULT_REWARD_CONFIG.correctDirectionPerSecond, 0, 20),
    movementPerSecond: readNumber(ui.rewardMoving, DEFAULT_REWARD_CONFIG.movementPerSecond, 0, 20),
    standingStillPerSecond: readNumber(ui.rewardStanding, DEFAULT_REWARD_CONFIG.standingStillPerSecond, 0, 20),
    wrongDirectionPerSecond: readNumber(ui.rewardWrong, DEFAULT_REWARD_CONFIG.wrongDirectionPerSecond, 0, 30),
    reverseProgressPerSecond: readNumber(ui.rewardReverse, DEFAULT_REWARD_CONFIG.reverseProgressPerSecond, 0, 30),
    offTrackPerSecond: readNumber(ui.rewardOffTrack, DEFAULT_REWARD_CONFIG.offTrackPerSecond, 0, 30),
    collision: readNumber(ui.rewardCollision, DEFAULT_REWARD_CONFIG.collision, 0, 100),
    crash: readNumber(ui.rewardCrash, DEFAULT_REWARD_CONFIG.crash, 0, 200),
    finish: readNumber(ui.rewardFinish, DEFAULT_REWARD_CONFIG.finish, 0, 1000),
  };
  return rewardConfig;
}

function selectedTracks(): TrackDefinition[] {
  if (ui.trackSelect.value === "all") return [...TRACKS];
  return [resolveTrack(ui.trackSelect.value as TrackDefinition["id"] )];
}

function selectedTrackLabel(): string {
  return ui.trackSelect.value === "all" ? "all track types" : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]).name;
}

function updateRewardTelemetry(car: Car | undefined): void {
  if (!car) return;
  const breakdown = car.rewardBreakdown;
  const penalty = breakdown.standingStill + breakdown.wrongDirection + breakdown.reverseProgress + breakdown.offTrack + breakdown.collision + breakdown.crash;
  ui.reward.textContent = car.lastReward.toFixed(2);
  ui.direction.textContent = `${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`;
  ui.penalties.textContent = `-${penalty.toFixed(2)}`;
}

function setBusy(value: boolean): void {
  [ui.raceButton, ui.visualButton, ui.headlessButton, ui.resetButton, ui.saveButton, ui.loadButton].forEach((button) => { button.disabled = value; });
  [ui.trackSelect, ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardCollision, ui.rewardCrash, ui.rewardFinish].forEach((input) => { input.disabled = value; });
  ui.stopButton.disabled = !(value || running);
}

function launchRace(): void {
  training = false; running = true; visualTraining = false; trainingPopulation = []; raceAccumulator = 0; runStartedAt = performance.now(); flyFinishAnnounced = false;
  activeTrack = ui.trackSelect.value === "all" ? DEFAULT_TRACK : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]);
  rewardConfig = readRewardConfig();
  fly = startPosition(0, activeTrack); fly.color = "#74c0ff"; fly.name = "fly"; fly.isFly = true; fly.network = bestNetwork?.clone() ?? new SpikingNetwork(77);
  raceCars = [fly, ...[-1, 1, -2].map((lane, index) => { const car = startPosition(lane, activeTrack); car.color = ["#f19a69", "#e9d26d", "#b48cff"][index]; car.name = `bot ${index + 1}`; return car; })];
  const detail = bestNetwork ? `best trained fly pilot deployed on ${activeTrack.name} against three heuristic bots` : `demo brain deployed on ${activeTrack.name} — train a controller to improve it`;
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
  const drawPath = () => { context.beginPath(); activeTrack.points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)); context.closePath(); };
  drawPath(); context.strokeStyle = "#38454b"; context.lineWidth = activeTrack.width + 14; context.stroke(); drawPath(); context.strokeStyle = "#18272b"; context.lineWidth = activeTrack.width; context.stroke();
  drawPath(); context.strokeStyle = "#5a6c67"; context.lineWidth = 2; context.setLineDash([12, 12]); context.stroke(); context.setLineDash([]);
  const line = startLine(activeTrack); const lineOffset = activeTrack.width / 2 + 7; const startA = addCanvasPoint(line.point, { x: line.normal.x * lineOffset, y: line.normal.y * lineOffset }); const startB = addCanvasPoint(line.point, { x: -line.normal.x * lineOffset, y: -line.normal.y * lineOffset });
  context.strokeStyle = "#9ed5ff"; context.lineWidth = 5; context.beginPath(); context.moveTo(startA.x, startA.y); context.lineTo(startB.x, startB.y); context.stroke();
  for (let index = 0; index < activeTrack.points.length; index += 2) { const marker = activeTrack.points[index]; context.fillStyle = "#7aa18c"; context.globalAlpha = 0.28; context.beginPath(); context.arc(marker.x, marker.y, 3, 0, TAU); context.fill(); }
  context.restore();
}

function addCanvasPoint(point: { x: number; y: number }, offset: { x: number; y: number }): { x: number; y: number } { return { x: point.x + offset.x, y: point.y + offset.y }; }

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
  context.clearRect(0, 0, WIDTH, HEIGHT); renderTrack(); trainingPopulation.filter((car) => car.trackId === activeTrack.id).forEach((car) => drawCar(car, 0.18)); raceCars.forEach((car) => drawCar(car));
  if (training && trainingPopulation[trainingIndex]) drawCar(trainingPopulation[trainingIndex], 0.9); updateRewardTelemetry(fly ?? trainingPopulation[trainingIndex]); updateNeural(fly?.network ?? trainingPopulation[trainingIndex]?.network);
}

function updateRace(): void {
  if (!running || training) return;
  raceCars.forEach((car) => { const action = car.isFly && car.network ? car.network.step(sensorValues(car, raceCars, activeTrack)) : heuristicAction(car, raceCars); car.action = action; stepCar(car, action, raceCars, activeTrack, rewardConfig); });
  if (fly) {
    const lapPercent = Math.round(fly.progress * 100);
    ui.progress.textContent = `${lapPercent}%`;
    ui.speed.textContent = fly.speed.toFixed(1);
    updateRewardTelemetry(fly);
    if (!fly.finished) setProgress(fly.progress, `lap ${lapPercent}%`, `speed ${fly.speed.toFixed(1)} · collisions ${fly.collisions}`);
    if (fly.finished && !flyFinishAnnounced) {
      flyFinishAnnounced = true;
      setRunState("Finish line crossed", `Fly pilot completed a lap on ${activeTrack.name} with reward ${fly.score.toFixed(1)}.`, "ready", "FINISH");
      setProgress(1, "100% · lap complete", "finish reward applied · press Start race to run again");
      appendEvent(`finish line crossed on ${activeTrack.name} · lap reward ${rewardConfig.finish.toFixed(1)}`);
    }
  }
}

function makeTrainingCar(network: SpikingNetwork, lane = 0, route: TrackDefinition = activeTrack): Car { network.reset(); const car = startPosition(lane, route); car.network = network; car.color = "#8191aa"; car.isFly = true; return car; }

function trainPopulationStep(): void {
  const car = trainingPopulation[trainingIndex]; if (!car?.network) return;
  const cars = [car]; car.action = car.network.step(sensorValues(car, cars, trainingTracks[trainingTrackIndex])); stepCar(car, car.action, cars, trainingTracks[trainingTrackIndex], rewardConfig);
  updateRewardTelemetry(car);
  const episodeCount = Math.max(1, trainingTracks.length); const totalEpisodes = Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations);
  const completedEpisodes = (trainingGeneration - 1) * trainingPopulationSize * episodeCount + trainingIndex * episodeCount + trainingTrackIndex;
  const candidateFraction = car.ticks / MAX_TICKS;
  const route = trainingTracks[trainingTrackIndex];
  setProgress((completedEpisodes + candidateFraction) / totalEpisodes, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex + 1}/${trainingPopulationSize} · ${route.name}`, `visual · tick ${car.ticks}/${MAX_TICKS} · direction ${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`);
  if (car.crashed || car.finished || car.ticks >= MAX_TICKS) {
    trainingScores[trainingIndex] += car.score;
    trainingProgresses[trainingIndex] += car.totalProgress;
    appendEvent(`candidate ${trainingIndex + 1}/${trainingPopulationSize} finished ${route.name} · fitness ${car.score.toFixed(1)}${car.finished ? " · finish line" : car.crashed ? " · crashed" : ""}`);
    if (trainingTrackIndex + 1 < trainingTracks.length) {
      trainingTrackIndex += 1; activeTrack = trainingTracks[trainingTrackIndex];
      trainingPopulation[trainingIndex] = makeTrainingCar(car.network, (trainingIndex % 3) - 1, trainingTracks[trainingTrackIndex]);
      setProgress((completedEpisodes + 1) / totalEpisodes, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex + 1}/${trainingPopulationSize} · ${trainingTracks[trainingTrackIndex].name}`, "visual · switching track episode");
    } else {
      car.score = trainingScores[trainingIndex] / trainingTracks.length; car.totalProgress = trainingProgresses[trainingIndex] / trainingTracks.length;
      trainingIndex += 1; trainingTrackIndex = 0;
      if (trainingIndex >= trainingPopulation.length) finishVisualGeneration();
    }
  }
}

function startVisualGeneration(): void {
  trainingTrackIndex = 0; activeTrack = trainingTracks[0]; trainingScores = trainingNetworks.map(() => 0); trainingProgresses = trainingNetworks.map(() => 0);
  trainingPopulation = trainingNetworks.map((network, index) => makeTrainingCar(network, (index % 3) - 1, trainingTracks[0]));
  trainingIndex = 0;
  trainingPopulation.forEach((car) => car.network?.reset());
  const episodeCount = Math.max(1, trainingTracks.length);
  setProgress(((trainingGeneration - 1) * trainingPopulationSize * episodeCount) / Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations), `generation ${trainingGeneration}/${requestedGenerations} · candidate 1/${trainingPopulationSize} · ${trainingTracks[0].name}`, "visual · preparing candidate");
}

function breed(): void {
  const ranked = [...trainingNetworks].map((network, index) => ({ network, score: trainingPopulation[index]?.score ?? -Infinity })).sort((a, b) => b.score - a.score);
  const eliteCount = Math.max(2, Math.floor(ranked.length * 0.2)); bestNetwork = ranked[0].network.clone(); bestFitness = ranked[0].score; generation = trainingGeneration;
  const winner = trainingPopulation.find((car) => car.network === ranked[0].network); ui.generation.textContent = `${generation}`; ui.fitness.textContent = bestFitness.toFixed(1); ui.progress.textContent = `${Math.round((winner?.totalProgress ?? winner?.progress ?? 0) * 100)}%`;
  appendEvent(`generation ${trainingGeneration} complete · best fitness ${bestFitness.toFixed(1)} · breeding ${ranked.length - eliteCount} mutations`);
  trainingNetworks = ranked.map((entry, index) => index < eliteCount ? entry.network.clone() : ranked[index % eliteCount].network.mutate(0.12, 0.22, generation * 1000 + index));
}

function finishVisualGeneration(): void { breed(); if (trainingGeneration >= requestedGenerations) finishTraining(); else { trainingGeneration += 1; startVisualGeneration(); } }

async function runHeadless(): Promise<void> {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = false; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 24, 4, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); activeTrack = trainingTracks[0]; trainingNetworks = createNetworkPopulation(trainingPopulationSize);
  beginRun("Headless training", `Evaluating ${trainingPopulationSize} controllers across ${requestedGenerations} generations on ${selectedTrackLabel()}.`, "HEADLESS TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—";
  try {
    for (; trainingGeneration <= requestedGenerations && training && trainingSession === session; trainingGeneration += 1) {
      trainingPopulation = trainingNetworks.map((network) => makeTrainingCar(network, 0, trainingTracks[0]));
      trainingIndex = 0;
      setRunState("Headless training", `Generation ${trainingGeneration}/${requestedGenerations}: evaluating each candidate across ${trainingTracks.length} track${trainingTracks.length === 1 ? "" : "s"}.`, "running", "HEADLESS TRAINING");
      for (const [index, car] of trainingPopulation.entries()) {
        if (!training || trainingSession !== session) return;
        trainingIndex = index;
        const totalCandidates = Math.max(1, trainingPopulationSize * requestedGenerations);
        const startedCandidates = (trainingGeneration - 1) * trainingPopulationSize + index;
        setProgress(startedCandidates / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${index + 1}/${trainingPopulationSize}`, `headless · ${trainingTracks.length} track${trainingTracks.length === 1 ? "" : "s"} · evaluating…`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const result = evaluateGeneralist(car.network as SpikingNetwork, trainingTracks, rewardConfig); car.score = result.fitness; car.progress = result.progress; car.totalProgress = result.progress; car.finished = result.finished; car.laps = result.laps; car.rewardTotals = result.rewardTotals; car.rewardBreakdown = result.rewardTotals; car.lastReward = 0; car.forwardAlignment = 0;
        trainingIndex = index + 1;
        const completedCandidates = (trainingGeneration - 1) * trainingPopulationSize + trainingIndex;
        ui.fitness.textContent = result.fitness.toFixed(1);
        ui.progress.textContent = `${Math.round(result.progress * 100)}%`;
        setProgress(completedCandidates / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex}/${trainingPopulationSize}`, `headless · ${result.ticks} ticks across ${result.episodes.length} track${result.episodes.length === 1 ? "" : "s"} · fitness ${result.fitness.toFixed(1)}`);
        updateRewardTelemetry(car);
        if (index === 0 || index === trainingPopulation.length - 1 || (index + 1) % Math.max(1, Math.floor(trainingPopulationSize / 4)) === 0) appendEvent(`generation ${trainingGeneration}: candidate ${index + 1}/${trainingPopulationSize} scored ${result.fitness.toFixed(1)} across ${result.episodes.length} tracks`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      breed();
    }
    if (training && trainingSession === session) finishTraining();
  } catch (error) { if (training && trainingSession === session) failTraining(error); }
}

function startVisualTraining(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 24, 4, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); activeTrack = trainingTracks[0]; trainingNetworks = createNetworkPopulation(trainingPopulationSize);
  beginRun("Visual training", `Watching ${trainingPopulationSize} candidates drive across ${requestedGenerations} generations on ${selectedTrackLabel()}.`, "VISUAL TRAINING");
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
ui.trackSelect.addEventListener("change", () => { if (!training) safely(launchRace); });
[ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardCollision, ui.rewardCrash, ui.rewardFinish].forEach((input) => {
  input.addEventListener("change", () => { rewardConfig = readRewardConfig(); appendEvent("reward settings updated · new weights apply immediately"); });
});
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
