import {it,expect,vi} from 'vitest';
import {VisionCnn} from '../cnn';
import {defaultSpec,serialiseModel} from '../perception';
import {ROBOT_WORLD_CAMERA} from '../robot';
import {DEFAULT_GOAL_REWARDS,validateGoalRewards,noseArrivalBonus,goalTimeBonus} from './goal-rewards';
import {WorldSim} from './world';
import {WorldSession} from '../ui/sessions';
import {SpikingNetwork} from '../../core';
import {goalScore,discoveryScore,goalResult} from './training';
import {FlagDiscovery} from './discovery';
import {validateArena} from './arena';
import {validateWorldSetup,validateRoomTraining} from '../format';
import {DEFAULT_SEARCH_JUDGE} from './search-judge';
const idle={steer:0,throttle:0,brake:0,reverse:0};
const world={seed:7,half:460,obstacles:[],patches:[]};
const rewards={...DEFAULT_GOAL_REWARDS,noseFirst:true,adaptiveTime:true};
const spec={...defaultSpec(1,10,'rgb',false),channels:[1,1,1] as [number,number,number],hidden:2};
const eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,Array(10).fill(1),'Goal reward regression',undefined,undefined,'world');
function session(win:'sight'|'reach'='sight'){
  return new WorldSession({seed:7,density:0,style:0,kind:'vision',fade:0,controller:new SpikingNetwork(7,19).toJSON(),vision:eyes,world,start:{x:0,y:0,heading:0},goalCount:3,task:'explore',searchWin:win,goalRewards:rewards,maxTicks:900,searchJudge:{...DEFAULT_SEARCH_JUDGE,enabled:false,zeroChill:false}});
}
it('rewards only a forward nose-first arrival, with an optional switch and no stationary bonus',()=>{
  expect(noseArrivalBonus(rewards,0,20,10,0)).toBe(30);
  for(const [heading,speed,x,y] of [[Math.PI,-20,10,0],[0,-20,-10,0],[0,0,10,0],[0,20,0,10],[0,20,0,0]])expect(noseArrivalBonus(rewards,heading,speed,x,y)).toBe(0);
  expect(noseArrivalBonus(DEFAULT_GOAL_REWARDS,0,20,10,0)).toBe(0);
});
it('extends a finite three-goal clock by 10 then 15 seconds, once per collected goal',()=>{
  const sim=new WorldSim(7,{world,start:{x:0,y:0,heading:0},goals:[{x:23,y:0},{x:120,y:0},{x:200,y:0}],goalLimit:3,maxTicks:60,goalRewards:rewards});
  sim.step({steer:0,throttle:1,brake:0});expect(sim.status.goals).toBe(1);expect(sim.status.noseReward).toBe(30);expect(sim.deadlineTicks).toBe(360);
  sim.kart.x=120;sim.step(idle);expect(sim.status.goals).toBe(2);expect(sim.deadlineTicks).toBe(810);
  sim.kart.x=200;sim.step(idle);expect(sim.status.goals).toBe(3);expect(sim.status.timeBonusTicks).toBe(750);expect(sim.done).toBe(true);
  sim.step(idle);expect(sim.status.timeBonusTicks).toBe(750);expect(goalTimeBonus(rewards,3,3)).toBe(0);
  const legacy=new WorldSim(7,{world,start:{x:0,y:0,heading:0},goals:[{x:23,y:0}],goalLimit:1,maxTicks:60});legacy.step(idle);expect(legacy.deadlineTicks).toBe(60);expect(legacy.status.noseReward).toBe(0);
});
it('keeps newly generated sequential visual flags hidden, resets old pixels, and finishes only after all finds',()=>{
  const s=session(),pixels=new Float32Array(48*24*3),n=48*24;
  for(let y=8;y<14;y++)for(let x=20;x<28;x++){pixels[y*48+x]=1;pixels[n+y*48+x]=.2;pixels[2*n+y*48+x]=.62;}
  vi.spyOn(s.driver!,'act').mockImplementation(()=>{s.discovery!.observe(pixels,s.episode.tick);return {action:idle} as ReturnType<NonNullable<WorldSession['driver']>['act']>;});
  const old={...s.episode.sim.goals[0]};s.step();s.step();expect(s.episode.sim.status.goals).toBe(1);expect(s.done).toBe(false);expect(s.episode.sim.deadlineTicks).toBe(1200);expect(s.discovery!.cue()).toEqual([0,0]);expect(s.episode.sim.goals[0]).not.toEqual(old);expect(s.episode.sim.goals).toHaveLength(1);
  expect(Math.abs(s.episode.sim.mission()[0])*Math.PI).toBeGreaterThan(s.episode.camera.hfov/2);
  expect(s.driver!.options.missionCue).toBe(false);
  s.step();expect(s.episode.sim.status.goals).toBe(1);s.step();expect(s.episode.sim.status.goals).toBe(2);expect(s.episode.sim.deadlineTicks).toBe(1650);
  s.step();s.step();expect(s.won).toBe(true);expect(s.done).toBe(true);expect(s.visualFinds).toBe(3);expect(s.episode.sim.status.noseReward).toBe(0);
  expect(goalResult(s,100).timeBonusTicks).toBe(750);
  const tick=s.episode.tick;expect(s.continueSearch()).toBe(true);expect(s.episode.sim.goalLimit).toBe(6);expect(s.episode.sim.deadlineTicks).toBe(tick+900);
  s.step();s.step();s.step();expect(s.episode.sim.status.goals).toBe(4);expect(s.episode.sim.status.timeBonusTicks).toBe(1050);
});
it('does not award reach-mode collections before confirmed vision, or for seeing a distant target',()=>{
  const s=session('reach');vi.spyOn(s.driver!,'act').mockImplementation(()=>({action:idle} as ReturnType<NonNullable<WorldSession['driver']>['act']>));
  const g=s.episode.sim.goals[0];s.episode.sim.kart.x=g.x;s.episode.sim.kart.y=g.y;s.step();expect(s.episode.sim.status.goals).toBe(0);
  s.discovery!.firstSightTick=s.episode.tick;s.step();expect(s.episode.sim.status.goals).toBe(1);expect(s.done).toBe(false);expect(s.found).toBe(false);
  s.discovery!.firstSightTick=s.episode.tick;s.step();expect(s.episode.sim.status.goals).toBe(1);
});
it('ignores held frames from the previous goal until the next acquisition',()=>{
  const d=new FlagDiscovery(48,24,1.8),image=new Float32Array(48*24*3);d.reset(12);d.observe(image,12);expect(d.sampleTick).toBe(null);d.observe(image,14);expect(d.sampleTick).toBe(14);
});
it('ranks actual partial finds and nose rewards but keeps completion dominant and normalizes adaptive deadlines',()=>{
  const base={arrived:false,ticks:900,collisions:0,progress:0,reverseDistance:0,crashed:false,goals:0,goalTarget:3,objective:'sight' as const,won:false};
  expect(discoveryScore({...base,goals:2},900)).toBeGreaterThan(discoveryScore({...base,goals:1},900));
  expect(discoveryScore({...base,won:true,deadlineTicks:1650},900)).toBeGreaterThan(discoveryScore({...base,won:true,deadlineTicks:900},900));
  expect(goalScore({...base,arrived:true,noseReward:30},900,0)).toBeGreaterThan(goalScore({...base,arrived:true},900,0));
  expect(goalScore({...base,arrived:true,noProgressPenalty:9999},900,0)).toBeGreaterThan(goalScore({...base,progress:1,noseReward:600},900,0));
});
it('validates and preserves reward settings in scenes and brain setup metadata, with old defaults disabled',()=>{
  expect(validateGoalRewards(undefined)).toEqual(DEFAULT_GOAL_REWARDS);
  for(const raw of [null,[],{...rewards,adaptiveTime:1},{...rewards,secondsPerGoal:Infinity},{...rewards,growthSeconds:31}])expect(()=>validateGoalRewards(raw)).toThrow();
  const arena=validateArena({format:'flykart-world',version:1,world,start:{x:0,y:0,heading:0},exercise:{task:'explore',searchWin:'reach',goalPreset:'random',goalCount:3,goalRewards:rewards}});expect(arena.exercise!.goalRewards).toEqual(rewards);
  expect(validateWorldSetup({version:1,seed:7,density:0,style:0,driver:'vision',fade:0,goalPreset:'random',mapPreset:'clear',memoryCount:4096,sonarOn:true,trailVisible:true,goalRewards:rewards}).goalRewards).toEqual(rewards);
  expect(validateRoomTraining({version:1,task:'explore',crashWeight:.2,maxTicks:900,memoryEnabled:false,reverseCoach:false,goalRewards:rewards}).goalRewards).toEqual(rewards);
});
