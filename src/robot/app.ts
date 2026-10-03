import "./robot.css";
import { Action, SpikingNetwork, clamp } from "../core";
import { controllerCheckpoint, importFile } from "../vision/format";
import { Perceiver, VisionModel } from "../vision/perception";
import { worldDomain } from "../vision/world/worldDomain";
import { sensorsFromEstimates } from "../vision/interface";
import { Firmware } from "./firmware";
import { RoomMemory } from "./memory";
import { DEFAULT_ROBOT, ESP_WIRING, UNO_WIRING, RobotConfig, RobotPhysics, RobotSonar, Wiring, WorldObject, ObjectKind, OBJECT_TYPES, ROOM_TYPES, traversable, makeObject, preset, wiringIssues } from "./model";
import { HabitatScene } from "./scene";
import { CHECK_PHASES, DEFAULT_ADAPTER, DrivetrainCheck, MotorAdapter, motorRequests, PROGRAMS, ProgramId, programSketch, validateAdapter } from "./controls";
import { DEFAULT_NOISE, NOISE_PRESETS, NoiseSource, SensorNoise, validateNoise } from "./noise";
import { SensorConsole, EventKind } from "./telemetry";
import { SketchEditor } from "./editor";
import { WiringDiagram } from "./wiring-diagram";

const root = document.querySelector<HTMLDivElement>("#robot-app")!;
root.innerHTML = `
<header><div><p class="eyebrow">FLYKART / EMBODIED INTELLIGENCE</p><h1>Robot habitat<span style="color:var(--accent)">.</span></h1><p class="subtitle">A little fly. A real-sized robot. A world to learn.</p></div>
<nav aria-label="FlyKart pages"><a href="./index.html">Race lab ↗</a><a href="./vision.html">Vision lab ↗</a><span class="pill">ESP32-CAM · FOUR WHEELS</span></nav></header>
<main class="shell">
  <div class="toolbar"><div class="toolbar-group"><button id="run" class="primary">▶ Run simulation</button><button id="step">Step</button><button id="reset" class="quiet">Reset robot</button><label>Habitat <select id="preset"><option value="room">Workshop room</option><option value="garden">Garden</option><option value="empty">Empty floor</option></select></label></div><div class="toolbar-group"><button id="save-lab">Export lab</button><label class="import-label">Import lab<input id="lab-file" class="scene-file" type="file" accept=".json,application/json"></label><button id="advanced">⚙ Components & wiring</button></div></div>
  <section class="experiment"><div><p class="eyebrow">CONTROLLER WORKBENCH</p><label>Program <select id="program" aria-label="Controller preset">${PROGRAMS.map(p => `<option value="${p.id}">${p.title}</option>`).join("")}</select></label><p id="program-note"></p></div><div class="experiment-actions"><button id="bench-check">Clear floor & run drive check</button><button id="show-code" class="quiet">Hide code</button><a href="#sensor-console">Sensor console ↓</a></div></section>
  <div class="workspace">
    <section class="world-column" aria-label="Robot world">
      <div class="stage"><canvas id="habitat" aria-label="Interactive Three.js robot habitat"></canvas><div class="view-tag">HABITAT / LIVE 3D</div><div class="stage-chip" id="motion-state">Paused · orbit to explore</div><div class="stage-controls"><button id="focus">Follow robot</button><button id="overview">Overview</button></div><div class="scale">7 × 7 m floor · grid spacing 20 cm</div><div class="stage-note">Drag to orbit · scroll to zoom · click to select</div></div>
      <div class="object-tools"><select id="object-kind" aria-label="Object to add"><option value="wall">Wall</option><option value="table">Table</option><option value="chair">Chair</option><option value="rock">Rock</option><option value="stone">Low stone</option><option value="bush">Bush</option><option value="tree">Tree</option><option value="water">Water</option></select><button id="add-object">＋ Add object</button><button id="add-room">＋ Room</button><button id="undo" class="quiet">Undo edit</button><span class="spacer"></span><small id="object-count"></small></div>
      <div class="sensors">
        <div class="card sensor-card"><div class="sensor-title">01 / CAMERA <span>160 × 120 · RGB565</span></div><canvas id="camera" class="camera-feed" width="160" height="120" aria-label="Low resolution ESP32 camera view"></canvas><small>OV2640-style colour capture at <span id="camera-rate">10</span> Hz. Lens height <span id="camera-height">6.5</span> cm.</small></div>
        <div class="card sensor-card"><div class="sensor-title">02 / FLY VISION <span id="retina-size">48 × 24</span></div><canvas id="fly-eye" class="fly-feed" width="288" height="144" aria-label="Actual camera pixels sent to the fly vision network"></canvas><div class="input-bars" id="input-bars"></div><small id="perception-note">Colour image → estimates → spiking brain. Loading eyes…</small><div class="neural-labels"><span>LEFT</span><span>INPUT ACTIVITY</span><span>RIGHT</span></div></div>
        <div class="card sensor-card map-card"><div><div class="sensor-title">03 / ROOM MEMORY <span>512 KENYON CELLS</span></div><canvas id="room-map" width="240" height="180" aria-label="Sensor-derived room map and estimated robot position"></canvas></div><div><small>Estimated map from sonar + wheel commands. Amber: uncertain echoes. Green: traversed rays. Position drifts.</small><div class="memory-row"><span id="memory-count">0 cells learned</span><span id="memory-recall">No recall yet</span></div></div></div>
      </div>
    </section>
    <aside class="sidebar">
      <section class="card"><div class="card-head"><h2>The fly's brain</h2><span>17 / 19 → 48 → 4</span></div><p id="brain-name" class="brain-name">Loading bundled world brain…</p><select id="drive-mode" class="drive-mode" aria-label="Robot control mode"><option value="fly">Fly controls the robot</option><option value="manual">Manual · WASD / arrow keys</option><option value="sketch">Sketch only · brain requests zero</option></select><div class="row"><label class="import-label">Import brain<input id="brain-file" class="scene-file" type="file" accept=".json,application/json"></label><button id="export-brain">Export brain</button></div><div id="spikes" class="spikes"></div><div class="neural-labels"><span>48 SPIKING NEURONS</span><span id="adapter">WORLD INPUTS</span></div><label class="check"><input id="memory-enabled" type="checkbox" checked> Kenyon visual memory + sonar map</label><div class="row"><button id="forget">Forget room</button><button id="restore-brain" class="quiet">Bundled brain</button></div><p id="brain-note" class="warning-label">Eyes trained in the old renderer; transfer to 3D is experimental.</p></section>
      <section class="card"><div class="card-head"><h2>HC-SR04 sonar</h2><span><span class="legend-dot"></span>FRONT BEAM</span></div><div class="sonar-readout"><strong id="range">—</strong><span id="range-unit">cm</span></div><p class="muted" style="font-size:11px" id="echo-note">No return is an unknown distance.</p><label class="check"><input id="beam-visible" type="checkbox" checked> Show approximate acoustic cone</label><div class="metrics"><div class="metric"><strong id="speed">0</strong><span>cm/s · actual motion</span></div><div class="metric"><strong id="hits">0</strong><span>contacts</span></div><div class="metric"><strong id="left-pwm">0</strong><span>left PWM</span></div><div class="metric"><strong id="right-pwm">0</strong><span>right PWM</span></div></div></section>
      <section class="card"><div class="card-head"><h2>Object inspector</h2><span>METRES</span></div><select id="object-list" class="select-object" aria-label="Selected world object"><option value="">Select an object…</option></select><div id="object-editor"><p class="inspector-empty">Click an object in the habitat to move, rotate or resize it. Tables and chairs have legs and real underside clearance.</p></div></section>
    </aside>
  </div>
  <p id="status" class="status" role="status" aria-live="polite">Preparing the habitat…</p>
  <details class="code-panel" open><summary><span id="sketch-file">drivetrain-check.ino</span><span>EDIT → APPLY → RUN</span></summary><div class="code-body"><div class="code-editor"><div class="editor-tools"><button id="apply-code" class="primary">✓ Apply code</button><button id="default-code">Fly bridge</button><button id="reflex-code">Sonar avoidance</button><label class="import-label">Open .ino<input id="ino-file" class="scene-file" type="file" accept=".ino,.txt"></label><button id="export-code">Save .ino</button></div><div class="notepad"><pre id="code-gutter" aria-hidden="true"></pre><div class="code-surface"><pre id="code-syntax" aria-hidden="true"></pre><textarea id="sketch" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Arduino controller code"></textarea></div></div><div class="editor-status"><p id="code-status" class="code-status" role="status"></p><span id="executing-line"></span></div></div><details class="code-help"><summary>Sketch API & virtual GPIO</summary><p><code>brainLeft()</code> / <code>brainRight()</code> read routed motor requests. Pin writes control the driver. <code>pulseIn()</code> needs a sonar trigger. <code>Serial.print()</code> / <code>Serial.println()</code> write to the console. <code>cameraFrame()</code> and <code>cameraMeanR/G/B()</code> expose camera statistics; the complete pixels appear in the camera panel.</p><p>Numeric variables, functions, if/else, arithmetic and delays are supported. User loops, arrays, libraries and pointers are unsupported. This bounded Arduino-style interpreter uses floating-point numbers and tick-based timing. Hardware deployment needs real sensor and brain adapters.</p><div id="pins" class="pin-monitor"></div></details></div></details>
  <section class="card console-panel" id="sensor-console"><div class="console-head"><div><p class="eyebrow">INSTRUMENTS</p><h2>Sensor & controller console</h2></div><div class="row"><select id="console-filter" aria-label="Console event type"><option value="all">All events</option>${["sonar", "camera", "brain", "serial", "check", "system"].map(k => `<option>${k}</option>`).join("")}</select><label class="check"><input id="log-enabled" type="checkbox" checked> Record</label><label class="check"><input id="log-follow" type="checkbox" checked> Follow</label><button id="clear-log">Clear</button><button id="export-log">Export log</button><button id="export-frame">Save camera PNG</button></div></div><div class="instrument-strip"><span id="camera-stats">Camera waiting</span><span id="brain-stats">No neural output yet</span><span id="run-reason">Paused · operator</span></div><div id="console-lines" role="log" aria-label="Sensor and Serial output"></div><small id="log-count">Bounded to the most recent 1,500 events. Camera logs contain frame statistics; PNG saves the complete delivered frame.</small><details class="noise-panel"><summary>Sensor noise & lighting <span id="noise-summary">No added noise</span></summary><div class="row"><label>Profile <select id="noise-preset"><option value="clean">No added noise</option><option value="mild">Mild noise</option><option value="harsh">Dim & unreliable</option><option value="custom">Custom</option></select></label><small>Noise changes the delivered camera pixels and sonar readings, including the fly's inputs. No-echo stays unknown; the HC-SR04 base model still includes echo uncertainty.</small></div><div id="noise-fields" class="advanced-fields"></div></details></section>
  <footer><span>26 × 17 cm chassis · 11.5 cm axle spacing · 65 mm wheels · 6.5 cm sensor mount</span><span>Physics & learning approximations · <a href="./docs/robot-habitat.html">Hardware notes & model limits ↗</a></span></footer>
</main>
<dialog id="pinout" class="pinout-dialog"><div class="dialog-head"><div><p class="eyebrow">HARDWARE / CONNECTIONS</p><h2>Pinout & wires</h2><p>Follow the wires from controller pins to the robot's components.</p></div><div class="row"><button id="export-wiring">Save SVG</button><button id="edit-pinout" class="primary">Edit connections</button><button id="close-pinout" aria-label="Close wiring diagram">✕</button></div></div><div id="pinout-diagram"></div></dialog>
<dialog id="hardware"><div class="dialog-head"><div><h2>Components & wiring</h2><p>Match the virtual robot to your build. Dimensions are in centimetres.</p></div><button id="close-hardware" aria-label="Close components window">✕</button></div>
  <div class="advanced-section"><h3>Chassis & drivetrain</h3><div class="advanced-fields" id="physics-fields"></div><small style="display:block;margin-top:12px">Four yellow 48:1 DC gearmotors, two paired per side. Differential skid steering; motor current and battery sag are not electrically simulated.</small></div>
  <div class="advanced-section"><h3>Camera & acoustic sensor</h3><div class="advanced-fields" id="sensor-fields"></div><div class="row"><label class="check"><input id="camera-enabled" type="checkbox" checked> Camera connected</label><label class="check"><input id="sonar-enabled" type="checkbox" checked> Sonar connected</label></div><small>HC-SR04: 2–400 cm nominal range, 10 µs trigger, ≈66 ms between samples. Echo depends on height, target size and incidence; water at floor level returns nothing. Lens FOV is an editable assumption.</small></div>
  <div class="advanced-section" id="connection-settings"><h3>Controller → L298N → motor pairs</h3><label>Controller board <select id="board"><option value="esp32-cam">ESP32-CAM · direct L298N</option><option value="uno">Legacy UNO pin profile · external camera bridge</option></select></label><div class="wiring-grid" id="wiring-fields" style="margin-top:14px"></div><div class="row" style="flex-wrap:wrap"><label class="check"><input id="common-ground" type="checkbox" checked> Shared ground</label><label class="check"><input id="echo-divider" type="checkbox" checked> ECHO level shifted to 3.3 V</label><label class="check"><input id="sd-card" type="checkbox"> SD interface active</label></div><details class="hardware-wiring-preview" open><summary>Wire diagram · pin preview</summary><div id="hardware-diagram"></div></details><div id="wiring-message" class="wiring-message"></div></div>
  <div class="advanced-section"><h3>Fly → motor adapter</h3><p class="routing-note">The imported brain exposes steer, drive, reverse and brake outputs. L1/L2/L3 and R1/R2/R3 below are named software leg adapters: each side duplicates one motor request. These checkpoints do not identify biological leg neurons.</p><div class="advanced-fields"><label>Steering<select id="route-steering"><option value="arc">Arc · steering follows drive</option><option value="pivot">Pivot · allow in-place turns</option></select></label><label>Turn gain<input id="route-gain" type="number" min="0" max="1" step=".05"></label><label>Maximum PWM<input id="route-pwm" type="number" min="0" max="255"></label><label>Left motors ←<select id="route-left">${["L1","L2","L3","R1","R2","R3"].map(k => `<option>${k}</option>`).join("")}</select></label><label>Right motors ←<select id="route-right">${["L1","L2","L3","R1","R2","R3"].map(k => `<option>${k}</option>`).join("")}</select></label><label class="check"><input id="route-invert-left" type="checkbox"> Reverse left polarity</label><label class="check"><input id="route-invert-right" type="checkbox"> Reverse right polarity</label></div><small>Left driver channel → front-left + rear-left. Right channel → front-right + rear-right. Apply to change routing; independent four-wheel control requires more driver channels.</small></div>
  <div class="advanced-section dialog-actions"><small>Applying pin changes does not rewrite your sketch. Use “Fly bridge” or update its pin constants to match. Invalid connections inhibit simulated motors.</small><button id="apply-hardware" class="primary">Apply components</button></div>
</dialog>`;

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
let floorColour = "#b7bea7", surfaceEvent = "", contactEvent = "";
let wiring: Wiring = { ...ESP_WIRING };
const physics = new RobotPhysics();
let sonar = new RobotSonar();
let memory = new RoomMemory();
let controller: SpikingNetwork | null = null;
let perceiver: Perceiver | null = null;
let brainDomain: "world" | "track" = "world";
let brainName = "Bundled robot world brain";
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
const history: { objects: WorldObject[]; floorColour: string }[] = [];
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

function validateObjects(raw: unknown): WorldObject[] {
  const kinds = OBJECT_TYPES.map(o => o.kind);
  if (!Array.isArray(raw) || raw.length > 200) throw new Error("A habitat must contain at most 200 objects.");
  const ids = new Set<string>();
  return raw.map(o => {
    if (!o || typeof o.id !== "string" || o.id.length > 100 || ids.has(o.id) || !kinds.includes(o.kind)) throw new Error("Invalid habitat object."); ids.add(o.id);
    if (![o.x, o.z, o.yaw, o.width, o.depth, o.height].every(Number.isFinite) || Math.abs(o.x) > 3.5 || Math.abs(o.z) > 3.5 || Math.abs(o.yaw) > Math.PI * 100 || o.width < .02 || o.width > 6 || o.depth < .02 || o.depth > 6 || o.height < .002 || o.height > 4) throw new Error("Object position or dimensions are out of range.");
    return { id: o.id, kind: o.kind, x: o.x, z: o.z, yaw: o.yaw, width: o.width, depth: o.depth, height: o.height };
  });
}
const PHYSICS_FIELDS: [keyof RobotConfig, string, number, number, number][] = [
  ["length", "Total length · cm", 10, 60, 100], ["width", "Outside wheel width · cm", 8, 40, 100], ["wheelbase", "Axle centre spacing · cm", 5, 40, 100], ["mountHeight", "Sensor lens height · cm", 3, 30, 100],
  ["wheelDiameter", "Wheel diameter · cm", 3, 15, 100], ["wheelWidth", "Wheel width · cm", 1, 6, 100], ["rpm", "RPM at 6 V · 100–240", 100, 240, 1], ["voltage", "Motor supply · V", 3, 9, 1],
  ["bridgeDrop", "L298N total drop · V", 0, 4, 1], ["turnGrip", "Skid turn response", .2, 1, 1], ["deadband", "PWM start deadband", 0, .6, 1],
];
const SENSOR_FIELDS: [keyof RobotConfig, string, number, number, number][] = [["cameraFov", "Horizontal FOV · degrees", 30, 120, 1], ["cameraPitch", "Downward tilt · degrees", -15, 40, 1], ["cameraHz", "Camera capture · Hz", 1, 15, 1], ["sonarBeam", "Useful beam · degrees", 8, 30, 1]];
const ALL_FIELDS = [...PHYSICS_FIELDS, ...SENSOR_FIELDS];
function validateConfig(raw: unknown): RobotConfig {
  const r = raw as RobotConfig;
  if (!r || typeof r.cameraEnabled !== "boolean" || typeof r.sonarEnabled !== "boolean") throw new Error("Invalid component settings.");
  const config = { ...DEFAULT_ROBOT, cameraEnabled: r.cameraEnabled, sonarEnabled: r.sonarEnabled };
  for (const [key, , min, max, scale] of ALL_FIELDS) { const n = r[key]; if (typeof n !== "number" || !Number.isFinite(n) || n * scale < min - 1e-8 || n * scale > max + 1e-8) throw new Error(`Invalid ${key}.`); Object.assign(config, { [key]: n }); }
  if (config.wheelbase > config.length || config.wheelWidth * 2 >= config.width) throw new Error("Wheel spacing and width must fit the chassis.");
  return config;
}
function validateWiring(raw: unknown): Wiring {
  const w = raw as Wiring;
  if (!w || !["esp32-cam", "uno"].includes(w.board) || ["commonGround", "echoDivider", "sdCard"].some(k => typeof w[k as keyof Wiring] !== "boolean")) throw new Error("Invalid wiring profile.");
  if ([w.in1, w.in2, w.in3, w.in4, w.ena, w.enb, w.trig, w.echo].some(n => !Number.isInteger(n) || n < -1 || n > 39)) throw new Error("Invalid pin number.");
  return { board: w.board, in1: w.in1, in2: w.in2, in3: w.in3, in4: w.in4, ena: w.ena, enb: w.enb, trig: w.trig, echo: w.echo, commonGround: w.commonGround, echoDivider: w.echoDivider, sdCard: w.sdCard };
}

function validateFloor(raw: unknown): string { if (raw === undefined) return "#b7bea7"; if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/i.test(raw)) throw new Error("Invalid floor colour."); return raw; }
function updateFloor(): void { scene.setFloorColour(floorColour); el<HTMLInputElement>("floor-colour").value = floorColour; }
function saveLocal(): void {
  try { localStorage.setItem("flykart-robot-habitat-v1", JSON.stringify({ objects, floorColour, config: physics.config, wiring, sketch: firmware.source, program: appliedProgram, mode: value("drive-mode"), adapter: adapterConfig, noise: noiseConfig })); }
  catch { message("Browser storage is unavailable. Export lab to keep your work.", true); }
}
function restoreLocal(): void {
  try {
    const text = localStorage.getItem("flykart-robot-habitat-v1"); if (!text) return;
    const data = JSON.parse(text), nextObjects = validateObjects(data.objects), config = validateConfig(data.config), nextWiring = validateWiring(data.wiring), nextFirmware = new Firmware(data.sketch);
    floorColour = validateFloor(data.floorColour); objects = nextObjects; physics.config = config; wiring = nextWiring; firmware = nextFirmware; el<HTMLTextAreaElement>("sketch").value = firmware.source;
    adapterConfig = validateAdapter(data.adapter ?? DEFAULT_ADAPTER); noiseConfig = validateNoise(data.noise ?? DEFAULT_NOISE); noise = new NoiseSource(noiseConfig);
    program = appliedProgram = PROGRAMS.some(p => p.id === data.program) ? data.program : "custom";
    el<HTMLSelectElement>("drive-mode").value = ["fly", "manual", "sketch"].includes(data.mode) ? data.mode : "sketch";
  } catch { message("Saved habitat could not be restored; using the workshop preset.", true); }
}
function editWorld(): void { history.push({ objects: structuredClone(objects), floorColour }); if (history.length > 30) history.shift(); }
function worldChanged(): void {
  scene.rebuildObjects(objects); updateFloor(); scene.select(selected); populateObjects(); memory = new RoomMemory(); saveLocal();
  captureTime = -Infinity; sonar = new RobotSonar();
}
function populateObjects(): void {
  const list = el<HTMLSelectElement>("object-list"); list.replaceChildren(new Option("Select an object…", ""));
  objects.forEach((o, i) => list.add(new Option(`${String(i + 1).padStart(2, "0")} / ${o.kind}`, o.id))); list.value = selected ?? "";
  setText("object-count", `${objects.length} objects / 200 max`);
}
function selectObject(id: string | null): void {
  selected = id; scene.select(id); el<HTMLSelectElement>("object-list").value = id ?? "";
  const o = objects.find(o => o.id === id), editor = el("object-editor");
  if (!o) { editor.innerHTML = '<p class="inspector-empty">Select an object to move, rotate or resize it. All dimensions are in metres.</p>'; return; }
  editor.innerHTML = `<div class="form-grid">${(["x", "z", "yaw", "width", "depth", "height"] as const).map(k => `<label>${k === "yaw" ? "Rotation · degrees" : k}<input data-property="${k}" type="number" step="${k === "yaw" ? "5" : ".05"}" value="${k === "yaw" ? (o[k] * 180 / Math.PI).toFixed(1) : o[k].toFixed(3)}"></label>`).join("")}</div><button id="remove-object" class="full quiet" style="margin-top:12px">Remove ${o.kind}</button>`;
  const note = document.createElement("p"); note.className = "object-hint";
  note.textContent = o.kind === "cable" || o.kind === "doormat" ? traversable(o, physics.config) ? `${o.kind === "cable" ? "Drive-over caution: possible cable snag; simulated speed reduced 25%." : "Traversable mat: simulated speed reduced 15%."} Low-profile limit ${Math.min(.012, physics.config.wheelDiameter * .2) * 100} cm. No wheel-climbing or tangling physics.` : "Too tall to drive over in this model; this object blocks the chassis." : ["table", "chair", "bed"].includes(o.kind) ? `Underneath clearance: ${((o.kind === "bed" ? o.height * .32 : (o.kind === "table" ? o.height : o.height * .55) - .045) * 100).toFixed(1)} cm. Chassis envelope: ${((physics.config.mountHeight + .04) * 100).toFixed(1)} cm. Legs still block movement.` : "Contact follows the visible solid shape at chassis height. The selection box shows overall dimensions.";
  editor.append(note);
  editor.querySelectorAll<HTMLInputElement>("input").forEach(input => input.addEventListener("change", () => safe(() => {
    const property = input.dataset.property as keyof WorldObject; const n = Number(input.value) * (property === "yaw" ? Math.PI / 180 : 1);
    const updated = { ...o, [property]: n }; validateObjects([updated]); editWorld(); Object.assign(o, updated); worldChanged(); selectObject(o.id);
  })));
  button("remove-object", () => { editWorld(); objects = objects.filter(item => item.id !== id); selected = null; worldChanged(); selectObject(null); });
}

function initializeHardware(): void {
  const fields = (list: typeof ALL_FIELDS) => list.map(([key, label, min, max]) => `<label>${label}<input id="component-${key}" type="number" min="${min}" max="${max}" step="${key === "rpm" ? 1 : .1}"></label>`).join("");
  el("physics-fields").innerHTML = fields(PHYSICS_FIELDS); el("sensor-fields").innerHTML = fields(SENSOR_FIELDS);
  el("wiring-fields").innerHTML = (["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo"] as const).map(key => `<label>${key.toUpperCase()} → GPIO<input id="wire-${key}" type="number" min="-1" max="39" step="1"></label>`).join("");
  el("hardware").querySelectorAll("input,select").forEach(input => input.addEventListener("input", () => safe(() => previewWiring(readWiring()))));
}
function fillHardware(): void {
  el<HTMLInputElement>("route-steering").value = adapterConfig.steering; el<HTMLInputElement>("route-gain").value = String(adapterConfig.turnGain); el<HTMLInputElement>("route-pwm").value = String(adapterConfig.maxPWM);
  el<HTMLInputElement>("route-left").value = adapterConfig.leftSource; el<HTMLInputElement>("route-right").value = adapterConfig.rightSource;
  el<HTMLInputElement>("route-invert-left").checked = adapterConfig.invertLeft; el<HTMLInputElement>("route-invert-right").checked = adapterConfig.invertRight;
  for (const [key, , , , scale] of ALL_FIELDS) el<HTMLInputElement>(`component-${key}`).value = String(Math.round(Number(physics.config[key]) * scale * 100) / 100);
  el<HTMLSelectElement>("board").value = wiring.board;
  for (const key of ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo"] as const) el<HTMLInputElement>(`wire-${key}`).value = String(wiring[key]);
  for (const [id, flag] of [["common-ground", wiring.commonGround], ["echo-divider", wiring.echoDivider], ["sd-card", wiring.sdCard], ["sonar-enabled", physics.config.sonarEnabled], ["camera-enabled", physics.config.cameraEnabled]] as [string, boolean][]) el<HTMLInputElement>(id).checked = flag;
  previewWiring(wiring);
}
function readWiring(): Wiring { return { board: value("board") as Wiring["board"], in1: Number(value("wire-in1")), in2: Number(value("wire-in2")), in3: Number(value("wire-in3")), in4: Number(value("wire-in4")), ena: Number(value("wire-ena")), enb: Number(value("wire-enb")), trig: Number(value("wire-trig")), echo: Number(value("wire-echo")), commonGround: check("common-ground"), echoDivider: check("echo-divider"), sdCard: check("sd-card") }; }
function previewWiring(w: Wiring): void {
  const voltage = Number(value("component-voltage"));
  const c = { ...physics.config, voltage: Number.isFinite(voltage) && voltage > 0 ? voltage : physics.config.voltage, cameraEnabled: check("camera-enabled"), sonarEnabled: check("sonar-enabled") };
  const draft = JSON.stringify(w) !== JSON.stringify(wiring) || c.voltage !== physics.config.voltage || c.cameraEnabled !== physics.config.cameraEnabled || c.sonarEnabled !== physics.config.sonarEnabled;
  hardwareDiagram.update(w, c, draft);
  const issues = wiringIssues(w); const box = el("wiring-message"); box.replaceChildren();
  for (const [text, error] of [...issues.errors.map(s => [s, true] as const), ...issues.notes.map(s => [s, false] as const)]) { const p = document.createElement("p"); p.textContent = text; p.className = error ? "problem" : ""; box.append(p); }
}
function hardwareChanged(): void { scene.rebuildRobot(physics.config); physics.left = physics.right = 0; sonar = new RobotSonar(); memory = new RoomMemory(); captureTime = -Infinity; firmware = new Firmware(firmware.source); saveLocal(); }

function log(kind: EventKind, text: string, data?: unknown): void { if (check("log-enabled")) consoleLog.push(simTime, kind, text, data); }
function setRunning(next: boolean, reason = "operator"): void { if (running !== next) log("system", next ? "Simulation running" : `Simulation paused: ${reason}`); running = next; pauseReason = reason; el("run").textContent = running ? "Ⅱ Pause simulation" : "▶ Run simulation"; }
function resetRobot(): void { setRunning(false); physics.reset(); sonar = new RobotSonar(); noise = new NoiseSource(noiseConfig); driveCheck = new DrivetrainCheck(); phaseIndex = -1; controller?.reset(); perceiver?.reset(); action = { steer: 0, throttle: 0, brake: 0 }; requests = motorRequests(action, adapterConfig); estimates.fill(0); sensors.fill(0); simTime = 0; cameraFrame = 0; neuralLogTime = -Infinity; captureTime = -Infinity; actualPWM = [0, 0]; firmware = new Firmware(firmware.source); keys.clear(); log("system", "Robot and program clock reset; room memory retained"); }
function applyCode(source: string): void {
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
function fillNoise(): void { for (const [key] of NOISE_FIELDS) el<HTMLInputElement>(`noise-${key}`).value = String(noiseConfig[key]); el<HTMLInputElement>("noise-preset").value = Object.entries(NOISE_PRESETS).find(([, profile]) => NOISE_FIELDS.every(([key]) => profile[key] === noiseConfig[key]))?.[0] ?? "custom"; setText("noise-summary", `Camera σ ${noiseConfig.cameraSigma} · echo σ ${noiseConfig.sonarSigmaCm} cm · light ×${noiseConfig.brightness}`); }
function applyNoise(next: SensorNoise): void { noiseConfig = validateNoise(next); noise = new NoiseSource(noiseConfig); captureTime = -Infinity; fillNoise(); log("system", "Sensor noise changed", noiseConfig); saveLocal(); }
function initializeInstruments(): void {
  el("noise-fields").innerHTML = NOISE_FIELDS.map(([key, title, min, max, step]) => `<label>${title}<input id="noise-${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join("");
  el("noise-fields").addEventListener("change", () => safe(() => { const config = Object.fromEntries(NOISE_FIELDS.map(([key]) => [key, Number(value(`noise-${key}`))])) as SensorNoise; applyNoise(config); el<HTMLInputElement>("noise-preset").value = "custom"; }));
  el("noise-preset").addEventListener("change", () => { const config = NOISE_PRESETS[value("noise-preset")]; if (config) applyNoise({ ...config }); });
  el("program").addEventListener("change", () => chooseProgram(value("program") as ProgramId));
  button("bench-check", () => { editWorld(); objects = preset("empty"); selected = null; worldChanged(); selectObject(null); el<HTMLInputElement>("preset").value = "empty"; chooseProgram("sequence"); resetRobot(); setRunning(true); message("Drive check running on an empty floor. It repeats until you pause. Undo edit restores the previous habitat."); });
  button("bench-current", () => { const start = { ...physics.pose }; chooseProgram("sequence"); resetRobot(); physics.pose = start; physics.odometry = { ...start }; setRunning(true); message("Drive check running from the current pose with this room intact. This fixed sequence reports obstacles as contacts; Explore with sonar uses avoidance instead."); });
  button("survey-room", () => { const start = { ...physics.pose }; chooseProgram("avoid"); resetRobot(); physics.pose = start; physics.odometry = { ...start }; setRunning(true); message("Sonar avoidance running in this habitat. The forward sensor can miss low, weak or angled objects; inspect contacts and the camera."); });
  button("show-code", () => { const hidden = workbench.classList.toggle("code-hidden"); el("show-code").textContent = hidden ? "Show code" : "Hide code"; });
  button("clear-log", () => { consoleLog.clear(); consoleRevision = -1; });
  el("console-filter").addEventListener("change", () => { consoleRevision = -1; });
  button("export-log", () => download("robot-sensor-log.json", JSON.stringify({ format: "flykart-robot-log", noise: noiseConfig, adapter: adapterConfig, sketch: firmware.source, events: consoleLog.events }, null, 2)));
  button("export-frame", () => { el<HTMLCanvasElement>("camera").toBlob(blob => { if (!blob) return; const a = document.createElement("a"), url = URL.createObjectURL(blob); a.href = url; a.download = `camera-frame-${cameraFrame}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); }); });
  fillNoise(); programInfo();
}
function installBrain(text: string): void {
  const imported = importFile(text);
  if (!imported.controller) throw new Error("Import a controller or combined vision brain, not just an eye network.");
  const usingWorld = !!imported.world;
  const snapshot = usingWorld ? imported.world!.controller.snapshot : imported.controller.snapshot;
  const nextDomain = usingWorld ? "world" : imported.controller.domain;
  const model = (usingWorld ? imported.world!.vision : imported.vision) ?? eyes[nextDomain];
  if (!model) throw new Error("A matching vision network is required for this brain.");
  const nextPerceiver = validateEyes(model, nextDomain);
  const nextController = SpikingNetwork.fromJSON(snapshot);
  controller = nextController; perceiver = nextPerceiver; brainDomain = nextDomain; brainName = imported.name; estimates = new Float32Array(perceiver.estimateCount); sensors = new Array(controller.inputCount).fill(0);
  captureTime = -Infinity; memory = new RoomMemory(); setText("brain-name", brainName); setText("adapter", `${brainDomain.toUpperCase()} INPUTS`);
  setText("brain-note", brainDomain === "track" ? "Track input meanings retained. A racing brain may not navigate a room; room recall is off." : "Eyes trained in the old renderer; transfer to 3D is experimental.");
  message(`Imported ${brainName}. ${imported.warnings.join(" ")}`);
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
  const base = import.meta.env.BASE_URL;
  const paths = ["vision/robot/world-controller.json", "vision/robot/world-vision-net.json", "vision/robot/vision-net.json"];
  const [brain, worldEyes, trackEyes] = await Promise.all(paths.map(async p => { const r = await fetch(`${base}${p}`); if (!r.ok) throw new Error(`Cannot load ${p}`); return r.text(); }));
  const worldModel = JSON.parse(worldEyes) as VisionModel, trackModel = JSON.parse(trackEyes) as VisionModel;
  validateEyes(worldModel, "world"); validateEyes(trackModel, "track"); eyes.world = worldModel; eyes.track = trackModel;
  installBrain(brain); brainName = "Bundled robot world brain"; setText("brain-name", brainName);
}

function capture(): void {
  scene.updateRobot(physics.pose, physics.config, check("beam-visible"), physics.left, physics.right, 0);
  const width = perceiver?.model.spec.width ?? 48, height = perceiver?.model.spec.height ?? 24;
  const frame = scene.capture(width, height, physics.config.cameraEnabled, noise);
  cameraFrame++; cameraRGB = frame.rgb; cameraDropped = frame.dropped;
  log("camera", `Frame ${cameraFrame} · 160×120 RGB565 · mean RGB ${cameraRGB.map(n => Math.round(n)).join(",")} · ${cameraDropped ? "missing/black frame" : "delivered"}`, { frame: cameraFrame, rgb: cameraRGB, dropped: cameraDropped });
  setText("retina-size", `${width} × ${height}`);
  const body = neuralBody();
  if (perceiver && physics.config.cameraEnabled) estimates.set(perceiver.see(frame.planar, body).mean); else estimates.fill(0);
  if (brainDomain === "world" && physics.config.sonarEnabled) estimates[4] = Math.max(estimates[4], sonar.closeness);
  if (check("memory-enabled") && brainDomain === "world" && physics.config.cameraEnabled && perceiver) {
    const remembered = memory.observe(frame.features, estimates);
    if (remembered) for (let k = 0; k < estimates.length; k++) estimates[k] = estimates[k] * .8 + remembered[k] * .2;
  }
  if (controller) {
    if (brainDomain === "world") worldDomain.sensors(estimates, [0, 0], body, sensors);
    else sensorsFromEstimates(estimates, body, sensors);
    if (controller.inputCount > 17) { sensors[17] = sonar.closeness; sensors[18] = +sonar.reading.echo; }
  }
  captureTime = simTime;
}
function neuralBody() { return { speed: clamp((physics.left + physics.right) / 2 / .99, -1, 1), lastSteer: action.steer, lastDrive: action.throttle - (action.reverse ?? 0), sonarCloseness: sonar.closeness, sonarStrength: +sonar.reading.echo }; }
function tick(): void {
  const dt = 1 / 30; simTime += dt;
  if (sonar.update(simTime, physics.pose, objects, physics.config, noise)) {
    log("sonar", sonar.reading.echo ? `${(sonar.metres * 100).toFixed(1)} cm · ECHO ${Math.round(sonar.pulseMicroseconds)} µs` : "No echo · distance unknown", { cm: sonar.reading.echo ? sonar.metres * 100 : null, echoUs: sonar.pulseMicroseconds });
    if (check("memory-enabled") && physics.config.sonarEnabled) memory.mapPing(physics.odometry, physics.config.length * .48, sonar.metres, sonar.reading.echo);
  }
  if (simTime - captureTime >= 1 / physics.config.cameraHz - 1e-8) capture();
  if (controller) {
    if (brainDomain === "world") worldDomain.sensors(estimates, [0, 0], neuralBody(), sensors); else sensorsFromEstimates(estimates, neuralBody(), sensors);
    if (controller.inputCount > 17) { sensors[17] = sonar.closeness; sensors[18] = +sonar.reading.echo; }
    action = controller.step(sensors);
  }
  requests = motorRequests(action, adapterConfig);
  let demands: [number, number] = [requests.left, requests.right];
  const mode = value("drive-mode");
  if (mode === "manual") {
    const forward = +(keys.has("w") || keys.has("ArrowUp")) - +(keys.has("s") || keys.has("ArrowDown"));
    const steer = +(keys.has("d") || keys.has("ArrowRight")) - +(keys.has("a") || keys.has("ArrowLeft"));
    demands = [clamp(forward * .65 + steer * .5, -1, 1) * 255, clamp(forward * .65 - steer * .5, -1, 1) * 255];
  } else if (mode === "sketch") demands = [0, 0];
  try {
    firmware.tick({ timeMs: simTime * 1000, brainLeft: demands[0], brainRight: demands[1], echoUs: sonar.pulseMicroseconds, wiring, camera: { frame: cameraFrame, rgb: cameraRGB }, log: line => log("serial", line), sonarRead: pulse => log("serial", `pulseIn(ECHO) → ${Math.round(pulse)} µs`), phase: index => {
      phaseIndex = index;
      if (appliedProgram !== "sequence") return;
      const result = driveCheck.observe(index, physics.pose, physics.collisions);
      if (result) log("check", `${result.passed ? "PASS" : "CHECK"} · ${result.title} · ${result.distanceCm.toFixed(1)} cm · ${result.yawDeg.toFixed(1)}° · ${result.contacts} contacts`, result);
    } });
    actualPWM = wiringIssues(wiring).errors.length ? [0, 0] : firmware.motors(wiring);
    physics.step(...actualPWM, objects, dt);
    const contact = physics.contact ? `${physics.contact.objectId}/${physics.contact.part}` : "";
    if (contact && contact !== contactEvent) log("system", `Contact · ${physics.contact!.part} · motion blocked`, physics.contact); contactEvent = contact;
    const surface = physics.surface?.objectId ?? "";
    if (surface && surface !== surfaceEvent) log("system", physics.surface!.kind === "cable" ? "Crossing loose cable · snag caution · traction approximation −25%" : "Crossing doormat · traction approximation −15%", physics.surface); surfaceEvent = surface;
  } catch (error) { actualPWM = [0, 0]; physics.left = physics.right = 0; setRunning(false, "sketch error"); codeMessage(error instanceof Error ? error.message : String(error), true); message("Controller code stopped. Fix the sketch and apply it again.", true); }
  if (simTime - neuralLogTime >= .2) { neuralLogTime = simTime; log("brain", `steer ${action.steer.toFixed(2)} · drive ${action.throttle.toFixed(2)} · reverse ${(action.reverse ?? 0).toFixed(2)} · brake ${action.brake.toFixed(2)} | request ${demands.map(Math.round).join(" / ")} → PWM ${actualPWM.map(n => Math.round(n * 255)).join(" / ")}`, { mode, action: { ...action }, inputs: [...sensors], estimates: [...estimates], legs: requests.legs, requests: demands, pwm: actualPWM.map(n => n * 255) }); }
  scene.updateRobot(physics.pose, physics.config, check("beam-visible"), physics.left, physics.right, dt);
}

function renderMap(): void {
  const canvas = el<HTMLCanvasElement>("room-map"), ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#142228"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = 23, originX = canvas.width / 2, originY = canvas.height / 2;
  ctx.strokeStyle = "#26383d"; ctx.lineWidth = 1;
  for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(originX + i * scale, 0); ctx.lineTo(originX + i * scale, canvas.height); ctx.moveTo(0, originY + i * scale); ctx.lineTo(canvas.width, originY + i * scale); ctx.stroke(); }
  for (const [key, occupancy] of memory.map) { const [x, z] = key.split(",").map(Number); ctx.fillStyle = occupancy > 0 ? `rgba(233,186,115,${Math.min(.9, occupancy / 3 + .2)})` : "#466c5d"; ctx.fillRect(originX + x * .1 * scale, originY + z * .1 * scale, 3, 3); }
  const p = physics.odometry; ctx.save(); ctx.translate(originX + p.x * scale, originY + p.z * scale); ctx.rotate(p.heading); ctx.fillStyle = "#d4e7de"; ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.fillStyle = "#8fa6a7"; ctx.font = "9px system-ui"; ctx.fillText("DEAD RECKONING / 1 m GRID", 9, 14);
}
function telemetry(): void {
  if (el<HTMLDialogElement>("pinout").open) pinoutDiagram.live(firmware.pins, sonar.pulseMicroseconds);
  setText("executing-line", `Ln ${firmware.currentLine} · ${value("drive-mode").toUpperCase()}`);
  setText("run-reason", running ? "Running · autonomous modes keep running on focus loss" : `Paused · ${pauseReason}`);
  setText("camera-stats", `Frame ${cameraFrame} · mean RGB ${cameraRGB.map(Math.round).join(" / ")}${cameraDropped ? " · MISSING" : ""}`);
  setText("brain-stats", `Steer ${action.steer.toFixed(2)} · Drive ${action.throttle.toFixed(2)} · Brake ${action.brake.toFixed(2)} · Reverse ${(action.reverse ?? 0).toFixed(2)}`);
  setText("motor-routing", `${adapterConfig.leftSource} → LEFT front + rear  ${Math.round(requests.left)}\n${adapterConfig.rightSource} → RIGHT front + rear  ${Math.round(requests.right)}\n${adapterConfig.steering.toUpperCase()} · software leg adapters · ±${adapterConfig.maxPWM} PWM`);
  for (const key of ["steer", "throttle", "reverse", "brake"] as const) { el<HTMLMeterElement>(`output-${key}`).value = action[key] ?? 0; setText(`output-value-${key}`, (action[key] ?? 0).toFixed(2)); }
  setText("motor-note", value("drive-mode") !== "fly" ? "Fly outputs are observed; this preset uses its own motor requests." : !running ? "Simulation paused. Run or Step to execute the fly and sketch." : Math.max(...actualPWM.map(Math.abs)) < physics.config.deadband ? "Motor PWM below start threshold. Inspect drive/brake outputs or try the drive-check preset." : "Fly requests pass through your sketch; paired wheels share each driver channel.");
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
  button("run", () => setRunning(!running)); button("step", () => { setRunning(false, "stepped simulation"); for (let i = 0; i < Number(value("step-size")); i++) tick(); telemetry(); }); button("reset", resetRobot);
  button("focus", () => { following = !following; if (following) scene.focus(physics.pose); el("focus").textContent = following ? "Unfollow robot" : "Follow robot"; });
  button("overview", () => { following = false; el("focus").textContent = "Follow robot"; scene.overview(); });
  el("preset").addEventListener("change", () => { editWorld(); objects = preset(value("preset")); floorColour = ROOM_TYPES.find(r => r.id === value("preset"))?.floor ?? "#b7bea7"; selected = null; worldChanged(); selectObject(null); resetRobot(); message("Habitat replaced. Room memory cleared; Undo edit restores the previous layout and floor colour."); });
  el("floor-colour").addEventListener("input", () => { floorColour = validateFloor(value("floor-colour")); updateFloor(); captureTime = -Infinity; });
  el("floor-colour").addEventListener("change", saveLocal);
  el("collision-visible").addEventListener("change", () => scene.showContacts(check("collision-visible")));
  button("add-object", () => { if (objects.length >= 200) { message("The habitat limit is 200 objects.", true); return; } editWorld(); const o = makeObject(value("object-kind") as ObjectKind, clamp(physics.pose.x + Math.cos(physics.pose.heading) * .75, -3, 3), clamp(physics.pose.z + Math.sin(physics.pose.heading) * .75, -3, 3)); objects.push(o); selected = o.id; worldChanged(); selectObject(o.id); });
  button("add-room", () => { if (objects.length > 196) { message("Four free object slots are needed for a room.", true); return; } editWorld(); const x = .5, z = .5; objects.push(...[{ x, z: z - .8, width: 1.6 }, { x: x - .8, z, width: 1.6, yaw: Math.PI / 2 }, { x: x + .8, z, width: 1.6, yaw: Math.PI / 2 }, { x: x + .45, z: z + .8, width: .7 }].map(p => ({ ...makeObject("wall"), ...p, height: .8 }))); worldChanged(); message("Added a 1.6 m room with a doorway. Select its walls to adjust dimensions."); });
  button("undo", () => { const previous = history.pop(); if (previous) { objects = previous.objects; floorColour = previous.floorColour; selected = null; worldChanged(); selectObject(null); } });
  el("object-list").addEventListener("change", () => selectObject(value("object-list") || null));
  const canvas = el("habitat"); let downX = 0, downY = 0;
  canvas.addEventListener("pointerdown", e => { downX = e.clientX; downY = e.clientY; }); canvas.addEventListener("pointerup", e => { if (Math.hypot(e.clientX - downX, e.clientY - downY) < 4) selectObject(scene.pick(e.clientX, e.clientY)); });
  button("advanced", () => { fillHardware(); el<HTMLDialogElement>("hardware").showModal(); }); button("close-hardware", () => el<HTMLDialogElement>("hardware").close());
  const pinoutButton = document.createElement("button"); pinoutButton.id = "show-pinout"; pinoutButton.textContent = "Pinout & wires"; el("advanced").before(pinoutButton);
  button("show-pinout", () => { pinoutDiagram.update(wiring, physics.config); pinoutDiagram.live(firmware.pins, sonar.pulseMicroseconds); el<HTMLDialogElement>("pinout").showModal(); });
  button("close-pinout", () => el<HTMLDialogElement>("pinout").close());
  button("export-wiring", () => download("robot-wiring.svg", pinoutDiagram.exportSvg(), "image/svg+xml"));
  button("edit-pinout", () => { el<HTMLDialogElement>("pinout").close(); fillHardware(); el<HTMLDialogElement>("hardware").showModal(); el("connection-settings").scrollIntoView({ block: "start" }); });
  el("board").addEventListener("change", () => { const profile = value("board") === "uno" ? UNO_WIRING : ESP_WIRING; for (const key of ["in1", "in2", "in3", "in4", "ena", "enb", "trig", "echo"] as const) el<HTMLInputElement>(`wire-${key}`).value = String(profile[key]); el<HTMLInputElement>("echo-divider").checked = profile.echoDivider; previewWiring(readWiring()); });
  button("apply-hardware", () => safe(() => { const config = { ...physics.config }; for (const [key, , , , scale] of ALL_FIELDS) Object.assign(config, { [key]: Number(value(`component-${key}`)) / scale }); config.cameraEnabled = check("camera-enabled"); config.sonarEnabled = check("sonar-enabled"); const nextConfig = validateConfig(config), nextWiring = validateWiring(readWiring()), nextAdapter = validateAdapter({ steering: value("route-steering"), turnGain: Number(value("route-gain")), maxPWM: Number(value("route-pwm")), leftSource: value("route-left"), rightSource: value("route-right"), invertLeft: check("route-invert-left"), invertRight: check("route-invert-right") }); physics.config = nextConfig; wiring = nextWiring; adapterConfig = nextAdapter; setRunning(false); hardwareChanged(); el<HTMLDialogElement>("hardware").close(); message("Components and motor routing applied. Update sketch constants if you changed GPIO pins."); }));
  button("apply-code", () => applyCode(value("sketch"))); button("default-code", () => chooseProgram("fly")); button("reflex-code", () => chooseProgram("avoid"));
  el("drive-mode").addEventListener("change", () => { log("system", `Motor request source: ${value("drive-mode")}`); saveLocal(); });
  el("sketch").addEventListener("input", () => codeMessage("Unapplied changes · click Apply & restart code"));
  el("sketch").addEventListener("keydown", event => { if (event instanceof KeyboardEvent && event.key === "Tab") { event.preventDefault(); const editor = el<HTMLTextAreaElement>("sketch"); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); editor.dispatchEvent(new Event("input")); } });
  button("export-code", () => download("robot-controller.ino", value("sketch"), "text/plain"));
  button("forget", () => { memory = new RoomMemory(); message("Forgot the room's learned visual cells and sonar map."); });
  el("memory-enabled").addEventListener("change", () => { if (!check("memory-enabled")) memory.recalled = false; });
  button("export-brain", () => { if (controller) download("robot-flykart-brain.json", JSON.stringify(controllerCheckpoint(controller, { domain: brainDomain }), null, 2)); });
  button("restore-brain", () => { setRunning(false); void loadBundled().catch(error => message(String(error), true)); });
  button("save-lab", () => safe(() => download("robot-habitat.json", JSON.stringify({ format: "flykart-robot-lab", version: 1, savedAt: new Date().toISOString(), objects, floorColour, config: physics.config, wiring, sketch: value("sketch"), program: appliedProgram, mode: value("drive-mode"), adapter: adapterConfig, noise: noiseConfig, controller: controller ? controllerCheckpoint(controller, { domain: brainDomain }) : null, vision: perceiver?.model ?? null, memory: memory.toJSON() }, null, 2))));
  const file = (id: string, callback: (text: string) => void, max = 12000000) => el<HTMLInputElement>(id).addEventListener("change", async e => { const input = e.target as HTMLInputElement, upload = input.files?.[0]; if (!upload) return; if (upload.size > max) { message("File exceeds the size limit.", true); input.value = ""; return; } try { callback(await upload.text()); } catch (error) { message(error instanceof Error ? error.message : String(error), true); } input.value = ""; });
  file("brain-file", text => { setRunning(false); installBrain(text); });
  file("ino-file", text => { program = "custom"; customDraft = text; el<HTMLTextAreaElement>("sketch").value = text; programInfo(); codeMessage("Sketch opened. Click Apply code to run it."); }, 60000);
  file("lab-file", text => {
    const data = JSON.parse(text); if (data.format !== "flykart-robot-lab" || data.version !== 1) throw new Error("Expected a FlyKart robot lab file.");
    // Validate every component before mutating the current session.
    const nextObjects = validateObjects(data.objects), nextConfig = validateConfig(data.config), nextWiring = validateWiring(data.wiring), nextFirmware = new Firmware(data.sketch), nextMemory = RoomMemory.fromJSON(data.memory);
    const nextAdapter = validateAdapter(data.adapter ?? DEFAULT_ADAPTER), nextNoise = validateNoise(data.noise ?? DEFAULT_NOISE), nextFloor = validateFloor(data.floorColour);
    let nextBrain: SpikingNetwork | null = null, nextEyes: Perceiver | null = null, nextDomain: "world" | "track" = "world";
    if (data.controller) { const parsed = importFile(JSON.stringify(data.controller)); nextDomain = parsed.controller!.domain; nextBrain = SpikingNetwork.fromJSON(parsed.controller!.snapshot); if (data.vision) nextEyes = validateEyes(data.vision, nextDomain); }
    editWorld(); objects = nextObjects; floorColour = nextFloor; physics.config = nextConfig; wiring = nextWiring; controller = nextBrain; perceiver = nextEyes; brainDomain = nextDomain; firmware = nextFirmware; el<HTMLTextAreaElement>("sketch").value = firmware.source;
    adapterConfig = nextAdapter; noiseConfig = nextNoise; program = appliedProgram = PROGRAMS.some(p => p.id === data.program) ? data.program : "custom"; el<HTMLSelectElement>("drive-mode").value = ["fly", "manual", "sketch"].includes(data.mode) ? data.mode : "sketch"; programInfo(); fillNoise();
    estimates = new Float32Array(nextEyes?.estimateCount ?? (nextDomain === "world" ? 10 : 13)); sensors = new Array(controller?.inputCount ?? 19).fill(0); selected = null; scene.rebuildObjects(objects); scene.rebuildRobot(physics.config); scene.select(null); populateObjects(); selectObject(null); resetRobot(); memory = nextMemory;
    updateFloor(); setText("brain-name", controller ? "Imported lab controller" : "No controller · use manual or sketch"); setText("adapter", `${brainDomain.toUpperCase()} INPUTS`); saveLocal(); message("Imported habitat, components, sketch, brain and learned memory. Robot reset to its starting pose.");
  });
  const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.matches("input,textarea,select") || target.isContentEditable);
  window.addEventListener("keydown", e => { if (!editable(e.target) && !el<HTMLDialogElement>("hardware").open && !el<HTMLDialogElement>("pinout").open && ["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) { if (value("drive-mode") === "manual") e.preventDefault(); keys.add(e.key); } });
  window.addEventListener("keyup", e => keys.delete(e.key)); window.addEventListener("blur", () => { keys.clear(); if (value("drive-mode") === "manual") { actualPWM = [0, 0]; physics.left = physics.right = 0; setRunning(false, "manual keyboard focus lost"); } });
}

async function main(): Promise<void> {
  restoreLocal();
  scene = new HabitatScene(el<HTMLCanvasElement>("habitat"), el<HTMLCanvasElement>("camera"), el<HTMLCanvasElement>("fly-eye")); scene.rebuildObjects(objects); scene.rebuildRobot(physics.config);
  updateFloor();
  el("spikes").innerHTML = Array.from({ length: 48 }, () => "<i></i>").join(""); populateObjects(); initializeHardware(); wireEvents(); initializeInstruments(); codeMessage("Applied sketch ready · edit, Apply, then Run");
  let previous = performance.now(), accumulator = 0, uiTime = 0;
  const frame = (now: number) => {
    try {
    const elapsed = Math.min((now - previous) / 1000, .2); previous = now;
    if (running) { accumulator += elapsed * Number(value("sim-rate")); while (accumulator >= 1 / 30 && running) { tick(); accumulator -= 1 / 30; } } else accumulator = 0;
    scene.updateRobot(physics.pose, physics.config, check("beam-visible"), 0, 0, 0);
    if (following) scene.controls.target.set(physics.pose.x, .06, physics.pose.z);
    if (simTime - captureTime >= 1 / physics.config.cameraHz || captureTime === -Infinity) capture();
    scene.render(); if (now - uiTime > 100) { telemetry(); uiTime = now; }
    } catch (error) { setRunning(false, "simulation error"); message(`Simulation paused: ${error instanceof Error ? error.message : error}`, true); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try { await loadBundled(); message("Ready. Start with Clear floor & run drive check, or choose a controller preset. Edit and Apply its code to change the machine."); }
  catch (error) { message(`Bundled brain unavailable: ${error instanceof Error ? error.message : error}. Manual and sketch control still work.`, true); }
}
void main().catch(error => { message(`Could not start the 3D habitat: ${error instanceof Error ? error.message : error}`, true); });
