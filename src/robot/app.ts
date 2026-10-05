import { attachJsonImport } from '../json-import';
import {TargetLab} from './target-lab';
import {RunLibrary} from './run-library';
import {SensorTiming} from './sensor-timing';
import {EnergyState,DEFAULT_HUNGER,validateHunger} from './homeostasis';
import {guardMotors,DEFAULT_GUARD} from './collision-guard';
import {validateVisual,prepareVisual} from './imported-assets';
import { DEFAULT_VIBRATION, validateVibration, VibrationSensor } from "./vibration";
import { RobotWorkbench } from "./workbench";
import { setupMonitorLayout } from "./monitor-layout";
import { validateRobotConfig } from "./model";
import "./robot.css";
import { Action, SpikingNetwork, clamp } from "../core";
import { controllerCheckpoint, exportVisionBrain, importFile } from "../vision/format";
import { Perceiver, VisionModel } from "../vision/perception";
import { worldDomain } from "../vision/world/worldDomain";
import { sensorsFromEstimates } from "../vision/interface";
import { Firmware } from "./firmware";
import { RoomMemory, DEFAULT_MEMORY, MemorySettings, validateMemorySettings } from "./memory";
import { ESP_WIRING, UNO_WIRING, RobotConfig, RobotPhysics, RobotSonar, Wiring, WorldObject, ObjectKind, OBJECT_TYPES, ROOM_TYPES, traversable, makeObject, preset, wiringIssues } from "./model";
import { HabitatScene } from "./scene";
import { CHECK_PHASES, DEFAULT_ADAPTER, DrivetrainCheck, MotorAdapter, motorRequests, PROGRAMS, ProgramId, programSketch, validateAdapter } from "./controls";
import { DEFAULT_NOISE, NOISE_PRESETS, NoiseSource, SensorNoise, validateNoise } from "./noise";
import { SensorConsole, EventKind } from "./telemetry";
import { SketchEditor } from "./editor";
import { WiringDiagram } from "./wiring-diagram";
import { reconnect, rewritePins } from "./rewiring";
import { copyText } from "./serial";
import { HardwarePanel } from "./hardware-panel";
import { TrainingOptions, TrainingRun } from "./training";
import { DEFAULT_VISION, VisualSwarm, VisionSettings, validateVisionSettings, visualFeatures } from "./vision-workbench";
import { DEFAULT_OBJECTIVE, MissionSnapshot, ObjectiveRun, SugarPolicy, SensoryCue, EMPTY_CUE, cameraCue, scentCue, validateMission } from "./objectives";
import { placementError, validatePose } from "./placement";
import type { Pose } from "./model";
import { CalibrationProfile, DEFAULT_CALIBRATION, StateEstimator, HeadingPID, PIDSettings, compensate, validateCalibration } from './state-estimator';
import { VisualPlaces } from './places';
import { CalibrationPanel } from './calibration-panel';
import { ResearchPanel } from './research-panel';
import { compactInput } from './compact';
import { compactSketch } from './compact-firmware';
import { EpisodeRecorder, EpisodeStep } from './training';
import type { TrialCase, Variant } from "./experiments";
import { TaskBrain, taskObservation, visualCoach, racerToRoom } from './task-brain';
import { DEFAULT_TASK, TaskSettings, TaskJudge, LifecycleSnapshot, TaskEvidence, validateLifecycle, validateTaskSettings, taskCase, movingTarget } from './lifecycle';
import { LifecyclePanel } from './lifecycle-panel';
import { TargetTracker, EMPTY_TARGET } from './target-tracker';
import { CameraDelay } from './camera-delay';
import { TaskChallenge, taskEnvironment } from './task-validation';
import { TASK_HUNGER, usesVibration, taskContract, fingerprint } from './sensor-contract';

const root = document.querySelector<HTMLDivElement>("#robot-app")!;
root.innerHTML = `
<header><div><p class="eyebrow">FLYKART / EMBODIED INTELLIGENCE</p><h1>Robot habitat<span style="color:var(--accent)">.</span></h1><p class="subtitle">A little fly. A real-sized robot. A world to learn.</p></div>
<nav aria-label="FlyKart pages"><a href="./index.html">Race lab ↗</a><a href="./vision.html">Vision lab ↗</a><span class="pill">ESP32-CAM · FOUR WHEELS</span></nav></header>
<main class="shell">
  <div class="toolbar"><div class="toolbar-group"><button id="run" class="primary">▶ Run simulation</button><button id="step">Step</button><button id="reset" class="quiet">Reset robot</button><label>Habitat <select id="preset"><option value="room">Workshop room</option><option value="garden">Garden</option><option value="empty">Empty floor</option></select></label></div><div class="toolbar-group"><button id="save-lab">Export lab</button><label class="import-label">Import lab<input id="lab-file" class="scene-file" type="file" accept=".json,application/json"></label><button id="advanced">⚙ Components & wiring</button></div></div>
  <section class="experiment"><div class="program-controls"><label>Program <select id="program" aria-label="Controller preset">${PROGRAMS.map(p => `<option value="${p.id}">${p.title}</option>`).join("")}</select></label><details class="program-help"><summary>Preset details</summary><p id="program-note"></p></details></div><div class="experiment-actions"><button id="bench-check">Clear floor & run drive check</button><button id="show-code" class="quiet">Hide code</button><a href="#sensor-console">Sensor console ↓</a></div></section>
  <div class="workspace">
    <section class="world-column" aria-label="Robot world">
      <div class="stage"><canvas id="habitat" aria-label="Interactive Three.js robot habitat"></canvas><div class="view-tag">HABITAT / LIVE 3D</div><div class="stage-chip" id="motion-state">Paused · orbit to explore</div><div class="stage-controls"><button id="focus">Follow robot</button><button id="overview">Overview</button></div><div class="scale">7 × 7 m floor · grid spacing 20 cm</div><div class="stage-note">Drag to orbit · scroll to zoom · click to select</div></div>
      <div class="object-tools"><select id="object-kind" aria-label="Object to add"><option value="wall">Wall</option><option value="table">Table</option><option value="chair">Chair</option><option value="rock">Rock</option><option value="stone">Low stone</option><option value="bush">Bush</option><option value="tree">Tree</option><option value="water">Water</option></select><button id="add-object">＋ Add object</button><button id="add-room">＋ Room</button><button id="undo" class="quiet" disabled>↶ Undo scene</button><button id="redo" class="quiet" disabled>↷ Redo scene</button><span class="spacer"></span><small id="object-count"></small></div>
      <div class="sensors">
        <div class="card sensor-card"><div class="sensor-title">01 / CAMERA <span>160 × 120 · RGB565</span></div><canvas id="camera" class="camera-feed" width="160" height="120" aria-label="Low resolution ESP32 camera view"></canvas><small>OV2640-style colour capture at <span id="camera-rate">10</span> Hz. Lens height <span id="camera-height">6.5</span> cm.</small></div>
        <div class="card sensor-card"><div class="sensor-title">02 / FLY VISION <span id="retina-size">48 × 24</span></div><canvas id="fly-eye" class="fly-feed" width="288" height="144" aria-label="Actual camera pixels sent to the fly vision network"></canvas><div class="input-bars" id="input-bars"></div><small id="perception-note">Colour image → estimates → spiking brain. Loading eyes…</small><div class="neural-labels"><span>LEFT</span><span>INPUT ACTIVITY</span><span>RIGHT</span></div></div>
        <div class="card sensor-card map-card"><div><div class="sensor-title">03 / ROOM MEMORY <span>512 KENYON CELLS</span></div><canvas id="room-map" width="240" height="180" aria-label="Sensor-derived room map and estimated robot position"></canvas></div><div><small>Estimated map from sonar + wheel commands. Amber: uncertain echoes. Green: traversed rays. Position drifts.</small><div class="memory-row"><span id="memory-count">0 cells learned</span><span id="memory-recall">No recall yet</span></div></div></div>
      </div>
    </section>
    <aside class="sidebar">
      <section class="card"><div class="card-head"><h2>The fly's brain</h2><span>17 / 19 → 48 → 4</span></div><p id="brain-name" class="brain-name">Loading bundled world brain…</p><select id="drive-mode" class="drive-mode" aria-label="Robot control mode"><option value="fly">Fly controls the robot</option><option value="manual">Manual · WASD / arrow keys</option><option value="sketch">Sketch only · brain requests zero</option></select><div class="row"><label class="import-label">Import brain<input id="brain-file" class="scene-file" type="file" accept=".json,application/json"></label><button id="export-brain">Export brain</button></div><div id="spikes" class="spikes"></div><div class="neural-labels"><span>48 SPIKING NEURONS</span><span id="adapter">WORLD INPUTS</span></div><label class="check"><input id="memory-enabled" type="checkbox" checked> Kenyon visual memory + sonar map</label><div class="row"><button id="forget">Forget room</button><button id="restore-brain" class="quiet">Bundled brain</button></div><p id="brain-note" class="warning-label">Eyes trained in the old renderer; transfer to 3D is experimental.</p></section>
      <section class="card"><div class="card-head"><h2>HC-SR04 sonar</h2><span><span class="legend-dot"></span>FRONT BEAM</span></div><div class="sonar-readout"><strong id="range">—</strong><span id="range-unit">cm</span></div><p class="muted" style="font-size:11px" id="echo-note">No return is an unknown distance.</p><label class="check"><input id="beam-visible" type="checkbox" checked> Show approximate acoustic cone</label><div class="metrics"><div class="metric"><strong id="speed">0</strong><span>cm/s · actual motion</span></div><div class="metric"><strong id="hits">0</strong><span>contacts</span></div><div class="metric"><strong id="left-pwm">0</strong><span>left PWM</span></div><div class="metric"><strong id="right-pwm">0</strong><span>right PWM</span></div></div></section>
      <section class="card"><div class="card-head"><h2>SW-420 vibration</h2><span>DIGITAL SWITCH</span></div><p id="vibration-status">Disabled · optional sensor</p><button id="vibration-shake">Inject a test shake</button><small>Brief vibration pulses can indicate impact, motor chatter or a cable crossing. Event hold makes short pulses readable; this switch cannot measure crash force.</small></section>
      <section class="card"><div class="card-head"><h2>Object inspector</h2><span>METRES</span></div><select id="object-list" class="select-object" aria-label="Selected world object"><option value="">Select an object…</option></select><div id="object-editor"><p class="inspector-empty">Click an object in the habitat to move, rotate or resize it. Tables and chairs have legs and real underside clearance.</p></div></section>
    </aside>
  </div>
  <p id="status" class="status" role="status" aria-live="polite">Preparing the habitat…</p>
  <details class="code-panel" open><summary><span id="sketch-file">drivetrain-check.ino</span><span>EDIT → APPLY → RUN</span></summary><div class="code-body"><div class="code-editor"><div class="editor-tools"><button id="apply-code" class="primary">✓ Apply code</button><button id="default-code">Fly bridge</button><button id="reflex-code">Sonar avoidance</button><label class="import-label">Open .ino<input id="ino-file" class="scene-file" type="file" accept=".ino,.txt"></label><button id="export-code">Save .ino</button></div><div class="notepad"><pre id="code-gutter" aria-hidden="true"></pre><div class="code-surface"><pre id="code-syntax" aria-hidden="true"></pre><textarea id="sketch" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Arduino controller code"></textarea></div></div><div class="editor-status"><p id="code-status" class="code-status" role="status"></p><span id="executing-line"></span></div></div><details class="code-help"><summary>Sketch API & virtual GPIO</summary><p><code>brainLeft()</code> / <code>brainRight()</code> read routed motor requests. Pin writes control the driver. <code>pulseIn()</code> needs a sonar trigger. <code>Serial.print()</code> / <code>Serial.println()</code> write to the console. <code>vibrationValid()</code> / <code>vibrationActive()</code> expose the optional held SW-420 signal; <code>digitalRead(VIBRATION)</code> reads raw DO when wired. <code>cameraFrame()</code> and <code>cameraMeanR/G/B()</code> expose camera statistics; the complete pixels appear in the camera panel.</p><p>Numeric variables, functions, if/else, arithmetic and delays are supported. User loops, arrays, libraries and pointers are unsupported. This bounded Arduino-style interpreter uses floating-point numbers and tick-based timing. Hardware deployment needs real sensor and brain adapters.</p><div id="pins" class="pin-monitor"></div></details></div></details>
  <section class="card console-panel" id="sensor-console"><div class="console-head"><div><p class="eyebrow">INSTRUMENTS</p><h2>Sensor & controller console</h2></div><div class="row"><select id="console-filter" aria-label="Console event type"><option value="all">All events</option>${["sonar", "vibration", "camera", "brain", "serial", "check", "system"].map(k => `<option>${k}</option>`).join("")}</select><label class="check"><input id="log-enabled" type="checkbox" checked> Record</label><label class="check"><input id="log-follow" type="checkbox" checked> Follow</label><button id="clear-log">Clear</button><button id="export-log">Export log</button><button id="export-frame">Save camera PNG</button></div></div><div class="instrument-strip"><span id="camera-stats">Camera waiting</span><span id="brain-stats">No neural output yet</span><span id="run-reason">Paused · operator</span></div><div id="console-lines" role="log" aria-label="Sensor and Serial output"></div><small id="log-count">Bounded to the most recent 1,500 events. Camera logs contain frame statistics; PNG saves the complete delivered frame.</small><details class="noise-panel"><summary>Sensor noise & lighting <span id="noise-summary">No added noise</span></summary><div class="row"><label>Profile <select id="noise-preset"><option value="clean">No added noise</option><option value="mild">Mild noise</option><option value="harsh">Dim & unreliable</option><option value="custom">Custom</option></select></label><small>Noise changes the delivered camera pixels and sonar readings, including the fly's inputs. No-echo stays unknown; the HC-SR04 base model still includes echo uncertainty.</small></div><div id="noise-fields" class="advanced-fields"></div></details></section>
  <footer><span>26 × 17 cm chassis · 11.5 cm axle spacing · 65 mm wheels · 6.5 cm sensor mount</span><span>Physics & learning approximations · <a href="./docs/robot-habitat.html">Hardware notes & model limits ↗</a></span></footer>
</main>
<dialog id="pinout" class="pinout-dialog"><div class="dialog-head"><div><p class="eyebrow">HARDWARE / CONNECTIONS</p><h2>Pinout & wires</h2><p>Follow the wires from controller pins to the robot's components.</p></div><div class="row"><button id="export-wiring">Save SVG</button><button id="edit-pinout" class="primary">Edit connections</button><button id="close-pinout" aria-label="Close wiring diagram">✕</button></div></div><div id="pinout-diagram"></div></dialog>
<dialog id="hardware"><div class="dialog-head"><div><h2>Components & wiring</h2><p>Match the virtual robot to your build. Dimensions are in centimetres.</p></div><button id="close-hardware" aria-label="Close components window">✕</button></div>
  <div class="advanced-section"><h3>Chassis & drivetrain</h3><div class="advanced-fields" id="physics-fields"></div><small style="display:block;margin-top:12px">Four yellow 48:1 DC gearmotors, two paired per side. Differential skid steering; motor current and battery sag are not electrically simulated.</small></div>
  <div class="advanced-section"><h3>Camera & acoustic sensor</h3><div class="advanced-fields" id="sensor-fields"></div><div class="row"><label class="check"><input id="camera-enabled" type="checkbox" checked> Camera connected</label><label class="check"><input id="sonar-enabled" type="checkbox" checked> Sonar connected</label></div><small>HC-SR04: 2–400 cm nominal range, 10 µs trigger, ≈66 ms between samples. Echo depends on height, target size and incidence; water at floor level returns nothing. Lens FOV is an editable assumption.</small></div>
  <div class="advanced-section"><h3>SW-420 · LM393 digital vibration switch</h3><div class="row"><label class="check"><input id="vibration-enabled" type="checkbox"> Sensor installed</label><label class="check"><input id="vibration-active-low" type="checkbox" checked> Active LOW · verify your module</label></div><div class="advanced-fields"><label>Virtual sensitivity · 0–1<input id="vibration-sensitivity" type="number" min="0" max="1" step=".05"></label><label>Bounce lockout · ms<input id="vibration-debounce" type="number" min="1" max="100"></label><label>Event hold · ms<input id="vibration-hold" type="number" min="20" max="2000"></label></div><label class="check"><input id="vibration-gpio33" type="checkbox"> Modified board: GPIO33 status-LED pad accessible and LED isolated</label><p>Module size 32 × 15 mm; 3.3–5 V supply; DO is binary, not acceleration. On ESP32 use 3.3 V VCC and common GND. Adjust the physical comparator potentiometer to match sensitivity. All normal spare header pins are occupied in the USB build: GPIO33 requires a board modification; otherwise use an I/O expansion design. A disconnected DO is virtual-only and cannot be exported to hardware. Camera / PSRAM pins stay reserved.</p></div>
  <div class="advanced-section" id="connection-settings"><h3>Controller → L298N → motor pairs</h3><label>Controller board <select id="board"><option value="esp32-cam">ESP32-CAM · direct L298N</option><option value="uno">Legacy UNO pin profile · external camera bridge</option></select></label><div class="wiring-grid" id="wiring-fields" style="margin-top:14px"></div><div class="row" style="flex-wrap:wrap"><label class="check"><input id="common-ground" type="checkbox" checked> Shared ground</label><label class="check"><input id="echo-divider" type="checkbox" checked> ECHO level shifted to 3.3 V</label><label class="check"><input id="sd-card" type="checkbox"> SD interface active</label></div><details class="hardware-wiring-preview" open><summary>Wire diagram · pin preview</summary><div id="hardware-diagram"></div></details><div id="wiring-message" class="wiring-message"></div></div>
  <div class="advanced-section"><h3>Fly → motor adapter</h3><p class="routing-note">The imported brain exposes steer, drive, reverse and brake outputs. L1/L2/L3 and R1/R2/R3 below are named software leg adapters: each side duplicates one motor request. These checkpoints do not identify biological leg neurons.</p><div class="advanced-fields"><label>Steering<select id="route-steering"><option value="arc">Arc · steering follows drive</option><option value="pivot">Pivot · allow in-place turns</option></select></label><label>Turn gain<input id="route-gain" type="number" min="0" max="1" step=".05"></label><label>Maximum PWM<input id="route-pwm" type="number" min="0" max="255"></label><label>Left motors ←<select id="route-left">${["L1","L2","L3","R1","R2","R3"].map(k => `<option>${k}</option>`).join("")}</select></label><label>Right motors ←<select id="route-right">${["L1","L2","L3","R1","R2","R3"].map(k => `<option>${k}</option>`).join("")}</select></label><label class="check"><input id="route-invert-left" type="checkbox"> Reverse left polarity</label><label class="check"><input id="route-invert-right" type="checkbox"> Reverse right polarity</label></div><small>Left driver channel → front-left + rear-left. Right channel → front-right + rear-right. Apply to change routing; independent four-wheel control requires more driver channels.</small></div>
  <div class="advanced-section dialog-actions"><small>Pin changes update the sketch's numeric IN1–IN4, ENA/ENB, TRIG and ECHO declarations automatically. Reflash the hardware bridge after changing real connections. Invalid connections inhibit simulated motors.</small><button id="apply-hardware" class="primary">Apply components</button></div>
</dialog>`;

root.querySelector(".sidebar")!.before(root.querySelector(".sensors")!);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string, handler: () => void) => el(id).addEventListener("click", handler);
const check = (id: string) => el<HTMLInputElement>(id).checked;
const value = (id: string) => el<HTMLInputElement>(id).value;
const setText = (id: string, text: string) => { el(id).textContent = text; };
const message = (text: string, error = false) => { setText("status", text); el("status").classList.toggle("error", error); };
const codeMessage = (text: string, error = false) => { setText("code-status", text); el("code-status").classList.toggle("error", error); };
const download = (name: string, text: string, type = "application/json") => { const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); };
const safe = (fn: () => void) => { try { fn(); } catch (error) { message(error instanceof Error ? error.message : String(error), true); } };

let objects = preset("room");
let vibration=new VibrationSensor();
let hardwarePanel: HardwarePanel;
let lowerWorkbench:RobotWorkbench|undefined;
let training: TrainingRun | null = null, lastTraining: TrainingRun | null = null;
let trainingContext: { domain: "world" | "track"; initialGeneration: number; [key: string]: unknown } | null = null, trainingNoise: SensorNoise | null = null;
let floorColour = "#b7bea7", surfaceEvent = "", contactEvent = "";
let wiring: Wiring = { ...ESP_WIRING };
const physics = new RobotPhysics();
let startPose={...physics.pose};
let calibration:CalibrationProfile={...DEFAULT_CALIBRATION},compensationEnabled=false;
let estimator=new StateEstimator(physics.pose,calibration),places=new VisualPlaces();
let researchPanel:ResearchPanel,calibrationPanel:CalibrationPanel;
let liveRecorder=new EpisodeRecorder(),liveEpisode=0,lastStep:EpisodeStep;
let researchBaseline:{brain:SpikingNetwork|null;visionSettings:VisionSettings;config:RobotConfig;source:string;mode:string;policy:SugarPolicy;memoryEnabled:boolean}|null=null;
let lastTrainingAt=0;
let compactFeatures=new Array(30).fill(0),researchMode=false,returnToPlace=false;
let taskSettings:TaskSettings=structuredClone(DEFAULT_TASK),taskBrain=new TaskBrain(),taskJudge=new TaskJudge(taskSettings),taskOrigin:WorldObject|null=null;
let loadingBundled=false;
let energy=new EnergyState(DEFAULT_HUNGER),targetLab:TargetLab|undefined,sensorTiming=new SensorTiming(),guardReason='Guard off',captureCost=0;
let targetTracker=new TargetTracker(),taskSeen={...EMPTY_TARGET},cameraDelay=new CameraDelay();
let taskInputs:number[]=[],taskRaw:Float32Array=new Float32Array(0),taskWidth=48,taskHeight=24,taskPanel:LifecyclePanel,taskFrameRecorder:EpisodeRecorder|null=null;
let taskLineage:LifecycleSnapshot['lineage']=[],taskEvidence:TaskEvidence[]=[],taskParent:LifecycleSnapshot['parent'];
function journeySnapshot():LifecycleSnapshot{return {format:'robot-lifecycle',version:1,contract:taskContract(taskBrain.observation,taskSettings.modules,taskSettings.target),settings:structuredClone(taskSettings),brain:taskBrain.toJSON(),lineage:structuredClone(taskLineage),evidence:structuredClone(taskEvidence),...(taskParent?{parent:structuredClone(taskParent)}:{})};}
function lineage(event:string):void {taskLineage.push({event,time:new Date().toISOString(),generation:brainGeneration});if(taskLineage.length>100)taskLineage.shift();taskEvidence=[];}
function loadJourney(s:LifecycleSnapshot):void {taskSettings=s.settings;taskBrain=TaskBrain.fromJSON(s.brain);taskLineage=s.lineage;taskEvidence=s.evidence;taskParent=s.parent;taskJudge=new TaskJudge(taskSettings);energy=new EnergyState(validateHunger(taskSettings.hunger));targetLab?.sync();taskOrigin=objects.find(o=>o.id==='task-blue-ball')?structuredClone(objects.find(o=>o.id==='task-blue-ball')!):null;taskPanel?.sync();}
function taskActive():boolean{return taskSettings.mode!=='off'&&['task','coach'].includes(value('drive-mode'));}
let memorySettings:MemorySettings={...DEFAULT_MEMORY},visionSettings:VisionSettings={...DEFAULT_VISION};
let mission:MissionSnapshot={settings:{...DEFAULT_OBJECTIVE},goals:[],trail:[]};
let objectiveRun=new ObjectiveRun(mission),sugarPolicy=new SugarPolicy(memorySettings.count),cue:SensoryCue={...EMPTY_CUE};
let swarm:VisualSwarm|null=null;
let sonar = new RobotSonar();
let memory = new RoomMemory();
let controller: SpikingNetwork | null = null;
let perceiver: Perceiver | null = null;
let brainDomain: "world" | "track" = "world";
let brainName = "Bundled robot world brain";
let brainFitness=0, brainGeneration=0;
const eyes: Partial<Record<"world" | "track", VisionModel>> = {};
let program: ProgramId = "sequence", adapterConfig: MotorAdapter = { ...DEFAULT_ADAPTER }, noiseConfig: SensorNoise = { ...DEFAULT_NOISE };
let noise = new NoiseSource(noiseConfig), driveCheck = new DrivetrainCheck();
const consoleLog = new SensorConsole();
let consoleRevision = -1, cameraFrame = 0, cameraRGB = [0, 0, 0], cameraDropped = false, neuralLogTime = -Infinity, phaseIndex = -1, pauseReason = "operator";
let requests = motorRequests({ steer: 0, throttle: 0, brake: 0 }, adapterConfig);
let customDraft = "", appliedProgram: ProgramId = program;
let firmware = new Firmware(programSketch(program, wiring));
el<HTMLTextAreaElement>("sketch").value = firmware.source;
const sketchEditor = new SketchEditor(el<HTMLTextAreaElement>("sketch"), el("code-syntax"), el("code-gutter"));
el<HTMLSelectElement>("drive-mode").value = "sketch";
const workbench = document.createElement("div"); workbench.className = "workbench";
const stage = document.querySelector(".stage")!; stage.before(workbench); workbench.append(stage, document.querySelector(".code-panel")!);
el("spikes").after(Object.assign(document.createElement("div"), { id: "motor-routing", className: "motor-routing" }));
el("motor-routing").before(Object.assign(document.createElement("div"), { id: "fly-outputs", className: "fly-outputs", innerHTML: ["steer", "throttle", "reverse", "brake"].map(k => `<label>${k === "throttle" ? "drive" : k}<meter id="output-${k}" min="${k === "steer" ? -1 : 0}" max="1" value="0"></meter><span id="output-value-${k}">0</span></label>`).join("") }));
el("motor-routing").after(Object.assign(document.createElement("p"), { id: "motor-note", className: "warning-label" }));
const diagnostics = document.createElement("section"); diagnostics.className = "card check-card";
diagnostics.innerHTML = '<div class="card-head"><h2>Drivetrain check</h2><span id="check-cycles">REPEATS</span></div><p id="check-phase">Choose the straight & turn preset</p><div id="check-progress"></div><div id="check-results"></div><small>Measurements use simulated ground truth only for this diagnostic. The fly receives sensor inputs. Fixed wheels settle after turns; there is no steering servo.</small>';
document.querySelector(".world-column")!.append(diagnostics);
let running = false, following = false, simTime = 0, captureTime = -Infinity, selected: string | null = null;
let estimates = new Float32Array(10), sensors: number[] = new Array(19).fill(0);
let action: Action = { steer: 0, throttle: 0, brake: 0 };
let actualPWM: [number, number] = [0, 0];
const keys = new Set<string>();
type SceneEdit = { objects: WorldObject[]; floorColour: string; startPose:Pose; robotPose:Pose; mission:MissionSnapshot;journey:LifecycleSnapshot };
const history:SceneEdit[] = [], redoHistory:SceneEdit[] = [];
let scene: HabitatScene;
const pinoutDiagram = new WiringDiagram(el("pinout-diagram")), hardwareDiagram = new WiringDiagram(el("hardware-diagram"));
el("preset").innerHTML = ROOM_TYPES.map(r => `<option value="${r.id}">${r.label}</option>`).join("");
el("object-kind").innerHTML = OBJECT_TYPES.map(o => `<option value="${o.kind}">${o.label}</option>`).join("");
const roomTools = document.createElement("div"); roomTools.className = "habitat-tools";
roomTools.innerHTML = '<label class="floor-control">Floor colour <input id="floor-colour" type="color" value="#b7bea7" aria-label="Floor colour"></label><label class="check"><input id="collision-visible" type="checkbox"> Show contact shapes</label><small>Amber: blocking geometry at chassis height · blue: drive-over surfaces · green: chassis. Overhead furniture is clear if it fits.</small>';
document.querySelector(".object-tools")!.after(roomTools);
const contactNote = document.createElement("p"); contactNote.id = "contact-note"; contactNote.className = "contact-note"; roomTools.after(contactNote);
const roomCheck = document.createElement("button"); roomCheck.id = "bench-current"; roomCheck.textContent = "Run check in this habitat"; el("bench-check").before(roomCheck);
const survey = document.createElement("button"); survey.id = "survey-room"; survey.textContent = "Explore with sonar"; survey.className = "quiet"; el("bench-check").after(survey);
const trainingPanel = document.createElement("section"); trainingPanel.className = "card training-panel";
trainingPanel.innerHTML = `<div class="training-head"><div><p class="eyebrow">LEARN / MEASURE / EXPORT</p><h2>Fly training bench</h2><p>Train the spiking controller through the actual 3D camera and sonar. Eyes stay fixed. Each candidate gets the same room, start pose and noise seeds; room memory resets between trials.</p></div><button id="export-fly">Export fly + eyes</button></div><div class="training-settings"><label>Episode seconds<input id="train-seconds" type="number" min="5" max="60" value="20"></label><label>Trials / candidate<input id="train-episodes" type="number" min="1" max="5" value="2"></label><label>Candidates<input id="train-population" type="number" min="2" max="8" value="4"></label><label>Generations<input id="train-generations" type="number" min="1" max="10" value="3"></label><label>Seed<input id="train-seed" type="number" min="0" max="2147483647" value="2048"></label><label>Mutation rate<input id="train-rate" type="number" min="0" max="1" step=".05" value=".15"></label><label>Mutation amount<input id="train-amount" type="number" min="0" max="1" step=".05" value=".12"></label></div><div class="row"><button id="train-evaluate">Evaluate current fly</button><button id="train-evolve" class="primary">Evolve fly in this room</button><button id="train-stop" disabled>Stop training</button><button id="train-export" disabled>Export training dataset</button></div><p id="train-status" role="status">Ready · evaluations keep weights unchanged; evolution keeps the best candidate each generation.</p><progress id="train-progress" value="0" max="100"></progress><div id="train-results"></div><small>Score = new 20 cm cells × 0.5 + bounded distance − contacts × 2 − blocked seconds − cable seconds × 0.1 + objective rewards. True pose is used only for scoring and labelled evaluation data. Exports retain all trial summaries and the last two episodes, with bounded actual input-crop pixels, neural inputs, actions and motor writes. Sensor noise uses the controls below. Test the winner in other rooms before drawing conclusions.</small>`;
el("sensor-console").before(trainingPanel);
const hardwareHost = document.createElement("section"); hardwareHost.className = "card hardware-panel"; el("sensor-console").after(hardwareHost);
const copyLog = document.createElement("button"); copyLog.id = "copy-log"; copyLog.textContent = "Copy log"; el("export-log").before(copyLog);
const copyJson = document.createElement("button"); copyJson.id = "copy-log-json"; copyJson.textContent = "Copy JSON"; el("export-log").before(copyJson);
el<HTMLSelectElement>("console-filter").add(new Option("training", "training"));

const learningPanel=document.createElement("section");learningPanel.className="card learning-panel";learningPanel.id="learning-panel";learningPanel.innerHTML="<div class=\"learning-header\"><div><p class=\"eyebrow\">SUGAR / SENSES / COLLECTIVE VISION</p><h2>Give the fly a task</h2><p>Place sugar, draw a trail, then choose how the fly senses and learns. Rewards are a simulated taste signal; the physical car has a camera and sonar.</p></div><a href=\"./docs/robot-learning.html\">Methods & guide findings ↗</a></div><div class=\"learning-columns\"><section><h3>Objective & reward</h3><div class=\"learning-fields\"><label>Task<select id=\"objective-mode\"><option value=\"explore\">Explore the habitat</option><option value=\"sugar\">Find sugar</option><option value=\"trail\">Follow the trail to sugar</option></select></label><label>Trail sense<select id=\"objective-cue\"><option value=\"paint\">Camera · cyan painted trail</option><option value=\"scent\">Virtual antennae · scent field</option></select></label><label>Sugar reward<input id=\"objective-sugar\" type=\"number\" min=\"0\" max=\"100\" value=\"10\"></label><label>Trail checkpoint reward<input id=\"objective-trailReward\" type=\"number\" min=\"0\" max=\"20\" value=\"2\"></label><label>Contact penalty<input id=\"objective-pain\" type=\"number\" min=\"0\" max=\"10\" value=\"1\"></label><label>Trail sensing width · m<input id=\"objective-width\" type=\"number\" min=\".05\" max=\".5\" step=\".01\" value=\".18\"></label><label>Scent decay / second<input id=\"objective-decay\" type=\"number\" min=\"0\" max=\"1\" step=\".01\" value=\"0\"></label></div><div class=\"row\"><button id=\"apply-objective\">Apply objective</button><button id=\"add-sugar\">＋ Sugar ahead</button><button id=\"demo-trail\">Create a short trail</button><button id=\"clear-trail\">Clear trail</button><button id=\"clear-sugar\">Clear sugar</button></div><div class=\"row\"><button id=\"forage\" class=\"primary\">Use sugar memory steering</button><button id=\"reset-pickups\">Reset pickups</button><button id=\"forget-sugar\">Forget reward learning</button></div><label class=\"check\"><input id=\"sugar-learn\" type=\"checkbox\" checked> Learn reward associations during live runs</label><p id=\"objective-status\" role=\"status\"></p><p id=\"sugar-status\"></p><small>Sugar is awarded once per target per episode. Cyan paint is visible in the raw camera; virtual scent is an extra simulated sensor with three local antenna readings. Coordinates are used only by the reward evaluator. Training uses a frozen reward policy for fair candidate comparisons.</small></section><section><h3>What the fly sees</h3><div class=\"learning-fields\"><label>Virtual swarm<select id=\"vision-layout\"><option value=\"single\">One fly · original camera crop</option><option value=\"circle3\">3 flies · separate gaze patches</option><option value=\"circle5\">5 flies · separate gaze patches</option><option value=\"scales3\">3 flies · different zoom levels</option></select></label><label>Gaze radius<input id=\"vision-radius\" type=\"number\" min=\"0\" max=\".2\" step=\".01\" value=\".08\"></label><label>Average recent frames<select id=\"vision-temporal\"><option value=\"1\">1 · current frame</option><option value=\"4\">4 · reduce noise, add lag</option><option value=\"16\">16 · more averaging and lag</option></select></label><label>Kenyon cells<select id=\"kenyon-count\"><option value=\"512\">512 · legacy</option><option value=\"2048\">2,048</option><option value=\"4096\" selected>4,096</option><option value=\"10000\">10,000</option><option value=\"20000\">20,000</option></select></label><label>Active cells · fraction<input id=\"kenyon-sparsity\" type=\"number\" min=\".005\" max=\".05\" step=\".005\" value=\".01\"></label></div><label class=\"check\"><input id=\"vision-normalize\" type=\"checkbox\">Contrast normalization</label><label class=\"check\"><input id=\"vision-smooth\" type=\"checkbox\">Smooth neighbouring pixels</label><label class=\"check\"><input id=\"kenyon-rare\" type=\"checkbox\" checked>Rare Kenyon cells count more in recall</label><button id=\"apply-vision\">Apply vision & memory settings</button><p id=\"swarm-status\"></p><div id=\"swarm-views\"></div><canvas id=\"kenyon-cells\" width=\"320\" height=\"96\" aria-label=\"Kenyon memory occupancy and active cells\"></canvas><p id=\"kenyon-status\"></p><small>The raw camera stays separate from the processed fly input. Swarm members share one frame and wiring, inspect different crops and vote using predicted visual variance; world-brain sectors are remapped before voting. Track brains use the central view. Extra looks add compute. Compare these options in multiple rooms before claiming an accuracy gain.</small></section></div>";trainingPanel.before(learningPanel);
const editTools=document.createElement("div");editTools.className="scene-edit-tools";editTools.innerHTML='<label>Scene tool <select id="scene-tool"><option value="orbit">Orbit & select</option><option value="move">Move selected robot / item</option><option value="rotate">Rotate selected robot / item</option><option value="trail">Draw trail on floor</option></select></label><button id="select-robot">Select robot</button><button id="rotate-left">↶ 15°</button><button id="rotate-right">↷ 15°</button><span>Move: drag the selected body. Rotate: drag around it. Use the inspector for exact values.</span>';
root.querySelector(".stage")!.after(editTools);
el<HTMLSelectElement>("drive-mode").add(new Option("Fly + sugar memory steering","reward"));
el<HTMLSelectElement>("console-filter").add(new Option("reward","reward"));
el("room-map").closest(".map-card")!.querySelector(".sensor-title span")!.id="kenyon-title";
function clearMemory():void { memory=memory.settings.count===memorySettings.count&&memory.settings.sparsity===memorySettings.sparsity&&memory.settings.rareWeighting===memorySettings.rareWeighting?memory.fresh():new RoomMemory(memorySettings);swarm?.reset();sugarPolicy.reset();places=new VisualPlaces(); }
function rebuildSwarm():void { swarm=perceiver?new VisualSwarm(perceiver.model,visionSettings):null;captureTime=-Infinity; }
function pauseForEdit(reason:string):void {
  if(researchPanel?.active||calibrationPanel?.active||taskPanel?.active)throw new Error("Finish the current research or marked run before editing.");
  if(hardwarePanel?.busy)throw new Error("Disconnect hardware before editing this experiment.");
  if(training)endTraining(reason+"; training stopped.");setRunning(false,reason);physics.left=physics.right=0;actualPWM=[0,0];
}
function fillLearning():void {
  el<HTMLInputElement>("objective-mode").value=mission.settings.mode;el<HTMLInputElement>("objective-cue").value=mission.settings.cue;
  for(const k of ["sugar","trailReward","pain","width","decay"] as const)el<HTMLInputElement>("objective-"+k).value=String(mission.settings[k]);
  el<HTMLInputElement>("vision-layout").value=visionSettings.layout;el<HTMLInputElement>("vision-radius").value=String(visionSettings.radius);el<HTMLInputElement>("vision-temporal").value=String(visionSettings.temporal);
  if(document.getElementById("vision-vote")){el<HTMLInputElement>("vision-vote").value=visionSettings.vote??"confidence";el<HTMLInputElement>("vision-weights").value=(visionSettings.memberWeights??[1,1,1,1,1]).join(",");}
  el<HTMLInputElement>("vision-normalize").checked=visionSettings.normalize;el<HTMLInputElement>("vision-smooth").checked=visionSettings.smooth;
  el<HTMLInputElement>("kenyon-count").value=String(memorySettings.count);el<HTMLInputElement>("kenyon-sparsity").value=String(memorySettings.sparsity);el<HTMLInputElement>("kenyon-rare").checked=memorySettings.rareWeighting;
}
function resetObjectives():void {energy=new EnergyState(validateHunger(taskSettings.hunger));taskJudge=new TaskJudge(taskSettings,training?taskSettings.shaping*Math.pow(taskSettings.fade,training.generation-1):taskSettings.shaping);taskOrigin=objects.find(o=>o.id==="task-blue-ball")?structuredClone(objects.find(o=>o.id==="task-blue-ball")!):null;objectiveRun=new ObjectiveRun(mission);sugarPolicy.reset();scene.rebuildMission(mission);cue={...EMPTY_CUE,antennae:[0,0,0]};}
function refreshLearning():void {
  setText("objective-status","Reward "+objectiveRun.total.toFixed(2)+" · sugar "+objectiveRun.collected.size+"/"+mission.goals.length+" · trail "+objectiveRun.checkpoint+"/"+mission.trail.length);
  setText("sugar-status","Reward updates "+sugarPolicy.updates+" · MBON values "+sugarPolicy.values.map(v=>v.toFixed(2)).join(" / ")+" · cue "+cue.strength.toFixed(2)+" · antennae "+cue.antennae.map(v=>v.toFixed(2)).join(" / "));
  setText("kenyon-title",memory.count.toLocaleString()+" KENYON CELLS");
  setText("kenyon-status",memory.active.length+" active · "+(memory.occupancy*100).toFixed(1)+"% have observations · recall confidence "+(memory.confidence*100).toFixed(0)+"%"+(memory.occupancy>.8?" · crowded: compare against a fresh memory":""));
  setText("swarm-status",(swarm?.members.length??1)+" virtual fly view(s) · disagreement "+(swarm?.disagreement??0).toFixed(3)+" · "+(brainDomain==="track"?"track brain uses central view":"variance-weighted world perception and motor votes"));
  const canvas=el<HTMLCanvasElement>("kenyon-cells"),ctx=canvas.getContext("2d")!,active=new Set(memory.active),cols=160,rows=Math.ceil(memory.count/cols),sx=canvas.width/cols,sy=canvas.height/rows;
  ctx.fillStyle="#102027";ctx.fillRect(0,0,canvas.width,canvas.height);
  for(let id=0;id<memory.count;id++)if(active.has(id)||memory.counts[id]>0){ctx.fillStyle=active.has(id)?"#efc179":"#69a994";ctx.fillRect(id%cols*sx,Math.floor(id/cols)*sy,Math.max(1,sx*.75),Math.max(1,sy*.75));}
}
function showSwarmViews():void {
  const box=el("swarm-views");box.replaceChildren();
  if(!swarm||swarm.members.length<2)return;
  const w=swarm.model.spec.width,h=swarm.model.spec.height,n=w*h;
  for(const [i,member]of swarm.members.entries()){
    const wrap=document.createElement("div"),label=document.createElement("small"),canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;const ctx=canvas.getContext("2d")!,image=ctx.createImageData(w,h);
    for(let p=0;p<n;p++){for(let k=0;k<3;k++)image.data[p*4+k]=member.frame[k*n+p]*255;image.data[p*4+3]=255;}ctx.putImageData(image,0,0);
    label.textContent="Fly "+(i+1)+" · "+Math.round(member.patch.scale*100)+"% view";wrap.append(canvas,label);box.append(wrap);
  }
}
function initializeLearning():void {
  const swarmOptions=document.createElement("div");swarmOptions.className="learning-fields";swarmOptions.innerHTML='<label>Swarm decision<select id="vision-vote"><option value="confidence">Predicted confidence</option><option value="mean">Weighted mean</option><option value="median">Weighted median · robust votes</option></select></label><label>Member weights · centre then other gazes<input id="vision-weights" value="1,1,1,1,1" aria-label="Five swarm member weights"></label>';el("apply-vision").before(swarmOptions);
  fillLearning();
  button("apply-objective",()=>safe(()=>{
    const settings={...mission.settings,mode:value("objective-mode") as MissionSnapshot["settings"]["mode"],cue:value("objective-cue") as MissionSnapshot["settings"]["cue"]};
    for(const k of ["sugar","trailReward","pain","width","decay"] as const)settings[k]=Number(value("objective-"+k));
    const next=validateMission({...mission,settings,goals:mission.goals.map(g=>({...g,amount:settings.sugar}))});pauseForEdit("Objective changed");editWorld();mission=next;resetObjectives();saveLocal();message("Objective applied. Rewards are logged and included in training scores.");
  }));
  button("add-sugar",()=>safe(()=>{if(mission.goals.length>=30)throw new Error("Sugar target limit is 30.");pauseForEdit("Sugar target added");editWorld();const p=physics.pose;const goal={id:"sugar-"+crypto.randomUUID(),x:clamp(p.x+Math.cos(p.heading)*.7,-3.2,3.2),z:clamp(p.z+Math.sin(p.heading)*.7,-3.2,3.2),yaw:0,radius:.18,amount:mission.settings.sugar};mission.goals.push(goal);if(mission.settings.mode==="explore")mission.settings.mode="sugar";resetObjectives();fillLearning();populateObjects();selectObject(goal.id);saveLocal();message("Sugar placed ahead. Select Move or Rotate to position it; choose sugar memory steering to forage.");}));
  button("demo-trail",()=>safe(()=>{pauseForEdit("Trail added");editWorld();const p=physics.pose;mission.trail=Array.from({length:17},(_,i)=>{const f=i*.085,s=Math.max(0,i-8)*.035;return {x:clamp(p.x+Math.cos(p.heading)*f-Math.sin(p.heading)*s,-3.2,3.2),z:clamp(p.z+Math.sin(p.heading)*f+Math.cos(p.heading)*s,-3.2,3.2)};});const end=mission.trail.at(-1)!;if(mission.goals.length<30)mission.goals.push({...end,id:"sugar-"+crypto.randomUUID(),yaw:0,radius:.18,amount:mission.settings.sugar});mission.settings.mode="trail";resetObjectives();fillLearning();populateObjects();saveLocal();message("Short trail added in this room. Draw a different path with the scene tool; it may need moving around furniture.");}));
  for(const [id,kind]of [["clear-trail","trail"],["clear-sugar","goals"]] as const)button(id,()=>safe(()=>{pauseForEdit("Objectives edited");editWorld();mission[kind]=[];resetObjectives();populateObjects();selectObject(null);saveLocal();}));
  button("reset-pickups",()=>safe(()=>{pauseForEdit("Pickups reset");resetObjectives();message("Sugar and checkpoints reset. Learned reward weights retained.");}));
  button("forget-sugar",()=>safe(()=>{pauseForEdit("Reward memory cleared");sugarPolicy=new SugarPolicy(memorySettings.count);saveLocal();message("Reward associations cleared. The imported spiking brain is retained.");}));
  button("forage",()=>safe(()=>{if(brainDomain!=="world")throw new Error("Sugar memory steering requires a world-domain fly. Load bundled habitat fly first.");pauseForEdit("Sugar steering selected");chooseProgram("fly");el<HTMLInputElement>("drive-mode").value="reward";if(mission.settings.mode==="explore")mission.settings.mode="sugar";fillLearning();saveLocal();message("Sugar memory steering selected. Press Run. Steering uses camera cues or explicit virtual antennae, not goal coordinates.");}));
  el("sugar-learn").addEventListener("change",()=>{if(training)endTraining("Learning option changed; training stopped.");hardwarePanel.stop();saveLocal();});
  button("apply-vision",()=>safe(()=>{
    const nextVision=validateVisionSettings({layout:value("vision-layout"),radius:Number(value("vision-radius")),temporal:Number(value("vision-temporal")),normalize:check("vision-normalize"),smooth:check("vision-smooth"),vote:value("vision-vote"),memberWeights:value("vision-weights").split(",").map(Number)});
    const nextMemory=validateMemorySettings({count:Number(value("kenyon-count")),sparsity:Number(value("kenyon-sparsity")),rareWeighting:check("kenyon-rare")});
    pauseForEdit("Visual processing changed");visionSettings=nextVision;memorySettings=nextMemory;memory=new RoomMemory(nextMemory);sugarPolicy=new SugarPolicy(memorySettings.count);clearMemory();rebuildSwarm();saveLocal();message("Vision settings applied. Visual and reward memories reset because their sensory representation changed; compare results on held-out rooms.");
  }));
}
function entityPose(id:string):{x:number;z:number;yaw:number}|null {
  if(id==="@robot")return {...physics.pose,yaw:physics.pose.heading};
  return objects.find(o=>o.id===id)??mission.goals.find(o=>o.id===id)??null;
}
function setEntityPose(id:string,p:{x:number;z:number;yaw:number}):void {
  if(id==="@robot"){const next=validatePose({x:p.x,z:p.z,heading:p.yaw}),error=placementError(next,physics.config,objects);if(error)throw new Error(error);physics.pose=next;physics.odometry={...next};estimator=new StateEstimator(next,calibration);startPose={...next};physics.blocked=false;physics.contact=null;scene.updateRobot(next,physics.config,check("beam-visible"),0,0,0);}
  else {const o=objects.find(o=>o.id===id),g=mission.goals.find(o=>o.id===id);if(o){const next={...o,...p};validateObjects([next]);Object.assign(o,p);scene.rebuildObjects(objects);}else if(g){validateMission({...mission,goals:mission.goals.map(goal=>goal.id===id?{...goal,...p}:goal)});Object.assign(g,p);scene.rebuildMission(mission,objectiveRun.collected);}}
  scene.select(id);captureTime=-Infinity;
}
function specialInspector(id:string|null):boolean {
  const g=mission.goals.find(o=>o.id===id),robot=id==="@robot";if(!g&&!robot)return false;
  const editor=el("object-editor"),p=entityPose(id!)!;
  editor.innerHTML='<p class="object-hint">'+(robot?"Robot placement also sets the reset and training start. Colliding placements are rejected.":"Sugar is a nonblocking task marker. Radius defines the reward zone.")+'</p><div class="form-grid">'+["x","z","yaw",...(g?["radius","amount"]:[])].map(k=>'<label>'+(k==="yaw"?"Rotation · degrees":k)+'<input data-property="'+k+'" type="number" step="'+(k==="yaw"?"5":".05")+'" value="'+(k==="yaw"?p.yaw*180/Math.PI:k==="x"?p.x:k==="z"?p.z:g![k as "radius"|"amount"])+'"></label>').join("")+'</div>';
  editor.querySelectorAll<HTMLInputElement>("input").forEach(input=>input.addEventListener("change",()=>safe(()=>{const k=input.dataset.property!,n=Number(input.value)*(k==="yaw"?Math.PI/180:1);pauseForEdit("Scene placement changed");if(["x","z","yaw"].includes(k)){const next={...entityPose(id!)!,[k]:n};if(robot){const error=placementError(validatePose({...next,heading:next.yaw}),physics.config,objects);if(error)throw new Error(error);}editWorld();setEntityPose(id!,next);}else {const next={...g!,[k]:n};validateMission({...mission,goals:mission.goals.map(goal=>goal.id===id?next:goal)});editWorld();Object.assign(g!,next);}worldChanged();selectObject(id);})));
  if(g){const remove=document.createElement("button");remove.textContent="Remove sugar";remove.addEventListener("click",()=>safe(()=>{pauseForEdit("Sugar removed");editWorld();mission.goals=mission.goals.filter(goal=>goal.id!==id);worldChanged();selectObject(null);}));editor.append(remove);}
  return true;
}
function bindSceneEditing():void {
  const canvas=el<HTMLCanvasElement>("habitat");let drag:{id:string;point:{x:number;z:number};pose:{x:number;z:number;yaw:number};angle:number;mode:string}|null=null,down={x:0,y:0},drawing=false;
  const finish=()=>{if(!drag&&!drawing)return;drag=null;drawing=false;worldChanged();selectObject(selected);log("system","Scene placement / trail edited",{startPose});};
  el("scene-tool").addEventListener("change",()=>{finish();const orbit=value("scene-tool")==="orbit";scene.controls.enabled=orbit;canvas.classList.toggle("scene-editing",!orbit);});
  button("select-robot",()=>selectObject("@robot"));
  for(const [id,angle]of [["rotate-left",-Math.PI/12],["rotate-right",Math.PI/12]] as const)button(id,()=>safe(()=>{const target=selected??"@robot",p=entityPose(target);if(!p)return;pauseForEdit("Entity rotated");const next={...p,yaw:p.yaw+angle};if(target==="@robot"){const error=placementError(validatePose({...next,heading:next.yaw}),physics.config,objects);if(error)throw new Error(error);}editWorld();setEntityPose(target,next);worldChanged();selectObject(target);}));
  canvas.addEventListener("pointerdown",e=>safe(()=>{if(e.button!==0)return;down={x:e.clientX,y:e.clientY};const mode=value("scene-tool");if(mode==="orbit")return;const point=scene.floorPoint(e.clientX,e.clientY);if(!point)return;pauseForEdit("Scene drag");const hit=scene.pick(e.clientX,e.clientY);if(hit)selectObject(hit);
    if(mode==="trail"){editWorld();if(mission.trail.length>=500)throw new Error("Trail limit is 500 points; clear it to draw another.");if(mission.trail.length&&Math.hypot(point.x-mission.trail.at(-1)!.x,point.z-mission.trail.at(-1)!.z)>.5)mission.trail=[];mission.trail.push(point);mission.settings.mode="trail";fillLearning();drawing=true;}
    else {const id=selected??"@robot",p=entityPose(id);if(!p)return;selectObject(id);editWorld();drag={id,point,pose:{x:p.x,z:p.z,yaw:p.yaw},angle:Math.atan2(point.z-p.z,point.x-p.x),mode};}canvas.setPointerCapture(e.pointerId);
  }));
  canvas.addEventListener("pointermove",e=>{const point=scene.floorPoint(e.clientX,e.clientY);if(!point)return;if(drawing){const last=mission.trail.at(-1)!;if(mission.trail.length<500&&Math.hypot(point.x-last.x,point.z-last.z)>.085){mission.trail.push(point);scene.rebuildMission(mission);}return;}if(!drag)return;safe(()=>{const p=drag!.pose,next=drag!.mode==="move"?{...p,x:p.x+point.x-drag!.point.x,z:p.z+point.z-drag!.point.z}:{...p,yaw:p.yaw+Math.atan2(point.z-p.z,point.x-p.x)-drag!.angle};setEntityPose(drag!.id,next);});});
  canvas.addEventListener("pointerup",e=>{if(value("scene-tool")==="orbit"){if(Math.hypot(e.clientX-down.x,e.clientY-down.y)<4)selectObject(scene.pick(e.clientX,e.clientY));}else finish();if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});
  canvas.addEventListener("pointercancel",finish);
}
function validateObjects(raw: unknown): WorldObject[] {
  const kinds = OBJECT_TYPES.map(o => o.kind);
  if (!Array.isArray(raw) || raw.length > 200) throw new Error("A habitat must contain at most 200 objects.");
  const ids = new Set<string>();
  return raw.map(o => {
    if (!o || typeof o.id !== "string" || !o.id || o.id === "@robot" || o.id.length > 100 || ids.has(o.id) || !kinds.includes(o.kind)) throw new Error("Invalid habitat object."); ids.add(o.id);
    if (![o.x, o.z, o.yaw, o.width, o.depth, o.height].every(Number.isFinite) || Math.abs(o.x) > 3.5 || Math.abs(o.z) > 3.5 || Math.abs(o.yaw) > Math.PI * 100 || o.width < .02 || o.width > 6 || o.depth < .02 || o.depth > 6 || o.height < .002 || o.height > 4) throw new Error("Object position or dimensions are out of range.");
    if(o.visual&&((o.kind==='image'&&o.visual.type!=='image')||(o.kind==='model'&&o.visual.type!=='glb')||!['image','model'].includes(o.kind)))throw new Error('Imported visual does not match the object type.');
    return { id: o.id, kind: o.kind, x: o.x, z: o.z, yaw: o.yaw, width: o.width, depth: o.depth, height: o.height,...(o.visual?{visual:validateVisual(o.visual)}:{}) };
  });
}
const PHYSICS_FIELDS: [keyof RobotConfig, string, number, number, number][] = [
  ["length", "Total length · cm", 10, 60, 100], ["width", "Outside wheel width · cm", 8, 40, 100], ["wheelbase", "Axle centre spacing · cm", 5, 40, 100], ["mountHeight", "Sensor lens height · cm", 3, 30, 100],
  ["wheelDiameter", "Wheel diameter · cm", 3, 15, 100], ["wheelWidth", "Wheel width · cm", 1, 6, 100], ["rpm", "RPM at 6 V · 100–240", 100, 240, 1], ["voltage", "Motor supply · V", 3, 9, 1],
  ["bridgeDrop", "L298N total drop · V", 0, 4, 1], ["turnGrip", "Skid turn response", .2, 1, 1], ["deadband", "PWM start deadband", 0, .6, 1],
];
const SENSOR_FIELDS: [keyof RobotConfig, string, number, number, number][] = [["cameraFov", "Horizontal FOV · degrees", 30, 120, 1], ["cameraPitch", "Downward tilt · degrees", -15, 40, 1], ["cameraHz", "Camera capture · Hz", 1, 15, 1], ["sonarBeam", "Useful beam · degrees", 8, 30, 1]];
const ALL_FIELDS = [...PHYSICS_FIELDS, ...SENSOR_FIELDS];
function validateConfig(raw: unknown): RobotConfig { return validateRobotConfig(raw); }
function validateWiring(raw: unknown): Wiring {
  const w = raw as Wiring;
  if (!w || !["esp32-cam", "uno"].includes(w.board) || ["commonGround", "echoDivider", "sdCard"].some(k => typeof w[k as keyof Wiring] !== "boolean")) throw new Error("Invalid wiring profile.");
  if ([w.in1, w.in2, w.in3, w.in4, w.ena, w.enb, w.trig, w.echo, w.vibration??-1].some(n => !Number.isInteger(n) || n < -1 || n > 39)) throw new Error("Invalid pin number.");
  return { vibration:w.vibration??-1, board: w.board, in1: w.in1, in2: w.in2, in3: w.in3, in4: w.in4, ena: w.ena, enb: w.enb, trig: w.trig, echo: w.echo, commonGround: w.commonGround, echoDivider: w.echoDivider, sdCard: w.sdCard };
}

function validateFloor(raw: unknown): string { if (raw === undefined) return "#b7bea7"; if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/i.test(raw)) throw new Error("Invalid floor colour."); return raw; }
function updateFloor(): void { scene.setFloorColour(floorColour); el<HTMLInputElement>("floor-colour").value = floorColour; }
function learningData(includeMemory=false) {
  return {format:"robot-learning",version:1,memorySettings:{...memorySettings},visionSettings:{...visionSettings},sugarPolicy:sugarPolicy.toJSON(),learn:check("sugar-learn"),calibration,compensationEnabled,places:places.toJSON(),lifecycle:journeySnapshot(),...(includeMemory?{memory:memory.toJSON()}:{})};
}
function parseLearning(raw:unknown,fallbackMemory?:RoomMemory) {
  const r=raw as ReturnType<typeof learningData>|undefined;
  if(r&&(r.format!=="robot-learning"||r.version!==1||typeof r.learn!=="boolean"))throw new Error("Invalid robot learning extension.");
  const ms=r?validateMemorySettings(r.memorySettings):fallbackMemory?.settings??{...DEFAULT_MEMORY},vs=r?validateVisionSettings(r.visionSettings):{...DEFAULT_VISION};
  const mem=r?.memory?RoomMemory.fromJSON(r.memory):fallbackMemory??new RoomMemory(ms);
  if(mem.settings.count!==ms.count||mem.settings.sparsity!==ms.sparsity||mem.settings.rareWeighting!==ms.rareWeighting)throw new Error("Memory settings differ from the saved visual memory.");
  return {lifecycle:r?.lifecycle?validateLifecycle(r.lifecycle):null,memorySettings:ms,visionSettings:vs,memory:mem,policy:r?SugarPolicy.fromJSON(r.sugarPolicy,ms.count):new SugarPolicy(ms.count),learn:r?.learn??true,calibration:r?.calibration?validateCalibration(r.calibration):{...DEFAULT_CALIBRATION},compensationEnabled:r?.compensationEnabled===true,places:r?.places?VisualPlaces.fromJSON(r.places):new VisualPlaces()};
}
function saveLocal(): void {
  if(researchMode)return;
  try { localStorage.setItem("flykart-robot-habitat-v1", JSON.stringify({ objects, floorColour,startPose,mission,learning:learningData(), config: physics.config, wiring, sketch: firmware.source, program: appliedProgram, mode: value("drive-mode"), adapter: adapterConfig, cameraLatency:cameraDelay.seconds, noise: noiseConfig,controller:controller?controllerCheckpoint(controller,{domain:brainDomain,fitness:brainFitness,generation:brainGeneration}):null,vision:perceiver?.model??null,brainName })); }
  catch { message("Browser storage is unavailable. Export lab to keep your work.", true); }
}
function restoreLocal(): void {
  try {
    const text = localStorage.getItem("flykart-robot-habitat-v1"); if (!text) return;
    const data=JSON.parse(text), nextObjects=validateObjects(data.objects),config=validateConfig(data.config),nextWiring=validateWiring(data.wiring),nextFirmware=new Firmware(data.sketch);
    // Validate the whole saved lab before changing any live state.
    const nextFloor=validateFloor(data.floorColour),nextAdapter=validateAdapter(data.adapter??DEFAULT_ADAPTER),nextNoise=validateNoise(data.noise??DEFAULT_NOISE),nextDelay=new CameraDelay(data.cameraLatency??0),learned=parseLearning(data.learning),nextPose=validatePose(data.startPose??new RobotPhysics().pose),nextMission=data.mission?validateMission(data.mission):{settings:{...DEFAULT_OBJECTIVE},goals:[],trail:[]};
    let saved: {controller:SpikingNetwork;perceiver:Perceiver;domain:"track"|"world";name:string;fitness:number;generation:number}|null=null;
    if(data.controller||data.vision){
      if(!data.controller||!data.vision)throw new Error("Saved controller and eyes must be present together.");
      const imported=importFile(JSON.stringify(data.controller));if(!imported.controller)throw new Error("Missing saved controller.");
      const domain=imported.controller.domain;
      saved={controller:SpikingNetwork.fromJSON(imported.controller.snapshot),perceiver:validateEyes(data.vision,domain),domain,name:typeof data.brainName==="string"?data.brainName.slice(0,200):"Restored fly",fitness:imported.controller.meta.fitness??0,generation:imported.controller.meta.generation??0};
    }
    floorColour=nextFloor;objects=nextObjects;physics.config=config;wiring=nextWiring;firmware=nextFirmware;el<HTMLTextAreaElement>("sketch").value=firmware.source;
    cameraDelay=nextDelay;adapterConfig=nextAdapter;noiseConfig=nextNoise;noise=new NoiseSource(noiseConfig);
    startPose=nextPose;physics.pose={...startPose};physics.odometry={...startPose};mission=nextMission;memorySettings=learned.memorySettings;visionSettings=learned.visionSettings;memory=learned.memory;sugarPolicy=learned.policy;calibration=learned.calibration;compensationEnabled=learned.compensationEnabled;places=learned.places;estimator=new StateEstimator(physics.pose,calibration);el<HTMLInputElement>("sugar-learn").checked=learned.learn;if(learned.lifecycle)loadJourney(learned.lifecycle);
    if(saved){controller=saved.controller;perceiver=saved.perceiver;brainDomain=saved.domain;brainName=saved.name;brainFitness=saved.fitness;brainGeneration=saved.generation;estimates=new Float32Array(perceiver.estimateCount);sensors=new Array(controller.inputCount).fill(0);}
    program=appliedProgram=PROGRAMS.some(p=>p.id===data.program)?data.program:"custom";
    el<HTMLSelectElement>("drive-mode").value=["fly","manual","sketch","reward","task","coach"].includes(data.mode)?data.mode:"sketch";
  } catch { message("Saved habitat could not be restored; using the workshop preset.",true); }
}
function sceneEditSnapshot():SceneEdit{return {objects:structuredClone(objects),floorColour,startPose:{...startPose},robotPose:{...physics.pose},mission:structuredClone(mission),journey:journeySnapshot()};}
function syncSceneUndo():void{el<HTMLButtonElement>('undo').disabled=!history.length;el<HTMLButtonElement>('redo').disabled=!redoHistory.length;}
function restoreSceneEdit(previous:SceneEdit):void{objects=structuredClone(previous.objects);floorColour=previous.floorColour;startPose={...previous.startPose};physics.pose={...previous.robotPose};physics.odometry={...physics.pose};mission=structuredClone(previous.mission);loadJourney(previous.journey);fillLearning();selected=null;worldChanged();selectObject(null);syncSceneUndo();}
function editWorld(): void { pauseForEdit('Scene edit');history.push(sceneEditSnapshot());redoHistory.length=0;if(history.length>50)history.shift();syncSceneUndo(); }
function worldChanged(): void {
  if (training) endTraining("Habitat changed; training stopped.");
  scene.rebuildObjects(objects); updateFloor(); resetObjectives();scene.select(selected); populateObjects(); clearMemory(); saveLocal();
  captureTime = -Infinity; sonar = new RobotSonar();targetTracker.reset();cameraDelay.reset();
}
function populateObjects(): void {
  const list = el<HTMLSelectElement>("object-list"); list.replaceChildren(new Option("Select an object…", ""),new Option("Robot · position & rotation","@robot"));
  objects.forEach((o, i) => list.add(new Option(`${String(i + 1).padStart(2, "0")} / ${o.kind}`, o.id))); list.value = selected ?? "";
  mission.goals.forEach((g,i)=>list.add(new Option("Sugar "+(i+1)+" · "+g.amount+" reward",g.id)));list.value=selected??"";
  setText("object-count", `${objects.length} objects / 200 max`);
}
function selectObject(id: string | null): void {
  selected = id; scene.select(id); el<HTMLSelectElement>("object-list").value = id ?? "";
  if(specialInspector(id))return;
  const o = objects.find(o => o.id === id), editor = el("object-editor");
  if (!o) { editor.innerHTML = '<p class="inspector-empty">Select an object to move, rotate or resize it. All dimensions are in metres.</p>'; return; }
  editor.innerHTML = `<div class="form-grid">${(["x", "z", "yaw", "width", "depth", "height"] as const).map(k => `<label>${k === "yaw" ? "Rotation · degrees" : k}<input data-property="${k}" type="number" step="${k === "yaw" ? "5" : ".05"}" value="${k === "yaw" ? (o[k] * 180 / Math.PI).toFixed(1) : o[k].toFixed(3)}"></label>`).join("")}</div><button id="remove-object" class="full quiet" style="margin-top:12px">Remove ${o.kind}</button>`;
  const note = document.createElement("p"); note.className = "object-hint";
  note.textContent = o.kind === "cable" || o.kind === "doormat" ? traversable(o, physics.config) ? `${o.kind === "cable" ? "Drive-over caution: possible cable snag; simulated speed reduced 25%." : "Traversable mat: simulated speed reduced 15%."} Low-profile limit ${Math.min(.012, physics.config.wheelDiameter * .2) * 100} cm. No wheel-climbing or tangling physics.` : "Too tall to drive over in this model; this object blocks the chassis." : ["table", "chair", "bed"].includes(o.kind) ? `Underneath clearance: ${((o.kind === "bed" ? o.height * .32 : (o.kind === "table" ? o.height : o.height * .55) - .045) * 100).toFixed(1)} cm. Chassis envelope: ${((physics.config.mountHeight + .04) * 100).toFixed(1)} cm. Legs still block movement.` : "Contact follows the visible solid shape at chassis height. The selection box shows overall dimensions.";
  editor.append(note);
  editor.querySelectorAll<HTMLInputElement>("input").forEach(input => input.addEventListener("change", () => safe(() => {
    const property = input.dataset.property as keyof WorldObject; const n = Number(input.value) * (property === "yaw" ? Math.PI / 180 : 1);
    const updated = { ...o, [property]: n }; validateObjects([updated]);pauseForEdit("Object edited"); editWorld(); Object.assign(o, updated); worldChanged(); selectObject(o.id);
  })));
  button("remove-object", () => safe(() => { pauseForEdit("Object removed");editWorld(); objects = objects.filter(item => item.id !== id); selected = null; worldChanged(); selectObject(null); }));
}

function initializeHardware(): void {
  const fields = (list: typeof ALL_FIELDS) => list.map(([key, label, min, max]) => `<label>${label}<input id="component-${key}" type="number" min="${min}" max="${max}" step="${key === "rpm" ? 1 : .1}"></label>`).join("");
  el("physics-fields").innerHTML = fields(PHYSICS_FIELDS); el("sensor-fields").innerHTML = fields(SENSOR_FIELDS);
  el("wiring-fields").innerHTML = (["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo", "vibration"] as const).map(key => `<label>${key.toUpperCase()} → GPIO<input id="wire-${key}" type="number" min="-1" max="39" step="1"></label>`).join("");
  el("hardware").querySelectorAll("input,select").forEach(input => input.addEventListener("input", () => safe(() => previewWiring(readWiring()))));
}
function fillHardware(): void {
  el<HTMLInputElement>("route-steering").value = adapterConfig.steering; el<HTMLInputElement>("route-gain").value = String(adapterConfig.turnGain); el<HTMLInputElement>("route-pwm").value = String(adapterConfig.maxPWM);
  el<HTMLInputElement>("route-left").value = adapterConfig.leftSource; el<HTMLInputElement>("route-right").value = adapterConfig.rightSource;
  el<HTMLInputElement>("route-invert-left").checked = adapterConfig.invertLeft; el<HTMLInputElement>("route-invert-right").checked = adapterConfig.invertRight;
  for (const [key, , , , scale] of ALL_FIELDS) el<HTMLInputElement>(`component-${key}`).value = String(Math.round(Number(physics.config[key]) * scale * 100) / 100);
  el<HTMLSelectElement>("board").value = wiring.board;
  for (const key of ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo", "vibration"] as const) el<HTMLInputElement>(`wire-${key}`).value = String(wiring[key]??-1);
  for (const [id, flag] of [["common-ground", wiring.commonGround], ["echo-divider", wiring.echoDivider], ["sd-card", wiring.sdCard], ["sonar-enabled", physics.config.sonarEnabled], ["camera-enabled", physics.config.cameraEnabled]] as [string, boolean][]) el<HTMLInputElement>(id).checked = flag;
  const v=physics.config.vibration??DEFAULT_VIBRATION;
  for(const [id,flag] of [["vibration-enabled",v.enabled],["vibration-active-low",v.activeLow],["vibration-gpio33",v.gpio33Access]] as [string,boolean][])el<HTMLInputElement>(id).checked=flag;
  for(const [id,n] of [["sensitivity",v.sensitivity],["debounce",v.debounceMs],["hold",v.holdMs]])el<HTMLInputElement>(`vibration-${id}`).value=String(n);
  previewWiring(wiring);
}
function readVibration(){return validateVibration({enabled:check("vibration-enabled"),activeLow:check("vibration-active-low"),gpio33Access:check("vibration-gpio33"),sensitivity:Number(value("vibration-sensitivity")),debounceMs:Number(value("vibration-debounce")),holdMs:Number(value("vibration-hold"))});}
function readWiring(): Wiring { return { vibration:Number(value("wire-vibration")), board: value("board") as Wiring["board"], in1: Number(value("wire-in1")), in2: Number(value("wire-in2")), in3: Number(value("wire-in3")), in4: Number(value("wire-in4")), ena: Number(value("wire-ena")), enb: Number(value("wire-enb")), trig: Number(value("wire-trig")), echo: Number(value("wire-echo")), commonGround: check("common-ground"), echoDivider: check("echo-divider"), sdCard: check("sd-card") }; }
function previewWiring(w: Wiring): void {
  const voltage = Number(value("component-voltage"));
  const c = { ...physics.config, voltage: Number.isFinite(voltage) && voltage > 0 ? voltage : physics.config.voltage, cameraEnabled: check("camera-enabled"), sonarEnabled: check("sonar-enabled"), vibration:readVibration() };
  const draft = JSON.stringify(w) !== JSON.stringify(wiring) || c.voltage !== physics.config.voltage || c.cameraEnabled !== physics.config.cameraEnabled || c.sonarEnabled !== physics.config.sonarEnabled;
  hardwareDiagram.update(w, c, draft);
  const issues = wiringIssues(w); const box = el("wiring-message"); box.replaceChildren();
  for (const [text, error] of [...issues.errors.map(s => [s, true] as const), ...issues.notes.map(s => [s, false] as const)]) { const p = document.createElement("p"); p.textContent = text; p.className = error ? "problem" : ""; box.append(p); }
}
function hardwareChanged(): void { vibration=new VibrationSensor(noiseConfig.seed); scene.rebuildRobot(physics.config); physics.left = physics.right = 0; sonar = new RobotSonar(); clearMemory(); captureTime = -Infinity; firmware = new Firmware(firmware.source); saveLocal(); }

function log(kind: EventKind, text: string, data?: unknown): void { if (check("log-enabled")) consoleLog.push(simTime, kind, text, data); }
function setRunning(next: boolean, reason = "operator"): void { if (running !== next) log("system", next ? "Simulation running" : `Simulation paused: ${reason}`); running = next; pauseReason = reason; el("run").textContent = running ? "Ⅱ Pause simulation" : "▶ Run simulation"; }
function resetRobot(): void { sensorTiming.reset();vibration=new VibrationSensor(noiseConfig.seed); setRunning(false);targetTracker=new TargetTracker();taskSeen={...EMPTY_TARGET};cameraDelay=new CameraDelay(cameraDelay.seconds);liveRecorder=new EpisodeRecorder();liveEpisode++; physics.reset();physics.pose={...startPose};physics.odometry={...startPose};estimator=new StateEstimator(startPose,calibration);places.reset();resetObjectives();swarm?.reset(); sonar = new RobotSonar(); noise = new NoiseSource(noiseConfig); driveCheck = new DrivetrainCheck(); phaseIndex = -1; controller?.reset(); perceiver?.reset(); action = { steer: 0, throttle: 0, brake: 0 }; requests = motorRequests(action, adapterConfig); estimates.fill(0); sensors.fill(0); simTime = 0; cameraFrame = 0; neuralLogTime = -Infinity; captureTime = -Infinity; actualPWM = [0, 0]; firmware = new Firmware(firmware.source); keys.clear(); log("system", "Robot and program clock reset; room memory retained"); }
function applyCode(source: string): void {
  if (hardwarePanel?.busy) { codeMessage("Disconnect hardware before changing controller code.", true); return; }
  if (training) endTraining("Sketch changed; training stopped.");
  try { const next = new Firmware(source); next.tick({ timeMs: simTime * 1000, brainLeft: 0, brainRight: 0, echoUs: 0, wiring }); firmware = next; driveCheck = new DrivetrainCheck(); phaseIndex = -1; appliedProgram = program; physics.left = physics.right = 0; actualPWM = [0, 0]; el<HTMLTextAreaElement>("sketch").value = source; sketchEditor.refresh(); codeMessage("Applied · virtual GPIO now runs this sketch"); log("system", "Controller sketch compiled and applied"); saveLocal(); }
  catch (error) { codeMessage(error instanceof Error ? error.message : String(error), true); }
}
function programInfo(): void { const info = PROGRAMS.find(p => p.id === program)!; el<HTMLSelectElement>("program").value = program; setText("program-note", info.description); setText("sketch-file", info.file); sketchEditor.refresh(); }
function chooseProgram(id: ProgramId): void {
  if (program === "custom" || value("sketch") !== firmware.source) customDraft = value("sketch");
  program = id; el<HTMLSelectElement>("drive-mode").value = PROGRAMS.find(p => p.id === id)!.mode;
  applyCode(id === "custom" && customDraft ? customDraft : programSketch(id, wiring)); programInfo();
}
const NOISE_FIELDS: [keyof SensorNoise, string, number, number, number][] = [["cameraSigma", "Camera noise · σ / 255", 0, 60, 1], ["cameraDropout", "Frame dropout · 0–1", 0, 1, .01], ["brightness", "Exposure multiplier", .1, 2, .05], ["sonarSigmaCm", "Sonar jitter · σ cm", 0, 30, .1], ["sonarDropout", "Echo dropout · 0–1", 0, 1, .01], ["seed", "Repeatable noise seed", 0, 2147483647, 1]];
function fillNoise(): void { if(document.getElementById("camera-latency"))el<HTMLInputElement>("camera-latency").value=String(cameraDelay.seconds);for (const [key] of NOISE_FIELDS) el<HTMLInputElement>(`noise-${key}`).value = String(noiseConfig[key]); el<HTMLInputElement>("noise-preset").value = Object.entries(NOISE_PRESETS).find(([, profile]) => NOISE_FIELDS.every(([key]) => profile[key] === noiseConfig[key]))?.[0] ?? "custom"; setText("noise-summary", `Camera σ ${noiseConfig.cameraSigma} · delay ${Math.round(cameraDelay.seconds*1000)} ms · echo σ ${noiseConfig.sonarSigmaCm} cm · light ×${noiseConfig.brightness}`); }
function applyNoise(next: SensorNoise): void { if(training)endTraining("Sensor noise changed; training stopped."); noiseConfig = validateNoise(next); noise = new NoiseSource(noiseConfig); captureTime = -Infinity; fillNoise(); log("system", "Sensor noise changed", noiseConfig); saveLocal(); }
function initializeInstruments(): void {
  el("noise-fields").innerHTML = NOISE_FIELDS.map(([key, title, min, max, step]) => `<label>${title}<input id="noise-${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join("");
  const delayLabel=document.createElement("label");delayLabel.innerHTML=`Camera delivery delay · seconds<input id="camera-latency" type="number" min="0" max="1" step=".05" value="${cameraDelay.seconds}">`;el("noise-fields").after(delayLabel);el("camera-latency").addEventListener("change",()=>safe(()=>{pauseForEdit("Camera latency changed");cameraDelay=new CameraDelay(Number(value("camera-latency")));targetTracker.reset();captureTime=-Infinity;fillNoise();saveLocal();}));
  el("noise-fields").addEventListener("change", () => safe(() => { const config = Object.fromEntries(NOISE_FIELDS.map(([key]) => [key, Number(value(`noise-${key}`))])) as SensorNoise; applyNoise(config); el<HTMLInputElement>("noise-preset").value = "custom"; }));
  el("noise-preset").addEventListener("change", () => { const config = NOISE_PRESETS[value("noise-preset")]; if (config) applyNoise({ ...config }); });
  el("program").addEventListener("change", () => chooseProgram(value("program") as ProgramId));
  button("bench-check", () => { editWorld(); objects = preset("empty"); selected = null; worldChanged(); selectObject(null); el<HTMLInputElement>("preset").value = "empty"; chooseProgram("sequence"); resetRobot(); setRunning(true); message("Drive check running on an empty floor. It repeats until you pause. Undo edit restores the previous habitat."); });
  button("bench-current", () => { const start = { ...physics.pose }; chooseProgram("sequence"); resetRobot(); physics.pose = start; physics.odometry = { ...start }; setRunning(true); message("Drive check running from the current pose with this room intact. This fixed sequence reports obstacles as contacts; Explore with sonar uses avoidance instead."); });
  button("survey-room", () => { const start = { ...physics.pose }; chooseProgram("avoid"); resetRobot(); physics.pose = start; physics.odometry = { ...start }; setRunning(true); message("Sonar avoidance running in this habitat. The forward sensor can miss low, weak or angled objects; inspect contacts and the camera."); });
  button("show-code", () => { const hidden = workbench.classList.toggle("code-hidden"); el("show-code").textContent = hidden ? "Show code" : "Hide code"; });
  button("clear-log", () => { consoleLog.clear(); consoleRevision = -1; });
  button("copy-log", () => { void copyText(consoleLog.text(value("console-filter"))).then(()=>message("Console log copied · all retained events matching the current filter.")).catch(e=>message(String(e),true)); });
  button("copy-log-json", () => { void copyText(JSON.stringify(consoleLog.select(value("console-filter")),null,2)).then(()=>message("Structured console events copied.")).catch(e=>message(String(e),true)); });
  el("console-filter").addEventListener("change", () => { consoleRevision = -1; });
  button("export-log", () => download("robot-sensor-log.json", JSON.stringify({ format: "flykart-robot-log", noise: noiseConfig, adapter: adapterConfig, sketch: firmware.source, events: consoleLog.events }, null, 2)));
  button("export-frame", () => { el<HTMLCanvasElement>("camera").toBlob(blob => { if (!blob) return; const a = document.createElement("a"), url = URL.createObjectURL(blob); a.href = url; a.download = `camera-frame-${cameraFrame}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); }); });
  fillNoise(); programInfo();
}
function installBrain(text: string): void {
  if (hardwarePanel?.busy) throw new Error("Disconnect hardware before replacing the fly.");
  if (training) endTraining("Brain replaced; training stopped.");
  const imported = importFile(text);
  if (!imported.controller) throw new Error("Import a controller or combined vision brain, not just an eye network.");
  const usingWorld = !!imported.world;
  const snapshot = usingWorld ? imported.world!.controller.snapshot : imported.controller.snapshot;
  const nextDomain = usingWorld ? "world" : imported.controller.domain;
  const model = (usingWorld ? imported.world!.vision : imported.vision) ?? eyes[nextDomain];
  if (!model) throw new Error("A matching vision network is required for this brain.");
  const nextPerceiver = validateEyes(model, nextDomain);
  const nextController = SpikingNetwork.fromJSON(snapshot);
  const extension=JSON.parse(text).robotLearning,learned=extension?parseLearning(extension):null;
  if(!learned?.lifecycle){taskSettings=structuredClone(DEFAULT_TASK);taskBrain=new TaskBrain();taskLineage=[];taskEvidence=[];taskParent=undefined;taskPanel?.sync();}
  controller = nextController; perceiver = nextPerceiver; brainDomain = nextDomain; brainName = imported.name;const meta=usingWorld?imported.world!.controller.meta:imported.controller.meta;brainFitness=meta.fitness??0;brainGeneration=meta.generation??0;estimates = new Float32Array(perceiver.estimateCount); sensors = new Array(controller.inputCount).fill(0);
  captureTime = -Infinity; clearMemory();if(learned){memorySettings=learned.memorySettings;visionSettings=learned.visionSettings;memory=learned.memory;sugarPolicy=learned.policy;calibration=learned.calibration;compensationEnabled=learned.compensationEnabled;places=learned.places;estimator=new StateEstimator(physics.pose,calibration);el<HTMLInputElement>("sugar-learn").checked=learned.learn;if(learned.lifecycle)loadJourney(learned.lifecycle);fillLearning();}rebuildSwarm(); setText("brain-name", brainName); setText("adapter", `${brainDomain.toUpperCase()} INPUTS`);
  setText("brain-note", brainDomain === "track" ? "Track input meanings retained. A racing brain may not navigate a room; room recall is off." : "Eyes trained in the old renderer; transfer to 3D is experimental.");
  message(`Imported ${brainName}. ${imported.warnings.join(" ")}`);if(!loadingBundled)saveLocal();
}
function validateEyes(model: VisionModel, domain: string): Perceiver {
  const spec = model?.spec;
  const count = domain === "world" ? 10 : 13;
  if (!spec || spec.width < 8 || spec.width > 160 || spec.height < 8 || spec.height > 120 || !Number.isInteger(spec.width) || !Number.isInteger(spec.height) || ![1, 2].includes(spec.frames) || spec.outputs !== count * 2 + 3 || model.targetScale?.length !== count || !model.targetScale.every(n => Number.isFinite(n) && n > 0) || (model.domain ?? "track") !== domain) throw new Error("Vision network dimensions or domain do not match the controller.");
  if (!Array.isArray(spec.channels) || spec.channels.length !== 3 || spec.channels.some(n => !Number.isInteger(n) || n < 1 || n > 64) || !Number.isInteger(spec.hidden) || spec.hidden < 1 || spec.hidden > 256 || ![3, 5].includes(spec.extra)) throw new Error("Vision network architecture exceeds the lab limits.");
  const next = new Perceiver(model);
  if (!next.net.params.every(Number.isFinite)) throw new Error("Vision network has non-finite weights.");
  return next;
}
async function loadBundled(): Promise<void> {
  loadingBundled=true;try{
  const base = import.meta.env.BASE_URL;
  const paths = ["vision/robot/world-controller.json", "vision/robot/world-vision-net.json", "vision/robot/vision-net.json"];
  const [brain, worldEyes, trackEyes] = await Promise.all(paths.map(async p => { const r = await fetch(`${base}${p}`); if (!r.ok) throw new Error(`Cannot load ${p}`); return r.text(); }));
  const worldModel = JSON.parse(worldEyes) as VisionModel, trackModel = JSON.parse(trackEyes) as VisionModel;
  validateEyes(worldModel, "world"); validateEyes(trackModel, "track"); eyes.world = worldModel; eyes.track = trackModel;
  installBrain(brain); brainName = "Bundled robot world brain"; setText("brain-name", brainName);
  }finally{loadingBundled=false;}
}

function capture(): void {
  const captureStarted=performance.now();
  scene.updateRobot(physics.pose, physics.config, check("beam-visible"), physics.left, physics.right, 0);
  const width = perceiver?.model.spec.width ?? 48, height = perceiver?.model.spec.height ?? 24;
  const frame = scene.capture(width, height, physics.config.cameraEnabled, noise,(p,d)=>cameraDelay.deliver(p,d,simTime));
  taskRaw=frame.planar;taskWidth=width;taskHeight=height;taskSeen=targetTracker.see(taskRaw,width,height,taskSettings.target,cameraDelay.capturedAt,!frame.dropped&&physics.config.cameraEnabled);
  cameraFrame++; cameraRGB = frame.rgb; cameraDropped = frame.dropped;
  log("camera", `Frame ${cameraFrame} · 160×120 RGB565 · mean RGB ${cameraRGB.map(n => Math.round(n)).join(",")} · ${cameraDropped ? "missing/black frame" : "delivered"}`, { frame: cameraFrame, rgb: cameraRGB, dropped: cameraDropped });
  setText("retina-size", `${width} × ${height}`);
  const body = neuralBody();
  let processed=frame.planar;
  if (perceiver && physics.config.cameraEnabled) {swarm??=new VisualSwarm(perceiver.model,visionSettings);estimates.set(swarm.see(frame.planar,body,brainDomain));processed=swarm.processed;scene.showFlyInput(processed,width,height);} else estimates.fill(0);
  cue=mission.settings.mode==="trail"&&mission.settings.cue==="scent"?scentCue(physics.pose,mission,simTime):cameraCue(processed,width,height,mission.settings.mode);
  training?.recorder.frame(cameraFrame,width,height,processed,frame.dropped,frame.planar);liveRecorder.frame(cameraFrame,width,height,processed,frame.dropped,frame.planar);researchPanel?.frame(cameraFrame,width,height,processed,frame.planar,frame.dropped);taskFrameRecorder?.frame(cameraFrame,width,height,processed,frame.dropped,frame.planar);compactFeatures=compactInput(el<HTMLCanvasElement>("camera").getContext("2d")!.getImageData(0,0,160,120).data,sonar.reading.echo?sonar.metres*100:null,actualPWM);showSwarmViews();
  if(physics.config.cameraEnabled&&!frame.dropped&&(!researchPanel||check("place-enabled")))places.observe(Array.from(visualFeatures(processed,width,height)),estimator,simTime);
  if(returnToPlace&&!cue.strength){const navigation=places.cue(estimator.pose);if(navigation)cue={...cue,...navigation};}
  if (brainDomain === "world" && physics.config.sonarEnabled) estimates[4] = Math.max(estimates[4], sonar.closeness);
  if (brainDomain === "world" && physics.config.cameraEnabled && perceiver) {
    const remembered = memory.observe(visualFeatures(processed,width,height), estimates,check("memory-enabled"));
    if (check("memory-enabled") && remembered) for (let k = 0; k < estimates.length; k++) estimates[k] = estimates[k] * .8 + remembered[k] * .2;
  }
  if (controller) {
    if (brainDomain === "world") worldDomain.sensors(estimates, [cue.bearing, cue.strength], body, sensors);
    else sensorsFromEstimates(estimates, body, sensors);
    if (controller.inputCount > 17) { sensors[17] = sonar.closeness; sensors[18] = +sonar.reading.echo; }
  }
  sensorTiming.sample('Sim camera',simTime,cameraDelay.age,!frame.dropped&&physics.config.cameraEnabled);captureCost=performance.now()-captureStarted;
  captureTime = simTime;
}
function neuralBody() { return { speed: clamp((physics.left + physics.right) / 2 / .99, -1, 1), lastSteer: action.steer, lastDrive: action.throttle - (action.reverse ?? 0), sonarCloseness: sonar.closeness, sonarStrength: +sonar.reading.echo }; }
function manualDemands(): [number,number] {const forward=+(keys.has("w")||keys.has("ArrowUp"))-+(keys.has("s")||keys.has("ArrowDown")),steer=+(keys.has("d")||keys.has("ArrowRight"))-+(keys.has("a")||keys.has("ArrowLeft"));return [clamp(forward*.65+steer*.5,-1,1)*255,clamp(forward*.65-steer*.5,-1,1)*255];}
function tick(): void {
  const previousPWM=[...actualPWM];const dt = 1 / 30; simTime += dt;
  if(taskActive()&&taskSettings.mode==='follow'&&taskOrigin){const ball=objects.find(o=>o.id===taskOrigin!.id);if(ball){Object.assign(ball,movingTarget(taskOrigin,simTime,taskSettings.speed));scene.moveBall(ball);}}
  if(mission.settings.mode==="trail"&&mission.settings.cue==="scent")cue=scentCue(physics.pose,mission,simTime);
  if (sonar.update(simTime, physics.pose, objects, physics.config, noise)) {
    sensorTiming.sample('Sim sonar',simTime,0,sonar.reading.echo&&physics.config.sonarEnabled);
    log("sonar", sonar.reading.echo ? `${(sonar.metres * 100).toFixed(1)} cm · ECHO ${Math.round(sonar.pulseMicroseconds)} µs` : "No echo · distance unknown", { cm: sonar.reading.echo ? sonar.metres * 100 : null, echoUs: sonar.pulseMicroseconds });
    if (check("memory-enabled") && physics.config.sonarEnabled) memory.mapPing(estimator.pose, physics.config.length * .48, sonar.metres, sonar.reading.echo);
  }
  if (simTime - captureTime >= 1 / physics.config.cameraHz - 1e-8) capture();
  if (controller) {
    if (brainDomain === "world") worldDomain.sensors(estimates, [cue.bearing, cue.strength], neuralBody(), sensors); else sensorsFromEstimates(estimates, neuralBody(), sensors);
    if (controller.inputCount > 17) { sensors[17] = sonar.closeness; sensors[18] = +sonar.reading.echo; }
    action = swarm?swarm.step(controller,sensors,neuralBody(),[cue.bearing,cue.strength],brainDomain):controller.step(sensors);
  }
  const mode = value("drive-mode");
  if(taskActive()){taskInputs=taskObservation(taskRaw,taskWidth,taskHeight,taskSettings.modules,taskSettings.target,sonar.reading.echo?sonar.metres*100:null,actualPWM,taskSettings.modules.bumper?(usesVibration(taskBrain.observation)?vibration.reading.valid?vibration.reading.active:null:physics.blocked):null,!cameraDropped&&physics.config.cameraEnabled,taskBrain.observation,taskSeen,energy);action=mode==='coach'?visualCoach(taskInputs,taskSettings.mode==='follow',taskSettings.mode==='forage'):taskBrain.action(taskInputs,action,taskSettings.inheritance);}else taskInputs=[];
  if(mode==="reward")action=sugarPolicy.action(memory.active,action,cue,sonar.reading.echo?sonar.closeness:0,!training&&!researchMode,false);
  requests = motorRequests(action, adapterConfig);
  let demands: [number, number] = [requests.left, requests.right];
  if (mode === "manual") {
    const forward = +(keys.has("w") || keys.has("ArrowUp")) - +(keys.has("s") || keys.has("ArrowDown"));
    const steer = +(keys.has("d") || keys.has("ArrowRight")) - +(keys.has("a") || keys.has("ArrowLeft"));
    demands = [clamp(forward * .65 + steer * .5, -1, 1) * 255, clamp(forward * .65 - steer * .5, -1, 1) * 255];
  } else if (mode === "sketch") demands = [0, 0];
  try {
    firmware.tick({ timeMs: simTime * 1000, brainLeft: demands[0], brainRight: demands[1], echoUs: sonar.pulseMicroseconds, wiring, vibration:vibration.reading, camera: { frame: cameraFrame, rgb: cameraRGB }, log: line => log("serial", line), sonarRead: pulse => log("serial", `pulseIn(ECHO) → ${Math.round(pulse)} µs`), phase: index => {
      phaseIndex = index;
      if (appliedProgram !== "sequence") return;
      const result = driveCheck.observe(index, physics.pose, physics.collisions);
      if (result) log("check", `${result.passed ? "PASS" : "CHECK"} · ${result.title} · ${result.distanceCm.toFixed(1)} cm · ${result.yawDeg.toFixed(1)}° · ${result.contacts} contacts`, result);
    } });
    actualPWM = wiringIssues(wiring).errors.length ? [0, 0] : firmware.motors(wiring);
    if(compensationEnabled)actualPWM=compensate(actualPWM,calibration);
    if(!training&&!researchMode&&check("sugar-learn")&&["fly","manual","reward"].includes(mode))sugarPolicy.rememberExecuted(memory.active,actualPWM);
    const guarded=guardMotors(actualPWM,sonar.reading.echo?sonar.metres*100:null,simTime-sonar.lastTime,physics.maxSpeed,physics.config.guard??DEFAULT_GUARD);actualPWM=guarded.pwm;if(guardReason!==guarded.reason){guardReason=guarded.reason;log('system','Forward guard · '+guardReason,{stopDistance:guarded.stopDistance});}
    if(energy.settings.enabled&&energy.energy<=0&&!energy.charging)actualPWM=[0,0];
    estimator.predict(actualPWM,physics.config,dt);
    const beforeSpeed=physics.speed, beforeContacts=physics.collisions, beforeSurface=physics.surface?.objectId;
    physics.step(...actualPWM, objects, dt);
    const beforeCount=vibration.reading.count;
    vibration.simulate(simTime*1000,physics.config.vibration??DEFAULT_VIBRATION,physics.collisions>beforeContacts?Math.abs(beforeSpeed)+Math.abs((physics.left+physics.right)/2):0,!!physics.surface&&beforeSurface!==physics.surface.objectId,physics.speed,dt);
    if(vibration.reading.count!==beforeCount)log("vibration",`SW-420 event #${vibration.reading.count} · DO=${vibration.reading.level} · held digital pulse; cause unclassified`,{...vibration.reading});
    const contact = physics.contact ? `${physics.contact.objectId}/${physics.contact.part}` : "";
    if (contact && contact !== contactEvent) log("system", `Contact · ${physics.contact!.part} · motion blocked`, physics.contact); contactEvent = contact;
    const surface = physics.surface?.objectId ?? "";
    if (surface && surface !== surfaceEvent) log("system", physics.surface!.kind === "cable" ? "Crossing loose cable · snag caution · traction approximation −25%" : "Crossing doormat · traction approximation −15%", physics.surface); surfaceEvent = surface;
  } catch (error) { actualPWM = [0, 0]; physics.left = physics.right = 0; setRunning(false, "sketch error"); codeMessage(error instanceof Error ? error.message : String(error), true); message("Controller code stopped. Fix the sketch and apply it again.", true); }
  if (simTime - neuralLogTime >= .2) { neuralLogTime = simTime; log("brain", `steer ${action.steer.toFixed(2)} · drive ${action.throttle.toFixed(2)} · reverse ${(action.reverse ?? 0).toFixed(2)} · brake ${action.brake.toFixed(2)} | request ${demands.map(Math.round).join(" / ")} → PWM ${actualPWM.map(n => Math.round(n * 255)).join(" / ")}`, { mode, action: { ...action }, inputs: [...sensors], ...(taskActive()?{taskInput:[...taskInputs],taskSource:mode==="coach"?"coach":"neural"}:{}), estimates: [...estimates], legs: requests.legs, requests: demands, pwm: actualPWM.map(n => n * 255) }); }
  scene.updateRobot(physics.pose, physics.config, check("beam-visible"), physics.left, physics.right, dt);
  const dock=taskActive()&&taskSettings.mode==='forage'?objects.find(o=>o.id==='task-blue-ball'):undefined;
  let dockContact=false;
  if(dock){const dx=physics.pose.x-dock.x,dz=physics.pose.z-dock.z,localX=dx*Math.cos(dock.yaw)+dz*Math.sin(dock.yaw),localZ=-dx*Math.sin(dock.yaw)+dz*Math.cos(dock.yaw),frontGap=-localX-physics.config.length/2-dock.width/2;dockContact=Math.abs(physics.speed)<.025&&Math.max(...actualPWM.map(Math.abs))<.2&&Math.abs(localZ)<dock.depth/2&&frontGap>=-.015&&frontGap<=energy.settings.dockRadius&&Math.cos(physics.pose.heading-dock.yaw)>.7;}
  const energyReward=energy.step(dt,(Math.abs(actualPWM[0])+Math.abs(actualPWM[1]))/2,dockContact);
  if(taskActive()&&taskSettings.mode==='forage'){taskJudge.success ||=energy.energy>=energy.settings.sated&&energy.charged>.05;}
  const rewards=objectiveRun.update(physics.pose,physics.blocked),skill=taskActive()?taskJudge.update(physics.pose,objects.find(o=>o.id==='task-blue-ball')??null,physics.blocked,dt,physics.config.length):{amount:0,messages:[]},taskReward=rewards.reduce((a,r)=>a+r.amount,0)+skill.amount+energyReward*taskSettings.sugar;
  for(const msg of skill.messages)log('reward',msg,{amount:skill.amount,trainingOnly:true});
  for(const reward of rewards){log("reward",reward.message+" · "+(reward.amount>0?"+":"")+reward.amount.toFixed(2),reward);if(!training&&!researchMode&&check("sugar-learn"))sugarPolicy.reward(reward.amount);}
  if(rewards.some(r=>r.kind==="sugar")){places.sugar();scene.rebuildMission(mission,objectiveRun.collected);captureTime=-Infinity;}if(rewards.length&&!training)saveLocal();
  lastStep={time:simTime,inputs:[...sensors],action:{...action},pwm:actualPWM.map(v=>v*255),cameraFrame,sonar:{cm:sonar.reading.echo?sonar.metres*100:null,echo:sonar.reading.echo},evaluation:{pose:{...physics.pose},blocked:physics.blocked,contact:physics.contact?.part??null,surface:physics.surface?.kind??null,taskReward,success:taskActive()?taskJudge.success:mission.settings.mode==="sugar"?mission.goals.length>0&&objectiveRun.collected.size===mission.goals.length:mission.settings.mode==="trail"&&mission.trail.length>0&&objectiveRun.checkpoint===mission.trail.length&&objectiveRun.collected.size===mission.goals.length},diagnostics:{energy:{energy:energy.energy,charging:energy.charging,enabled:energy.settings.enabled},guard:{reason:guardReason,issued:[...actualPWM]},vibration:{...vibration.reading},estimated:{...estimator.pose},odometry:{...physics.odometry},covariance:[...estimator.covariance],cells:memory.active.slice(0,200),activeCount:memory.active.length,estimates:[...estimates],votes:swarm?.votes.map(v=>({...v}))??[],requests:[...demands],compactInput:[...compactFeatures.slice(0,26),...previousPWM,...compactFeatures.slice(28)],rewards:[...rewards.map(r=>r.message),...skill.messages],...(taskActive()?{taskInput:[...taskInputs],taskSource:mode==='coach'?'coach' as const:'neural' as const,taskSuccess:taskJudge.success,taskRecipe:taskBrain.observation,targetTrack:{...taskSeen},cameraAge:cameraDelay.age}:{})}};
  liveRecorder.step(lastStep,dt);
  if(taskActive())taskPanel?.observe(taskInputs,action,mode,taskSeen,cameraDelay.age);
  if (training) {
    training.recorder.step(lastStep,dt);
    if (training.recorder.seconds >= training.options.seconds - 1e-8) {
      const job = training, more = job.advance(), result = job.results.at(-1)!;
      log("training", `G${result.generation} C${result.candidate+1} trial ${result.episode} · score ${result.score.toFixed(2)} · ${result.cells} cells · ${result.contacts} contacts · ${result.blockedSeconds.toFixed(1)}s blocked`, result);
      if (more) beginEpisode(); else endTraining("Training complete · best evaluated controller installed. Export fly + eyes to keep it.");
    }
  }
}

function beginEpisode(): void {
  if (!training) return;
  if(training.options.visualTask)taskBrain=training.visualTask!;resetRobot(); controller = training.brain; perceiver?.reset(); clearMemory();swarm?.reset();sugarPolicy.reset(training.noiseSeed); noiseConfig = { ...noiseConfig, seed: training.noiseSeed }; noise = new NoiseSource(noiseConfig);
  setRunning(true); renderTraining();
}
function endTraining(reason: string): void {
  if (!training) return;
  const job=training; controller=SpikingNetwork.fromJSON(job.best);if(job.bestVisualTask)taskBrain=job.bestVisualTask; lastTraining=job; lastTrainingAt=Date.now();training=null;
  if(trainingNoise) {noiseConfig=trainingNoise;noise=new NoiseSource(noiseConfig);trainingNoise=null;fillNoise();}
  if(job.completedGeneration){brainFitness=job.fitness;if(job.options.evolve){brainGeneration+=job.completedGeneration;brainName="3D trained fly";if(job.bestVisualTask)lineage("Visual task + inherited fly evolution: "+job.completedGeneration+" completed generations");}}
  taskPanel?.sync();
  setRunning(false,"training ended"); physics.left=physics.right=0;actualPWM=[0,0];setText("brain-name",job.options.evolve?"3D training winner · export to keep":"Evaluated fly · weights unchanged");setText("train-status",reason);log("training",reason);renderTraining();saveLocal();
}
function renderTraining(): void {
  const job=training??lastTraining; el<HTMLButtonElement>("train-stop").disabled=!training;el<HTMLButtonElement>("train-evaluate").disabled=!!training;el<HTMLButtonElement>("train-evolve").disabled=!!training;el<HTMLButtonElement>("train-export").disabled=!job?.results.length;
  if(training) {setText("train-status",training.progress);const total=training.options.episodes*(training.options.evolve?training.options.population*training.options.generations:1);el<HTMLProgressElement>("train-progress").value=(training.results.length+training.recorder.seconds/training.options.seconds)/total*100;}
  else if(job?.completed) el<HTMLProgressElement>("train-progress").value=100;
  el("train-results").replaceChildren(...(job?.results.slice(-12)??[]).map(r=>{const p=document.createElement("p");p.textContent=`G${r.generation} · C${r.candidate+1} · trial ${r.episode}: ${r.score.toFixed(2)} score / ${r.cells} cells / ${r.contacts} contacts / ${r.taskReward.toFixed(2)} reward`;return p;}));
}
function startTraining(evolve: boolean): void {
  if(hardwarePanel.busy||researchPanel?.active||calibrationPanel?.active||taskPanel?.active) throw new Error("Finish the current job and disconnect hardware before simulated training.");
  if(!controller||!perceiver) throw new Error("Load a fly and its matching eyes first.");
  if(wiringIssues(wiring).errors.length)throw new Error("Fix wiring conflicts before training.");
  const options:TrainingOptions={evolve,task:taskActive()||mission.settings.mode!=="explore",...(taskActive()?{visualTask:taskBrain.toJSON()}:{}),seconds:Number(value("train-seconds")),episodes:Number(value("train-episodes")),population:Number(value("train-population")),generations:Number(value("train-generations")),seed:Number(value("train-seed")),rate:Number(value("train-rate")),amount:Number(value("train-amount"))};
  const job=new TrainingRun(controller,options);
  trainingContext={objects:structuredClone(objects),floorColour,config:{...physics.config},wiring:{...wiring},adapter:{...adapterConfig},noise:{...noiseConfig},domain:brainDomain,initialGeneration:brainGeneration,vision:perceiver.model,memoryEnabled:check("memory-enabled"),sketch:programSketch("fly",wiring),initialPose:{...startPose},visionSettings:{...visionSettings},memorySettings:{...memorySettings},mission:structuredClone(mission),sugarPolicy:sugarPolicy.toJSON(),lifecycle:journeySnapshot(),dt:1/30,initialBrain:controllerCheckpoint(controller,{domain:brainDomain,fitness:brainFitness,generation:brainGeneration})};
  const trainingMode=taskActive()?"task":value("drive-mode")==="reward"?"reward":"fly";trainingContext.mode=trainingMode;chooseProgram("fly");el<HTMLInputElement>("drive-mode").value=trainingMode;trainingNoise={...noiseConfig};training=job;lastTraining=null;log("training",evolve?"Seeded controller evolution started; eyes and reward policy frozen":"Seeded evaluation started; weights unchanged",options);beginEpisode();
}
function initializeTraining(): void {
  button("train-evaluate",()=>safe(()=>startTraining(false)));button("train-evolve",()=>safe(()=>startTraining(true)));button("train-stop",()=>endTraining("Training stopped · last completed generation retained."));
  button("train-export",()=>{const job=training??lastTraining;if(!job)return;download("robot-training.json",JSON.stringify({format:"flykart-robot-training",version:1,settings:job.options,context:trainingContext,scoreDefinition:job.options.task?"objectiveReward +20 success -0.05 * seconds -2 * contacts - blockedSeconds":"0.5 * (unique20cmCells - 1) + min(distanceMetres, unique20cmCells * 0.4) - 2 * contacts - blockedSeconds - 0.1 * cableSeconds + objectiveReward",completed:job.completed,results:job.results,episodes:job.datasets,controller:controllerCheckpoint(job.best,{domain:trainingContext?.domain??brainDomain,fitness:job.fitness,generation:(trainingContext?.initialGeneration??0)+(job.options.evolve?job.completedGeneration:0)}),lifecycle:journeySnapshot(),notes:"Evaluation pose/contact fields are privileged labels, never neural inputs. Pixels are delivered CNN input crops. Last two episodes retained; omittedFrames reports pixel-byte limits."},null,2));});
  button("export-fly",()=>{if(!controller)return;const combined=JSON.parse(exportVisionBrain({name:brainName,controller:controllerCheckpoint(controller,{domain:brainDomain,fitness:brainFitness,generation:brainGeneration}),profile:controller.inputCount>17?"robot":"kart",vision:perceiver?.model??null,fusion:{fade:0,mode:"belief",visionTemperature:1},memory:null,world:brainDomain==="world"?{controller:controllerCheckpoint(controller,{domain:"world",fitness:brainFitness,generation:brainGeneration}),vision:perceiver?.model??null}:null,notes:"3D habitat controller and eyes. robotLearning contains this workbench\u0027s visual/reward extension; other labs may ignore it."}));combined.robotLearning=learningData(true);download("robot-fly-with-eyes.json",JSON.stringify(combined,null,2));});
}

function renderMap(): void {
  const canvas = el<HTMLCanvasElement>("room-map"), ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#142228"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = 23, originX = canvas.width / 2, originY = canvas.height / 2;
  ctx.strokeStyle = "#26383d"; ctx.lineWidth = 1;
  for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(originX + i * scale, 0); ctx.lineTo(originX + i * scale, canvas.height); ctx.moveTo(0, originY + i * scale); ctx.lineTo(canvas.width, originY + i * scale); ctx.stroke(); }
  for (const [key, occupancy] of memory.map) { const [x, z] = key.split(",").map(Number); ctx.fillStyle = occupancy > 0 ? `rgba(233,186,115,${Math.min(.9, occupancy / 3 + .2)})` : "#466c5d"; ctx.fillRect(originX + x * .1 * scale, originY + z * .1 * scale, 3, 3); }
  const p = estimator.pose; ctx.save(); ctx.translate(originX + p.x * scale, originY + p.z * scale); ctx.rotate(p.heading); ctx.fillStyle = "#d4e7de"; ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.fillStyle = "#8fa6a7"; ctx.font = "9px system-ui"; ctx.fillText("ESTIMATED POSE / 1 m GRID", 9, 14);
}
function telemetry(): void {
  lowerWorkbench?.refresh();
  targetLab?.update(guardReason);
  if(document.getElementById('timing-rows')){const reports=[...sensorTiming.report(simTime),...hardwarePanel.timingReport()];el('timing-rows').replaceChildren(...reports.map(r=>{const tr=document.createElement('tr');for(const value of [r.channel,r.hz.toFixed(1)+' Hz',r.ageMs.toFixed(0)+' ms',r.p95GapMs.toFixed(0)+' ms',r.missing+'/'+r.samples])tr.append(Object.assign(document.createElement('td'),{textContent:String(value)}));return tr;}));setText('timing-cost',`Sim camera + perception: ${captureCost.toFixed(1)} ms / delivered frame. Ages and gaps use separate simulation and host clocks; no assumed device/host clock synchronization.`);}
  const vr=vibration.reading;setText("vibration-status",vr.valid?`DO ${vr.level} · ${vr.active?"Vibration event held":"Quiet"} · ${vr.count} events${(wiring.vibration??-1)<0?" · virtual DO (unwired)":""}`:"Disabled · optional sensor");
  if (training) renderTraining();
  if (el<HTMLDialogElement>("pinout").open) pinoutDiagram.live(firmware.pins, sonar.pulseMicroseconds);
  setText("executing-line", `Ln ${firmware.currentLine} · ${value("drive-mode").toUpperCase()}`);
  setText("run-reason", running ? "Running · autonomous modes keep running on focus loss" : `Paused · ${pauseReason}`);
  setText("camera-stats", `Frame ${cameraFrame} · mean RGB ${cameraRGB.map(Math.round).join(" / ")}${cameraDropped ? " · MISSING" : ""}`);
  setText("brain-stats", `Steer ${action.steer.toFixed(2)} · Drive ${action.throttle.toFixed(2)} · Brake ${action.brake.toFixed(2)} · Reverse ${(action.reverse ?? 0).toFixed(2)}`);
  setText("motor-routing", `${adapterConfig.leftSource} → LEFT front + rear  ${Math.round(requests.left)}\n${adapterConfig.rightSource} → RIGHT front + rear  ${Math.round(requests.right)}\n${adapterConfig.steering.toUpperCase()} · software leg adapters · ±${adapterConfig.maxPWM} PWM`);
  for (const key of ["steer", "throttle", "reverse", "brake"] as const) { el<HTMLMeterElement>(`output-${key}`).value = action[key] ?? 0; setText(`output-value-${key}`, (action[key] ?? 0).toFixed(2)); }
  setText("motor-note", !["fly","reward"].includes(value("drive-mode")) ? "Fly outputs are observed; this preset uses its own motor requests." : !running ? "Simulation paused. Run or Step to execute the fly and sketch." : Math.max(...actualPWM.map(Math.abs)) < physics.config.deadband ? "Motor PWM below start threshold. Inspect drive/brake outputs or try the drive-check preset." : value("drive-mode")==="reward" ? "Fly + sugar memory requests pass through your sketch; paired wheels share each driver channel." : "Fly requests pass through your sketch; paired wheels share each driver channel.");
  setText("check-cycles", `${driveCheck.cycles} CYCLES`);
  setText("check-phase", appliedProgram === "sequence" ? (CHECK_PHASES[phaseIndex]?.title ?? "Ready · press Run") : "Drive check inactive · choose preset 01");
  const progress = el("check-progress"); if (!progress.children.length) progress.innerHTML = CHECK_PHASES.map(p => `<i title="${p.title}"></i>`).join("");
  Array.from(progress.children).forEach((bar, i) => bar.classList.toggle("active", appliedProgram === "sequence" && phaseIndex === i));
  el("check-results").replaceChildren(...driveCheck.results.slice(-4).map(r => { const row = document.createElement("p"); row.className = r.passed ? "pass" : "fail"; row.textContent = `${r.passed ? "✓" : "!"} ${r.title} · ${r.distanceCm.toFixed(1)} cm / ${r.yawDeg.toFixed(1)}°${r.contacts ? ` · ${r.contacts} contacts` : ""}`; row.title = r.reason; return row; }));
  if (consoleRevision !== consoleLog.revision) {
    consoleRevision = consoleLog.revision; const box = el("console-lines"), scroll = box.scrollTop;
    const filtered = consoleLog.select(value("console-filter"));
    box.replaceChildren(...filtered.slice(-65).map(event => { const row = document.createElement("div"); row.className = `event event-${event.kind}`; const time = document.createElement("time"), tag = document.createElement("b"), text = document.createElement("span"); time.textContent = `${event.time.toFixed(3)}s`; tag.textContent = event.kind.toUpperCase(); text.textContent = event.message; row.append(time, tag, text); return row; }));
    box.scrollTop = check("log-follow") ? box.scrollHeight : scroll; setText("log-count", `${consoleLog.events.length} / 1,500 retained events · showing last 65 ${value("console-filter")} events · export includes structured inputs, estimates, outputs and sensor measurements`);
  }
  setText("range", !physics.config.sonarEnabled ? "Off" : sonar.reading.echo ? (sonar.metres * 100).toFixed(1) : "—");
  setText("range-unit", sonar.reading.echo && physics.config.sonarEnabled ? "cm" : "no echo");
  setText("echo-note", sonar.reading.echo ? `ECHO pulse ≈ ${Math.round(sonar.pulseMicroseconds)} µs · ${(simTime - sonar.lastTime < .001 ? "fresh" : "held")} sample` : "No return: out of range, weak, angled or below the beam.");
  setText("speed", (physics.speed * 100).toFixed(1)); setText("hits", String(physics.collisions)); setText("left-pwm", String(Math.round(actualPWM[0] * 255))); setText("right-pwm", String(Math.round(actualPWM[1] * 255)));
  const errors = wiringIssues(wiring).errors;
  setText("motion-state", errors.length ? "Motor inhibit · check wiring" : physics.blocked ? `Contact · ${physics.contact?.part ?? "solid"} · motion blocked` : running ? `Running · ${simTime.toFixed(1)} s` : `Paused · ${simTime.toFixed(1)} s`);
  setText("contact-note", physics.blocked ? `Blocked by ${physics.contact?.part ?? "solid geometry"}. Contacts use visible solids at chassis height, independently of the fly's memory map. Reset or reverse to move away.` : physics.surface ? physics.surface.kind === "cable" ? "Crossing a loose cable · drive-over allowed, possible snag · 25% simulated speed reduction" : "Crossing a doormat · 15% simulated speed reduction" : `Chassis clearance envelope ${((physics.config.mountHeight + .04) * 100).toFixed(1)} cm · furniture tops above it do not block movement · low mats and cables are traversable`);
  el("motion-state").classList.toggle("blocked", physics.blocked || errors.length > 0);
  setText("memory-count", `${memory.taught} cells learned`); setText("memory-recall", check("memory-enabled") && memory.recalled && brainDomain === "world" ? "Recalling · 20% cue" : "No recall");
  refreshLearning();researchPanel?.refreshPlaces();
  setText("camera-rate", String(physics.config.cameraHz)); setText("camera-height", (physics.config.mountHeight * 100).toFixed(1));
  setText("perception-note", !physics.config.cameraEnabled ? "Camera disconnected · visual estimates zero" : perceiver ? `${brainDomain === "world" ? "9 obstacle sectors + surface" : "13 racing estimates"} → ${controller?.inputCount ?? 17} brain inputs` : "No eyes loaded · import a vision brain");
  const spikes = controller?.activity().spikes;
  el("spikes").querySelectorAll("i").forEach((dot, i) => dot.classList.toggle("active", !!spikes?.[i]));
  const bars = el("input-bars"); if (bars.children.length !== sensors.length) bars.innerHTML = sensors.map(() => "<i></i>").join("");
  Array.from(bars.children).forEach((bar, i) => { (bar as HTMLElement).style.height = `${Math.max(5, Math.abs(sensors[i]) * 100)}%`; (bar as HTMLElement).title = `Input ${i}: ${sensors[i].toFixed(3)}`; });
  setText("pins", ["in1", "in2", "in3", "in4", "ena", "enb"] .map(k => { const pin = wiring[k as keyof Wiring] as number; return `${k.toUpperCase().padEnd(4)} GPIO ${String(pin).padStart(2)}  ${pin < 0 ? "JUMPER HIGH" : String(Math.round(firmware.pins.get(pin) ?? 0)).padStart(3) + " / 255"}`; }).join("\n"));
  renderMap();
}

function wireEvents(): void {
  el("step").after(Object.assign(document.createElement("select"), { id: "step-size", innerHTML: '<option value="1">1 tick</option><option value="30">1 second</option><option value="150">5 seconds</option>', ariaLabel: "Step duration" }));
  el("reset").after(Object.assign(document.createElement("select"), { id: "sim-rate", innerHTML: '<option value="1">1× speed</option><option value="2">2× speed</option><option value="4">4× speed</option>', ariaLabel: "Simulation speed" }));
  button("vibration-shake",()=>{if(!physics.config.vibration?.enabled){message("Enable SW-420 in Components & wiring and Apply components first.");return;}const s=physics.config.vibration;vibration.sample(s.activeLow?1:0,simTime*1000,s);vibration.sample(s.activeLow?0:1,simTime*1000,s);log("vibration",`Injected test shake · DO=${vibration.reading.level} · event #${vibration.reading.count}`,{...vibration.reading});telemetry();});
  button("run", () => setRunning(!running)); button("step", () => { setRunning(false, "stepped simulation"); for (let i = 0; i < Number(value("step-size")); i++) tick(); telemetry(); }); button("reset", () => { if(training)endTraining("Robot reset; training stopped.");resetRobot(); });
  button("focus", () => { following = !following; if (following) scene.focus(physics.pose); el("focus").textContent = following ? "Unfollow robot" : "Follow robot"; });
  button("overview", () => { following = false; el("focus").textContent = "Follow robot"; scene.overview(); });
  el("preset").addEventListener("change", () => { editWorld(); objects = preset(value("preset")); floorColour = ROOM_TYPES.find(r => r.id === value("preset"))?.floor ?? "#b7bea7"; selected = null; worldChanged(); selectObject(null); resetRobot(); message("Habitat replaced. Room memory cleared; Undo edit restores the previous layout and floor colour."); });
  let floorEditing=false;
  el("floor-colour").addEventListener("input", () => {if(!floorEditing){editWorld();floorEditing=true;} if(training)endTraining("Floor changed; training stopped.");floorColour = validateFloor(value("floor-colour")); updateFloor(); captureTime = -Infinity; });
  el("floor-colour").addEventListener("change",()=>{floorEditing=false;saveLocal();});
  el("collision-visible").addEventListener("change", () => scene.showContacts(check("collision-visible")));
  button("add-object", () => { if (objects.length >= 200) { message("The habitat limit is 200 objects.", true); return; } editWorld(); const o = makeObject(value("object-kind") as ObjectKind, clamp(physics.pose.x + Math.cos(physics.pose.heading) * .75, -3, 3), clamp(physics.pose.z + Math.sin(physics.pose.heading) * .75, -3, 3)); objects.push(o); selected = o.id; worldChanged(); selectObject(o.id); });
  button("add-room", () => { if (objects.length > 196) { message("Four free object slots are needed for a room.", true); return; } editWorld(); const x = .5, z = .5; objects.push(...[{ x, z: z - .8, width: 1.6 }, { x: x - .8, z, width: 1.6, yaw: Math.PI / 2 }, { x: x + .8, z, width: 1.6, yaw: Math.PI / 2 }, { x: x + .45, z: z + .8, width: .7 }].map(p => ({ ...makeObject("wall"), ...p, height: .8 }))); worldChanged(); message("Added a 1.6 m room with a doorway. Select its walls to adjust dimensions."); });
  button("undo", () => safe(() => {pauseForEdit("Undo scene edit");const previous=history.pop();if(previous){redoHistory.push(sceneEditSnapshot());restoreSceneEdit(previous);}}));
  button("redo", () => safe(() => {pauseForEdit("Redo scene edit");const next=redoHistory.pop();if(next){history.push(sceneEditSnapshot());restoreSceneEdit(next);}}));
  document.addEventListener('keydown',event=>{const target=event.target as HTMLElement,editable=target.closest('textarea,[contenteditable=true],input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button]):not([type=submit])');if(!(event.ctrlKey||event.metaKey)||event.altKey||editable)return;if(event.key.toLowerCase()==='z'){event.preventDefault();el<HTMLButtonElement>(event.shiftKey?'redo':'undo').click();}else if(event.key.toLowerCase()==='y'){event.preventDefault();el<HTMLButtonElement>('redo').click();}});
  el("object-list").addEventListener("change", () => selectObject(value("object-list") || null));
  bindSceneEditing();

  button("advanced", () => { fillHardware(); el<HTMLDialogElement>("hardware").showModal(); }); button("close-hardware", () => el<HTMLDialogElement>("hardware").close());
  const pinoutButton = document.createElement("button"); pinoutButton.id = "show-pinout"; pinoutButton.textContent = "Pinout & wires"; el("advanced").before(pinoutButton);
  button("show-pinout", () => { pinoutDiagram.update(wiring, physics.config); pinoutDiagram.live(firmware.pins, sonar.pulseMicroseconds); el<HTMLDialogElement>("pinout").showModal(); });
  pinoutDiagram.enableEditing((signal,pin)=>safe(()=>{
    if(hardwarePanel.busy)throw new Error("Disconnect hardware before reconnecting GPIOs.");
    const next=reconnect(wiring,signal,pin), rewritten=rewritePins(value("sketch"),next), nextFirmware=new Firmware(rewritten.source);
    nextFirmware.tick({timeMs:0,brainLeft:0,brainRight:0,echoUs:0,wiring:next});
    if(training)endTraining("Wiring changed; training stopped.");setRunning(false,"GPIO reconnected");wiring=next;firmware=nextFirmware;el<HTMLTextAreaElement>("sketch").value=rewritten.source;sketchEditor.refresh();physics.left=physics.right=0;actualPWM=[0,0];sonar=new RobotSonar();clearMemory();captureTime=-Infinity;
    pinoutDiagram.update(wiring,physics.config);codeMessage(`GPIOs synchronized · ${rewritten.changed.join(" / ")||"unchanged"}`);saveLocal();log("system",`Reconnected ${signal.toUpperCase()} → ${pin<0?"enable jumper":`GPIO ${pin}`} · code updated`,wiring);message("Wiring and sketch updated together. Simulation paused; reflash the bridge before changing real wires.");
  }));
  button("close-pinout", () => el<HTMLDialogElement>("pinout").close());
  button("export-wiring", () => download("robot-wiring.svg", pinoutDiagram.exportSvg(), "image/svg+xml"));
  button("edit-pinout", () => { el<HTMLDialogElement>("pinout").close(); fillHardware(); el<HTMLDialogElement>("hardware").showModal(); el("connection-settings").scrollIntoView({ block: "start" }); });
  el("board").addEventListener("change", () => { const profile = value("board") === "uno" ? UNO_WIRING : ESP_WIRING; for (const key of ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo", "vibration"] as const) el<HTMLInputElement>(`wire-${key}`).value = String(profile[key]??-1); el<HTMLInputElement>("echo-divider").checked = profile.echoDivider; previewWiring(readWiring()); });
  button("apply-hardware", () => safe(() => {
    if(hardwarePanel.busy)throw new Error("Disconnect hardware before changing its configuration.");
    const config = { ...physics.config }; for (const [key, , , , scale] of ALL_FIELDS) Object.assign(config, { [key]: Number(value(`component-${key}`)) / scale }); config.cameraEnabled = check("camera-enabled"); config.sonarEnabled = check("sonar-enabled");config.vibration=readVibration();
    const nextConfig = validateConfig(config), nextWiring = validateWiring(readWiring()), nextAdapter = validateAdapter({ steering: value("route-steering"), turnGain: Number(value("route-gain")), maxPWM: Number(value("route-pwm")), leftSource: value("route-left"), rightSource: value("route-right"), invertLeft: check("route-invert-left"), invertRight: check("route-invert-right") });
    const changed = ["in1","in2","in3","in4","ena","enb","trig","echo","vibration"].some(k=>nextWiring[k as keyof Wiring]!==wiring[k as keyof Wiring]);
    const nextSource=changed?rewritePins(value("sketch"),nextWiring).source:firmware.source; const nextFirmware=new Firmware(nextSource);
    if(training)endTraining("Components changed; training stopped.");
    physics.config=nextConfig;wiring=nextWiring;adapterConfig=nextAdapter;firmware=nextFirmware;el<HTMLTextAreaElement>("sketch").value=nextSource;sketchEditor.refresh();setRunning(false);hardwareChanged();el<HTMLDialogElement>("hardware").close();message("Components applied; changed GPIO constants synchronized with the code. Recompile the bridge before changing real wires.");
  }));
  button("apply-code", () => applyCode(value("sketch"))); button("default-code", () => chooseProgram("fly")); button("reflex-code", () => chooseProgram("avoid"));
  el("drive-mode").addEventListener("change", () => { hardwarePanel.stop();if(training)endTraining("Motor request source changed; training stopped.");log("system", `Motor request source: ${value("drive-mode")}`); saveLocal(); });
  el("sketch").addEventListener("input", () => codeMessage("Unapplied changes · click Apply & restart code"));
  el("sketch").addEventListener("keydown", event => { if (event instanceof KeyboardEvent && event.key === "Tab") { event.preventDefault(); const editor = el<HTMLTextAreaElement>("sketch"); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); editor.dispatchEvent(new Event("input")); } });
  button("export-code", () => download("robot-controller.ino", value("sketch"), "text/plain"));
  button("forget", () => { if(training)endTraining("Memory cleared; training stopped.");clearMemory(); message("Forgot the room's learned visual cells and sonar map."); });
  el("memory-enabled").addEventListener("change", () => { hardwarePanel.stop();if(training)endTraining("Memory setting changed; training stopped.");if (!check("memory-enabled")) memory.recalled = false; });
  button("export-brain", () => { if (controller) download("robot-flykart-brain.json", JSON.stringify(controllerCheckpoint(controller, { domain: brainDomain, fitness: brainFitness, generation: brainGeneration }), null, 2)); });
  button("restore-brain", () => { setRunning(false); void loadBundled().then(()=>saveLocal()).catch(error => message(String(error), true)); });
  button("save-lab", () => safe(() => download("robot-habitat.json", JSON.stringify(labData(), null, 2))));
  const file = (id: string, callback: (text: string) => void|Promise<void>, max = 64000000) => el<HTMLInputElement>(id).addEventListener("change", async e => { const input = e.target as HTMLInputElement, upload = input.files?.[0]; if (!upload) return; if (upload.size > max) { message("File exceeds the size limit.", true); input.value = ""; return; } try { const opening="Opening " + upload.name + "…"; message(opening); await callback(await upload.text()); if(el("status").textContent===opening)message("Opened " + upload.name + "."); } catch (error) { message(error instanceof Error ? error.message : String(error), true); } input.value = ""; });
  const importBusy=()=>hardwarePanel.busy||!!training||!!researchPanel?.active||!!calibrationPanel?.active||!!taskPanel?.active;
  attachJsonImport(el<HTMLInputElement>('brain-file'), text => { setRunning(false); installBrain(text); }, { title: 'Import robot brain', busy: importBusy, onError: detail => message(detail, true) });
  file("ino-file", text => { program = "custom"; customDraft = text; el<HTMLTextAreaElement>("sketch").value = text; programInfo(); codeMessage("Sketch opened. Click Apply code to run it."); }, 60000);
  attachJsonImport(el<HTMLInputElement>('lab-file'), text => restoreLab(JSON.parse(text)), { title: 'Import robot lab', busy: importBusy, onError: detail => message(detail, true) });
  const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.matches("input,textarea,select") || target.isContentEditable);
  window.addEventListener("keydown", e => { if (!editable(e.target) && !el<HTMLDialogElement>("hardware").open && !el<HTMLDialogElement>("pinout").open && ["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) { if (value("drive-mode") === "manual") e.preventDefault(); keys.add(e.key); } });
  window.addEventListener("keyup", e => keys.delete(e.key)); window.addEventListener("blur", () => { keys.clear(); if (value("drive-mode") === "manual") { hardwarePanel.stop();actualPWM = [0, 0]; physics.left = physics.right = 0; setRunning(false, "manual keyboard focus lost"); } });
}

function labData(){return { format: "flykart-robot-lab", version: 1, savedAt: new Date().toISOString(), objects, floorColour,startPose,currentPose:{...physics.pose},mission,learning:learningData(), config: physics.config, wiring, sketch: value("sketch"), program: appliedProgram, mode: value("drive-mode"), adapter: adapterConfig, cameraLatency:cameraDelay.seconds, noise: noiseConfig, controller: controller ? controllerCheckpoint(controller, { domain: brainDomain, fitness: brainFitness, generation: brainGeneration }) : null, vision: perceiver?.model ?? null, memory: memory.toJSON() ,internalEnergy:energy.energy };}
async function prepareObjectVisuals(items:WorldObject[]):Promise<void>{const visuals=items.map(o=>o.visual).filter((v):v is NonNullable<WorldObject['visual']>=>!!v);const unique=[...new Map(visuals.map(v=>[v.data,v])).values()];if(unique.reduce((sum,v)=>sum+v.data.length,0)>8_000_000)throw new Error('Imported visual budget exceeds 8 MB.');for(const v of visuals)await prepareVisual(v);}
async function restoreLab(raw:unknown,verifyOnly=false):Promise<void>{
    if(hardwarePanel.busy)throw new Error("Disconnect hardware before importing another lab.");
    const data = raw as any; if (data.format !== "flykart-robot-lab" || data.version !== 1) throw new Error("Expected a FlyKart robot lab file.");
    // Validate every component before mutating the current session.
    const nextObjects = validateObjects(data.objects), nextConfig = validateConfig(data.config), nextWiring = validateWiring(data.wiring), nextFirmware = new Firmware(data.sketch), nextMemory = RoomMemory.fromJSON(data.memory);
    const nextAdapter = validateAdapter(data.adapter ?? DEFAULT_ADAPTER), nextNoise = validateNoise(data.noise ?? DEFAULT_NOISE), nextDelay=new CameraDelay(data.cameraLatency??0), nextFloor = validateFloor(data.floorColour);
    const nextPose=validatePose(data.startPose??new RobotPhysics().pose),nextMission=data.mission?validateMission(data.mission):{settings:{...DEFAULT_OBJECTIVE},goals:[],trail:[]},learned=parseLearning(data.learning,nextMemory);
    if(nextMission.goals.some(g=>nextObjects.some(o=>o.id===g.id)||g.id==="@robot"))throw new Error("Sugar and object IDs must be unique.");
    let nextBrain: SpikingNetwork | null = null, nextEyes: Perceiver | null = null, nextDomain: "world" | "track" = "world", nextFitness=0, nextGeneration=0;
    if (data.controller) { const parsed = importFile(JSON.stringify(data.controller)); nextDomain = parsed.controller!.domain; nextFitness=parsed.controller!.meta.fitness??0;nextGeneration=parsed.controller!.meta.generation??0;nextBrain = SpikingNetwork.fromJSON(parsed.controller!.snapshot); if (data.vision) nextEyes = validateEyes(data.vision, nextDomain); }
    if(data.internalEnergy!==undefined&&(!Number.isFinite(data.internalEnergy)||data.internalEnergy<0||data.internalEnergy>1))throw new Error('Invalid internal energy.');
    await prepareObjectVisuals([...nextObjects,...(learned.lifecycle?.settings.specimen?[learned.lifecycle.settings.specimen]:[])]);
    if(hardwarePanel.busy||researchPanel.active||calibrationPanel.active||taskPanel.active)throw new Error('Job started during import; try again.');
    if(verifyOnly)return;
    if(training)endTraining("Lab imported; training stopped.");brainFitness=nextFitness;brainGeneration=nextGeneration;brainName=nextBrain?"Imported lab controller":"No controller";
    editWorld();startPose=nextPose;mission=nextMission;memorySettings=learned.memorySettings;visionSettings=learned.visionSettings;sugarPolicy=learned.policy;calibration=learned.calibration;compensationEnabled=learned.compensationEnabled;places=learned.places;estimator=new StateEstimator(physics.pose,calibration);el<HTMLInputElement>("sugar-learn").checked=learned.learn;fillLearning();
    objects = nextObjects;if(learned.lifecycle)loadJourney(learned.lifecycle);else loadJourney({format:"robot-lifecycle",version:1,settings:structuredClone(DEFAULT_TASK),brain:new TaskBrain().toJSON(),lineage:[],evidence:[]}); floorColour = nextFloor; physics.config = nextConfig; wiring = nextWiring; controller = nextBrain; perceiver = nextEyes; brainDomain = nextDomain; firmware = nextFirmware; el<HTMLTextAreaElement>("sketch").value = firmware.source;
    cameraDelay=nextDelay; adapterConfig = nextAdapter; noiseConfig = nextNoise; program = appliedProgram = PROGRAMS.some(p => p.id === data.program) ? data.program : "custom"; el<HTMLSelectElement>("drive-mode").value = ["fly", "manual", "sketch", "reward", "task", "coach"].includes(data.mode) ? data.mode : "sketch"; programInfo(); fillNoise();
    estimates = new Float32Array(nextEyes?.estimateCount ?? (nextDomain === "world" ? 10 : 13)); sensors = new Array(controller?.inputCount ?? 19).fill(0); selected = null; scene.rebuildObjects(objects); scene.rebuildRobot(physics.config); scene.select(null); populateObjects(); selectObject(null); resetRobot(); memory = nextMemory;if(data.internalEnergy!==undefined)energy.energy=data.internalEnergy;targetLab?.sync();
    updateFloor();rebuildSwarm(); setText("brain-name", controller ? "Imported lab controller" : "No controller · use manual or sketch"); setText("adapter", `${brainDomain.toUpperCase()} INPUTS`); saveLocal(); message("Imported habitat, components, sketch, brain and learned memory. Robot reset to its starting pose.");
}

function researchCheckpoint():()=>void {
  if(training||researchPanel?.active)throw new Error("Finish the current training or research job before starting another run.");
  const state={vibration,objects,floorColour,startPose:{...startPose},mission,config:physics.config,wiring,adapterConfig,controller,perceiver,memory,sugarPolicy,visionSettings,swarm,noiseConfig,noise,firmware,program,appliedProgram,objectiveRun,estimator,places,simTime,liveRecorder,liveEpisode,action,actualPWM,estimates:estimates.slice(),sensors:[...sensors],sonar,selected,returnToPlace,journey:journeySnapshot(),taskOrigin:taskOrigin?structuredClone(taskOrigin):null,taskJudge,taskRaw:taskRaw.slice(),taskInputs:[...taskInputs],taskWidth,taskHeight,targetTracker,taskSeen,cameraDelay,energy,sensorTiming,guardReason,mode:value('drive-mode'),enabled:check('memory-enabled'),physics:{pose:{...physics.pose},odometry:{...physics.odometry},left:physics.left,right:physics.right,speed:physics.speed,blocked:physics.blocked,collisions:physics.collisions,contact:physics.contact,surface:physics.surface}};
  researchBaseline={brain:controller,visionSettings:{...visionSettings},config:{...physics.config},source:firmware.source,mode:value("drive-mode"),policy:sugarPolicy,memoryEnabled:check("memory-enabled")};
  energy=new EnergyState(validateHunger(taskSettings.hunger));sensorTiming=new SensorTiming();targetTracker=new TargetTracker();taskSeen={...EMPTY_TARGET};cameraDelay=new CameraDelay();swarm=perceiver?new VisualSwarm(perceiver.model,visionSettings):null;controller=controller?.clone()??null;
  memory=memory.fresh();sugarPolicy=SugarPolicy.fromJSON(sugarPolicy.toJSON(),memorySettings.count);places=VisualPlaces.fromJSON(places.toJSON());estimator=new StateEstimator(physics.pose,calibration);
  return ()=>{vibration=state.vibration;objects=state.objects;loadJourney(state.journey);energy=state.energy;sensorTiming=state.sensorTiming;guardReason=state.guardReason;taskJudge=state.taskJudge;taskOrigin=state.taskOrigin;taskRaw=state.taskRaw;taskInputs=state.taskInputs;taskWidth=state.taskWidth;taskHeight=state.taskHeight;targetTracker=state.targetTracker;taskSeen=state.taskSeen;cameraDelay=state.cameraDelay;floorColour=state.floorColour;startPose=state.startPose;mission=state.mission;physics.config=state.config;Object.assign(physics,state.physics);wiring=state.wiring;adapterConfig=state.adapterConfig;controller=state.controller;perceiver=state.perceiver;memory=state.memory;sugarPolicy=state.sugarPolicy;visionSettings=state.visionSettings;swarm=state.swarm;noiseConfig=state.noiseConfig;noise=state.noise;firmware=state.firmware;program=state.program;appliedProgram=state.appliedProgram;objectiveRun=state.objectiveRun;estimator=state.estimator;places=state.places;simTime=state.simTime;liveRecorder=state.liveRecorder;liveEpisode=state.liveEpisode;action=state.action;actualPWM=state.actualPWM;estimates=state.estimates;sensors=state.sensors;sonar=state.sonar;selected=state.selected;returnToPlace=state.returnToPlace;el<HTMLSelectElement>('drive-mode').value=state.mode;el<HTMLInputElement>('memory-enabled').checked=state.enabled;researchMode=false;scene.rebuildObjects(objects);scene.rebuildRobot(physics.config);scene.rebuildMission(mission,objectiveRun.collected);updateFloor();populateObjects();fillLearning();fillHardware();fillNoise();programInfo();el<HTMLTextAreaElement>('sketch').value=firmware.source;sketchEditor.refresh();captureTime=-Infinity;};
}
function configureTrial(c:TrialCase,v:Variant,brain?:ReturnType<SpikingNetwork['toJSON']>):void {
  const baseline=researchBaseline?.brain;if(!baseline||!perceiver)throw new Error('Load a controller and its eyes before research.');
  taskSettings={...taskSettings,mode:'off'};researchMode=true;objects=structuredClone(c.objects);startPose={...c.pose};mission=structuredClone(c.mission);floorColour='#b7bea7';physics.config={...researchBaseline!.config,sonarEnabled:v!=='no-sonar'&&researchBaseline!.config.sonarEnabled};visionSettings={...researchBaseline!.visionSettings};sugarPolicy=SugarPolicy.fromJSON(researchBaseline!.policy.toJSON(),memorySettings.count);
  controller=brain?SpikingNetwork.fromJSON(brain):baseline.clone();
  if(v==='single')visionSettings={...visionSettings,layout:'single'};if(v==='swarm3')visionSettings={...visionSettings,layout:'circle3'};if(v==='filtered5')visionSettings={...visionSettings,layout:'circle5',normalize:true,smooth:true,temporal:4};
  el<HTMLInputElement>('memory-enabled').checked=v!=='no-memory';returnToPlace=false;memory=memory.fresh();places=new VisualPlaces();sugarPolicy.reset(c.seed);noiseConfig={...DEFAULT_NOISE,...(c.harsh?NOISE_PRESETS.harsh:NOISE_PRESETS.mild),seed:c.seed};noise=new NoiseSource(noiseConfig);
  // Use the edited sketch, including actual pin writes. Preserve teacher outputs through it.
  firmware=new Firmware(brain?programSketch("fly",wiring):researchBaseline!.source);el<HTMLSelectElement>('drive-mode').value=brain?"reward":researchBaseline!.mode==="reward"?"reward":"fly";scene.rebuildObjects(objects);resetRobot();rebuildSwarm();capture();
}
async function simulatedSegment(pwm:[number,number],seconds:number,gains:[number,number],pidEnabled:boolean,settings:PIDSettings,cancel:()=>boolean):Promise<{pose:Pose;blocked:boolean}> {
  if(hardwarePanel.busy)throw new Error('Disconnect hardware before simulated calibration.');if(gains.some(v=>v<.5||v>1.5))throw new Error('Demo gains must be 0.5–1.5.');
  physics.left=physics.right=0;const pid=new HeadingPID(settings.kp,settings.ki,settings.kd,settings.limit),target=physics.pose.heading;let time=0,blocked=false;estimator=new StateEstimator(physics.pose,calibration);
  while(time<seconds){if(cancel())throw new Error('Calibration demonstration cancelled.');for(let i=0;i<3&&time<seconds;i++){const dt=Math.min(1/30,seconds-time),correction=pidEnabled&&Math.abs(pwm[0]-pwm[1])<.01?pid.step(target,physics.pose.heading,dt,0):0,issued:[number,number]=[clamp(pwm[0]+correction,-1,1),clamp(pwm[1]-correction,-1,1)];estimator.predict(issued,physics.config,dt);physics.step(issued[0]*gains[0],issued[1]*gains[1],objects,dt);blocked||=physics.blocked;if(pidEnabled)estimator.observe(physics.pose,.02,.04,simTime,"virtual tracker · calibration demo");time+=dt;simTime+=dt;}scene.updateRobot(physics.pose,physics.config,check('beam-visible'),physics.left,physics.right,1/30);capture();await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
  // Endpoint protocol measures immediately after the timed pulse; each next mark starts from rest.
  physics.left=physics.right=0;actualPWM=[0,0];log('check',`Marked simulation segment · ${pidEnabled?'virtual tracker PID':'open loop'} · hidden plant gain demo`,{pose:physics.pose});return {pose:{...physics.pose},blocked};
}
function initializeResearch():void {
  const researchHost=document.createElement('section'),calibrationHost=document.createElement('section');hardwareHost.before(researchHost,calibrationHost);const jumps=document.createElement('div');jumps.className='row';jumps.innerHTML='<a href="#research-panel">Training, replay & export ↓</a><a href="#calibration-panel">Floor calibration ↓</a>';el('show-code').after(jumps);
  researchPanel=new ResearchPanel(researchHost,{busy:()=>hardwarePanel.busy||!!training||!!calibrationPanel?.active||!!taskPanel?.active,pause:()=>setRunning(false,'research job'),checkpoint:researchCheckpoint,configure:configureTrial,step:()=>{tick();return structuredClone(lastStep);},brain:()=>controller?.toJSON()??null,adopt:brain=>{pauseForEdit('Research winner adopted');controller=SpikingNetwork.fromJSON(brain);brainName='Research selected fly';setText('brain-name',brainName);rebuildSwarm();saveLocal();message('Selected research controller adopted. Export fly + eyes to keep it.');},download,message,context:()=>({objects,startPose,config:physics.config,wiring,adapter:adapterConfig,vision:perceiver?.model,visionSettings,memorySettings,calibration,sketch:firmware.source,controller:controller?.toJSON(),dt:1/30}),studentCode:(s,le)=>compactSketch(s,wiring,physics.config,le),studentRun:(s,cap,seconds)=>hardwarePanel.startStudent(s.hash,cap,seconds),stopHardware:()=>hardwarePanel.stop(),places:navigate=>{if(!researchMode)returnToPlace=navigate;const p=estimator.pose;return `${places.nodes.length} places / ${places.edges.length} edges · ${places.status}\nEstimated X ${p.x.toFixed(2)}, Z ${p.z.toFixed(2)}, heading ${(p.heading*180/Math.PI).toFixed(1)}° · position σ ${(Math.sqrt(Math.max(estimator.covariance[0],estimator.covariance[4]))*100).toFixed(1)} cm · ${estimator.source}; ${estimator.accepted} accepted, ${estimator.rejected} rejected observations · sugar route ${places.route().join(' → ')||'unknown'}`;},forgetPlaces:()=>{places=new VisualPlaces();saveLocal();}});
  researchPanel.liveLoader(()=>{const d=liveRecorder.finish(0,0,liveEpisode,mission.settings.mode!=='explore');return d;});
  calibrationPanel=new CalibrationPanel(calibrationHost,{config:()=>physics.config,pose:()=>({...physics.pose}),profile:()=>calibration,apply:(p,enabled)=>{calibration=validateCalibration(p);compensationEnabled=enabled;estimator.profile=calibration;saveLocal();message('Calibration profile applied to command odometry'+(enabled?' and simulated / USB-host motor compensation.':'.'));},busy:()=>hardwarePanel.busy||researchPanel.active||!!training||!!taskPanel?.active,checkpoint:researchCheckpoint,pause:()=>setRunning(false,'marked calibration'),segment:simulatedSegment,physical:(pwm,seconds,cancel,pid,settings)=>hardwarePanel.calibrationSegment(pwm,seconds,cancel,pid,settings),stop:()=>{hardwarePanel.stop();physics.left=physics.right=0;actualPWM=[0,0];},observe:(p,s,h)=>estimator.observe(p,s,h,simTime),wall:(cm,n,offset,sigma)=>estimator.wallRange(cm,n,offset,physics.config.length*.48,sigma,simTime),fov:degrees=>{physics.config.cameraFov=degrees;hardwareChanged();fillHardware();},mark:(origin,targets)=>scene.calibrationMarks(origin,targets),download,message});
  // Scene pointer edits and keyboard controls must not mutate a running research/calibration transaction.
  document.addEventListener('click',event=>{if(!researchPanel.active&&!calibrationPanel.active&&!taskPanel?.active)return;const target=event.target as HTMLElement;if(target.closest("#workbench-stop,.wb-navigation,.wb-view,#copy-log,#copy-log-json,#copy-serial,#save-serial,#export-log,#serial-stop,#serial-disconnect"))return;if(target.closest('#research-panel,#calibration-panel,#lifecycle-panel'))return;event.stopImmediatePropagation();event.preventDefault();},true);
  el('habitat').addEventListener('pointerdown',event=>{if(researchPanel.active||calibrationPanel.active||taskPanel?.active){event.stopImmediatePropagation();event.preventDefault();}},true);
}

function initializeJourney():void {
  const host=document.createElement('section');learningPanel.before(host);
  if(!el<HTMLSelectElement>('drive-mode').querySelector('option[value="task"]'))el<HTMLSelectElement>('drive-mode').add(new Option('Learned visual task network + inherited fly','task'));
  if(!el<HTMLSelectElement>('drive-mode').querySelector('option[value="coach"]'))el<HTMLSelectElement>('drive-mode').add(new Option('Camera coach · demonstration teacher','coach'));
  taskPanel=new LifecyclePanel(host,{snapshot:journeySnapshot,apply:settings=>{pauseForEdit('Task network selected');taskSettings=validateTaskSettings(settings);physics.config.cameraEnabled=settings.modules.camera;physics.config.sonarEnabled=settings.modules.sonar;chooseProgram('fly');el<HTMLSelectElement>('drive-mode').value=settings.mode==='off'?'fly':'task';taskJudge=new TaskJudge(taskSettings);taskEvidence=[];sonar=new RobotSonar();captureTime=-Infinity;scene.rebuildRobot(physics.config);fillHardware();saveLocal();message('Frozen visual task network selected. Sugar and pain score training; they are absent from its observation vector.');},transfer:()=>{
    pauseForEdit('Racer adapted');if(!controller||brainDomain!=='track'||!eyes.world)throw new Error('Import a track racer first. Its original is retained in journey lineage.');
    taskParent={domain:'track',brain:controller.toJSON()};controller=SpikingNetwork.fromJSON(racerToRoom(controller.toJSON()));perceiver=validateEyes(eyes.world,'world');brainDomain='world';brainName='Room offspring of imported racer';sensors=new Array(19).fill(0);estimates=new Float32Array(perceiver.estimateCount);lineage('Adapted racer: body speed/commands and static obstacle remapped; novel room rows zero');clearMemory();rebuildSwarm();setText('brain-name',brainName);setText('adapter','WORLD INPUTS');taskPanel.sync();saveLocal();message('Room offspring created; original racer retained. Validate this new task mapping before deployment.');
  },setup:setupTaskCase,checkpoint:researchCheckpoint,step:()=>{tick();return structuredClone(lastStep);},busy:()=>hardwarePanel.busy||!!training||researchPanel.active||calibrationPanel.active,pause:()=>setRunning(false,'training journey'),adopt:(b,event)=>{taskBrain=b.clone();targetTracker.reset();lineage(event);chooseProgram('fly');el<HTMLSelectElement>('drive-mode').value='task';taskPanel.sync();saveLocal();message('Learned visual network installed. Use frozen held-out tests to assess actual task success.');},evidence:e=>{taskEvidence=e;saveLocal();},context:()=>({controller:controller?.toJSON(),taskBrain:taskBrain.toJSON(),settings:structuredClone(taskSettings),contract:taskContract(taskBrain.observation,taskSettings.modules,taskSettings.target),config:{...physics.config},wiring:{...wiring},adapter:{...adapterConfig},visionSettings:structuredClone(visionSettings),eyeChecksum:perceiver?fingerprint(perceiver.model):null,memoryEnabled:check('memory-enabled'),memorySettings:{...memorySettings},sketch:firmware.source,objects:structuredClone(objects),startPose:{...startPose},floorColour,noise:{...noiseConfig},cameraLatency:cameraDelay.seconds}),download,message,frame:r=>{taskFrameRecorder=r;if(r)capture();}});
  taskPanel.sync();
}
function setupTaskCase(settings:TaskSettings,seed:number,heldOut:boolean,room:string,mode:'task'|'coach',challenge:TaskChallenge={profile:'baseline',variant:'current'}):void {
  if(!controller||!perceiver||brainDomain!=='world')throw new Error('Adapt the racer to room inputs, or load the bundled world fly first.');
  if(settings.mode==='forage'&&taskBrain.observation!==TASK_HUNGER)throw new Error('Prepare the hungry foraging head in Target studio before this task.');
  if(!Number.isInteger(seed)||seed<0||seed>2000000)throw new Error('Task seed must be a nonnegative integer below 2,000,000.');
  if(!taskPanel?.active){pauseForEdit('Room task prepared');editWorld();}
  else researchMode=true;
  const base=taskPanel?.active&&researchBaseline?researchBaseline:{config:{...physics.config},visionSettings:{...visionSettings},memoryEnabled:check('memory-enabled')},environment=taskEnvironment(seed,challenge.profile);
  physics.config={...base.config,...(environment.turnGrip===null?{}:{turnGrip:environment.turnGrip})};visionSettings=structuredClone(base.visionSettings);if(challenge.variant==='single')visionSettings={...visionSettings,layout:'single'};if(challenge.variant==='swarm3')visionSettings={...visionSettings,layout:'circle3',memberWeights:[1,1,1,0,0]};el<HTMLInputElement>('memory-enabled').checked=challenge.variant!=='no-memory'&&base.memoryEnabled;cameraDelay=new CameraDelay(environment.latency);if(environment.floor)floorColour=environment.floor;
  const c=taskCase(seed,heldOut,settings,room,physics.config,challenge);taskSettings=validateTaskSettings(settings);objects=c.objects;startPose=c.pose;taskOrigin=structuredClone(c.ball);taskEvidence=[];mission={settings:{...DEFAULT_OBJECTIVE},goals:[],trail:[]};physics.config={...physics.config,cameraEnabled:settings.modules.camera,sonarEnabled:settings.modules.sonar};
  controller=controller.clone();taskBrain=taskBrain.clone();memory=memory.fresh();places=new VisualPlaces();chooseProgram('fly');el<HTMLSelectElement>('drive-mode').value=mode;noiseConfig=heldOut||challenge.profile!=='baseline'?environment.noise:{...noiseConfig,seed};rebuildSwarm();updateFloor();scene.rebuildObjects(objects);scene.rebuildRobot(physics.config);resetRobot();capture();populateObjects();fillLearning();fillHardware();fillNoise();taskPanel?.sync();saveLocal();
  if(!taskPanel?.active)message((settings.mode==='forage'?'Charging-pod':settings.specimen||settings.target.appearance?'Custom-target':'Blue-ball')+' task prepared. Collect demonstrations, evolve visual offspring, then test held-out seeds.');
}

function initializeTargetTools():void{
  const busy=()=>hardwarePanel.busy||!!training||researchPanel.active||calibrationPanel.active||taskPanel.active;
  targetLab=new TargetLab(el('lifecycle-panel'),{settings:()=>taskSettings,energy:()=>energy,views:()=>({count:swarm?.members.length??0,disagreement:swarm?.disagreement??0}),frame:()=>({pixels:taskRaw,width:taskWidth,height:taskHeight,valid:!cameraDropped&&physics.config.cameraEnabled}),guard:()=>physics.config.guard??DEFAULT_GUARD,setGuard:g=>{pauseForEdit('Forward guard changed');physics.config.guard=g;lineage('Forward guard settings changed');saveLocal();},pause:()=>pauseForEdit('Target studio'),busy,apply:(settings,b)=>{pauseForEdit('Visual target changed');taskSettings=validateTaskSettings(settings);taskBrain=b;targetTracker.reset();resetObjectives();lineage('New target / energy observation head; retraining required');taskPanel.sync();saveLocal();},add:o=>{editWorld();const c={...o,id:makeObject(o.kind).id,x:0,z:0};objects.push(c);worldChanged();selectObject(c.id);},message});
  const timing=document.createElement('section');timing.className='timing-dashboard';timing.innerHTML='<h3>Sensor timing & freshness</h3><p>Acquisition cadence, delivery age, 95th-percentile sample gap, and missing observations. A no-echo sonar sample is fresh but its distance remains unknown.</p><div class="research-table"><table><thead><tr><th>Channel</th><th>Cadence</th><th>Age</th><th>p95 gap</th><th>Missing / samples</th></tr></thead><tbody id="timing-rows"></tbody></table></div><p id="timing-cost"></p><div class="row"><button id="timing-export">Export timing report</button><button id="timing-reset">Clear timing counters</button></div>';el('sensor-console').prepend(timing);button('timing-export',()=>download('robot-sensor-timing.json',JSON.stringify({simulation:sensorTiming.report(simTime),hardware:hardwarePanel.timingReport(),captureCost,noise:noiseConfig,cameraLatency:cameraDelay.seconds},null,2)));button('timing-reset',()=>sensorTiming.reset());
  new RunLibrary(el('research-panel').querySelector('.research-body')!,{lab:labData,restore:restoreLab,validate:lab=>restoreLab(lab,true),episodes:()=>{const candidates=[{at:taskPanel.retainedAt,episodes:taskPanel.retainedEpisodes()},{at:researchPanel.retainedAt,episodes:researchPanel.retainedEpisodes()},{at:lastTrainingAt,episodes:lastTraining?.datasets??[]}].filter(v=>v.episodes.length).sort((a,b)=>b.at-a.at);return candidates[0]?.episodes??(liveRecorder.steps.length?[liveRecorder.finish(0,0,liveEpisode,taskActive())]:[]);},evidence:()=>taskEvidence,replay:d=>{researchPanel.openReplay(d);const link=document.createElement('a');link.href='#research-panel';document.body.append(link);link.click();link.remove();},pause:()=>setRunning(false,'checkpoint'),busy,download,message});
}

async function main(): Promise<void> {
  el<HTMLSelectElement>("drive-mode").add(new Option("Learned visual task network + inherited fly","task"));el<HTMLSelectElement>("drive-mode").add(new Option("Camera coach · demonstration teacher","coach"));
  restoreLocal();const restoredJourney=journeySnapshot(),restoredDriveMode=value("drive-mode"),restoredController=controller,restoredEyes=perceiver,restoredDomain=brainDomain,restoredName=brainName,restoredFitness=brainFitness,restoredGeneration=brainGeneration;
  await prepareObjectVisuals([...objects,...(taskSettings.specimen?[taskSettings.specimen]:[])]);
  scene = new HabitatScene(el<HTMLCanvasElement>("habitat"), el<HTMLCanvasElement>("camera"), el<HTMLCanvasElement>("fly-eye")); scene.rebuildObjects(objects); scene.rebuildRobot(physics.config);
  updateFloor();
  resetObjectives();
  hardwarePanel=new HardwarePanel(hardwareHost,{context:()=>({wiring,config:physics.config,adapter:adapterConfig,source:firmware.source,brain:controller,eyes:perceiver?.model??null,domain:brainDomain,memoryEnabled:check("memory-enabled"),mode:value("drive-mode"),manual:manualDemands(),memory,memorySettings,visionSettings,objective:mission.settings,sugarPolicy,calibration,compensationEnabled,task:taskSettings,taskBrain}),pause:()=>{if(training)endTraining("Hardware armed; simulated training stopped.");setRunning(false,"physical hardware armed");},download,message});
  initializeLearning();initializeTraining();initializeResearch();initializeJourney();initializeTargetTools();
  el("spikes").innerHTML = Array.from({ length: 48 }, () => "<i></i>").join(""); populateObjects(); initializeHardware(); wireEvents(); initializeInstruments();
  lowerWorkbench=new RobotWorkbench(root.querySelector('.shell')!,{tasks:el('lifecycle-panel'),senses:learningPanel,train:trainingPanel,research:el('research-panel'),calibrate:el('calibration-panel'),logs:el('sensor-console'),hardware:hardwareHost},()=>({controller:brainName,senses:[physics.config.cameraEnabled?'Camera':'',physics.config.sonarEnabled?'HC-SR04':'',physics.config.vibration?.enabled?'SW-420':''].filter(Boolean).join(' · ')||'Sensors disconnected',task:taskSettings.mode!=='off'?`${taskSettings.mode==='forage'?'Seek charging / food pod':taskSettings.mode==='follow'?'Follow target':'Approach target'} · ${taskBrain.updates} visual updates`:mission.settings.mode==='explore'?'Explore the habitat':mission.settings.mode==='trail'?'Follow trail to sugar':'Find sugar',job:taskPanel.active?el('task-status').textContent??'Task training active':researchPanel.active?el('research-status').textContent??'Research active':calibrationPanel.active?el('cal-status').textContent??'Calibration active':training?el('train-status').textContent??'Controller training active':hardwarePanel.busy?'USB / hardware session active':running?'Simulation running · pause above or stop here':'Idle · choose a task or inspect a recording',busy:!!training||taskPanel.active||researchPanel.active||calibrationPanel.active||hardwarePanel.busy||running}),()=>{if(taskPanel.active)el('task-cancel').click();if(researchPanel.active)el('research-cancel').click();if(calibrationPanel.active)el('cal-stop').click();if(training)endTraining('Training stopped from the workbench');setRunning(false,'workbench stop');hardwarePanel.stop();message('Stop requested. Active jobs finish cancellation and restore their saved context.');});
  setupMonitorLayout(root.querySelector('.shell')!);
  codeMessage("Applied sketch ready · edit, Apply, then Run");
  let previous = performance.now(), accumulator = 0, uiTime = 0;
  const frame = (now: number) => {
    try {
    const elapsed = Math.min((now - previous) / 1000, .2); previous = now;
    if (running) { accumulator += elapsed * Number(value("sim-rate")); while (accumulator >= 1 / 30 && running) { tick(); accumulator -= 1 / 30; } } else accumulator = 0;
    scene.updateRobot(physics.pose, physics.config, check("beam-visible"), 0, 0, 0);
    if (following) scene.controls.target.set(physics.pose.x, .06, physics.pose.z);
    if ((!researchPanel?.active&&!calibrationPanel?.active&&!taskPanel?.active)&&(simTime - captureTime >= 1 / physics.config.cameraHz || captureTime === -Infinity)) capture();
    scene.render(); if (now - uiTime > 100) { telemetry(); uiTime = now; }
    } catch (error) { setRunning(false, "simulation error"); message(`Simulation paused: ${error instanceof Error ? error.message : error}`, true); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try { await loadBundled();if(restoredController&&restoredEyes){controller=restoredController;perceiver=restoredEyes;brainDomain=restoredDomain;brainName=restoredName;brainFitness=restoredFitness;brainGeneration=restoredGeneration;estimates=new Float32Array(perceiver.estimateCount);sensors=new Array(controller.inputCount).fill(0);setText("brain-name",brainName);setText("adapter",`${brainDomain.toUpperCase()} INPUTS`);rebuildSwarm();}loadJourney(restoredJourney);el<HTMLSelectElement>("drive-mode").value=restoredDriveMode;taskPanel.sync();saveLocal(); message("Ready. Start with Clear floor & run drive check, or choose a controller preset. Edit and Apply its code to change the machine."); }
  catch (error) { message(`Bundled brain unavailable: ${error instanceof Error ? error.message : error}. Manual and sketch control still work.`, true); }
}
void main().catch(error => { message(`Could not start the 3D habitat: ${error instanceof Error ? error.message : error}`, true); });
