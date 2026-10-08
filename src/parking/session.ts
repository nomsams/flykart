import {Action,BrainSnapshot,SpikingNetwork,clamp} from '../core';
import {RoomMemory,MemorySettings,DEFAULT_MEMORY} from '../robot/memory';
import {VisionSettings,DEFAULT_VISION} from '../robot/vision-workbench';
import {VisionModel,Perceiver} from '../vision/perception';
import {worldDomain} from '../vision/domains';
import {SECTOR_SPAN} from '../vision/world/world';
import {VisionDriver} from '../vision/pipeline';
import {SonarHistory} from '../vision/sonar-history';
import {CM_PER_PIXEL} from '../vision/robot';
import {DEFAULT_STALL} from '../vision/stall';
import {ParkingSettings,ParkingScene} from './model';
import {ControllerCheckpoint} from '../vision/format';
import {ParkingEpisode,ParkingCue} from './episode';

export type ParkingBrain={controller:BrainSnapshot;eyes:VisionModel;visual:VisionSettings;memory:MemorySettings;metadata?:Pick<ControllerCheckpoint,'generation'|'fitness'|'track'|'trainingRecipe'>};
export const PARKING_VISUAL={...DEFAULT_VISION},PARKING_MEMORY={...DEFAULT_MEMORY};
export const parkingDomain={...worldDomain,title:'Parking · camera + sonar',sensors(estimates:ArrayLike<number>,mission:ArrayLike<number>,body:Parameters<typeof worldDomain.sensors>[2],out?:number[]){
  const s=worldDomain.sensors(estimates,mission,body,out);
  // Same 19-input shape. The open-heading advisory also follows the visible bay direction near the target.
  // Marker confidence/relative angle originate in pixels (or explicitly selected compass localization).
  if(mission[3]>0){const mix=clamp(mission[1]/.5,.25,1);s[15]=s[15]*(1-mix)+clamp(mission[2]*Math.PI/SECTOR_SPAN,-1,1)*mix;}
  return s;
}};
export class ParkingSession{
  readonly episode:ParkingEpisode;readonly network:SpikingNetwork;readonly driver:VisionDriver;readonly cue:ParkingCue;readonly scan=new SonarHistory();readonly memory:RoomMemory;
  constructor(readonly settings:ParkingSettings,readonly brain:ParkingBrain,options:{scene?:ParkingScene;memory?:RoomMemory;learn?:boolean}={}){
    this.network=SpikingNetwork.fromJSON(brain.controller);this.memory=options.memory??new RoomMemory(brain.memory);
    this.episode=new ParkingEpisode(settings,{...brain.eyes.camera,width:brain.eyes.spec.width,height:brain.eyes.spec.height,mountHeight:.065*(100/CM_PER_PIXEL),mountForward:.26*.48*(100/CM_PER_PIXEL)},options.scene);this.cue=new ParkingCue(this.episode.camera);
    this.driver=new VisionDriver({controller:this.network,perceiver:new Perceiver(brain.eyes),domain:parkingDomain,sensorOnly:true,missionCue:settings.cue==='compass',...(settings.cue==='visual'?{pixelMission:this.cue}:{}),roomMemory:this.memory,learnMemory:options.learn!==false&&settings.phase!=='frozen',visual:brain.visual,resolution:'native',fusion:{fade:0},stall:{...DEFAULT_STALL,enabled:true}});
    this.driver.reset();this.scan.record(this.episode.sonarUnit,this.episode.pose);this.driver.act(this.episode);
  }
  get done(){return this.episode.done;}
  step(action?:Action){if(this.done)return;const frame=this.driver.act(this.episode);this.episode.step(action??frame.action);const stall=action?0:this.driver.stall?.painForTick(this.episode.tick)??0;this.episode.status.pain+=stall;this.episode.status.score-=stall*(4+this.settings.crashWeight*60);this.scan.record(this.episode.sonarUnit,this.episode.pose);}
}
