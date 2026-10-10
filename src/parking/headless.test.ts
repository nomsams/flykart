import {describe,it,expect} from 'vitest';
import {SpikingNetwork} from '../core';
import {VisionCnn} from '../vision/cnn';
import {defaultSpec,serialiseModel} from '../vision/perception';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import {widenBrain} from '../vision/inputs';
import {DEFAULT_MEMORY} from '../robot/memory';
import {DEFAULT_VISION} from '../robot/vision-workbench';
import {DEFAULT_PARKING,generateParking,validateParkingSettings} from './model';
import {ParkingEpisode} from './episode';
import {ParkingBrain,ParkingSession} from './session';
import {trainParking} from './training';
import {ParkingPresentation} from './presentation';
import {runCohort} from '../vision/cohort';
import {RuntimeBudget} from '../vision/runtime-budget';

const idle={steer:0,throttle:0,brake:0,reverse:0};
const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8};
const eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'headless fixture',undefined,undefined,'world');
const brain=():ParkingBrain=>({controller:widenBrain(new SpikingNetwork(13).toJSON()),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512}});
function slow(mode:'penalty'|'pain'='penalty'){
  const scene=generateParking(DEFAULT_PARKING);scene.actors=[];scene.start={x:.8,z:0,heading:0};scene.target={...scene.target,x:0,z:0,heading:0};scene.bays=scene.bays.map(b=>b.id===scene.target.id?{...scene.target}:b);
  return new ParkingEpisode({...DEFAULT_PARKING,slowDriving:true,slowMode:mode,phase:'frozen',maxTicks:300},ROBOT_WORLD_CAMERA,scene);
}
describe('optional slow-driving costs',()=>{
  it('defaults off and migrates old states; rejects malformed tuning',()=>{
    const old={...DEFAULT_PARKING} as Record<string,unknown>;for(const key of ['slowDriving','slowMode','slowSpeedCm','slowWeight','slowZoneRadius'])delete old[key];expect(validateParkingSettings(old)).toEqual(DEFAULT_PARKING);
    for(const patch of [{slowMode:'wrong'},{slowSpeedCm:0},{slowZoneRadius:.1},{slowWeight:NaN}])expect(()=>validateParkingSettings({...DEFAULT_PARKING,...patch})).toThrow('slow-driving');
  });
  it('charges only after the start grace and exempts the safe target zone',()=>{
    const e=slow();for(let i=0;i<30;i++)e.step(idle);expect(e.status.slowPenalty).toBe(0);for(let i=0;i<30;i++)e.step(idle);expect(e.status.slowPenalty).toBeCloseTo(1);expect(e.status.slowSeconds).toBeCloseTo(1);
    e.physics.pose.x=.35;const before=e.status.slowPenalty;for(let i=0;i<90;i++)e.step(idle);expect(e.status.slowPenalty).toBe(before);expect(e.status.success).toBe(false); // safe zone is broader than arrival tolerance
    const off=slow();off.settings.slowDriving=false;for(let i=0;i<90;i++)off.step(idle);expect(off.status.slowPenalty).toBe(0);
  });
  it('scales by actual travel shortfall in either direction; spinning wheels give no exemption',()=>{
    const values:number[]=[];
    for(const direction of [-1,1]){const e=slow();e.physics.step=()=>{e.physics.pose.x+=direction*.001;};for(let i=0;i<60;i++)e.step({...idle,throttle:direction>0?1:0,reverse:direction<0?1:0});values.push(e.status.slowPenalty);}expect(values[0]).toBeCloseTo(.4);expect(values[1]).toBeCloseTo(.4);
    const fast=slow();fast.physics.step=()=>{fast.physics.pose.x+=.002;};for(let i=0;i<90;i++)fast.step(idle);expect(fast.status.slowPenalty).toBe(0);
    const stuck=slow();stuck.physics.step=()=>{stuck.physics.left=stuck.physics.right=.3;};for(let i=0;i<60;i++)stuck.step({...idle,throttle:1});expect(stuck.status.slowPenalty).toBeCloseTo(1);
  });
  it('pain and score modes remain separate, frozen trials dispense no sugar',()=>{
    const e=slow('pain');for(let i=0;i<60;i++)e.step(idle);expect(e.status.slowPain).toBeCloseTo(1);expect(e.status.pain).toBeCloseTo(1);expect(e.status.slowPenalty).toBe(0);expect(e.status.reward).toBe(0);expect(e.status.score).toBeLessThan(-10);
  });
});
describe('headless presentation and compute',()=>{
  it('uses identical neural inputs, physics, memory and scores while skipping diagnostic maps and trails',()=>{
    const b=brain(),settings={...DEFAULT_PARKING,maxTicks:120,slowDriving:true},shown=new ParkingSession(settings,b),hidden=new ParkingSession(settings,b,{diagnostics:()=>false});
    for(let i=0;i<90;i++){shown.step();hidden.step();expect(hidden.driver.sensors).toEqual(shown.driver.sensors);expect(hidden.episode.physics.pose).toEqual(shown.episode.physics.pose);}
    expect(hidden.episode.result()).toEqual(shown.episode.result());expect(hidden.memory.toJSON()).toEqual(shown.memory.toJSON());expect(hidden.episode.frame).toEqual(shown.episode.frame);expect(hidden.scan.samples).toHaveLength(0);expect(hidden.episode.trail).toHaveLength(0);expect(shown.scan.samples.length).toBeGreaterThan(0);expect(hidden.episode.sonarUnit.count).toBe(shown.episode.sonarUnit.count);
  });
  it('can enable diagnostics mid-run without changing the controller or reconstructing missed scans',()=>{
    let on=false;const s=new ParkingSession({...DEFAULT_PARKING,maxTicks:120},brain(),{diagnostics:()=>on});for(let i=0;i<12;i++)s.step();expect(s.scan.samples).toHaveLength(0);on=true;for(let i=0;i<8;i++)s.step();expect(s.scan.samples.length).toBeGreaterThan(0);const count=s.scan.samples.length;on=false;for(let i=0;i<12;i++)s.step();expect(s.scan.samples).toHaveLength(count);expect(s.episode.tick).toBe(32);
  });
  it('auto-watches selected/every-N generations and returns to maximum headless pacing',()=>{
    const p=new ParkingPresentation();p.mode='headless';p.watchGeneration=3;p.every=5;expect(p.visible(1)).toBe(false);expect(p.visible(3)).toBe(true);expect(p.visible(4)).toBe(false);expect(p.visible(5)).toBe(true);expect(p.visible(0)).toBe(false);expect(p.speed(0,3)).toBe(4);expect(p.speed(0,4)).toBe(0);p.hideGeneration(3);expect(p.visible(3)).toBe(false);expect(p.speed(0,3)).toBe(0);expect(p.visible(5)).toBe(true);p.clearSuppression();expect(p.visible(3)).toBe(true);p.mode='low';expect(p.visible(4)).toBe(true);p.restore({...p.toJSON(),mode:'headless'});expect(p.visible(4)).toBe(false);
    const budget=new RuntimeBudget();budget.mode='turbo';expect(budget.shouldPaint(100)).toBe(false);expect(budget.cohort).toEqual({workMs:32,idleMs:0});budget.mode='headless';expect(budget.cohort.idleMs).toBeGreaterThan(0);
  });
  it('accepts live speed changes without skipping or duplicating simulation steps',async()=>{
    let reads=0;const ghost={ticks:0,get done(){return this.ticks>=6;},step(){this.ticks++;}};await runCohort([ghost],()=>false,()=>{},()=>{reads++;return reads<2?256:0;},()=>({workMs:0,idleMs:0}));expect(reads).toBe(6);expect(ghost.ticks).toBe(6);
  });
  it('selects exactly the same offspring and held-out scores with headless computation',async()=>{
    const settings={...DEFAULT_PARKING,maxTicks:60,slowDriving:true},options={generations:1,population:2,lessons:['arrival'] as const,seed:72,speed:0,cancel:()=>false,log:()=>{},progress:()=>{}};
    const a=(await trainParking(brain(),settings,{...options,lessons:[...options.lessons]}))!,b=(await trainParking(brain(),settings,{...options,lessons:[...options.lessons],preview:()=>false}))!;expect(b.brain).toEqual(a.brain);expect(b.trials).toEqual(a.trials);expect(b.validation).toEqual(a.validation);
  },30000);
});
