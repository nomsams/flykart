import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REWARD_CONFIG, SpikingNetwork, createRoadObstacles, startPosition, stepCar } from './core';
import { roomRewards, TrainingRecipe, validateRecipe } from './training-recipe';
import { controllerCheckpoint, exportAsFlyKartV1, exportVisionBrain, importFile } from './vision/format';
import { widenBrain } from './vision/inputs';
import { TrackEpisode } from './vision/episode';
import { TrackSession } from './vision/ui/sessions';
import { HC_SR04, ROBOT_PROFILE, CM_PER_PIXEL } from './vision/robot';
import { ping } from './vision/sonar';
import { mulberry32 } from './vision/rng';
import { loadBrowserBrain, saveBrowserBrain } from './browser-brain';

const recipe = (): TrainingRecipe => ({ version:1,domain:'race',reward:{...DEFAULT_REWARD_CONFIG,collision:23,finish:420},physics:{wallsEnabled:true,lapTarget:3,impactPain:true,checkpointCount:12,domainRandomization:.2},obstacles:{enabled:true,count:6,kind:'wall'} });
afterEach(()=>vi.unstubAllGlobals());
describe('portable training contract',()=>{
  it('retains rewards and lineage scores when adding sonar, saving Vision and exporting for v1',()=>{
    const original=new SpikingNetwork(47).toJSON(), checkpoint=controllerCheckpoint(widenBrain(original),{trainingRecipe:recipe(),fitness:98,generation:7});
    const vision=exportVisionBrain({name:'offspring',controller:checkpoint,vision:null,fusion:{mode:'belief',fade:0,visionTemperature:1},memory:null,world:null});
    const parsed=importFile(vision);expect(parsed.trainingRecipe).toEqual(recipe());expect(parsed.controller!.meta.generation).toBe(7);
    const narrowed=importFile(exportAsFlyKartV1(checkpoint));expect(narrowed.controller!.snapshot).toEqual(original);expect(narrowed.trainingRecipe).toEqual(recipe());
    expect(roomRewards(recipe())).toEqual({pain:2.3,sugar:14,trailReward:2});
  });
  it('rejects malformed rewards and geometry settings before importing a controller',()=>{
    expect(()=>validateRecipe({...recipe(),reward:{...recipe().reward,collision:-1}})).toThrow(/reward/);
    expect(()=>validateRecipe({...recipe(),physics:{...recipe().physics,checkpointCount:1}})).toThrow(/recipe/);
    const brain=controllerCheckpoint(new SpikingNetwork(1));expect(()=>importFile(JSON.stringify({...brain,trainingRecipe:{...recipe(),obstacles:{enabled:true,count:5,kind:'unknown'}}}))).toThrow(/recipe/);
  });
  it('uses transferred weights in the running Vision session and candidate context',()=>{
    const r=recipe(), settings={trackId:'grand-loop',rivals:0,objects:6,style:0,walls:true,controller:new SpikingNetwork(1).toJSON(),vision:null,fade:0,mode:'belief' as const,memory:null,seed:4,rewardConfig:r.reward,objectKind:r.obstacles.kind,lapTarget:3,impactPain:true,checkpointCount:12,physicsVariation:.2};
    const session=new TrackSession(settings);expect(session.episode.rewardConfig.collision).toBe(23);expect(session.episode.physics.checkpointCount).toBe(12);expect(session.episode.roadObjects.every(o=>o.obstacleKind==='wall')).toBe(true);
    session.step();expect(session.episode.car.score).toBeCloseTo(session.episode.car.rewardTotals.total);
  });
});
describe('browser brain shelf fallback',()=>{
  it('keeps separate parents for each stage, loads legacy Racer saves, and preserves old data on quota failure',async()=>{
    const values=new Map<string,string>();let full=false;
    vi.stubGlobal('indexedDB',undefined);vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(full)throw new Error('quota');values.set(k,v);}});
    const racer=JSON.stringify(controllerCheckpoint(new SpikingNetwork(1),{trainingRecipe:recipe()}));
    values.set('flykart.best-brain.v1',racer);expect((await loadBrowserBrain('racer')).text).toBe(racer);
    await saveBrowserBrain('racer',racer);const offspring=JSON.stringify(controllerCheckpoint(new SpikingNetwork(2),{trainingRecipe:recipe()}));await saveBrowserBrain('vision',offspring);
    expect((await loadBrowserBrain('racer')).text).toBe(racer);expect((await loadBrowserBrain('vision')).text).toBe(offspring);
    const parking=JSON.stringify(controllerCheckpoint(new SpikingNetwork(3),{domain:'world'}));await saveBrowserBrain('parking',parking);expect((await loadBrowserBrain('parking')).text).toBe(parking);expect((await loadBrowserBrain('racer')).text).toBe(racer);expect((await loadBrowserBrain('vision')).text).toBe(offspring);
    full=true;await expect(saveBrowserBrain('vision',racer)).rejects.toThrow(/full/);expect((await loadBrowserBrain('vision')).text).toBe(offspring);
  });
});
describe('tall sonar course objects',()=>{
  it.each(['wall','bush'] as const)('renders and measures %s above the robot sensor mount',kind=>{
    const episode=new TrackEpisode({track:'grand-loop',roadObjects:1,objectKind:kind,profile:ROBOT_PROFILE,seed:4});const object=episode.roadObjects[0];object.position={x:80,y:0};object.heading=0;
    const targets=episode.sonarTargets();expect(targets[0].z1*CM_PER_PIXEL).toBeGreaterThan(30);
    const quiet={...HC_SR04,noiseBaseCm:0,noiseProportional:0,speckleSigma:0,ghostProbability:0};const echo=ping(quiet,{x:0,y:0,heading:0},targets,mulberry32(4));expect(echo.echo).toBe(true);expect(echo.range).toBeLessThan(80);
    episode.car.position={x:0,y:0};episode.car.heading=0;episode.render();expect(episode.scene!.sprites.some(s=>s.z1===targets[0].z1)).toBe(true);
  });
  it.each(['wall','bush'] as const)('penalizes actual %s contact without moving the obstacle',kind=>{
    const car=startPosition(0,'grand-loop'),object=createRoadObstacles(1,'grand-loop',4,kind)[0];object.position={...car.position};object.heading=car.heading;const original={...object.position};car.speed=30;
    stepCar(car,{steer:0,throttle:0,brake:0},[car,object],'grand-loop',{...DEFAULT_REWARD_CONFIG,collision:23},{wallsEnabled:false,impactPain:true});
    expect(car.collisions).toBe(1);expect(car.rewardTotals.collision).toBeGreaterThan(0);expect(object.position).toEqual(original);expect(object.speed).toBe(0);
  });
  it('allows driving past a wall inside its bounding circle when outside its rectangular footprint',()=>{
    const car=startPosition(0,'grand-loop'),wall=createRoadObstacles(1,'grand-loop',4,'wall')[0];wall.position={...car.position};wall.heading=car.heading;
    car.position={x:car.position.x+Math.cos(car.heading)*20,y:car.position.y+Math.sin(car.heading)*20};
    stepCar(car,{steer:0,throttle:0,brake:0},[car,wall],'grand-loop',DEFAULT_REWARD_CONFIG,{wallsEnabled:false});expect(car.collisions).toBe(0);
  });
});
