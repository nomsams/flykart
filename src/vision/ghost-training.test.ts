import { WorldSession } from './ui/sessions';
import { WorldEpisode } from './world/worldDomain';
import { ROBOT_PROFILE } from './robot';
import { importFile, exportVisionBrain, controllerCheckpoint, validateRoomTraining } from './format';
import { SpikingNetwork } from '../core';
import { RoomMemory } from '../robot/memory';
import { describe,it,expect } from 'vitest';
import { goalScore,reverseCoach } from './world/training';
import { WorldSim, WorldDef } from './world/world';
import { validateArena,reverseGoal } from './world/arena';
import { runCohort } from './cohort';
import { DrivingTrail } from '../robot/driving-trail';
import { HC_SR04 } from './robot';
import { Sonar } from './sonar';
import { SonarHistory } from './sonar-history';
import { mulberry32 } from './rng';

const field:WorldDef={seed:1,half:460,obstacles:[],patches:[]};
const result={arrived:true,ticks:100,collisions:0,progress:1,reverseDistance:50,crashed:false};
describe('Fair goal trials',()=>{
  it('prefers faster arrival, and penalizes contacts at the default 20%',()=>{
    expect(goalScore(result,900,.2)).toBeGreaterThan(goalScore({...result,ticks:200},900,.2));
    expect(goalScore(result,900,.2)).toBeGreaterThan(goalScore({...result,collisions:2},900,.2));
    expect(goalScore(result,900,0)).toBe(goalScore({...result,collisions:2},900,0));
    expect(goalScore(result,900,1)).toBe(goalScore({...result,ticks:200},900,1));
  });
  it('gives no speed bonus to an early crash; arrival beats partial progress',()=>{
    const failed={...result,arrived:false,crashed:true,progress:.5};
    expect(goalScore(failed,900,.2)).toBe(goalScore({...failed,ticks:899},900,.2));
    expect(goalScore({...result,ticks:900,collisions:7},900,.2)).toBeGreaterThan(goalScore({...failed,progress:1,crashed:false},900,.2));
  });
  it('places a reachable reverse target without removing scene objects',()=>{
    const start={x:0,y:0,heading:0},goal=reverseGoal(field,start),world=structuredClone(field);
    const sim=new WorldSim(1,{world,start,goal,goalLimit:1,maxTicks:900});
    while(!sim.done)sim.step({steer:0,throttle:0,brake:0,reverse:1});
    expect(goal.x).toBeLessThan(0);expect(sim.status.goals).toBe(1);expect(sim.status.collisions).toBe(0);expect(sim.status.goalX).toBe(goal.x);expect(sim.status.timedOut).toBe(false);expect(field).toEqual(world);
  });
  it('rejects blocked reverse corridors rather than teleporting through obstacles',()=>{
    const blocked={...field,obstacles:[{x:-50,y:0,radius:45,height:50,tone:.5,kind:'rock' as const}]};
    expect(()=>reverseGoal(blocked,{x:0,y:0,heading:0})).toThrow(/No clear reverse corridor/);
  });
  it('imports bounded scenes atomically and separates exact-centre collisions',()=>{
    const raw={format:'flykart-world',version:1,world:structuredClone(field),start:{x:0,y:0,heading:0}};
    const arena=validateArena(raw);arena.world.half=200;expect(raw.world.half).toBe(460);
    expect(()=>validateArena({...raw,start:{x:1000,y:0,heading:0}})).toThrow(/Start pose/);
    expect(()=>validateArena({...raw,world:{...field,patches:[{x:0,y:0,radius:40,kind:'water'}]}})).toThrow(/Start pose/);
    const sim=new WorldSim(1,{world:{...field,obstacles:[{x:0,y:0,radius:15,height:30,tone:.5,kind:'rock'}]},start:{x:0,y:0,heading:0}});sim.step({steer:0,throttle:0,brake:0});
    expect(Math.hypot(sim.kart.x,sim.kart.y)).toBeGreaterThan(23);
  });
  it('advances independent ghosts and cancels without further work',async()=>{
    const ghost=()=>({ticks:0,get done(){return this.ticks>=3;},step(){this.ticks++;}}),a=ghost(),b=ghost();
    expect(await runCohort([a,b],()=>false,()=>{})).toBe(true);expect(a.ticks).toBe(3);expect(b.ticks).toBe(3);
    const c=ghost();expect(await runCohort([c],()=>true,()=>{})).toBe(false);expect(c.ticks).toBe(0);
  });
});
describe('Diagnostic histories',()=>{
  it('bounds ground traces, rejects teleport lines and clears',()=>{
    const history=new DrivingTrail(3),p={x:0,z:0,heading:0};history.record(p);
    for(let i=1;i<=6;i++)history.record({...p,x:i*.05});expect(history.count).toBe(3);
    const before=history.positions.slice();expect(history.record({...p,x:5})).toBe(false);expect(history.positions).toEqual(before);
    history.break();expect(history.record({...p,x:2})).toBe(false);history.clear();expect(history.count).toBe(0);
  });
  it('maps only fresh sonar readings and keeps angular uncertainty',()=>{
    const unit=new Sonar(HC_SR04,mulberry32(1)),pose={x:0,y:0,heading:0},history=new SonarHistory();
    unit.update(0,pose,[]);history.record(unit,pose);history.record(unit,pose);
    expect(history.samples).toHaveLength(1);expect(history.samples[0].echo).toBe(false);expect(history.samples[0].beam).toBe(15);
    unit.update(2,pose,[]);history.record(unit,pose);expect(history.samples).toHaveLength(2);
  });
});

describe('Portable room settings and physical cues',()=>{
  it('round-trips expanded visual memory and rejects malformed settings before install',()=>{
    const file=JSON.parse(exportVisionBrain({name:'Room',controller:controllerCheckpoint(new SpikingNetwork(1),{domain:'world'}),vision:null,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,world:null,worldMemory:new RoomMemory({count:512,sparsity:.01,rareWeighting:true}).toJSON(),worldArena:validateArena({format:'flykart-world',version:1,world:field,start:{x:0,y:0,heading:0}}),worldTraining:{version:1,task:'reverse',crashWeight:.2,maxTicks:300,memoryEnabled:true,reverseCoach:true}}));
    expect(importFile(JSON.stringify(file)).worldMemory?.settings?.count).toBe(512);
    expect(importFile(JSON.stringify(file)).worldTraining?.crashWeight).toBe(.2);
    file.worldMemory.counts[0]=NaN;expect(()=>importFile(JSON.stringify(file))).toThrow(/Invalid room memory/);
    expect(()=>validateRoomTraining({version:1,task:'reverse',crashWeight:2,maxTicks:300,memoryEnabled:true,reverseCoach:true})).toThrow(/Invalid room training/);
  });
  it('refreshes world sonar at the current simulation tick, not tick zero',()=>{
    const episode=new WorldEpisode({seed:1,profile:ROBOT_PROFILE,headless:true});
    for(let i=0;i<9;i++)episode.step({steer:0,throttle:0,brake:0});const before=episode.sonarUnit!.count;
    episode.refreshSonar();expect(episode.sonarUnit!.count).toBe(before+1);expect(episode.sonarUnit!.lastTick).toBe(9);
  });
  it('coaches straight reversing for a rear goal and brakes forward momentum first',()=>{
    const inputs=Array(17).fill(0);inputs[0]=1;expect(reverseCoach(inputs).steer).toBeCloseTo(0,12);expect(reverseCoach(inputs).reverse).toBe(.8);
    inputs[11]=.2;expect(reverseCoach(inputs).brake).toBe(1);expect(reverseCoach(inputs).reverse).toBe(0);
  });
});

it('applies shared colour-camera noise and brightness to world episodes',()=>{
  const episode=new WorldSession({seed:7,density:.1,style:0,kind:'expert',fade:0,controller:new SpikingNetwork(1).toJSON(),vision:null,cameraNoise:.04,cameraBrightness:.8}).episode;
  expect(episode.style.noise).toBe(.04);expect(episode.style.brightness).toBe(.8);
});

it('does not award an arrival bonus to a fatal contact at the goal',()=>{
  expect(goalScore({...result,crashed:true},900,.2)).toBe(goalScore({...result,arrived:false,crashed:true},900,.2));
});
