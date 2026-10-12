import {expect,it} from 'vitest';
import {DEFAULT_SEARCH_JUDGE,SearchJudge,validateSearchJudge} from './search-judge';
import {discoveryScore,goalScore,trainWorldController,type GoalResult} from './training';
import {SpikingNetwork} from '../../core';
import {WorldSession,type WorldSettings} from '../ui/sessions';
import {VisionCnn} from '../cnn';
import {defaultSpec,serialiseModel} from '../perception';
import {WORLD_CAMERA} from './worldDomain';
import {exportVisionBrain,importFile,controllerCheckpoint,validateRoomTraining} from '../format';

const spec={...defaultSpec(2,10,'rgb',false),channels:[1,1,1] as [number,number,number],hidden:4};
const settings:WorldSettings={seed:7,density:0,style:0,kind:'vision',fade:0,task:'explore',world:{seed:1,half:460,obstacles:[],patches:[]},start:{x:0,y:0,heading:0},controller:new SpikingNetwork(7).toJSON(),vision:serialiseModel(new VisionCnn(spec,7),WORLD_CAMERA,Array(10).fill(1),'test',undefined,undefined,'world'),maxTicks:450};
const failure:GoalResult={arrived:false,ticks:900,collisions:0,progress:0,reverseDistance:0,crashed:false,won:false,visualViews:64};
it('ranks real ground exploration above a moving circle with the same maximum visual novelty',()=>{
  const loop=new SearchJudge({...DEFAULT_SEARCH_JUDGE}),search=new SearchJudge({...DEFAULT_SEARCH_JUDGE});
  loop.reset(0,0);search.reset(0,0);
  for(let tick=1;tick<=900;tick++){
    loop.observe(20*Math.cos(tick/20),20*Math.sin(tick/20),tick,0,0,false,0);
    search.observe(tick*2,0,tick,0,0,false,0);
  }
  expect(loop.cells).toBeLessThan(10);expect(loop.seconds).toBeGreaterThan(20);expect(loop.pain).toBeGreaterThan(0);expect(loop.penalty).toBeGreaterThan(5);
  expect(search.penalty).toBe(0);expect(search.coverageReward).toBe(20);
  const result=(j:SearchJudge)=>({...failure,pain:j.pain,coverageReward:j.coverageReward,noProgressPenalty:j.penalty});
  expect(discoveryScore(result(search),900,.2)).toBeGreaterThan(discoveryScore(result(loop),900,.2));
  const earlier=loop.penalty;loop.observe(20,0,901,0,0,false,0);expect(loop.penalty-earlier).toBeGreaterThan(.01);
});
it('allows brief turns, useful reversing and completion; repeated poses cannot earn coverage twice',()=>{
  const j=new SearchJudge({...DEFAULT_SEARCH_JUDGE,zeroChill:true});j.reset(0,0);
  for(let t=1;t<=120;t++)j.observe(0,0,t,0,0,false,0);
  expect(j.penalty).toBe(0);expect(j.disqualified).toBe(false);
  for(let t=121;t<=300;t++)j.observe(-(t-120)*2,0,t,0,0,false,0);
  expect(j.penalty).toBe(0);expect(j.disqualified).toBe(false);
  const cells=j.cells;j.observe(0,0,301,0,0,false,0);expect(j.cells).toBe(cells);
  j.observe(0,0,302,0,1,true,5);expect(j.disqualified).toBe(false);expect(j.reason).toBe('goal completed');
  j.reset(0,0,302,1);expect(j.cells).toBe(1);expect(j.penalty).toBe(0);
});
it('counts visible approach progress and handles disabled settings, contacts and idle cutoff',()=>{
  const j=new SearchJudge({...DEFAULT_SEARCH_JUDGE,zeroChill:true});j.reset(0,0);
  for(let t=1;t<=450;t++)j.observe(0,0,t,Math.floor(t/90)*.05,0,false,0);
  expect(j.disqualified).toBe(false);expect(j.penalty).toBe(0);
  j.observe(0,0,451,.25,0,false,1);expect(j.reason).toBe('contact');expect(j.disqualified).toBe(true);
  const idle=new SearchJudge({...DEFAULT_SEARCH_JUDGE,zeroChill:true});idle.reset(0,0);
  for(let t=1;t<=360;t++)idle.observe(0,0,t,0,0,false,0);
  expect(idle.disqualified).toBe(true);expect(idle.reason).toContain('no-progress');
  const off=new SearchJudge({...DEFAULT_SEARCH_JUDGE,enabled:false,zeroChill:true});off.reset(0,0);off.observe(0,0,900,0,0,false,4);
  expect(off.disqualified).toBe(false);expect(off.penalty).toBe(0);expect(off.coverageReward).toBe(0);
  expect(()=>validateSearchJudge({...DEFAULT_SEARCH_JUDGE,cutoffSeconds:6})).toThrow();
});
it('preserves success priority and makes rejection independent of crash slider weight',()=>{
  for(const weight of [0,.2,1]){
    const won={...failure,arrived:true,won:true,ticks:900,pain:100,noProgressPenalty:1000};
    expect(discoveryScore(won,900,weight)).toBeGreaterThan(discoveryScore({...failure,coverageReward:20},900,weight));
    expect(goalScore(won,900,weight)).toBeGreaterThan(goalScore({...failure,progress:1},900,weight));
    expect(discoveryScore({...won,disqualified:true},900,weight)).toBe(-1000000);
    expect(goalScore({...won,disqualified:true},900,weight)).toBe(-1000000);
  }
});
it('never reads hidden goal range for the visual judge and transfers no judge signal into neural inputs',()=>{
  const make=(y:number)=>new WorldSession({...settings,goals:[{x:-300,y}],searchWin:'reach'});
  const a=make(-80),b=make(80);
  for(const s of [a,b]){
    // Physics is allowed to evaluate arrival; the learner and judge are not
    // allowed to read a hidden target's true distance.
    let physics=false,distance=s.episode.sim.status.distanceToGoal;const step=s.episode.step.bind(s.episode);
    Object.defineProperty(s.episode.sim.status,'distanceToGoal',{get:()=>{if(!physics)throw Error('Hidden distance leak');return distance;},set:v=>{distance=v;}});
    s.episode.step=action=>{physics=true;try{step(action);}finally{physics=false;}};
    s.episode.mission=()=>{throw Error('Compass leak');};s.episode.truth=()=>{throw Error('Truth leak');};
  }
  for(let i=0;i<24;i++){a.step();b.step();expect(a.lastAction).toEqual(b.lastAction);expect(a.driver!.sensors).toEqual(b.driver!.sensors);expect(a.searchJudge.penalty).toBe(b.searchJudge.penalty);}
});
it('default judge pain changes fitness without changing sensor frames, motor actions or physical impact state',()=>{
  const controller=structuredClone(settings.controller);controller.inputWeights.fill(0);controller.recurrentWeights.fill(0);controller.outputWeights.fill(0);controller.bias.fill(-10);
  const make=(enabled:boolean)=>new WorldSession({...settings,controller,goals:[{x:-300,y:0}],searchWin:'reach',searchJudge:{...DEFAULT_SEARCH_JUDGE,enabled}});
  const on=make(true),off=make(false);
  for(let i=0;i<300;i++){on.step();off.step();expect(on.driver!.sensors).toEqual(off.driver!.sensors);expect(on.lastAction).toEqual(off.lastAction);expect(on.episode.sim.kart).toEqual(off.episode.sim.kart);}
  expect(on.searchJudge.penalty).toBeGreaterThan(0);expect(on.searchJudge.pain).toBeGreaterThan(0);expect(off.searchJudge.penalty).toBe(0);
  expect(on.episode.frame).toEqual(off.episode.frame);expect(on.episode.sim.status.pain).toBe(off.episode.sim.status.pain);expect(on.episode.sim.status.crashed).toBe(false);
});
it('preserves the exact parent and never checkpoints all-disqualified generations',async()=>{
  const parent=structuredClone(settings.controller),saved:unknown[]=[],logs:string[]=[];
  const report=await trainWorldController({...settings,searchJudge:{...DEFAULT_SEARCH_JUDGE,delaySeconds:2,cutoffSeconds:3,zeroChill:true}},2,2,.2,()=>false,s=>logs.push(s),sessions=>{
    for(const s of sessions){const driver=s.driver!;driver.act=()=>({action:{steer:0,throttle:0,brake:1,reverse:0}} as ReturnType<typeof driver.act>);}
  },0,false,true,undefined,{seed:44,onGeneration:c=>{saved.push(c);}});
  expect(report!.viableGenerations).toBe(0);expect(report!.generation).toBe(0);expect(report!.attemptedGenerations).toBe(2);expect(report!.brain).toEqual(parent);expect(saved).toHaveLength(0);expect(report!.trials.every(t=>t.disqualified)).toBe(true);expect(logs.filter(l=>l.includes('all ghosts disqualified'))).toHaveLength(2);
},30000);
it('round trips explicit settings and retains legacy imports without a new field',()=>{
  const base={version:1 as const,task:'explore' as const,crashWeight:.2,maxTicks:900,memoryEnabled:false,reverseCoach:false};
  expect(validateRoomTraining(base)).toEqual(base);
  const training={...base,searchJudge:{...DEFAULT_SEARCH_JUDGE,zeroChill:true,weight:2}};
  const text=exportVisionBrain({name:'Search',controller:controllerCheckpoint(settings.controller,{domain:'world'}),vision:settings.vision,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,world:null,worldTraining:training});
  expect(importFile(text).worldTraining).toEqual(training);
  expect(()=>validateRoomTraining({...base,searchJudge:{...DEFAULT_SEARCH_JUDGE,weight:0}})).toThrow();
});
