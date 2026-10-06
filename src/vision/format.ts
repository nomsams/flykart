import { ArenaFile, validateArena } from './world/arena';
import { RoomMemory, RoomMemorySnapshot } from '../robot/memory';
import { SonarHistory, ScanSnapshot } from './sonar-history';
import { GoalPreset } from './world/world';
// Files FlyKart Vision reads and writes.
//
//   flykart-brain          the original FlyKart checkpoint: a 17 -> 48 -> 4 spiking controller.
//                          Importing one gives the controller; the bundled eyes are used until you load your own.
//   flykart-vision-brain   a controller *plus* eyes: the embedded controller is itself a complete
//                          flykart-brain, so "Export as FlyKart v1 brain" hands the original app exactly what it expects.
//   flykart-vision-net     just a camera network.
//
// A controller may also read a sonar (19 inputs instead of 17). Such a brain, and a vision brain made for the
// "robot" sensor profile, carry that in the file; exporting for the original FlyKart drops the sonar inputs.
import { BrainSnapshot, SpikingNetwork } from "../core";
import { BrainMeta, parseBrainFile } from "../lab";
import { RacingSettings, validateRacingSettings } from "./racing-settings";
import { narrowBrain } from "./inputs";
import type { DriverMode } from "./pipeline";
import { MemorySnapshot, MushroomBody } from "./memory";
import { VisionModel, validateVisionModel } from "./perception";
import { TrainingRecipe, validateRecipe } from '../training-recipe';

export type ControllerCheckpoint = {
  format: "flykart-brain"; version: number; savedAt: string; fitness: number; generation: number; track: string;
  domain?: "track" | "world";
  provenance?: unknown[]; lineage?: unknown;
  network: BrainSnapshot;
  trainingRecipe?: TrainingRecipe;
};

export type RoomTrainingSettings={version:1;task:"forage"|"reverse"|"explore";searchWin?:"sight"|"reach";crashWeight:number;maxTicks:number;memoryEnabled:boolean;reverseCoach:boolean;retainForward?:boolean};
export function validateRoomTraining(raw:unknown):RoomTrainingSettings{const s=raw as RoomTrainingSettings;if(!s||s.version!==1||!["forage","reverse","explore"].includes(s.task)||!Number.isFinite(s.crashWeight)||s.crashWeight<0||s.crashWeight>1||!Number.isInteger(s.maxTicks)||s.maxTicks<300||s.maxTicks>3000||typeof s.memoryEnabled!=="boolean"||typeof s.reverseCoach!=="boolean"||(s.retainForward!==undefined&&typeof s.retainForward!=="boolean")||(s.searchWin!==undefined&&!["sight","reach"].includes(s.searchWin)))throw Error("Invalid room training settings.");return {...s};}

export type FusionSettings = { fade: number; mode: DriverMode; visionTemperature: number };
export type WorldSetup={version:1;seed:number;density:number;style:number;driver:'vision'|'both'|'feeling'|'expert'|'blind';fade:number;goalPreset:GoalPreset;mapPreset:'procedural'|'clear'|'woods'|'imported';memoryCount:number;sonarOn:boolean;trailVisible:boolean};
export function validateWorldSetup(raw:unknown):WorldSetup{
  const s=raw as WorldSetup;
  if(!s||s.version!==1||!Number.isInteger(s.seed)||s.seed<1||s.seed>999999||!Number.isFinite(s.density)||s.density<0||s.density>1||!Number.isFinite(s.style)||s.style<0||s.style>1||!['vision','both','feeling','expert','blind'].includes(s.driver)||!Number.isFinite(s.fade)||s.fade<0||s.fade>1e6||!['standard','near','far','random','pair'].includes(s.goalPreset)||!['procedural','clear','woods','imported'].includes(s.mapPreset)||![512,2048,4096,10000,20000].includes(s.memoryCount)||typeof s.sonarOn!=='boolean'||typeof s.trailVisible!=='boolean')throw Error('Invalid Open world setup.');
  return {...s};
}
export type TrackSetup={version:1;trackId:string;rivals:number;style:number;memoryCount:number;memoryEnabled:boolean};
export function validateTrackSetup(raw:unknown):TrackSetup{const s=raw as TrackSetup;if(!s||s.version!==1||typeof s.trackId!=='string'||s.trackId.length>100||!Number.isInteger(s.rivals)||s.rivals<0||s.rivals>20||!Number.isFinite(s.style)||s.style<0||s.style>1||!Number.isInteger(s.memoryCount)||s.memoryCount<64||s.memoryCount>64000||typeof s.memoryEnabled!=='boolean')throw Error('Invalid Track setup.');return {...s};}

export type VisionBrainFile = {
  format: "flykart-vision-brain"; version: 1; savedAt: string; name: string;
  controller: ControllerCheckpoint;
  /** Which sensor head the file was made for; files from before the sonar omit it and mean "kart". */
  profile?: "kart" | "robot";
  vision: VisionModel | null;
  fusion: FusionSettings;
  memory: MemorySnapshot | null;
  worldMemory?:RoomMemorySnapshot|null;
  worldArena?:ArenaFile|null;
  worldTraining?:RoomTrainingSettings;
  worldSetup?:WorldSetup;
  trackSetup?:TrackSetup;
  worldScan?:ScanSnapshot;
  trackScan?:ScanSnapshot;
  racer?:{controller:ControllerCheckpoint;vision:VisionModel|null;memory:MemorySnapshot|null};
  world: { controller: ControllerCheckpoint; vision: VisionModel | null } | null;
  notes?: string;
  experiment?: RacingSettings;
  /** Habitat extensions are retained by Vision; the habitat validates them on installation. */
  robotLearning?: unknown;
  robotMission?: unknown;
};

export type Imported = {
  trainingRecipe?: TrainingRecipe;
  kind: "v1-brain" | "vision-brain" | "vision-net";
  name: string;
  profile?: "kart" | "robot";
  controller?: { snapshot: BrainSnapshot; meta: BrainMeta; domain: "track" | "world" };
  vision?: VisionModel | null;
  fusion?: FusionSettings;
  memory?: MemorySnapshot | null;
  worldMemory?:RoomMemorySnapshot|null;
  worldArena?:ArenaFile|null;
  worldTraining?:RoomTrainingSettings;
  worldSetup?:WorldSetup;
  trackSetup?:TrackSetup;
  worldScan?:ScanSnapshot;
  trackScan?:ScanSnapshot;
  racer?:{controller:{snapshot:BrainSnapshot;meta:BrainMeta};vision:VisionModel|null;memory:MemorySnapshot|null;trainingRecipe?:TrainingRecipe};
  world?: { controller: { snapshot: BrainSnapshot; meta: BrainMeta }; vision: VisionModel | null;trainingRecipe?:TrainingRecipe } | null;
  experiment?: RacingSettings;
  warnings: string[];
};

const asObject = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Read any FlyKart file: an original brain checkpoint, a vision brain, or a bare vision network. */
export function importFile(text: string): Imported {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("That file is not valid JSON."); }
  const object = asObject(raw);
  if (!object) throw new Error("Expected a JSON object.");
  if (object.format === "flykart-vision-net") {
    return { kind: "vision-net", name: "vision net", vision: validateVisionModel(object), warnings: [] };
  }
  if (object.format === "flykart-vision-brain") {
    const file = object as unknown as VisionBrainFile;
    if(file.version!==1)throw new Error('Unsupported vision brain version.');
    const domain=file.controller?.domain??'track';
    if(!['track','world'].includes(domain)||typeof file.name!=='string')throw new Error('Invalid vision brain name or domain.');
    const controller = parseBrainFile(JSON.stringify(file.controller), { allowSonar: true });
    if(file.profile!==undefined&&!['kart','robot'].includes(file.profile))throw Error('Invalid sensor profile.');
    if(file.worldSetup)validateWorldSetup(file.worldSetup);
    if(file.trackSetup)validateTrackSetup(file.trackSetup);
    if(file.worldSetup?.mapPreset==='imported'&&!file.worldArena)throw Error('Imported map setup is missing its scene.');
    if(file.worldScan)SonarHistory.fromJSON(file.worldScan);
    if(file.trackScan)SonarHistory.fromJSON(file.trackScan);
    if(file.racer){if(file.racer.controller.domain!==undefined&&file.racer.controller.domain!=='track')throw Error('Invalid racer controller domain.');if(file.racer.vision)validateVisionModel(file.racer.vision,'track');if(file.racer.memory)MushroomBody.fromJSON(file.racer.memory);}
    if(file.vision)validateVisionModel(file.vision,domain);
    if(file.world?.controller?.domain!==undefined&&file.world.controller.domain!=='world')throw new Error('Invalid secondary world controller domain.');
    if(file.world?.vision)validateVisionModel(file.world.vision,'world');
    if(file.memory)MushroomBody.fromJSON(file.memory);
    if(file.worldMemory)RoomMemory.fromJSON(file.worldMemory);
    if(file.fusion&&(!['belief','action-average','vision-action'].includes(file.fusion.mode)||!Number.isFinite(file.fusion.fade)||file.fusion.fade<0||!Number.isFinite(file.fusion.visionTemperature)||file.fusion.visionTemperature<=0))throw new Error('Invalid vision fusion settings.');
    const warnings: string[] = [];
    if (!file.vision) warnings.push("This file has a controller but no eyes; select a camera network before using visual control.");
    return {
      kind: "vision-brain", name: file.name ?? "vision brain", profile: file.profile === "robot" ? "robot" : "kart",
      trainingRecipe: file.controller.trainingRecipe === undefined ? undefined : validateRecipe(file.controller.trainingRecipe),
      controller: { snapshot: controller.snapshot, meta: controller.meta, domain: file.controller.domain ?? "track" },
      vision: file.vision ?? null, fusion: file.fusion, memory: file.memory ?? null,worldMemory:file.worldMemory??null,worldArena:file.worldArena?validateArena(file.worldArena):null,worldTraining:file.worldTraining?validateRoomTraining(file.worldTraining):undefined,
      experiment: file.experiment === undefined ? undefined : validateRacingSettings(file.experiment),
      worldSetup:file.worldSetup?validateWorldSetup(file.worldSetup):undefined,trackSetup:file.trackSetup?validateTrackSetup(file.trackSetup):undefined,worldScan:file.worldScan,trackScan:file.trackScan,
      racer:file.racer?{controller:parseBrainFile(JSON.stringify(file.racer.controller),{allowSonar:true}),vision:file.racer.vision??null,memory:file.racer.memory??null,trainingRecipe:file.racer.controller.trainingRecipe?validateRecipe(file.racer.controller.trainingRecipe):undefined}:undefined,
      world: file.world ? { controller: parseBrainFile(JSON.stringify(file.world.controller), { allowSonar: true }), vision: file.world.vision,trainingRecipe:file.world.controller.trainingRecipe===undefined?undefined:validateRecipe(file.world.controller.trainingRecipe) } : null,
      warnings,
    };
  }
  // Anything else must be an original FlyKart brain (or a bare network snapshot): parseBrainFile explains if it is not.
  const brain = parseBrainFile(text, { allowSonar: true });
  if(object.domain!==undefined&&!['track','world'].includes(String(object.domain)))throw new Error('Invalid controller domain.');
  const domain = object.domain === "world" ? "world" : "track";
  const warnings: string[] = [];
  if (brain.meta.upgradedFromLegacy) warnings.push("This is an older FlyKart brain; it was upgraded to the current 17-input format exactly as the original simulator does.");
  if (brain.snapshot.inputCount > 17) warnings.push("This brain also listens to a sonar. Use the robot sensor profile; on the camera-only kart its sonar inputs stay silent.");
  if (domain === "track") warnings.push("This brain was trained on exact simulator numbers. Through a camera it will receive slightly wrong ones, so expect it to drive less smoothly than a brain trained for imperfect eyes.");
  return { kind: "v1-brain", trainingRecipe: object.trainingRecipe === undefined ? undefined : validateRecipe(object.trainingRecipe), name: brain.meta.lineage?.name ?? (brain.meta.generation !== null ? `generation ${brain.meta.generation} brain` : "imported brain"), profile: brain.snapshot.inputCount > 17 ? "robot" : "kart", controller: { snapshot: brain.snapshot, meta: brain.meta, domain }, warnings };
}

export function controllerCheckpoint(network: SpikingNetwork | BrainSnapshot, options: { fitness?: number; generation?: number; track?: string; domain?: "track" | "world"; provenance?: unknown[]; trainingRecipe?: TrainingRecipe } = {}): ControllerCheckpoint {
  const snapshot = network instanceof SpikingNetwork ? network.toJSON() : network;
  return { format: "flykart-brain", version: 2, savedAt: new Date().toISOString(), fitness: options.fitness ?? 0, generation: options.generation ?? 0, track: options.track ?? "all", ...(options.domain ? { domain: options.domain } : {}), ...(options.trainingRecipe ? {trainingRecipe:validateRecipe(options.trainingRecipe)} : {}), provenance: options.provenance ?? [], network: snapshot };
}

export function exportVisionBrain(file: Omit<VisionBrainFile, "format" | "version" | "savedAt">): string {
  const full: VisionBrainFile = { format: "flykart-vision-brain", version: 1, savedAt: new Date().toISOString(), ...file };
  return JSON.stringify(full);
}

/** The controller alone, in the exact shape the original FlyKart's "Import brain" button reads. */
export function exportAsFlyKartV1(controller: ControllerCheckpoint): string {
  if(controller.domain==='world')throw new Error('Room input meanings cannot be exported as a racer. Keep this brain in Vision or the 3D habitat.');
  const { domain: _domain, ...plain } = controller;
  return JSON.stringify({ ...plain, network: narrowBrain(plain.network) }, null, 2);
}
