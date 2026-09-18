import "./style.css";
import {
  BrainSnapshot, CAR_WIDTH, CHECKPOINT_COUNT, LANE_SPACING, Car, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, PhysicsConfig, RewardConfig, STEP, TAU, TRACKS, TrackDefinition, Vec,
  SpikingNetwork, clamp, evaluateGeneralist, heuristicAction, nearestTrack, pointAtDistance, resolveTrack, sensorValues, startLine, startPosition, stepCar, trackCheckpoint,
} from "./core";

const WIDTH = 960;
const HEIGHT = 600;
const MODEL_STORAGE_KEY = "flykart.best-brain.v1";
const CHECKPOINT_VERSION = 1;

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
  raceButton: required<HTMLButtonElement>("#race-btn"), driveButton: required<HTMLButtonElement>("#drive-btn"), visualButton: required<HTMLButtonElement>("#visual-train-btn"), evolveFiveButton: required<HTMLButtonElement>("#evolve-five-btn"),
  headlessButton: required<HTMLButtonElement>("#headless-train-btn"), stopButton: required<HTMLButtonElement>("#stop-btn"),
  resetButton: required<HTMLButtonElement>("#reset-btn"), saveButton: required<HTMLButtonElement>("#save-btn"), loadButton: required<HTMLButtonElement>("#load-btn"),
  exportButton: required<HTMLButtonElement>("#export-btn"), importButton: required<HTMLButtonElement>("#import-btn"), importFile: required<HTMLInputElement>("#import-file"),
  population: required<HTMLInputElement>("#population"), generations: required<HTMLInputElement>("#generations"),
  trackSelect: required<HTMLSelectElement>("#track-select"), wallsToggle: required<HTMLInputElement>("#walls-toggle"),
  rewardProgress: required<HTMLInputElement>("#reward-progress"), rewardDirection: required<HTMLInputElement>("#reward-direction"), rewardMoving: required<HTMLInputElement>("#reward-moving"),
  rewardStanding: required<HTMLInputElement>("#reward-standing"), rewardWrong: required<HTMLInputElement>("#reward-wrong"), rewardReverse: required<HTMLInputElement>("#reward-reverse"),
  rewardOffTrack: required<HTMLInputElement>("#reward-offtrack"), rewardEdge: required<HTMLInputElement>("#reward-edge"), rewardCenterline: required<HTMLInputElement>("#reward-centerline"), rewardCollision: required<HTMLInputElement>("#reward-collision"), rewardCrash: required<HTMLInputElement>("#reward-crash"), rewardCheckpoint: required<HTMLInputElement>("#reward-checkpoint"), rewardFinish: required<HTMLInputElement>("#reward-finish"),
  mode: required<HTMLElement>("#mode-label"), hint: required<HTMLElement>("#hint-label"), status: required<HTMLElement>("#training-status"),
  generation: required<HTMLElement>("#generation"), fitness: required<HTMLElement>("#fitness"), progress: required<HTMLElement>("#progress"),
  speed: required<HTMLElement>("#speed"), reward: required<HTMLElement>("#reward"), direction: required<HTMLElement>("#direction"), centerline: required<HTMLElement>("#centerline"), penalties: required<HTMLElement>("#penalties"), bars: required<HTMLElement>("#neural-bars"),
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
let fiveBrainEvolution = false;
let manualMode = false;
let trainingPopulation: Car[] = [];
let trainingIndex = 0;
let trainingGeneration = 0;
let trainingNetworks: SpikingNetwork[] = [];
type TrainingTrace = { trackId: TrackDefinition["id"]; points: Vec[]; score: number; generation: number; color: string };
let trainingHistory: TrainingTrace[] = [];
let trainingTracks: TrackDefinition[] = [DEFAULT_TRACK];
let trainingScores: number[] = [];
let trainingProgresses: number[] = [];
let trainingTrackIndex = 0;
let visualTimer: number | undefined;
let trainingSession = 0;
let trainingPopulationSize = 0;
let requestedGenerations = 0;
let rewardConfig: RewardConfig = { ...DEFAULT_REWARD_CONFIG };
let physicsConfig: PhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG };
let activeTrack: TrackDefinition = DEFAULT_TRACK;
let flyFinishAnnounced = false;
let runStartedAt: number | undefined;
let raceAccumulator = 0;
let lastFrameTime = performance.now();
const pressedKeys = new Set<string>();

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
    offTrackPerSecond: readNumber(ui.rewardOffTrack, DEFAULT_REWARD_CONFIG.offTrackPerSecond, 0, 200),
    edgePenaltyPerSecond: readNumber(ui.rewardEdge, DEFAULT_REWARD_CONFIG.edgePenaltyPerSecond, 0, 20),
    centerlinePerSecond: readNumber(ui.rewardCenterline, DEFAULT_REWARD_CONFIG.centerlinePerSecond ?? 0, 0, 20),
    collision: readNumber(ui.rewardCollision, DEFAULT_REWARD_CONFIG.collision, 0, 100),
    crash: readNumber(ui.rewardCrash, DEFAULT_REWARD_CONFIG.crash, 0, 200),
    checkpoint: readNumber(ui.rewardCheckpoint, DEFAULT_REWARD_CONFIG.checkpoint, 0, 1000),
    finish: readNumber(ui.rewardFinish, DEFAULT_REWARD_CONFIG.finish, 0, 1000),
  };
  return rewardConfig;
}

function readPhysicsConfig(): PhysicsConfig {
  physicsConfig = { wallsEnabled: ui.wallsToggle.checked };
  return physicsConfig;
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
  const penalty = breakdown.standingStill + breakdown.wrongDirection + breakdown.reverseProgress + breakdown.offTrack + breakdown.edge + breakdown.collision + breakdown.crash;
  ui.reward.textContent = car.lastReward.toFixed(2);
  ui.direction.textContent = `${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`;
  ui.centerline.textContent = `${Math.round(clamp(1 - Math.abs(car.lateralOffset), 0, 1) * 100)}%`;
  ui.penalties.textContent = `-${penalty.toFixed(2)}`;
}

function setBusy(value: boolean): void {
  [ui.raceButton, ui.driveButton, ui.visualButton, ui.evolveFiveButton, ui.headlessButton, ui.resetButton, ui.saveButton, ui.loadButton, ui.exportButton, ui.importButton].forEach((button) => { button.disabled = value; });
  [ui.trackSelect, ui.wallsToggle, ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardEdge, ui.rewardCenterline, ui.rewardCollision, ui.rewardCrash, ui.rewardCheckpoint, ui.rewardFinish].forEach((input) => { input.disabled = value; });
  ui.stopButton.disabled = !(value || running);
}

function createGridCar(lane: number, distanceAlong: number, color: string, name: string, route: TrackDefinition): Car {
  const car = startPosition(lane, route); const sample = pointAtDistance(distanceAlong, route); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
  const start = { x: sample.point.x + normal.x * lane * LANE_SPACING, y: sample.point.y + normal.y * lane * LANE_SPACING };
  car.position = start; car.heading = Math.atan2(sample.tangent.y, sample.tangent.x); car.color = color; car.name = name;
  const nearest = nearestTrack(car.position, route); car.progress = nearest.progress; car.distanceAlong = nearest.distanceAlong; car.bestProgress = nearest.progress;
  car.checkpointsPassed = Math.min(CHECKPOINT_COUNT - 1, Math.floor(nearest.progress * CHECKPOINT_COUNT)); car.nextCheckpoint = car.checkpointsPassed >= CHECKPOINT_COUNT - 1 ? 0 : car.checkpointsPassed + 1;
  return car;
}

function launchRace(manual = false): void {
  training = false; running = true; visualTraining = false; fiveBrainEvolution = false; manualMode = manual; trainingPopulation = []; trainingHistory = []; raceAccumulator = 0; runStartedAt = performance.now(); flyFinishAnnounced = false;
  activeTrack = ui.trackSelect.value === "all" ? DEFAULT_TRACK : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]);
  rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig();
  fly = startPosition(0, activeTrack); fly.color = "#74c0ff"; fly.name = "fly"; fly.isFly = true; fly.network = bestNetwork?.clone() ?? new SpikingNetwork(77);
  raceCars = [fly, createGridCar(-1, 52, "#f19a69", "bot 1", activeTrack), createGridCar(1, 108, "#e9d26d", "bot 2", activeTrack), createGridCar(-1, 164, "#b48cff", "bot 3", activeTrack)];
  const detail = manual ? `manual driving on ${activeTrack.name} — arrows or WASD steer, Space brakes, S/↓ reverses` : bestNetwork ? `best trained fly pilot deployed on ${activeTrack.name} against three spaced heuristic bots` : `demo brain deployed on ${activeTrack.name} — train a controller to improve it`;
  setRunState("Racing", detail, "running", "RACE MODE");
  setProgress(0, "lap 0%", manual ? "manual controls active · arrows/WASD · Space brake" : "fixed 30 Hz simulator · press Stop to pause");
  appendEvent(manual ? "manual race started · keyboard controls active" : "race started · fly pilot and three spaced bots are on the track");
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

function checkpointObject(): { format: string; version: number; savedAt: string; fitness: number; generation: number; network: BrainSnapshot } {
  if (!bestNetwork) throw new Error("train a brain before exporting a checkpoint");
  return { format: "flykart-brain", version: CHECKPOINT_VERSION, savedAt: new Date().toISOString(), fitness: bestFitness, generation, network: bestNetwork.toJSON() };
}

function exportBrain(): void {
  try {
    const payload = JSON.stringify(checkpointObject(), null, 2); const blob = new Blob([payload], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `flykart-brain-generation-${generation}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    const detail = `checkpoint downloaded from generation ${generation}; it can be imported on another browser`;
    setRunState("Checkpoint downloaded", detail, "ready", "RACE MODE"); appendEvent(detail);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "could not export checkpoint"; setRunState("Export error", detail, "error", "RACE MODE"); appendEvent(`export failed: ${detail}`);
  }
}

async function importBrain(file: File): Promise<void> {
  try {
    const parsed = JSON.parse(await file.text()) as { format?: unknown; version?: unknown; fitness?: unknown; generation?: unknown; network?: BrainSnapshot };
    if (parsed.format !== undefined && parsed.format !== "flykart-brain") throw new Error("this file is not a FlyKart brain checkpoint");
    if (!parsed.network) throw new Error("checkpoint is missing its network weights");
    const network = SpikingNetwork.fromJSON(parsed.network);
    bestNetwork = network; bestFitness = typeof parsed.fitness === "number" && Number.isFinite(parsed.fitness) ? parsed.fitness : -Infinity;
    generation = typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation >= 0 ? parsed.generation : 0;
    ui.generation.textContent = `${generation}`; ui.fitness.textContent = Number.isFinite(bestFitness) ? bestFitness.toFixed(1) : "—"; launchRace();
    const detail = `checkpoint imported from ${file.name}; generation ${generation} is ready to race`;
    setRunState("Checkpoint imported", detail, "ready", "RACE MODE"); appendEvent(detail);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "could not import checkpoint"; setRunState("Import error", detail, "error", "RACE MODE"); appendEvent(`import failed: ${detail}`);
  } finally { ui.importFile.value = ""; }
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
  drawPath(); context.strokeStyle = "#7b968b"; context.lineWidth = 2; context.setLineDash([16, 14]); context.stroke(); context.setLineDash([]);
  context.fillStyle = "#b7d8a2"; context.globalAlpha = 0.8; context.font = "600 11px system-ui"; context.fillText("CENTERLINE · +REWARD", -WIDTH / 2 + 18, -HEIGHT / 2 + 24); context.globalAlpha = 1;
  for (let index = 1; index < CHECKPOINT_COUNT; index += 1) {
    const checkpoint = trackCheckpoint(index, activeTrack); const gateOffset = activeTrack.width * 0.46;
    const gateA = addCanvasPoint(checkpoint.point, { x: checkpoint.normal.x * gateOffset, y: checkpoint.normal.y * gateOffset });
    const gateB = addCanvasPoint(checkpoint.point, { x: -checkpoint.normal.x * gateOffset, y: -checkpoint.normal.y * gateOffset });
    context.strokeStyle = "#e7bd72"; context.globalAlpha = 0.72; context.lineWidth = 2; context.setLineDash([6, 6]); context.beginPath(); context.moveTo(gateA.x, gateA.y); context.lineTo(gateB.x, gateB.y); context.stroke(); context.setLineDash([]);
    context.fillStyle = "#f1d28f"; context.font = "600 10px system-ui"; context.fillText(`CP${index}`, checkpoint.point.x + 6, checkpoint.point.y - 6);
  }
  const line = startLine(activeTrack); const lineOffset = activeTrack.width / 2 + 7; const startA = addCanvasPoint(line.point, { x: line.normal.x * lineOffset, y: line.normal.y * lineOffset }); const startB = addCanvasPoint(line.point, { x: -line.normal.x * lineOffset, y: -line.normal.y * lineOffset });
  context.strokeStyle = "#9ed5ff"; context.lineWidth = 5; context.beginPath(); context.moveTo(startA.x, startA.y); context.lineTo(startB.x, startB.y); context.stroke();
  for (let index = 0; index < activeTrack.points.length; index += 2) { const marker = activeTrack.points[index]; context.fillStyle = "#7aa18c"; context.globalAlpha = 0.28; context.beginPath(); context.arc(marker.x, marker.y, 3, 0, TAU); context.fill(); }
  context.restore();
}

function addCanvasPoint(point: { x: number; y: number }, offset: { x: number; y: number }): { x: number; y: number } { return { x: point.x + offset.x, y: point.y + offset.y }; }

function drawCar(car: Car, alpha = 1): void {
  context.save(); context.translate(WIDTH / 2 + car.position.x, HEIGHT / 2 + car.position.y); context.rotate(car.heading); context.globalAlpha = alpha;
  context.fillStyle = "rgba(0,0,0,.35)"; context.beginPath(); context.ellipse(2, 3, CAR_WIDTH + 2, CAR_WIDTH * 0.58, 0, 0, TAU); context.fill(); context.fillStyle = car.color; context.fillRect(-12, -CAR_WIDTH / 2, 24, CAR_WIDTH); context.fillStyle = "#d8e4ed"; context.fillRect(2, -5, 7, 10); context.fillStyle = "#0e1419"; context.fillRect(-9, -9, 6, 3); context.fillRect(-9, 6, 6, 3);
  if (car.isFly) { context.strokeStyle = "#b6e0ff"; context.lineWidth = 1.5; context.beginPath(); context.arc(-1, -11, 7, Math.PI, TAU); context.stroke(); context.fillStyle = "#d7efff"; context.beginPath(); context.arc(-3, 0, 3, 0, TAU); context.fill(); }
  context.restore();
  if (car.trail.length > 1) { context.save(); context.translate(WIDTH / 2, HEIGHT / 2); context.strokeStyle = car.color; context.globalAlpha = alpha * 0.2; context.lineWidth = 2; context.beginPath(); car.trail.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)); context.stroke(); context.restore(); }
}

function recordTrainingTrace(car: Car): void {
  if (car.trail.length < 2) return;
  trainingHistory.unshift({ trackId: car.trackId, points: car.trail.map((point) => ({ ...point })), score: car.score, generation: trainingGeneration, color: car.color });
  while (trainingHistory.length > 18) trainingHistory.pop();
}

function drawTrainingHistory(): void {
  trainingHistory.filter((trace) => trace.trackId === activeTrack.id).forEach((trace, index) => {
    context.save(); context.translate(WIDTH / 2, HEIGHT / 2); context.strokeStyle = trace.color; context.globalAlpha = Math.max(0.06, 0.2 - index * 0.008); context.lineWidth = index < 5 ? 2.5 : 1.5; context.setLineDash(index < 5 ? [8, 8] : [4, 8]);
    context.beginPath(); trace.points.forEach((point, pointIndex) => pointIndex === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)); context.stroke(); context.restore();
  });
}

function updateNeural(network: SpikingNetwork | undefined): void {
  const activity = network?.activity().spikes ?? []; bars.forEach((bar, index) => { bar.style.height = `${Math.max(6, (activity[index * 3] ?? 0) * 100)}%`; });
}

function render(): void {
  context.clearRect(0, 0, WIDTH, HEIGHT); renderTrack();
  if (training) {
    drawTrainingHistory();
    if (fiveBrainEvolution) {
      const leader = [...trainingPopulation].sort((a, b) => b.score - a.score)[0];
      trainingPopulation.filter((car) => car.trackId === activeTrack.id).forEach((car) => drawCar(car, car === leader ? 1 : 0.62));
      updateRewardTelemetry(leader); updateNeural(leader?.network);
    } else {
      const activeCandidate = trainingPopulation[trainingIndex];
      if (activeCandidate?.trackId === activeTrack.id) drawCar(activeCandidate, 0.95);
      updateRewardTelemetry(activeCandidate); updateNeural(activeCandidate?.network);
    }
  } else {
    raceCars.forEach((car) => drawCar(car)); updateRewardTelemetry(fly); updateNeural(fly?.network);
  }
}

function manualAction(): ReturnType<typeof heuristicAction> {
  const left = pressedKeys.has("ArrowLeft") || pressedKeys.has("a") || pressedKeys.has("A");
  const right = pressedKeys.has("ArrowRight") || pressedKeys.has("d") || pressedKeys.has("D");
  const forward = pressedKeys.has("ArrowUp") || pressedKeys.has("w") || pressedKeys.has("W");
  const reverse = pressedKeys.has("ArrowDown") || pressedKeys.has("s") || pressedKeys.has("S");
  return { steer: (right ? 1 : 0) - (left ? 1 : 0), throttle: forward ? 1 : 0, brake: pressedKeys.has(" ") ? 1 : 0, reverse: reverse ? 1 : 0 };
}

function updateRace(): void {
  if (!running || training) return;
  raceCars.forEach((car) => {
    const action = car === fly && manualMode ? manualAction() : car.isFly && car.network ? car.network.step(sensorValues(car, raceCars, activeTrack)) : heuristicAction(car, raceCars, activeTrack);
    car.action = action; stepCar(car, action, raceCars, activeTrack, rewardConfig, physicsConfig);
  });
  if (fly) {
    const lapPercent = Math.round(fly.progress * 100);
    ui.progress.textContent = `${lapPercent}%`;
    ui.speed.textContent = fly.speed.toFixed(1);
    updateRewardTelemetry(fly);
    if (!fly.finished) setProgress(fly.progress, `lap ${lapPercent}%`, `speed ${fly.speed.toFixed(1)} · checkpoints ${fly.checkpointsPassed}/${CHECKPOINT_COUNT} · collisions ${fly.collisions}`);
    if (fly.finished && !flyFinishAnnounced) {
      flyFinishAnnounced = true;
      setRunState("Finish line crossed", `Fly pilot completed a lap on ${activeTrack.name} with reward ${fly.score.toFixed(1)}.`, "ready", "FINISH");
      setProgress(1, "100% · lap complete", "finish reward applied · press Start race to run again");
      appendEvent(`finish line crossed on ${activeTrack.name} · lap reward ${rewardConfig.finish.toFixed(1)}`);
    }
    if (fly.timedOut && !fly.finished && !flyFinishAnnounced) {
      flyFinishAnnounced = true;
      setRunState("Time limit", `Fly pilot reached the ${MAX_TICKS}-tick limit without completing the lap.`, "paused", "TIME LIMIT");
      appendEvent(`time limit reached on ${activeTrack.name} · no crash recorded`);
    }
  }
}

function makeTrainingCar(network: SpikingNetwork, lane = 0, route: TrackDefinition = activeTrack): Car { network.reset(); const car = startPosition(lane, route); car.network = network; car.color = "#8191aa"; car.isFly = true; return car; }

function makeFiveBrainCar(network: SpikingNetwork, index: number, route: TrackDefinition): Car {
  const lanes = [-1.15, 1.15, -0.45, 0.45, 0]; const offsets = [0, 0, 68, 68, 136];
  const colors = ["#74c0ff", "#f19a69", "#e9d26d", "#b48cff", "#7cf0b6"];
  const car = createGridCar(lanes[index] ?? 0, offsets[index] ?? index * 48, colors[index] ?? "#8191aa", `brain ${index + 1}`, route);
  car.network = network; car.isFly = true; network.reset(); return car;
}

function createMutationPopulation(size: number, parent: SpikingNetwork | undefined, seed: number): SpikingNetwork[] {
  const stableParent = (parent ?? new SpikingNetwork(seed)).clone();
  return [stableParent, ...Array.from({ length: Math.max(0, size - 1) }, (_, index) => stableParent.mutate(0.12, 0.22, seed + index + 1))];
}

function trainFiveBrainStep(): void {
  const route = trainingTracks[trainingTrackIndex];
  trainingPopulation.forEach((car) => {
    if (!car.network || car.crashed || car.finished || car.timedOut) return;
    car.action = car.network.step(sensorValues(car, trainingPopulation, route));
    stepCar(car, car.action, trainingPopulation, route, rewardConfig, physicsConfig);
  });
  const tick = Math.max(0, ...trainingPopulation.map((car) => car.ticks));
  const episodesPerGeneration = Math.max(1, trainingTracks.length);
  const generationEpisodes = trainingPopulationSize * episodesPerGeneration;
  const completedEpisodes = (trainingGeneration - 1) * generationEpisodes + trainingTrackIndex * trainingPopulationSize;
  const liveFraction = tick / MAX_TICKS;
  const leader = [...trainingPopulation].sort((a, b) => b.score - a.score)[0];
  setProgress((completedEpisodes + liveFraction * trainingPopulationSize) / Math.max(1, requestedGenerations * generationEpisodes), `generation ${trainingGeneration}/${requestedGenerations} · five brains racing · ${route.name}`, `visual race · ${tick}/${MAX_TICKS} ticks · leader checkpoints ${leader?.checkpointsPassed ?? 0}/${CHECKPOINT_COUNT} · winner is ranked by averaged fitness`);
  const finished = trainingPopulation.every((car) => car.crashed || car.finished || car.timedOut || car.ticks >= MAX_TICKS);
  if (leader) {
    updateRewardTelemetry(leader);
    ui.fitness.textContent = leader.score.toFixed(1);
    ui.progress.textContent = `${Math.round(leader.totalProgress * 100)}%`;
  }
  if (!finished) return;
  trainingPopulation.forEach((car, index) => { trainingScores[index] += car.score; trainingProgresses[index] += car.totalProgress; });
  trainingPopulation.forEach(recordTrainingTrace);
  const currentLeader = [...trainingPopulation].sort((a, b) => b.score - a.score)[0];
  appendEvent(`five-brain race finished ${route.name} · leader ${currentLeader?.name ?? "unknown"} · fitness ${currentLeader?.score.toFixed(1) ?? "—"}`);
  if (trainingTrackIndex + 1 < trainingTracks.length) {
    trainingTrackIndex += 1; activeTrack = trainingTracks[trainingTrackIndex];
    trainingPopulation = trainingNetworks.map((network, index) => makeFiveBrainCar(network, index, activeTrack));
    appendEvent(`five brains reset for ${activeTrack.name}; previous track scores retained`);
    return;
  }
  trainingPopulation.forEach((car, index) => {
    car.score = trainingScores[index] / trainingTracks.length;
    car.totalProgress = trainingProgresses[index] / trainingTracks.length;
  });
  finishVisualGeneration();
}

function trainPopulationStep(): void {
  if (fiveBrainEvolution) { trainFiveBrainStep(); return; }
  const car = trainingPopulation[trainingIndex]; if (!car?.network) return;
  const cars = [car]; car.action = car.network.step(sensorValues(car, cars, trainingTracks[trainingTrackIndex])); stepCar(car, car.action, cars, trainingTracks[trainingTrackIndex], rewardConfig, physicsConfig);
  updateRewardTelemetry(car);
  const episodeCount = Math.max(1, trainingTracks.length); const totalEpisodes = Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations);
  const completedEpisodes = (trainingGeneration - 1) * trainingPopulationSize * episodeCount + trainingIndex * episodeCount + trainingTrackIndex;
  const candidateFraction = car.ticks / MAX_TICKS;
  const route = trainingTracks[trainingTrackIndex];
  setProgress((completedEpisodes + candidateFraction) / totalEpisodes, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex + 1}/${trainingPopulationSize} · ${route.name}`, `visual · tick ${car.ticks}/${MAX_TICKS} · checkpoints ${car.checkpointsPassed}/${CHECKPOINT_COUNT} · direction ${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`);
  if (car.crashed || car.finished || car.ticks >= MAX_TICKS) {
    recordTrainingTrace(car);
    trainingScores[trainingIndex] += car.score;
    trainingProgresses[trainingIndex] += car.totalProgress;
    const terminalReason = car.finished ? " · finish line" : car.crashed ? " · crashed" : car.timedOut ? " · time limit" : "";
    appendEvent(`candidate ${trainingIndex + 1}/${trainingPopulationSize} finished ${route.name} · fitness ${car.score.toFixed(1)}${terminalReason}`);
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
  trainingPopulation = fiveBrainEvolution ? trainingNetworks.map((network, index) => makeFiveBrainCar(network, index, trainingTracks[0])) : trainingNetworks.map((network, index) => makeTrainingCar(network, (index % 3) - 1, trainingTracks[0]));
  trainingIndex = 0;
  trainingPopulation.forEach((car) => car.network?.reset());
  const episodeCount = Math.max(1, trainingTracks.length);
  setProgress(((trainingGeneration - 1) * trainingPopulationSize * episodeCount) / Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations), fiveBrainEvolution ? `generation ${trainingGeneration}/${requestedGenerations} · five brains racing · ${trainingTracks[0].name}` : `generation ${trainingGeneration}/${requestedGenerations} · candidate 1/${trainingPopulationSize} · ${trainingTracks[0].name}`, fiveBrainEvolution ? "visual race · five independent brains share the track" : "visual · preparing candidate");
}

function breed(): void {
  const ranked = [...trainingNetworks].map((network, index) => ({ network, score: trainingPopulation[index]?.score ?? -Infinity })).sort((a, b) => b.score - a.score);
  const candidate = ranked[0];
  if (!candidate || !Number.isFinite(candidate.score)) throw new Error("generation produced no finite brain fitness");
  const improved = !bestNetwork || candidate.score > bestFitness;
  if (improved) {
    bestNetwork = candidate.network.clone(); bestFitness = candidate.score; generation = trainingGeneration;
  }
  const winner = trainingPopulation.find((car) => car.network === candidate.network); ui.generation.textContent = `${generation}`; ui.fitness.textContent = bestFitness.toFixed(1); ui.progress.textContent = `${Math.round((winner?.totalProgress ?? winner?.progress ?? 0) * 100)}%`;
  const result = improved ? `accepted new incumbent ${bestFitness.toFixed(1)}` : `rejected candidate ${candidate.score.toFixed(1)}; incumbent remains ${bestFitness.toFixed(1)}`;
  appendEvent(`generation ${trainingGeneration} complete · ${result} · next generation keeps parent at slot 1 and tries ${Math.max(0, ranked.length - 1)} mutations`);
  trainingNetworks = createMutationPopulation(ranked.length, bestNetwork, trainingGeneration * 1000);
}

function finishVisualGeneration(): void { breed(); if (trainingGeneration >= requestedGenerations) finishTraining(); else { trainingGeneration += 1; startVisualGeneration(); } }

async function runHeadless(): Promise<void> {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = false; fiveBrainEvolution = false; manualMode = false; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 24, 4, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); activeTrack = trainingTracks[0]; trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, 7000);
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
        const result = evaluateGeneralist(car.network as SpikingNetwork, trainingTracks, rewardConfig, physicsConfig); car.score = result.fitness; car.progress = result.progress; car.totalProgress = result.progress; car.finished = result.finished; car.laps = result.laps; car.rewardTotals = result.rewardTotals; car.rewardBreakdown = result.rewardTotals; car.lastReward = 0; car.forwardAlignment = 0;
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
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; fiveBrainEvolution = false; manualMode = false; trainingHistory = []; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 24, 4, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); activeTrack = trainingTracks[0]; trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, 5000);
  beginRun("Visual training", `Watching ${trainingPopulationSize} candidates drive across ${requestedGenerations} generations on ${selectedTrackLabel()}.`, "VISUAL TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function startFiveBrainEvolution(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; fiveBrainEvolution = true; manualMode = false; trainingHistory = []; trainingGeneration = 1;
  trainingPopulationSize = 5; requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); activeTrack = trainingTracks[0]; trainingNetworks = createMutationPopulation(5, bestNetwork, 9000);
  beginRun("Five-brain evolution", `Racing five independent brains together for ${requestedGenerations} generations on ${selectedTrackLabel()}.`, "5-BRAIN EVOLUTION");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function scheduleVisualBatch(session: number): void {
  if (!visualTraining || trainingSession !== session) return;
  try { for (let index = 0; index < 24 && visualTraining; index += 1) trainPopulationStep(); }
  catch (error) { if (trainingSession === session) failTraining(error); return; }
  visualTimer = window.setTimeout(() => scheduleVisualBatch(session), 16);
}

function finishTraining(): void {
  training = false; visualTraining = false; fiveBrainEvolution = false; clearVisualTimer(); trainingPopulation = []; setBusy(false); launchRace();
  const detail = `training complete — best fitness ${bestFitness.toFixed(1)} at generation ${generation}; the trained fly is now racing`;
  setRunState("Training complete", detail, "ready", "RACE MODE"); setProgress(1, "100% · complete", "trained controller deployed in race mode"); appendEvent(detail);
}

function failTraining(error: unknown): void {
  training = false; visualTraining = false; fiveBrainEvolution = false; clearVisualTimer(); trainingPopulation = []; setBusy(false);
  const detail = error instanceof Error ? error.message : "unknown training error";
  setRunState("Training error", detail, "error", "TRAINING ERROR"); appendEvent(`training failed: ${detail}`); console.error("FlyKart training failed", error);
}

function stopAll(): void {
  trainingSession += 1; const wasTraining = training; training = false; visualTraining = false; fiveBrainEvolution = false; running = false; clearVisualTimer(); trainingPopulation = []; setBusy(false);
  const detail = wasTraining ? "training stopped before completion; the best controller found so far is kept" : "race paused; press Start race or train again to continue";
  setRunState("Paused", detail, "paused", "PAUSED"); appendEvent(wasTraining ? "training stopped by user" : "race paused by user");
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" ? error : "unknown application error"; }

function failApplication(error: unknown): void {
  trainingSession += 1; training = false; visualTraining = false; fiveBrainEvolution = false; running = false; clearVisualTimer(); trainingPopulation = []; setBusy(false);
  const detail = describeError(error);
  setRunState("Application error", `${detail} Refresh the page and try again.`, "error", "APPLICATION ERROR"); appendEvent(`error: ${detail}`); console.error("FlyKart application error", error);
}

function safely(action: () => void): void { try { action(); } catch (error) { failApplication(error); } }

ui.raceButton.addEventListener("click", () => safely(() => launchRace(false)));
ui.driveButton.addEventListener("click", () => safely(() => launchRace(true)));
ui.visualButton.addEventListener("click", () => safely(startVisualTraining));
ui.evolveFiveButton.addEventListener("click", () => safely(startFiveBrainEvolution));
ui.headlessButton.addEventListener("click", () => { void runHeadless(); });
ui.stopButton.addEventListener("click", () => safely(stopAll));
ui.resetButton.addEventListener("click", () => safely(resetBrain));
ui.saveButton.addEventListener("click", () => safely(saveBrain));
ui.loadButton.addEventListener("click", () => safely(loadBrain));
ui.exportButton.addEventListener("click", () => safely(exportBrain));
ui.importButton.addEventListener("click", () => ui.importFile.click());
ui.importFile.addEventListener("change", () => { const file = ui.importFile.files?.[0]; if (file) void importBrain(file); });
ui.trackSelect.addEventListener("change", () => { if (!training) safely(launchRace); });
ui.wallsToggle.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(physicsConfig.wallsEnabled ? "track walls enabled · off-track recovery is active" : "track walls disabled · cars may leave the road and only receive off-track penalties"); });
[ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardEdge, ui.rewardCenterline, ui.rewardCollision, ui.rewardCrash, ui.rewardCheckpoint, ui.rewardFinish].forEach((input) => {
  input.addEventListener("change", () => { rewardConfig = readRewardConfig(); appendEvent("reward settings updated · new weights apply immediately"); });
});
window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  pressedKeys.add(event.key);
});
window.addEventListener("keyup", (event) => { pressedKeys.delete(event.key); });
window.addEventListener("blur", () => { pressedKeys.clear(); });
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
