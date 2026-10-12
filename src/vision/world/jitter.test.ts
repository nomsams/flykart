import {expect,it} from 'vitest';
import {SearchJudge,DEFAULT_SEARCH_JUDGE,validateSearchJudge} from './search-judge';
import {WorldSession} from '../ui/sessions';
import {SpikingNetwork} from '../../core';
import {VisionCnn} from '../cnn';
import {defaultSpec,serialiseModel} from '../perception';
import {WORLD_CAMERA} from './worldDomain';
import {KART_PROFILE} from '../robot';
import {goalResult,discoveryScore,trainWorldController} from './training';
import {exportVisionBrain,controllerCheckpoint,importFile} from '../format';
const rules={...DEFAULT_SEARCH_JUDGE,loopGuard:false,blindReverse:false};
function rock(j:SearchJudge,ticks:number,blocked=false,glitches=false){
  let x=16;for(let t=1;t<=ticks&&!j.disqualified;t++){const sign=(glitches?t%2:Math.floor((t-1)/10)%2)?-1:1;if(!blocked)x+=sign*.15;j.observe(x,0,t,0,0,false,0,{visualSearch:true,reverse:sign<0,targetVisible:false,heading:0,drive:sign});}
}
it('detects localized rocking, revokes its boundary-cell credit and applies increasing pain plus negative reward',()=>{
  const j=new SearchJudge(rules);j.reset(16,0);rock(j,240);
  expect(j.jitterActive).toBe(true);expect(j.reversalCount).toBeGreaterThanOrEqual(4);expect(j.motionTravelCm).toBeGreaterThan(8);expect(j.motionNetCm).toBeLessThan(4);
  expect(j.jitterSeconds).toBeGreaterThan(3);expect(j.jitterPain).toBeGreaterThan(4);expect(j.jitterPenalty).toBe(j.jitterPain);expect(j.coverageReward).toBe(0);expect(j.reason).toContain('jitter');
  const cost=j.jitterPenalty;j.observe(16.15,0,241,0,0,false,0,{visualSearch:true,reverse:false,targetVisible:false,heading:0,drive:1});expect(j.jitterPenalty-cost).toBeGreaterThan(2/30);
});
it('catches blocked alternating commands but ignores tiny pose chatter and one-tick drive glitches',()=>{
  const blocked=new SearchJudge(rules),glitches=new SearchJudge(rules);blocked.reset(16,0);glitches.reset(16,0);
  rock(blocked,240,true);rock(glitches,240,true,true);expect(blocked.jitterPenalty).toBeGreaterThan(0);expect(blocked.motionTravelCm).toBe(0);expect(glitches.jitterPenalty).toBe(0);
});
it('preserves useful backing escapes, productive multi-point exploration and visible approach',()=>{
  for(const useful of ['escape','explore','approach']){
    const j=new SearchJudge({...rules,zeroChill:true});j.reset(0,0);let x=0;
    for(let t=1;t<=300;t++){
      const sign=useful==='escape'?(t<40?-1:1):(Math.floor(t/10)%2?-1:1);x+=sign*(useful==='explore'?(sign>0?1:.15):.15);
      j.observe(x,0,t,useful==='approach'?t*.002:0,0,false,0,{visualSearch:true,reverse:sign<0,targetVisible:useful==='approach',heading:0,drive:sign});
    }
    expect(j.jitterPenalty,useful).toBe(0);expect(j.disqualified,useful).toBe(false);
  }
});
it('honors disabling, completion and reset, while Zero chill independently rejects persistent jitter',()=>{
  const off=new SearchJudge({...rules,antiJitter:false});off.reset(16,0);rock(off,240);expect(off.jitterPenalty).toBe(0);
  const strict=new SearchJudge({...rules,antiJitter:false,zeroChill:true});strict.reset(16,0);rock(strict,300);expect(strict.disqualified).toBe(true);expect(strict.reason).toContain('jitter');expect(strict.jitterSeconds).toBeLessThan(3);
  const completed=new SearchJudge(rules);completed.reset(16,0);rock(completed,150);const cost=completed.jitterPenalty;completed.observe(16,0,151,0,1,true,0);expect(completed.jitterActive).toBe(false);expect(completed.jitterPenalty).toBe(cost);completed.reset(16,0,151,1);expect(completed.jitterPenalty).toBe(0);expect(completed.reversalCount).toBe(0);
});
const spec={...defaultSpec(1,10,'rgb',false),width:8,height:8,channels:[1,1,1] as [number,number,number],hidden:2};
const eyes=serialiseModel(new VisionCnn(spec,7),WORLD_CAMERA,Array(10).fill(1),'Jitter regression',undefined,undefined,'world');
const settings={seed:7,density:0,style:0,kind:'vision' as const,fade:0,task:'explore' as const,world:{seed:1,half:460,obstacles:[],patches:[]},start:{x:0,y:0,heading:0},profile:{...KART_PROFILE,worldCamera:{...WORLD_CAMERA,width:8,height:8}},controller:new SpikingNetwork(7).toJSON(),vision:eyes,maxTicks:300,goals:[{x:-300,y:0}],searchWin:'reach' as const};
function installRock(s:WorldSession){
  const act=s.driver!.act.bind(s.driver!),step=s.episode.step.bind(s.episode);let t=0,x=s.episode.sim.kart.x;
  s.driver!.act=e=>{const frame=act(e),sign=Math.floor(t/10)%2?-1:1;return {...frame,action:{steer:0,throttle:sign>0?1:0,reverse:sign<0?1:0,brake:0}};};
  s.episode.step=a=>{step(a);const sign=Math.floor(t++/10)%2?-1:1;x+=sign*.15;s.episode.sim.kart.x=x;s.episode.sim.kart.y=0;s.episode.sim.kart.heading=0;};
}
it('feeds real episode jitter penalties into fitness without changing RGB, neural inputs or physical impact pain',()=>{
  const on=new WorldSession({...settings,searchJudge:{...rules,delaySeconds:20,cutoffSeconds:30}}),off=new WorldSession({...settings,searchJudge:{...rules,antiJitter:false,delaySeconds:20,cutoffSeconds:30}});installRock(on);installRock(off);
  for(let t=0;t<240;t++){on.step();off.step();expect(on.lastAction).toEqual(off.lastAction);expect(on.driver!.sensors).toEqual(off.driver!.sensors);}
  expect(on.episode.frame).toEqual(off.episode.frame);expect(on.episode.sim.status.pain).toBe(off.episode.sim.status.pain);expect(on.searchJudge.jitterPenalty).toBeGreaterThan(0);
  const a=goalResult(on,300),b=goalResult(off,300);expect(a.jitterPenalty).toBe(a.noProgressPenalty);expect(discoveryScore(a,300)).toBeLessThan(discoveryScore(b,300));expect(a.pain).toBe(on.episode.sim.status.pain+on.searchJudge.pain);
});
it('rejects jittering training candidates without autosaving them or changing the exact parent',async()=>{
  const saved:unknown[]=[],seen=new WeakSet<WorldSession>();const report=await trainWorldController({...settings,goals:undefined,searchJudge:{...rules,zeroChill:true}},1,2,.2,()=>false,()=>{},sessions=>sessions.forEach(s=>{if(!seen.has(s)){seen.add(s);installRock(s);}}),4,false,false,undefined,{seed:19,onGeneration:c=>{saved.push(c);}});
  expect(report!.viableGenerations).toBe(0);expect(report!.brain).toEqual(settings.controller);expect(saved).toEqual([]);expect(report!.trials.every(t=>t.disqualified&&t.jitterPenalty!>0&&t.rejectionReason?.includes('jitter'))).toBe(true);
},30000);
it('migrates old settings and exports the configurable motion guard with the brain',()=>{
  const old={enabled:true,zeroChill:false,delaySeconds:6,cutoffSeconds:12,weight:1};expect(validateSearchJudge(old)).toEqual(DEFAULT_SEARCH_JUDGE);
  for(const patch of [{antiJitter:1},{jitterWindowSeconds:1},{jitterWeight:0}])expect(()=>validateSearchJudge({...old,...patch})).toThrow();
  const training={version:1 as const,task:'explore' as const,crashWeight:.2,maxTicks:900,memoryEnabled:false,reverseCoach:false,searchJudge:{...DEFAULT_SEARCH_JUDGE,jitterWindowSeconds:3,jitterWeight:4}};
  const text=exportVisionBrain({name:'Motion guard',controller:controllerCheckpoint(settings.controller,{domain:'world'}),vision:eyes,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,world:null,worldTraining:training});expect(importFile(text).worldTraining).toEqual(training);
});
