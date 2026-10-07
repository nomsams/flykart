import { describe, expect, it } from 'vitest';
import { SpikingNetwork, wrapAngle } from '../core';
import { FlagDiscovery } from './world/discovery';
import { WorldEpisode, WORLD_CAMERA, worldDomain } from './world/worldDomain';
import { WorldDef, WorldSim } from './world/world';
import { WorldSession, WorldSettings } from './ui/sessions';
import { discoveryScore, goalResult, trainWorldController } from './world/training';
import { controllerCheckpoint, exportVisionBrain, importFile, validateRoomTraining } from './format';
import { VisionCnn } from './cnn';
import { defaultSpec, Perceiver, serialiseModel } from './perception';
import { VisionDriver } from './pipeline';
import { DEFAULT_VISION } from '../robot/vision-workbench';
import { targetComponents } from '../robot/target-tracker';

const field:WorldDef={seed:1,half:460,obstacles:[],patches:[]};
const spec={...defaultSpec(2,10,'rgb',false),channels:[1,1,1] as [number,number,number],hidden:4};
const eyes=serialiseModel(new VisionCnn(spec,7),WORLD_CAMERA,Array(10).fill(1),'test',undefined,undefined,'world');
const settings:WorldSettings={seed:7,density:0,style:0,kind:'vision',fade:0,task:'explore',world:field,start:{x:0,y:0,heading:0},controller:new SpikingNetwork(7).toJSON(),vision:eyes,maxTicks:300};
function pixels(flag=true):Float32Array {
  const image=new Float32Array(48*24*3).fill(.1),n=48*24;
  if(flag)for(let y=5;y<18;y++)for(let x=30;x<33;x++){const k=y*48+x;image[k]=1;image[n+k]=.2;image[2*n+k]=.62;}
  return image;
}

describe('Pixel discovery without a goal oracle',()=>{
  it('confirms fresh frames only and zeroes target cues when it disappears',()=>{
    const d=new FlagDiscovery(48,24,WORLD_CAMERA.hfov);
    d.observe(pixels(),0);expect(d.firstSightTick).toBeNull();expect(d.cue()[0]).toBeGreaterThan(0);expect(d.cue()[1]).toBeGreaterThan(0);
    d.observe(pixels(),0);expect(d.firstSightTick).toBeNull();d.observe(pixels(),2);expect(d.firstSightTick).toBe(2);
    d.observe(pixels(false),4);expect(d.cue()).toEqual([0,0]);expect(d.firstSightTick).toBe(2);
    d.reset();expect(d.firstSightTick).toBeNull();expect(d.visualViews).toBe(0);
  });
  it('requires consecutive sightings, not two glimpses separated by a blank frame',()=>{
    const d=new FlagDiscovery(48,24,WORLD_CAMERA.hfov);d.observe(pixels(),0);d.observe(pixels(false),2);d.observe(pixels(),4);expect(d.firstSightTick).toBeNull();d.observe(pixels(),6);expect(d.firstSightTick).toBe(6);
  });
  it('detects real rendered flags and respects camera occlusion',()=>{
    const make=(world:WorldDef)=>new WorldEpisode({seed:7,world,start:{x:0,y:0,heading:0},goal:{x:160,y:0},goalLimit:1});
    const open=make(field),d=new FlagDiscovery(48,24,WORLD_CAMERA.hfov);d.observe(open.render(),0);d.observe(open.render(),2);expect(d.firstSightTick).toBe(2);
    const blocked=make({...field,obstacles:[{x:60,y:0,radius:30,height:100,kind:'rock',tone:.5}]});d.reset();d.observe(blocked.render(),0);d.observe(blocked.render(),2);expect(d.firstSightTick).toBeNull();expect(d.cue()).toEqual([0,0]);
    open.sim.kart.heading=Math.PI;d.reset();d.observe(open.render(),0);expect(d.cue()).toEqual([0,0]);
  });
  it('starts targets outside calibrated FOV, with reproducible positions and intact geometry',()=>{
    const bearings:number[]=[];
    for(let seed=1;seed<=12;seed++){
      const s=new WorldSession({...settings,seed,goalPreset:'pair'}),g=s.episode.sim.goals[0];
      const angle=wrapAngle(Math.atan2(g.y,g.x)-s.initialPose.heading);bearings.push(angle);
      expect(Math.abs(angle)).toBeGreaterThanOrEqual(s.episode.camera.hfov/2+.25);expect(s.episode.sim.goals).toHaveLength(1);expect(s.episode.sim.goalLimit).toBe(1);
      s.step();expect(s.discovery!.firstSightTick).toBeNull();expect(s.driver!.sensors.slice(0,2)).toEqual([0,0]);
      expect(s.episode.sim.goals).toEqual(new WorldSession({...settings,seed,goalPreset:'pair'}).episode.sim.goals);expect(s.episode.sim.world).toEqual(field);
    }
    expect(bearings.some(a=>a<0)).toBe(true);expect(bearings.some(a=>a>0)).toBe(true);
    expect(()=>new WorldSim(1,{hiddenGoalAngle:Math.PI})).toThrow(/Invalid hidden/);
    expect(()=>new WorldSession({...settings,start:{x:400,y:400,heading:-3*Math.PI/4},goalPreset:'far'})).toThrow(/No clear targets/);
  });
  it('never calls compass, truth or pose-indexed memory in the pixel mission pipeline',()=>{
    const run=(hidden:number)=>{
      const episode=new WorldEpisode({seed:7,world:field,goal:{x:hidden,y:0}});
      episode.render=()=>pixels(false);episode.mission=()=>{throw Error('Compass leak');};episode.truth=()=>{throw Error('Truth leak');};episode.lapContext=()=>{throw Error('Pose leak');};
      const driver=new VisionDriver({controller:new SpikingNetwork(7),perceiver:new Perceiver(eyes),domain:worldDomain,sensorOnly:true,pixelMission:new FlagDiscovery(48,24,WORLD_CAMERA.hfov),fusion:{fade:1e6}});
      driver.reset();const frame=driver.act(episode);return{inputs:[...frame.sensors],action:frame.action};
    };
    expect(run(200)).toEqual(run(-200));expect(run(200).inputs.slice(0,2)).toEqual([0,0]);
  });
  it('prevents privileged or blind modes after construction',()=>{
    const s=new WorldSession({...settings,kind:'expert',fade:1e6});expect(s.settings.kind).toBe('vision');expect(s.driver!.options.sensorOnly).toBe(true);
    s.driver!.mode='vision-action';expect(()=>s.step()).toThrow(/Pixel missions/);
    expect(()=>new WorldSession({...settings,vision:null})).toThrow(/requires a world camera/);
  });
  it('observes exactly the processed central eye without modifying the raw camera',()=>{
    const s=new WorldSession({...settings,visual:{...DEFAULT_VISION,smooth:true,layout:'circle3'},resolution:'16x8'}),raw=pixels(),original=raw.slice();
    let observed:Float32Array|null=null;const observe=s.discovery!.observe.bind(s.discovery!);
    s.discovery!.observe=(image,tick)=>{observed=image.slice();observe(image,tick);};s.episode.render=()=>raw;s.step();
    expect(observed).toEqual(s.driver!.ensemble!.frames[0]);expect(observed).not.toEqual(raw);expect(raw).toEqual(original);
    expect(s.driver!.ensemble!.frames).toHaveLength(3);
  });
  it('keeps the existing robot detector threshold while accepting a two-pixel flag',()=>{
    const image=pixels(false),n=48*24;
    for(const k of [100,101]){image[k]=1;image[n+k]=.2;image[2*n+k]=.62;}
    const target={hue:328.5,tolerance:18,minSaturation:.35,minValue:.18,diameter:.14};
    expect(targetComponents(image,48,24,target)).toHaveLength(0);expect(targetComponents(image,48,24,target,2)).toHaveLength(1);
    expect(()=>targetComponents(image,48,24,target,0)).toThrow(/threshold/);
  });
  it('ends exactly at discovery, and makes seeing mandatory in the arrival variant',()=>{
    const s=new WorldSession(settings);s.episode.render=()=>pixels();s.controller.step=()=>({steer:0,throttle:0,brake:0});
    s.step();s.step();expect(s.done).toBe(false);s.step();expect(s.done).toBe(true);expect(s.won).toBe(true);expect(s.episode.tick).toBe(2);s.step();expect(s.episode.tick).toBe(2);
    const r=goalResult(s,300);expect(r.found).toBe(true);expect(r.arrived).toBe(false);expect(r.progress).toBe(0);
    const reach=new WorldSession({...settings,searchWin:'reach'});reach.episode.render=()=>pixels();reach.controller.step=()=>({steer:0,throttle:0,brake:0});reach.step();reach.step();reach.step();expect(reach.found).toBe(true);expect(reach.done).toBe(false);
    reach.episode.sim.status.goals=1;expect(reach.won).toBe(true);
    const blindArrival=new WorldSession({...settings,searchWin:'reach'});blindArrival.episode.sim.status.goals=1;expect(blindArrival.won).toBe(false);
  });
});

describe('Discovery fitness and portable settings',()=>{
  const result={arrived:false,ticks:150,collisions:0,progress:0,reverseDistance:0,crashed:false,found:true,won:true,firstSightTick:100,visualViews:20,objective:'sight' as const};
  it('ranks successful finds by time, not hidden distance or many contacts',()=>{
    expect(discoveryScore({...result,collisions:7},900)).toBeGreaterThan(discoveryScore({...result,firstSightTick:101},900));
    const failed={...result,won:false,found:false,firstSightTick:null};expect(discoveryScore(failed,900)).toBe(discoveryScore({...failed,progress:1,ticks:1},900));
    expect(discoveryScore({...result,firstSightTick:900},900)).toBeGreaterThan(discoveryScore({...failed,visualViews:64},900));
    expect(discoveryScore({...result,objective:'reach',ticks:100},900)).toBeGreaterThan(discoveryScore({...result,objective:'reach',ticks:200},900));
  });
  it('uses the selected impact weight for sight and arrival searches while success always dominates',()=>{
    for(const objective of ['sight','reach'] as const){
      const fast={...result,objective,firstSightTick:100,ticks:100,pain:6},careful={...result,objective,firstSightTick:200,ticks:200,pain:0};
      expect(discoveryScore(fast,900,0)).toBeGreaterThan(discoveryScore(careful,900,0));
      expect(discoveryScore(fast,900,.2)).toBeLessThan(discoveryScore(careful,900,.2));
      expect(discoveryScore(fast,900,1)).toBeLessThan(discoveryScore(careful,900,1));
      expect(discoveryScore({...fast,ticks:900,firstSightTick:900},900,1)).toBeGreaterThan(discoveryScore({...careful,won:false,visualViews:64},900,1));
    }
  });
  it('preserves search objective and accepts old room settings',()=>{
    const training={version:1 as const,task:'explore' as const,searchWin:'reach' as const,crashWeight:.2,maxTicks:300,memoryEnabled:false,reverseCoach:false};
    const file=exportVisionBrain({name:'Search',controller:controllerCheckpoint(settings.controller,{domain:'world'}),vision:eyes,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,world:null,worldTraining:training});expect(importFile(file).worldTraining).toEqual(training);
    expect(validateRoomTraining({...training,task:'reverse',searchWin:undefined}).task).toBe('reverse');expect(()=>validateRoomTraining({...training,searchWin:'telepathy'})).toThrow(/Invalid room/);
  });
  it('evolves independent camera-only ghosts and exports real search results',async()=>{
    const original=structuredClone(settings.controller),logs:string[]=[],contexts:WorldSession[][]=[];
    const trained=await trainWorldController({...settings,maxTicks:12},1,2,.2,()=>false,line=>logs.push(line),sessions=>contexts.push(sessions));
    expect(trained!.task).toBe('explore');expect(trained!.coachFrames).toBe(0);expect(trained!.scoreDefinition).toContain('No distance/progress reward');expect(trained!.trials).toHaveLength(2);expect(trained!.trials.every(t=>t.firstSightTick===null&&t.progress===0)).toBe(true);
    expect(logs.some(l=>l.includes('no compass or pheromone'))).toBe(true);expect(contexts.every(s=>s[0]!==s[1]&&s[0].discovery!==s[1].discovery)).toBe(true);expect(settings.controller).toEqual(original);
  });
  it('evolves beyond imported saved dots with fair fresh cohorts and bounded failure retries',async()=>{
    const imported={...settings,goals:[{x:300,y:0},{x:-300,y:0}],maxTicks:1};
    const original=structuredClone(imported),seen=new Map<string,{x:number;y:number}[]>();
    const trained=await trainWorldController(imported,4,2,.2,()=>false,()=>{},(sessions,generation,seed)=>{
      if(sessions[0].episode.tick!==0)return;
      expect(sessions[0].episode.sim.world).toEqual(field);
      expect(sessions[0].episode.sim.world).not.toBe(sessions[1].episode.sim.world);
      const targets=structuredClone(sessions[0].episode.sim.goals);
      expect(sessions[1].episode.sim.goals).toEqual(targets);
      expect(targets).toHaveLength(1);expect(imported.goals).not.toContainEqual(targets[0]);
      seen.set(`${generation}:${seed}`,targets);
    },0,false,true,undefined,{seed:123,failureRetries:1});
    const trials=trained!.targetTrials.filter(t=>t.phase==='training');
    expect(trials.filter(t=>t.retry===0)).toHaveLength(8);
    expect(new Set(trials.filter(t=>t.retry===0).map(t=>JSON.stringify(t.targets))).size).toBe(8);
    for(const t of trials){expect(trials.filter(other=>other.seed===t.seed).length).toBeLessThanOrEqual(2);expect(seen.get(`${t.generation}:${t.seed}`)).toEqual(t.targets);}
    expect(trained!.validation.seeds.every(s=>!trained!.trainingSeeds.includes(s))).toBe(true);
    expect(imported).toEqual(original);
  });
});
