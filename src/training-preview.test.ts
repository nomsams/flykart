import {describe,it,expect} from 'vitest';
import {SpikingNetwork} from './core';
import {VisionCnn} from './vision/cnn';
import {defaultSpec,serialiseModel} from './vision/perception';
import {ROBOT_WORLD_CAMERA} from './vision/robot';
import {DEFAULT_MEMORY} from './robot/memory';
import {DEFAULT_VISION} from './robot/vision-workbench';
import {DEFAULT_PARKING} from './parking/model';
import {ParkingSession,type ParkingBrain} from './parking/session';
import {capturePreview,TrainingPreviews} from './training-preview';
import {WorldSession,TrackSession} from './vision/ui/sessions';
import {cohortYield} from './vision/cohort-yield';

const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8};
const eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'preview test',undefined,undefined,'world');
const brain:ParkingBrain={controller:new SpikingNetwork(13,19).toJSON(),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512}};
describe('worker observer snapshots',()=>{
  it('round-trips real parking frames, sonar, physics, cues, activity and scores without transporting models',()=>{
    const s=new ParkingSession({...DEFAULT_PARKING,maxTicks:120},brain);for(let i=0;i<45;i++)s.step();
    const raw=capturePreview(s,1,true),row=structuredClone(raw),views=new TrainingPreviews({kind:'parking',brain,settings:s.settings}),v=views.update([row])[0] as ParkingSession;
    expect(v.episode.result()).toEqual(s.episode.result());expect(v.episode.frame).toEqual(s.episode.frame);expect(v.episode.render()).toBe(v.episode.frame);expect(v.driver.sensors).toEqual(s.driver.sensors);expect(v.network.activity()).toEqual(s.network.activity());expect(v.scan.toJSON()).toEqual(s.scan.toJSON());expect(v.cue.sampleTick).toBe(s.cue.sampleTick);expect(v.memory.taught).toBe(s.memory.taught);
    expect(row.state).not.toHaveProperty('brain');expect(row.state).not.toHaveProperty('network');expect(()=>v.step()).toThrow('previews cannot');
    for(let i=0;i<10;i++)s.step();const next=views.update([structuredClone(capturePreview(s,1,false))])[0] as ParkingSession;expect(next).toBe(v);expect(next.episode.tick).toBe(s.episode.tick);expect(next.episode.physics.pose).toEqual(s.episode.physics.pose);expect(next.episode.frame).toEqual(row.state.episode&&(row.state.episode as ParkingSession['episode']).frame);expect(capturePreview(s,1,false).state.episode).not.toHaveProperty('frame');
  });
  it('retains World prototypes, discovery, memory counters and contact-pose scans',()=>{
    const settings={seed:7,density:0,style:0,kind:'vision' as const,fade:0,controller:brain.controller,vision:eyes,task:'explore' as const,maxTicks:120,memorySettings:brain.memory};
    const s=new WorldSession(settings);for(let i=0;i<30;i++)s.step();const v=new TrainingPreviews({kind:'world',settings}).update([structuredClone(capturePreview(s,2,true))])[0] as WorldSession;
    expect(v.episode.tick).toBe(s.episode.tick);expect(v.episode.truth()).toEqual(s.episode.truth());expect(v.discovery?.cue()).toEqual(s.discovery?.cue());expect(v.discovery?.visualViews).toBe(s.discovery?.visualViews);expect(v.sonarMap.toJSON()).toEqual(s.sonarMap.toJSON());expect(v.memory?.taught).toBe(s.memory?.taught);expect(v.done).toBe(s.done);
  });
  it('retains racer episode geometry and aggregate progress',()=>{
    const settings={trackId:'grand-loop',rivals:1,objects:1,style:0,walls:true,controller:brain.controller,vision:null,fade:0,mode:'belief' as const,memory:null,seed:12};
    const s=new TrackSession(settings);for(let i=0;i<15;i++)s.step();const v=new TrainingPreviews({kind:'track',settings}).update([structuredClone(capturePreview(s,3,true))])[0] as TrackSession;
    expect(v.episode.car.position).toEqual(s.episode.car.position);expect(v.episode.truth()).toEqual(s.episode.truth());expect(v.episode.car.totalProgress).toBe(s.episode.car.totalProgress);expect(v.controller.activity()).toEqual(s.controller.activity());expect(v.done).toBe(s.done);
  });
  it('yields zero-delay batches without using a window-style timeout',async()=>{
    const scheduler=cohortYield();try{await scheduler.wait(0);await scheduler.wait(0);}finally{scheduler.close();}
  });
});
