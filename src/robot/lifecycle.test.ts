import { describe,it,expect } from 'vitest';
import { SpikingNetwork } from '../core';
import { BLUE_TARGET, DEFAULT_MODULES, TaskBrain, TASK_INPUT_NAMES, racerToRoom, targetSight, taskObservation, validateModules, visualCoach } from './task-brain';
import { DEFAULT_TASK, TaskJudge, movingTarget, taskCase, validateLifecycle } from './lifecycle';
import { DEFAULT_ROBOT, makeObject, robotContactParts, solidsFor } from './model';
import { contactParts, polygonsOverlap } from './contacts';
import { placementError } from './placement';
import { EpisodeStep, TrainingRun } from './training';
import { DEFAULT_VISION, validateVisionSettings } from './vision-workbench';
import { VisionDriver } from '../vision/pipeline';
import { worldDomain } from '../vision/world/worldDomain';
import type { VisionEpisode } from '../vision/domain';
import type { Perceiver } from '../vision/perception';
import { DEFAULT_ADAPTER, motorRequests } from './controls';
const neutral={steer:0,throttle:0,brake:0};
const blue=()=>{const frame=new Float32Array(16*8*3).fill(.1);for(let y=3;y<7;y++)for(let x=11;x<15;x++){const i=y*16+x;frame[i]=.08;frame[128+i]=.3;frame[256+i]=.95;}return frame;};
describe('visual-only deployment contract',()=>{
  it('retains inherited braking in both motor adapters and teaches stopped drive',()=>{
    const b=new TaskBrain(8),input=Array(35).fill(0),base={steer:.8,throttle:.9,reverse:.1,brake:1};
    for(const steering of ['arc','pivot'] as const){const adapter={...DEFAULT_ADAPTER,steering};expect(motorRequests(b.action(input,base,1),adapter)).toEqual(motorRequests(base,adapter));}
    expect(b.action(input,base,.5).brake).toBe(.5);
    for(let i=0;i<1000;i++)b.learn(input,{...base,steer:0},.02);
    const a=b.action(input,neutral,0);expect(Math.abs(a.throttle-(a.reverse??0))).toBeLessThan(.01);
  });
  it('issues camera scan and approach commands above the chassis deadband',()=>{
    const scan=Array(35).fill(0);scan[34]=1;
    const request=motorRequests(visualCoach(scan),DEFAULT_ADAPTER);expect(Math.max(Math.abs(request.left),Math.abs(request.right))/255).toBeGreaterThan(DEFAULT_ROBOT.deadband);
    const approach=[...scan];approach[29]=.4;const near=motorRequests(visualCoach(approach),DEFAULT_ADAPTER);expect(near.left/255).toBeGreaterThan(DEFAULT_ROBOT.deadband);expect(near.right/255).toBeGreaterThan(DEFAULT_ROBOT.deadband);
    approach[25]=1;approach[24]=1-8/220;expect(visualCoach(approach).throttle).toBeGreaterThan(0);
    approach[24]=1-3/220;expect(visualCoach(approach).reverse).toBeGreaterThan(0);
    approach[29]=0;approach[24]=1-15/220;expect(visualCoach(approach).reverse).toBeGreaterThan(0);
  });
  it('rejects privileged modes switched on after construction',()=>{const p={see:()=>({mean:new Float32Array(10),variance:new Float32Array(10),action:new Float32Array(3)})} as unknown as Perceiver,driver=new VisionDriver({controller:new SpikingNetwork(1),perceiver:p,sensorOnly:true});driver.mode='action-average';expect(()=>driver.act({} as VisionEpisode)).toThrow('privileged');});
  it('never calls truth, coordinate mission or pose-indexed memory in sensor-only mode',()=>{const forbidden=()=>{throw Error('Privileged state was accessed');},perceiver={see:()=>({mean:new Float32Array(10).fill(.2),variance:new Float32Array(10).fill(.1),action:new Float32Array(3)}),reset:()=>{}} as unknown as Perceiver,episode={tick:0,render:()=>blue(),proprioception:()=>({speed:0,lastSteer:0,lastDrive:0}),sonar:()=>null,truth:forbidden,mission:forbidden,lapContext:forbidden} as unknown as VisionEpisode,driver=new VisionDriver({controller:new SpikingNetwork(3),perceiver,domain:worldDomain,sensorOnly:true,fusion:{fade:1000}});expect(driver.act(episode).sensors.slice(0,2)).toEqual([0,0]);expect(()=>new VisionDriver({controller:new SpikingNetwork(3),perceiver:null,sensorOnly:true})).toThrow();expect(()=>new VisionDriver({controller:new SpikingNetwork(3),perceiver,sensorOnly:true,mode:'action-average'})).toThrow();});
  it('finds the ball only in visible pixels and masks disabled channels',()=>{const frame=blue(),sight=targetSight(frame,16,8,BLUE_TARGET);expect(sight.visible).toBe(true);expect(sight.bearing).toBeGreaterThan(.5);const input=taskObservation(frame,16,8,DEFAULT_MODULES,BLUE_TARGET,30,[.2,.3],true);expect(input).toHaveLength(35);expect(input[30]).toBe(0);expect(input[31]).toBe(0);expect(input[33]).toBe(0);expect(input[34]).toBe(1);const dark=taskObservation(frame,16,8,{camera:false,sonar:false,bumper:false,light:true},BLUE_TARGET,30,[.2,.3],true);expect(dark.slice(0,26)).toEqual(Array(26).fill(0));expect(dark.slice(28)).toEqual(Array(7).fill(0));expect(TASK_INPUT_NAMES.join(' ')).not.toMatch(/reward|score|pose|sugar|pain|position/);});
  it('represents installed contact and image-derived light with separate validity bits',()=>{const input=taskObservation(blue(),16,8,{...DEFAULT_MODULES,bumper:true,light:true},BLUE_TARGET,null,[0,0],false);expect(input[25]).toBe(0);expect(input[30]).toBe(0);expect(input[31]).toBe(1);expect(input[32]).toBeGreaterThan(0);expect(input[33]).toBe(1);expect(taskObservation(blue(),16,8,{...DEFAULT_MODULES,bumper:true},BLUE_TARGET,null,[0,0],null)[31]).toBe(0);expect(()=>validateModules({camera:1})).toThrow();});
  it('learns pixel-conditioned actions and round-trips frozen weights',()=>{const b=new TaskBrain(8),input=taskObservation(blue(),16,8,DEFAULT_MODULES,BLUE_TARGET,120,[0,0],null),target=visualCoach(input),before=b.action(input,neutral,0);for(let i=0;i<1000;i++)b.learn(input,target,.02);const after=b.action(input,neutral,0);expect(Math.abs(after.steer-target.steer)).toBeLessThan(Math.abs(before.steer-target.steer)*.1);expect(TaskBrain.fromJSON(b.toJSON()).action(input,neutral,0)).toEqual(after);const copy=b.toJSON();expect(()=>TaskBrain.fromJSON({...copy,inputs:[...copy.inputs,'reward']})).toThrow();expect(b.mutate(1,.2,99).toJSON()).not.toEqual(copy);expect(b.toJSON()).toEqual(copy);});
  it('transfers matching inputs and retains the parent circuit without mutating it',()=>{const parent=new SpikingNetwork(10).toJSON(),before=structuredClone(parent),child=racerToRoom(parent);expect(parent).toEqual(before);expect(child.inputCount).toBe(19);expect(child.recurrentWeights).toEqual(parent.recurrentWeights);expect(child.outputWeights).toEqual(parent.outputWeights);for(let n=0;n<48;n++){expect(child.inputWeights[n*19+11]).toBe(parent.inputWeights[n*17+3]);expect(child.inputWeights[n*19+12]).toBe(parent.inputWeights[n*17+14]);expect(child.inputWeights[n*19+13]).toBe(parent.inputWeights[n*17+15]);expect(child.inputWeights[n*19]).toBe(0);expect(child.inputWeights[n*19+17]).toBe(0);}});
});
describe('external task rewards and fair offspring selection',()=>{
  it('places held-out targets outside furniture legs without excluding clear under-table space',()=>{
    let underTable=0;
    for(const room of ['empty','room','living','office'])for(let seed=0;seed<60;seed++){
      const c=taskCase(seed,true,DEFAULT_TASK,room),ball=contactParts(c.ball,solidsFor(c.ball),c.ball.height)[0];
      expect(placementError(c.pose,DEFAULT_ROBOT,c.objects)).toBeNull();
      const furniture=c.objects.filter(o=>o.id!==c.ball.id);
      expect(furniture.flatMap(o=>contactParts(o,solidsFor(o),c.ball.height)).some(p=>polygonsOverlap(ball.polygon,p.polygon))).toBe(false);
      underTable+=Number(furniture.some(o=>o.kind==='table'&&Math.abs(o.x-c.ball.x)<o.width/2&&Math.abs(o.z-c.ball.z)<o.depth/2));
    }
    expect(underTable).toBeGreaterThan(0);expect(()=>taskCase(-1,false,DEFAULT_TASK)).toThrow();expect(()=>taskCase(1,false,DEFAULT_TASK,'typo')).toThrow();
  });
  it('rewards approach once and does not farm stationary proximity',()=>{const settings={...DEFAULT_TASK,mode:'approach' as const},judge=new TaskJudge(settings,0),ball=makeObject('ball',0,0);judge.update({x:-1,z:0,heading:0},ball,false,.1);expect(judge.update({x:-.18,z:0,heading:0},ball,false,.1).amount).toBe(10);expect(judge.update({x:-.18,z:0,heading:0},ball,false,20).amount).toBe(0);expect(judge.success).toBe(true);});
  it('charges pain on contact entry even without an installed collision sensor',()=>{const judge=new TaskJudge({...DEFAULT_TASK,mode:'approach'},0),ball=makeObject('ball',0,0),pose={x:-1,z:0,heading:0};expect(judge.update(pose,ball,true,.1).amount).toBe(-1);expect(judge.update(pose,ball,true,.1).amount).toBe(0);judge.update(pose,ball,false,.1);expect(judge.update(pose,ball,true,.1).amount).toBe(-1);});
  it('requires continuous following and resets hold when too near or far',()=>{const judge=new TaskJudge({...DEFAULT_TASK,mode:'follow',hold:2},0),ball=makeObject('ball',0,0),p={x:-.35,z:0,heading:0};judge.update(p,ball,false,1.2);judge.update({...p,x:-1},ball,false,.1);expect(judge.hold).toBe(0);judge.update(p,ball,false,1.2);expect(judge.success).toBe(false);judge.update(p,ball,false,1);expect(judge.success).toBe(true);expect(judge.total).toBe(10);});
  it('has seeded separate held-out cases and visible sphere contact geometry',()=>{const a=taskCase(42,false,DEFAULT_TASK),b=taskCase(42,false,DEFAULT_TASK);expect(a.ball.x).toBe(b.ball.x);expect(a.ball.z).toBe(b.ball.z);expect(taskCase(42,true,DEFAULT_TASK).ball.z).not.toBe(a.ball.z);const p=robotContactParts(a.ball,DEFAULT_ROBOT)[0];expect(p.part).toBe('blue ball surface');expect(p.polygon.length).toBeGreaterThan(4);expect(movingTarget(a.ball,10,.1)).not.toEqual({x:a.ball.x,z:a.ball.z});});
  it('selects matching fly and task genotypes while retaining the incumbent on ties',()=>{const brain=new SpikingNetwork(2),head=new TaskBrain(7),run=new TrainingRun(brain,{evolve:true,seconds:5,episodes:1,population:2,generations:1,seed:1,rate:1,amount:.2,task:true,visualTask:head.toJSON()}),first=run.visualTask!.toJSON(),step:EpisodeStep={time:1,inputs:Array(17).fill(0),action:neutral,pwm:[0,0],cameraFrame:1,sonar:{cm:null,echo:false},evaluation:{pose:{x:0,z:0,heading:0},blocked:false,contact:null,surface:null,taskReward:0}};run.recorder.step(step,1);expect(run.advance()).toBe(true);expect(run.visualTask!.toJSON()).not.toEqual(first);run.recorder.step({...step,evaluation:{...step.evaluation,taskReward:20,success:true}},1);expect(run.advance()).toBe(false);expect(run.bestVisualTask!.origin).toBe('Visual task offspring');expect(head.toJSON()).toEqual(first);});
  it('validates lineage/schema and permits old swarm presets',()=>{const s={format:'robot-lifecycle',version:1,settings:DEFAULT_TASK,brain:new TaskBrain().toJSON(),lineage:[],evidence:[],parent:{domain:'track',brain:new SpikingNetwork(1).toJSON()}};expect(validateLifecycle(s).parent?.brain).toEqual(s.parent.brain);expect(()=>validateLifecycle({...s,parent:{domain:'world',brain:{}}})).toThrow();expect(validateVisionSettings(DEFAULT_VISION)).toEqual(DEFAULT_VISION);expect(()=>validateVisionSettings({...DEFAULT_VISION,memberWeights:[0,0,0,0,0]})).toThrow();});
});
