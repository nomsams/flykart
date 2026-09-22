import "./style.css";
import {
  BrainSnapshot, CAR_WIDTH, CHECKPOINT_COUNT, LANE_SPACING, MAX_ADAPTIVE_EXTENSIONS, Car, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, PhysicsConfig, RewardConfig, RoadObjectKind, STEP, TAU, TRACKS, TrackDefinition, Vec,
  SpikingNetwork, blendedEvolutionSelectionScore, clamp, compareEvolutionCandidates, createMutationPopulation, createRoadObstacles, evaluateGeneralist, heuristicAction, nearestTrack, pointAtDistance, resolveTrack, sensorValues, shouldAcceptEvolutionCandidate, startLine, startPosition, stepCar, trackCheckpoint, trackDiagnostics,
} from "./core";

const WIDTH = 960;
const HEIGHT = 600;
const MODEL_STORAGE_KEY = "flykart.best-brain.v1";
const CHECKPOINT_VERSION = 1;
const VISUAL_TRAINING_STEPS_PER_FRAME = 4;

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("Game canvas is missing");
const context = canvas.getContext("2d")!;
if (!context) throw new Error("Canvas rendering is unavailable");
// Reward bands are rendered on a transparent layer and clipped with the same
// wide stroke as the road. This keeps offset bands inside the asphalt when a
// route folds back on itself or turns sharply.
const rewardFieldCanvas = document.createElement("canvas");
rewardFieldCanvas.width = WIDTH;
rewardFieldCanvas.height = HEIGHT;
const rewardFieldContext = rewardFieldCanvas.getContext("2d");
if (!rewardFieldContext) throw new Error("Reward-field rendering is unavailable");

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
  trackSelect: required<HTMLSelectElement>("#track-select"), trackProvenance: required<HTMLElement>("#track-provenance"), wallsToggle: required<HTMLInputElement>("#walls-toggle"), adaptiveTimeToggle: required<HTMLInputElement>("#adaptive-time-toggle"), adaptiveExtensions: required<HTMLInputElement>("#adaptive-extensions"), checkpointCount: required<HTMLInputElement>("#checkpoint-count"), ghostEvolutionToggle: required<HTMLInputElement>("#ghost-evolution-toggle"), softContactToggle: required<HTMLInputElement>("#soft-contact-toggle"), obstacleToggle: required<HTMLInputElement>("#obstacle-toggle"), obstacleCount: required<HTMLInputElement>("#obstacle-count"), obstacleKind: required<HTMLSelectElement>("#obstacle-kind"), plateauExplorationToggle: required<HTMLInputElement>("#plateau-exploration-toggle"), plateauPatience: required<HTMLInputElement>("#plateau-patience"), breedingProgressWeight: required<HTMLInputElement>("#breeding-progress-weight"), breedingPriorityValue: required<HTMLOutputElement>("#breeding-priority-value"), winnerMatingShare: required<HTMLInputElement>("#winner-mating-share"), curriculumToggle: required<HTMLInputElement>("#curriculum-toggle"),
  rewardProgress: required<HTMLInputElement>("#reward-progress"), rewardDirection: required<HTMLInputElement>("#reward-direction"), rewardMoving: required<HTMLInputElement>("#reward-moving"),
  rewardStanding: required<HTMLInputElement>("#reward-standing"), rewardWrong: required<HTMLInputElement>("#reward-wrong"), rewardReverse: required<HTMLInputElement>("#reward-reverse"),
  rewardOffTrack: required<HTMLInputElement>("#reward-offtrack"), rewardEdge: required<HTMLInputElement>("#reward-edge"), rewardProximity: required<HTMLInputElement>("#reward-proximity"), rewardHazard: required<HTMLInputElement>("#reward-hazard"), rewardCenterline: required<HTMLInputElement>("#reward-centerline"), rewardCollision: required<HTMLInputElement>("#reward-collision"), rewardCrash: required<HTMLInputElement>("#reward-crash"), rewardCheckpoint: required<HTMLInputElement>("#reward-checkpoint"), rewardFinish: required<HTMLInputElement>("#reward-finish"),
  mode: required<HTMLElement>("#mode-label"), hint: required<HTMLElement>("#hint-label"), status: required<HTMLElement>("#training-status"),
  generation: required<HTMLElement>("#generation"), fitness: required<HTMLElement>("#fitness"), progress: required<HTMLElement>("#progress"), plateau: required<HTMLElement>("#plateau"), strategy: required<HTMLElement>("#evolution-strategy"), mutationRate: required<HTMLElement>("#mutation-rate"),
  speed: required<HTMLElement>("#speed"), reward: required<HTMLElement>("#reward"), direction: required<HTMLElement>("#direction"), centerline: required<HTMLElement>("#centerline"), traffic: required<HTMLElement>("#traffic-gap"), penalties: required<HTMLElement>("#penalties"), rewardBreakdown: required<HTMLElement>("#reward-breakdown"), bars: required<HTMLElement>("#neural-bars"),
  runState: required<HTMLElement>("#run-state"), runDetail: required<HTMLElement>("#run-detail"),
  runProgressTrack: required<HTMLElement>("#run-progress-track"), runProgressBar: required<HTMLElement>("#run-progress-bar"),
  runProgressText: required<HTMLElement>("#run-progress-text"), runStepText: required<HTMLElement>("#run-step-text"),
  runElapsed: required<HTMLElement>("#run-elapsed"), eventLog: required<HTMLOListElement>("#event-log"), copyLogButton: required<HTMLButtonElement>("#copy-log-btn"),
  plotSummary: required<HTMLElement>("#plot-summary"), plotTooltip: required<HTMLElement>("#plot-tooltip"), trackInfo: required<HTMLElement>("#track-info"),
  familyTree: required<HTMLElement>("#family-tree"), breedingBoard: required<HTMLElement>("#breeding-board"), lineageCount: required<HTMLElement>("#lineage-count"), useLineageButton: required<HTMLButtonElement>("#use-lineage-btn"), downloadLineageButton: required<HTMLButtonElement>("#download-lineage-btn"), lineageDetail: required<HTMLElement>("#lineage-detail"),
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
let softContactEvolution = false;
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
type LineageNodeStatus = "candidate" | "retained" | "rejected" | "immigrant";
type BreedingMode = "seed" | "incumbent" | "crossover" | "mutation" | "immigrant";
type BreedingRecord = { mode: BreedingMode; parentIds: string[]; firstShare: number; secondShare: number; mutationRate: number; mutationAmount: number };
type LineageNode = { id: string; name: string; generation: number; index: number; parentIds: string[]; network: SpikingNetwork; score?: number; progress?: number; finished?: boolean; status: LineageNodeStatus; breeding?: BreedingRecord };
const LINEAGE_NAMES = ["Aster", "Brio", "Cinder", "Dune", "Echo", "Fable", "Glim", "Hush", "Iris", "Jolt", "Kite", "Lumen", "Mica", "Nori", "Orbit", "Pip", "Quill", "Rook", "Sable", "Tango", "Umber", "Vega", "Wisp", "Xeno", "Yarrow", "Zest"];
const MAX_LINEAGE_NODES = 320;
let lineageNodes: LineageNode[] = [];
let trainingLineageIds: string[] = [];
let selectedLineageId: string | undefined;
let selectedLineageNetwork: SpikingNetwork | undefined;
let lineageSerial = 0;
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
let randomObjectKind: RoadObjectKind | "mixed" = "stalled-car";
let plateauExplorationEnabled = true;
let plateauPatience = 3;
let plateauStreak = 0;
let plateauReason = "none";
let curriculumEnabled = false;
let winnerMatingShare = 80;
let breedingProgressWeight = 100;
let trainingWorldSeed = 0;
type TrainingContextKey = TrackDefinition["id"] | "all";
type TrainingProvenance = { context: TrainingContextKey; trained: boolean; source: string; bestFitness: number | null; bestProgress: number; finished: boolean; generation: number };
let activeTrainingContext: TrainingContextKey = DEFAULT_TRACK.id;
const contextNetworks = new Map<TrainingContextKey, SpikingNetwork>();
const contextFitness = new Map<TrainingContextKey, number>();
const contextGenerations = new Map<TrainingContextKey, number>();
const contextProvenance = new Map<TrainingContextKey, TrainingProvenance>();
let freshTrainingContext = false;
let warmStartLabel = "demo brain";
let bestProgressForContext = 0;
let bestFinishedForContext = false;
const DEFAULT_MUTATION_RATE = 0.12;
const DEFAULT_MUTATION_AMOUNT = 0.22;
let mutationRate = DEFAULT_MUTATION_RATE;
let mutationAmount = DEFAULT_MUTATION_AMOUNT;
let previousGenerationProgress = 0;
let activeTrack: TrackDefinition = DEFAULT_TRACK;
let flyFinishAnnounced = false;
let runStartedAt: number | undefined;
let eventHistory: string[] = [];
type EvolutionPoint = { generation: number; bestFitness: number; candidateFitness: number; progress: number; candidateProgress: number; plateauStreak: number; mutationRate: number; mutationAmount: number; plateauReason: string; candidateLineageId?: string; candidateName?: string };
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
  const distanceFromBottom = ui.eventLog.scrollHeight - ui.eventLog.scrollTop - ui.eventLog.clientHeight;
  const shouldFollowTail = distanceFromBottom <= 20;
  const previousScrollTop = ui.eventLog.scrollTop;
  const visibleEvents = eventHistory.slice(-32);
  ui.eventLog.replaceChildren();
  visibleEvents.forEach((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    ui.eventLog.appendChild(item);
  });
  ui.eventLog.scrollTop = shouldFollowTail ? ui.eventLog.scrollHeight : previousScrollTop;
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
    hazardPenaltyPerSecond: readNumber(ui.rewardHazard, DEFAULT_REWARD_CONFIG.hazardPenaltyPerSecond, 0, 100),
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
  randomObjectKind = ui.obstacleKind.value as RoadObjectKind | "mixed";
}

function readEvolutionConfig(): void {
  plateauExplorationEnabled = ui.plateauExplorationToggle.checked;
  plateauPatience = readInteger(ui.plateauPatience, 3, 1, 20);
  winnerMatingShare = readInteger(ui.winnerMatingShare, 80, 50, 95);
  breedingProgressWeight = readInteger(ui.breedingProgressWeight, 100, 0, 100);
  ui.breedingPriorityValue.value = `${breedingProgressWeight}% progress · ${100 - breedingProgressWeight}% reward`;
  ui.breedingPriorityValue.textContent = ui.breedingPriorityValue.value;
  curriculumEnabled = ui.curriculumToggle.checked;
  softContactEvolution = ui.softContactToggle.checked;
}

function selectedTrainingContext(): TrainingContextKey {
  return ui.trackSelect.value === "all" ? "all" : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]).id;
}

function contextLabel(context: TrainingContextKey): string {
  return context === "all" ? "Generalist" : resolveTrack(context).name;
}

function isTrainingContext(value: unknown): value is TrainingContextKey {
  return value === "all" || (typeof value === "string" && TRACKS.some((route) => route.id === value));
}

function restoreProvenance(value: unknown): void {
  if (!Array.isArray(value)) return;
  value.forEach((candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Partial<TrainingProvenance>;
    if (!isTrainingContext(record.context) || typeof record.trained !== "boolean" || typeof record.source !== "string" || (record.bestFitness !== null && (typeof record.bestFitness !== "number" || !Number.isFinite(record.bestFitness))) || (record.bestProgress !== undefined && (typeof record.bestProgress !== "number" || !Number.isFinite(record.bestProgress))) || (record.finished !== undefined && typeof record.finished !== "boolean") || typeof record.generation !== "number") return;
    contextProvenance.set(record.context, { context: record.context, trained: record.trained, source: record.source, bestFitness: record.bestFitness, bestProgress: clamp(record.bestProgress ?? 0, 0, 1), finished: record.finished === true, generation: Math.max(0, Math.floor(record.generation)) });
  });
}

function updateTrackProvenance(): void {
  const context = selectedTrainingContext();
  const record = contextProvenance.get(context);
  const trained = [...contextProvenance.values()].filter((candidate) => candidate.trained).map((candidate) => contextLabel(candidate.context));
  const trainedSummary = trained.length > 0 ? ` · trained contexts: ${trained.join(", ")}` : " · no local generations yet";
  if (!record || !record.trained) {
    const source = record?.source ?? warmStartLabel;
    ui.trackProvenance.textContent = `NEW ROUTE · local score baseline reset · warm-start: ${source}${trainedSummary}`;
    ui.trackProvenance.className = "track-provenance new-route";
    return;
  }
  const score = record.bestFitness === null ? "pending" : record.bestFitness.toFixed(1);
  ui.trackProvenance.textContent = `TRAINED HERE · best local score ${score} · coverage ${(record.bestProgress * 100).toFixed(1)}%${record.finished ? " · lap finished" : ""} · generation ${record.generation}${trainedSummary}`;
  ui.trackProvenance.className = "track-provenance trained-route";
}

function updateBestMetrics(): void {
  ui.generation.textContent = `${generation}`;
  ui.fitness.textContent = Number.isFinite(bestFitness) ? bestFitness.toFixed(1) : "—";
}

function prepareTrainingContext(): void {
  const previousContext = activeTrainingContext;
  activeTrainingContext = selectedTrainingContext();
  const stored = contextNetworks.get(activeTrainingContext);
  if (stored) {
    bestNetwork = stored.clone(); bestFitness = contextFitness.get(activeTrainingContext) ?? -Infinity; generation = contextGenerations.get(activeTrainingContext) ?? 0;
    freshTrainingContext = false;
    warmStartLabel = contextLabel(activeTrainingContext);
    const record = contextProvenance.get(activeTrainingContext); bestProgressForContext = record?.bestProgress ?? 0; bestFinishedForContext = record?.finished ?? false;
  } else {
    // Reuse the current brain as a warm-start, but never compare its old
    // track score against this track's first generation. The old brain is
    // retained as slot 1 of generation 1; all fitness starts locally.
    freshTrainingContext = true;
    warmStartLabel = bestNetwork ? contextLabel(previousContext) : "demo brain";
    bestFitness = -Infinity; generation = 0;
    bestProgressForContext = 0; bestFinishedForContext = false;
    contextProvenance.set(activeTrainingContext, { context: activeTrainingContext, trained: false, source: warmStartLabel, bestFitness: null, bestProgress: 0, finished: false, generation: 0 });
  }
  updateBestMetrics(); updateTrackProvenance();
}

function rememberTrainingContext(): void {
  if (!bestNetwork || !Number.isFinite(bestFitness)) return;
  contextNetworks.set(activeTrainingContext, bestNetwork.clone()); contextFitness.set(activeTrainingContext, bestFitness); contextGenerations.set(activeTrainingContext, generation);
  contextProvenance.set(activeTrainingContext, { context: activeTrainingContext, trained: true, source: warmStartLabel, bestFitness, bestProgress: bestProgressForContext, finished: bestFinishedForContext, generation });
  updateTrackProvenance();
}

function activateStoredContextForRace(): void {
  const context = selectedTrainingContext(); const stored = contextNetworks.get(context);
  if (!stored) return;
  activeTrainingContext = context; bestNetwork = stored.clone(); bestFitness = contextFitness.get(context) ?? bestFitness; generation = contextGenerations.get(context) ?? generation; freshTrainingContext = false; warmStartLabel = contextLabel(context); const record = contextProvenance.get(context); bestProgressForContext = record?.bestProgress ?? 0; bestFinishedForContext = record?.finished ?? false; updateBestMetrics(); updateTrackProvenance();
}

function trainingObstacleCount(): number {
  if (!randomObjectsEnabled || randomObjectCount <= 0) return 0;
  if (!curriculumEnabled || requestedGenerations <= 1) return randomObjectCount;
  const difficulty = clamp((trainingGeneration - 1) / Math.max(1, requestedGenerations - 1), 0, 1);
  return Math.max(1, Math.round(randomObjectCount * (0.2 + difficulty * 0.8)));
}

function lineageNodeById(id: string | undefined): LineageNode | undefined {
  return id ? lineageNodes.find((node) => node.id === id) : undefined;
}

function lineageNameForIndex(index: number): string {
  return lineageNodeById(trainingLineageIds[index])?.name ?? `candidate ${index + 1}`;
}

function updateLineageSelection(): void {
  const selected = lineageNodeById(selectedLineageId);
  ui.useLineageButton.disabled = !selected;
  ui.downloadLineageButton.disabled = !selected;
  if (!selected) {
    ui.lineageDetail.textContent = "Click a compact brain node to inspect it.";
    return;
  }
  const parentNames = selected.parentIds.map((id) => lineageNodeById(id)?.name ?? "older brain").join(" × ") || "origin / warm start";
  const score = selected.score === undefined ? "pending evaluation" : `reward ${selected.score.toFixed(1)}`;
  const progress = selected.progress === undefined ? "coverage pending" : `${(selected.progress * 100).toFixed(1)}% coverage`;
  ui.lineageDetail.textContent = `${selected.name} · G${selected.generation} candidate ${selected.index + 1} · ${score} · ${progress}${selected.finished ? " · lap finished" : ""} · parents: ${parentNames}`;
}

function selectLineageNode(id: string): void {
  selectedLineageId = id;
  const node = lineageNodeById(id);
  // Selection is also the source used by the next race. The explicit
  // “Use selected brain” button remains available as a visible confirmation,
  // but clicking a graph point must never leave a stale previously-selected
  // network attached to the new name.
  selectedLineageNetwork = node?.network.clone();
  renderLineageTree();
}

function renderLineageTree(): void {
  ui.familyTree.replaceChildren();
  const latestGeneration = lineageNodes.reduce((latest, node) => Math.max(latest, node.generation), 0);
  const firstVisibleGeneration = Math.max(1, latestGeneration - 7);
  const visible = lineageNodes.filter((node) => node.generation >= firstVisibleGeneration);
  ui.lineageCount.textContent = lineageNodes.length === 0 ? "0 brains" : `${lineageNodes.length} brains · G${latestGeneration}`;
  if (visible.length === 0) {
    const empty = document.createElement("p"); empty.className = "family-tree-empty"; empty.textContent = "Start training to see named candidates and their offspring."; ui.familyTree.appendChild(empty); updateLineageSelection(); renderBreedingBoard(latestGeneration); return;
  }
  const generations = new Map<number, LineageNode[]>();
  visible.forEach((node) => { const group = generations.get(node.generation) ?? []; group.push(node); generations.set(node.generation, group); });
  generations.forEach((nodes, generationNumber) => {
    const generation = document.createElement("section"); generation.className = "family-generation"; generation.setAttribute("aria-label", `Generation ${generationNumber}`);
    const label = document.createElement("span"); label.className = "family-generation-label"; label.textContent = `G${generationNumber}`; generation.appendChild(label);
    const nodeList = document.createElement("div"); nodeList.className = "family-nodes";
    nodes.forEach((node) => {
      const button = document.createElement("button"); button.type = "button"; button.className = `family-node ${node.status}${node.id === selectedLineageId ? " selected" : ""}`; button.setAttribute("role", "treeitem"); button.setAttribute("aria-pressed", node.id === selectedLineageId ? "true" : "false");
      const name = document.createElement("span"); name.className = "family-node-name"; name.textContent = node.name;
      const meta = document.createElement("span"); meta.className = "family-node-meta"; meta.textContent = node.score === undefined ? "pending" : `${node.score.toFixed(0)} · ${(clamp(node.progress ?? 0, 0, 1) * 100).toFixed(0)}%`;
      const parents = document.createElement("span"); parents.className = "family-node-parents"; parents.textContent = node.parentIds.length === 0 ? "origin" : `← ${node.parentIds.map((id) => lineageNodeById(id)?.name ?? "older").join(" × ")}`;
      button.title = `${node.name} · ${node.status} · ${parents.textContent}`; button.append(name, meta, parents); button.addEventListener("click", () => selectLineageNode(node.id)); nodeList.appendChild(button);
    });
    generation.appendChild(nodeList); ui.familyTree.appendChild(generation);
  });
  updateLineageSelection();
  renderBreedingBoard(latestGeneration);
}

function renderBreedingBoard(generationNumber: number): void {
  ui.breedingBoard.replaceChildren();
  const offspring = lineageNodes.filter((node) => node.generation === generationNumber && node.breeding && node.breeding.mode !== "seed");
  if (offspring.length === 0) {
    const empty = document.createElement("p"); empty.className = "breeding-empty"; empty.textContent = "Finish a generation to see its parent pairings, inherited gene mix, and mutation pressure."; ui.breedingBoard.appendChild(empty); return;
  }
  const summary = document.createElement("p"); summary.className = "breeding-summary";
  const crosses = offspring.filter((node) => node.breeding?.mode === "crossover").length;
  const immigrants = offspring.filter((node) => node.breeding?.mode === "immigrant").length;
  summary.textContent = `G${generationNumber} breeding ledger · ${crosses} crossover${crosses === 1 ? "" : "s"} · ${immigrants} immigrant${immigrants === 1 ? "" : "s"} · incumbent clone is protected in slot 1`;
  ui.breedingBoard.appendChild(summary);
  const grid = document.createElement("div"); grid.className = "breeding-grid";
  offspring.forEach((node) => {
    const record = node.breeding!; const card = document.createElement("article"); card.className = `breeding-card ${record.mode}`;
    const heading = document.createElement("div"); heading.className = "breeding-card-heading";
    const child = document.createElement("strong"); child.textContent = node.name;
    const role = document.createElement("span"); role.textContent = record.mode === "crossover" ? "crossbred" : record.mode === "incumbent" ? "incumbent" : record.mode === "immigrant" ? "scout" : "mutant";
    heading.append(child, role); card.appendChild(heading);
    const parentRow = document.createElement("div"); parentRow.className = "breeding-parents";
    if (record.parentIds.length === 0) {
      const origin = document.createElement("span"); origin.className = "breeding-parent origin"; origin.textContent = record.mode === "immigrant" ? "random genome" : "new seed"; parentRow.appendChild(origin);
    } else {
      record.parentIds.forEach((parentId, parentIndex) => {
        const parent = lineageNodeById(parentId); const button = document.createElement("button"); button.type = "button"; button.className = `breeding-parent ${parentIndex === 0 ? "first" : "second"}`; button.textContent = parent?.name ?? "older brain"; button.title = `Select ${parent?.name ?? "older brain"}`; button.addEventListener("click", () => { if (parent) selectLineageNode(parent.id); }); parentRow.appendChild(button);
        if (parentIndex < record.parentIds.length - 1) { const cross = document.createElement("span"); cross.className = "breeding-cross"; cross.textContent = "×"; parentRow.appendChild(cross); }
      });
    }
    card.appendChild(parentRow);
    if (record.mode === "crossover" || record.mode === "incumbent" || record.mode === "mutation") {
      const chromosome = document.createElement("div"); chromosome.className = "chromosome"; chromosome.setAttribute("aria-label", `${Math.round(record.firstShare * 100)}% first parent genes and ${Math.round(record.secondShare * 100)}% second parent genes`);
      const first = document.createElement("span"); first.className = "chromosome-first"; first.style.flexBasis = `${record.firstShare * 100}%`; first.textContent = `${Math.round(record.firstShare * 100)}%`;
      const second = document.createElement("span"); second.className = "chromosome-second"; second.style.flexBasis = `${record.secondShare * 100}%`; second.textContent = record.secondShare > 0 ? `${Math.round(record.secondShare * 100)}%` : "";
      chromosome.append(first, second); card.appendChild(chromosome);
      const mutation = document.createElement("span"); mutation.className = "breeding-mutation"; mutation.textContent = record.mutationRate > 0 ? `mutation ${(record.mutationRate * 100).toFixed(0)}% · amplitude ${record.mutationAmount.toFixed(2)}` : "protected copy · no mutation"; card.appendChild(mutation);
    } else {
      const mutation = document.createElement("span"); mutation.className = "breeding-mutation"; mutation.textContent = "fresh genome · exploration immigrant"; card.appendChild(mutation);
    }
    grid.appendChild(card);
  });
  ui.breedingBoard.appendChild(grid);
}

function resetLineage(): void {
  lineageNodes = []; trainingLineageIds = []; selectedLineageId = undefined; selectedLineageNetwork = undefined; lineageSerial = 0; renderLineageTree();
}

function addLineageNode(network: SpikingNetwork, generationNumber: number, index: number, parentIds: string[], status: LineageNodeStatus, breeding?: BreedingRecord): string {
  const id = `lineage-${generationNumber}-${lineageSerial}`; lineageSerial += 1;
  const name = generationNumber === 1 && index === 0 ? "Origin·G1.1" : `${LINEAGE_NAMES[(generationNumber * 11 + index) % LINEAGE_NAMES.length]}·G${generationNumber}.${index + 1}`;
  lineageNodes.push({ id, name, generation: generationNumber, index, parentIds: [...parentIds], network: network.clone(), status, breeding });
  if (lineageNodes.length > MAX_LINEAGE_NODES) { const removed = lineageNodes.splice(0, lineageNodes.length - MAX_LINEAGE_NODES); if (removed.some((node) => node.id === selectedLineageId)) selectedLineageId = undefined; }
  return id;
}

function registerInitialLineagePopulation(networks: SpikingNetwork[]): void {
  const ids: string[] = [];
  networks.forEach((network, index) => {
    const parentIds = index === 0 ? [] : ids.slice(0, 1);
    const breeding: BreedingRecord = index === 0
      ? { mode: "seed", parentIds, firstShare: 1, secondShare: 0, mutationRate: 0, mutationAmount: 0 }
      : { mode: "mutation", parentIds, firstShare: 1, secondShare: 0, mutationRate: DEFAULT_MUTATION_RATE, mutationAmount: DEFAULT_MUTATION_AMOUNT };
    ids.push(addLineageNode(network, trainingGeneration, index, parentIds, "candidate", breeding));
  });
  trainingLineageIds = ids; renderLineageTree();
}

function registerNextLineagePopulation(networks: SpikingNetwork[], generationNumber: number, retainedParentId: string | undefined, winnerParentId: string | undefined, runnerUpParentId: string | undefined, winnerShare: number, exploring: boolean): void {
  const safeSize = networks.length; const immigrantCount = exploring ? Math.min(safeSize - 1, Math.max(1, Math.floor((safeSize - 1) * 0.2))) : 0; const immigrantStart = safeSize - immigrantCount; const ids: string[] = [];
  networks.forEach((network, index) => {
    let parentIds = retainedParentId ? [retainedParentId] : [];
    let status: LineageNodeStatus = index === 0 ? "retained" : "candidate";
    let breeding: BreedingRecord = { mode: index === 0 ? "incumbent" : "mutation", parentIds, firstShare: 1, secondShare: 0, mutationRate: index === 0 ? 0 : mutationRate, mutationAmount: index === 0 ? 0 : mutationAmount };
    if (exploring && index >= immigrantStart) { parentIds = []; status = "immigrant"; }
    else if (index > 0 && retainedParentId && winnerParentId) {
      const winnerSlots = Math.round(clamp(winnerShare, 0, 100) / 10);
      const mateId = (index - 1) % 10 < winnerSlots ? winnerParentId : (runnerUpParentId ?? winnerParentId);
      parentIds = [retainedParentId, mateId];
      breeding = { mode: "crossover", parentIds, firstShare: 0.5, secondShare: 0.5, mutationRate: mutationRate * 0.85, mutationAmount: mutationAmount * 0.85 };
    }
    if (status === "immigrant") breeding = { mode: "immigrant", parentIds: [], firstShare: 0, secondShare: 0, mutationRate: 0, mutationAmount: 0 };
    breeding.parentIds = [...parentIds];
    ids.push(addLineageNode(network, generationNumber, index, parentIds, status, breeding));
  });
  trainingLineageIds = ids; renderLineageTree();
}

function updateLineageEvaluations(): void {
  trainingPopulation.forEach((car, index) => {
    const node = lineageNodeById(trainingLineageIds[index]); if (!node) return;
    node.score = car.score; node.progress = clamp(car.totalProgress ?? car.progress ?? 0, 0, 1); node.finished = car.finished;
  });
  renderLineageTree();
}

function updateEvolutionTelemetry(): void {
  const exploring = plateauExplorationEnabled && plateauStreak >= plateauPatience;
  ui.plateau.textContent = plateauStreak === 0 ? "clear" : `${plateauStreak} gen`;
  ui.mutationRate.textContent = `${Math.round(mutationRate * 100)}%`;
  ui.strategy.textContent = !plateauExplorationEnabled ? "fixed mutation" : exploring ? `exploration burst · ${plateauReason}` : plateauStreak > 0 ? `plateau · ${plateauReason}` : `local search · ${plateauPatience} gen patience`;
  ui.plateau.className = plateauStreak === 0 ? "metric-neutral" : exploring ? "metric-negative" : "metric-neutral";
  ui.strategy.className = exploring ? "metric-negative" : "metric-neutral";
}

function renderEvolutionChart(): void {
  const width = evolutionChart.width; const height = evolutionChart.height;
  const left = 68; const right = 18; const top = 28; const bottom = 30; const gap = 28; const plotWidth = width - left - right; const panelHeight = (height - top - bottom - gap) / 2; const progressTop = top + panelHeight + gap;
  evolutionContext.clearRect(0, 0, width, height); evolutionContext.fillStyle = "#0c131b"; evolutionContext.fillRect(0, 0, width, height);
  evolutionContext.font = "10px system-ui"; evolutionContext.lineWidth = 1; ui.plotTooltip.setAttribute("aria-hidden", "true"); ui.plotTooltip.hidden = true;
  if (evolutionHistory.length === 0) {
    evolutionContext.fillStyle = "#7f8ca0"; evolutionContext.fillText("Start training to populate the evolution trend", left, top + panelHeight + gap / 2);
    evolutionContext.strokeStyle = "rgba(113, 145, 181, .18)"; evolutionContext.strokeRect(left, top, plotWidth, panelHeight); evolutionContext.strokeRect(left, progressTop, plotWidth, panelHeight);
    evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.fillText("reward / fitness", 8, top - 10); evolutionContext.fillText("route coverage", 8, progressTop - 10);
    ui.plotSummary.textContent = "No generations recorded yet. The upper panel will scale reward locally; the lower panel always shows route coverage from 0–100%. Click a generation after training to select its candidate.";
    return;
  }
  const fitnessValues = evolutionHistory.flatMap((point) => [point.bestFitness, point.candidateFitness]); const rawMin = Math.min(...fitnessValues); const rawMax = Math.max(...fitnessValues); const rawRange = Math.max(1, rawMax - rawMin); const fitnessPadding = Math.max(1, rawRange * 0.14); const fitnessMin = rawMin - fitnessPadding; const fitnessMax = rawMax + fitnessPadding;
  const xAt = (index: number): number => left + (evolutionHistory.length === 1 ? plotWidth / 2 : (index / (evolutionHistory.length - 1)) * plotWidth);
  const rewardY = (fitness: number): number => top + (1 - (fitness - fitnessMin) / Math.max(1, fitnessMax - fitnessMin)) * panelHeight;
  const progressY = (progress: number): number => progressTop + (1 - clamp(progress, 0, 1)) * panelHeight;
  evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.font = "600 10px system-ui"; evolutionContext.fillText(`REWARD / FITNESS · ${fitnessMin.toFixed(0)} to ${fitnessMax.toFixed(0)}`, 8, top - 10); evolutionContext.fillText("FORWARD COVERAGE + MUTATION RATE · fixed 0–100%", 8, progressTop - 10);
  const drawGrid = (panelTop: number, labelAt: (fraction: number) => string): void => {
    evolutionContext.strokeStyle = "rgba(113, 145, 181, .2)"; evolutionContext.setLineDash([3, 5]);
    for (let row = 0; row <= 4; row += 1) { const fraction = row / 4; const y = panelTop + fraction * panelHeight; evolutionContext.beginPath(); evolutionContext.moveTo(left, y); evolutionContext.lineTo(left + plotWidth, y); evolutionContext.stroke(); evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.fillText(labelAt(fraction), 8, y + 3); }
    evolutionContext.setLineDash([]); evolutionContext.strokeStyle = "rgba(113, 145, 181, .48)"; evolutionContext.strokeRect(left, panelTop, plotWidth, panelHeight);
  };
  drawGrid(top, (fraction) => (fitnessMax - fraction * (fitnessMax - fitnessMin)).toFixed(0)); drawGrid(progressTop, (fraction) => `${Math.round((1 - fraction) * 100)}%`);
  evolutionHistory.forEach((point, index) => { if (point.plateauStreak <= 0) return; const startX = index === 0 ? left : xAt(index - 1); const endX = xAt(index); const color = point.plateauStreak >= plateauPatience ? "rgba(255, 140, 140, .18)" : "rgba(255, 140, 140, .07)"; evolutionContext.fillStyle = color; evolutionContext.fillRect(startX, top, Math.max(2, endX - startX), panelHeight); evolutionContext.fillRect(startX, progressTop, Math.max(2, endX - startX), panelHeight); });
  const drawSeries = (valueAt: (point: EvolutionPoint) => number, yAt: (value: number) => number, color: string, dash: number[] = []): void => { evolutionContext.strokeStyle = color; evolutionContext.lineWidth = 2.2; evolutionContext.setLineDash(dash); evolutionContext.beginPath(); evolutionHistory.forEach((point, index) => { const x = xAt(index); const y = yAt(valueAt(point)); if (index === 0) evolutionContext.moveTo(x, y); else evolutionContext.lineTo(x, y); }); evolutionContext.stroke(); evolutionContext.setLineDash([]); };
  drawSeries((point) => point.bestFitness, rewardY, "#7cf0b6"); drawSeries((point) => point.candidateFitness, rewardY, "#f3c96b", [6, 4]);
  evolutionContext.beginPath(); evolutionHistory.forEach((point, index) => { const x = xAt(index); const y = progressY(point.progress); if (index === 0) evolutionContext.moveTo(x, y); else evolutionContext.lineTo(x, y); }); evolutionContext.lineTo(xAt(evolutionHistory.length - 1), progressTop + panelHeight); evolutionContext.lineTo(left, progressTop + panelHeight); evolutionContext.closePath(); evolutionContext.fillStyle = "rgba(114, 184, 255, .1)"; evolutionContext.fill(); drawSeries((point) => point.progress, progressY, "#72b8ff"); drawSeries((point) => point.candidateProgress, progressY, "#f3c96b", [6, 4]); drawSeries((point) => point.mutationRate, progressY, "#d29bff", [2, 3]);
  evolutionHistory.forEach((point, index) => { const x = xAt(index); const radius = index === hoveredEvolutionIndex ? 4 : 2.5; evolutionContext.fillStyle = "#7cf0b6"; evolutionContext.beginPath(); evolutionContext.arc(x, rewardY(point.bestFitness), radius, 0, TAU); evolutionContext.fill(); evolutionContext.fillStyle = "#72b8ff"; evolutionContext.beginPath(); evolutionContext.arc(x, progressY(point.progress), radius, 0, TAU); evolutionContext.fill(); evolutionContext.fillStyle = "#f3c96b"; evolutionContext.beginPath(); evolutionContext.arc(x, progressY(point.candidateProgress), radius, 0, TAU); evolutionContext.fill(); evolutionContext.fillStyle = "#d29bff"; evolutionContext.beginPath(); evolutionContext.arc(x, progressY(point.mutationRate), radius, 0, TAU); evolutionContext.fill(); if (point.plateauStreak >= plateauPatience) { evolutionContext.fillStyle = "#ff8c8c"; evolutionContext.beginPath(); evolutionContext.arc(x, rewardY(point.bestFitness), 3.5, 0, TAU); evolutionContext.fill(); } });
  const latest = evolutionHistory[evolutionHistory.length - 1]; const previous = evolutionHistory[evolutionHistory.length - 2]; const rewardDelta = previous ? latest.bestFitness - previous.bestFitness : 0; const progressDelta = previous ? (latest.progress - previous.progress) * 100 : latest.progress * 100; const xLabels = evolutionHistory.length === 1 ? [0] : [0, Math.floor((evolutionHistory.length - 1) / 2), evolutionHistory.length - 1];
  evolutionContext.fillStyle = "#8c9bb0"; evolutionContext.font = "10px system-ui"; xLabels.forEach((index) => { const label = `G${evolutionHistory[index].generation}`; evolutionContext.fillText(label, Math.max(left, Math.min(width - right - 22, xAt(index) - 10)), height - 10); });
  if (hoveredEvolutionIndex !== undefined && evolutionHistory[hoveredEvolutionIndex]) { const point = evolutionHistory[hoveredEvolutionIndex]; const x = xAt(hoveredEvolutionIndex); evolutionContext.strokeStyle = "rgba(238, 245, 255, .65)"; evolutionContext.setLineDash([2, 3]); evolutionContext.beginPath(); evolutionContext.moveTo(x, top); evolutionContext.lineTo(x, progressTop + panelHeight); evolutionContext.stroke(); evolutionContext.setLineDash([]); ui.plotTooltip.hidden = false; ui.plotTooltip.setAttribute("aria-hidden", "false"); ui.plotTooltip.style.left = `${clamp(hoveredEvolutionRatio * evolutionChart.clientWidth + 12, 6, Math.max(6, evolutionChart.clientWidth - 188))}px`; ui.plotTooltip.textContent = `G${point.generation} · reward ${point.bestFitness.toFixed(1)} · candidate ${point.candidateName ?? "unnamed"} ${point.candidateFitness.toFixed(1)} · best coverage ${(point.progress * 100).toFixed(1)}% · candidate coverage ${(point.candidateProgress * 100).toFixed(1)}% · plateau ${point.plateauStreak}/${plateauPatience} (${point.plateauReason}) · mutation ${(point.mutationRate * 100).toFixed(0)}% / ${point.mutationAmount.toFixed(2)} · click to select candidate`; }
  ui.plotSummary.textContent = `G${latest.generation} · reward ${latest.bestFitness.toFixed(1)} · candidate ${latest.candidateName ?? "unnamed"} ${latest.candidateFitness.toFixed(1)} · Δ reward ${rewardDelta >= 0 ? "+" : ""}${rewardDelta.toFixed(1)} · best coverage ${(latest.progress * 100).toFixed(1)}% (${progressDelta >= 0 ? "+" : ""}${progressDelta.toFixed(1)} pp) · candidate coverage ${(latest.candidateProgress * 100).toFixed(1)}% · plateau ${latest.plateauStreak}/${plateauPatience} (${latest.plateauReason}) · mutation ${(latest.mutationRate * 100).toFixed(0)}% / ${latest.mutationAmount.toFixed(2)} · reward scale ${fitnessMin.toFixed(0)}…${fitnessMax.toFixed(0)} · click a generation to select its candidate`;
}

function resetEvolutionHistory(): void {
  evolutionHistory = []; renderEvolutionChart();
}

function recordEvolutionPoint(candidateFitness: number, candidateProgress: number, retainedProgress: number, candidateLineageId?: string, candidateName?: string): void {
  evolutionHistory.push({ generation: trainingGeneration, bestFitness, candidateFitness, progress: clamp(retainedProgress, 0, 1), candidateProgress: clamp(candidateProgress, 0, 1), plateauStreak, mutationRate, mutationAmount, plateauReason, candidateLineageId, candidateName });
  if (evolutionHistory.length > 1000) evolutionHistory.shift();
  renderEvolutionChart();
}

function evolutionPointFromEvent(event: PointerEvent): { index: number; ratio: number } | undefined {
  if (evolutionHistory.length === 0) return undefined;
  const bounds = evolutionChart.getBoundingClientRect();
  const chartX = (event.clientX - bounds.left) * (evolutionChart.width / Math.max(1, bounds.width));
  const left = 68; const right = 18;
  const ratio = clamp((chartX - left) / Math.max(1, evolutionChart.width - left - right), 0, 1);
  return { index: Math.round(ratio * (evolutionHistory.length - 1)), ratio };
}

evolutionChart.addEventListener("pointermove", (event) => {
  const point = evolutionPointFromEvent(event);
  if (!point) return;
  hoveredEvolutionRatio = point.ratio; hoveredEvolutionIndex = point.index; renderEvolutionChart();
});
evolutionChart.addEventListener("click", (event) => {
  const point = evolutionPointFromEvent(event);
  const evolution = point ? evolutionHistory[point.index] : undefined;
  const node = lineageNodeById(evolution?.candidateLineageId);
  if (!node) {
    if (evolution) appendEvent(`G${evolution.generation} candidate is no longer available in the compact lineage window`);
    return;
  }
  selectLineageNode(node.id);
  appendEvent(`selected ${node.name} from evolution graph · reward ${node.score?.toFixed(1) ?? evolution?.candidateFitness.toFixed(1) ?? "pending"}`);
});
evolutionChart.addEventListener("pointerleave", () => { hoveredEvolutionIndex = undefined; renderEvolutionChart(); });

function refreshTrainingObstacles(route: TrackDefinition, seed: number): void {
  trainingObstacles = randomObjectsEnabled ? createRoadObstacles(trainingObstacleCount(), route, seed, randomObjectKind) : [];
  trainingGhostObstacles = ghostEvolution && fiveBrainEvolution
    // Each candidate gets independent object instances, but the same seeded
    // layout, so isolation does not introduce a hidden fitness advantage.
    ? Array.from({ length: trainingPopulationSize }, () => randomObjectsEnabled ? createRoadObstacles(trainingObstacleCount(), route, seed, randomObjectKind) : [])
    : [];
}

function selectedTracks(): TrackDefinition[] {
  if (ui.trackSelect.value === "all") return [...TRACKS];
  return [resolveTrack(ui.trackSelect.value as TrackDefinition["id"] )];
}

function selectedTrackLabel(): string {
  return ui.trackSelect.value === "all" ? "all track types" : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]).name;
}

function updateTrackInfo(): void {
  if (ui.trackSelect.value === "all") {
    ui.trackInfo.textContent = `${TRACKS.length} routes · generalist evaluation · gates are checked in each route's own direction`;
    updateTrackProvenance();
    return;
  }
  const route = resolveTrack(ui.trackSelect.value as TrackDefinition["id"]); const diagnostics = trackDiagnostics(route);
  ui.trackInfo.textContent = `${route.name} · ${Math.round(diagnostics.length)} px · width ${Math.round(diagnostics.width)} · ${diagnostics.cornerCount} corners · ${diagnostics.hardTurnCount} hard turns · sharpest ${Math.round(diagnostics.maxTurnDegrees)}° · sweep ${Math.round(diagnostics.maxTurnSweepDegrees)}° · shortest segment ${Math.round(diagnostics.minSegmentLength)} px`;
  updateTrackProvenance();
}

function updateRewardTelemetry(car: Car | undefined): void {
  if (!car) return;
  const breakdown = car.rewardBreakdown;
  const penalty = breakdown.standingStill + breakdown.wrongDirection + breakdown.reverseProgress + breakdown.offTrack + breakdown.edge + breakdown.proximity + breakdown.hazard + breakdown.collision + breakdown.crash;
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
    ["outside", breakdown.offTrack], ["edge", breakdown.edge], ["close traffic", breakdown.proximity], ["hazard", breakdown.hazard],
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
  [ui.trackSelect, ui.wallsToggle, ui.adaptiveTimeToggle, ui.adaptiveExtensions, ui.checkpointCount, ui.ghostEvolutionToggle, ui.softContactToggle, ui.obstacleToggle, ui.obstacleCount, ui.obstacleKind, ui.plateauExplorationToggle, ui.plateauPatience, ui.breedingProgressWeight, ui.winnerMatingShare, ui.curriculumToggle, ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardEdge, ui.rewardProximity, ui.rewardHazard, ui.rewardCenterline, ui.rewardCollision, ui.rewardCrash, ui.rewardCheckpoint, ui.rewardFinish].forEach((input) => { input.disabled = value; });
  ui.stopButton.disabled = !(value || running);
}

function createGridCar(lane: number, distanceAlong: number, color: string, name: string, route: TrackDefinition, checkpointCount = physicsConfig.checkpointCount ?? CHECKPOINT_COUNT): Car {
  const car = startPosition(lane, route); const sample = pointAtDistance(distanceAlong, route); const normal = { x: -sample.tangent.y, y: sample.tangent.x };
  const start = { x: sample.point.x + normal.x * lane * LANE_SPACING, y: sample.point.y + normal.y * lane * LANE_SPACING };
  car.position = start; car.heading = Math.atan2(sample.tangent.y, sample.tangent.x); car.color = color; car.name = name;
  const nearest = nearestTrack(car.position, route); car.progress = nearest.progress; car.totalProgress = nearest.progress; car.distanceAlong = nearest.distanceAlong; car.bestProgress = nearest.progress;
  car.checkpointsPassed = Math.min(checkpointCount - 1, Math.floor(nearest.progress * checkpointCount)); car.nextCheckpoint = car.checkpointsPassed >= checkpointCount - 1 ? 0 : car.checkpointsPassed + 1;
  return car;
}

function launchRace(manual = false): void {
  training = false; running = true; visualTraining = false; fiveBrainEvolution = false; ghostEvolution = false; manualMode = manual; trainingPopulation = []; trainingObstacles = []; trainingGhostObstacles = []; trainingHistory = []; raceAccumulator = 0; runStartedAt = performance.now(); flyFinishAnnounced = false;
  activeTrack = ui.trackSelect.value === "all" ? DEFAULT_TRACK : resolveTrack(ui.trackSelect.value as TrackDefinition["id"]);
  activateStoredContextForRace();
  rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig();
  const selectedNode = lineageNodeById(selectedLineageId); const raceNetwork = selectedLineageNetwork ?? bestNetwork;
  fly = startPosition(0, activeTrack); fly.color = "#74c0ff"; fly.name = selectedNode ? `fly · ${selectedNode.name}` : "fly"; fly.isFly = true; fly.network = raceNetwork?.clone() ?? new SpikingNetwork(77);
  const roadObjects = randomObjectsEnabled ? createRoadObstacles(randomObjectCount, activeTrack, generation + 77, randomObjectKind) : [];
  const heuristicRivals = [createGridCar(-1, 52, "#f19a69", "bot 1", activeTrack), createGridCar(1, 108, "#e9d26d", "bot 2", activeTrack), createGridCar(-1, 164, "#b48cff", "bot 3", activeTrack)];
  // The player/fly timeout is an evaluation limit, not a race-wide kill
  // switch. Heuristic rivals should continue until they actually finish.
  heuristicRivals.forEach((car) => { car.timeLimit = Number.POSITIVE_INFINITY; });
  raceCars = [fly, ...heuristicRivals, ...roadObjects];
  const objectDetail = roadObjects.length > 0 ? ` plus ${roadObjects.length} ${randomObjectKind} objects` : "";
  const detail = manual ? `manual driving on ${activeTrack.name} — arrows or WASD steer, Space brakes, S/↓ reverses${objectDetail}` : selectedNode ? `${selectedNode.name} deployed on ${activeTrack.name} against three spaced heuristic bots${objectDetail}` : bestNetwork ? `best trained fly pilot deployed on ${activeTrack.name} against three spaced heuristic bots${objectDetail}` : `demo brain deployed on ${activeTrack.name} — train a controller to improve it${objectDetail}`;
  setRunState("Racing", detail, "running", "RACE MODE");
  setProgress(0, "lap 0%", manual ? "manual controls active · arrows/WASD · Space brake" : "fixed 30 Hz simulator · press Stop to pause");
  appendEvent(manual ? `manual race started · keyboard controls active${objectDetail}` : `race started · fly pilot and three spaced bots are on the track${objectDetail}`);
  setBusy(false);
}

function resetBrain(): void {
  bestNetwork = undefined; bestFitness = -Infinity; generation = 0; contextNetworks.clear(); contextFitness.clear(); contextGenerations.clear(); contextProvenance.clear(); freshTrainingContext = true; warmStartLabel = "demo brain"; bestProgressForContext = 0; bestFinishedForContext = false; ui.generation.textContent = "0"; ui.fitness.textContent = "—"; ui.progress.textContent = "0%"; plateauStreak = 0; plateauReason = "none"; resetEvolutionHistory(); resetLineage(); updateEvolutionTelemetry(); updateTrackProvenance();
  appendEvent("controller reset; returning to demo brain"); launchRace();
}

function checkpointNetwork(): SpikingNetwork | undefined {
  return bestNetwork ?? trainingNetworks[0];
}

function persistBestBrain(): void {
  const network = checkpointNetwork(); if (!network) return;
  try {
    if (!bestNetwork) bestNetwork = network.clone(); rememberTrainingContext();
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ fitness: Number.isFinite(bestFitness) ? bestFitness : 0, generation, track: activeTrainingContext, provenance: [...contextProvenance.values()], network: network.toJSON() }));
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

function checkpointObject(networkOverride?: SpikingNetwork, fitnessOverride?: number, generationOverride?: number, lineage?: LineageNode): { format: string; version: number; savedAt: string; fitness: number; generation: number; track: TrainingContextKey; provenance: TrainingProvenance[]; network: BrainSnapshot; lineage?: { name: string; generation: number; parents: string[] } } {
  const network = networkOverride ?? checkpointNetwork(); if (!network) throw new Error("start training before exporting a checkpoint");
  const checkpointFitness = fitnessOverride ?? bestFitness; const checkpointGeneration = generationOverride ?? generation;
  return { format: "flykart-brain", version: CHECKPOINT_VERSION, savedAt: new Date().toISOString(), fitness: Number.isFinite(checkpointFitness) ? checkpointFitness : 0, generation: checkpointGeneration, track: activeTrainingContext, provenance: [...contextProvenance.values()], network: network.toJSON(), ...(lineage ? { lineage: { name: lineage.name, generation: lineage.generation, parents: lineage.parentIds.map((id) => lineageNodeById(id)?.name ?? id) } } : {}) };
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

function useSelectedLineage(): void {
  const node = lineageNodeById(selectedLineageId);
  if (!node) { appendEvent("select a brain family node before using it"); return; }
  selectedLineageNetwork = node.network.clone();
  setRunState("Selected brain ready", `${node.name} is selected for the next race; the evolution incumbent remains unchanged.`, "ready", "LINEAGE"); appendEvent(`selected ${node.name} for racing · reward ${node.score?.toFixed(1) ?? "pending"} · coverage ${((node.progress ?? 0) * 100).toFixed(1)}%`);
  if (!training) launchRace(false);
}

function downloadSelectedLineage(): void {
  const node = lineageNodeById(selectedLineageId);
  if (!node) { appendEvent("select a brain family node before downloading it"); return; }
  try {
    const payload = JSON.stringify(checkpointObject(node.network, node.score, node.generation, node), null, 2); const blob = new Blob([payload], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `flykart-${node.name.replace(/[^a-z0-9.-]+/gi, "-")}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setRunState("Lineage brain downloaded", `${node.name} was exported with its parent names.`, "ready", "LINEAGE"); appendEvent(`downloaded selected brain ${node.name}`);
  } catch (error) { const detail = error instanceof Error ? error.message : "could not download selected brain"; setRunState("Lineage export error", detail, "error", "LINEAGE"); appendEvent(`lineage export failed: ${detail}`); }
}

async function importBrain(file: File): Promise<void> {
  try {
    const parsed = JSON.parse(await file.text()) as { format?: unknown; version?: unknown; fitness?: unknown; generation?: unknown; track?: unknown; provenance?: unknown; network?: BrainSnapshot };
    if (parsed.format !== undefined && parsed.format !== "flykart-brain") throw new Error("this file is not a FlyKart brain checkpoint");
    if (!parsed.network) throw new Error("checkpoint is missing its network weights");
    const network = SpikingNetwork.fromJSON(parsed.network);
    contextProvenance.clear(); restoreProvenance(parsed.provenance);
    const sourceContext = isTrainingContext(parsed.track) ? parsed.track : "all"; const selectedContext = selectedTrainingContext(); const sourceFitness = typeof parsed.fitness === "number" && Number.isFinite(parsed.fitness) ? parsed.fitness : -Infinity; const sourceGeneration = typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation >= 0 ? parsed.generation : 0;
    const sourceRecord = contextProvenance.get(sourceContext); const sourceProgress = sourceRecord?.bestProgress ?? 0; const sourceFinished = sourceRecord?.finished ?? false;
    contextNetworks.set(sourceContext, network.clone()); if (Number.isFinite(sourceFitness)) contextFitness.set(sourceContext, sourceFitness); contextGenerations.set(sourceContext, sourceGeneration); contextProvenance.set(sourceContext, { context: sourceContext, trained: true, source: "imported checkpoint", bestFitness: Number.isFinite(sourceFitness) ? sourceFitness : null, bestProgress: sourceProgress, finished: sourceFinished, generation: sourceGeneration });
    activeTrainingContext = selectedContext; bestNetwork = network; bestFitness = selectedContext === sourceContext ? sourceFitness : -Infinity; generation = selectedContext === sourceContext ? sourceGeneration : 0; freshTrainingContext = selectedContext !== sourceContext; warmStartLabel = contextLabel(sourceContext); bestProgressForContext = selectedContext === sourceContext ? sourceProgress : 0; bestFinishedForContext = selectedContext === sourceContext ? sourceFinished : false; if (freshTrainingContext) contextProvenance.set(selectedContext, { context: selectedContext, trained: false, source: `${contextLabel(sourceContext)} checkpoint`, bestFitness: null, bestProgress: 0, finished: false, generation: 0 });
    updateTrackProvenance();
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
    const saved = JSON.parse(raw) as { fitness?: unknown; generation?: unknown; track?: unknown; provenance?: unknown; network?: BrainSnapshot }; if (!saved.network) throw new Error("saved checkpoint is incomplete");
    const network = SpikingNetwork.fromJSON(saved.network); contextProvenance.clear(); restoreProvenance(saved.provenance);
    const sourceContext = isTrainingContext(saved.track) ? saved.track : "all"; const selectedContext = selectedTrainingContext(); const sourceFitness = typeof saved.fitness === "number" && Number.isFinite(saved.fitness) ? saved.fitness : -Infinity; const sourceGeneration = typeof saved.generation === "number" && Number.isInteger(saved.generation) && saved.generation >= 0 ? saved.generation : 0;
    const sourceRecord = contextProvenance.get(sourceContext); const sourceProgress = sourceRecord?.bestProgress ?? 0; const sourceFinished = sourceRecord?.finished ?? false;
    contextNetworks.set(sourceContext, network.clone()); if (Number.isFinite(sourceFitness)) contextFitness.set(sourceContext, sourceFitness); contextGenerations.set(sourceContext, sourceGeneration); contextProvenance.set(sourceContext, { context: sourceContext, trained: true, source: "saved checkpoint", bestFitness: Number.isFinite(sourceFitness) ? sourceFitness : null, bestProgress: sourceProgress, finished: sourceFinished, generation: sourceGeneration });
    activeTrainingContext = selectedContext; bestNetwork = network; bestFitness = selectedContext === sourceContext ? sourceFitness : -Infinity; generation = selectedContext === sourceContext ? sourceGeneration : 0; freshTrainingContext = selectedContext !== sourceContext; warmStartLabel = contextLabel(sourceContext); bestProgressForContext = selectedContext === sourceContext ? sourceProgress : 0; bestFinishedForContext = selectedContext === sourceContext ? sourceFinished : false; if (freshTrainingContext) contextProvenance.set(selectedContext, { context: selectedContext, trained: false, source: `${contextLabel(sourceContext)} saved brain`, bestFitness: null, bestProgress: 0, finished: false, generation: 0 });
    updateTrackProvenance();
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
  drawRewardField();
  drawPath(); context.strokeStyle = "#7b968b"; context.lineWidth = 2; context.setLineDash([16, 14]); context.stroke(); context.setLineDash([]);
  context.fillStyle = "#b7d8a2"; context.globalAlpha = 0.9; context.font = "600 11px system-ui"; context.fillText("REWARD FIELD · green center / red edge + off-track", -WIDTH / 2 + 18, -HEIGHT / 2 + 24); context.globalAlpha = 1;
  const checkpointCount = physicsConfig.checkpointCount ?? CHECKPOINT_COUNT;
  const checkpointCar = training
    ? trainingPopulation.reduce<Car | undefined>((leader, car) => !leader || car.totalProgress > leader.totalProgress ? car : leader, undefined)
    : fly;
  for (let index = 1; index < checkpointCount; index += 1) {
    const checkpoint = trackCheckpoint(index, activeTrack, checkpointCount); const gateOffset = activeTrack.width / 2 + CAR_WIDTH;
    const gateA = addCanvasPoint(checkpoint.point, { x: checkpoint.normal.x * gateOffset, y: checkpoint.normal.y * gateOffset });
    const gateB = addCanvasPoint(checkpoint.point, { x: -checkpoint.normal.x * gateOffset, y: -checkpoint.normal.y * gateOffset });
    const passed = Boolean(checkpointCar && checkpointCar.checkpointsPassed >= index);
    const next = checkpointCar?.nextCheckpoint === index;
    context.strokeStyle = passed ? "#7cf0b6" : next ? "#74c0ff" : "#e7bd72"; context.globalAlpha = passed || next ? 0.95 : 0.72; context.lineWidth = next ? 3 : 2; context.setLineDash(passed ? [] : [6, 6]); context.beginPath(); context.moveTo(gateA.x, gateA.y); context.lineTo(gateB.x, gateB.y); context.stroke(); context.setLineDash([]);
    context.globalAlpha = 0.9; context.strokeStyle = "#f7dfaa"; context.lineWidth = 1.5; context.beginPath(); context.moveTo(checkpoint.point.x - checkpoint.tangent.x * 9, checkpoint.point.y - checkpoint.tangent.y * 9); context.lineTo(checkpoint.point.x + checkpoint.tangent.x * 9, checkpoint.point.y + checkpoint.tangent.y * 9); context.stroke();
    context.beginPath(); context.moveTo(checkpoint.point.x + checkpoint.tangent.x * 9, checkpoint.point.y + checkpoint.tangent.y * 9); context.lineTo(checkpoint.point.x + checkpoint.tangent.x * 3 - checkpoint.normal.x * 4, checkpoint.point.y + checkpoint.tangent.y * 3 - checkpoint.normal.y * 4); context.moveTo(checkpoint.point.x + checkpoint.tangent.x * 9, checkpoint.point.y + checkpoint.tangent.y * 9); context.lineTo(checkpoint.point.x + checkpoint.tangent.x * 3 + checkpoint.normal.x * 4, checkpoint.point.y + checkpoint.tangent.y * 3 + checkpoint.normal.y * 4); context.stroke();
    context.fillStyle = passed ? "#7cf0b6" : next ? "#9ed5ff" : "#f1d28f"; context.font = "600 10px system-ui"; context.fillText(`${passed ? "✓ " : next ? "→ " : ""}CP${index}`, checkpoint.point.x + 6, checkpoint.point.y - 6);
  }
  const line = startLine(activeTrack); const lineOffset = activeTrack.width / 2 + CAR_WIDTH; const startA = addCanvasPoint(line.point, { x: line.normal.x * lineOffset, y: line.normal.y * lineOffset }); const startB = addCanvasPoint(line.point, { x: -line.normal.x * lineOffset, y: -line.normal.y * lineOffset });
  context.strokeStyle = "#9ed5ff"; context.lineWidth = 5; context.beginPath(); context.moveTo(startA.x, startA.y); context.lineTo(startB.x, startB.y); context.stroke();
  for (let index = 0; index < activeTrack.points.length; index += 2) { const marker = activeTrack.points[index]; context.fillStyle = "#7aa18c"; context.globalAlpha = 0.28; context.beginPath(); context.arc(marker.x, marker.y, 3, 0, TAU); context.fill(); }
  context.restore();
}

function drawRewardField(): void {
  const halfWidth = activeTrack.width / 2; const longitudinalSteps = Math.max(80, Math.ceil(activeTrack.length / 18)); const lateralBands = 18; const lateralMin = -0.96; const lateralMax = 0.96; const lateralStep = (lateralMax - lateralMin) / lateralBands;
  const centerWeight = clamp((rewardConfig.centerlinePerSecond ?? 0) / 1.5, 0, 1); const edgeWeight = clamp(rewardConfig.edgePenaltyPerSecond / 5, 0, 1); const offTrackWeight = clamp(rewardConfig.offTrackPerSecond / 40, 0, 1);
  const field = rewardFieldContext!;
  field.setTransform(1, 0, 0, 1, 0, 0); field.clearRect(0, 0, WIDTH, HEIGHT); field.save(); field.translate(WIDTH / 2, HEIGHT / 2); field.globalAlpha = 1; field.lineJoin = "round";
  // Use continuous rounded strokes for each lateral band. Independent
  // quadrilaterals create self-overlapping wedges at hairpins and chicanes,
  // which falsely look like extra penalty regions even though they are only
  // part of the visualization.
  for (let band = 0; band < lateralBands; band += 1) {
    const lateralMid = lateralMin + (band + 0.5) * lateralStep; const absoluteLateral = Math.abs(lateralMid);
    const centerIntensity = clamp(1 - absoluteLateral / 0.62, 0, 1) * centerWeight;
    const edgeIntensity = clamp((absoluteLateral - 0.54) / 0.38, 0, 1) * edgeWeight;
    const offTrackIntensity = clamp((absoluteLateral - 0.84) / 0.12, 0, 1) * offTrackWeight;
    const greenIntensity = centerIntensity; const redIntensity = Math.max(edgeIntensity * 0.72, offTrackIntensity);
    const strongest = Math.max(greenIntensity, redIntensity); const redShare = redIntensity + greenIntensity > 0 ? redIntensity / (redIntensity + greenIntensity) : 0;
    const red = Math.round(78 + 166 * redShare); const green = Math.round(222 - 104 * redShare); const blue = Math.round(146 - 76 * redShare);
    field.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${0.04 + strongest * 0.34})`; field.lineWidth = Math.max(1.5, lateralStep * halfWidth * 0.84); field.lineCap = "round";
    field.beginPath();
    for (let step = 0; step <= longitudinalSteps; step += 1) {
      const sample = pointAtDistance((step / longitudinalSteps) * activeTrack.length, activeTrack); const normal = { x: -sample.tangent.y, y: sample.tangent.x }; const point = { x: sample.point.x + normal.x * lateralMid * halfWidth, y: sample.point.y + normal.y * lateralMid * halfWidth };
      if (step === 0) field.moveTo(point.x, point.y); else field.lineTo(point.x, point.y);
    }
    field.stroke();
  }
  field.globalAlpha = 0.68; field.strokeStyle = rewardConfig.correctDirectionPerSecond > 0 ? "#b7d8a2" : "#72818a"; field.lineWidth = 1.5;
  const arrowSpacing = Math.max(1, Math.floor(longitudinalSteps / 18));
  for (let step = 0; step < longitudinalSteps; step += arrowSpacing) {
    const sample = pointAtDistance((step / longitudinalSteps) * activeTrack.length, activeTrack); const tangent = sample.tangent; const tip = { x: sample.point.x + tangent.x * 12, y: sample.point.y + tangent.y * 12 }; const back = { x: sample.point.x - tangent.x * 8, y: sample.point.y - tangent.y * 8 }; const normal = { x: -tangent.y, y: tangent.x };
    field.beginPath(); field.moveTo(back.x, back.y); field.lineTo(tip.x, tip.y); field.moveTo(tip.x, tip.y); field.lineTo(tip.x - tangent.x * 5 + normal.x * 3, tip.y - tangent.y * 5 + normal.y * 3); field.moveTo(tip.x, tip.y); field.lineTo(tip.x - tangent.x * 5 - normal.x * 3, tip.y - tangent.y * 5 - normal.y * 3); field.stroke();
  }
  // One destination-in operation masks every band in one pass. It avoids
  // alpha accumulation where the route is close to itself and makes the
  // visualization flush with the actual road surface.
  field.globalCompositeOperation = "destination-in"; field.globalAlpha = 1; field.strokeStyle = "#fff"; field.lineWidth = activeTrack.width; field.lineJoin = "round"; field.lineCap = "round";
  field.beginPath(); activeTrack.points.forEach((point, index) => index === 0 ? field.moveTo(point.x, point.y) : field.lineTo(point.x, point.y)); field.closePath(); field.stroke();
  field.globalCompositeOperation = "source-over"; field.restore();
  context.drawImage(rewardFieldCanvas, -WIDTH / 2, -HEIGHT / 2);
}

function addCanvasPoint(point: { x: number; y: number }, offset: { x: number; y: number }): { x: number; y: number } { return { x: point.x + offset.x, y: point.y + offset.y }; }

function drawCar(car: Car, alpha = 1): void {
  context.save(); context.translate(WIDTH / 2 + car.position.x, HEIGHT / 2 + car.position.y); context.rotate(car.heading); context.globalAlpha = alpha;
  if (car.isObstacle && car.obstacleKind && car.obstacleKind !== "stalled-car") {
    if (car.obstacleKind === "oil") {
      context.fillStyle = "rgba(130, 117, 200, .72)"; context.beginPath(); context.ellipse(0, 0, 22, 12, 0, 0, TAU); context.fill();
      context.strokeStyle = "#b9adff"; context.lineWidth = 1.5; context.beginPath(); context.arc(-5, 0, 8, 0.2, 2.5); context.stroke();
    } else if (car.obstacleKind === "barrier") {
      context.fillStyle = "#e0a15b"; context.fillRect(-18, -9, 36, 18); context.fillStyle = "#402b20"; for (let index = -12; index < 18; index += 12) context.fillRect(index, -9, 5, 18);
    } else {
      context.fillStyle = "#f08b47"; context.beginPath(); context.moveTo(0, -11); context.lineTo(8, 10); context.lineTo(-8, 10); context.closePath(); context.fill(); context.fillStyle = "#ffe4b0"; context.fillRect(-5, -1, 10, 3);
    }
    context.restore(); return;
  }
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

function applyLineageNames(): void {
  trainingPopulation.forEach((car, index) => { car.name = lineageNameForIndex(index); });
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
    stepCar(car, car.action, simulationCars, route, rewardConfig, ghostEvolution ? physicsConfig : { ...physicsConfig, softCollisions: softContactEvolution });
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
    trainingPopulation = trainingNetworks.map((network, index) => makeFiveBrainCar(network, index, activeTrack)); applyLineageNames();
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
  if (car.timeLimit > previousTimeLimit) appendEvent(`${car.name} earned adaptive extension ${car.timeExtensions}/${physicsConfig.maxAdaptiveExtensions ?? MAX_ADAPTIVE_EXTENSIONS} · new limit ${car.timeLimit} ticks`);
  updateRewardTelemetry(car);
  const episodeCount = Math.max(1, trainingTracks.length); const totalEpisodes = Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations);
  const completedEpisodes = (trainingGeneration - 1) * trainingPopulationSize * episodeCount + trainingIndex * episodeCount + trainingTrackIndex;
  const candidateFraction = Math.min(1, car.ticks / MAX_TICKS);
  const route = trainingTracks[trainingTrackIndex];
  setProgress((completedEpisodes + candidateFraction) / totalEpisodes, `generation ${trainingGeneration}/${requestedGenerations} · ${car.name} (${trainingIndex + 1}/${trainingPopulationSize}) · ${route.name}`, `visual · tick ${car.ticks}/${car.timeLimit} · checkpoints ${car.checkpointsPassed}/${physicsConfig.checkpointCount ?? CHECKPOINT_COUNT} · direction ${Math.round(clamp((car.forwardAlignment + 1) * 50, 0, 100))}%`);
  if (car.crashed || car.finished || car.timedOut) {
    recordTrainingTrace(car);
    trainingScores[trainingIndex] += car.score;
    trainingProgresses[trainingIndex] += car.totalProgress;
    const terminalReason = car.finished ? " · finish line" : car.crashed ? " · crashed" : car.timedOut ? " · time limit" : "";
    appendEvent(`${car.name} (${trainingIndex + 1}/${trainingPopulationSize}) finished ${route.name} · fitness ${car.score.toFixed(1)}${terminalReason}`);
    if (trainingTrackIndex + 1 < trainingTracks.length) {
      trainingTrackIndex += 1; activeTrack = trainingTracks[trainingTrackIndex];
      trainingPopulation[trainingIndex] = makeTrainingCar(car.network, (trainingIndex % 3) - 1, trainingTracks[trainingTrackIndex]); trainingPopulation[trainingIndex].name = lineageNameForIndex(trainingIndex);
      refreshTrainingObstacles(activeTrack, trainingWorldSeed + trainingTrackIndex * 97);
      setProgress((completedEpisodes + 1) / totalEpisodes, `generation ${trainingGeneration}/${requestedGenerations} · ${car.name} (${trainingIndex + 1}/${trainingPopulationSize}) · ${trainingTracks[trainingTrackIndex].name}`, "visual · switching track episode");
    } else {
      car.score = trainingScores[trainingIndex] / trainingTracks.length; car.totalProgress = trainingProgresses[trainingIndex] / trainingTracks.length;
      trainingIndex += 1; trainingTrackIndex = 0;
      if (trainingIndex >= trainingPopulation.length) finishVisualGeneration();
    }
  }
}

function startVisualGeneration(): void {
  trainingTrackIndex = 0; activeTrack = trainingTracks[0]; trainingScores = trainingNetworks.map(() => 0); trainingProgresses = trainingNetworks.map(() => 0);
  trainingPopulation = fiveBrainEvolution ? trainingNetworks.map((network, index) => makeFiveBrainCar(network, index, trainingTracks[0])) : trainingNetworks.map((network, index) => makeTrainingCar(network, (index % 3) - 1, trainingTracks[0])); applyLineageNames();
  refreshTrainingObstacles(activeTrack, trainingWorldSeed);
  trainingIndex = 0;
  trainingPopulation.forEach((car) => car.network?.reset());
  const episodeCount = Math.max(1, trainingTracks.length);
  const evolutionLabel = ghostEvolution ? "independent evolution · isolated candidate worlds" : softContactEvolution ? "Ghost contact mode · overlap is penalized but non-blocking" : "shared-track evolution · rigid collision dynamics enabled";
  updateEvolutionTelemetry();
  setProgress(((trainingGeneration - 1) * trainingPopulationSize * episodeCount) / Math.max(1, trainingPopulationSize * episodeCount * requestedGenerations), fiveBrainEvolution ? `generation ${trainingGeneration}/${requestedGenerations} · ${trainingPopulationSize} brains · ${trainingTracks[0].name}` : `generation ${trainingGeneration}/${requestedGenerations} · candidate 1/${trainingPopulationSize} · ${trainingTracks[0].name}`, fiveBrainEvolution ? evolutionLabel : "visual · preparing candidate");
}

function breed(): void {
  updateLineageEvaluations();
  const evaluated = [...trainingNetworks].map((network, index) => {
    const car = trainingPopulation[index]; const score = car?.score ?? -Infinity; const progress = car?.totalProgress ?? car?.progress ?? 0; const finished = car?.finished ?? false;
    return { network, score, car, progress, finished, lineageId: trainingLineageIds[index] };
  });
  const incumbentRanked = [...evaluated].sort((a, b) => compareEvolutionCandidates({ progress: b.progress, fitness: b.score, finished: b.finished }, { progress: a.progress, fitness: a.score, finished: a.finished }));
  const candidate = incumbentRanked[0];
  if (!candidate || !Number.isFinite(candidate.score)) throw new Error("generation produced no finite brain fitness");
  const finiteFitness = evaluated.map((entry) => entry.score).filter(Number.isFinite);
  const fitnessMin = finiteFitness.length > 0 ? Math.min(...finiteFitness) : 0;
  const fitnessMax = finiteFitness.length > 0 ? Math.max(...finiteFitness) : fitnessMin;
  const progressShare = breedingProgressWeight / 100;
  const ranked = [...evaluated]
    .map((entry) => ({ ...entry, selectionScore: blendedEvolutionSelectionScore({ progress: entry.progress, fitness: entry.score, finished: entry.finished }, progressShare, fitnessMin, fitnessMax) }))
    .sort((a, b) => b.selectionScore - a.selectionScore || compareEvolutionCandidates({ progress: b.progress, fitness: b.score, finished: b.finished }, { progress: a.progress, fitness: a.score, finished: a.finished }));
  const winnerProgress = candidate.progress;
  const progressGain = winnerProgress - previousGenerationProgress;
  const retainedProgress = Math.max(previousGenerationProgress, winnerProgress);
  const progressStalled = trainingGeneration > 1 && progressGain < 0.02;
  const improved = shouldAcceptEvolutionCandidate({ progress: candidate.progress, fitness: candidate.score, finished: candidate.finished }, bestNetwork ? { progress: bestProgressForContext, fitness: bestFitness, finished: bestFinishedForContext } : undefined);
  const routeStable = Boolean(bestNetwork) && candidate.progress <= bestProgressForContext + 0.005;
  const rewardGain = Number.isFinite(bestFitness) ? candidate.score - bestFitness : Infinity;
  const rewardPlateau = trainingGeneration > 1 && Number.isFinite(bestFitness) && routeStable && rewardGain >= 0 && rewardGain <= Math.max(2, Math.abs(bestFitness) * 0.01);
  const plateauDetected = progressStalled || rewardPlateau || !improved;
  if (improved) {
    bestNetwork = candidate.network.clone(); bestFitness = candidate.score; generation = trainingGeneration;
    bestProgressForContext = clamp(candidate.progress, 0, 1); bestFinishedForContext = candidate.finished;
  }
  if (plateauDetected) { plateauStreak += 1; plateauReason = rewardPlateau ? "reward plateau" : progressStalled ? "route plateau" : "candidate rejected"; }
  else { plateauStreak = 0; plateauReason = "none"; }
  previousGenerationProgress = retainedProgress;
  if (plateauDetected) {
    mutationRate = clamp(mutationRate * 1.28 + 0.01, DEFAULT_MUTATION_RATE, 0.65);
    mutationAmount = clamp(mutationAmount * 1.22 + 0.01, DEFAULT_MUTATION_AMOUNT, 0.85);
  } else {
    mutationRate = clamp(mutationRate * 0.92, DEFAULT_MUTATION_RATE, 0.65);
    mutationAmount = clamp(mutationAmount * 0.94, DEFAULT_MUTATION_AMOUNT, 0.85);
  }
  const exploring = plateauExplorationEnabled && plateauStreak >= plateauPatience;
  updateEvolutionTelemetry();
  ui.generation.textContent = `${generation}`; ui.fitness.textContent = bestFitness.toFixed(1); ui.progress.textContent = `${Math.round(retainedProgress * 100)}%`;
  recordEvolutionPoint(candidate.score, winnerProgress, retainedProgress, candidate.lineageId, lineageNodeById(candidate.lineageId)?.name);
  const result = improved ? `accepted new incumbent ${bestFitness.toFixed(1)}` : `rejected candidate ${candidate.score.toFixed(1)}; incumbent remains ${bestFitness.toFixed(1)}`;
  const reason = rewardPlateau ? "reward plateau" : progressStalled ? "route progress plateau" : improved ? "progress improved" : "fitness did not improve";
  trainingLineageIds.forEach((id) => { const node = lineageNodeById(id); if (node && node.status !== "immigrant") node.status = "candidate"; });
  const candidateNode = lineageNodeById(candidate.lineageId); if (candidateNode) candidateNode.status = improved ? "retained" : "rejected";
  const retainedParentId = improved ? candidate.lineageId : trainingLineageIds[0]; const retainedNode = lineageNodeById(retainedParentId); if (retainedNode) retainedNode.status = "retained";
  renderLineageTree();
  rememberTrainingContext();
  // Incumbent acceptance deliberately remains progress-first, but mating must
  // follow the user's progress/reward ratio. Keeping `candidate` here made
  // the slider mostly cosmetic because only the runner-up came from `ranked`.
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const winnerShare = winnerMatingShare / 100;
  const runnerUpShare = 1 - winnerShare;
  const winnerParentId = winner.lineageId;
  const runnerUpParentId = runnerUp?.lineageId;
  appendEvent(`generation ${trainingGeneration} complete · ${result} · ${reason} · plateau ${plateauStreak}/${plateauPatience} · ${exploring ? "exploration burst with random immigrants" : "local mutations"} · mutation ${(mutationRate * 100).toFixed(0)}% / ${(mutationAmount).toFixed(2)} · breeding ranked ${breedingProgressWeight}% progress / ${100 - breedingProgressWeight}% normalized reward · protected incumbent mates ${Math.round(winnerShare * 100)}% with blended winner and ${Math.round(runnerUpShare * 100)}% with runner-up`);
  persistBestBrain();
  trainingNetworks = createMutationPopulation(ranked.length, bestNetwork, trainingWorldSeed + trainingGeneration * 1000, mutationRate, mutationAmount, { plateauStreak: plateauExplorationEnabled ? plateauStreak : 0, plateauPatience, incumbentMatingPool: [winner.network, runnerUp?.network ?? winner.network], incumbentMatingWeights: [winnerMatingShare, 100 - winnerMatingShare] });
  if (trainingGeneration < requestedGenerations) registerNextLineagePopulation(trainingNetworks, trainingGeneration + 1, retainedParentId, winnerParentId, runnerUpParentId, winnerMatingShare, exploring);
}

function finishVisualGeneration(): void { breed(); if (trainingGeneration >= requestedGenerations) finishTraining(); else { trainingGeneration += 1; startVisualGeneration(); } }

async function runHeadless(): Promise<void> {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = false; fiveBrainEvolution = false; ghostEvolution = ui.ghostEvolutionToggle.checked; manualMode = false; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 5, 2, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig(); readEvolutionConfig(); activeTrack = trainingTracks[0]; prepareTrainingContext(); trainingWorldSeed = 7000; plateauStreak = 0; plateauReason = "none"; mutationRate = DEFAULT_MUTATION_RATE; mutationAmount = DEFAULT_MUTATION_AMOUNT; previousGenerationProgress = 0; resetEvolutionHistory(); resetLineage(); trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, trainingWorldSeed, DEFAULT_MUTATION_RATE, DEFAULT_MUTATION_AMOUNT); registerInitialLineagePopulation(trainingNetworks); ensureWorkingCheckpoint(); updateEvolutionTelemetry();
  beginRun("Headless training", `Evaluating ${trainingPopulationSize} controllers across ${requestedGenerations} generations on ${selectedTrackLabel()}${freshTrainingContext ? ` · new route baseline reset · warm-start from ${warmStartLabel}` : ""}${ghostEvolution ? " in independent candidate worlds" : " with traffic bots"}${randomObjectsEnabled ? ` and ${trainingObstacleCount()} ${randomObjectKind} objects` : ""}${curriculumEnabled ? " on a progressive hazard curriculum" : ""}. Parent ranking uses ${breedingProgressWeight}% progress / ${100 - breedingProgressWeight}% normalized reward; the protected incumbent mates ${winnerMatingShare}% with the blended winner and ${100 - winnerMatingShare}% with the runner-up.`, "HEADLESS TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—";
  try {
    for (; trainingGeneration <= requestedGenerations && training && trainingSession === session; trainingGeneration += 1) {
      trainingPopulation = trainingNetworks.map((network) => makeTrainingCar(network, 0, trainingTracks[0])); applyLineageNames();
      trainingIndex = 0;
      setRunState("Headless training", `Generation ${trainingGeneration}/${requestedGenerations}: evaluating each candidate across ${trainingTracks.length} track${trainingTracks.length === 1 ? "" : "s"}.`, "running", "HEADLESS TRAINING");
      for (const [index, car] of trainingPopulation.entries()) {
        if (!training || trainingSession !== session) return;
        trainingIndex = index;
        const totalCandidates = Math.max(1, trainingPopulationSize * requestedGenerations);
        const startedCandidates = (trainingGeneration - 1) * trainingPopulationSize + index;
        setProgress(startedCandidates / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · ${lineageNameForIndex(index)} (${index + 1}/${trainingPopulationSize})`, `headless · ${trainingTracks.length} track${trainingTracks.length === 1 ? "" : "s"} · evaluating…`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const result = evaluateGeneralist(car.network as SpikingNetwork, trainingTracks, rewardConfig, physicsConfig, ghostEvolution, trainingObstacleCount(), trainingWorldSeed, randomObjectKind); car.score = result.fitness; car.progress = result.progress; car.totalProgress = result.progress; car.finished = result.finished; car.laps = result.laps; car.rewardTotals = result.rewardTotals; car.rewardBreakdown = result.rewardTotals; car.lastReward = 0; car.forwardAlignment = 0;
        trainingIndex = index + 1;
        const completedCandidates = (trainingGeneration - 1) * trainingPopulationSize + trainingIndex;
        ui.fitness.textContent = result.fitness.toFixed(1);
        ui.progress.textContent = `${Math.round(result.progress * 100)}%`;
        setProgress(completedCandidates / totalCandidates, `generation ${trainingGeneration}/${requestedGenerations} · ${lineageNameForIndex(index)} (${trainingIndex}/${trainingPopulationSize})`, `headless · ${result.ticks} ticks across ${result.episodes.length} track${result.episodes.length === 1 ? "" : "s"} · fitness ${result.fitness.toFixed(1)}`);
        updateRewardTelemetry(car);
        if (index === 0 || index === trainingPopulation.length - 1 || (index + 1) % Math.max(1, Math.floor(trainingPopulationSize / 4)) === 0) appendEvent(`generation ${trainingGeneration}: ${lineageNameForIndex(index)} (${index + 1}/${trainingPopulationSize}) scored ${result.fitness.toFixed(1)} across ${result.episodes.length} tracks`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      breed();
    }
    if (training && trainingSession === session) finishTraining();
  } catch (error) { if (training && trainingSession === session) failTraining(error); }
}

function startVisualTraining(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; fiveBrainEvolution = false; manualMode = false; trainingHistory = []; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 5, 2, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig(); readEvolutionConfig(); activeTrack = trainingTracks[0]; prepareTrainingContext(); trainingWorldSeed = 5000; plateauStreak = 0; plateauReason = "none"; mutationRate = DEFAULT_MUTATION_RATE; mutationAmount = DEFAULT_MUTATION_AMOUNT; previousGenerationProgress = 0; resetEvolutionHistory(); resetLineage(); trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, trainingWorldSeed, DEFAULT_MUTATION_RATE, DEFAULT_MUTATION_AMOUNT); registerInitialLineagePopulation(trainingNetworks); ensureWorkingCheckpoint(); updateEvolutionTelemetry();
  beginRun("Visual training", `Watching ${trainingPopulationSize} candidates drive across ${requestedGenerations} generations on ${selectedTrackLabel()}${freshTrainingContext ? ` · new route baseline reset · warm-start from ${warmStartLabel}` : ""}${randomObjectsEnabled ? ` with ${trainingObstacleCount()} ${randomObjectKind} objects` : ""}${curriculumEnabled ? " on a progressive hazard curriculum" : ""}. Parent ranking uses ${breedingProgressWeight}% progress / ${100 - breedingProgressWeight}% normalized reward; the protected incumbent mates ${winnerMatingShare}% with the blended winner and ${100 - winnerMatingShare}% with the runner-up.`, "VISUAL TRAINING");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function startFiveBrainEvolution(): void {
  const session = ++trainingSession; clearVisualTimer(); training = true; running = false; visualTraining = true; fiveBrainEvolution = true; ghostEvolution = ui.ghostEvolutionToggle.checked; manualMode = false; trainingHistory = []; trainingGeneration = 1;
  trainingPopulationSize = readInteger(ui.population, 5, 2, 80); requestedGenerations = readInteger(ui.generations, 100, 1, 10000); trainingTracks = selectedTracks(); rewardConfig = readRewardConfig(); physicsConfig = readPhysicsConfig(); readRoadObjectConfig(); readEvolutionConfig(); activeTrack = trainingTracks[0]; prepareTrainingContext(); trainingWorldSeed = 9000; plateauStreak = 0; plateauReason = "none"; mutationRate = DEFAULT_MUTATION_RATE; mutationAmount = DEFAULT_MUTATION_AMOUNT; previousGenerationProgress = 0; resetEvolutionHistory(); resetLineage(); trainingNetworks = createMutationPopulation(trainingPopulationSize, bestNetwork, trainingWorldSeed, DEFAULT_MUTATION_RATE, DEFAULT_MUTATION_AMOUNT); registerInitialLineagePopulation(trainingNetworks); ensureWorkingCheckpoint(); updateEvolutionTelemetry();
  const mode = ghostEvolution ? "independent candidate worlds (no candidate sensing, collisions, or influence)" : softContactEvolution ? "Ghost contact mode (candidates sense and penalize overlap, but contact is non-blocking)" : "a shared physical track with rigid collision dynamics";
  beginRun("Population evolution", `Racing ${trainingPopulationSize} brains simultaneously in ${mode} for ${requestedGenerations} generations on ${selectedTrackLabel()}${freshTrainingContext ? ` · new route baseline reset · warm-start from ${warmStartLabel}` : ""}${randomObjectsEnabled ? ` with ${randomObjectCount} ${randomObjectKind} objects` : ""}. Parent ranking uses ${breedingProgressWeight}% progress / ${100 - breedingProgressWeight}% normalized reward; the protected incumbent mates ${winnerMatingShare}% with the blended winner and ${100 - winnerMatingShare}% with the runner-up.`, "POPULATION EVOLUTION");
  setBusy(true); ui.generation.textContent = "0"; ui.fitness.textContent = "—"; startVisualGeneration(); scheduleVisualBatch(session);
}

function scheduleVisualBatch(session: number): void {
  if (!visualTraining || trainingSession !== session) return;
  try { for (let index = 0; index < VISUAL_TRAINING_STEPS_PER_FRAME && visualTraining; index += 1) trainPopulationStep(); }
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
ui.useLineageButton.addEventListener("click", () => safely(useSelectedLineage));
ui.downloadLineageButton.addEventListener("click", () => safely(downloadSelectedLineage));
ui.trackSelect.addEventListener("change", () => { updateTrackInfo(); if (!training) safely(() => { activateStoredContextForRace(); launchRace(); }); });
ui.wallsToggle.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(physicsConfig.wallsEnabled ? "track walls enabled · off-track recovery is active" : "track walls disabled · cars may leave the road and only receive off-track penalties"); });
ui.adaptiveTimeToggle.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(physicsConfig.adaptiveTimeLimit ? `adaptive time enabled · up to ${physicsConfig.maxAdaptiveExtensions} evidence-based extensions` : "adaptive time disabled · candidates stop at the base tick limit"); });
ui.adaptiveExtensions.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(`adaptive extension limit set to ${physicsConfig.maxAdaptiveExtensions}`); });
ui.checkpointCount.addEventListener("change", () => { physicsConfig = readPhysicsConfig(); appendEvent(`checkpoint gate count set to ${physicsConfig.checkpointCount}; ordered gates will be rebuilt on the next run`); });
ui.ghostEvolutionToggle.addEventListener("change", () => { ghostEvolution = ui.ghostEvolutionToggle.checked; if (ghostEvolution && ui.softContactToggle.checked) { ui.softContactToggle.checked = false; softContactEvolution = false; appendEvent("independent evolution selected · Ghost contact mode disabled because candidates are fully isolated"); } else appendEvent(ghostEvolution ? "independent evolution enabled · each candidate has its own world and cannot sense, collide with, or influence another" : "shared-track evolution enabled · candidates now learn traffic interactions"); });
ui.softContactToggle.addEventListener("change", () => { softContactEvolution = ui.softContactToggle.checked; if (softContactEvolution && ui.ghostEvolutionToggle.checked) { ui.ghostEvolutionToggle.checked = false; ghostEvolution = false; appendEvent("Ghost contact mode selected · independent evolution disabled so candidates can sense one another"); } else appendEvent(softContactEvolution ? "Ghost contact mode enabled · overlap is penalized but never separates or stalls a candidate" : "Ghost contact mode disabled · shared evolution uses rigid collision dynamics"); });
ui.obstacleToggle.addEventListener("change", () => { readRoadObjectConfig(); appendEvent(randomObjectsEnabled ? `random road objects enabled · ${randomObjectCount} ${randomObjectKind} objects per episode` : "random road objects disabled"); });
ui.obstacleCount.addEventListener("change", () => { readRoadObjectConfig(); appendEvent(`random road object count set to ${randomObjectCount}`); });
ui.obstacleKind.addEventListener("change", () => { readRoadObjectConfig(); appendEvent(`road object type set to ${randomObjectKind}`); });
ui.plateauExplorationToggle.addEventListener("change", () => { readEvolutionConfig(); updateEvolutionTelemetry(); appendEvent(plateauExplorationEnabled ? `plateau exploration enabled · patience ${plateauPatience} generations` : "plateau exploration disabled · mutation stays local"); });
ui.plateauPatience.addEventListener("change", () => { readEvolutionConfig(); updateEvolutionTelemetry(); appendEvent(`plateau patience set to ${plateauPatience} generations`); });
ui.breedingProgressWeight.addEventListener("input", () => { readEvolutionConfig(); });
ui.breedingProgressWeight.addEventListener("change", () => { readEvolutionConfig(); appendEvent(`breeding priority set to ${breedingProgressWeight}% route progress / ${100 - breedingProgressWeight}% normalized reward; lap completion and incumbent protection remain progress-first`); });
ui.winnerMatingShare.addEventListener("change", () => { readEvolutionConfig(); appendEvent(`breeding mix set to ${winnerMatingShare}% blended winner / ${100 - winnerMatingShare}% runner-up; incumbent remains protected`); });
ui.curriculumToggle.addEventListener("change", () => { readEvolutionConfig(); appendEvent(curriculumEnabled ? "progressive hazards enabled · obstacle count ramps with training" : "progressive hazards disabled · obstacle count stays fixed"); });
[ui.rewardProgress, ui.rewardDirection, ui.rewardMoving, ui.rewardStanding, ui.rewardWrong, ui.rewardReverse, ui.rewardOffTrack, ui.rewardEdge, ui.rewardProximity, ui.rewardHazard, ui.rewardCenterline, ui.rewardCollision, ui.rewardCrash, ui.rewardCheckpoint, ui.rewardFinish].forEach((input) => {
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
  readEvolutionConfig(); updateEvolutionTelemetry(); resetEvolutionHistory(); updateTrackInfo();
  launchRace();
  setRunState("Ready to race", "The demo brain is driving now. Choose a training mode to evolve a better fly pilot.", "ready", "RACE MODE");
  appendEvent("application ready · choose a command to begin");
  window.dispatchEvent(new Event("flykart:ready"));
  requestAnimationFrame(frame);
} catch (error) {
  failApplication(error);
}
