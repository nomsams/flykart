import { Action, BrainSnapshot, clamp, SpikingNetwork } from '../core';
import { mulberry32 } from '../vision/rng';
import { visualFeatures } from './vision-workbench';
import { widenBrain } from '../vision/inputs';

export const TASK_INPUT_NAMES = [...Array.from({length:8},(_,i)=>['red','green','blue'].map(c=>`camera.patch${i+1}.${c}`)).flat(), 'sonar.close','sonar.valid','command.left','command.right','target.bearing','target.area','bumper.contact','bumper.valid','light.level','light.valid','camera.valid'];
export type SensorModules = { camera:boolean; sonar:boolean; bumper:boolean; light:boolean };
export const DEFAULT_MODULES:SensorModules={camera:true,sonar:true,bumper:false,light:false};
export function validateModules(raw:unknown):SensorModules { const s=raw as SensorModules;if(!s||Object.keys(DEFAULT_MODULES).some(k=>typeof s[k as keyof SensorModules]!=='boolean'))throw new Error('Invalid sensor modules.');return {...s}; }
export type ColourTarget={hue:number;tolerance:number;minSaturation:number;minValue:number;diameter:number};
export const BLUE_TARGET:ColourTarget={hue:220,tolerance:25,minSaturation:.35,minValue:.18,diameter:.06};
export function validateTarget(raw:unknown):ColourTarget {const s=raw as ColourTarget;if(!s||![s.hue,s.tolerance,s.minSaturation,s.minValue,s.diameter].every(Number.isFinite)||s.hue<0||s.hue>=360||s.tolerance<5||s.tolerance>60||s.minSaturation<.1||s.minSaturation>1||s.minValue<.05||s.minValue>1||s.diameter<.02||s.diameter>.2)throw new Error('Invalid target colour/diameter.');return {...s};}
export function rgbHue(r:number,g:number,b:number):[number,number,number] {const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let hue=d===0?0:max===r?60*((g-b)/d%6):max===g?60*((b-r)/d+2):60*((r-g)/d+4);return [(hue+360)%360,max===0?0:d/max,max];}
export type TargetSight={bearing:number;area:number;visible:boolean};
/** Camera-only cue: colour centroid, never scene position, reward or target ID. */
export function targetSight(frame:Float32Array,w:number,h:number,target:ColourTarget):TargetSight {
  const n=w*h;let count=0,moment=0;
  for(let i=0;i<n;i++){const [hue,s,v]=rgbHue(frame[i],frame[n+i],frame[2*n+i]),delta=Math.abs(hue-target.hue);if(Math.min(delta,360-delta)<=target.tolerance&&s>=target.minSaturation&&v>=target.minValue){count++;moment+=(i%w)/Math.max(1,w-1)*2-1;}}
  const visible=count>=Math.max(3,n*.002);return {bearing:visible?moment/count:0,area:visible?count/n:0,visible};
}
export function taskObservation(frame:Float32Array,w:number,h:number,modules:SensorModules,target:ColourTarget,cm:number|null,last:[number,number],contact:boolean|null,cameraValid=true):number[] {
  const sight=modules.camera&&cameraValid?targetSight(frame,w,h,target):{bearing:0,area:0,visible:false},rgb=modules.camera&&cameraValid?Array.from(visualFeatures(frame,w,h)):Array(24).fill(0),valid=modules.sonar&&cm!==null&&Number.isFinite(cm)&&cm>=2&&cm<=400;
  const light=modules.light&&modules.camera&&cameraValid?rgb.reduce((a,v)=>a+v,0)/24:0;
  return [...rgb,valid?clamp(1-cm!/220,0,1):0,+valid,...last.map(v=>clamp(v,-1,1)),sight.bearing,clamp(sight.area*20,0,1),modules.bumper&&contact!==null?+contact:0,+(modules.bumper&&contact!==null),light,+(modules.light&&modules.camera&&cameraValid),+(modules.camera&&cameraValid)];
}
export type TaskSnapshot={format:'robot-visual-task';version:1;inputs:string[];hidden:16;weights:number[];updates:number;origin:string};
const N=35,H=16,COUNT=H*(N+1)+2*(H+1);
export class TaskBrain {
  weights:number[];updates=0;origin='Untrained visual task network';
  constructor(seed=2048){const r=mulberry32(seed);this.weights=Array.from({length:COUNT},()=> (r()-.5)*.12);}
  private forward(input:number[]):{hidden:number[];output:number[]} {if(input.length!==N||input.some(v=>!Number.isFinite(v)))throw new Error('Invalid modular observation.');const hidden=Array.from({length:H},(_,j)=>Math.tanh(this.weights[j*(N+1)+N]+input.reduce((s,v,k)=>s+v*this.weights[j*(N+1)+k],0))),offset=H*(N+1),output=[0,1].map(o=>Math.tanh(this.weights[offset+o*(H+1)+H]+hidden.reduce((s,v,j)=>s+v*this.weights[offset+o*(H+1)+j],0)));return {hidden,output};}
  action(input:number[],base:Action,inheritance:number):Action {const {output:[steer,drive]}=this.forward(input),a=clamp(inheritance,0,1),motor=drive*(1-a)+(base.throttle-(base.reverse??0)) *a;return {steer:clamp(steer*(1-a)+base.steer*a,-1,1),throttle:Math.max(0,motor),reverse:Math.max(0,-motor),brake:0};}
  learn(input:number[],target:Action,rate=.015):number {const {hidden,output}=this.forward(input),desired=[target.steer,target.throttle-(target.reverse??0)],delta=output.map((v,k)=>(v-desired[k])*(1-v*v)),offset=H*(N+1),back=hidden.map((v,j)=>(1-v*v)*delta.reduce((s,d,k)=>s+d*this.weights[offset+k*(H+1)+j],0));for(let o=0;o<2;o++){for(let j=0;j<H;j++)this.weights[offset+o*(H+1)+j]-=rate*delta[o]*hidden[j];this.weights[offset+o*(H+1)+H]-=rate*delta[o];}for(let j=0;j<H;j++){for(let k=0;k<N;k++)this.weights[j*(N+1)+k]-=rate*back[j]*input[k];this.weights[j*(N+1)+N]-=rate*back[j];}this.weights=this.weights.map(v=>clamp(v,-4,4));this.updates++;return output.reduce((s,v,k)=>s+(v-desired[k])**2,0)/2;}
  clone():TaskBrain{return TaskBrain.fromJSON(this.toJSON());}
  mutate(rate:number,amount:number,seed:number):TaskBrain{const c=this.clone(),r=mulberry32(seed);c.weights=c.weights.map(v=>r()<rate?clamp(v+(r()+r()+r()-1.5)*amount,-4,4):v);c.origin='Visual task offspring';return c;}
  toJSON():TaskSnapshot{return {format:'robot-visual-task',version:1,inputs:[...TASK_INPUT_NAMES],hidden:16,weights:[...this.weights],updates:this.updates,origin:this.origin};}
  static fromJSON(raw:unknown):TaskBrain {const s=raw as TaskSnapshot;if(!s||s.format!=='robot-visual-task'||s.version!==1||s.hidden!==H||JSON.stringify(s.inputs)!==JSON.stringify(TASK_INPUT_NAMES)||!Array.isArray(s.weights)||s.weights.length!==COUNT||s.weights.some(v=>!Number.isFinite(v)||Math.abs(v)>4)||!Number.isInteger(s.updates)||s.updates<0||typeof s.origin!=='string'||s.origin.length>200)throw new Error('Invalid visual task network/schema.');const c=new TaskBrain();c.weights=[...s.weights];c.updates=s.updates;c.origin=s.origin;return c;}
}
/** Visible teacher for demonstrations; explicitly excluded from neural-only validation. */
export function visualCoach(input:number[],follow=false):Action {const close=input[24],valid=input[25],bearing=input[28],area=input[29];if(valid&&close>.91)return {steer:.65,throttle:0,reverse:.25,brake:0};if(!input[34])return {steer:0,throttle:0,brake:0};if(!area)return {steer:.6,throttle:.08,brake:0};return {steer:clamp(bearing*2,-.8,.8),throttle:follow?clamp((.18-area)*3,0,.4):clamp((.32-area)*2,.08,.4),reverse:follow?clamp((area-.23)*2,0,.2):0,brake:0};}
/** Preserve the recurrent motor circuit; transfer only inputs with matching meanings. */
export function racerToRoom(raw:BrainSnapshot):BrainSnapshot {
  const source=SpikingNetwork.fromJSON(raw).toJSON(),wide=widenBrain(source),weights=Array(48*19).fill(0);
  // Body speed / previous commands and scalar static obstacle have comparable meanings.
  // Track curve, road edge and checkpoint inputs do not describe rooms; reset those rows.
  const mapping:[number,number][]=[[11,3],[12,14],[13,15],[6,16]];
  for(let j=0;j<48;j++){for(const [dest,src]of mapping)weights[j*19+dest]=wide.inputWeights[j*19+src];if(source.inputCount===19){weights[j*19+17]=wide.inputWeights[j*19+17];weights[j*19+18]=wide.inputWeights[j*19+18];}}
  return {...wide,inputWeights:weights};
}
