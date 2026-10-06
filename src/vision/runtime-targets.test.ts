import { expect,it } from 'vitest';
import { WorldSim,WorldDef,validateGoalCount } from './world/world';
import { WorldSession } from './ui/sessions';
import { SpikingNetwork } from '../core';
import { RuntimeBudget } from './runtime-budget';
import { runCohort } from './cohort';
import { VisionCnn } from './cnn';
import { defaultSpec,serialiseModel } from './perception';
import { WORLD_CAMERA } from './world/worldDomain';
import { ROBOT_PROFILE } from './robot';
import { validateArena } from './world/arena';
import { validateWorldSetup } from './format';
const field:WorldDef={seed:7,half:460,obstacles:[],patches:[]};
const eyes=serialiseModel(new VisionCnn({...defaultSpec(2,10,'rgb',false),channels:[1,1,1],hidden:4},7),WORLD_CAMERA,Array(10).fill(1),'test',undefined,undefined,'world');
it('keeps camera/sonar driving finite when a flag fills the view or is collected',()=>{
  for(const distance of [200,80,50,25,20,5,0]){
    const session=new WorldSession({seed:7,world:field,goals:[{x:100,y:0}],start:{x:100-distance,y:0,heading:0},kind:'vision',sensorOnly:true,controller:new SpikingNetwork(1).toJSON(),vision:eyes,profile:ROBOT_PROFILE,density:0,style:0,fade:0});
    expect(()=>session.step()).not.toThrow();expect([...session.episode.frame].every(Number.isFinite)).toBe(true);expect(Object.values(session.lastAction).every(Number.isFinite)).toBe(true);expect(session.episode.sim.status.crashed).toBe(false);
    if(distance<=20){expect(session.done).toBe(true);expect(session.episode.sim.status.goals).toBe(1);}
  }
});
it('varies random counts and positions reproducibly, across all quadrants',()=>{
  const counts=new Set<number>(),quadrants=new Set<string>();
  for(let seed=1;seed<=30;seed++){
    const options={world:field,goalPreset:'random' as const,goalCount:'random' as const,start:{x:0,y:0,heading:0}};
    const sim=new WorldSim(seed,options);counts.add(sim.goals.length);
    expect(sim.goals).toEqual(new WorldSim(seed,options).goals);expect(sim.goalLimit).toBe(sim.goals.length);
    for(const g of sim.goals){quadrants.add(`${Math.sign(g.x)},${Math.sign(g.y)}`);expect(Math.abs(g.x)).toBeLessThanOrEqual(428);expect(Math.abs(g.y)).toBeLessThanOrEqual(428);}
  }
  expect([...counts].sort()).toEqual([1,2,3,4,5,6]);expect(quadrants.size).toBe(4);
});
it('does not kill a run with an exception when collection leaves no place for another flag',()=>{
  const world:WorldDef={seed:1,half:150,obstacles:[],patches:[{x:0,y:0,radius:120,kind:'water'}]};
  const sim=new WorldSim(7,{world,start:{x:130,y:0,heading:0},goal:{x:130,y:0},goalPreset:'far'});
  expect(()=>sim.step({steer:0,throttle:0,brake:0})).not.toThrow();
  expect(sim.status.goals).toBe(1);expect(sim.status.stopReason).toMatch(/no clear next target/);expect(sim.done).toBe(true);expect(sim.status.crashed).toBe(false);
});
it('requires all selected targets in sensor-only training and stops on the last',()=>{
  const session=new WorldSession({seed:7,world:field,goalCount:5,goalPreset:'random',kind:'expert',sensorOnly:true,controller:new SpikingNetwork(1).toJSON(),vision:null,density:0,style:0,fade:0});
  expect(session.episode.sim.goalLimit).toBe(5);
  for(let i=0;i<5;i++){const sim=session.episode.sim;Object.assign(sim.kart,sim.goals[0]);session.step();expect(sim.status.goals).toBe(i+1);expect(session.done).toBe(i===4);}
});
it('preserves target count through scenes and setups, rejecting invalid values',()=>{
  const scene={format:'flykart-world',version:1,world:field,start:{x:0,y:0,heading:0},goals:[{x:100,y:0}],exercise:{task:'forage',searchWin:'reach',goalPreset:'random',goalCount:'random'}};
  expect(validateArena(scene).exercise!.goalCount).toBe('random');
  const setup={version:1,seed:7,density:0,style:0,driver:'expert',fade:0,goalPreset:'random',goalCount:6,mapPreset:'clear',memoryCount:4096,sonarOn:true,trailVisible:true};
  expect(validateWorldSetup(setup).goalCount).toBe(6);
  for(const value of [0,7,1.5,NaN,'2',null])expect(()=>validateGoalCount(value)).toThrow();
});
it('keeps identical neural actions and physics when only the preview duty cycle changes',async()=>{
  const options={seed:7,world:field,goalPreset:'near' as const,kind:'vision' as const,sensorOnly:true,controller:new SpikingNetwork(1).toJSON(),vision:eyes,density:0,style:0,fade:0,maxTicks:20};
  const normal=new WorldSession(options),low=new WorldSession(options),policy=new RuntimeBudget();policy.mode='headless';
  await runCohort([normal],()=>false,()=>{});await runCohort([low],()=>false,()=>{},0,()=>policy.cohort);
  expect(low.episode.sim.kart).toEqual(normal.episode.sim.kart);expect(low.episode.sim.status).toEqual(normal.episode.sim.status);expect(low.controller.toJSON()).toEqual(normal.controller.toJSON());
});
