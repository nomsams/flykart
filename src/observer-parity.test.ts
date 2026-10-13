import {describe,it,expect} from 'vitest';
import {cartHit} from './cart-inspection';
import {DEFAULT_OBSERVER,validateObserverSettings,applyObserverSettings,observerSettings} from './observer-settings';
import {DEFAULT_SEARCH_JUDGE} from './vision/world/search-judge';
import {DEFAULT_PARKING} from './parking/model';
import {parkingProgressJudge,applyParkingProgressJudge} from './parking/progress-judge';
import {RobotTrialJudge} from './robot/trial-judge';
import {SpikingNetwork} from './core';
import {EpisodeRecorder,TrainingRun,type EpisodeStep} from './robot/training';
import {validateReplay} from './robot/replay';
import {controllerCheckpoint,exportVisionBrain,importFile} from './vision/format';
import {DEFAULT_ROBOT,RobotSonar,makeObject} from './robot/model';
import {SonarHistory} from './vision/sonar-history';
const pose={x:0,z:0,heading:0};
const step:EpisodeStep={time:1,inputs:[.1,.2],action:{steer:0,throttle:.4,brake:0},pwm:[100,100],cameraFrame:1,sonar:{cm:null,echo:false},evaluation:{pose,blocked:false,contact:null,surface:null}};
describe('portable observer and shared motion policy',()=>{
  it('cycles overlapping carts and ignores clicks outside their rendered footprint',()=>{
    const points=[{x:20,y:30},{x:20,y:30},{x:80,y:30}];
    expect(cartHit(points,20,30,-1,12)).toBe(0);expect(cartHit(points,20,30,0,12)).toBe(1);expect(cartHit(points,20,30,1,12)).toBe(0);expect(cartHit(points,81,30,0,12)).toBe(2);expect(cartHit(points,50,50,0,12)).toBe(-1);
  });
  it('validates portable views, retains them without storage, and round-trips them without changing weights',()=>{
    const brain=new SpikingNetwork(51,19),settings={...DEFAULT_OBSERVER,fpv:{mode:'overlay' as const,opacity:55},scan:{evidence:'cells' as const,transmission:false}};
    applyObserverSettings(settings);expect(observerSettings()).toEqual(settings);
    const file={name:'portable',profile:'robot' as const,controller:controllerCheckpoint(brain,{domain:'world'}),vision:null,fusion:{fade:0,mode:'belief' as const,visionTemperature:1},memory:null,world:null,roomMemoryEnabled:false,observerSettings:settings,progressJudge:{...DEFAULT_SEARCH_JUDGE,zeroChill:true}};
    const imported=importFile(exportVisionBrain(file));expect(imported.observerSettings).toEqual(settings);expect(imported.progressJudge?.zeroChill).toBe(true);expect(imported.roomMemoryEnabled).toBe(false);expect(imported.controller?.snapshot).toEqual(brain.toJSON());
    expect(()=>validateObserverSettings({...settings,fpv:{mode:'overlay',opacity:NaN}})).toThrow();expect(()=>importFile(JSON.stringify({...JSON.parse(exportVisionBrain(file)),progressJudge:{enabled:true}}))).toThrow();expect(()=>exportVisionBrain({...file,progressJudge:{...DEFAULT_SEARCH_JUDGE,weight:NaN}})).toThrow();
  });
  it('transfers only common motion policy and preserves parking task-specific rewards',()=>{
    const p={...DEFAULT_PARKING,strictCrash:true,antiJiggle:true,jiggleWeight:3,reverseReward:true},common=parkingProgressJudge(p),restored=applyParkingProgressJudge(DEFAULT_PARKING,common);
    expect(common.blindReverse).toBe(false);expect(restored.strictCrash).toBe(true);expect(restored.jiggleWeight).toBe(3);expect(restored.reverseReward).toBe(DEFAULT_PARKING.reverseReward);
    expect(applyParkingProgressJudge(DEFAULT_PARKING,undefined)).toBe(DEFAULT_PARKING);
  });
  it('keeps sonar acquisition pose while the body later moves and records held samples once',()=>{
    const unit=new RobotSonar(),p={...pose},wall={...makeObject('wall',1,0),yaw:Math.PI/2},history=new SonarHistory();
    unit.update(1,p,[wall],DEFAULT_ROBOT);const acquired={...unit.samplePose!};p.x=2;
    history.record(unit,{x:999,y:999,heading:2});history.record(unit,{x:999,y:999,heading:2});expect(history.samples).toHaveLength(1);expect(history.samples[0].x).toBeCloseTo(acquired.x+unit.spec.mountForward);expect(unit.lastTick).toBe(30);expect(unit.samplePose).toEqual(acquired);
  });
  it('allows productive reverse travel, scores stationary failure externally, and rejects a new contact',()=>{
    const cfg={...DEFAULT_SEARCH_JUDGE,blindReverse:false,zeroChill:true},moving=new RobotTrialJudge(cfg,pose),idle=new RobotTrialJudge(cfg,pose),contact=new RobotTrialJudge(cfg,pose,3);
    for(let i=1;i<=360;i++){moving.observe({x:-i*.01,z:0,heading:0},i/30,-1,0,0,false,0);idle.observe(pose,i/30,1,0,0,false,0);}
    expect(moving.judge.disqualified).toBe(false);expect(idle.judge.disqualified).toBe(true);expect(idle.judge.pain).toBeGreaterThan(0);expect(idle.judge.penalty).toBeGreaterThan(0);
    expect(contact.observe(pose,1,1,0,0,false,3).disqualified).toBe(false);expect(contact.observe(pose,2,1,0,0,false,4).disqualified).toBe(true);
  });
  it('records pain and negative reward separately, validates replay, and never feeds them into the controller',()=>{
    const r=new EpisodeRecorder();r.step({...step,evaluation:{...step.evaluation,taskReward:5,judgePain:2,judgePenalty:3}},1/30);
    const data=r.finish(1,0,1,true);expect(data.summary.judgePain).toBe(2);expect(data.summary.judgePenalty).toBe(3);expect(data.summary.score).toBeCloseTo(5-3-1/600);expect(data.steps[0].inputs).toEqual(step.inputs);expect(validateReplay(data)).toEqual(data);
    expect(()=>validateReplay({...data,steps:[{...data.steps[0],evaluation:{...data.steps[0].evaluation,judgePain:-1}}]})).toThrow(/judge/);
  });
  it('retains the parent when every candidate is rejected and excludes a rejected high-reward candidate',()=>{
    const parent=new SpikingNetwork(7,19),options={evolve:true,seconds:5,episodes:1,population:2,generations:1,seed:1,rate:.5,amount:.5},all=new TrainingRun(parent,options),mixed=new TrainingRun(parent,options);
    for(let i=0;i<2;i++){all.recorder.step({...step,evaluation:{...step.evaluation,taskReward:1e9,disqualified:true}},1/30);all.advance();}
    expect(all.best).toEqual(parent.toJSON());expect(all.completedGeneration).toBe(0);
    mixed.recorder.step(step,1/30);mixed.advance();mixed.recorder.step({...step,evaluation:{...step.evaluation,taskReward:1e9,disqualified:true}},1/30);mixed.advance();expect(mixed.best).toEqual(parent.toJSON());expect(mixed.results[1].score).toBe(-1e6);
  });
});
