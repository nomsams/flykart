import { mulberry32 } from '../vision/rng';
import { DEFAULT_OBJECTIVE, MissionSnapshot } from './objectives';
import { makeObject, ObjectKind, Pose, preset, WorldObject } from './model';
import { EpisodeDataset } from './training';
export type TrialCase={name:string;seed:number;stage:number;objects:WorldObject[];pose:Pose;mission:MissionSnapshot;harsh:boolean};
export type Variant='current'|'no-memory'|'no-sonar'|'single'|'swarm3'|'filtered5';
export const STAGES=['Visible sugar on clear floor','Left and right goal turns','Obstacle detour','Furniture passage','Room clutter','Dim camera and echo noise'];
export function trialCase(stage:number,seed:number,heldOut=false):TrialCase {
  if(!Number.isInteger(stage)||stage<0||stage>=STAGES.length||!Number.isInteger(seed)||seed<0)throw new Error('Invalid trial case.');
  const rng=mulberry32(seed),pose:Pose={x:-1.5,z:0,heading:0},goal={id:'trial-sugar',x:-.25,z:stage>0?(rng()<.5?-1:1)*(.35+rng()*.35):0,yaw:0,radius:.18,amount:10},objects:WorldObject[]=[];
  const add=(kind:ObjectKind,x:number,z:number,extra:Partial<WorldObject>={})=>objects.push({...makeObject(kind,x,z),...extra,id:`case-${stage}-${objects.length}`});
  if(stage===2)add('block',-.85,goal.z*.35,{width:.2,depth:.3,height:.18});
  if(stage===3){add('table',-.6,0,{width:1.6,depth:1.2,height:.65});add('chair',.55,1.2);}
  if(stage>=4){const room=heldOut?'office':'living';objects.push(...preset(room));goal.x=1.7;goal.z=.7+(rng()-.5)*.3;for(const o of objects)if(o.kind==='shoe'||o.kind==='block')o.z+=(rng()-.5)*.2;}
  objects.forEach((o,i)=>o.id=`case-${stage}-${i}`);
  return {name:`${STAGES[stage]} · ${heldOut?'held-out':'training'} seed ${seed}`,seed,stage,objects,pose,mission:{settings:{...DEFAULT_OBJECTIVE,mode:'sugar'},goals:[goal],trail:[]},harsh:stage===5};
}
export type TrialResult={case:string;seed:number;variant:string;stage:number;success:boolean;timeToGoal:number|null;contacts:number;distance:number;reward:number;score:number;cpuMs:number;seconds:number};
export function trialResult(data:EpisodeDataset,c:TrialCase,variant:string,cpuMs:number):TrialResult {const first=data.steps.find(s=>s.evaluation.success);return {case:c.name,seed:c.seed,stage:c.stage,variant,success:!!first,timeToGoal:first?.time??null,contacts:data.summary.contacts,distance:data.summary.distance,reward:data.summary.taskReward,score:data.summary.score,cpuMs,seconds:data.summary.seconds};}
export function pairedReport(results:TrialResult[]):{variant:string;n:number;successRate:number;contacts:number;meanMs:number;scoreDifference:number|null;ci:[number,number]|null}[] {
  const variants=[...new Set(results.map(r=>r.variant))];return variants.map(variant=>{const group=results.filter(r=>r.variant===variant),differences=group.flatMap(r=>{const baseline=results.find(b=>b.variant==='current'&&b.seed===r.seed&&b.stage===r.stage);return baseline?[r.score-baseline.score]:[];}),mean=(a:number[])=>a.reduce((a,b)=>a+b,0)/Math.max(1,a.length),rng=mulberry32(2048),boot=differences.length>=3?Array.from({length:1000},()=>mean(differences.map(()=>differences[Math.floor(rng()*differences.length)]))).sort((a,b)=>a-b):[];return {variant,n:group.length,successRate:mean(group.map(r=>+r.success)),contacts:mean(group.map(r=>r.contacts)),meanMs:mean(group.map(r=>r.cpuMs)),scoreDifference:differences.length?mean(differences):null,ci:boot.length?[boot[25],boot[974]]:null};});
}
