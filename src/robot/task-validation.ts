import { mulberry32 } from '../vision/rng';
import { ROOM_TYPES } from './model';
import { NOISE_PRESETS } from './noise';
export type TaskProfile='baseline'|'varied'|'stress';
export type TaskVariant='current'|'single'|'swarm3'|'no-memory'|'no-sonar';
export type TaskChallenge={profile:TaskProfile;variant:TaskVariant};
export const TASK_PROFILES:TaskProfile[]=['baseline','varied','stress'];
export const TASK_VARIANTS:TaskVariant[]=['current','single','swarm3','no-memory','no-sonar'];
export function validateChallenge(c:TaskChallenge):TaskChallenge {if(!c||!TASK_PROFILES.includes(c.profile)||!TASK_VARIANTS.includes(c.variant))throw new Error('Unknown task challenge or ablation.');return {...c};}
export function taskEnvironment(seed:number,profile:TaskProfile){
  const r=mulberry32(seed+97031),stress=profile==='stress',base=profile==='baseline';
  return {latency:base?0:(stress?.3:.12)+r()*.12,turnGrip:base?null:(stress?.5:.6)+r()*.2,floor:base?null:['#a89c86','#78908a','#b3b2a4'][Math.floor(r()*3)],noise:{...(stress?NOISE_PRESETS.harsh:NOISE_PRESETS.mild),brightness:base?1:(stress?.5:.72)+r()*.25,cameraDropout:base?0:stress?.07:.02,seed}};
}
export function taskSuite(seed:number,room:string,count:number,variants:TaskVariant[]){
  if(!ROOM_TYPES.some(r=>r.id===room)||!Number.isInteger(seed)||seed<0||seed>1000000||!Number.isInteger(count)||count<1||count>3||!variants.length||variants.length>5||variants.some(v=>!TASK_VARIANTS.includes(v))||new Set(variants).size!==variants.length)throw new Error('Task suite needs 1–3 seeds and unique ablation choices.');
  return TASK_PROFILES.flatMap((profile,stage)=>Array.from({length:count},(_,i)=>({seed:seed+100000+stage*100+i,room:stage===0?room:stage===1?'room':'office',profile}))).flatMap(c=>variants.map(variant=>({...c,variant})));
}
export function taskComparisons(rows:{seed:number;variant?:TaskVariant;success:boolean;contacts:number;score:number;scenario?:TaskProfile;room?:string}[]){
  return TASK_VARIANTS.filter(v=>rows.some(r=>(r.variant??'current')===v)).map(variant=>{const own=rows.filter(r=>(r.variant??'current')===variant),pairs=own.map(r=>{const base=rows.find(b=>(b.variant??'current')==='current'&&b.seed===r.seed&&b.room===r.room&&b.scenario===r.scenario);return base?r.score-base.score:null;}).filter((n):n is number=>n!==null);return {variant,trials:own.length,successes:own.filter(r=>r.success).length,contacts:own.reduce((n,r)=>n+r.contacts,0),pairedScoreDelta:pairs.length?pairs.reduce((a,b)=>a+b,0)/pairs.length:null};});
}
