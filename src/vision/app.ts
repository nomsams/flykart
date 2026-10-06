import { generateClutter, furniture } from './world/objects';
import { racerToRoom } from '../robot/task-brain';
import { generateWorld, WorldSim, GoalPreset } from './world/world';
import { RoomMemory } from '../robot/memory';
import { mountMapPicker } from '../map-picker';
import { mountRoomPanel } from './room-panel';
import { ArenaFile, validateArena, reverseGoal } from './world/arena';
import { WorldTrainingResult, trainWorldController } from './world/training';
import { drawSonarHistory } from './sonar-history';
import { GHOST_COLORS } from './ui/draw';
import { mountBrainShelf } from '../browser-brain';
import { TrainingRecipe, validateRecipe } from '../training-recipe';
import { widenBrain } from './inputs';
import { attachJsonImport } from '../json-import';
import { organizeVision } from './layout';
// FlyKart Vision: the page that wires the simulator, camera, fusion and lap memory to the DOM.
import "../style.css";
import { explainControls } from "../control-help";
import { installSettingsHistory } from "../settings-history";
import { mountExperimentPanel } from "./experiment-panel";
import { calibratedProfile } from "./racing-settings";
import { CameraTrainingResult, trainCameraController } from "./browser-training";
import type { RacingSettings } from "./racing-settings";
import { lowResolution } from "./ensemble";
import "./vision.css";
import { BrainSnapshot, TRACKS, RoadObjectKind, DEFAULT_REWARD_CONFIG } from "../core";
import { MushroomBody } from "./memory";
import { controllerCheckpoint, exportAsFlyKartV1, exportVisionBrain, importFile, validateWorldSetup, WorldSetup } from "./format";
import type { VisionModel } from "./perception";
import { DriverMode } from "./pipeline";
import { Assets, loadAssets } from "./ui/assets";
import { SonarView, drawBrain, drawEstimates, drawEye, drawKenyon, drawSonarTrace, drawTrace, drawTrackMap, drawWorldMap, estimateRows } from "./ui/draw";
import { renderEvidence } from "./ui/evidence";
import { HOW_IT_WORKS } from "./ui/how";
import { LapRecord, TrackSession, TrackSettings, WorldDriverKind, WorldSession, WorldSettings } from "./ui/sessions";
import { trackDomain, worldDomain } from "./domains";
import { proceduralTrack } from "./proceduralTracks";
import { CM_PER_PIXEL, KART_PROFILE, MOUNT, ROBOT, ROBOT_PROFILE, SensorProfile } from "./robot";

const $ = <T extends HTMLElement>(id: string): T => { const element = document.getElementById(id); if (!element) throw new Error(`missing element #${id}`); return element as T; };

type Imported = { name: string; snapshot: BrainSnapshot; info: string; fitness?:number; generation?:number; provenance?:unknown[] };

const state = {
  assets: null as Assets | null,
  imported: null as Imported | null,
  sourceRecipe: null as TrainingRecipe | null,
  dormantObstacleCount:0,
  importedVision: null as VisionModel | null,
  importedWorld: null as { controller: BrainSnapshot; vision: VisionModel | null; fitness?:number;generation?:number;trainingRecipe?:TrainingRecipe;provenance?:unknown[] } | null,
  robotExtensions: null as {robotLearning?:unknown;robotMission?:unknown} | null,
  memory: new MushroomBody({ seed: 11 }),
  worldMemory: null as RoomMemory|null,
  arena: null as ArenaFile|null,
  track: null as TrackSession | null,
  world: null as WorldSession | null,
  running: { track: false, world: false },
  lapsLeft: 0, lapNumber: 0, laps: [] as LapRecord[],
  fade: 0, mode: "belief" as DriverMode,
  tab: "track", activeDomain: "track" as "track" | "world",
  profile: "kart" as "kart" | "robot", sonarOn: true,
  last: 0, accumulator: { track: 0, world: 0 },
};

/* ------------------------------- tabs ------------------------------- */

function showTab(name: string): void {
  state.tab = name;
  if (name === "track" || name === "world") state.activeDomain = name;
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

let experiment:ReturnType<typeof mountExperimentPanel>;
let cameraTraining=false, cancelTraining=false, trainedCamera:CameraTrainingResult|null=null;
let trainedExperiment:RacingSettings|null=null;
let trainedContext:TrackSettings|null=null;
let trainedParentGeneration=0;
let trainedWorld:WorldTrainingResult|null=null,trainedWorldContext:WorldSettings|null=null;
let trainedWorldExperiment:RacingSettings|null=null,worldParentGeneration=0;
let trainedWorldRecipe:TrainingRecipe|undefined,trainedWorldProvenance:unknown[]=[];
const sensorLog:string[]=[];let loggedPing=-1,loggedWorldPing=-1,loggedWorldSight:number|null=null;
function logSensor(line:string):void{sensorLog.push(line);while(sensorLog.length>500)sensorLog.shift();for(const id of ["sensor-log","world-sensor-log"]){const box=document.getElementById(id) as HTMLTextAreaElement|null;if(box){box.value=sensorLog.join("\n");box.scrollTop=box.scrollHeight;}}}
const robotAssets = () => state.assets?.robot ?? null;
const baseProfile = ():SensorProfile => state.profile === "robot" ? ROBOT_PROFILE : KART_PROFILE;
const sensorProfile = (): SensorProfile => experiment ? calibratedProfile(baseProfile(),experiment.applied()) : baseProfile();

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
  select.replaceChildren(...items.map(item => new Option(item.label, item.id)));
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

function boundedInput(id:string,min:number,max:number,fallback:number):number {
  const input=$<HTMLInputElement>(id), raw=input.value.trim()?Number(input.value):NaN;
  const value=Number.isFinite(raw)?Math.max(min,Math.min(max,Math.round(raw))):fallback;
  input.value=String(value);return value;
}
function buildTrack(options: { keepMemory?: boolean } = {}): void {
  state.running.track=false;$("track-run").textContent="Start";setStatus("track","ready");
  const gates=boundedInput('race-checkpoints',2,64,8),variation=boundedInput('race-variation',0,35,0)/100;
  if(state.memory.config.gates!==gates){state.memory=new MushroomBody({...state.memory.config,gates});options.keepMemory=false;}
  const capacity=boundedInput("memory-count",64,64000,4000);if(state.memory.kenyonCount!==capacity){state.memory=new MushroomBody({...state.memory.config,kenyonCells:capacity});options.keepMemory=false;}
  const select = $("track-select") as HTMLSelectElement;
  const memoryOn = $<HTMLInputElement>("memory-on").checked;
  if (!options.keepMemory) { state.memory.forget(); state.lapNumber = 0; state.laps = []; renderLapTable(); }
  const settings=experiment.applied();if(document.getElementById('world-eye-layout'))$<HTMLSelectElement>('world-eye-layout').value=settings.visual.layout;loggedPing=-1;state.accumulator.track=0;
  const profile=sensorProfile(),eyes=currentVision();if(eyes)profile.camera={...profile.camera,width:eyes.spec.width,height:eyes.spec.height};
  state.track = new TrackSession({
    rewardConfig:settings.reward,objectKind:$<HTMLSelectElement>("track-object-kind").value as RoadObjectKind|"mixed",checkpointCount:gates,physicsVariation:variation,
    lapTarget:settings.multiLap?settings.laps:1, impactPain:settings.impactPain, visual:settings.visual, resolution:settings.resolution,cameraNoise:settings.cameraNoise,cameraBrightness:settings.cameraBrightness,
    trackId: select.value, rivals: Number($<HTMLSelectElement>("track-rivals").value), objects: Number($<HTMLSelectElement>("track-objects").value), style: Number($<HTMLInputElement>("track-style").value), profile, sonarOn: state.sonarOn,
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
  state.lapsLeft = 0; state.running.track = false; $("track-run").textContent = "Start"; setStatus("track", session.episode.car.finished ? `${session.episode.car.laps} lap(s) done · ${(session.episode.car.ticks / 30).toFixed(1)} s` : `stopped: ${session.episode.car.crashReason ?? "time"}`);
}

function setStatus(which: "track" | "world", text: string): void { $(`${which}-status`).textContent = text; }

function paintTrack(preview?:TrackSession,ghosts:TrackSession[]=[]): void {
  const session = preview??state.track; if (!session) return;
  const episode = session.episode; const car = episode.car; const driver = session.driver;
  const resolution=session.settings.resolution??'native';$('track-camera-size').textContent=`${resolution==='native'?episode.camera.width+'×'+episode.camera.height:resolution.replace('x','×')} colour pixels · 15 Hz simulation clock`;
  const reading = episode.sonar();
  const spec=episode.sonarUnit?.spec;
  const sonarView: SonarView | null = reading ? { x: car.position.x + Math.cos(car.heading) * (spec?.mountForward??MOUNT.forward), y: car.position.y + Math.sin(car.heading) * (spec?.mountForward??MOUNT.forward), heading: car.heading+(spec?.yawDeg??0)*Math.PI/180, beamDeg:(spec?.lobeSigmaDeg??12)*1.25, rangePx: reading.range, echo: reading.echo, on: state.sonarOn } : null;
  drawTrackMap($("track-map") as HTMLCanvasElement, session.route, car, episode.cars, episode.camera.hfov, { ghosts:ghosts.map((s,i)=>({x:s.episode.car.position.x,y:s.episode.car.position.y,heading:s.episode.car.heading,label:String(i+1),color:GHOST_COLORS[i%GHOST_COLORS.length]})),checkpointCount:session.settings.checkpointCount,sonar: sonarView, nextGate: episode.nextGate(), label: `progress ${(car.totalProgress * 100).toFixed(0)}%   speed ${car.speed.toFixed(0)}   time ${(car.ticks / 30).toFixed(1)} s   gates ${car.checkpointsPassed}` });
  if (!session.perceiver) episode.render();
  drawEye($("track-eye") as HTMLCanvasElement, lowResolution(episode.frame,episode.camera.width,episode.camera.height,session.settings.resolution??"native"), episode.camera);
  const ensemble=driver.ensemble;if(ensemble){const canvas=$("virtual-eyes") as HTMLCanvasElement,ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,canvas.width,canvas.height);ensemble.frames.forEach((f,i)=>{const thumb=document.createElement('canvas');thumb.width=episode.camera.width;thumb.height=episode.camera.height;const c=thumb.getContext('2d')!,image=c.createImageData(thumb.width,thumb.height),n=thumb.width*thumb.height;for(let p=0;p<n;p++){for(let k=0;k<3;k++)image.data[p*4+k]=Math.round(f[k*n+p]*255);image.data[p*4+3]=255;}c.putImageData(image,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(thumb,i*canvas.width/ensemble.frames.length,0,canvas.width/ensemble.frames.length,canvas.height);});$("eye-disagreement").textContent=`${ensemble.frames.length} view(s) · estimate disagreement ${ensemble.disagreement.toFixed(3)} · filtered RGB is the controller's image`;}
  const truth = episode.truth(session.lastTruth); const perception = driver.perception;
  const rows = estimateRows(trackDomain, truth, perception ? perception.mean : null, perception ? perception.variance : null, driver.fused.mean, perception ? driver.fused.weights : null, driver.memoryCue ? driver.memoryCue.mean : null, Boolean(driver.memoryCue));
  drawEstimates($("track-estimates") as HTMLCanvasElement, rows);
  const activity = session.controller.activity();
  drawBrain($("brain-canvas") as HTMLCanvasElement, activity.spikes, activity.outputs);
  const memory = state.memory; const on = $<HTMLInputElement>("memory-on").checked && Boolean(session.perceiver);
  const gate = car.checkpointsPassed % memory.config.gates;
  const cells: number[] = []; for (let j = gate; j < memory.kenyonCount; j += memory.config.gates) cells.push(j);
  drawKenyon($("memory-cells") as HTMLCanvasElement, cells, new Set(Array.from(memory.active).filter((j) => j >= 0)), (j) => memory.isTaught(j), (j) => memory.cellDistance(j), on);
  if (reading) { drawSonarTrace($("sonar-canvas") as HTMLCanvasElement, session.sonarTrace, state.sonarOn); const age=(episode.tick-(episode.sonarUnit?.lastTick??0))/30;$("sonar-status").textContent = `${!state.sonarOn ? 'ignored by controller' : reading.echo ? `${(reading.range*CM_PER_PIXEL).toFixed(1)} cm · strength ${reading.strength.toFixed(1)}` : 'no echo (not zero distance)'} · ping ${episode.sonarUnit!.count} · age ${(age*1000).toFixed(0)} ms · ${state.running.track?'15 Hz simulation clock':'paused; held sample'}`;logFreshPing(session); }
  drawSonarHistory($("track-sonar-map") as HTMLCanvasElement,session.sonarMap,{x:car.position.x,y:car.position.y,heading:car.heading},state.sonarOn&&Boolean(episode.sonarUnit),{...scanOptions("track"),available:Boolean(episode.sonarUnit)});
  drawTrace($("memory-trace") as HTMLCanvasElement, session.trace, "bend 150 px ahead   white: truth · blue: camera · violet: memory · green: used");
  $("memory-status").textContent = on ? `lap ${Math.max(1,memory.lap)} · ${memory.taughtCells} of ${memory.kenyonCount} cells taught · ${memory.remembering ? "recalling an earlier lap" : "nothing remembered here yet"}` : "off";
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
  const keepImported=$<HTMLSelectElement>("track-controller").value === "imported";
  state.profile = next; $<HTMLSelectElement>("profile").value = next;
  if(experiment)experiment.write(experiment.applied());
  state.memory.forget(); state.worldMemory=null;state.laps = []; state.lapNumber = 0; renderLapTable();
  const hasEyes = next === "robot" ? Boolean(robotAssets()?.vision) : Boolean(state.assets!.vision);
  refreshBrainSelects({ controller: keepImported ? "imported" : next === "robot" && robotAssets()?.controller ? "robot" : "robust", eyes: hasEyes ? "bundled" : "none" });
  buildTrack();
  if (state.tab === "world") buildWorld(); else state.world = null;
}

/* ------------------------------- world session ------------------------------- */

function syncWorldTaskUi():void {
  const explore=$<HTMLSelectElement>('world-task').value==='explore';
  $<HTMLSelectElement>('world-driver').disabled=explore;$<HTMLInputElement>('world-fade').disabled=explore;
  $<HTMLInputElement>('world-crash-weight').disabled=explore;$<HTMLInputElement>('world-reverse-coach').disabled=explore;
  $('world-search-win-row').hidden=!explore;
  $<HTMLSelectElement>('world-goal-preset').querySelector<HTMLOptionElement>('option[value=pair]')!.textContent=explore?'One random hidden flag · search':'Two dots · collect both, either order';
  if(explore){$<HTMLSelectElement>('world-driver').value='vision';$<HTMLInputElement>('world-fade').value='0';}
  $('world-task-note').textContent=explore?'Search starts with one pink flag outside the camera view. The brain sees processed colour pixels through obstacle eyes and a fixed pink-colour detector, enabled sonar and body feedback. Target slots are image bearing and apparent size; both are zero while unseen. No goal compass, true range, hidden-distance reward or pheromone trail. First confirmed sighting wins by default; optionally require arrival too. The map and scan history are observer diagnostics, never neural inputs. Existing compass brains need evolution for these new cue meanings.':'Compass exercises give direction and distance even when the flag is hidden; there is no pheromone trail. Camera estimates, enabled sonar and body feedback also reach the controller. Reverse practice ends on arrival. Ghosts have independent physics and common seeds. Rewards and contact labels select offspring only. A real robot needs a physical goal source.';
  if(explore)$('world-weight-label').textContent='Fastest successful find wins · impact pain is a tiny tie-break';
  else $('world-crash-weight').dispatchEvent(new Event('input'));
}

function buildWorld(): void {
  state.running.world=false;$("world-run").textContent="Start";
  const assets = state.assets!; syncWorldTaskUi(); const kind = $<HTMLSelectElement>("world-driver").value as WorldDriverKind;
  const robotWorld = state.profile === "robot" ? robotAssets() : null;
  const controller = state.importedWorld?.controller ?? robotWorld?.worldController ?? assets.worldController ?? assets.robust!;
  const vision = state.importedWorld ? state.importedWorld.vision : (state.profile === "robot" ? robotWorld?.worldVision ?? null : assets.worldVision);
  const settings=experiment.applied();if(document.getElementById('world-eye-layout'))$<HTMLSelectElement>('world-eye-layout').value=settings.visual.layout;state.accumulator.world=0;loggedWorldPing=-1;loggedWorldSight=null;
  if(state.worldMemory&&state.worldMemory.count!==Number($<HTMLSelectElement>("world-memory-count").value))state.worldMemory=null;
  const profile=sensorProfile();if(vision)profile.worldCamera={...profile.worldCamera,width:vision.spec.width,height:vision.spec.height};
  state.world = new WorldSession({ cameraNoise:settings.cameraNoise,cameraBrightness:settings.cameraBrightness,visual:settings.visual,resolution:settings.resolution, profile, sonarOn: state.sonarOn, roomMemory:$<HTMLInputElement>("world-memory-on").checked?state.worldMemory:null,memorySettings:$<HTMLInputElement>("world-memory-on").checked?{count:Number($<HTMLSelectElement>("world-memory-count").value),sparsity:.01,rareWeighting:true}:undefined,goalPreset:$<HTMLSelectElement>("world-goal-preset").value as GoalPreset,task:$<HTMLSelectElement>("world-task").value as "forage"|"reverse"|"explore",searchWin:$<HTMLSelectElement>("world-search-win").value as "sight"|"reach",world:worldScene(),start:$<HTMLSelectElement>("world-map-preset").value==="imported"?state.arena?.start:undefined,seed: boundedInput("world-seed",1,999999,7), density: Number($<HTMLInputElement>("world-density").value), style: Number($<HTMLInputElement>("world-style").value), kind, sensorOnly:kind==="vision",fade: Number($<HTMLInputElement>("world-fade").value), controller, vision });
  state.worldMemory=state.world.memory;
  renderWorldPreviews();
  $("world-brain-info").textContent = !assets.worldController ? "The trained world controller was not found; the track controller is being used instead, which does not understand this world." : !vision && (kind === "vision" || kind === "both") ? "The world camera network was not found, so the kart is driving without eyes." : "";
  $("world-caption").textContent = `world ${$<HTMLInputElement>("world-seed").value}`;
  paintWorld();
}

function paintWorld(preview?:WorldSession,ghosts:WorldSession[]=[]): void {
  const session = preview??state.world; if (!session) return;
  const episode = session.episode; const sim = episode.sim; const driver = session.driver;
  const truth = episode.truth(session.lastTruth); const perception = driver?.perception ?? null;
  const reading = episode.sonar();
  const spec=episode.sonarUnit?.spec;
  const sonarView: SonarView | null = reading ? { x: sim.kart.x + Math.cos(sim.kart.heading) * (spec?.mountForward??MOUNT.forward), y: sim.kart.y + Math.sin(sim.kart.heading) * (spec?.mountForward??MOUNT.forward), heading: sim.kart.heading+(spec?.yawDeg??0)*Math.PI/180,beamDeg:(spec?.lobeSigmaDeg??12)*1.25, rangePx: reading.range, echo: reading.echo, on: state.sonarOn } : null;
  drawWorldMap($("world-map") as HTMLCanvasElement, sim.world, sim.kart, { x: sim.status.goalX, y: sim.status.goalY }, { truth, seen: perception ? perception.mean : null, sigma: perception ? perception.variance : null },
    `goals ${sim.status.goals}   speed ${sim.kart.speed.toFixed(0)}   ${sim.surface}${sim.status.crashed ? "   " + sim.status.crashReason : ""}`, sonarView,{goals:sim.goals,trail:$<HTMLInputElement>("world-trail-visible").checked?session.trail:undefined,ghosts:ghosts.map((s,i)=>({...s.episode.sim.kart,trail:$<HTMLInputElement>("world-trail-visible").checked?s.trail:undefined,label:String(i+1),color:GHOST_COLORS[i%GHOST_COLORS.length]}))});
  drawSonarHistory($("world-sonar-map") as HTMLCanvasElement,session.sonarMap,sim.kart,state.sonarOn&&Boolean(episode.sonarUnit),{...scanOptions("world"),available:Boolean(episode.sonarUnit),extent:sim.world.half+50});
  const discovery=session.discovery, sight=$('world-discovery-status');sight.hidden=!discovery;
  if(discovery){const cue=discovery.cue(),first=discovery.firstSightTick; sight.textContent=`${session.won?'WINNER · ':''}${discovery.tracker.current.visible?'Flag visible':'Searching · flag not visible'} · first sight ${first===null?'not yet':(first/30).toFixed(2)+' s'} · pixel bearing ${(cue[0]*180).toFixed(1)}° · apparent size ${cue[1].toFixed(3)} · ${discovery.visualViews} coarse views. No compass or true range; map is for the observer.`;}
  $("world-memory-status").textContent=session.memory?`${session.memory.count} cells · ${session.memory.taught} taught · ${session.memory.recalled?"recalling":"building visual signatures"}`:"Off";
  $("world-sonar").textContent = !reading ? "—" : !state.sonarOn ? "off" : reading.echo ? `${(reading.range * CM_PER_PIXEL).toFixed(0)} cm` : "no echo";
  if (!perception) episode.render();
  drawEye($("world-eye") as HTMLCanvasElement, lowResolution(episode.frame,episode.camera.width,episode.camera.height,session.settings.resolution??"native"), episode.camera);
  const rows = driver ? estimateRows(worldDomain, truth, perception ? perception.mean : null, perception ? perception.variance : null, driver.fused.mean, perception ? driver.fused.weights : null) : estimateRows(worldDomain, truth, null, null, truth, null);
  drawEstimates($("world-estimates") as HTMLCanvasElement, rows, [-1, 1]);
  const activity = session.controller.activity(); drawBrain($("world-brain") as HTMLCanvasElement, activity.spikes, activity.outputs);
  $("world-goals").textContent = String(sim.status.goals); $("world-collisions").textContent = `${sim.status.collisions} · pain ${sim.status.pain.toFixed(2)}`; $("world-time").textContent = `${(sim.status.ticks / 30).toFixed(0)} s`;
}

/* ------------------------------- main loop ------------------------------- */

function frame(now: number): void {
  const dt = Math.min(0.1, (now - (state.last || now)) / 1000); state.last = now;
  if (state.tab === "track" && state.running.track && state.track) {
    const speed = Number($<HTMLSelectElement>("track-speed").value);
    state.accumulator.track = Math.min(120,state.accumulator.track + dt * 30 * speed);
    let steps = Math.min(40, Math.floor(state.accumulator.track));  const started = performance.now();
    while (steps-- > 0 && !state.track.done) { state.track.step(); logFreshPing(state.track); state.accumulator.track -= 1; if (performance.now() - started > 22) break; }
    if (state.track.done) finishLap();
    paintTrack();
    if (state.running.track) setStatus("track", `${state.track.episode.car.finished ? "lap done" : "driving"} · ${(state.track.episode.car.ticks / 30).toFixed(1)} s`);
  } else if (state.tab === "world" && state.running.world && state.world) {
    const speed = Number($<HTMLSelectElement>("world-speed").value);
    state.accumulator.world = Math.min(120,state.accumulator.world + dt * 30 * speed);
    let steps = Math.min(40, Math.floor(state.accumulator.world));  const started = performance.now();
    while (steps-- > 0 && !state.world.done) { state.world.step();logWorldPing(state.world); state.accumulator.world -= 1; if (performance.now() - started > 22) break; }
    if (state.world.done) { state.running.world = false; $("world-run").textContent = "Start"; setStatus("world", state.world.episode.sim.status.crashed ? `stopped: ${state.world.episode.sim.status.crashReason}` : state.world.discovery?`${state.world.won?'Search won':'Search ended without a win'} · first sight ${state.world.discovery.firstSightTick===null?'not found':(state.world.discovery.firstSightTick/30).toFixed(2)+' s'} · ${(state.world.episode.tick/30).toFixed(1)} s`:state.world.episode.sim.status.goals>=state.world.episode.sim.goalLimit?`Goal reached · ${(state.world.episode.tick/30).toFixed(1)} s`:`time up · ${state.world.episode.sim.status.goals} goals`); }
    paintWorld();
  }
  requestAnimationFrame(frame);
}

/* ------------------------------- import / export ------------------------------- */

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function importBrainText(text: string, name: string): Promise<void> {
  const imported=importFile(text),raw=JSON.parse(text),full=imported.kind==='vision-brain';
  const track=imported.controller?.domain==='track'?{controller:imported.controller,vision:imported.vision,memory:imported.memory,trainingRecipe:imported.trainingRecipe}:imported.racer;
  const world=imported.controller?.domain==='world'?{...imported.controller,vision:imported.vision,trainingRecipe:imported.trainingRecipe}:imported.world?.controller?{...imported.world.controller,vision:imported.world.vision,trainingRecipe:imported.world.trainingRecipe}:null;
  const nextProfile=imported.profile??state.profile;
  const setup=imported.worldSetup??{version:1,seed:7,density:.6,style:0,driver:'vision',fade:0,goalPreset:'standard',mapPreset:imported.worldArena?'imported':'procedural',memoryCount:imported.worldMemory?.settings?.count??4096,sonarOn:true,trailVisible:true} as WorldSetup;
  // Validate the actual goal placement before replacing any current brain or controls.
  if(world||full){
    const arena=imported.worldArena,geometry=arena?.world??(setup.mapPreset==='clear'?{seed:setup.seed,half:460,obstacles:[],patches:[]}:undefined);
    const exploration=imported.worldTraining?.task==='explore',incomingEyes=world?.vision??(full?null:nextProfile==='robot'?robotAssets()?.worldVision:state.assets!.worldVision);
    if(exploration&&!incomingEyes)throw Error('Exploration requires a world camera network.');
    const incomingProfile=calibratedProfile(nextProfile==='robot'?ROBOT_PROFILE:KART_PROFILE,imported.experiment??experiment.applied());
    const trial=new WorldSim(setup.seed,{world:geometry,start:arena?.start,density:setup.density,goalPreset:imported.worldTraining?.task==='reverse'?'near':exploration&&setup.goalPreset==='pair'?'random':setup.goalPreset,hiddenGoalAngle:exploration?Math.min(Math.PI-.01,incomingProfile.worldCamera.hfov/2+.25):undefined});
    if(imported.worldTraining?.task==='reverse')reverseGoal(trial.world,trial.kart);
  }
  state.running.track=state.running.world=false;$('track-run').textContent=$('world-run').textContent='Start';setStatus('world','paused');
  if(imported.profile){state.profile=nextProfile;$<HTMLSelectElement>('profile').value=nextProfile;}
  const prefer:{controller?:string;eyes?:string}={};
  if(track){
    state.imported={name:name.replace(/\.json$/i,''),snapshot:track.controller.snapshot,fitness:track.controller.meta.fitness??0,generation:track.controller.meta.generation??0,info:imported.warnings.join(' '),provenance:Array.isArray(raw.racer?.controller?.provenance??raw.controller?.provenance??raw.provenance)?(raw.racer?.controller?.provenance??raw.controller?.provenance??raw.provenance):[]};
    prefer.controller='imported';state.sourceRecipe=track.trainingRecipe??null;
    state.importedVision=track.vision??null;prefer.eyes=track.vision?'imported':full?'none':'bundled';
    const memory=track.memory??null;state.memory=memory?MushroomBody.fromJSON(memory):new MushroomBody({seed:11,kenyonCells:imported.trackSetup?.memoryCount??4000});
    $<HTMLInputElement>('memory-count').value=String(state.memory.kenyonCount);$<HTMLInputElement>('memory-on').checked=Boolean(memory)&& (imported.trackSetup?.memoryEnabled??true);
  }else if(imported.vision?.domain==='track'){state.importedVision=imported.vision;prefer.eyes='imported';}
  if(full){state.importedWorld=null;state.worldMemory=null;state.arena=null;state.world=null;state.robotExtensions=null;}
  if(world){
    const c=world;
    state.importedWorld={controller:c.snapshot,vision:world.vision??(full?null:nextProfile==='robot'?robotAssets()?.worldVision??null:state.assets!.worldVision),fitness:c.meta.fitness??0,generation:c.meta.generation??0,trainingRecipe:world.trainingRecipe,provenance:imported.controller?.domain==='world'?(raw.controller?.provenance??raw.provenance??[]):raw.world?.controller?.provenance??raw.provenance??[]};
    state.robotExtensions=imported.controller?.domain==='world'?{robotLearning:raw.robotLearning,robotMission:raw.robotMission}:null;
  }else if(imported.vision?.domain==='world'){const source=state.importedWorld??worldExportSource();if(source)state.importedWorld={...source,vision:imported.vision};}
  if(full||world){
    state.arena=imported.worldArena??null;writeWorldSetup(setup);
    const t=imported.worldTraining;$<HTMLSelectElement>('world-task').value=t?.task??'forage';$<HTMLSelectElement>('world-search-win').value=t?.searchWin??'sight';$<HTMLInputElement>('world-crash-weight').value=String((t?.crashWeight??.2)*100);$('world-crash-weight').dispatchEvent(new Event('input'));$<HTMLInputElement>('world-train-ticks').value=String(t?.maxTicks??900);$<HTMLInputElement>('world-reverse-coach').checked=t?.reverseCoach??true;$<HTMLInputElement>('world-retain-forward').checked=t?.retainForward??true;
    state.worldMemory=imported.worldMemory?RoomMemory.fromJSON(imported.worldMemory):null;$<HTMLInputElement>('world-memory-on').checked=t?.memoryEnabled??Boolean(imported.worldMemory);
    if(state.worldMemory)$<HTMLSelectElement>('world-memory-count').value=String(state.worldMemory.count);
  }
  if(imported.experiment)experiment.write(imported.experiment);
  const recipe=track?.trainingRecipe;
  if(recipe){
    const r=recipe;state.dormantObstacleCount=r.obstacles.count;experiment.write({...experiment.applied(),reward:r.reward,multiLap:r.physics.lapTarget>1,laps:r.physics.lapTarget===1?3:r.physics.lapTarget,impactPain:r.physics.impactPain});
    $<HTMLInputElement>('track-walls').checked=r.physics.wallsEnabled;$<HTMLInputElement>('race-checkpoints').value=String(r.physics.checkpointCount);$<HTMLInputElement>('race-variation').value=String(r.physics.domainRandomization*100);
    const count=r.obstacles.enabled?r.obstacles.count:0,select=$<HTMLSelectElement>('track-objects');if(!Array.from(select.options).some(o=>Number(o.value)===count))select.add(new Option(String(count),String(count)));select.value=String(count);$<HTMLSelectElement>('track-object-kind').value=r.obstacles.kind;
  }
  if(track?.memory&&!recipe)$<HTMLInputElement>('race-checkpoints').value=String(track.memory.config.gates);
  if(imported.trackSetup){const t=imported.trackSetup;const select=$<HTMLSelectElement>('track-select');if(Array.from(select.options).some(o=>o.value===t.trackId))select.value=t.trackId;const rivals=$<HTMLSelectElement>('track-rivals');if(!Array.from(rivals.options).some(o=>Number(o.value)===t.rivals))rivals.add(new Option(String(t.rivals),String(t.rivals)));rivals.value=String(t.rivals);$<HTMLInputElement>('track-style').value=String(t.style);}
  else if(raw.track&&Array.from($<HTMLSelectElement>('track-select').options).some(o=>o.value===raw.track))$<HTMLSelectElement>('track-select').value=raw.track;
  if(imported.fusion){state.mode=imported.fusion.mode;$<HTMLSelectElement>('track-mode').value=state.mode;const fade=imported.fusion.fade;setFade(fade<=0?0:fade>=1e5?1:Math.min(.98,1+Math.log10(Math.max(.001,fade))/3));}
  refreshBrainSelects(prefer);buildTrack({keepMemory:Boolean(track?.memory)});
  if(full||world||imported.vision?.domain==='world'){buildWorld();if(imported.worldScan)state.world!.sonarMap.restore(imported.worldScan);}
  if(imported.trackScan)state.track!.sonarMap.restore(imported.trackScan);
  showTab(imported.controller?.domain==='world'||imported.vision?.domain==='world'?'world':'track');paintTrack();paintWorld();
  $('brain-info').textContent=`${imported.name}: ${imported.warnings.join(' ')}`;$('brain-file-status').textContent=`Imported ${imported.name}. Import remains available to replace it again.`;
}

function worldExportSource(): { controller: BrainSnapshot; vision: VisionModel | null;fitness?:number;generation?:number;trainingRecipe?:TrainingRecipe;provenance?:unknown[] } | null {
  const assets = state.assets; if (!assets) return null;
  if (state.profile === "robot" && assets.robot?.worldController) return { controller: assets.robot.worldController, vision: assets.robot.worldVision };
  return assets.worldController ? { controller: assets.worldController, vision: assets.worldVision } : null;
}

function visionRecipe():TrainingRecipe {
  const settings=experiment.applied();if(document.getElementById('world-eye-layout'))$<HTMLSelectElement>('world-eye-layout').value=settings.visual.layout;
  return validateRecipe({version:1,domain:'race',reward:settings.reward??DEFAULT_REWARD_CONFIG,physics:{wallsEnabled:$<HTMLInputElement>('track-walls').checked,lapTarget:settings.multiLap?settings.laps:1,impactPain:settings.impactPain,checkpointCount:Number($<HTMLInputElement>('race-checkpoints').value),domainRandomization:Number($<HTMLInputElement>('race-variation').value)/100},obstacles:{enabled:Number($<HTMLSelectElement>('track-objects').value)>0,count:Number($<HTMLSelectElement>('track-objects').value)||state.dormantObstacleCount,kind:$<HTMLSelectElement>('track-object-kind').value}});
}
function selectedCheckpoint() {
  const imported=$<HTMLSelectElement>('track-controller').value==='imported'?state.imported:null;
  return controllerCheckpoint(currentController(),{track:$<HTMLSelectElement>('track-select').value,domain:'track',fitness:imported?.fitness,generation:imported?.generation,trainingRecipe:visionRecipe(),provenance:[...(imported?.provenance??[]),{context:'vision',trained:Boolean(trainedCamera&&imported?.snapshot===trainedCamera.brain),source:'FlyKart Vision',experiment:experiment.applied(),validation:trainedCamera&&imported?.snapshot===trainedCamera.brain?trainedCamera.validation:null}]});
}
function visionBrainText():string {
  const world=state.importedWorld??worldExportSource();
  return exportVisionBrain({...(state.activeDomain==='world'?state.robotExtensions??{}:{}),experiment:experiment.applied(),name:'FlyKart vision brain',profile:state.profile,worldSetup:readWorldSetup(),trackSetup:{version:1,trackId:$<HTMLSelectElement>('track-select').value,rivals:Number($<HTMLSelectElement>('track-rivals').value),style:Number($<HTMLInputElement>('track-style').value),memoryCount:state.memory.kenyonCount,memoryEnabled:$<HTMLInputElement>('memory-on').checked},worldScan:state.world?.sonarMap.toJSON(),trackScan:state.track?.sonarMap.toJSON(),racer:state.activeDomain==='world'?{controller:selectedCheckpoint(),vision:currentVision(),memory:$<HTMLInputElement>('memory-on').checked?state.memory.toJSON():null}:undefined,worldMemory:state.worldMemory?.toJSON()??null,worldArena:state.world?validateArena({format:"flykart-world",version:1,world:state.world.episode.sim.world,start:state.world.initialPose}):state.arena,worldTraining:{version:1,task:$<HTMLSelectElement>('world-task').value as 'forage'|'reverse'|'explore',searchWin:$<HTMLSelectElement>('world-search-win').value as 'sight'|'reach',crashWeight:Number($<HTMLInputElement>('world-crash-weight').value)/100,maxTicks:boundedInput('world-train-ticks',300,3000,900),memoryEnabled:$<HTMLInputElement>('world-memory-on').checked,reverseCoach:$<HTMLInputElement>('world-reverse-coach').checked,retainForward:$<HTMLInputElement>('world-retain-forward').checked},
    controller:state.activeDomain==='world'&&world?controllerCheckpoint(world.controller,{domain:'world',fitness:world.fitness,generation:world.generation,trainingRecipe:world.trainingRecipe,provenance:world.provenance}):selectedCheckpoint(),
    vision:state.activeDomain==='world'&&world?world.vision:currentVision(),fusion:{fade:state.fade,mode:state.mode,visionTemperature:1},memory:state.activeDomain!=='world'&&$<HTMLInputElement>('memory-on').checked?state.memory.toJSON():null,
    world:world?{controller:controllerCheckpoint(world.controller,{domain:'world',track:'open world',fitness:world.fitness,generation:world.generation,trainingRecipe:world.trainingRecipe,provenance:world.provenance}),vision:world.vision}:null});
}
function exportVision():void{try{const text=visionBrainText();importFile(text);download(state.activeDomain==='world'?'flykart-room-brain.json':'flykart-vision-brain.json',text);$('brain-file-status').textContent='Exported validated brain, eyes, settings and scan memory.';}catch(e){$('brain-file-status').textContent=(e as Error).message;}}

/* ------------------------------- boot ------------------------------- */

async function boot(): Promise<void> {
  mountRoomPanel();
  const { assets, problems } = await loadAssets(); state.assets = assets;
  if (!assets.robust && !assets.v1) throw new Error(`No controller could be loaded (${problems.join("; ")}).`);
  const named = TRACKS.filter((track) => !track.id.startsWith("gen-"));
  const generated = Array.from({ length: 3 }, (_, i) => proceduralTrack(40 + i));
  fillSelect($("track-select") as HTMLSelectElement, [...named.map((t) => ({ id: t.id, label: t.name })), ...generated.map((t, i) => ({ id: t.id, label: `Generated track ${i + 1} (never trained on)` }))], "grand-loop");
  refreshBrainSelects({ controller: "robust", eyes: assets.vision ? "bundled" : "none" });
  $("fade-label").textContent = fadeLabel(0); updateModeNote();
  if (!assets.robot) { const option = $<HTMLSelectElement>("profile").querySelector("option[value=robot]") as HTMLOptionElement; option.disabled = true; option.textContent += " (not bundled in this build)"; }
  $<HTMLSelectElement>("profile").addEventListener("change", (event) => setProfile((event.target as HTMLSelectElement).value === "robot" ? "robot" : "kart"));
  $<HTMLInputElement>("sonar-on").addEventListener("change", (event) => { state.sonarOn = (event.target as HTMLInputElement).checked; if(state.track)state.track.settings.sonarOn=state.sonarOn;if(state.world)state.world.settings.sonarOn=state.sonarOn;if (state.track) state.track.driver.options.sonarOff = !state.sonarOn; if (state.world?.driver) state.world.driver.options.sonarOff = !state.sonarOn; });

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => button.addEventListener("click", () => showTab(button.id.replace("tab-btn-", ""))));
  $<HTMLInputElement>("fade").addEventListener("input", (event) => setFade(Number((event.target as HTMLInputElement).value)));
  $("preset-seeing").addEventListener("click", () => setFade(0)); $("preset-both").addEventListener("click", () => setFade(0.75)); $("preset-feeling").addEventListener("click", () => { setFade(1); });
  $<HTMLSelectElement>("track-mode").addEventListener("change", (event) => { state.mode = (event.target as HTMLSelectElement).value as DriverMode; if (state.track) state.track.driver.mode = state.mode; updateModeNote(); });
  for (const id of ["track-select", "track-rivals", "track-objects", "track-object-kind", "race-checkpoints", "race-variation", "track-controller", "track-eyes", "track-walls"]) $(id).addEventListener("change", () => { if(id==="track-objects"&&Number($<HTMLSelectElement>("track-objects").value)>0)state.dormantObstacleCount=Number($<HTMLSelectElement>("track-objects").value);describeBrain(); if (id === "track-select" || id === "track-controller" || id === "track-eyes") state.memory.forget(); buildTrack({ keepMemory: !(id === "track-select" || id === "track-controller" || id === "track-eyes") }); });
  $("track-style").addEventListener("change", () => buildTrack({ keepMemory: true }));
  $("track-restart").addEventListener("click", () => { state.lapsLeft = 0; buildTrack({ keepMemory: true }); setStatus("track", "restarted"); });
  $("track-run").addEventListener("click", () => { if(cameraTraining)return; if (state.track?.done) buildTrack({ keepMemory: true }); state.running.track = !state.running.track; $("track-run").textContent = state.running.track ? "Pause" : "Resume"; setStatus("track", state.running.track ? "driving" : "paused");paintTrack(); });
  $("track-laps").addEventListener("click", () => { if (!currentVision()) { setStatus("track", "choose eyes first: the memory works through the camera"); return; } $<HTMLInputElement>("memory-on").checked = true; state.lapsLeft = 0;$<HTMLInputElement>("multi-lap").checked=true;$<HTMLSelectElement>("lap-target").value="3";experiment.write(experiment.read());buildTrack(); state.running.track = true; $("track-run").textContent = "Pause"; });
  $("memory-forget").addEventListener("click", () => { state.memory.forget(); state.laps = []; state.lapNumber = 0; renderLapTable(); paintTrack(); });
  $("memory-on").addEventListener("change", () => buildTrack({ keepMemory: true }));
  attachJsonImport($<HTMLInputElement>('import-file'), importBrainText, { title: 'Import brain + eyes', trigger: $('import-btn'), busy: () => cameraTraining, onError: message => { $('brain-info').textContent = message;$('brain-file-status').textContent = message; } });
  $("export-vision-btn").addEventListener("click", exportVision);
  $("export-v1-btn").addEventListener("click", () => download("flykart-brain-for-v1.json", exportAsFlyKartV1(selectedCheckpoint())));

  $("world-run").addEventListener("click", () => { if(cameraTraining)return; if (!state.world) buildWorld(); if (state.world?.done) buildWorld(); state.running.world = !state.running.world; $("world-run").textContent = state.running.world ? "Pause" : "Resume"; setStatus("world", state.running.world ? "driving" : "paused"); });
  $("world-new").addEventListener("click", () => {state.arena=null;$<HTMLSelectElement>("world-map-preset").value="procedural"; $<HTMLInputElement>("world-seed").value = String(1 + Math.floor(Math.random() * 99999)); buildWorld(); setStatus("world", "new world"); });
  for (const id of ["world-driver", "world-seed", "world-density", "world-style"]) $(id).addEventListener("change", () => { buildWorld(); setStatus("world", "ready"); });
  $("world-fade").addEventListener("input", () => { if (state.world?.driver) state.world.driver.fusion.fade = Number($<HTMLInputElement>("world-fade").value); });

  mountTrainingTools();
  $("how").innerHTML = HOW_IT_WORKS;
  $("evidence").innerHTML = renderEvidence(assets.results, assets.controllerResults, assets.robotResults);
  experiment=mountExperimentPanel(baseProfile,()=>{state.running.track=false;state.running.world=false;$("track-run").textContent="Start";buildTrack();if(state.world)buildWorld();});
  $("copy-sensor-log").onclick=()=>{void navigator.clipboard.writeText(sensorLog.join("\n")).then(()=>$("copy-sensor-log").textContent="Copied").catch(()=>{($('sensor-log') as HTMLTextAreaElement).select();$("copy-sensor-log").textContent="Select logs · Ctrl+C";});};
  $("clear-sensor-log").onclick=()=>{sensorLog.length=0;($('sensor-log') as HTMLTextAreaElement).value='';};
  $("camera-train").onclick=()=>{void runCameraTraining();};$("camera-train-stop").onclick=()=>{cancelTraining=true;$("camera-train-status").textContent='Cancelling after the current tick…';};
  $("camera-train-adopt").onclick=()=>{if(!trainedCamera||!trainedContext||!trainedExperiment)return;state.profile=trainedContext.profile?.id??'kart';$<HTMLSelectElement>('profile').value=state.profile;state.sonarOn=trainedContext.sonarOn!==false;$<HTMLInputElement>('sonar-on').checked=state.sonarOn;experiment.write(trainedExperiment);
    $<HTMLSelectElement>('track-select').value=trainedContext.trackId;
    $<HTMLSelectElement>('track-rivals').value=String(trainedContext.rivals);
    $<HTMLSelectElement>('track-objects').value=String(trainedContext.objects);
    $<HTMLSelectElement>('track-object-kind').value=trainedContext.objectKind??'mixed';
    $<HTMLInputElement>('track-style').value=String(trainedContext.style);
    $<HTMLInputElement>('track-walls').checked=trainedContext.walls;
    $<HTMLInputElement>('race-checkpoints').value=String(trainedContext.checkpointCount??8);
    $<HTMLInputElement>('race-variation').value=String((trainedContext.physicsVariation??0)*100);
    state.importedVision=trainedContext.vision;state.imported={name:'Camera-trained offspring',fitness:trainedCamera.score,generation:trainedParentGeneration+trainedCamera.generation,snapshot:trainedCamera.brain,info:'Selected with camera-only inputs. See the training report for held-out scores.'};refreshBrainSelects({controller:'imported',eyes:'imported'});setFade(0);state.mode='belief';$<HTMLSelectElement>('track-mode').value='belief';$<HTMLInputElement>('memory-on').checked=false;buildTrack();};
  $("camera-report").onclick=()=>{if(trainedCamera)download('flykart-camera-training.json',JSON.stringify({...trainedCamera,experiment:trainedExperiment,context:trainedContext,notes:'Camera weights frozen; sensor-only neural inputs. Small paired validation is not deployment proof.'},null,2));};
  mountBrainShelf($('import-btn').closest('section')??$('import-btn').parentElement!,'vision',visionBrainText,importBrainText,()=>cameraTraining);
  document.querySelector('.profile-bar')!.after(document.querySelector('.browser-brain-shelf')!);
  $('add-sonar-inputs').onclick=()=>{if(cameraTraining)return;if(state.profile!=='robot'){setStatus('track','Select the Robot sensor head first.');return;}const snapshot=widenBrain(currentController());state.imported={...($<HTMLSelectElement>('track-controller').value==='imported'?state.imported:null),name:'Racer + sonar inputs',snapshot,info:'Original weights retained; two sonar rows start at zero. Train camera offspring to learn how to use them.'};refreshBrainSelects({controller:'imported'});buildTrack();};
  explainControls(document.querySelector("main")!);
  installSettingsHistory(document.querySelector('main')!,()=>{state.profile=$<HTMLSelectElement>('profile').value as 'kart'|'robot';state.sonarOn=$<HTMLInputElement>('sonar-on').checked;state.mode=$<HTMLSelectElement>('track-mode').value as DriverMode;setFade(Number($<HTMLInputElement>('fade').value));state.running.track=false;state.running.world=false;buildTrack();if(state.world)buildWorld();},()=>cameraTraining);
  const trackSection=$("track-select").closest("section")!;document.querySelector("#tab-track aside")!.prepend(trackSection);
  mountMapPicker($<HTMLSelectElement>("track-select"),()=>TRACKS);
  organizeVision(()=>{if(state.tab==='track')paintTrack();else if(state.tab==='world')paintWorld();});
  document.querySelector('.profile-bar')!.after(document.querySelector('.settings-history')!);
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


async function runCameraTraining():Promise<void>{
  if(cameraTraining)return;
  trainedCamera=null;trainedContext=null;trainedExperiment=null;
  $<HTMLButtonElement>('camera-train-adopt').disabled=true;$<HTMLButtonElement>('camera-report').disabled=true;
  try{
    if(!currentVision())throw new Error('Choose a camera network first.');
    trainedExperiment=structuredClone(experiment.read());state.running.track=false;state.running.world=false;$("track-run").textContent="Start";$("world-run").textContent="Start";trainedParentGeneration=$<HTMLSelectElement>('track-controller').value==='imported'?(state.imported?.generation??0):0;cameraTraining=true;cancelTraining=false;trainedCamera=null;
    const settings={...state.track!.settings,controller:currentController(),vision:currentVision(),maxTicks:Number($<HTMLInputElement>('camera-train-ticks').value)};
    trainedContext={...settings,memory:null,fade:0,mode:'belief',sensorOnly:true};
    if(!Number.isInteger(settings.maxTicks)||settings.maxTicks<300||settings.maxTicks>3000)throw new Error('Training budget must be 300–3000 ticks per lap.');
    const generations=Number($<HTMLInputElement>('camera-generations').value),population=Number($<HTMLInputElement>('camera-population').value);
    if(!Number.isInteger(generations)||generations<1||generations>50||!Number.isInteger(population)||population<2||population>16)throw new Error('Use 1–50 generations and 2–16 candidates.');
    const controls=Array.from(document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('main input,main select,main button')).filter(e=>!['camera-train-stop','copy-sensor-log','clear-sensor-log'].includes(e.id)),disabled=controls.map(e=>e.disabled);
    controls.forEach(e=>e.disabled=true);$<HTMLButtonElement>('camera-train-stop').disabled=false;
    try{trainedCamera=await trainCameraController(settings,generations,population,()=>cancelTraining,line=>{$('camera-train-status').textContent=line;logSensor(line);},(sessions,generation,seed)=>{paintTrack(sessions[0],sessions);renderGhostScores('camera-ghost-scores',sessions.map((s,i)=>`${i+1} · ${(s.episode.car.totalProgress*100).toFixed(0)}% · ${(s.episode.tick/30).toFixed(1)} s · ${s.episode.car.collisions} contacts`),generation,seed);},Number($<HTMLSelectElement>('camera-train-speed').value));}
    finally{controls.forEach((e,i)=>e.disabled=disabled[i]);$<HTMLButtonElement>('camera-train-stop').disabled=true;}
    $<HTMLButtonElement>('camera-train-adopt').disabled=!trainedCamera;$<HTMLButtonElement>('camera-report').disabled=!trainedCamera;
    $('camera-train-status').textContent=trainedCamera?`Training complete. Held-out parent ${trainedCamera.validation.parent.toFixed(2)}, offspring ${trainedCamera.validation.offspring.toFixed(2)}. Review before adopting.`:'Training cancelled; original controller kept.';
  }catch(e){$('camera-train-status').textContent=(e as Error).message;}
  finally{cameraTraining=false;}
}

function logFreshPing(session:TrackSession):void{
  const episode=session.episode,car=episode.car,reading=episode.sonar();if(!reading||!episode.sonarUnit)return;
  if(loggedPing!==episode.sonarUnit.count){loggedPing=episode.sonarUnit.count;logSensor(`t=${(episode.tick/30).toFixed(3)}s ping=${loggedPing} ${reading.echo?`range=${(reading.range*CM_PER_PIXEL).toFixed(2)}cm strength=${reading.strength.toFixed(3)}`:'NO_ECHO'} speed=${car.speed.toFixed(2)} collisions=${car.collisions} painCost=${car.rewardTotals.collision.toFixed(3)}`);}
}


function worldScene(){
  const kind=$<HTMLSelectElement>('world-map-preset').value;
  if(kind==='imported')return state.arena?.world;
  if(['room','workshop','bedroom'].includes(kind))return generateClutter(Number($<HTMLInputElement>('world-seed').value),Number($<HTMLInputElement>('world-density').value),kind as 'room'|'workshop'|'bedroom');
  if(kind==='clear')return {seed:Number($<HTMLInputElement>('world-seed').value),half:460,obstacles:[],patches:[]};
  return undefined;
}
function renderWorldPreviews():void{
  const strip=$('world-map-previews');strip.replaceChildren();
  for(const [kind,label] of [['procedural','Meadow'],['clear','Practice'],['woods','Woodland'],['room','Living room'],['workshop','Workshop'],['bedroom','Bedroom'],...(state.arena?[['imported','Your scene']]:[])]){
    const b=document.createElement('button');b.className='map-thumbnail';b.setAttribute('aria-pressed',String($<HTMLSelectElement>('world-map-preset').value===kind));
    const c=document.createElement('canvas');c.width=112;c.height=74;const ctx=c.getContext('2d')!;ctx.fillStyle='#254936';ctx.fillRect(0,0,112,74);
    const world=kind==='imported'?state.arena!.world:kind==='clear'?{half:460,obstacles:[],patches:[]}:['room','workshop','bedroom'].includes(kind)?generateClutter(Number($<HTMLInputElement>('world-seed').value),Number($<HTMLInputElement>('world-density').value),kind as 'room'|'workshop'|'bedroom'):generateWorld(Number($<HTMLInputElement>('world-seed').value),kind==='woods'?1:Number($<HTMLInputElement>('world-density').value));
    ctx.save();ctx.translate(56,37);ctx.scale(34/world.half,34/world.half);
    for(const p of world.patches){ctx.fillStyle=p.kind==='water'?'#548fbc':p.kind==='sand'?'#bda874':'#71523e';ctx.beginPath();ctx.arc(p.x,p.y,p.radius,0,Math.PI*2);ctx.fill();}
    for(const o of world.obstacles){ctx.fillStyle=furniture(o)?'#c9a279':o.kind==='shoe'?'#cf754d':o.kind==='mat'?'#99705e':o.kind==='cable'?'#d9ce96':o.kind==='tree'?'#79a94c':'#bbc1bc';if(furniture(o))ctx.fillRect(o.x-o.radius,o.y-o.radius*.65,o.radius*2,o.radius*1.3);else{ctx.beginPath();ctx.arc(o.x,o.y,o.radius,0,Math.PI*2);ctx.fill();}}ctx.restore();
    const text=document.createElement('span');text.textContent=label;b.append(c,text);b.onclick=()=>{if(cameraTraining)return;$<HTMLSelectElement>('world-map-preset').value=kind;$('world-map-preset').dispatchEvent(new Event('change',{bubbles:true}));};strip.append(b);
  }
}
function renderGhostScores(id:string,rows:string[],generation:number,seed:number):void{
  const panel=$(id);panel.replaceChildren();const title=document.createElement('strong');title.textContent=`${generation?'Generation '+generation:'Held-out comparison'} · seed ${seed}`;panel.append(title);
  rows.forEach((row,i)=>{const p=document.createElement('div');p.textContent=row;p.style.borderLeft=`3px solid ${GHOST_COLORS[i%GHOST_COLORS.length]}`;panel.append(p);});
}
function readWorldSetup():WorldSetup{
  return validateWorldSetup({version:1,seed:Number($<HTMLInputElement>('world-seed').value),density:Number($<HTMLInputElement>('world-density').value),style:Number($<HTMLInputElement>('world-style').value),driver:$<HTMLSelectElement>('world-driver').value,fade:Number($<HTMLInputElement>('world-fade').value),goalPreset:$<HTMLSelectElement>('world-goal-preset').value,mapPreset:$<HTMLSelectElement>('world-map-preset').value,memoryCount:Number($<HTMLSelectElement>('world-memory-count').value),sonarOn:state.sonarOn,trailVisible:$<HTMLInputElement>('world-trail-visible').checked});
}
function writeWorldSetup(s:WorldSetup):void{
  for(const [id,value] of Object.entries({'world-seed':s.seed,'world-density':s.density,'world-style':s.style,'world-driver':s.driver,'world-fade':s.fade,'world-goal-preset':s.goalPreset,'world-map-preset':s.mapPreset,'world-memory-count':s.memoryCount}))$<HTMLInputElement|HTMLSelectElement>(id).value=String(value);
  $<HTMLSelectElement>('world-map-preset').querySelector<HTMLOptionElement>('option[value=imported]')!.disabled=!state.arena;
  state.sonarOn=s.sonarOn;$<HTMLInputElement>('sonar-on').checked=s.sonarOn;$<HTMLInputElement>('world-trail-visible').checked=s.trailVisible;
}
function scanOptions(domain:'track'|'world'):{mode:'perspective'|'top';history:boolean;beam:boolean}{return{mode:$<HTMLSelectElement>(domain+'-scan-view').value as 'perspective'|'top',history:$<HTMLInputElement>(domain+'-scan-history').checked,beam:$<HTMLInputElement>(domain+'-scan-beam').checked};}
function mountScanControls():void{
  for(const domain of ['track','world'] as const){
    const paint=()=>domain==='track'?paintTrack():paintWorld();
    for(const id of ['view','history','beam'])$(domain+'-scan-'+id).addEventListener('change',paint);
    $(domain+'-scan-clear').onclick=()=>{state[domain]?.sonarMap.clear();paint();};
    $(domain+'-scan-export').onclick=()=>{const map=state[domain]?.sonarMap;if(map)download('flykart-'+domain+'-scan-map.json',JSON.stringify(map.toJSON(),null,2));};
  }
}
function mountBrainFiles():void{
  const bar=document.createElement('section');bar.className='brain-file-bar';bar.setAttribute('aria-label','Brain import and export');
  bar.innerHTML='<div><strong>Brain files</strong><small>Available in Track and Open world · import again at any time</small></div><div class="button-row"><button id="brain-import-always" class="primary">Import brain + eyes…</button><button id="brain-export-always">Export current brain + setup</button><button id="brain-json-copy">Copy export JSON</button></div><p id="brain-file-status" role="status">Choose a saved brain or use a bundled controller.</p>';
  document.querySelector('.profile-bar')!.after(bar);
  $('brain-import-always').onclick=()=>{if(!cameraTraining)$('import-btn').click();};$('brain-export-always').onclick=exportVision;
  $('brain-json-copy').onclick=()=>{try{const text=visionBrainText();importFile(text);if(!navigator.clipboard?.writeText){showExportText(text);return;}void navigator.clipboard.writeText(text).then(()=>$('brain-file-status').textContent='Complete export JSON copied. Paste it into Import on another device.').catch(()=>showExportText(text));}catch(e){$('brain-file-status').textContent=(e as Error).message;}};
}
function showExportText(text:string):void{
  let dialog=document.getElementById('brain-export-dialog') as HTMLDialogElement|null;
  if(!dialog){dialog=document.createElement('dialog');dialog.id='brain-export-dialog';dialog.className='json-import-dialog';dialog.innerHTML='<h2>Copy exported brain JSON</h2><p>Automatic clipboard access is unavailable. Select this complete JSON and copy it manually.</p><textarea aria-label="Exported brain JSON" readonly></textarea><button type="button">Close</button>';dialog.querySelector('button')!.onclick=()=>dialog!.close();document.body.append(dialog);}
  dialog.querySelector('textarea')!.value=text;dialog.showModal();dialog.querySelector('textarea')!.select();
}
function mountTrainingTools():void{
  mountBrainFiles();mountScanControls();
  $('world-goal-preset').addEventListener('change',()=>{try{buildWorld();setStatus('world','Goal preset ready');}catch(e){setStatus('world',(e as Error).message);}});
  $('world-goal-shuffle').onclick=()=>{if(cameraTraining)return;$<HTMLInputElement>('world-seed').value=String(1+Math.floor(Math.random()*999999));try{buildWorld();setStatus('world','New target positions · map regenerated only for procedural maps');}catch(e){setStatus('world',(e as Error).message);}};
  $('memory-count').addEventListener('change',()=>buildTrack({keepMemory:true}));
  $('world-eye-layout').addEventListener('change',()=>{if(cameraTraining)return;const next=experiment.applied();next.visual={...next.visual,layout:$<HTMLSelectElement>('world-eye-layout').value as RacingSettings['visual']['layout']};experiment.write(next);state.worldMemory=null;buildWorld();});
  $('world-clutter-new').onclick=()=>{if(cameraTraining)return;const picker=$<HTMLSelectElement>('world-map-preset');if(!['room','workshop','bedroom'].includes(picker.value))picker.value='room';$<HTMLInputElement>('world-seed').value=String(1+Math.floor(Math.random()*999999));state.worldMemory=null;buildWorld();setStatus('world','New seeded clutter; selected room type kept.');};
  $('world-clearance-apply').onclick=()=>{if(cameraTraining||!state.world)return;try{const cm=Number($<HTMLInputElement>('world-clearance').value);if(!Number.isFinite(cm)||cm<0||cm>26)throw Error('Clearance must be 0–26 cm.');const world=structuredClone(state.world.episode.sim.world);for(const o of world.obstacles)if(furniture(o))o.clearance=Math.min(cm/1.1,o.height-.5);state.arena=validateArena({format:'flykart-world',version:1,world,start:state.world.initialPose});const picker=$<HTMLSelectElement>('world-map-preset');picker.querySelector<HTMLOptionElement>('option[value=imported]')!.disabled=false;picker.value='imported';state.worldMemory=null;buildWorld();setStatus('world','Furniture clearance applied; layout preserved as Your scene.');}catch(e){setStatus('world',(e as Error).message);}};
  $('world-map-preset').addEventListener('change',()=>{if(cameraTraining)return;const kind=$<HTMLSelectElement>('world-map-preset').value;if(kind==='woods')$<HTMLInputElement>('world-density').value='1';else if(kind==='procedural')$<HTMLInputElement>('world-density').value='.6';try{buildWorld();}catch(e){setStatus('world',(e as Error).message);}});
  $('world-goal-behind').onclick=()=>{if(cameraTraining||!state.world)return;const sim=state.world.episode.sim;try{reverseGoal(sim.world,sim.kart);state.arena=validateArena({format:'flykart-world',version:1,world:sim.world,start:{x:sim.kart.x,y:sim.kart.y,heading:sim.kart.heading}});$<HTMLSelectElement>('world-map-preset').querySelector<HTMLOptionElement>('option[value=imported]')!.disabled=false;$<HTMLSelectElement>('world-map-preset').value='imported';$<HTMLSelectElement>('world-task').value='reverse';buildWorld();setStatus('world','Fixed goal behind the start · ready');}catch(e){setStatus('world',(e as Error).message);}};
  $('world-search-win').addEventListener('change',()=>{try{buildWorld();}catch(e){setStatus('world',(e as Error).message);}});
  $('world-task').addEventListener('change',()=>{try{buildWorld();}catch(e){setStatus('world',(e as Error).message);}});
  $('world-memory-count').addEventListener('change',()=>{state.worldMemory=null;buildWorld();});$('world-memory-on').addEventListener('change',()=>buildWorld());$('world-memory-forget').onclick=()=>{state.worldMemory=state.worldMemory?.fresh()??null;buildWorld();};
  $('world-export-brain').onclick=exportVision;
  $('world-copy-logs').onclick=()=>{void navigator.clipboard.writeText(sensorLog.join('\n')).then(()=>$('world-copy-logs').textContent='Copied').catch(()=>{$<HTMLTextAreaElement>('world-sensor-log').select();$('world-copy-logs').textContent='Select logs · Ctrl+C';});};$('world-clear-logs').onclick=()=>{sensorLog.length=0;logSensor('Room console cleared.');};
  $('world-trail-visible').addEventListener('change',()=>paintWorld());$('world-trail-clear').onclick=()=>{if(state.world)state.world.trail.splice(0,state.world.trail.length,{x:state.world.episode.sim.kart.x,y:state.world.episode.sim.kart.y});paintWorld();};
  $('world-map-export').onclick=()=>{if(!state.world)return;const sim=state.world.episode.sim;download('flykart-open-world.json',JSON.stringify({format:'flykart-world',version:1,world:sim.world,start:state.world.initialPose},null,2));};
  attachJsonImport($<HTMLInputElement>('world-map-file'),async text=>{const arena=validateArena(JSON.parse(text));state.arena=arena;$<HTMLSelectElement>('world-map-preset').querySelector<HTMLOptionElement>('option[value=imported]')!.disabled=false;$<HTMLSelectElement>('world-map-preset').value='imported';$<HTMLSelectElement>('world-task').value='forage';state.worldMemory=null;buildWorld();},{title:'Import Open world scene',trigger:$('world-map-import'),busy:()=>cameraTraining,onError:message=>setStatus('world',message)});
  const weight=$<HTMLInputElement>('world-crash-weight');weight.oninput=()=>{$('world-weight-label').textContent=`${100-Number(weight.value)}% arrival speed · ${weight.value}% less impact pain`;};
  $('world-adapt-racer').onclick=()=>{if(cameraTraining)return;const parent=selectedCheckpoint(),worldEyes=state.world?.settings.vision??worldExportSource()?.vision;if(!worldEyes){setStatus('world','Load a world camera network first.');return;}state.importedWorld={controller:racerToRoom(parent.network),vision:worldEyes,generation:parent.generation,fitness:0,trainingRecipe:parent.trainingRecipe,provenance:[{context:'racer-to-room',source:'Explicit input remapping; untrained room offspring',trained:false,parent}]};state.robotExtensions=null;state.worldMemory=null;$<HTMLSelectElement>('world-driver').value='vision';buildWorld();setStatus('world','Room offspring created. Racer parent kept; evolve and test before use.');};
  $('world-train').onclick=()=>{void runWorldTraining();};$('world-train-stop').onclick=()=>{cancelTraining=true;$('world-training-status').textContent='Cancelling after the current cohort tick…';};
  $('world-train-report').onclick=()=>{if(trainedWorld)download('flykart-room-training.json',JSON.stringify({...trainedWorld,context:{...trainedWorldContext,roomMemory:undefined},experiment:trainedWorldExperiment,notes:'Frozen eyes; independent ghosts; fresh visual memory; no deployment claim.'},null,2));};
  $('world-train-adopt').onclick=()=>{
    if(!trainedWorld||!trainedWorldContext||!trainedWorldExperiment||cameraTraining)return;
    if(trainedWorld.retention&&!trainedWorld.retention.passed){setStatus('world','Forward regression detected; parent kept. Review the report or train a separate specialist.');return;}
    const c=trainedWorldContext;state.profile=c.profile?.id??'kart';$<HTMLSelectElement>('profile').value=state.profile;state.sonarOn=c.sonarOn!==false;$<HTMLInputElement>('sonar-on').checked=state.sonarOn;experiment.write(trainedWorldExperiment);
    state.importedWorld={controller:trainedWorld.brain,vision:c.vision,fitness:trainedWorld.score,generation:worldParentGeneration+trainedWorld.generation,trainingRecipe:trainedWorldRecipe,provenance:[...trainedWorldProvenance,{context:"world-camera-ghosts",source:trainedWorld.task==='explore'?"Camera pixels + enabled sensors; colour target detector, no compass":"Camera + enabled sensors + goal compass",trained:true,validation:trainedWorld.validation,retention:trainedWorld.retention,crashWeight:trainedWorld.crashWeight,task:trainedWorld.task,coachFrames:trainedWorld.coachFrames}]};state.robotExtensions=null;
    state.arena=c.world?validateArena({format:'flykart-world',version:1,world:c.world,start:c.start??{x:0,y:0,heading:0}}):null;$<HTMLSelectElement>('world-map-preset').value=state.arena?'imported':'procedural';$<HTMLSelectElement>('world-map-preset').querySelector<HTMLOptionElement>('option[value=imported]')!.disabled=!state.arena;
    $<HTMLInputElement>('world-seed').value=String(c.seed);$<HTMLInputElement>('world-density').value=String(c.density);$<HTMLInputElement>('world-style').value=String(c.style);$<HTMLSelectElement>('world-driver').value='vision';$<HTMLSelectElement>('world-goal-preset').value=c.goalPreset??'standard';$<HTMLSelectElement>('world-task').value=c.task??'forage';$<HTMLSelectElement>('world-search-win').value=c.searchWin??'sight';state.worldMemory=null;buildWorld();setStatus('world','Room offspring installed; parent checkpoint unchanged.');
  };
}
async function runWorldTraining():Promise<void>{
  if(cameraTraining)return;trainedWorld=null;trainedWorldContext=null;
  $<HTMLButtonElement>('world-train-adopt').disabled=true;$<HTMLButtonElement>('world-train-report').disabled=true;
  let restore=()=>{};
  try{
    buildWorld();const session=state.world!;
    const generations=boundedInput('world-generations',1,50,3),population=boundedInput('world-population',2,16,5),maxTicks=boundedInput('world-train-ticks',300,3000,900);
    trainedWorldExperiment=structuredClone(experiment.applied());trainedWorldContext={...session.settings,start:session.initialPose,maxTicks,sensorOnly:true,kind:'vision',fade:0,roomMemory:undefined};worldParentGeneration=state.importedWorld?.generation??0;trainedWorldRecipe=state.importedWorld?.trainingRecipe?structuredClone(state.importedWorld.trainingRecipe):undefined;trainedWorldProvenance=structuredClone(state.importedWorld?.provenance??[]);
    const crashWeight=Number($<HTMLInputElement>('world-crash-weight').value)/100;if(!Number.isFinite(crashWeight)||crashWeight<0||crashWeight>1)throw Error('Contact weight must be 0–100%.');
    state.running.track=state.running.world=false;$('track-run').textContent=$('world-run').textContent='Start';cameraTraining=true;cancelTraining=false;
    const controls=Array.from(document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('main input,main select,main button')).filter(e=>!['world-train-stop','copy-sensor-log','clear-sensor-log','world-copy-logs','world-clear-logs'].includes(e.id)),disabled=controls.map(e=>e.disabled);controls.forEach(e=>e.disabled=true);$<HTMLButtonElement>('world-train-stop').disabled=false;restore=()=>{controls.forEach((e,i)=>e.disabled=disabled[i]);$<HTMLButtonElement>('world-train-stop').disabled=true;};
    trainedWorld=await trainWorldController(trainedWorldContext,generations,population,crashWeight,()=>cancelTraining,line=>{logSensor(line);$('world-training-status').textContent=line;},(sessions,generation,seed)=>{paintWorld(sessions[0],sessions);renderGhostScores('world-ghost-scores',sessions.map((s,i)=>s.discovery?`${i+1} · ${s.won?'FOUND / WIN':s.done?(s.found?'seen, no arrival':'not found'):'searching'} · first sight ${s.discovery.firstSightTick===null?'—':(s.discovery.firstSightTick/30).toFixed(2)+' s'} · ${(s.episode.tick/30).toFixed(1)} s · ${s.episode.sim.status.collisions} contacts · pain ${s.episode.sim.status.pain.toFixed(2)} · ${s.discovery.visualViews} views`:`${i+1} · ${s.episode.sim.status.goals>=s.episode.sim.goalLimit?'ARRIVED':s.done?'stopped':'driving'} · targets ${s.episode.sim.status.goals}/${s.episode.sim.goalLimit} · ${(s.episode.tick/30).toFixed(1)} s · ${s.episode.sim.status.collisions} contacts · pain ${s.episode.sim.status.pain.toFixed(2)} · reverse ${(s.reverseDistance*CM_PER_PIXEL/100).toFixed(2)} m`),generation,seed);},Number($<HTMLSelectElement>('world-train-speed').value),$<HTMLInputElement>('world-reverse-coach').checked,$<HTMLInputElement>('world-retain-forward').checked);
    if(trainedWorld){
      const v=trainedWorld.validation,search=trainedWorld.task==='explore';
      const parentWins=v.parentTrials.filter(t=>t.won).length,childWins=v.offspringTrials.filter(t=>t.won).length;
      $('world-training-status').textContent=`Complete. Held-out parent ${v.parent.toFixed(2)}, offspring ${v.offspring.toFixed(2)}. ${search?`Search wins: parent ${parentWins}/${v.seeds.length}, offspring ${childWins}/${v.seeds.length}. ${childWins===0?'No successful held-out search; score changes may reflect camera-view diversity only.':v.offspring>v.parent?'Higher score on this small search test.':'No improvement demonstrated.'}`:v.offspring>v.parent?'Improved on this small test.':'No improvement demonstrated.'} ${trainedWorld.retention?`Forward retention ${trainedWorld.retention.passed?'passed':'FAILED · adoption blocked'}. `:''}Review report before adoption.`;
    }else $('world-training-status').textContent='Cancelled; parent retained.';
  }catch(e){$('world-training-status').textContent=(e as Error).message;}
  finally{restore();cameraTraining=false;$<HTMLButtonElement>('world-train-adopt').disabled=!trainedWorld||trainedWorld.retention?.passed===false;$<HTMLButtonElement>('world-train-report').disabled=!trainedWorld;}
}

function logWorldPing(session:WorldSession):void{
  const first=session.discovery?.firstSightTick;if(first!==null&&first!==undefined&&first!==loggedWorldSight){loggedWorldSight=first;logSensor(`room discovery firstSight=${(first/30).toFixed(3)}s source=processed-RGB confirmed=2-frames compass=off objective=${session.settings.searchWin??'sight'}`);}
  const unit=session.episode.sonarUnit;if(!unit||loggedWorldPing===unit.count)return;
  loggedWorldPing=unit.count;const r=unit.reading;
  logSensor(`room t=${(session.episode.tick/30).toFixed(3)}s ping=${unit.count} ${r.echo?`range=${(r.range*CM_PER_PIXEL).toFixed(2)}cm strength=${r.strength.toFixed(3)}`:'NO_ECHO'} speed=${session.episode.sim.kart.speed.toFixed(2)} contacts=${session.episode.sim.status.collisions} pain=${session.episode.sim.status.pain.toFixed(3)}`);
}
