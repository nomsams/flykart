import { Action, clamp } from "../core";
import { mulberry32 } from "../vision/rng";
import type { Pose } from "./model";

export type GroundPoint={x:number;z:number};
export type SugarGoal=GroundPoint&{id:string;yaw:number;radius:number;amount:number};
export type ObjectiveSettings={mode:"explore"|"sugar"|"trail";cue:"paint"|"scent";sugar:number;trailReward:number;pain:number;width:number;decay:number};
export const DEFAULT_OBJECTIVE:ObjectiveSettings={mode:"explore",cue:"paint",sugar:10,trailReward:2,pain:1,width:.18,decay:0};
export type MissionSnapshot={settings:ObjectiveSettings;goals:SugarGoal[];trail:GroundPoint[]};
export function validateMission(raw:unknown):MissionSnapshot {
  const r=raw as MissionSnapshot,s=r?.settings;
  if(!s||!["explore","sugar","trail"].includes(s.mode)||!["paint","scent"].includes(s.cue)||![s.sugar,s.trailReward,s.pain,s.width,s.decay].every(Number.isFinite)||s.sugar<0||s.sugar>100||s.trailReward<0||s.trailReward>20||s.pain<0||s.pain>10||s.width<.05||s.width>.5||s.decay<0||s.decay>1||!Array.isArray(r.goals)||r.goals.length>30||!Array.isArray(r.trail)||r.trail.length>500)throw new Error("Invalid objective configuration.");
  const point=(p:GroundPoint)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.z)&&Math.abs(p.x)<=3.5&&Math.abs(p.z)<=3.5;
  const ids=new Set<string>();
  if(r.goals.some(g=>!point(g)||typeof g.id!=="string"||!g.id||g.id==="@robot"||g.id.length>100||ids.has(g.id)||!Number.isFinite(g.yaw)||Math.abs(g.yaw)>Math.PI*100||!Number.isFinite(g.radius)||g.radius<.05||g.radius>.5||!Number.isFinite(g.amount)||g.amount<0||g.amount>100||(ids.add(g.id),false))||r.trail.some(p=>!point(p)))throw new Error("Invalid sugar goals or trail.");
  return structuredClone(r);
}
export type RewardEvent={amount:number;message:string;goal?:string;kind:"sugar"|"trail"|"pain"};
export class ObjectiveRun {
  collected=new Set<string>();checkpoint=0;total=0;
  private blocked=false;private previous:GroundPoint|null=null;
  constructor(readonly mission:MissionSnapshot){}
  update(p:Pose,blocked:boolean):RewardEvent[] {
    const events:RewardEvent[]=[];
    // True pose is used by this external reward evaluator, never exposed as a sensory input.
    const crossed=(target:GroundPoint,radius:number)=>{const a=this.previous??p,dx=p.x-a.x,dz=p.z-a.z,den=dx*dx+dz*dz,t=den?clamp(((target.x-a.x)*dx+(target.z-a.z)*dz)/den,0,1):0;return Math.hypot(target.x-a.x-dx*t,target.z-a.z-dz*t)<=radius;};
    if(this.mission.settings.mode!=="explore")for(const goal of this.mission.goals)if(!this.collected.has(goal.id)&&crossed(goal,goal.radius)){this.collected.add(goal.id);events.push({kind:"sugar",amount:goal.amount,message:"Sugar collected",goal:goal.id});}
    if(this.mission.settings.mode==="trail"){const target=this.mission.trail[this.checkpoint];if(target&&crossed(target,this.mission.settings.width)){this.checkpoint++;events.push({kind:"trail",amount:this.mission.settings.trailReward,message:"Trail checkpoint "+this.checkpoint+"/"+this.mission.trail.length});}}
    if(blocked&&!this.blocked&&this.mission.settings.pain)events.push({kind:"pain",amount:-this.mission.settings.pain,message:"Contact penalty"});
    this.blocked=blocked;this.previous={x:p.x,z:p.z};this.total+=events.reduce((a,e)=>a+e.amount,0);return events;
  }
}
export type SensoryCue={bearing:number;strength:number;antennae:[number,number,number]};
export const EMPTY_CUE: SensoryCue={bearing:0,strength:0,antennae:[0,0,0]};
export function cameraCue(frame:Float32Array,w:number,h:number,mode:ObjectiveSettings["mode"]):SensoryCue {
  if(mode==="explore")return {...EMPTY_CUE,antennae:[0,0,0]};
  const n=w*h;let mass=0,moment=0;const a:[number,number,number]=[0,0,0];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,r=frame[i],g=frame[n+i],b=frame[2*n+i],sugar=r>.55&&b>.45&&g<Math.min(r,b)*.78,trail=mode==="trail"&&g>.45&&b>.45&&r<Math.min(g,b)*.7;
    if(!sugar&&!trail)continue;const weight=sugar?1:(y/h)**2;mass+=weight;moment+=weight*(x/(w-1)*2-1);a[Math.min(2,Math.floor(x/w*3))]+=weight/n;
  }
  return {bearing:mass?moment/mass*.18:0,strength:clamp(mass/n*12,0,1),antennae:a};
}
export function scentCue(p:Pose,mission:MissionSnapshot,time:number):SensoryCue {
  if(mission.settings.mode!=="trail")return {...EMPTY_CUE,antennae:[0,0,0]};
  const s=mission.settings,samples=mission.trail,concentration=(x:number,z:number)=>{
    let best=0;for(let i=0;i<samples.length;i++){const a=samples[i],b=samples[Math.min(i+1,samples.length-1)],dx=b.x-a.x,dz=b.z-a.z,den=dx*dx+dz*dz,t=den?clamp(((x-a.x)*dx+(z-a.z)*dz)/den,0,1):0,d=Math.hypot(x-a.x-dx*t,z-a.z-dz*t);best=Math.max(best,Math.exp(-d*d/(2*s.width*s.width)));}return best*Math.exp(-s.decay*time);
  };
  const a=[-.6,0,.6].map(angle=>concentration(p.x+Math.cos(p.heading+angle)*.18,p.z+Math.sin(p.heading+angle)*.18)) as [number,number,number],total=a.reduce((x,y)=>x+y,0);
  return {bearing:total?(a[2]-a[0])/total*.25:0,strength:Math.max(...a),antennae:a};
}
export type RewardPolicySnapshot={format:"robot-sugar-policy";version:1;count:number;weights:number[];updates:number};
export class SugarPolicy {
  private weights:Float32Array;private random:()=>number;private traces:{cells:number[];choice:number;age:number}[]=[];
  updates=0;values=[0,0,0];lastChoice=1;
  constructor(readonly count:number,seed=2048){this.weights=new Float32Array(count*3);this.random=mulberry32(seed);}
  reset(seed=2048):void {this.traces=[];this.random=mulberry32(seed);}
  remember(cells:number[],action:Action):void {const choice=action.steer<-.2?0:action.steer>.2?2:1;this.traces.forEach(t=>t.age++);this.traces=this.traces.filter(t=>t.age<150);this.traces.push({cells:[...cells],choice,age:0});}
  rememberExecuted(cells:number[],pwm:[number,number]):void {if(Math.max(...pwm.map(Math.abs))<.05){this.traces.forEach(t=>t.age++);this.traces=this.traces.filter(t=>t.age<150);return;}this.remember(cells,{steer:pwm[0]-pwm[1],throttle:Math.max(0,(pwm[0]+pwm[1])/2),brake:0});}
  action(cells:number[],base:Action,cue:SensoryCue,sonar:number,explore=true,recordChoice=true):Action {
    this.values=[0,0,0];for(const id of cells)for(let k=0;k<3;k++)this.values[k]+=this.weights[id*3+k]/Math.max(1,cells.length);
    const scores=this.values.map((v,k)=>v+cue.strength*(k===0?-cue.bearing*12:k===2?cue.bearing*12:.35-Math.abs(cue.bearing)*4));
    let choice=scores.indexOf(Math.max(...scores));if(!cue.strength&&scores.every(v=>v===0))choice=1;
    if(explore&&this.random()<.08)choice=Math.floor(this.random()*3);
    if(sonar>.87)choice=this.random()<.5?0:2;
    this.lastChoice=choice;if(recordChoice)this.remember(cells,{steer:choice===0?-1:choice===2?1:0,throttle:1,brake:0});
    const learned=choice===0?-.7:choice===2?.7:0;
    return {steer:clamp(base.steer*.25+learned*.75,-1,1),throttle:sonar>.87?0:choice===1?.5:.18,brake:0,reverse:sonar>.87?.35:0};
  }
  reward(amount:number):void {
    if(!amount)return;for(const trace of this.traces){const gain=.03*clamp(amount,-10,10)*Math.exp(-trace.age/35);for(const id of trace.cells)this.weights[id*3+trace.choice]=clamp(this.weights[id*3+trace.choice]+gain,-3,3);}this.updates++;
  }
  toJSON():RewardPolicySnapshot{return {format:"robot-sugar-policy",version:1,count:this.count,weights:Array.from(this.weights),updates:this.updates};}
  static fromJSON(raw:unknown,count:number):SugarPolicy {
    const s=raw as RewardPolicySnapshot;if(!s||s.format!=="robot-sugar-policy"||s.version!==1||s.count!==count||!Array.isArray(s.weights)||s.weights.length!==count*3||s.weights.some(v=>!Number.isFinite(v)||Math.abs(v)>3)||!Number.isInteger(s.updates)||s.updates<0)throw new Error("Invalid sugar learning policy.");
    const p=new SugarPolicy(count);p.weights.set(s.weights);p.updates=s.updates;return p;
  }
}
