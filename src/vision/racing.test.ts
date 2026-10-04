import { describe, expect, it } from 'vitest';
import { CHECKPOINT_COUNT, DEFAULT_PHYSICS_CONFIG, DEFAULT_REWARD_CONFIG, DEFAULT_TRACK, MAX_TICKS, SpikingNetwork, nearestTrack, startPosition, stepCar } from '../core';
import { impactSeverity } from '../impact';
import { DEFAULT_RACING, boardFov, calibratedProfile, fitRange, validateRacingSettings } from './racing-settings';
import { HC_SR04, ROBOT_PROFILE, CM_PER_PIXEL } from './robot';
import { Sonar, ping } from './sonar';
import { mulberry32 } from './rng';
import { lowResolution } from './ensemble';
import { controllerCheckpoint, exportVisionBrain, importFile } from './format';

describe('continuous lap survival',()=>{
  it('keeps counters, time budget and ordered gates across laps, rewarding finish only once',()=>{
    const car=startPosition(0,DEFAULT_TRACK),last=DEFAULT_TRACK.points.at(-1)!,first=DEFAULT_TRACK.points[0];
    for(let lap=0;lap<3;lap++){
      car.position={x:last.x+(first.x-last.x)*.995,y:last.y+(first.y-last.y)*.995};
      car.heading=Math.atan2(first.y-last.y,first.x-last.x);car.speed=40;car.progress=nearestTrack(car.position,DEFAULT_TRACK).progress;car.distanceAlong=car.progress*DEFAULT_TRACK.length;
      car.netProgress=lap+car.progress;car.totalProgress=car.netProgress;car.nextCheckpoint=0;car.checkpointsPassed=lap*CHECKPOINT_COUNT+CHECKPOINT_COUNT-1;
      stepCar(car,{steer:0,throttle:0,brake:0},[car],DEFAULT_TRACK,DEFAULT_REWARD_CONFIG,{...DEFAULT_PHYSICS_CONFIG,lapTarget:3});
      expect(car.laps).toBe(lap+1);expect(car.ticks).toBe(lap+1);expect(car.finished).toBe(lap===2);
      expect(car.nextCheckpoint).toBe(lap===2?CHECKPOINT_COUNT:1);expect(car.rewardBreakdown.finish>0).toBe(lap===2);
      expect(car.timeLimit).toBe(MAX_TICKS*3);
    }
    const score=car.score;stepCar(car,{steer:0,throttle:1,brake:0},[car],DEFAULT_TRACK,DEFAULT_REWARD_CONFIG,{...DEFAULT_PHYSICS_CONFIG,lapTarget:3});expect(car.score).toBe(score);
  });
  it('does not award a second lap for a repeated first-lap finish crossing',()=>{
    const car=startPosition(0,DEFAULT_TRACK),last=DEFAULT_TRACK.points.at(-1)!,first=DEFAULT_TRACK.points[0];
    car.position={x:last.x+(first.x-last.x)*.995,y:last.y+(first.y-last.y)*.995};car.heading=Math.atan2(first.y-last.y,first.x-last.x);car.speed=40;car.progress=nearestTrack(car.position,DEFAULT_TRACK).progress;car.netProgress=car.progress;car.totalProgress=car.progress;car.laps=1;car.nextCheckpoint=0;
    stepCar(car,{steer:0,throttle:0,brake:0},[car],DEFAULT_TRACK,DEFAULT_REWARD_CONFIG,{...DEFAULT_PHYSICS_CONFIG,lapTarget:3});expect(car.laps).toBe(1);expect(car.finished).toBe(false);
  });
});
describe('impact teaching cost',()=>{
  it('penalizes fast stationary impacts more than co-moving bumps, with a nonzero floor',()=>{
    const cost=(otherSpeed:number,pain=true)=>{const c=startPosition(0),o=startPosition(0);o.position={x:c.position.x+Math.cos(c.heading)*17,y:c.position.y+Math.sin(c.heading)*17};c.speed=80;o.speed=otherSpeed;
      stepCar(c,{steer:0,throttle:0,brake:0},[c,o],DEFAULT_TRACK,DEFAULT_REWARD_CONFIG,{...DEFAULT_PHYSICS_CONFIG,impactPain:pain,softCollisions:true});return c.rewardBreakdown.collision;};
    expect(cost(0)).toBeGreaterThan(cost(70)*4);expect(cost(70)).toBeGreaterThan(0);expect(cost(0,false)).toBe(DEFAULT_REWARD_CONFIG.collision);
    expect(impactSeverity(-40)).toBe(.2);expect(impactSeverity(10000)).toBe(6);
  });
});
describe('sensor calibration and metadata',()=>{
  it('fits and validates separate physical distance measurements',()=>{const f=fitRange([[49,50],[99,100],[149,150]]);expect(f.scale).toBeCloseTo(1);expect(f.offsetCm).toBeCloseTo(1);expect(f.rmse).toBeCloseTo(0);expect(()=>fitRange([[50,50],[50,100],[50,150]])).toThrow();expect(boardFov(20,50,16,48)).toBeCloseTo(61.9275,3);});
  it('clones profiles without overwriting bundled calibration and rejects malformed imports',()=>{const s=validateRacingSettings({...DEFAULT_RACING,sonar:{heightCm:7,forwardCm:10,yawDeg:15,pitchDeg:4,sigmaDeg:10,scale:1.01,offsetCm:1}}),p=calibratedProfile(ROBOT_PROFILE,s);expect(p.sonar!.yawDeg).toBe(15);expect(p.sonar!.mountHeight*CM_PER_PIXEL).toBeCloseTo(7);expect(ROBOT_PROFILE.sonar!.yawDeg).toBeUndefined();expect(()=>validateRacingSettings({...s,sonar:{...s.sonar,scale:NaN}})).toThrow();});
  it('round-trips experiment settings while legacy brains remain readable',()=>{const data={name:'test',controller:controllerCheckpoint(new SpikingNetwork(4)),profile:'robot' as const,vision:null,fusion:{fade:0,mode:'belief' as const,visionTemperature:1},memory:null,world:null,experiment:validateRacingSettings({...DEFAULT_RACING,multiLap:true,resolution:'16x8'})};const raw=exportVisionBrain(data),result=importFile(raw);expect(result.experiment).toEqual(data.experiment);expect(importFile(JSON.stringify(data.controller)).experiment).toBeUndefined();});
  it('pings once per eligible tick, holds between pings, and honours yaw',()=>{const spec={...HC_SR04,noiseBaseCm:0,noiseProportional:0,soundScaleSigma:0,speckleSigma:0,ghostProbability:0};const sonar=new Sonar(spec,mulberry32(2)),pose={x:0,y:0,heading:0};expect(sonar.update(0,pose,[])).toBe(true);expect(sonar.update(0,pose,[])).toBe(false);expect(sonar.update(1,pose,[])).toBe(false);expect(sonar.update(2,pose,[])).toBe(true);expect(sonar.count).toBe(2);expect(sonar.reading.echo).toBe(false);
    const target={kind:'circle' as const,x:spec.mountForward,y:50,radius:7,z0:0,z1:20};expect(ping(spec,pose,[target],mulberry32(5)).echo).toBe(false);expect(ping({...spec,yawDeg:90},pose,[target],mulberry32(5)).echo).toBe(true);
  });
  it('reduces RGB resolution preserving colour channels and original image',()=>{const frame=new Float32Array(48*24*3);frame.fill(.25,0,48*24);frame.fill(.5,48*24,2*48*24);frame.fill(.75,2*48*24);const small=lowResolution(frame,48,24,'16x8');expect(small.length).toBe(frame.length);expect(small).toEqual(frame);expect(small).not.toBe(frame);expect(lowResolution(frame,48,24,'native')).toBe(frame);});
});
