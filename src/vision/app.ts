// FlyKart Vision: the page that wires the simulator, camera, fusion and lap memory to the DOM.
import "../style.css";
import "./vision.css";
import { BrainSnapshot, TRACKS } from "../core";
import { MushroomBody } from "./memory";
import { controllerCheckpoint, exportAsFlyKartV1, exportVisionBrain, importFile } from "./format";
import type { VisionModel } from "./perception";
import { DriverMode } from "./pipeline";
import { Assets, loadAssets } from "./ui/assets";
import { SonarView, drawBrain, drawEstimates, drawEye, drawKenyon, drawSonarTrace, drawTrace, drawTrackMap, drawWorldMap, estimateRows } from "./ui/draw";
import { renderEvidence } from "./ui/evidence";
import { HOW_IT_WORKS } from "./ui/how";
import { LapRecord, TrackSession, WorldDriverKind, WorldSession } from "./ui/sessions";
import { trackDomain, worldDomain } from "./domains";
import { proceduralTrack } from "./proceduralTracks";
import { CM_PER_PIXEL, KART_PROFILE, MOUNT, ROBOT, ROBOT_PROFILE, SensorProfile } from "./robot";

const $ = <T extends HTMLElement>(id: string): T => { const element = document.getElementById(id); if (!element) throw new Error(`missing element #${id}`); return element as T; };

type Imported = { name: string; snapshot: BrainSnapshot; info: string };

const state = {
  assets: null as Assets | null,
  imported: null as Imported | null,
  importedVision: null as VisionModel | null,
  importedWorld: null as { controller: BrainSnapshot; vision: VisionModel | null } | null,
  memory: new MushroomBody({ seed: 11 }),
  track: null as TrackSession | null,
  world: null as WorldSession | null,
  running: { track: false, world: false },
  lapsLeft: 0, lapNumber: 0, laps: [] as LapRecord[],
  fade: 0, mode: "belief" as DriverMode,
  tab: "track",
  profile: "kart" as "kart" | "robot", sonarOn: true,
  last: 0, accumulator: { track: 0, world: 0 },
};

/* ------------------------------- tabs ------------------------------- */

function showTab(name: string): void {
  state.tab = name;
  for (const id of ["track", "world", "evidence", "how"]) {
    const selected = id === name;
    $(`tab-${id}`).hidden = !selected;
    const button = $(`tab-btn-${id}`); button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected));
  }
  if (name === "world" && !state.world) buildWorld();
  if (state.assets) updateProfileUi();
  history.replaceState(null, "", `#${name}`);
}

/* ------------------------------- fading ------------------------------- */

/** Slider position 0..1 -> weight of the feeling channels: 0 is off, then a log scale from 0.001 to 1. */
const fadeFromSlider = (t: number): number => (t <= 0.001 ? 0 : t >= 0.99 ? 1e6 : Math.pow(10, -3 * (1 - t)));
const fadeLabel = (fade: number): string => (fade === 0 ? "seeing only" : fade >= 1e5 ? "feeling only" : fade < 0.05 ? `mostly seeing · feeling ×${fade.toFixed(3)}` : `both · feeling ×${fade.toFixed(2)}`);

function setFade(t: number): void {
  $<HTMLInputElement>("fade").value = String(t);
  state.fade = fadeFromSlider(t);
  $("fade-label").textContent = fadeLabel(state.fade);
  if (state.track) state.track.driver.fusion.fade = state.fade;
  updateModeNote();
}

function updateModeNote(): void {
  const mode = state.mode; const note = $("mode-note");
  note.textContent = mode === "belief"
    ? "Each number is weighted by how reliable its source has been: the camera’s own error estimate, the exact feeling channels (scaled by the slider), and the lap memory. Then the controller decides once."
    : mode === "action-average"
      ? "Runs a feeling-only brain and a camera brain side by side and averages their steering and pedals. When they disagree about which side to pass an obstacle, the average goes straight at it. Kept here to show why the other option exists."
      : "Skips the controller and uses the camera network’s own guess at what the exact-number brain would do (the “guessing” pathway it was trained with).";
}

/* ------------------------------- brains ------------------------------- */

const robotAssets = () => state.assets?.robot ?? null;
const sensorProfile = (): SensorProfile => (state.profile === "robot" ? ROBOT_PROFILE : KART_PROFILE);

function controllerChoices(): { id: string; label: string; snapshot: BrainSnapshot | null }[] {
  const assets = state.assets!;
  const list = [
    { id: "robust", label: state.profile === "robot" ? "Robust kart controller (no sonar inputs)" : "Robust controller (evolved for imperfect eyes)", snapshot: assets.robust },
    { id: "v1", label: "Original FlyKart demo brain (exact numbers only)", snapshot: assets.v1 },
  ];
  if (state.profile === "robot" && robotAssets()?.controller) list.unshift({ id: "robot", label: "Robot controller (evolved with the sonar)", snapshot: robotAssets()!.controller });
  if (state.imported) list.push({ id: "imported", label: `Imported: ${state.imported.name}`, snapshot: state.imported.snapshot });
  return list;
}

function eyesChoices(): { id: string; label: string; model: VisionModel | null }[] {
  const bundled = state.profile === "robot" ? robotAssets()?.vision ?? null : state.assets!.vision;
  const list = [{ id: "bundled", label: state.profile === "robot" ? "Robot camera network (trained at 6.5 cm)" : "Bundled camera network", model: bundled }, { id: "none", label: "None (original FlyKart, exact numbers)", model: null }];
  if (state.importedVision) list.splice(1, 0, { id: "imported", label: "Imported camera network", model: state.importedVision });
  return list;
}

function fillSelect(select: HTMLSelectElement, items: { id: string; label: string }[], keep?: string): void {
  const before = keep ?? select.value;
  select.innerHTML = items.map((item) => `<option value="${item.id}">${item.label}</option>`).join("");
  if (items.some((item) => item.id === before)) select.value = before;
}

function refreshBrainSelects(prefer?: { controller?: string; eyes?: string }): void {
  fillSelect($("track-controller") as HTMLSelectElement, controllerChoices(), prefer?.controller);
  fillSelect($("track-eyes") as HTMLSelectElement, eyesChoices(), prefer?.eyes);
  describeBrain();
}

function currentController(): BrainSnapshot {
  const id = ($("track-controller") as HTMLSelectElement).value;
  return (controllerChoices().find((choice) => choice.id === id)?.snapshot ?? (state.profile === "robot" ? robotAssets()?.controller : null) ?? state.assets!.robust ?? state.assets!.v1)!;
}
function currentVision(): VisionModel | null {
  const id = ($("track-eyes") as HTMLSelectElement).value;
  return eyesChoices().find((choice) => choice.id === id)?.model ?? null;
}

function describeBrain(): void {
  const controller = ($("track-controller") as HTMLSelectElement).value; const eyes = ($("track-eyes") as HTMLSelectElement).value;
  const parts: string[] = [];
  if (controller === "robot") parts.push("Starts as the robust controller with two extra inputs for the sonar, then evolved with the sonar in the loop: it also reads how close the nearest echo is and how strong it was.");
  if (currentController().inputCount > 17 && !sensorProfile().sonar) parts.push("This controller listens to a sonar, which the camera-only kart does not have; those inputs stay silent.");
  if (controller === "v1") parts.push("This is the demo brain from the original FlyKart guide. It never saw noise, so camera errors upset it more.");
  if (controller === "imported" && state.imported) parts.push(state.imported.info);
  if (eyes === "none") parts.push("No camera: the controller reads exact numbers, exactly as in FlyKart v1.");
  else if (currentVision()) { const vision = currentVision()!; parts.push(`Eyes: ${vision.spec.channels.join("-")} conv channels, ${vision.spec.input === "retina" ? "retina front end, " : ""}${vision.spec.spatial ? "soft-argmax, " : ""}${vision.trainedOn ? "trained by " + vision.trainedOn.split(";").pop()!.trim() : ""}.`); }
  $("brain-info").textContent = parts.join(" ");
}

/* ------------------------------- track session ------------------------------- */

function buildTrack(options: { keepMemory?: boolean } = {}): void {
  const select = $("track-select") as HTMLSelectElement;
  const memoryOn = $<HTMLInputElement>("memory-on").checked;
  if (!options.keepMemory) { state.memory.forget(); state.lapNumber = 0; state.laps = []; renderLapTable(); }
  state.track = new TrackSession({
    trackId: select.value, rivals: Number($<HTMLSelectElement>("track-rivals").value), objects: Number($<HTMLSelectElement>("track-objects").value), style: Number($<HTMLInputElement>("track-style").value), profile: sensorProfile(), sonarOn: state.sonarOn,
    walls: $<HTMLInputElement>("track-walls").checked, controller: currentController(), vision: currentVision(), fade: state.fade, mode: state.mode, memory: memoryOn ? state.memory : null, seed: 7,
  });
  $("track-caption").textContent = state.track.route.name;
  $("eye-note").textContent = state.track.perceiver ? "Gates are yellow bands under gantries; the finish is chequered; kerbs alternate red and white. Other karts, cones and barriers stand on the road." : "The camera is not used in this mode; this is what it would see.";
  updateProfileUi();
  paintTrack();
}

function renderLapTable(): void {
  const table = $("lap-table");
  if (state.laps.length === 0) { table.innerHTML = ""; return; }
  const best = Math.min(...state.laps.filter((lap) => lap.finished).map((lap) => lap.seconds), Infinity);
  table.innerHTML = `<div class="lap-row head"><span>Lap</span><span>Result</span><span>Off-road</span><span>Road-geometry error (camera → used)</span><span>Memory error</span></div>` + state.laps.map((lap) => {
    const result = lap.finished ? `<strong class="${lap.seconds === best ? "good" : ""}">${lap.seconds.toFixed(1)} s</strong>` : `<span class="bad">stopped at ${(lap.progress * 100).toFixed(0)}%</span>`;
    return `<div class="lap-row"><span>${lap.lap}</span><span>${result}</span><span>${(lap.offRoad * 100).toFixed(1)}%</span><span>${lap.errorCamera.toFixed(3)} → <span class="${lap.errorUsed < lap.errorCamera ? "good" : ""}">${lap.errorUsed.toFixed(3)}</span></span><span>${lap.memoryError === null ? "—" : lap.memoryError.toFixed(3)}${lap.remembering ? " · recalling" : ""}</span></div>`;
  }).join("");
}

function finishLap(): void {
  const session = state.track!;
  state.lapNumber += 1; state.laps.push(session.lap(state.lapNumber)); renderLapTable();
  if (state.lapsLeft > 1) { state.lapsLeft -= 1; buildTrack({ keepMemory: true }); setStatus("track", `lap ${state.lapNumber + 1} of memory run`); }
  else { state.lapsLeft = 0; state.running.track = false; $("track-run").textContent = "Start"; setStatus("track", session.episode.car.finished ? `lap done · ${(session.episode.car.ticks / 30).toFixed(1)} s` : `stopped: ${session.episode.car.crashReason ?? "time"}`); }
}

function setStatus(which: "track" | "world", text: string): void { $(`${which}-status`).textContent = text; }

function paintTrack(): void {
  const session = state.track; if (!session) return;
  const episode = session.episode; const car = episode.car; const driver = session.driver;
  const reading = episode.sonar();
  const sonarView: SonarView | null = reading ? { x: car.position.x + Math.cos(car.heading) * MOUNT.forward, y: car.position.y + Math.sin(car.heading) * MOUNT.forward, heading: car.heading, rangePx: reading.range, echo: reading.echo, on: state.sonarOn } : null;
  drawTrackMap($("track-map") as HTMLCanvasElement, session.route, car, episode.cars, episode.camera.hfov, { sonar: sonarView, nextGate: episode.nextGate(), label: `progress ${(car.totalProgress * 100).toFixed(0)}%   speed ${car.speed.toFixed(0)}   time ${(car.ticks / 30).toFixed(1)} s   gates ${car.checkpointsPassed}` });
  if (!session.perceiver) episode.render();
  drawEye($("track-eye") as HTMLCanvasElement, episode.frame, episode.camera);
  const truth = episode.truth(session.lastTruth); const perception = driver.perception;
  const rows = estimateRows(trackDomain, truth, perception ? perception.mean : null, perception ? perception.variance : null, driver.fused.mean, perception ? driver.fused.weights : null, driver.memoryCue ? driver.memoryCue.mean : null, Boolean(driver.memoryCue));
  drawEstimates($("track-estimates") as HTMLCanvasElement, rows);
  const activity = session.controller.activity();
  drawBrain($("brain-canvas") as HTMLCanvasElement, activity.spikes, activity.outputs);
  const memory = state.memory; const on = $<HTMLInputElement>("memory-on").checked && Boolean(session.perceiver);
  const gate = car.checkpointsPassed % memory.config.gates;
  const cells: number[] = []; for (let j = gate; j < memory.kenyonCount; j += memory.config.gates) cells.push(j);
  drawKenyon($("memory-cells") as HTMLCanvasElement, cells, new Set(Array.from(memory.active).filter((j) => j >= 0)), (j) => memory.isTaught(j), (j) => memory.cellDistance(j), on);
  if (reading) { drawSonarTrace($("sonar-canvas") as HTMLCanvasElement, session.sonarTrace, state.sonarOn); $("sonar-status").textContent = !state.sonarOn ? "switched off" : reading.echo ? `${(reading.range * CM_PER_PIXEL).toFixed(0)} cm · echo strength ${reading.strength.toFixed(1)}` : "no echo within 4 m"; }
  drawTrace($("memory-trace") as HTMLCanvasElement, session.trace, "bend 150 px ahead   white: truth · blue: camera · violet: memory · green: used");
  $("memory-status").textContent = on ? `lap ${memory.lap + 1} · ${memory.taughtCells} of ${memory.kenyonCount} cells taught · ${memory.remembering ? "recalling an earlier lap" : "nothing remembered here yet"}` : "off";
}

/* ------------------------------- sensor head ------------------------------- */

function updateProfileUi(): void {
  const robot = state.profile === "robot";
  $("sonar-row").hidden = !robot; $("sonar-panel").hidden = !robot || state.tab !== "track"; $("world-sonar-box").hidden = !robot;
  $("profile-note").textContent = robot
    ? `Robot scale: ${ROBOT.lengthCm} × ${ROBOT.widthCm} cm body, wheels ${ROBOT.wheelbaseCm} cm apart, and the camera and the HC-SR04 sonar both ${ROBOT.mountHeightCm} cm above the floor (one simulator pixel is ${CM_PER_PIXEL} cm, so the 24 × 14 px kart is about 26 × 15 cm). From that height the road is seen almost edge-on, the ground just ahead of the wheels is hidden, and gantries are raised so the sonar can pass beneath them.${robotAssets()?.vision ? "" : " The robot camera network is not bundled in this build: eyes are off."}`
    : "The original FlyKart Vision kart: a camera 16 cm up and no sonar. The robot profile adds the HC-SR04 and drops the camera to 6.5 cm.";
}

function setProfile(next: "kart" | "robot"): void {
  state.profile = next; $<HTMLSelectElement>("profile").value = next;
  state.memory.forget(); state.laps = []; state.lapNumber = 0; renderLapTable();
  const hasEyes = next === "robot" ? Boolean(robotAssets()?.vision) : Boolean(state.assets!.vision);
  refreshBrainSelects({ controller: next === "robot" && robotAssets()?.controller ? "robot" : "robust", eyes: hasEyes ? "bundled" : "none" });
  buildTrack();
  if (state.tab === "world") buildWorld(); else state.world = null;
}

/* ------------------------------- world session ------------------------------- */

function buildWorld(): void {
  const assets = state.assets!; const kind = $<HTMLSelectElement>("world-driver").value as WorldDriverKind;
  const robotWorld = state.profile === "robot" ? robotAssets() : null;
  const controller = state.importedWorld?.controller ?? robotWorld?.worldController ?? assets.worldController ?? assets.robust!;
  const vision = state.importedWorld?.vision ?? (state.profile === "robot" ? robotWorld?.worldVision ?? null : assets.worldVision);
  state.world = new WorldSession({ profile: sensorProfile(), sonarOn: state.sonarOn, seed: Number($<HTMLInputElement>("world-seed").value), density: Number($<HTMLInputElement>("world-density").value), style: Number($<HTMLInputElement>("world-style").value), kind, fade: Number($<HTMLInputElement>("world-fade").value), controller, vision });
  $("world-brain-info").textContent = !assets.worldController ? "The trained world controller was not found; the track controller is being used instead, which does not understand this world." : !vision && (kind === "vision" || kind === "both") ? "The world camera network was not found, so the kart is driving without eyes." : "";
  $("world-caption").textContent = `world ${$<HTMLInputElement>("world-seed").value}`;
  paintWorld();
}

function paintWorld(): void {
  const session = state.world; if (!session) return;
  const episode = session.episode; const sim = episode.sim; const driver = session.driver;
  const truth = episode.truth(session.lastTruth); const perception = driver?.perception ?? null;
  const reading = episode.sonar();
  const sonarView: SonarView | null = reading ? { x: sim.kart.x + Math.cos(sim.kart.heading) * MOUNT.forward, y: sim.kart.y + Math.sin(sim.kart.heading) * MOUNT.forward, heading: sim.kart.heading, rangePx: reading.range, echo: reading.echo, on: state.sonarOn } : null;
  drawWorldMap($("world-map") as HTMLCanvasElement, sim.world, sim.kart, { x: sim.status.goalX, y: sim.status.goalY }, { truth, seen: perception ? perception.mean : null, sigma: perception ? perception.variance : null },
    `goals ${sim.status.goals}   speed ${sim.kart.speed.toFixed(0)}   ${sim.surface}${sim.status.crashed ? "   " + sim.status.crashReason : ""}`, sonarView);
  $("world-sonar").textContent = !reading ? "—" : !state.sonarOn ? "off" : reading.echo ? `${(reading.range * CM_PER_PIXEL).toFixed(0)} cm` : "clear";
  if (!perception) episode.render();
  drawEye($("world-eye") as HTMLCanvasElement, episode.frame, episode.camera);
  const rows = driver ? estimateRows(worldDomain, truth, perception ? perception.mean : null, perception ? perception.variance : null, driver.fused.mean, perception ? driver.fused.weights : null) : estimateRows(worldDomain, truth, null, null, truth, null);
  drawEstimates($("world-estimates") as HTMLCanvasElement, rows, [-1, 1]);
  const activity = session.controller.activity(); drawBrain($("world-brain") as HTMLCanvasElement, activity.spikes, activity.outputs);
  $("world-goals").textContent = String(sim.status.goals); $("world-collisions").textContent = String(sim.status.collisions); $("world-time").textContent = `${(sim.status.ticks / 30).toFixed(0)} s`;
}

/* ------------------------------- main loop ------------------------------- */

function frame(now: number): void {
  const dt = Math.min(0.1, (now - (state.last || now)) / 1000); state.last = now;
  if (state.tab === "track" && state.running.track && state.track) {
    const speed = Number($<HTMLSelectElement>("track-speed").value);
    state.accumulator.track += dt * 30 * speed;
    let steps = Math.min(40, Math.floor(state.accumulator.track)); state.accumulator.track -= steps; const started = performance.now();
    while (steps-- > 0 && !state.track.done) { state.track.step(); if (performance.now() - started > 22) break; }
    if (state.track.done) finishLap();
    paintTrack();
    if (state.running.track) setStatus("track", `${state.track.episode.car.finished ? "lap done" : "driving"} · ${(state.track.episode.car.ticks / 30).toFixed(1)} s`);
  } else if (state.tab === "world" && state.running.world && state.world) {
    const speed = Number($<HTMLSelectElement>("world-speed").value);
    state.accumulator.world += dt * 30 * speed;
    let steps = Math.min(40, Math.floor(state.accumulator.world)); state.accumulator.world -= steps; const started = performance.now();
    while (steps-- > 0 && !state.world.done) { state.world.step(); if (performance.now() - started > 22) break; }
    if (state.world.done) { state.running.world = false; $("world-run").textContent = "Start"; setStatus("world", state.world.episode.sim.status.crashed ? `stopped: ${state.world.episode.sim.status.crashReason}` : `time up · ${state.world.episode.sim.status.goals} goals`); }
    paintWorld();
  }
  requestAnimationFrame(frame);
}

/* ------------------------------- import / export ------------------------------- */

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importBrain(file: File): Promise<void> {
  try {
    const imported = importFile(await file.text());
    const notes: string[] = [...imported.warnings];
    let prefer: { controller?: string; eyes?: string } = {};
    if (imported.controller && imported.controller.domain === "world") {
      state.importedWorld = { controller: imported.controller.snapshot, vision: imported.vision ?? null };
      notes.push("This is an open-world controller; it was loaded into the Open world tab.");
      buildWorld();
    } else if (imported.controller) {
      const meta = imported.controller.meta;
      state.imported = { name: file.name.replace(/\.json$/i, ""), snapshot: imported.controller.snapshot, info: `Imported ${imported.kind === "v1-brain" ? "FlyKart v1 brain" : "vision brain"}${meta.generation !== null ? `, generation ${meta.generation}` : ""}${meta.fitness !== null ? `, fitness ${meta.fitness.toFixed(0)}` : ""}. ${imported.warnings.join(" ")}` };
      prefer.controller = "imported";
    }
    if (imported.profile === "robot" && state.profile !== "robot" && state.assets?.robot) { state.profile = "robot"; $<HTMLSelectElement>("profile").value = "robot"; notes.push("This brain was made for the robot sensor head (camera 6.5 cm up and a sonar), so that profile was selected."); }
    if (imported.vision && imported.vision.domain !== "world") { state.importedVision = imported.vision; prefer.eyes = "imported"; }
    if (imported.world) state.importedWorld = { controller: imported.world.controller.snapshot, vision: imported.world.vision };
    if (imported.memory) { state.memory = MushroomBody.fromJSON(imported.memory); $<HTMLInputElement>("memory-on").checked = true; notes.push("The lap memory in the file was restored: the first lap will already recall the bends."); }
    if (imported.fusion) { state.mode = imported.fusion.mode; $<HTMLSelectElement>("track-mode").value = imported.fusion.mode; const t = imported.fusion.fade <= 0 ? 0 : imported.fusion.fade >= 1e5 ? 1 : Math.min(0.98, 1 + Math.log10(Math.max(0.001, imported.fusion.fade)) / 3); setFade(t); }
    refreshBrainSelects(prefer);
    $("brain-info").textContent = `${imported.name}: ${notes.join(" ")}`;
    buildTrack({ keepMemory: Boolean(imported.memory) });
  } catch (error) {
    $("brain-info").textContent = error instanceof Error ? error.message : "That file could not be read.";
  }
}

function worldExportSource(): { controller: BrainSnapshot; vision: VisionModel | null } | null {
  const assets = state.assets; if (!assets) return null;
  if (state.profile === "robot" && assets.robot?.worldController) return { controller: assets.robot.worldController, vision: assets.robot.worldVision };
  return assets.worldController ? { controller: assets.worldController, vision: assets.worldVision } : null;
}

function exportVision(): void {
  const snapshot = currentController(); const vision = currentVision();
  const memoryOn = $<HTMLInputElement>("memory-on").checked;
  download("flykart-vision-brain.json", exportVisionBrain({
    name: "FlyKart vision brain", profile: state.profile, controller: controllerCheckpoint(snapshot, { track: "all", provenance: [{ context: "vision", trained: true, source: "exported from FlyKart Vision" }] }), vision,
    fusion: { fade: state.fade, mode: state.mode, visionTemperature: 1 }, memory: memoryOn ? state.memory.toJSON() : null,
    world: worldExportSource() ? { controller: controllerCheckpoint(worldExportSource()!.controller, { domain: "world", track: "open world" }), vision: worldExportSource()!.vision } : null,
  }));
}

/* ------------------------------- boot ------------------------------- */

async function boot(): Promise<void> {
  const { assets, problems } = await loadAssets(); state.assets = assets;
  if (!assets.robust && !assets.v1) throw new Error(`No controller could be loaded (${problems.join("; ")}).`);
  const named = TRACKS.filter((track) => !track.id.startsWith("gen-"));
  const generated = Array.from({ length: 3 }, (_, i) => proceduralTrack(40 + i));
  fillSelect($("track-select") as HTMLSelectElement, [...named.map((t) => ({ id: t.id, label: t.name })), ...generated.map((t, i) => ({ id: t.id, label: `Generated track ${i + 1} (never trained on)` }))], "grand-loop");
  refreshBrainSelects({ controller: "robust", eyes: assets.vision ? "bundled" : "none" });
  $("fade-label").textContent = fadeLabel(0); updateModeNote();
  if (!assets.robot) { const option = $<HTMLSelectElement>("profile").querySelector("option[value=robot]") as HTMLOptionElement; option.disabled = true; option.textContent += " (not bundled in this build)"; }
  $<HTMLSelectElement>("profile").addEventListener("change", (event) => setProfile((event.target as HTMLSelectElement).value === "robot" ? "robot" : "kart"));
  $<HTMLInputElement>("sonar-on").addEventListener("change", (event) => { state.sonarOn = (event.target as HTMLInputElement).checked; if (state.track) state.track.driver.options.sonarOff = !state.sonarOn; if (state.world?.driver) state.world.driver.options.sonarOff = !state.sonarOn; });

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => button.addEventListener("click", () => showTab(button.id.replace("tab-btn-", ""))));
  $<HTMLInputElement>("fade").addEventListener("input", (event) => setFade(Number((event.target as HTMLInputElement).value)));
  $("preset-seeing").addEventListener("click", () => setFade(0)); $("preset-both").addEventListener("click", () => setFade(0.75)); $("preset-feeling").addEventListener("click", () => { setFade(1); });
  $<HTMLSelectElement>("track-mode").addEventListener("change", (event) => { state.mode = (event.target as HTMLSelectElement).value as DriverMode; if (state.track) state.track.driver.mode = state.mode; updateModeNote(); });
  for (const id of ["track-select", "track-rivals", "track-objects", "track-controller", "track-eyes", "track-walls"]) $(id).addEventListener("change", () => { describeBrain(); if (id === "track-select" || id === "track-controller" || id === "track-eyes") state.memory.forget(); buildTrack({ keepMemory: !(id === "track-select" || id === "track-controller" || id === "track-eyes") }); });
  $("track-style").addEventListener("change", () => buildTrack({ keepMemory: true }));
  $("track-restart").addEventListener("click", () => { state.lapsLeft = 0; buildTrack({ keepMemory: true }); setStatus("track", "restarted"); });
  $("track-run").addEventListener("click", () => { state.running.track = !state.running.track; $("track-run").textContent = state.running.track ? "Pause" : "Resume"; if (state.track?.done) buildTrack({ keepMemory: true }); setStatus("track", state.running.track ? "driving" : "paused"); });
  $("track-laps").addEventListener("click", () => { if (!currentVision()) { setStatus("track", "choose eyes first: the memory works through the camera"); return; } $<HTMLInputElement>("memory-on").checked = true; state.lapsLeft = 3; buildTrack(); state.running.track = true; $("track-run").textContent = "Pause"; });
  $("memory-forget").addEventListener("click", () => { state.memory.forget(); state.laps = []; state.lapNumber = 0; renderLapTable(); paintTrack(); });
  $("memory-on").addEventListener("change", () => buildTrack({ keepMemory: true }));
  $("import-btn").addEventListener("click", () => $<HTMLInputElement>("import-file").click());
  $<HTMLInputElement>("import-file").addEventListener("change", (event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (file) void importBrain(file); (event.target as HTMLInputElement).value = ""; });
  $("export-vision-btn").addEventListener("click", exportVision);
  $("export-v1-btn").addEventListener("click", () => download("flykart-brain-for-v1.json", exportAsFlyKartV1(controllerCheckpoint(currentController(), { track: "all" }))));

  $("world-run").addEventListener("click", () => { if (!state.world) buildWorld(); state.running.world = !state.running.world; $("world-run").textContent = state.running.world ? "Pause" : "Resume"; if (state.world?.done) buildWorld(); setStatus("world", state.running.world ? "driving" : "paused"); });
  $("world-new").addEventListener("click", () => { $<HTMLInputElement>("world-seed").value = String(1 + Math.floor(Math.random() * 99999)); buildWorld(); setStatus("world", "new world"); });
  for (const id of ["world-driver", "world-seed", "world-density", "world-style"]) $(id).addEventListener("change", () => { buildWorld(); setStatus("world", "ready"); });
  $("world-fade").addEventListener("input", () => { if (state.world?.driver) state.world.driver.fusion.fade = Number($<HTMLInputElement>("world-fade").value); });

  $("how").innerHTML = HOW_IT_WORKS;
  $("evidence").innerHTML = renderEvidence(assets.results, assets.controllerResults, assets.robotResults);
  buildTrack(); paintTrack();
  const wanted = location.hash.replace("#", ""); if (["world", "evidence", "how"].includes(wanted)) showTab(wanted);
  if (problems.length) console.warn("FlyKart Vision: bundled files not found:", problems.join(", "));
  $("boot-screen").setAttribute("hidden", "");
  (window as unknown as { flykartVision: unknown }).flykartVision = state;
  requestAnimationFrame(frame);
}

boot().catch((error) => {
  const screen = $("boot-screen"); screen.dataset.error = "true";
  $("boot-title").textContent = "FlyKart Vision did not start"; $("boot-message").textContent = error instanceof Error ? error.message : String(error);
});

