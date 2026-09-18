import "./style.css";
import {
  BrainSnapshot, CAR_WIDTH, CHECKPOINT_COUNT, LANE_SPACING, MAX_ADAPTIVE_EXTENSIONS, Car, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, PhysicsConfig, RewardConfig, STEP, TAU, TRACKS, TrackDefinition, Vec,
  SpikingNetwork, clamp, createMutationPopulation, createRoadObstacles, evaluateGeneralist, heuristicAction, nearestTrack, pointAtDistance, resolveTrack, sensorValues, startLine, startPosition, stepCar, trackCheckpoint,
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

const evolutionChart = required<HTMLCanvasElement>("#evolution-chart");
function evolutionChartContext(): CanvasRenderingContext2D {
  const chartContext = evolutionChart.getContext("2d");
  if (!chartContext) throw new Error("Evolution chart rendering is unavailable");
  return chartContext;
}
const evolutionContext = evolutionChartContext();

const ui = {
  raceButton: required<HTMLButtonElement>("#race-btn"), driveButton: required<HTMLButtonElement>("#drive-btn"), visualButton: required<HTMLButtonElement>("#visual-train-btn"), evolveFiveButton: required<HTMLButtonElement>("#evolve-five-btn"),
  headlessButton: required<HTMLButtonElement>("#headless-train-btn"), stopButton: required<HTMLButtonElement>("#stop-btn"),
  resetButton: required<HTMLButtonElement>("#reset-btn"), saveButton: required<HTMLButtonElement>("#save-btn"), loadButton: required<HTMLButtonElement>("#load-btn"),
  exportButton: required<HTMLButtonElement>("#export-btn"), importButton: required<HTMLButtonElement>("#import-btn"), importFile: required<HTMLInputElement>("#import-file"),
  population: required<HTMLInputElement>("#population"), generations: required<HTMLInputElement>("#generations"),
  trackSelect: required<HTMLSelectElement>("#track-select"), wallsToggle: required<HTMLInputElement>("#walls-toggle"), adaptiveTimeToggle: required<HTMLInputElement>("#adaptive-time-toggle"), adaptiveExtensions: required<HTMLInputElement>("#adaptive-extensions"), checkpointCount: required<HTMLInputElement>("#checkpoint-count"), ghostEvolutionToggle: required<HTMLInputElement>("#ghost-evolution-toggle"), obstacleToggle: required<HTMLInputElement>("#obstacle-toggle"), obstacleCount: required<HTMLInputElement>("#obstacle-count"), plateauExplorationToggle: required<HTMLInputElement>("#plateau-exploration-toggle"), plateauPatience: required<HTMLInputElement>("#plateau-patience"), curriculumToggle: required<HTMLInputElement>("#curriculum-toggle"),
  rewardProgress: required<HTMLInputElement>("#reward-progress"), rewardDirection: required<HTMLInputElement>("#reward-direction"), rewardMoving: required<HTMLInputElement>("#reward-moving"),
  rewardStanding: required<HTMLInputElement>("#reward-standing"), rewardWrong: required<HTMLInputElement>("#reward-wrong"), rewardReverse: required<HTMLInputElement>("#reward-reverse"),
  rewardOffTrack: required<HTMLInputElement>("#reward-offtrack"), rewardEdge: required<HTMLInputElement>("#reward-edge"), rewardProximity: required<HTMLInputElement>("#reward-proximity"), rewardCenterline: required<HTMLInputElement>("#reward-centerline"), rewardCollision: required<HTMLInputElement>("#reward-collision"), rewardCrash: required<HTMLInputElement>("#reward-crash"), rewardCheckpoint: required<HTMLInputElement>("#reward-checkpoint"), rewardFinish: required<HTMLInputElement>("#reward-finish"),
  mode: required<HTMLElement>("#mode-label"), hint: required<HTMLElement>("#hint-label"), status: required<HTMLElement>("#training-status"),
  generation: required<HTMLElement>("#generation"), fitness: required<HTMLElement>("#fitness"), progress: required<HTMLElement>("#progress"), plateau: required<HTMLElement>("#plateau"), strategy: required<HTMLElement>("#evolution-strategy"),
  speed: required<HTMLElement>("#speed"), reward: required<HTMLElement>("#reward"), direction: required<HTMLElement>("#direction"), centerline: required<HTMLElement>("#centerline"), traffic: required<HTMLElement>("#traffic-gap"), penalties: required<HTMLElement>("#penalties"), rewardBreakdown: required<HTMLElement>("#reward-breakdown"), bars: required<HTMLElement>("#neural-bars"),
  runState: required<HTMLElement>("#run-state"), runDetail: required<HTMLElement>("#run-detail"),
  runProgressTrack: required<HTMLElement>("#run-progress-track"), runProgressBar: required<HTMLElement>("#run-progress-bar"),
  runProgressText: required<HTMLElement>("#run-progress-text"), runStepText: required<HTMLElement>("#run-step-text"),
  runElapsed: required<HTMLElement>("#run-elapsed"), eventLog: required<HTMLOListElement>("#event-log"), copyLogButton: required<HTMLButtonElement>("#copy-log-btn"),
  plotSummary: required<HTMLElement>("#plot-summary"), plotTooltip: required<HTMLElement>("#plot-tooltip"),
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
let ghostEvolution = false;
let manualMode = false;
let trainingPopulation: Car[] = [];
let trainingObstacles: Car[] = [];
// Ghost population evolution gets a separate obstacle world per candidate as
// well, so a collision with a stalled road object cannot change another
// candidate's sensors or physics.
let trainingGhostObstacles: Car[][] = [];
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
let randomObjectsEnabled = false;
let randomObjectCount = 0;
let plateauExplorationEnabled = true;
let plateauPatience = 3;
let plateauStreak = 0;
let curriculumEnabled = false;
let trainingWorldSeed = 0;
type TrainingContextKey = TrackDefinition["id"] | "all";
let activeTrainingContext: TrainingContextKey = DEFAULT_TRACK.id;
const contextNetworks = new Map<TrainingContextKey, SpikingNetwork>();
const contextFitness = new Map<TrainingContextKey, number>();
const contextGenerations = new Map<TrainingContextKey, number>();
const DEFAULT_MUTATION_RATE = 0.12;
const DEFAULT_MUTATION_AMOUNT = 0.22;
let mutationRate = DEFAULT_MUTATION_RATE;
let mutationAmount = DEFAULT_MUTATION_AMOUNT;
let previousGenerationProgress = 0;
let activeTrack: TrackDefinition = DEFAULT_TRACK;
let flyFinishAnnounced = false;
let runStartedAt: number | undefined;
let eventHistory: string[] = [];
type EvolutionPoint = { generation: number; bestFitness: number; candidateFitness: number; progress: number; plateauStreak: number; mutationRate: number; mutationAmount: number };
let evolutionHistory: EvolutionPoint[] = [];
let hoveredEvolutionIndex: number | undefined;
let hoveredEvolutionRatio = 0;
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

function renderEventLog(): void {
  const visibleEvents = eventHistory.slice(-32);
  ui.eventLog.replaceChildren();
  visibleEvents.forEach((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    ui.eventLog.appendChild(item);
  });
  ui.eventLog.scrollTop = ui.eventLog.scrollHeight;
}

function appendEvent(message: string): void {
  eventHistory.push(`${runStartedAt === undefined ? "--:--" : formatDuration(performance.now() - runStartedAt)}  ${message}`);
  renderEventLog();
}

async function copyAllLog(): Promise<void> {
  if (eventHistory.length === 0) {
    appendEvent("copy log skipped: no events recorded yet");
    return;
  }
  const text = eventHistory.join("\n");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      if (!copied) throw new Error("clipboard unavailable");
    }
    const originalLabel = "Copy all log";
    ui.copyLogButton.textContent = `Copied ${eventHistory.length} events`;
    window.setTimeout(() => { ui.copyLogButton.textContent = originalLabel; }, 1400);
  } catch (error) {
    appendEvent(`copy log failed: ${error instanceof Error ? error.message : "clipboard unavailable"}`);
  }
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
    proximityPenaltyPerSecond: readNumber(ui.rewardProximity, DEFAULT_REWARD_CONFIG.proximityPenaltyPerSecond, 0, 100),
    centerlinePerSecond: readNumber(ui.rewardCenterline, DEFAULT_REWARD_CONFIG.centerlinePerSecond ?? 0, 0, 20),
    collision: readNumber(ui.rewardCollision, DEFAULT_REWARD_CONFIG.collision, 0, 100),
    crash: readNumber(ui.rewardCrash, DEFAULT_REWARD_CONFIG.crash, 0, 200),
    checkpoint: readNumber(ui.rewardCheckpoint, DEFAULT_REWARD_CONFIG.checkpoint, 0, 1000),
    finish: readNumber(ui.rewardFinish, DEFAULT_REWARD_CONFIG.finish, 0, 1000),
  };
  return rewardConfig;
}

function readPhysicsConfig(): PhysicsConfig {
  physicsConfig = {
    wallsEnabled: ui.wallsToggle.checked,
    adaptiveTimeLimit: ui.adaptiveTimeToggle.checked,
    maxAdaptiveExtensions: readInteger(ui.adaptiveExtensions, DEFAULT_PHYSICS_CONFIG.maxAdaptiveExtensions ?? 4, 0, MAX_ADAPTIVE_EXTENSIONS),
    checkpointCount: readInteger(ui.checkpointCount, CHECKPOINT_COUNT, 2, 64),
  };
  return physicsConfig;
}

function readRoadObjectConfig(): void {
  randomObjectsEnabled = ui.obstacleToggle.checked;
  randomObjectCount = readInteger(ui.obstacleCount, 6, 0, 64);
}

function readEvolutionConfig(): void {
  plateauExplorationEnabled = ui.plateauExplorationToggle.checked;
  plateauPatience = readInteger(ui.plateauPatience, 3, 1, 20);
  curriculumEnabled = ui.curriculumToggle.checked;
}

function selectedTrainingContext(): TrainingContextKey {
  return ui.trackSelect.value === "all" ? "all" : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]).id;
}

function updateBestMetrics(): void {
  ui.generation.textContent = `${generation}`;
  ui.fitness.textContent = Number.isFinite(bestFitness) ? bestFitness.toFixed(1) : "—";
}

function prepareTrainingContext(): void {
  activeTrainingContext = selectedTrainingContext();
  const stored = contextNetworks.get(activeTrainingContext);
  if (stored) {
    bestNetwork = stored.clone(); bestFitness = contextFitness.get(activeTrainingContext) ?? -Infinity; generation = contextGenerations.get(activeTrainingContext) ?? 0;
  } else {
    // Reuse the current brain as a warm-start, but never compare its old
    // track score against this track's first generation.
    bestFitness = -Infinity; generation = 0;
  }
  updateBestMetrics();
}

function rememberTrainingContext(): void {
  if (!bestNetwork || !Number.isFinite(bestFitness)) return;
  contextNetworks.set(activeTrainingContext, bestNetwork.clone()); contextFitness.set(activeTrainingContext, bestFitness); contextGenerations.set(activeTrainingContext, generation);
}

function activateStoredContextForRace(): void {
  const context = selectedTrainingContext(); const stored = contextNetworks.get(context);
  if (!stored) return;
  activeTrainingContext = context; bestNetwork = stored.clone(); bestFitness = contextFitness.get(context) ?? bestFitness; generation = contextGenerations.get(context) ?? generation; updateBestMetrics();
}

function trainingObstacleCount(): number {
  if (!randomObjectsEnabled || randomObjectCount <= 0) return 0;
  if (!curriculumEnabled || requestedGenerations <= 1) return randomObjectCount;
  const difficulty = clamp((trainingGeneration - 1) / Math.max(1, requestedGenerations - 1), 0, 1);
  return Math.max(1, Math.round(randomObjectCount * (0.2 + difficulty * 0.8)));
}

function updateEvolutionTelemetry(): void {
  const exploring = plateauExplorationEnabled && plateauStreak >= plateauPatience;
  ui.plateau.textContent = plateauStreak === 0 ? "clear" : `${plateauStreak} gen`;
  ui.strategy.textContent = !plateauExplorationEnabled ? "fixed mutation" : exploring ? "exploration burst" : `local search · ${plateauPatience} gen patience`;
  ui.plateau.className = plateauStreak === 0 ? "metric-neutral" : exploring ? "metric-negative" : "metric-neutral";
  ui.strategy.className = exploring ? "metric-negative" : "metric-neutral";
}

function renderEvolutionChart(): void {
  const width = evolutionChart.width; const height = evolutionChart.height;
  const left = 62; const right = 58; const top = 28; const bottom = 36; const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  evolutionContext.clearRect(0, 0, width, height); evolutionContext.fillStyle = "#0c131b"; evolutionContext.fillRect(0, 0, width, height);
  evolutionContext.font = "10px system-ui"; evolutionContext.lineWidth = 1;
  ui.plotTooltip.setAttribute("aria-hidden", "true");
  ui.plotTooltip.hidden = true;
  if (evolutionHistory.length === 0) {
    evolutionContext.fillStyle = "#7f8ca0"; evolutionContext.fillText("Start training to populate the evolution trend", left, top + plotHeight / 2);
    evolutionContext.strokeStyle = "rgba(113, 145, 181, .18)"; evolutionContext.strokeRect(left, top, plotWidth, plotHeight);
    evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.fillText("fitness / reward", 6, top - 9); evolutionContext.fillText("lap coverage", width - 64, top - 9);
    ui.plotSummary.textContent = "No generations recorded yet. Hover a point later to inspect the exact candidate, incumbent, progress, plateau, and mutation values.";
    return;
  }
  const fitnessValues = evolutionHistory.flatMap((point) => [point.bestFitness, point.candidateFitness]);
  const rawMin = Math.min(...fitnessValues); const rawMax = Math.max(...fitnessValues);
  const fitnessPadding = Math.max(1, (rawMax - rawMin) * 0.14); const fitnessMin = rawMin - fitnessPadding; const fitnessMax = rawMax + fitnessPadding;
  const xAt = (index: number): number => left + (evolutionHistory.length === 1 ? plotWidth / 2 : (index / (evolutionHistory.length - 1)) * plotWidth);
  const rewardY = (fitness: number): number => top + (1 - (fitness - fitnessMin) / Math.max(1, fitnessMax - fitnessMin)) * plotHeight;
  const progressY = (progress: number): number => top + (1 - clamp(progress, 0, 1)) * plotHeight;
  evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.font = "600 10px system-ui"; evolutionContext.fillText("fitness / reward", 6, top - 10); evolutionContext.fillText("forward progress", width - 82, top - 10);
  evolutionContext.strokeStyle = "rgba(113, 145, 181, .2)"; evolutionContext.setLineDash([3, 5]);
  for (let row = 0; row <= 4; row += 1) {
    const fraction = row / 4; const y = top + fraction * plotHeight;
    evolutionContext.beginPath(); evolutionContext.moveTo(left, y); evolutionContext.lineTo(left + plotWidth, y); evolutionContext.stroke();
    const fitnessLabel = (fitnessMax - fraction * (fitnessMax - fitnessMin)).toFixed(0);
    const progressLabel = `${Math.round((1 - fraction) * 100)}%`;
    evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.fillText(fitnessLabel, 8, y + 3); evolutionContext.fillText(progressLabel, width - 42, y + 3);
  }
  evolutionContext.setLineDash([]); evolutionContext.strokeStyle = "rgba(113, 145, 181, .48)"; evolutionContext.strokeRect(left, top, plotWidth, plotHeight);
  evolutionHistory.forEach((point, index) => {
    if (point.plateauStreak <= 0) return;
    const startX = index === 0 ? left : xAt(index - 1); const endX = xAt(index);
    evolutionContext.fillStyle = point.plateauStreak >= plateauPatience ? "rgba(255, 140, 140, .18)" : "rgba(255, 140, 140, .07)";
    evolutionContext.fillRect(startX, top, Math.max(2, endX - startX), plotHeight);
  });
  const drawSeries = (valueAt: (point: EvolutionPoint) => number, yAt: (value: number) => number, color: string, dash: number[] = []): void => {
    evolutionContext.strokeStyle = color; evolutionContext.lineWidth = 2.2; evolutionContext.setLineDash(dash); evolutionContext.beginPath();
    evolutionHistory.forEach((point, index) => { const x = xAt(index); const y = yAt(valueAt(point)); if (index === 0) evolutionContext.moveTo(x, y); else evolutionContext.lineTo(x, y); });
    evolutionContext.stroke(); evolutionContext.setLineDash([]);
  };
  drawSeries((point) => point.bestFitness, rewardY, "#7cf0b6");
  drawSeries((point) => point.candidateFitness, rewardY, "#f3c96b", [6, 4]);
  // A lightly filled progress area makes small forward gains visible even
  // when fitness values are orders of magnitude larger.
  evolutionContext.beginPath(); evolutionHistory.forEach((point, index) => { const x = xAt(index); const y = progressY(point.progress); if (index === 0) evolutionContext.moveTo(x, y); else evolutionContext.lineTo(x, y); }); evolutionContext.lineTo(xAt(evolutionHistory.length - 1), top + plotHeight); evolutionContext.lineTo(left, top + plotHeight); evolutionContext.closePath(); evolutionContext.fillStyle = "rgba(114, 184, 255, .08)"; evolutionContext.fill();
  drawSeries((point) => point.progress, progressY, "#72b8ff");
  evolutionHistory.forEach((point, index) => {
    const x = xAt(index); const radius = index === hoveredEvolutionIndex ? 4 : 2.5;
    evolutionContext.fillStyle = "#7cf0b6"; evolutionContext.beginPath(); evolutionContext.arc(x, rewardY(point.bestFitness), radius, 0, TAU); evolutionContext.fill();
    evolutionContext.fillStyle = "#72b8ff"; evolutionContext.beginPath(); evolutionContext.arc(x, progressY(point.progress), radius, 0, TAU); evolutionContext.fill();
    if (point.plateauStreak >= plateauPatience) { evolutionContext.fillStyle = "#ff8c8c"; evolutionContext.beginPath(); evolutionContext.arc(x, rewardY(point.bestFitness), 3.5, 0, TAU); evolutionContext.fill(); }
  });
  const latest = evolutionHistory[evolutionHistory.length - 1]; const previous = evolutionHistory[evolutionHistory.length - 2];
  const rewardDelta = previous ? latest.bestFitness - previous.bestFitness : 0; const progressDelta = previous ? (latest.progress - previous.progress) * 100 : latest.progress * 100;
  const xLabels = evolutionHistory.length === 1 ? [0] : [0, Math.floor((evolutionHistory.length - 1) / 2), evolutionHistory.length - 1];
  evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.font = "10px system-ui"; xLabels.forEach((index) => { const label = `G${evolutionHistory[index].generation}`; evolutionContext.fillText(label, Math.max(left, Math.min(width - right - 22, xAt(index) - 10)), height - 10); });
  if (hoveredEvolutionIndex !== undefined && evolutionHistory[hoveredEvolutionIndex]) {
    const point = evolutionHistory[hoveredEvolutionIndex]; const x = xAt(hoveredEvolutionIndex);
    evolutionContext.strokeStyle = "rgba(238, 245, 255, .65)"; evolutionContext.setLineDash([2, 3]); evolutionContext.beginPath(); evolutionContext.moveTo(x, top); evolutionContext.lineTo(x, top + plotHeight); evolutionContext.stroke(); evolutionContext.setLineDash([]);
    ui.plotTooltip.hidden = false; ui.plotTooltip.setAttribute("aria-hidden", "false"); ui.plotTooltip.style.left = `${clamp(hoveredEvolutionRatio * evolutionChart.clientWidth + 12, 6, Math.max(6, evolutionChart.clientWidth - 188))}px`; ui.plotTooltip.textContent = `G${point.generation} · best ${point.bestFitness.toFixed(1)} · candidate ${point.candidateFitness.toFixed(1)} · forward ${(point.progress * 100).toFixed(1)}% · plateau ${point.plateauStreak}/${plateauPatience} · mutation ${(point.mutationRate * 100).toFixed(0)}% / ${point.mutationAmount.toFixed(2)}`;
  }
  ui.plotSummary.textContent = `G${latest.generation} · incumbent ${latest.bestFitness.toFixed(1)} · candidate ${latest.candidateFitness.toFixed(1)} · Δ incumbent ${rewardDelta >= 0 ? "+" : ""}${rewardDelta.toFixed(1)} · forward ${(latest.progress * 100).toFixed(1)}% (${progressDelta >= 0 ? "+" : ""}${progressDelta.toFixed(1)} pp) · plateau ${latest.plateauStreak}/${plateauPatience} · mutation ${(latest.mutationRate * 100).toFixed(0)}% / ${latest.mutationAmount.toFixed(2)}`;
}

function resetEvolutionHistory(): void {
  evolutionHistory = []; renderEvolutionChart();
}

function recordEvolutionPoint(candidateFitness: number, progress: number): void {
  evolutionHistory.push({ generation: trainingGeneration, bestFitness, candidateFitness, progress: clamp(progress, 0, 1), plateauStreak, mutationRate, mutationAmount });
  if (evolutionHistory.length > 1000) evolutionHistory.shift();
  renderEvolutionChart();
}

evolutionChart.addEventListener("pointermove", (event) => {
  if (evolutionHistory.length === 0) return;
  const bounds = evolutionChart.getBoundingClientRect(); const chartX = (event.clientX - bounds.left) * (evolutionChart.width / Math.max(1, bounds.width));
  const left = 62; const right = 58; const ratio = clamp((chartX - left) / Math.max(1, evolutionChart.width - left - right), 0, 1);
  hoveredEvolutionRatio = ratio; hoveredEvolutionIndex = Math.round(ratio * (evolutionHistory.length - 1)); renderEvolutionChart();
});
evolutionChart.addEventListener("pointerleave", () => { hoveredEvolutionIndex = undefined; renderEvolutionChart(); });

function refreshTrainingObstacles(route: TrackDefinition, seed: number): void {
  trainingObstacles = randomObjectsEnabled ? createRoadObstacles(trainingObstacleCount(), route, seed) : [];
  trainingGhostObstacles = ghostEvolution && fiveBrainEvolution
    // Each candidate gets independent object instances, but the same seeded
    // layout, so isolation does not introduce a hidden fitness advantage.
    ? Array.from({ length: trainingPopulationSize }, () => randomObjectsEnabled ? createRoadObstacles(trainingObstacleCount(), route, seed) : [])
    : [];
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
  const penalty = breakdown.standingStill + breakdown.wrongDirection + breakdown.reverseProgress + breakdown.offTrack + breakdown.edge + breakdown.proximity + breakdown.collision + breakdown.crash;
  ui.reward.textContent = car.lastReward.toFixed(2);
  ui.reward.className = car.lastReward > 0.001 ? "metric-positive" : car.lastReward < -0.001 ? "metric-negative" : "metric-neutral";
  ui.direction.textContent = `${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`;
  ui.centerline.textContent = `${Math.round(clamp(1 - Math.abs(car.lateralOffset), 0, 1) * 100)}%`;
  ui.traffic.textContent = Number.isFinite(car.nearestOpponentDistance) ? `${car.nearestOpponentDistance.toFixed(0)} px` : "clear";
  ui.traffic.className = breakdown.proximity > 0.001 ? "metric-negative" : "metric-neutral";
  ui.penalties.textContent = penalty > 0.001 ? `-${penalty.toFixed(2)}` : "0.00";
  ui.penalties.className = penalty > 0.001 ? "metric-negative" : "metric-neutral";
  const positive = [
    ["progress", breakdown.progress], ["direction", breakdown.direction], ["moving", breakdown.movement],
    ["centerline", breakdown.centerline], ["checkpoint", breakdown.checkpoint], ["finish", breakdown.finish],
  ] as const;
  const negative = [
    ["standing", breakdown.standingStill], ["wrong way", breakdown.wrongDirection], ["reverse", breakdown.reverseProgress],
    ["outside", breakdown.offTrack], ["edge", breakdown.edge], ["close traffic", breakdown.proximity],
    ["collision", breakdown.collision], ["crash", breakdown.crash],
  ] as const;
  ui.rewardBreakdown.replaceChildren();
  const title = document.createElement("span"); title.className = "reward-breakdown-title"; title.textContent = "This tick"; ui.rewardBreakdown.appendChild(title);
  [...positive, ...negative].forEach(([label, value]) => {
    if (value <= 0.0001) return;
    const item = document.createElement("span"); item.className = value > 0 && positive.some(([key]) => key === label) ? "positive" : "negative";
    const displayedValue = value < 0.01 ? value.toFixed(3) : value.toFixed(2);
    item.textContent = `${item.className === "positive" ? "+" : "−"}${label} ${displayedValue}`;
    ui.rewardBreakdown.appendChild(item);
  });
  if (![...positive, ...negative].some(([, value]) => value > 0.0001)) {
    const item = document.createElement("span"); item.className = "neutral"; item.textContent = "no reward terms"; ui.rewardBreakdown.appendChild(item);
  }
}

function setBusy(value: boolean): void {
  [ui.raceButton, ui.driveButton, ui.visualButton, ui.evolveFiveButton, ui.headlessButton, ui.resetButton, ui.loadButton, ui.importButton].forEach((button) => { button.disabled = value; });
  [ui.trackSelect, ui.wallsToggle, ui.adaptiveTimeToggle, ui.adaptiveExtensions, ui.checkpointCount, ui.ghostEvolutionToggle, ui.obstacleToggle, ui.obstacleCount, ui.plateauExplorationToggle, ui.plateauPatience, ui.curriculumToggle, ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardEdge, ui.rewardProximity, ui.rewardCenterline, ui.rewardCollision, ui.rewardCrash, ui.rewardCheckpoint, ui.rewardFinish].forEach((input) => { input.disabled = value; });
  ui.stopButton.disabled = !(value || running);
}

function createGridCar(lane: number, distanceAlong: number, color: string, name: string, route: TrackDefinition, checkpointCount = physicsConfig.checkpointCount ?? CHECKPOINT_COUNT): Car {
  const car = startPosition(lane, route); const sample = pointAtDistance(distanceAlong, route); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
  const start = { x: sample.point.x + normal.x * lane * LANE_SPACING, y: sample.point.y + normal.y * lane * LANE_SPACING };
  car.position = start; car.heading = Math.atan2(sample.tangent.y, sample.tangent.x); car.color = color; car.name = name;
  const nearest = nearestTrack(car.position, route); car.progress = nearest.progress; car.distanceAlong = nearest.distanceAlong; car.bestProgress = nearest.progress;
  car.checkpointsPassed = Math.min(checkpointCount - 1, Math.floor(nearest.progress * checkpointCount)); car.nextCheckpoint = car.checkpointsPassed >= checkpointCount - 1 ? 0 : car.checkpointsPassed + 1;
  return car;
}

function launchRace(manual = false): void {
  training = false; running = true; visualTraining = false; fiveBrainEvolution = false; ghostEvolution = false; manualMode = manual; trainingPopulation = []; trainingObstacles = []; trainingGhostObstacles = []; trainingHistory = []; raceAccumulator = 0; runStartedAt = performance.now(); flyFinishAnnounced = false;
  activeTrack = ui.trackSelect.value === "all" ? DEFAULT_TRACK : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]);
  activateStoredContextForRace();
  rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig();
  fly = startPosition(0, activeTrack); fly.color = "#74c0ff"; fly.name = "fly"; fly.isFly = true; fly.network = bestNetwork?.clone() ?? new SpikingNetwork(77);
  const roadObjects = randomObjectsEnabled ? createRoadObstacles(randomObjectCount, activeTrack, generation + 77) : [];
  raceCars = [fly, createGridCar(-1, 52, "#f19a69", "bot 1", activeTrack), createGridCar(1, 108, "#e9d26d", "bot 2", activeTrack), createGridCar(-1, 164, "#b48cff", "bot 3", activeTrack), ...roadObjects];
  const objectDetail = roadObjects.length > 0 ? ` plus ${roadObjects.length} stalled road objects` : "";
  const detail = manual ? `manual driving on ${activeTrack.name} — arrows or WASD steer, Space brakes, S/↓ reverses${objectDetail}` : bestNetwork ? `best trained fly pilot deployed on ${activeTrack.name} against three spaced heuristic bots${objectDetail}` : `demo brain deployed on ${activeTrack.name} — train a controller to improve it${objectDetail}`;
  setRunState("Racing", detail, "running", "RACE MODE");
  setProgress(0, "lap 0%", manual ? "manual controls active · arrows/WASD · Space brake" : "fixed 30 Hz simulator · press Stop to pause");
  appendEvent(manual ? `manual race started · keyboard controls active${objectDetail}` : `race started · fly pilot and three spaced bots are on the track${objectDetail}`);
  setBusy(false);
}

function resetBrain(): void {
  bestNetwork = undefined; bestFitness = -Infinity; generation = 0; contextNetworks.clear(); contextFitness.clear(); contextGenerations.clear(); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; ui.progress.textContent = "0%"; plateauStreak = 0; resetEvolutionHistory(); updateEvolutionTelemetry();
  appendEvent("controller reset; returning to demo brain"); launchRace();
}

function checkpointNetwork(): SpikingNetwork | undefined {
  return bestNetwork ?? trainingNetworks[0];
}

function persistBestBrain(): void {
  const network = checkpointNetwork(); if (!network) return;
  try {
    if (!bestNetwork) bestNetwork = network.clone(); rememberTrainingContext();
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ fitness: Number.isFinite(bestFitness) ? bestFitness : 0, generation, track: activeTrainingContext, network: network.toJSON() }));
  } catch (error) { console.warn("FlyKart could not persist the current brain", error); }
}

function saveBrain(): void {
  const network = checkpointNetwork();
  if (!network) { setRunState("No checkpoint", "Start training before saving a checkpoint.", "paused", "RACE MODE"); appendEvent("save skipped: no controller is available yet"); return; }
  try {
    bestNetwork = bestNetwork ?? network.clone(); persistBestBrain();
    const detail = `checkpoint saved at generation ${generation} with fitness ${Number.isFinite(bestFitness) ? bestFitness.toFixed(1) : "pending"}`;
    setRunState("Checkpoint saved", detail, "ready", "RACE MODE"); appendEvent(detail);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "could not save checkpoint";
    setRunState("Save error", detail, "error", "RACE MODE"); appendEvent(`save failed: ${detail}`);
  }
}

function checkpointObject(): { format: string; version: number; savedAt: string; fitness: number; generation: number; track: TrainingContextKey; network: BrainSnapshot } {
  const network = checkpointNetwork(); if (!network) throw new Error("start training before exporting a checkpoint");
  return { format: "flykart-brain", version: CHECKPOINT_VERSION, savedAt: new Date().toISOString(), fitness: Number.isFinite(bestFitness) ? bestFitness : 0, generation, track: activeTrainingContext, network: network.toJSON() };
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
    const parsed = JSON.parse(await file.text()) as { format?: unknown; version?: unknown; fitness?: unknown; generation?: unknown; track?: unknown; network?: BrainSnapshot };
    if (parsed.format !== undefined && parsed.format !== "flykart-brain") throw new Error("this file is not a FlyKart brain checkpoint");
    if (!parsed.network) throw new Error("checkpoint is missing its network weights");
    const network = SpikingNetwork.fromJSON(parsed.network);
    bestNetwork = network; bestFitness = typeof parsed.fitness === "number" && Number.isFinite(parsed.fitness) ? parsed.fitness : -Infinity;
    generation = typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation >= 0 ? parsed.generation : 0;
    activeTrainingContext = selectedTrainingContext(); contextNetworks.set(activeTrainingContext, network.clone()); if (Number.isFinite(bestFitness)) contextFitness.set(activeTrainingContext, bestFitness); contextGenerations.set(activeTrainingContext, generation);
    updateBestMetrics(); launchRace();
    const detail = `checkpoint imported from ${file.name}; generation ${generation} is ready to race`;
    setRunState("Checkpoint imported", detail, "ready", "RACE MODE"); appendEvent(detail);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "could not import checkpoint"; setRunState("Import error", detail, "error", "RACE MODE"); appendEvent(`import failed: ${detail}`);
  } finally { ui.importFile.value = ""; }
}

function loadBrain(): void {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY); if (!raw) { setRunState("No checkpoint", "No saved controller was found in this browser.", "paused", "RACE MODE"); appendEvent("load skipped: no checkpoint found"); return; }
    const saved = JSON.parse(raw) as { fitness?: unknown; generation?: unknown; track?: unknown; network?: BrainSnapshot }; if (!saved.network) throw new Error("saved checkpoint is incomplete");
    bestNetwork = SpikingNetwork.fromJSON(saved.network); bestFitness = typeof saved.fitness === "number" && Number.isFinite(saved.fitness) ? saved.fitness : -Infinity;
    generation = typeof saved.generation === "number" && Number.isInteger(saved.generation) && saved.generation >= 0 ? saved.generation : 0;
    activeTrainingContext = selectedTrainingContext(); contextNetworks.set(activeTrainingContext, bestNetwork.clone()); if (Number.isFinite(bestFitness)) contextFitness.set(activeTrainingContext, bestFitness); contextGenerations.set(activeTrainingContext, generation);
    updateBestMetrics(); launchRace();
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
  const checkpointCount = physicsConfig.checkpointCount ?? CHECKPOINT_COUNT;
  for (let index = 1; index < checkpointCount; index += 1) {
    const checkpoint = trackCheckpoint(index, activeTrack, checkpointCount); const gateOffset = activeTrack.width / 2 + CAR_WIDTH;
    const gateA = addCanvasPoint(checkpoint.point, { x: checkpoint.normal.x * gateOffset, y: checkpoint.normal.y * gateOffset });
    const gateB = addCanvasPoint(checkpoint.point, { x: -checkpoint.normal.x * gateOffset, y: -checkpoint.normal.y * gateOffset });
    context.strokeStyle = "#e7bd72"; context.globalAlpha = 0.72; context.lineWidth = 2; context.setLineDash([6, 6]); context.beginPath(); context.moveTo(gateA.x, gateA.y); context.lineTo(gateB.x, gateB.y); context.stroke(); context.setLineDash([]);
    context.globalAlpha = 0.9; context.strokeStyle = "#f7dfaa"; context.lineWidth = 1.5; context.beginPath(); context.moveTo(checkpoint.point.x - checkpoint.tangent.x * 9, checkpoint.point.y - checkpoint.tangent.y * 9); context.lineTo(checkpoint.point.x + checkpoint.tangent.x * 9, checkpoint.point.y + checkpoint.tangent.y * 9); context.stroke();
    context.beginPath(); context.moveTo(checkpoint.point.x + checkpoint.tangent.x * 9, checkpoint.point.y + checkpoint.tangent.y * 9); context.lineTo(checkpoint.point.x + checkpoint.tangent.x * 3 - checkpoint.normal.x * 4, checkpoint.point.y + checkpoint.tangent.y * 3 - checkpoint.normal.y * 4); context.moveTo(checkpoint.point.x + checkpoint.tangent.x * 9, checkpoint.point.y + checkpoint.tangent.y * 9); context.lineTo(checkpoint.point.x + checkpoint.tangent.x * 3 + checkpoint.normal.x * 4, checkpoint.point.y + checkpoint.tangent.y * 3 + checkpoint.normal.y * 4); context.stroke();
    context.fillStyle = "#f1d28f"; context.font = "600 10px system-ui"; context.fillText(`CP${index}`, checkpoint.point.x + 6, checkpoint.point.y - 6);
  }
  const line = startLine(activeTrack); const lineOffset = activeTrack.width / 2 + CAR_WIDTH; const startA = addCanvasPoint(line.point, { x: line.normal.x * lineOffset, y: line.normal.y * lineOffset }); const startB = addCanvasPoint(line.point, { x: -line.normal.x * lineOffset, y: -line.normal.y * lineOffset });
  context.strokeStyle = "#9ed5ff"; context.lineWidth = 5; context.beginPath(); context.moveTo(startA.x, startA.y); context.lineTo(startB.x, startB.y); context.stroke();
  for (let index = 0; index < activeTrack.points.length; index += 2) { const marker = activeTrack.points[index]; context.fillStyle = "#7aa18c"; context.globalAlpha = 0.28; context.beginPath(); context.arc(marker.x, marker.y, 3, 0, TAU); context.fill(); }
  context.restore();
}

function addCanvasPoint(point: { x: number; y: number }, offset: { x: number; y: number }): { x: number; y: number } { return { x: point.x + offset.x, y: point.y + offset.y }; }

function drawCar(car: Car, alpha = 1): void {
  context.save(); context.translate(WIDTH / 2 + car.position.x, HEIGHT / 2 + car.position.y); context.rotate(car.heading); context.globalAlpha = alpha;
  context.fillStyle = "rgba(0,0,0,.35)"; context.beginPath(); context.ellipse(2, 3, CAR_WIDTH + 2, CAR_WIDTH * 0.58, 0, 0, TAU); context.fill(); context.fillStyle = car.color; context.fillRect(-12, -CAR_WIDTH / 2, 24, CAR_WIDTH); context.fillStyle = "#d8e4ed"; context.fillRect(2, -5, 7, 10); context.fillStyle = "#0e1419"; context.fillRect(-9, -9, 6, 3); context.fillRect(-9, 6, 6, 3);
  if (car.isObstacle) { context.strokeStyle = "#2a1718"; context.lineWidth = 2; context.beginPath(); context.moveTo(-9, -5); context.lineTo(9, 5); context.moveTo(9, -5); context.lineTo(-9, 5); context.stroke(); }
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
      const visibleObstacles = ghostEvolution ? (trainingGhostObstacles[0] ?? trainingObstacles) : trainingObstacles;
      visibleObstacles.filter((car) => car.trackId === activeTrack.id).forEach((car) => drawCar(car, 0.9));
      updateRewardTelemetry(leader); updateNeural(leader?.network);
    } else {
      const activeCandidate = trainingPopulation[trainingIndex];
      if (activeCandidate?.trackId === activeTrack.id) drawCar(activeCandidate, 0.95);
      trainingObstacles.filter((car) => car.trackId === activeTrack.id).forEach((car) => drawCar(car, 0.9));
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
    if (car.isObstacle) return;
    const action = car === fly && manualMode ? manualAction() : car.isFly && car.network ? car.network.step(sensorValues(car, raceCars, activeTrack)) : heuristicAction(car, raceCars, activeTrack);
    const previousTimeLimit = car.timeLimit; car.action = action; stepCar(car, action, raceCars, activeTrack, rewardConfig, physicsConfig);
    if (car.isFly && car.timeLimit > previousTimeLimit) appendEvent(`adaptive time extension ${car.timeExtensions}/${physicsConfig.maxAdaptiveExtensions ?? MAX_ADAPTIVE_EXTENSIONS} · limit increased to ${car.timeLimit} ticks`);
  });
  if (fly) {
    const lapPercent = Math.round(fly.progress * 100);
    ui.progress.textContent = `${lapPercent}%`;
    ui.speed.textContent = fly.speed.toFixed(1);
    updateRewardTelemetry(fly);
    if (!fly.finished) setProgress(fly.progress, `lap ${lapPercent}%`, `speed ${fly.speed.toFixed(1)} · time ${fly.ticks}/${fly.timeLimit} · checkpoints ${fly.checkpointsPassed}/${physicsConfig.checkpointCount ?? CHECKPOINT_COUNT} · collisions ${fly.collisions}`);
    if (fly.finished && !flyFinishAnnounced) {
      flyFinishAnnounced = true;
      setRunState("Finish line crossed", `Fly pilot completed a lap on ${activeTrack.name} with reward ${fly.score.toFixed(1)}.`, "ready", "FINISH");
      setProgress(1, "100% · lap complete", "finish reward applied · press Start race to run again");
      appendEvent(`finish line crossed on ${activeTrack.name} · lap reward ${rewardConfig.finish.toFixed(1)}`);
    }
    if (fly.timedOut && !fly.finished && !flyFinishAnnounced) {
      flyFinishAnnounced = true;
      setRunState("Time limit", `Fly pilot reached its ${fly.timeLimit}-tick limit without completing the lap.`, "paused", "TIME LIMIT");
      appendEvent(`time limit reached on ${activeTrack.name} · no crash recorded`);
    }
  }
}

function makeTrainingCar(network: SpikingNetwork, lane = 0, route: TrackDefinition = activeTrack): Car { network.reset(); const car = startPosition(lane, route); car.network = network; car.color = "#8191aa"; car.isFly = true; return car; }

function makeFiveBrainCar(network: SpikingNetwork, index: number, route: TrackDefinition): Car {
  const lanes = [-1.15, 1.15, -0.45, 0.45, 0]; const colors = ["#74c0ff", "#f19a69", "#e9d26d", "#b48cff", "#7cf0b6"];
  const column = index % lanes.length; const row = Math.floor(index / lanes.length);
  const car = createGridCar(lanes[column], row * 86 + (column === 4 ? 42 : 0), colors[index % colors.length], `brain ${index + 1}`, route);
  car.network = network; car.isFly = true; network.reset(); return car;
}

function ensureWorkingCheckpoint(): void {
  if (!bestNetwork && trainingNetworks[0]) bestNetwork = trainingNetworks[0].clone();
}

function trainFiveBrainStep(): void {
  const route = trainingTracks[trainingTrackIndex];
  const sharedSimulationCars = [...trainingPopulation, ...trainingObstacles];
  trainingPopulation.forEach((car, index) => {
    if (!car.network || car.crashed || car.finished || car.timedOut) return;
    const candidateObstacles = ghostEvolution ? (trainingGhostObstacles[index] ?? []) : trainingObstacles;
    const simulationCars = ghostEvolution ? [car, ...candidateObstacles] : sharedSimulationCars;
    const previousTimeLimit = car.timeLimit;
    car.action = car.network.step(sensorValues(car, simulationCars, route));
    stepCar(car, car.action, simulationCars, route, rewardConfig, physicsConfig);
    if (car.timeLimit > previousTimeLimit) appendEvent(`${car.name} earned adaptive extension ${car.timeExtensions}/${physicsConfig.maxAdaptiveExtensions ?? MAX_ADAPTIVE_EXTENSIONS} · new limit ${car.timeLimit} ticks`);
  });
  const tick = Math.max(0, ...trainingPopulation.map((car) => car.ticks));
  const episodesPerGeneration = Math.max(1, trainingTracks.length);
  const generationEpisodes = trainingPopulationSize * episodesPerGeneration;
  const completedEpisodes = (trainingGeneration - 1) * generationEpisodes + trainingTrackIndex * trainingPopulationSize;
  const leader = [...trainingPopulation].sort((a, b) => b.score - a.score)[0];
  const displayedTimeLimit = Math.max(MAX_TICKS, ...trainingPopulation.map((car) => car.timeLimit));
  const liveFraction = Math.min(1, tick / MAX_TICKS);
  setProgress((completedEpisodes + liveFraction * trainingPopulationSize) / Math.max(1, requestedGenerations * generationEpisodes), `generation ${trainingGeneration}/${requestedGenerations} · ${trainingPopulationSize} brains racing · ${route.name}`, `visual race · ${tick}/${displayedTimeLimit} ticks · leader checkpoints ${leader?.checkpointsPassed ?? 0}/${physicsConfig.checkpointCount ?? CHECKPOINT_COUNT} · winner is ranked by averaged fitness`);
  const finished = trainingPopulation.every((car) => car.crashed || car.finished || car.timedOut);
  if (leader) {
    updateRewardTelemetry(leader);
    ui.fitness.textContent = leader.score.toFixed(1);
    ui.progress.textContent = `${Math.round(leader.totalProgress * 100)}%`;
  }
  if (!finished) return;
  trainingPopulation.forEach((car, index) => { trainingScores[index] += car.score; trainingProgresses[index] += car.totalProgress; });
  trainingPopulation.forEach(recordTrainingTrace);
  const currentLeader = [...trainingPopulation].sort((a, b) => b.score - a.score)[0];
  appendEvent(`${trainingPopulationSize}-brain race finished ${route.name} · leader ${currentLeader?.name ?? "unknown"} · fitness ${currentLeader?.score.toFixed(1) ?? "—"}`);
  if (trainingTrackIndex + 1 < trainingTracks.length) {
    trainingTrackIndex += 1; activeTrack = trainingTracks[trainingTrackIndex];
    trainingPopulation = trainingNetworks.map((network, index) => makeFiveBrainCar(network, index, activeTrack));
      refreshTrainingObstacles(activeTrack, trainingWorldSeed + trainingTrackIndex * 97);
    appendEvent(`${trainingPopulationSize} brains reset for ${activeTrack.name}; previous track scores retained`);
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
  const cars = [car, ...trainingObstacles]; const previousTimeLimit = car.timeLimit; car.action = car.network.step(sensorValues(car, cars, trainingTracks[trainingTrackIndex])); stepCar(car, car.action, cars, trainingTracks[trainingTrackIndex], rewardConfig, physicsConfig);
  if (car.timeLimit > previousTimeLimit) appendEvent(`candidate ${trainingIndex + 1} earned adaptive extension ${car.timeExtensions}/${physicsConfig.maxAdaptiveExtensions ?? MAX_ADAPTIVE_EXTENSIONS} · new limit ${car.timeLimit} ticks`);
  updateRewardTelemetry(car);
  const episodeCount = Math.max(1, trainingTracks.length); const totalEpisodes = Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations);
  const completedEpisodes = (trainingGeneration - 1) * trainingPopulationSize * episodeCount + trainingIndex * episodeCount + trainingTrackIndex;
  const candidateFraction = Math.min(1, car.ticks / MAX_TICKS);
  const route = trainingTracks[trainingTrackIndex];
  setProgress((completedEpisodes + candidateFraction) / totalEpisodes, `generation ${trainingGeneration}/${requestedGenerations} · candidate ${trainingIndex + 1}/${trainingPopulationSize} · ${route.name}`, `visual · tick ${car.ticks}/${car.timeLimit} · checkpoints ${car.checkpointsPassed}/${physicsConfig.checkpointCount ?? CHECKPOINT_COUNT} · direction ${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`);
  if (car.crashed || car.finished || car.timedOut) {
    recordTrainingTrace(car);
    trainingScores[trainingIndex] += car.score;
    trainingProgresses[trainingIndex] += car.totalProgress;
    const terminalReason = car.finished ? " · finish line" : car.crashed ? " · crashed" : car.timedOut ? " · time limit" : "";
    appendEvent(`candidate ${trainingIndex + 1}/${trainingPopulationSize} finished ${route.name} · fitness ${car.score.toFixed(1)}${terminalReason}`);
    if (trainingTrackIndex + 1 < trainingTracks.length) {
      trainingTrackIndex += 1; activeTrack = trainingTracks[trainingTrackIndex];
      trainingPopulation[trainingIndex] = makeTrainingCar(car.network, (trainingIndex % 3) - 1, trainingTracks[trainingTrackIndex]);
      refreshTrainingObstacles(activeTrack, trainingWorldSeed + trainingTrackIndex * 97);
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
  refreshTrainingObstacles(activeTrack, trainingWorldSeed);
  trainingIndex = 0;
  trainingPopulation.forEach((car) => car.network?.reset());
  const episodeCount = Math.max(1, trainingTracks.length);
  const evolutionLabel = ghostEvolution ? "ghost evolution · isolated candidates" : "shared-track evolution · collision dynamics enabled";
  updateEvolutionTelemetry();
  setProgress(((trainingGeneration - 1) * trainingPopulationSize * episodeCount) / Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations), fiveBrainEvolution ? `generation ${trainingGeneration}/${requestedGenerations} · ${trainingPopulationSize} brains · ${trainingTracks[0].name}` : `generation ${trainingGeneration}/${requestedGenerations} · candidate 1/${trainingPopulationSize} · ${trainingTracks[0].name}`, fiveBrainEvolution ? evolutionLabel : "visual · preparing candidate");
}

function breed(): void {
  const ranked = [...trainingNetworks].map((network, index) => ({ network, score: trainingPopulation[index]?.score ?? -Infinity })).sort((a, b) => b.score - a.score);
  const candidate = ranked[0];
  if (!candidate || !Number.isFinite(candidate.score)) throw new Error("generation produced no finite brain fitness");
  const winner = trainingPopulation.find((car) => car.network === candidate.network);
  const winnerProgress = winner?.totalProgress ?? winner?.progress ?? 0;
  const progressGain = winnerProgress - previousGenerationProgress;
  const progressStalled = trainingGeneration > 1 && progressGain < 0.02;
  const improved = !bestNetwork || candidate.score > bestFitness;
  if (improved) {
    bestNetwork = candidate.network.clone(); bestFitness = candidate.score; generation = trainingGeneration;
    plateauStreak = 0;
  } else {
    plateauStreak += 1;
  }
  previousGenerationProgress = Math.max(previousGenerationProgress, winnerProgress);
  if (progressStalled || !improved) {
    mutationRate = clamp(mutationRate * 1.28 + 0.01, DEFAULT_MUTATION_RATE, 0.65);
    mutationAmount = clamp(mutationAmount * 1.22 + 0.01, DEFAULT_MUTATION_AMOUNT, 0.85);
  } else {
    mutationRate = clamp(mutationRate * 0.92, DEFAULT_MUTATION_RATE, 0.65);
    mutationAmount = clamp(mutationAmount * 0.94, DEFAULT_MUTATION_AMOUNT, 0.85);
  }
  const exploring = plateauExplorationEnabled && plateauStreak >= plateauPatience;
  updateEvolutionTelemetry();
  ui.generation.textContent = `${generation}`; ui.fitness.textContent = bestFitness.toFixed(1); ui.progress.textContent = `${Math.round(winnerProgress * 100)}%`;
  recordEvolutionPoint(candidate.score, winnerProgress);
  const result = improved ? `accepted new incumbent ${bestFitness.toFixed(1)}` : `rejected candidate ${candidate.score.toFixed(1)}; incumbent remains ${bestFitness.toFixed(1)}`;
  const reason = progressStalled ? "progress stalled" : improved ? "progress improved" : "fitness did not improve";
  rememberTrainingContext();
  const lateRanked = ranked[Math.max(0, ranked.length - 2)]?.network;
  const breedingPool = [candidate.network, ranked[1]?.network, lateRanked].filter((network, index, networks): network is SpikingNetwork => Boolean(network) && networks.indexOf(network) === index);
  appendEvent(`generation ${trainingGeneration} complete · ${result} · ${reason} · plateau ${plateauStreak}/${plateauPatience} · ${exploring ? "exploration burst with random immigrants" : "local mutations"} · mutation ${(mutationRate * 100).toFixed(0)}% / ${(mutationAmount).toFixed(2)} · next generation keeps parent at slot 1, crosses winner with runner-up/late-rank, then mutates ${Math.max(0, ranked.length - 1)} variants`);
  persistBestBrain();
  trainingNetworks = createMutationPopulation(ranked.length, bestNetwork, trainingWorldSeed + trainingGeneration * 1000, mutationRate, mutationAmount, { plateauStreak: plateauExplorationEnabled ? plateauStreak : 0, plateauPatience, breedingPool });
}

function finishVisualGeneration(): void { breed(); if (trainingGeneration >= requestedGenerations) finishTraining(); else { trainingGeneration += 1; startVisualGeneration(); } }

async function runHeadless(): Promise<void> {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = false; fiveBrainEvolution = false; ghostEvolution = ui.ghostEvolutionToggle.checked; manualMode = false; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 5, 2, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig(); readEvolutionConfig(); activeTrack = trainingTracks[0]; prepareTrainingContext(); trainingWorldSeed = 7000; plateauStreak = 0; mutationRate = DEFAULT_MUTATION_RATE; mutationAmount = DEFAULT_MUTATION_AMOUNT; previousGenerationProgress = 0; resetEvolutionHistory(); trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, trainingWorldSeed); ensureWorkingCheckpoint(); updateEvolutionTelemetry();
  beginRun("Headless training", `Evaluating ${trainingPopulationSize} controllers across ${requestedGenerations} generations on ${selectedTrackLabel()}${ghostEvolution ? " in isolated ghost worlds" : " with traffic bots"}${randomObjectsEnabled ? ` and ${trainingObstacleCount()} road objects` : ""}${curriculumEnabled ? " on a progressive hazard curriculum" : ""}.`, "HEADLESS TRAINING");
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
        const result = evaluateGeneralist(car.network as SpikingNetwork, trainingTracks, rewardConfig, physicsConfig, ghostEvolution, trainingObstacleCount(), trainingWorldSeed); car.score = result.fitness; car.progress = result.progress; car.totalProgress = result.progress; car.finished = result.finished; car.laps = result.laps; car.rewardTotals = result.rewardTotals; car.rewardBreakdown = result.rewardTotals; car.lastReward = 0; car.forwardAlignment = 0;
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
  trainingPopulationSize = readInteger(ui.population, 5, 2, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig(); readEvolutionConfig(); activeTrack = trainingTracks[0]; prepareTrainingContext(); trainingWorldSeed = 5000; plateauStreak = 0; mutationRate = DEFAULT_MUTATION_RATE; mutationAmount = DEFAULT_MUTATION_AMOUNT; previousGenerationProgress = 0; resetEvolutionHistory(); trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, trainingWorldSeed); ensureWorkingCheckpoint(); updateEvolutionTelemetry();
  beginRun("Visual training", `Watching ${trainingPopulationSize} candidates drive across ${requestedGenerations} generations on ${selectedTrackLabel()}${randomObjectsEnabled ? ` with ${trainingObstacleCount()} road objects` : ""}${curriculumEnabled ? " on a progressive hazard curriculum" : ""}.`, "VISUAL TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function startFiveBrainEvolution(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; fiveBrainEvolution = true; ghostEvolution = ui.ghostEvolutionToggle.checked; manualMode = false; trainingHistory = []; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 5, 2, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig(); readEvolutionConfig(); activeTrack = trainingTracks[0]; prepareTrainingContext(); trainingWorldSeed = 9000; plateauStreak = 0; mutationRate = DEFAULT_MUTATION_RATE; mutationAmount = DEFAULT_MUTATION_AMOUNT; previousGenerationProgress = 0; resetEvolutionHistory(); trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, trainingWorldSeed); ensureWorkingCheckpoint(); updateEvolutionTelemetry();
  const mode = ghostEvolution ? "isolated ghost worlds (no candidate sensing, collisions, or influence)" : "a shared physical track";
  beginRun("Population evolution", `Racing ${trainingPopulationSize} brains simultaneously in ${mode} for ${requestedGenerations} generations on ${selectedTrackLabel()}${randomObjectsEnabled ? ` with ${randomObjectCount} road objects` : ""}.`, "POPULATION EVOLUTION");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function scheduleVisualBatch(session: number): void {
  if (!visualTraining || trainingSession !== session) return;
  try { for (let index = 0; index < 24 && visualTraining; index += 1) trainPopulationStep(); }
  catch (error) { if (trainingSession === session) failTraining(error); return; }
  visualTimer = window.setTimeout(() => scheduleVisualBatch(session), 16);
}

function finishTraining(): void {
  training = false; visualTraining = false; fiveBrainEvolution = false; clearVisualTimer(); trainingPopulation = []; trainingGhostObstacles = []; setBusy(false); launchRace();
  const detail = `training complete — best fitness ${bestFitness.toFixed(1)} at generation ${generation}; the trained fly is now racing`;
  setRunState("Training complete", detail, "ready", "RACE MODE"); setProgress(1, "100% · complete", "trained controller deployed in race mode"); appendEvent(detail);
}

function failTraining(error: unknown): void {
  training = false; visualTraining = false; fiveBrainEvolution = false; clearVisualTimer(); trainingPopulation = []; trainingGhostObstacles = []; setBusy(false);
  const detail = error instanceof Error ? error.message : "unknown training error";
  setRunState("Training error", detail, "error", "TRAINING ERROR"); appendEvent(`training failed: ${detail}`); console.error("FlyKart training failed", error);
}

function stopAll(): void {
  trainingSession += 1; const wasTraining = training; training = false; visualTraining = false; fiveBrainEvolution = false; running = false; clearVisualTimer(); trainingPopulation = []; trainingGhostObstacles = []; setBusy(false);
  const detail = wasTraining ? "training stopped before completion; the best controller found so far is kept" : "race paused; press Start race or train again to continue";
  setRunState("Paused", detail, "paused", "PAUSED"); appendEvent(wasTraining ? "training stopped by user" : "race paused by user");
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" ? error : "unknown application error"; }

function failApplication(error: unknown): void {
  trainingSession += 1; training = false; visualTraining = false; fiveBrainEvolution = false; running = false; clearVisualTimer(); trainingPopulation = []; trainingGhostObstacles = []; setBusy(false);
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
ui.copyLogButton.addEventListener("click", () => { void copyAllLog(); });
ui.trackSelect.addEventListener("change", () => { if (!training) safely(() => { activateStoredContextForRace(); launchRace(); }); });
ui.wallsToggle.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(physicsConfig.wallsEnabled ? "track walls enabled · off-track recovery is active" : "track walls disabled · cars may leave the road and only receive off-track penalties"); });
ui.adaptiveTimeToggle.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(physicsConfig.adaptiveTimeLimit ? `adaptive time enabled · up to ${physicsConfig.maxAdaptiveExtensions} evidence-based extensions` : "adaptive time disabled · candidates stop at the base tick limit"); });
ui.adaptiveExtensions.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(`adaptive extension limit set to ${physicsConfig.maxAdaptiveExtensions}`); });
ui.checkpointCount.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(`checkpoint gate count set to ${physicsConfig.checkpointCount}; ordered gates will be rebuilt on the next run`); });
ui.ghostEvolutionToggle.addEventListener("change", () => { ghostEvolution = ui.ghostEvolutionToggle.checked; appendEvent(ghostEvolution ? "ghost evolution enabled · candidates run simultaneously but cannot see, collide with, or influence one another" : "shared-track evolution enabled · candidates now learn traffic interactions"); });
ui.obstacleToggle.addEventListener("change", () => { readRoadObjectConfig(); appendEvent(randomObjectsEnabled ? `random road objects enabled · ${randomObjectCount} stalled objects per episode` : "random road objects disabled"); });
ui.obstacleCount.addEventListener("change", () => { readRoadObjectConfig(); appendEvent(`random road object count set to ${randomObjectCount}`); });
ui.plateauExplorationToggle.addEventListener("change", () => { readEvolutionConfig(); updateEvolutionTelemetry(); appendEvent(plateauExplorationEnabled ? `plateau exploration enabled · patience ${plateauPatience} generations` : "plateau exploration disabled · mutation stays local"); });
ui.plateauPatience.addEventListener("change", () => { readEvolutionConfig(); updateEvolutionTelemetry(); appendEvent(`plateau patience set to ${plateauPatience} generations`); });
ui.curriculumToggle.addEventListener("change", () => { readEvolutionConfig(); appendEvent(curriculumEnabled ? "progressive hazards enabled · obstacle count ramps with training" : "progressive hazards disabled · obstacle count stays fixed"); });
[ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardEdge, ui.rewardProximity, ui.rewardCenterline, ui.rewardCollision, ui.rewardCrash, ui.rewardCheckpoint, ui.rewardFinish].forEach((input) => {
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
  readEvolutionConfig(); updateEvolutionTelemetry(); resetEvolutionHistory();
  launchRace();
  setRunState("Ready to race", "The demo brain is driving now. Choose a training mode to evolve a better fly pilot.", "ready", "RACE MODE");
  appendEvent("application ready · choose a command to begin");
  window.dispatchEvent(new Event("flykart:ready"));
  requestAnimationFrame(frame);
} catch (error) {
  failApplication(error);
}
