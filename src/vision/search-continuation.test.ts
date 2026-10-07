import { describe, expect, it } from 'vitest';
import racerSource from '../../assets/flykart-brain-racer.json?raw';
import visualSource from '../../assets/flykart-visual.json?raw';
import { SpikingNetwork } from '../core';
import { REPOSITORY_BRAINS } from '../repository-brains';
import { importFile, validateWorldSetup } from './format';
import { WorldSession, WorldSettings } from './ui/sessions';
import { VisionCnn } from './cnn';
import { defaultSpec, serialiseModel } from './perception';
import { WORLD_CAMERA } from './world/worldDomain';
import { WorldScene } from './world/worldScene';
import { DEFAULT_STYLE } from './camera';
import { validateArena } from './world/arena';

const field={seed:7,half:460,obstacles:[],patches:[]};
const eyes=serialiseModel(new VisionCnn({...defaultSpec(2,10,'rgb',false),channels:[1,1,1],hidden:4},7),WORLD_CAMERA,Array(10).fill(1),'regression',undefined,undefined,'world');
const settings:WorldSettings={seed:7,density:0,style:0,kind:'vision',fade:0,task:'explore',searchWin:'reach',goalPreset:'far',world:field,start:{x:0,y:0,heading:Math.PI},controller:new SpikingNetwork(7).toJSON(),vision:eyes,maxTicks:12};

it('continues ten distant arrivals without repeating two points, respawning or retaining a sighting',()=>{
  const s=new WorldSession(settings),controller=s.controller,episode=s.episode,trail=s.trail;
  s.controller.step=()=>({steer:0,throttle:0,brake:0});
  const targets:{x:number;y:number}[]=[];
  for(let i=0;i<10;i++){
    const g={...s.episode.sim.goals[0]};targets.push(g);
    const direction=g.x>=0?1:-1,k=s.episode.sim.kart;k.x=g.x-direction*80;k.y=g.y;k.heading=direction===1?0:Math.PI;k.speed=0;
    for(let n=0;n<5&&!s.found;n++)s.step();
    expect(s.found).toBe(true);expect(s.won).toBe(false);
    k.x=g.x-direction*10;s.step();expect(s.won).toBe(true);
    const pose={...k},tick=s.episode.tick,activity=s.controller.activity();
    expect(s.continueSearch()).toBe(true);
    expect(s.episode).toBe(episode);expect(s.controller).toBe(controller);expect(s.trail).toBe(trail);
    expect(s.episode.tick).toBe(tick);expect(s.episode.sim.kart).toEqual(pose);expect(s.controller.activity()).toEqual(activity);
    expect(s.searchesCompleted).toBe(i+1);expect(s.found).toBe(false);expect(s.done).toBe(false);expect(s.discovery!.cue()).toEqual([0,0]);
    expect(s.episode.sim.status.timedOut).toBe(false);
    const next=s.episode.sim.goals[0];expect(Math.hypot(next.x-k.x,next.y-k.y)).toBeGreaterThanOrEqual(field.half*.7);
    expect(targets.every(t=>Math.hypot(next.x-t.x,next.y-t.y)>0)).toBe(true);
  }
  expect(new Set(targets.map(t=>`${t.x},${t.y}`)).size).toBe(10);expect(s.episode.tick).toBeGreaterThan(s.episode.sim.maxTicks);
  s.episode.sim.status.crashed=true;expect(s.continueSearch()).toBe(false);
});

it('starts a new sight-only search without falsely counting arrival or carrying target tracking',()=>{
  const s=new WorldSession({...settings,searchWin:'sight',goals:[{x:120,y:0}],start:{x:0,y:0,heading:0}});
  s.controller.step=()=>({steer:0,throttle:0,brake:0});for(let i=0;i<4&&!s.done;i++)s.step();
  expect(s.won).toBe(true);expect(s.episode.sim.status.goals).toBe(0);
  expect(s.continueSearch()).toBe(true);expect(s.searchesCompleted).toBe(1);expect(s.episode.sim.status.goals).toBe(0);expect(s.won).toBe(false);
});

it('removes collected flags and rings instead of drawing a stale fallback target',()=>{
  const scene=new WorldScene(field,{...DEFAULT_STYLE});scene.setGoal(100,0);scene.prepare({x:0,y:0,heading:0});
  expect(scene.sprites.filter(s=>s.shape==='flag')).toHaveLength(1);
  scene.setGoals([]);scene.prepare({x:0,y:0,heading:0});expect(scene.sprites.filter(s=>s.shape==='flag')).toHaveLength(0);
  const rgb:[number,number,number]=[0,0,0];scene.ground(120,0,rgb);expect(rgb).not.toEqual([1,.84,.2]);
});

it('loads both repository files unchanged, retaining the saved visual objective and exact source bytes',async()=>{
  const texts=await Promise.all(REPOSITORY_BRAINS.map(b=>b.load()));
  expect(texts[0]).toBe(racerSource);
  expect(texts[1]).toBe(visualSource);
  const visual=importFile(texts[1]);expect(visual.controller!.domain).toBe('world');expect(visual.worldTraining!.task).toBe('explore');expect(visual.worldTraining!.searchWin).toBe('reach');
});

it('keeps repository visual-brain inputs and actions independent of hidden coordinates, truth, rewards and contact labels',async()=>{
  const imported=importFile(await REPOSITORY_BRAINS[1].load());
  const run=(hidden:number)=>{
    const s=new WorldSession({...settings,controller:imported.controller!.snapshot,vision:imported.vision!,goals:[{x:hidden,y:100}],start:{x:0,y:0,heading:0},sonarOn:false});
    s.episode.render=()=>new Float32Array(48*24*3).fill(.1);
    s.episode.mission=()=>{throw Error('Compass leak');};s.episode.truth=()=>{throw Error('Truth leak');};s.episode.lapContext=()=>{throw Error('Pose leak');};
    s.episode.sim.status.score=hidden;s.episode.sim.status.collisions=hidden;s.episode.sim.status.distanceToGoal=hidden;
    const results=[];for(let i=0;i<5;i++){const r=s.driver!.act(s.episode);results.push({inputs:[...r.sensors],action:r.action});s.episode.sim.status.ticks+=2;}
    return results;
  };
  expect(run(100)).toEqual(run(-300));expect(run(100).every(r=>r.inputs[0]===0&&r.inputs[1]===0)).toBe(true);
});

describe('portable live continuation preference',()=>{
  it('validates scene and setup values and keeps old files valid',async()=>{
    const setup=importFile(await REPOSITORY_BRAINS[1].load()).worldSetup!;
    expect(validateWorldSetup({...setup,repeatSearch:false}).repeatSearch).toBe(false);
    expect(()=>validateWorldSetup({...setup,repeatSearch:1})).toThrow(/continuation/);
    expect(validateWorldSetup(setup).repeatSearch).toBeUndefined();
    const a={format:'flykart-world',version:1,world:field,start:{x:0,y:0,heading:0},exercise:{task:'explore',searchWin:'reach',goalPreset:'far',repeatSearch:true}};
    expect(validateArena(a).exercise!.repeatSearch).toBe(true);expect(()=>validateArena({...a,exercise:{...a.exercise,repeatSearch:1}})).toThrow(/continuation/);
  });
});
