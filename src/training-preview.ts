import {ParkingSession,type ParkingBrain} from './parking/session';
import {TrackSession,WorldSession,type TrackSettings,type WorldSettings} from './vision/ui/sessions';
import type {ParkingSettings} from './parking/model';

export type TrainingSession=ParkingSession|TrackSession|WorldSession;
export type PreviewState={id:number;settings:Record<string,unknown>;state:Record<string,unknown>;activity:ReturnType<ParkingSession['network']['activity']>;memory?:{count:number;taught:number;confidence:number;recalled:boolean}};
// Observer snapshots omit models, functions and projection banks. They can never drive an agent.
const omit=new Set(['settings','brain','controller','network','perceiver','options','domain','memory','roomMemory','prepared','readers','primary','random']);
const pictures=new Set(['frame','frames','processed','trace','sonarTrace','sonarMap','scan','trail','effects','cameraScene']);
function copy(value:unknown,detailed:boolean):unknown{
  if(typeof value==='function')return undefined;
  if(!value||typeof value!=='object')return value;
  if(ArrayBuffer.isView(value))return value;
  if(value instanceof Map||value instanceof Set)return value;
  if(Array.isArray(value))return value.map(v=>copy(v,detailed));
  const out:Record<string,unknown>={};
  for(const [key,v] of Object.entries(value))if(!omit.has(key)&&(detailed||!pictures.has(key))){const next=copy(v,detailed);if(next!==undefined)out[key]=next;}
  return out;
}
export function capturePreview(s:TrainingSession,id:number,detailed:boolean):PreviewState{
  const settings=Object.fromEntries(Object.entries(s.settings).filter(([k])=>!['controller','vision','memory','roomMemory'].includes(k)));
  const network=s instanceof ParkingSession?s.network:s.controller,memory=s instanceof TrackSession?null:s.memory;
  return{id,settings,state:copy(s,detailed) as Record<string,unknown>,activity:network.activity(),...(memory?{memory:{count:memory.count,taught:memory.taught,confidence:memory.confidence,recalled:memory.recalled}}:{})};
}
/** Patch data into existing observer prototypes; never restore these snapshots as runnable brains. */
function patch(target:Record<string,unknown>,source:Record<string,unknown>){
  for(const [key,value] of Object.entries(source)){
    const previous=target[key];
    if(value&&previous&&typeof value==='object'&&typeof previous==='object'&&!Array.isArray(value)&&!ArrayBuffer.isView(value)&&!(value instanceof Map)&&!(value instanceof Set))patch(previous as Record<string,unknown>,value as Record<string,unknown>);
    else target[key]=value;
  }
}
export class TrainingPreviews{
  private cache=new Map<number,TrainingSession>();
  constructor(private job:{kind:'parking';brain:ParkingBrain;settings:ParkingSettings}|{kind:'track';settings:TrackSettings}|{kind:'world';settings:WorldSettings}){}
  update(rows:PreviewState[]):TrainingSession[]{
    const ids=new Set(rows.map(r=>r.id));for(const key of this.cache.keys())if(!ids.has(key))this.cache.delete(key);
    return rows.map(row=>{
      let s=this.cache.get(row.id);
      if(!s){
        if(this.job.kind==='parking'){
          const settings={...this.job.settings,...row.settings} as ParkingSettings;
          s=new ParkingSession({...settings,pathReward:false},{...this.job.brain,memory:{...this.job.brain.memory,count:512}},{scene:(row.state.episode as ParkingSession['episode']).scene,learn:false,diagnostics:()=>false});
          Object.assign(s,{settings});Object.assign(s.episode,{settings});
        }else if(this.job.kind==='track')s=new TrackSession({...this.job.settings,...row.settings,memory:null} as TrackSettings);
        else s=new WorldSession({...this.job.settings,...row.settings,roomMemory:null,memorySettings:this.job.settings.memorySettings?{...this.job.settings.memorySettings,count:512}:undefined} as WorldSettings);
        const episode=s.episode;episode.render=()=>episode.frame;
        s.step=()=>{throw Error('Training previews cannot advance simulation.');};this.cache.set(row.id,s);
      }
      patch(s as unknown as Record<string,unknown>,row.state);
      const network=s instanceof ParkingSession?s.network:s.controller;network.activity=()=>row.activity;
      if(row.memory&&!(s instanceof TrackSession)&&s.memory)for(const [key,value] of Object.entries(row.memory))Object.defineProperty(s.memory,key,{value,configurable:true});
      return s;
    });
  }
}
