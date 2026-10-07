import { describe,it,expect } from 'vitest';
import { SpikingNetwork } from '../core';
import { WorldSim,WorldDef } from './world/world';
import { WorldEpisode } from './world/worldDomain';
import { WorldSession } from './ui/sessions';
import { goalResult } from './world/training';
import { SonarHistory } from './sonar-history';
import { Sonar } from './sonar';
import { HC_SR04, KART_PROFILE, ROBOT_PROFILE } from './robot';
import { mulberry32 } from './rng';
import { controllerCheckpoint,exportVisionBrain,importFile } from './format';
const field:WorldDef={seed:1,half:460,obstacles:[],patches:[]};
describe('Goal placement and completion',()=>{
  it('places distant, clear, seed-reproducible targets in varied directions',()=>{
    const points=[];
    for(let seed=1;seed<=10;seed++){
      const s=new WorldSim(seed,{world:field,start:{x:0,y:0,heading:0},goalPreset:'far'});
      expect(Math.hypot(s.status.goalX,s.status.goalY)).toBeGreaterThanOrEqual(field.half*.7);
      expect(Math.abs(s.status.goalX)).toBeLessThan(field.half-50);expect(Math.abs(s.status.goalY)).toBeLessThan(field.half-50);
      expect(s.goals).toEqual(new WorldSim(seed,{world:field,start:{x:0,y:0,heading:0},goalPreset:'far'}).goals);points.push(s.status.goalX);
    }
    expect(points.some(x=>x<0)).toBe(true);expect(points.some(x=>x>0)).toBe(true);
  });
  it('handles small imported arenas without placing a dot inside an obstacle',()=>{
    const w={...field,half:100,obstacles:[{x:40,y:0,radius:20,kind:'rock' as const,height:20,tone:.5}]};
    const s=new WorldSim(7,{world:w});expect(Math.hypot(s.status.goalX-40,s.status.goalY)).toBeGreaterThan(46);
  });
  it('shows two flags in raw camera geometry and completes only after both',()=>{
    const ep=new WorldEpisode({seed:7,world:field,start:{x:0,y:0,heading:0},goals:[{x:-80,y:0},{x:80,y:0}],goalLimit:2});ep.render();expect(ep.scene!.sprites.filter(s=>s.shape==='flag')).toHaveLength(2);
    while(ep.sim.status.goals===0&&!ep.done)ep.step({steer:0,throttle:0,brake:0,reverse:1});
    expect(ep.sim.status.goals).toBe(1);expect(ep.done).toBe(false);expect(ep.sim.goals).toHaveLength(1);
    while(!ep.done)ep.step({steer:0,throttle:1,brake:0,reverse:0});expect(ep.sim.status.goals).toBe(2);expect(ep.summary().finished).toBe(true);
  });
  it('makes two-dot sensor-only ghost trials require both dots',()=>{
    const s=new WorldSession({seed:7,world:field,goalPreset:'pair',kind:'expert',sensorOnly:true,controller:new SpikingNetwork(7).toJSON(),vision:null,density:0,style:0,fade:0});
    expect(s.episode.sim.goalLimit).toBe(2);const d=s.episode.sim.status.distanceToGoal;const g=s.episode.sim.goals[0];s.episode.sim.kart.x=g.x;s.episode.sim.kart.y=g.y;s.episode.step({steer:0,throttle:0,brake:0});
    const r=goalResult(s,d);expect(r.arrived).toBe(false);expect(r.goals).toBe(1);expect(r.goalTarget).toBe(2);expect(s.done).toBe(false);
  });
});
describe('Scan evidence',()=>{
  it('maps camera-only room pings without supplying sonar to the brain, and uses one shared ranger on Robot',()=>{
    const settings={seed:7,world:{...field,half:150,obstacles:[{x:80,y:0,radius:12,height:30,tone:.5,kind:'rock' as const}]},start:{x:0,y:0,heading:0},goals:[{x:-80,y:30}],kind:'blind' as const,controller:new SpikingNetwork(7).toJSON(),vision:null,density:0,style:0,fade:0,profile:KART_PROFILE};
    const s=new WorldSession(settings),ep=s.episode,original=structuredClone(settings.controller);
    expect(ep.sonarUnit).toBeNull();expect(ep.sonar()).toBeNull();expect(ep.proprioception().sonarCloseness).toBeUndefined();
    expect(ep.camera).toEqual(KART_PROFILE.worldCamera);expect(s.controller.toJSON()).toEqual(original);
    expect([...s.sonarMap.cells.values()].some(v=>v<0)).toBe(true);expect([...s.sonarMap.cells.values()].some(v=>v>0)).toBe(true);
    const count=ep.scanSonarUnit!.count;for(let i=0;i<6;i++)s.step();
    expect(ep.scanSonarUnit!.count).toBeGreaterThan(count);expect(s.sonarMap.samples.length).toBeGreaterThan(1);expect(s.driver!.sensors).toHaveLength(17);
    const paused=new WorldSession({...settings,sonarOn:false});for(let i=0;i<4;i++)paused.step();expect(paused.sonarMap.samples).toHaveLength(0);
    const robot=new WorldSession({...settings,profile:ROBOT_PROFILE});expect(robot.episode.scanSonarUnit).toBe(robot.episode.sonarUnit);
  });
  const sonar=()=>new Sonar(HC_SR04,mulberry32(1));
  it('remembers uncertain echo bands and scanned approaches without marking no-echo space clear',()=>{
    const u=sonar(),h=new SonarHistory();u.reading={echo:true,range:100,strength:1};h.record(u,{x:0,y:0,heading:0});
    expect([...h.cells.values()].some(v=>v>0)).toBe(true);expect([...h.cells.values()].some(v=>v<0)).toBe(true);
    const before=h.toJSON();u.update(30,{x:20,y:20,heading:1},[],true);h.record(u,{x:20,y:20,heading:1});expect([...h.cells]).toEqual(before.cells);expect(h.samples).toHaveLength(2);
  });
  it('does not accumulate disabled pings, and portable history is isolated and validated',()=>{
    const u=sonar(),h=new SonarHistory();u.reading={echo:true,range:100,strength:1};h.record(u,{x:0,y:0,heading:0},false);expect(h.samples).toHaveLength(0);expect(h.cells.size).toBe(0);
    u.update(20,{x:0,y:0,heading:0},[],true);u.reading={echo:true,range:100,strength:1};h.record(u,{x:0,y:0,heading:0});const copy=SonarHistory.fromJSON(h.toJSON());h.clear();expect(copy.cells.size).toBeGreaterThan(0);expect(()=>SonarHistory.fromJSON({...copy.toJSON(),cells:[['bad',1]]})).toThrow(/Invalid sonar/);
  });
});
it('round-trips both domain brains, room settings, scan memory and legacy files',()=>{
  const track=controllerCheckpoint(new SpikingNetwork(1),{domain:'track',generation:3}),world=controllerCheckpoint(new SpikingNetwork(2),{domain:'world',generation:4}),h=new SonarHistory(),u=new Sonar(HC_SR04,mulberry32(1));u.reading={echo:true,range:100,strength:1};h.record(u,{x:0,y:0,heading:0});
  const settings={version:1 as const,seed:29,density:.4,style:.3,driver:'expert' as const,fade:.7,goalPreset:'pair' as const,mapPreset:'clear' as const,memoryCount:10000,sonarOn:false,trailVisible:false};
  const file=exportVisionBrain({name:'Both domains',profile:'kart',controller:world,vision:null,fusion:{mode:'belief',fade:0,visionTemperature:1},memory:null,world:null,racer:{controller:track,vision:null,memory:null},worldSetup:settings,worldScan:h.toJSON()});
  const parsed=importFile(file);expect(parsed.racer!.controller.snapshot).toEqual(track.network);expect(parsed.controller!.snapshot).toEqual(world.network);expect(parsed.worldSetup).toEqual(settings);expect(parsed.worldScan).toEqual(h.toJSON());
  const invalid=JSON.parse(file);invalid.worldSetup.memoryCount=-1;expect(()=>importFile(JSON.stringify(invalid))).toThrow(/Invalid Open world/);
  expect(importFile(JSON.stringify(track)).kind).toBe('v1-brain');
});
