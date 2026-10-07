import type { StallSettings } from '../stall';
import { RoomMemory, MemorySettings } from '../../robot/memory';
import { WorldDef } from '../world/world';
import { reverseGoal } from '../world/arena';
import { FlagDiscovery, SearchWin } from '../world/discovery';
import { SonarHistory } from '../sonar-history';
// A running drive: the simulation, the driver and the little bits of history the dashboards plot.
import { Action, BrainSnapshot, SpikingNetwork, TRACKS, TrackDefinition, RewardConfig, RoadObjectKind } from "../../core";
import { trackDomain, worldDomain } from "../domains";
import { TrackEpisode } from "../episode";
import { ESTIMATE_NAMES } from "../interface";
import { MushroomBody } from "../memory";
import { Perceiver, VisionModel } from "../perception";
import { DriverMode, VisionDriver } from "../pipeline";
import { WORLD_CAMERA, WorldEpisode, worldExpert } from "../world/worldDomain";
import { SECTORS } from "../world/world";
import type { SonarSample, TraceSample } from "./draw";
import type { RacingSettings } from "../racing-settings";
import { CM_PER_PIXEL, HC_SR04, SensorProfile, SonarSpec } from "../robot";

export type TrackSettings = {
  trackId: string; rivals: number; objects: number; style: number; walls: boolean;
  controller: BrainSnapshot; vision: VisionModel | null; fade: number; mode: DriverMode; memory: MushroomBody | null;
  seed: number;
  /** Sensor head. Omitted means the camera-only kart. */
  profile?: SensorProfile; sonarOn?: boolean;
  lapTarget?: number; impactPain?: boolean; maxTicks?: number; sensorOnly?: boolean; visual?: RacingSettings["visual"]; resolution?: RacingSettings["resolution"];
  cameraNoise?:number; cameraBrightness?:number;stall?:StallSettings;
  rewardConfig?: RewardConfig; objectKind?: RoadObjectKind | 'mixed'; checkpointCount?: number; physicsVariation?: number;
};

const FAR = ESTIMATE_NAMES.indexOf("curveFar");
/** The four road-geometry estimates the lap memory supplies. */
const GEOMETRY = ["headingError", "curvature", "curveNear", "curveFar"].map((name) => ESTIMATE_NAMES.indexOf(name as never));

export type LapRecord = { lap: number; finished: boolean; seconds: number; progress: number; offRoad: number; memoryError: number | null; errorCamera: number; errorUsed: number; remembering: boolean };

export class TrackSession {
  readonly route: TrackDefinition;
  readonly episode: TrackEpisode;
  readonly driver: VisionDriver;
  readonly controller: SpikingNetwork;
  readonly perceiver: Perceiver | null;
  readonly trace: TraceSample[] = [];
  readonly sonarTrace: SonarSample[] = [];
  readonly sonarMap=new SonarHistory();
  stallPain=0;
  lastTruth: number[] = new Array(13).fill(0);
  private sonarCount = 0;
  private cameraErrorSum = 0; private usedErrorSum = 0; private errorCount = 0;

  constructor(readonly settings: TrackSettings) {
    this.route = TRACKS.find((track) => track.id === settings.trackId) ?? TRACKS[0];
    this.controller = SpikingNetwork.fromJSON(settings.controller);
    this.perceiver = settings.vision ? new Perceiver(settings.vision) : null;
    this.episode = new TrackEpisode({ track: this.route, rivals: settings.rivals, roadObjects: settings.objects, objectKind: settings.objectKind ?? "mixed", rewardConfig:settings.rewardConfig,checkpointCount:settings.checkpointCount,physicsVariation:settings.physicsVariation,seed: settings.seed, styleStrength: settings.style, cameraNoise:settings.cameraNoise,cameraBrightness:settings.cameraBrightness,walls: settings.walls, maxTicks: settings.maxTicks ?? 7000, lapTarget:settings.lapTarget, impactPain:settings.impactPain, headless: false, profile: settings.profile });
    this.episode.car.network = this.controller;
    this.driver = new VisionDriver({
      stall:settings.stall,sensorOnly:settings.sensorOnly, visual:settings.visual, resolution:settings.resolution,
      perceiver: this.perceiver, controller: this.controller, domain: trackDomain, mode: settings.mode, fusion: { fade: settings.fade },
      memory: this.perceiver ? settings.memory : null, feelingController: this.controller.clone(), sonarOff: settings.sonarOn === false,
    });
    this.driver.reset();
    this.lastTruth = this.episode.truth();
    this.sonarMap.record(this.episode.sonarUnit,{x:this.episode.car.position.x,y:this.episode.car.position.y,heading:this.episode.car.heading},settings.sonarOn!==false);
    this.episode.render();
  }

  get done(): boolean { return this.episode.done; }

  step(): void {
    const previousLaps=this.episode.car.laps;
    const frame = this.driver.act(this.episode);
    if (frame.seen && frame.perception) {
      const truth = this.episode.truth(this.lastTruth);
      const memory = this.driver.memoryCue;
      this.trace.push({ truth: truth[FAR], camera: frame.perception.mean[FAR], memory: memory && memory.variance[FAR] < 1e5 ? memory.mean[FAR] : null, used: frame.fused.mean[FAR] });
      if (this.trace.length > 240) this.trace.shift();
      for (const c of GEOMETRY) { this.cameraErrorSum += Math.abs(frame.perception.mean[c] - truth[c]); this.usedErrorSum += Math.abs(frame.fused.mean[c] - truth[c]); }
      this.errorCount += GEOMETRY.length;
    }
    this.episode.step(frame.action);
    const pain=this.driver.stall?.painForTick(this.episode.tick)??0;this.stallPain+=pain;const cost=pain*12;this.episode.car.score-=cost;this.episode.car.rewardTotals.standingStill+=cost;
    if(this.episode.car.laps>previousLaps&&!this.episode.done)this.settings.memory?.beginLap();
    const reading = this.episode.sonar();
    if (reading && this.episode.sonarUnit!.count !== this.sonarCount) { this.sonarCount=this.episode.sonarUnit!.count; this.sonarMap.record(this.episode.sonarUnit!,{x:this.episode.car.position.x,y:this.episode.car.position.y,heading:this.episode.car.heading},this.driver.options.sonarOff!==true); this.sonarTrace.push({ cm: reading.range * CM_PER_PIXEL, echo: reading.echo, strength: reading.strength }); if (this.sonarTrace.length > 240) this.sonarTrace.shift(); }
  }

  lap(lapNumber: number): LapRecord {
    const car = this.episode.car; const memory = this.settings.memory;
    return {
      lap: lapNumber, finished: car.finished, seconds: car.ticks / 30, progress: car.totalProgress, offRoad: car.offTrackTicks / Math.max(1, car.ticks),
      memoryError: memory && this.perceiver ? memory.stats.lapAbsError : null,
      errorCamera: this.cameraErrorSum / Math.max(1, this.errorCount), errorUsed: this.usedErrorSum / Math.max(1, this.errorCount), remembering: Boolean(memory && memory.remembering),
    };
  }
}

export type WorldDriverKind = "vision" | "both" | "feeling" | "expert" | "blind";
export type WorldSettings = { seed: number; density: number; style: number; kind: WorldDriverKind; scanSonar?:SonarSpec; fade: number; controller: BrainSnapshot; vision: VisionModel | null; profile?: SensorProfile; sonarOn?: boolean; visual?:RacingSettings["visual"]; resolution?:RacingSettings["resolution"]; cameraNoise?:number;cameraBrightness?:number;stall?:StallSettings;maxTicks?:number; goals?:{x:number;y:number}[]; goalPreset?:import("../world/world").GoalPreset; goalCount?:import("../world/world").GoalCount;goalRadius?:number; task?:"forage"|"reverse"|"explore"; searchWin?:SearchWin; world?:WorldDef; start?:{x:number;y:number;heading:number}; memorySettings?:MemorySettings; roomMemory?:RoomMemory|null; sensorOnly?:boolean; practiceForward?:boolean };

export class WorldSession {
  readonly episode: WorldEpisode;
  readonly controller: SpikingNetwork;
  readonly driver: VisionDriver | null;
  lastTruth: number[] = new Array(SECTORS + 1).fill(0);
  readonly trail:{x:number;y:number}[]=[];
  readonly sonarMap=new SonarHistory();
  stallPain=0;
  readonly memory:RoomMemory|null;
  readonly initialPose:{x:number;y:number;heading:number};
  readonly discovery:FlagDiscovery|null;
  searchesCompleted=0;
  searchStartTick=0;
  reverseDistance=0;
  lastAction: Action = { steer: 0, throttle: 0, brake: 0, reverse: 0 };

  constructor(readonly settings: WorldSettings) {
    const explore=settings.task==='explore';
    if(explore){settings={...settings,kind:'vision',fade:0,sensorOnly:true};this.settings=settings;if(!settings.vision)throw Error('Exploration requires a world camera network.');}
    // Saved compass scenes may contain multiple dots. Visual search must retain
    // just its first saved flag and finish one search before generating another.
    const goals=explore?settings.goals?.slice(0,1):settings.goals;
    const camera=settings.profile?.worldCamera??WORLD_CAMERA;
    this.discovery=explore?new FlagDiscovery(settings.vision!.spec.width,settings.vision!.spec.height,camera.hfov):null;
    this.controller = SpikingNetwork.fromJSON(settings.controller);
    this.episode = new WorldEpisode({ seed: settings.seed, density: settings.density, styleStrength: settings.style,cameraNoise:settings.cameraNoise,cameraBrightness:settings.cameraBrightness, camera: WORLD_CAMERA, maxTicks: settings.maxTicks??4200, world:settings.world,start:settings.start,goals,goalCount:explore?1:settings.task==='reverse'?1:settings.goalCount,goalRadius:settings.goalRadius,goalLimit:goals?.length,goalPreset:settings.task==='reverse'?'near':explore&&settings.goalPreset==='pair'?'random':settings.goalPreset,hiddenGoalAngle:explore?Math.min(Math.PI-.01,camera.hfov/2+.25):undefined, scanSonar:settings.scanSonar??HC_SR04, profile: settings.profile });
    this.initialPose={x:this.episode.sim.kart.x,y:this.episode.sim.kart.y,heading:this.episode.sim.kart.heading};
    if(settings.task==='reverse'||settings.task==='forage'||settings.sensorOnly){
      let goal=goals?.[0]??(settings.task==='reverse'?reverseGoal(this.episode.sim.world,this.episode.sim.kart):{x:this.episode.sim.status.goalX,y:this.episode.sim.status.goalY});
      if(settings.practiceForward){try{goal=reverseGoal(this.episode.sim.world,{...this.episode.sim.kart,heading:this.episode.sim.kart.heading+Math.PI});}catch{/* A blocked front corridor retains the ordinary seeded navigation goal. */}}
      // Rebuild a fixed-goal episode so arrival ends the trial rather than moving the flag.
      this.episode=new WorldEpisode({...this.episode.options,goal,goals:settings.practiceForward?[goal]:goals??(settings.task==='reverse'?[goal]:this.episode.sim.goals),goalLimit:explore||settings.practiceForward?1:goals?.length??(settings.goalCount!==undefined?this.episode.sim.targetCount:(!explore&&settings.task!=='reverse'&&!settings.practiceForward&&settings.goalPreset==='pair'?2:1))});
    }
    this.memory=settings.roomMemory??(settings.memorySettings?new RoomMemory(settings.memorySettings):null);
    this.trail.push({x:this.episode.sim.kart.x,y:this.episode.sim.kart.y});
    this.sonarMap.record(this.episode.scanSonarUnit,this.episode.sim.kart,settings.sonarOn!==false);
    const needsEyes = settings.kind === "vision" || settings.kind === "both";
    const perceiver = needsEyes && settings.vision ? new Perceiver(settings.vision) : null;
    this.driver = settings.kind === "expert" ? null : new VisionDriver({
      stall:settings.stall,sensorOnly:settings.sensorOnly,missionCue:!explore,pixelMission:this.discovery??undefined,roomMemory:this.memory,perceiver, visual:settings.visual, resolution:settings.resolution, controller: this.controller, domain: worldDomain, blind: settings.kind === "blind", mode: "belief", sonarOff: settings.sonarOn === false,
      fusion: { fade: settings.kind === "both" ? settings.fade : 0 },
    });
    this.driver?.reset();
    this.lastTruth = this.episode.truth();
    this.episode.render();
  }

  get found():boolean {return this.discovery?.firstSightTick!=null;}
  get won():boolean {return this.discovery?this.found&&((this.settings.searchWin??'sight')==='sight'||this.episode.sim.status.goals>=this.episode.sim.goalLimit)&&!this.episode.sim.status.crashed:this.episode.sim.status.goals>=this.episode.sim.goalLimit&&!this.episode.sim.status.crashed;}
  get done(): boolean { return this.episode.done || Boolean(this.discovery&&this.found&&(this.settings.searchWin??'sight')==='sight'); }

  /** Keep the robot, neural state, memory and sensor histories; reset only target tracking. */
  continueSearch():boolean {
    if(this.settings.task==='reverse'||!this.won||!this.episode.sim.renewSearchTarget())return false;
    this.searchesCompleted++;
    this.searchStartTick=this.episode.tick;
    this.discovery?.reset();
    return true;
  }

  step(): void {
    if(this.done)return;
    const before={x:this.episode.sim.kart.x,y:this.episode.sim.kart.y};
    if (this.driver) {
      const frame = this.driver.act(this.episode);
      this.lastAction = frame.action;
      if(this.discovery&&this.found&&(this.settings.searchWin??'sight')==='sight')return;
      this.episode.step(frame.action);
    } else {
      const sensors = worldDomain.sensors(this.episode.truth(this.lastTruth), this.episode.mission(), this.episode.proprioception());
      this.lastAction = worldExpert(sensors); this.episode.step(this.lastAction);
    }
    const pain=this.driver?.stall?.painForTick(this.episode.tick)??0;this.stallPain+=pain;this.episode.sim.status.pain+=pain;this.episode.sim.status.score-=pain*12;
    if(this.episode.sim.status.pain>=8&&!this.episode.sim.status.crashed)this.episode.sim.status.stopReason='Stall pain limit reached; stop motors and try another policy.';
    const kart=this.episode.sim.kart,travel=Math.hypot(kart.x-before.x,kart.y-before.y);
    if(kart.speed<0)this.reverseDistance+=travel;
    const last=this.trail[this.trail.length-1];if(Math.hypot(kart.x-last.x,kart.y-last.y)>=2){this.trail.push({x:kart.x,y:kart.y});if(this.trail.length>4000)this.trail.shift();}
    this.sonarMap.record(this.episode.scanSonarUnit,kart,this.settings.sonarOn!==false&&this.driver?.options.sonarOff!==true);
  }
}
