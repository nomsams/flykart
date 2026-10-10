import {describe,it,expect} from 'vitest';
import {Action,wrapAngle} from '../core';
import {DEFAULT_ROBOT,overlaps} from '../robot/model';
import {ROBOT_WORLD_CAMERA,CM_PER_PIXEL} from '../vision/robot';
import {ping} from '../vision/sonar';
import {SonarHistory} from '../vision/sonar-history';
import {mulberry32} from '../vision/rng';
import {DEFAULT_PARKING,generateParking,bodySolid,actorSolid,validateParkingSettings,parkingQuality} from './model';
import {ParkingEpisode,PX} from './episode';
import {planParkingPath,pathPosition} from './path-coach';

const idle:Action={steer:0,throttle:0,brake:0,reverse:0};
function clearLot(){const scene=generateParking(DEFAULT_PARKING);scene.actors=[];scene.start={x:.8,z:0,heading:0};scene.target={...scene.target,x:0,z:0,heading:0};scene.bays=scene.bays.map(b=>b.id===scene.target.id?{...scene.target}:b);return scene;}
function quiet(e:ParkingEpisode){return {...e.sonarUnit.spec,speckleSigma:0,ghostProbability:0,noiseBaseCm:0,noiseProportional:0,soundScaleSigma:0,resolutionCm:.001};}
describe('parking reward coach',()=>{
  it('migrates older states and rejects invalid reward controls',()=>{
    const old={...DEFAULT_PARKING} as Record<string,unknown>;for(const k of ['approachReward','approachRadius','progressPenalty','reverseReward','pathReward','showCoach'])delete old[k];
    expect(validateParkingSettings(old)).toEqual(DEFAULT_PARKING);
    for(const patch of [{pathReward:'yes'},{approachRadius:0},{approachRadius:NaN},{reverseReward:1}])expect(()=>validateParkingSettings({...DEFAULT_PARKING,...patch})).toThrow('reward coach');
  });
  it('uses signed radial sugar, pays nothing outside its radius, and cannot farm approach loops',()=>{
    const e=new ParkingEpisode({...DEFAULT_PARKING,approachRadius:.5},ROBOT_WORLD_CAMERA,clearLot());e.physics.pose.x=.6;e.step(idle);expect(e.status.approachReward).toBe(0);
    e.physics.pose.x=.4;e.step(idle);expect(e.status.approachReward).toBeGreaterThan(0);
    e.physics.pose.x=.8;e.step(idle);expect(e.status.approachReward).toBeCloseTo(0,10);expect(e.status.reward).toBeCloseTo(0,10);
    const off=new ParkingEpisode({...DEFAULT_PARKING,approachReward:false},ROBOT_WORLD_CAMERA,clearLot());off.physics.pose.x=.4;off.step(idle);expect(off.status.approachReward).toBe(0);
  });
  it('penalizes no progress increasingly, including circles, but exempts valid delayed parking',()=>{
    const e=new ParkingEpisode({...DEFAULT_PARKING,maxTicks:300},ROBOT_WORLD_CAMERA,clearLot());for(let i=0;i<90;i++)e.step(idle);expect(e.status.progressPenalty).toBe(0);
    for(let i=0;i<90;i++){e.physics.pose.heading+=.05;e.step(idle);}const cost=e.status.progressPenalty;expect(cost).toBeGreaterThan(3);
    for(let i=0;i<90;i++)e.step(idle);expect(e.status.progressPenalty-cost).toBeGreaterThan(cost);expect(e.status.score).toBeLessThan(-e.tick/30*.2);
    const wait=new ParkingEpisode({...DEFAULT_PARKING,delayReward:true,rewardDelaySeconds:5},ROBOT_WORLD_CAMERA,clearLot());wait.physics.pose={x:0,z:0,heading:0};for(let i=0;i<180;i++)wait.step(idle);expect(wait.status.success).toBe(true);expect(wait.status.progressPenalty).toBe(0);
    const off=new ParkingEpisode({...DEFAULT_PARKING,progressPenalty:false},ROBOT_WORLD_CAMERA,clearLot());for(let i=0;i<180;i++)off.step(idle);expect(off.status.progressPenalty).toBe(0);
  });
  it('rewards useful physical reversing only when enabled; stationary requests and repeat approaches earn none',()=>{
    const e=new ParkingEpisode({...DEFAULT_PARKING,reverseReward:true},ROBOT_WORLD_CAMERA,clearLot()),off=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA,clearLot());
    for(let i=0;i<60;i++){e.step({...idle,reverse:.8});off.step({...idle,reverse:.8});}expect(e.status.reverseReward).toBeGreaterThan(0);expect(e.status.reverseReward).toBeLessThanOrEqual(5);expect(off.status.reverseReward).toBe(0);
    const bonus=e.status.reverseReward;for(let i=0;i<30;i++)e.step(idle);expect(e.status.reverseReward).toBe(bonus);
    const stop=new ParkingEpisode({...DEFAULT_PARKING,reverseReward:true},ROBOT_WORLD_CAMERA,clearLot());stop.physics.step=()=>{};for(let i=0;i<120;i++)stop.step({...idle,reverse:1});expect(stop.status.reverseReward).toBe(0);expect(stop.status.progressPenalty).toBeGreaterThan(0);
    e.physics.pose={x:.8,z:0,heading:0};e.physics.left=e.physics.right=0;for(let i=0;i<20;i++)e.step({...idle,reverse:.8});expect(e.status.reverseReward).toBe(bonus);
  });
  it('respects sparse/frozen and delayed sugar for all coach bonuses',()=>{
    for(const phase of ['sparse','frozen'] as const){const e=new ParkingEpisode({...DEFAULT_PARKING,phase,pathReward:true,reverseReward:true},ROBOT_WORLD_CAMERA,clearLot());for(let i=0;i<40;i++)e.step({...idle,reverse:.8});expect(e.status.reward).toBe(0);expect(e.status.pathReward).toBe(0);expect(e.status.reverseReward).toBe(0);}
    const e=new ParkingEpisode({...DEFAULT_PARKING,pathReward:true,reverseReward:true,delayReward:true},ROBOT_WORLD_CAMERA,clearLot());for(let i=0;i<40;i++)e.step({...idle,reverse:.8});expect(e.status.reward).toBe(0);expect(e.status.pendingReward).toBeGreaterThan(0);expect(e.status.pathReward).toBeGreaterThan(0);expect(e.status.reverseReward).toBeGreaterThan(0);
  });
  it('keeps rings, route and reward settings out of the raw inference camera',()=>{
    const scene=clearLot(),a=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA,scene),b=new ParkingEpisode({...DEFAULT_PARKING,pathReward:true,reverseReward:true,approachRadius:6},ROBOT_WORLD_CAMERA,scene);
    expect(a.frame).toEqual(b.frame);expect(a.sonar()).toEqual(b.sonar());b.mission=()=>{throw Error('hidden compass');};for(let i=0;i<10;i++)b.step(idle);
  });
});
describe('parking path teacher',()=>{
  it('finds a shortest reverse route in a clear lot without editing the lot',()=>{
    const scene=clearLot(),before=structuredClone(scene),path=planParkingPath(scene);expect(path.reason).toBe('ready');expect(path.length).toBeGreaterThan(.7);expect(path.length).toBeLessThan(.81);expect(path.poses.some(p=>p.reverse)).toBe(true);expect(scene).toEqual(before);
    expect(pathPosition(path,scene.start).progress).toBe(0);expect(pathPosition(path,path.poses.at(-1)!).remaining).toBeCloseTo(0);
    const copy=planParkingPath(scene);copy.poses[0].x=99;expect(planParkingPath(scene)).toEqual(path);
  });
  it('routes through occupied lots with full-body clearance and valid final orientation',()=>{
    for(const lesson of ['exit','oriented','parallel'] as const){const scene=generateParking({...DEFAULT_PARKING,lesson,seed:4}),path=planParkingPath(scene);expect(path.reason,lesson).toBe('ready');
      for(let i=1;i<path.poses.length;i++)for(let j=0;j<=8;j++){const a=path.poses[i-1],b=path.poses[i],f=j/8,p={x:a.x+(b.x-a.x)*f,z:a.z+(b.z-a.z)*f,heading:a.heading+wrapAngle(b.heading-a.heading)*f};expect(scene.actors.filter(a=>a.parked).some(a=>overlaps(bodySolid(p,DEFAULT_ROBOT.length,DEFAULT_ROBOT.width),actorSolid(a))),lesson).toBe(false);}
      const q=parkingQuality(path.poses.at(-1)!,scene.target);expect(q.distance).toBeLessThan(.075);if(lesson!=='exit'){expect(q.inside).toBe(true);expect(q.error).toBeLessThan(Math.PI/12);}
    }
  });
  it('reports a blocked start instead of inventing a path or reward',()=>{
    const scene=clearLot();scene.actors=[{id:'obstacle',kind:'vehicle',pose:{...scene.start},length:.26,width:.17,height:.11,speed:0,parked:true,route:[],waypoint:0,waitTicks:0}];const p=planParkingPath(scene);expect(p.reason).toBe('blocked');expect(p.poses).toHaveLength(0);
  });
});
describe('parking sonar geometry and scan acquisition',()=>{
  it('measures all four physical boundary faces from the front-mounted transducer',()=>{
    const e=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA,clearLot());
    for(const heading of [0,Math.PI/2,Math.PI,-Math.PI/2]){const pose={x:Math.cos(heading)*2.6*PX,y:Math.sin(heading)*2.6*PX,heading},r=ping(quiet(e),pose,e.targets(),mulberry32(1));expect(r.echo).toBe(true);const expected=(.4-.0125-.26*.48)*100;expect(r.range*CM_PER_PIXEL).toBeCloseTo(expected,0);}
  });
  it('measures rotated solid car faces, and a blind-zone wall cannot become a far opening',()=>{
    const e=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA),a=e.scene.actors[0];e.scene.actors=[a];a.pose={x:.5,z:0,heading:0};e.physics.pose={x:0,z:0,heading:0};
    let r=ping(quiet(e),e.pose,e.targets(),mulberry32(1));expect(r.echo).toBe(true);expect(r.range*CM_PER_PIXEL).toBeCloseTo((.5-.13-.26*.48)*100,0);
    a.pose.heading=Math.PI/2;r=ping(quiet(e),e.pose,e.targets(),mulberry32(1));expect(r.range*CM_PER_PIXEL).toBeCloseTo((.5-.085-.26*.48)*100,0);
    e.scene.actors=[];e.physics.pose={x:3-.0125-.26*.48-.01,z:0,heading:0};r=ping(quiet(e),e.pose,e.targets(),mulberry32(1));expect(r.echo).toBe(false);
  });
  it('maps the acquired sensor origin and holds it between pings instead of following later poses',()=>{
    const e=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA,clearLot()),h=new SonarHistory();e.physics.pose={x:2.6,z:0,heading:0};e.sonarUnit.update(2,e.pose,e.targets());h.record(e.sonarUnit,e.pose);const p=h.samples[0];expect(p.x/PX).toBeCloseTo(2.6+.26*.48);expect(p.echo).toBe(true);expect(h.cells.size).toBeGreaterThan(0);
    e.physics.pose.x=2.5;e.sonarUnit.update(3,e.pose,e.targets());h.record(e.sonarUnit,e.pose);expect(h.samples).toHaveLength(1);expect(h.samples[0]).toEqual(p);
  });
});
