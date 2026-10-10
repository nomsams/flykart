import { expect,it,vi } from 'vitest';
import { SpikingNetwork,DEFAULT_REWARD_CONFIG } from '../core';
import { trainCameraController } from './browser-training';
import type { TrackSettings } from './ui/sessions';
const {runs}=vi.hoisted(()=>({runs:[] as {trackId:string;seed:number;sensorOnly?:boolean;memory:unknown;fade:number}[]}));
vi.mock('./ui/sessions',()=>({TrackSession:class{
 done=false;episode:{car:{score:number}};
 constructor(settings:TrackSettings){runs.push(settings);this.episode={car:{score:settings.trackId==='hairpin'?10:90}};}
 step(){this.done=true;}
}}));
it('actually evaluates every selected map for every ghost and held-out comparison, with equal weight',async()=>{
 const settings={trackId:'grand-loop',controller:new SpikingNetwork(1).toJSON(),vision:{},rewardConfig:DEFAULT_REWARD_CONFIG,seed:1} as TrackSettings;
 const result=await trainCameraController(settings,1,2,()=>false,()=>{},()=>{},0,['grand-loop','hairpin']);
 expect(result!.score).toBe(50);expect(result!.validation.parent).toBe(50);expect(result!.validation.offspring).toBe(50);expect(result!.trainingMaps).toEqual(['grand-loop','hairpin']);
 expect(runs).toHaveLength(16);for(const trackId of ['grand-loop','hairpin'])for(const seed of [101,307,9001,12007])expect(runs.filter(s=>s.trackId===trackId&&s.seed===seed)).toHaveLength(2);
 expect(runs.every(s=>s.sensorOnly&&s.fade===0&&s.memory===null)).toBe(true);expect(result!.validation.seeds).toEqual([9001,12007]);
 await expect(trainCameraController(settings,1,2,()=>false,()=>{},()=>{},0,[])).rejects.toThrow(/at least one/);
});

it('awaits a completed generation checkpoint before cancellation in held-out work',async()=>{
 const settings={trackId:'grand-loop',controller:new SpikingNetwork(2).toJSON(),vision:{},rewardConfig:DEFAULT_REWARD_CONFIG,seed:1} as TrackSettings;
 let cancelled=false;const checkpoints:unknown[]=[];
 const result=await trainCameraController(settings,2,2,()=>cancelled,()=>{},()=>{},0,['grand-loop'],undefined,async c=>{checkpoints.push(structuredClone(c));cancelled=true;});
 expect(result).toBeNull();expect(checkpoints).toHaveLength(1);expect((checkpoints[0] as {generation:number}).generation).toBe(1);expect(settings.controller).toEqual(new SpikingNetwork(2).toJSON());
});
