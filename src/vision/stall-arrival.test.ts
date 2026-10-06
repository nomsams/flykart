import { expect,it } from 'vitest';
import { VisualStall,DEFAULT_STALL,validateStall } from './stall';
import { validateGoalRadius } from './world/world';
import { WorldSession } from './ui/sessions';
import { VisionCnn } from './cnn';
import { defaultSpec,serialiseModel } from './perception';
import { WORLD_CAMERA } from './world/worldDomain';
import { SpikingNetwork } from '../core';
import { validateRacingSettings,DEFAULT_RACING } from './racing-settings';
const command={steer:0,throttle:1,brake:0,reverse:0};
function pixels(phase=0,flat=false):Float32Array{const f=new Float32Array(48*24*3);for(let c=0;c<3;c++)for(let y=0;y<24;y++)for(let x=0;x<48;x++)f[c*48*24+y*48+x]=flat?.5:(Math.floor(x/6)+Math.floor(y/6)+phase)%2?.8:.2;return f;}
it('confirms sustained command/image stall and increases the capped pain rate exponentially',()=>{
  const stall=new VisualStall(48,24,{...DEFAULT_STALL,enabled:true,delaySeconds:1});
  for(let tick=0;tick<=32;tick+=2)stall.observe(pixels(),tick,command,null);
  expect(stall.bit).toBe(1);const early=stall.rate;
  for(let tick=34;tick<=92;tick+=2)stall.observe(pixels(),tick,command,null);
  expect(stall.rate).toBeGreaterThan(early*1.8);
  for(let tick=94;tick<=600;tick+=2)stall.observe(pixels(),tick,command,null);
  expect(stall.rate).toBe(1);expect(stall.painForTick(600)).toBeCloseTo(1/30);
  stall.observe(pixels(1),602,command,null);expect(stall.bit).toBe(0);expect(stall.painForTick(602)).toBe(0);
});
it('does not penalize intended stops, motion, held frames, darkness, or uninformative images',()=>{
  for(const kind of ['stop','brake','motion','held','dark','flat']){
    const stall=new VisualStall(48,24,{...DEFAULT_STALL,enabled:true});
    for(let tick=0;tick<=120;tick+=2)stall.observe(kind==='dark'?new Float32Array(48*24*3):pixels(kind==='motion'?tick/2:0,kind==='flat'),kind==='held'?0:tick,kind==='stop'?{...command,throttle:0}:kind==='brake'?{...command,brake:1}:command,null);
    expect(stall.bit,kind).toBe(0);expect(stall.painForTick(120),kind).toBe(0);
  }
});
it('requires repeated near-front echoes to corroborate a blank wall, and expires stale evidence',()=>{
  const stall=new VisualStall(48,24,{...DEFAULT_STALL,enabled:true});
  for(let tick=0;tick<=60;tick+=2)stall.observe(pixels(0,true),tick,command,{echo:true,range:10,strength:1});
  expect(stall.bit).toBe(1);expect(stall.painForTick(70)).toBe(0);expect(stall.valid).toBe(false);
  const reverse=new VisualStall(48,24,{...DEFAULT_STALL,enabled:true});for(let tick=0;tick<=60;tick+=2)reverse.observe(pixels(0,true),tick,{...command,throttle:0,reverse:1},{echo:true,range:10,strength:1});expect(reverse.bit).toBe(0);
});
it('validates portable stall settings and bounded arrival radius',()=>{
  expect(validateStall(undefined).enabled).toBe(false);
  expect(validateRacingSettings({...DEFAULT_RACING,stall:{...DEFAULT_STALL,enabled:true}}).stall!.enabled).toBe(true);
  for(const stall of [null,false,{...DEFAULT_STALL,maxRate:Infinity},{...DEFAULT_STALL,delaySeconds:0}])expect(()=>validateRacingSettings({...DEFAULT_RACING,stall})).toThrow();
  for(const radius of [0,25,NaN])expect(()=>validateGoalRadius(radius)).toThrow();expect(validateGoalRadius(undefined)).toBe(24);
});
it('requires actual arrival inside the selected yellow area after a confirmed visual sighting',()=>{
  const eyes=serialiseModel(new VisionCnn({...defaultSpec(2,10,'rgb',false),channels:[1,1,1],hidden:4},7),WORLD_CAMERA,Array(10).fill(1),'test',undefined,undefined,'world');
  const setup={seed:7,world:{seed:7,half:460,obstacles:[],patches:[]},start:{x:0,y:0,heading:0},goals:[{x:100,y:0}],task:'explore' as const,goalRadius:10,kind:'vision' as const,sensorOnly:true,controller:new SpikingNetwork(1).toJSON(),vision:eyes,density:0,style:0,fade:0};
  const session=new WorldSession({...setup,searchWin:'reach'});session.discovery!.firstSightTick=2;
  expect(session.won).toBe(false);expect(session.done).toBe(false);
  session.episode.sim.kart.x=80;session.episode.step({steer:0,throttle:0,brake:0});expect(session.won).toBe(false);
  session.episode.sim.kart.x=95;session.episode.step({steer:0,throttle:0,brake:0});expect(session.won).toBe(true);expect(session.done).toBe(true);
  const sight=new WorldSession({...setup,searchWin:'sight'});sight.discovery!.firstSightTick=2;expect(sight.won).toBe(true);expect(sight.done).toBe(true);expect(sight.episode.sim.status.goals).toBe(0);
});
