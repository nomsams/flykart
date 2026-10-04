import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { VisionCnn, NetSpec } from "../vision/cnn";
import { serialiseModel } from "../vision/perception";
import { DEFAULT_CAMERA } from "../vision/camera";
import { RoomMemory, DEFAULT_MEMORY, validateMemorySettings } from "./memory";
import { DEFAULT_OBJECTIVE, MissionSnapshot, ObjectiveRun, SugarPolicy, cameraCue, scentCue, validateMission } from "./objectives";
import { DEFAULT_VISION, VisualFilter, VisualSwarm, cropView, viewPatches, validateVisionSettings } from "./vision-workbench";
import { placementError, validatePose } from "./placement";
import { DEFAULT_ROBOT, makeObject } from "./model";
import { EpisodeRecorder, EpisodeStep } from "./training";

const mission=():MissionSnapshot=>({settings:{...DEFAULT_OBJECTIVE,mode:"sugar"},goals:[{id:"sugar-a",x:0,z:0,yaw:0,radius:.15,amount:10}],trail:[]});
const pose=(x=0,z=0,heading=0)=>({x,z,heading});
const gradient=(w=16,h=8)=>Float32Array.from({length:w*h*3},(_,i)=>.2+(i%w)/w*.5);
describe("graded, configurable visual memory",()=>{
  it("uses sparse expanded capacity without teaching while frozen",()=>{
    const m=new RoomMemory(),f=gradient().slice(0,24),e=new Float32Array(10).fill(.7);
    m.observe(f,e,false);expect(m.count).toBe(4096);expect(m.active).toHaveLength(41);expect(m.taught).toBe(0);
    for(let i=0;i<3;i++)m.observe(f,e);expect(m.observe(f,e,false)?.[0]).toBeCloseTo(.7);expect(m.occupancy).toBeCloseTo(41/4096);
    const snapshot=m.toJSON();expect(RoomMemory.fromJSON(snapshot).observe(f,e,false)).toEqual(m.observe(f,e,false));expect(m.toJSON()).toEqual(snapshot);
    const big=new RoomMemory({...DEFAULT_MEMORY,count:20000});big.observe(f,e);expect(big.active).toHaveLength(200);expect(big.fresh().taught).toBe(0);
  },20000);
  it("preserves version-one projection and activity after import and reset",()=>{
    const legacy=new RoomMemory({count:512,sparsity:16/512,rareWeighting:false},true),f=new Float32Array(24).fill(.3),e=new Float32Array(10).fill(.4);
    for(let i=0;i<3;i++)legacy.observe(f,e);
    const saved=legacy.toJSON();delete saved.settings;const loaded=RoomMemory.fromJSON(saved);
    expect(loaded.observe(f,e,false)?.[0]).toBeCloseTo(.4);expect(loaded.active).toEqual(legacy.active);expect(loaded.active).toHaveLength(16);
    const fresh=loaded.fresh();fresh.observe(f,e);expect(fresh.active).toEqual(legacy.active);expect(fresh.toJSON().version).toBe(1);
  });
  it("rejects inconsistent snapshots and settings before allocating projections",()=>{
    expect(()=>validateMemorySettings({...DEFAULT_MEMORY,count:999999})).toThrow();expect(()=>validateMemorySettings({...DEFAULT_MEMORY,sparsity:0})).toThrow();
    const m=new RoomMemory();expect(()=>RoomMemory.fromJSON({...m.toJSON(),prototypes:[[]]})).toThrow();expect(()=>m.observe(new Float32Array(24).fill(NaN),[])).toThrow();
  });
});
describe("external sugar evaluation and learned associations",()=>{
  it("awards a crossed target once per episode and penalizes contact entry once",()=>{
    const r=new ObjectiveRun(mission());r.update(pose(-.5),false);expect(r.update(pose(.5),false)[0].amount).toBe(10);
    expect(r.update(pose(0),false)).toEqual([]);expect(r.update(pose(0),true)[0].amount).toBe(-1);expect(r.update(pose(0),true)).toEqual([]);
    r.update(pose(),false);expect(r.update(pose(),true)[0].amount).toBe(-1);expect(r.total).toBe(8);
    expect(new ObjectiveRun(mission()).update(pose(),false)[0].kind).toBe("sugar");
  });
  it("only rewards trail checkpoints in order",()=>{
    const m=mission();m.settings.mode="trail";m.goals=[];m.trail=[{x:0,z:0},{x:1,z:0}];const r=new ObjectiveRun(m);
    expect(r.update(pose(1),false)).toEqual([]);expect(r.checkpoint).toBe(0);expect(r.update(pose(),false)[0].kind).toBe("trail");expect(r.update(pose(1),false)[0].amount).toBe(2);expect(r.checkpoint).toBe(2);
  });
  it("reads visible colour cues with correct left/right bearing and does not use goal coordinates",()=>{
    const f=new Float32Array(8*4*3),n=32;for(let y=0;y<4;y++)for(let x=5;x<8;x++){f[y*8+x]=1;f[2*n+y*8+x]=1;}
    expect(cameraCue(f,8,4,"sugar").bearing).toBeGreaterThan(0);expect(cameraCue(f,8,4,"sugar").strength).toBe(1);expect(cameraCue(f,8,4,"explore").strength).toBe(0);
    const reflected=f.slice();for(let k=0;k<3;k++)for(let y=0;y<4;y++)for(let x=0;x<8;x++)reflected[k*n+y*8+x]=f[k*n+y*8+7-x];expect(cameraCue(reflected,8,4,"sugar").bearing).toBeLessThan(0);
  });
  it("models local virtual antennae, distance and exponential decay without a sugar reward",()=>{
    const m=mission();m.settings.mode="trail";m.settings.decay=.2;m.goals=[];m.trail=[{x:0,z:.2},{x:1,z:.2}];
    const near=scentCue(pose(),m,0),far=scentCue(pose(0,-2),m,0);expect(near.bearing).toBeGreaterThan(0);expect(near.strength).toBeGreaterThan(far.strength);expect(scentCue(pose(),m,5).strength).toBeCloseTo(near.strength*Math.exp(-1));
    expect(new ObjectiveRun(m).update(pose(0,-2),false)).toEqual([]);
  });
  it("strengthens recent visual-action associations and retains them through export",()=>{
    const p=new SugarPolicy(512),cells=[1,7,18];p.remember(cells,{steer:.7,throttle:.5,brake:0});const untouched=p.toJSON();expect(untouched.weights.every(v=>v===0)).toBe(true);
    p.reward(10);expect(p.toJSON().weights[7*3+2]).toBeGreaterThan(0);p.reset();const recovered=SugarPolicy.fromJSON(p.toJSON(),512);
    const base={steer:0,throttle:.5,brake:0},cue={bearing:0,strength:0,antennae:[0,0,0] as [number,number,number]};expect(recovered.action(cells,base,cue,0,false).steer).toBeGreaterThan(.4);
    const snapshot=recovered.toJSON();for(let i=0;i<20;i++)recovered.action(cells,base,cue,0,false);expect(recovered.toJSON()).toEqual(snapshot);expect(()=>SugarPolicy.fromJSON(snapshot,2048)).toThrow();
  });
  it("includes reward in episode score and labels, without adding it to neural inputs",()=>{
    const r=new EpisodeRecorder(),s:EpisodeStep={time:0,inputs:Array(19).fill(0),action:{steer:0,throttle:0,brake:0},pwm:[0,0],cameraFrame:1,sonar:{cm:null,echo:false},evaluation:{pose:pose(),blocked:false,contact:null,surface:null,taskReward:10}};
    r.step(s,1/30);const result=r.finish(1,0,1);expect(result.summary.score).toBe(10);expect(result.summary.taskReward).toBe(10);expect(result.steps[0].inputs).toEqual(Array(19).fill(0));
  });
  it("rejects nonfinite, duplicated or reserved goal identities",()=>{
    expect(()=>validateMission({...mission(),goals:[{...mission().goals[0],id:"@robot"}]})).toThrow();expect(()=>validateMission({...mission(),goals:[mission().goals[0],mission().goals[0]]})).toThrow();expect(()=>validateMission({...mission(),trail:[{x:NaN,z:0}]})).toThrow();
  });
});
describe("actual captured-frame filtering and gaze diversity",()=>{
  it("averages distinct recent frames and clears stale history on reset",()=>{
    const filter=new VisualFilter(),s={...DEFAULT_VISION,temporal:4};filter.process(new Float32Array(12).fill(0),2,2,s);expect(filter.process(new Float32Array(12).fill(1),2,2,s)[0]).toBe(.5);
    filter.reset();expect(filter.process(new Float32Array(12).fill(1),2,2,s)[0]).toBe(1);
  });
  it("normalizes a brightness shift and smooths a noisy pixel",()=>{
    const f=gradient(),s={...DEFAULT_VISION,normalize:true};const a=new VisualFilter().process(f,16,8,s),b=new VisualFilter().process(f.map(v=>v+.1),16,8,s);for(let i=0;i<a.length;i++)expect(a[i]).toBeCloseTo(b[i],5);
    const noise=new Float32Array(27);noise[4]=1;expect(new VisualFilter().process(noise,3,3,{...DEFAULT_VISION,smooth:true})[4]).toBeCloseTo(1/9);
  });
  it("produces different bounded crops, leaving the source pixels intact",()=>{
    const f=gradient(),copy=f.slice(),patches=viewPatches({...DEFAULT_VISION,layout:"circle5"});expect(patches).toHaveLength(5);
    expect(cropView(f,16,8,patches[1])).not.toEqual(cropView(f,16,8,patches[3]));expect(f).toEqual(copy);expect(cropView(f,16,8,patches[0])).toEqual(copy);
    for(const p of patches)expect(Math.abs(p.x)+p.scale/2).toBeLessThanOrEqual(.5);expect(()=>validateVisionSettings({...DEFAULT_VISION,temporal:3})).toThrow();
  });
  it("runs separate real eye networks and finite neural votes, while preserving 19 inputs",()=>{
    const spec:NetSpec={width:16,height:8,frames:2,channels:[3,4,4],hidden:6,extra:5,outputs:23};const model=serialiseModel(new VisionCnn(spec,9),DEFAULT_CAMERA,Array(10).fill(1),"test",undefined,undefined,"world");
    const swarm=new VisualSwarm(model,{...DEFAULT_VISION,layout:"circle3"}),body={speed:0,lastSteer:0,lastDrive:0,sonarCloseness:.5,sonarStrength:1},brain=new SpikingNetwork(8,19),inputs=Array(19).fill(0);inputs[17]=.5;inputs[18]=1;
    expect(swarm.see(gradient(),body,"world")).toHaveLength(10);expect(swarm.members).toHaveLength(3);expect(swarm.members[1].frame).not.toEqual(swarm.members[2].frame);
    const action=swarm.step(brain,inputs,body,[0,0],"world");expect(Object.values(action).every(Number.isFinite)).toBe(true);expect(inputs).toHaveLength(19);expect(inputs[18]).toBe(1);
    swarm.reset();expect(swarm.members).toHaveLength(0);swarm.see(gradient(),body,"track");expect(swarm.members).toHaveLength(1);
  });
});
describe("editable robot placement",()=>{
  it("allows table clearance and low cables, but rejects legs, walls and floor overflow",()=>{
    const table=makeObject("table",0,0),cable=makeObject("cable",0,0);expect(placementError(pose(),DEFAULT_ROBOT,[table])).toBeNull();expect(placementError(pose(),DEFAULT_ROBOT,[cable])).toBeNull();
    expect(placementError(pose(),DEFAULT_ROBOT,[makeObject("wall",0,0)])).toMatch(/overlaps/);expect(placementError(pose(3.45),DEFAULT_ROBOT,[])).toMatch(/fit/);expect(()=>validatePose(pose(Infinity))).toThrow();
  });
});
