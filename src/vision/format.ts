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

export type FusionSettings = { fade: number; mode: DriverMode; visionTemperature: number };

export type VisionBrainFile = {
  format: "flykart-vision-brain"; version: 1; savedAt: string; name: string;
  controller: ControllerCheckpoint;
  /** Which sensor head the file was made for; files from before the sonar omit it and mean "kart". */
  profile?: "kart" | "robot";
  vision: VisionModel | null;
  fusion: FusionSettings;
  memory: MemorySnapshot | null;
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
    if(file.vision)validateVisionModel(file.vision,domain);
    if(file.world?.controller?.domain!==undefined&&file.world.controller.domain!=='world')throw new Error('Invalid secondary world controller domain.');
    if(file.world?.vision)validateVisionModel(file.world.vision,'world');
    if(file.memory)MushroomBody.fromJSON(file.memory);
    if(file.fusion&&(!['belief','action-average','vision-action'].includes(file.fusion.mode)||!Number.isFinite(file.fusion.fade)||file.fusion.fade<0||!Number.isFinite(file.fusion.visionTemperature)||file.fusion.visionTemperature<=0))throw new Error('Invalid vision fusion settings.');
    const warnings: string[] = [];
    if (!file.vision) warnings.push("This file has a controller but no eyes; the bundled camera network will be used.");
    return {
      kind: "vision-brain", name: file.name ?? "vision brain", profile: file.profile === "robot" ? "robot" : "kart",
      trainingRecipe: file.controller.trainingRecipe === undefined ? undefined : validateRecipe(file.controller.trainingRecipe),
      controller: { snapshot: controller.snapshot, meta: controller.meta, domain: file.controller.domain ?? "track" },
      vision: file.vision ?? null, fusion: file.fusion, memory: file.memory ?? null,
      experiment: file.experiment === undefined ? undefined : validateRacingSettings(file.experiment),
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
