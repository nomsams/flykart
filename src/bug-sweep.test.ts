import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpikingNetwork, pointAtDistance, trackCheckpoint, wrapAngle } from './core';
import { parseBrainFile } from './lab';
import { loadBrowserBrain, saveBrowserBrain } from './browser-brain';
import { controllerCheckpoint, exportAsFlyKartV1, exportVisionBrain, importFile } from './vision/format';
import { VisionCnn, encodeFloats } from './vision/cnn';
import { DEFAULT_CAMERA } from './vision/camera';
import { defaultSpec, serialiseModel, validateVisionModel } from './vision/perception';
import { MushroomBody } from './vision/memory';
import { TrackEpisode } from './vision/episode';
import { ROBOT_PROFILE } from './vision/robot';
import { widenBrain } from './vision/inputs';

const model=()=>serialiseModel(new VisionCnn({...defaultSpec(1,13,'rgb',false),width:8,height:8,channels:[1,1,1],hidden:2},7),DEFAULT_CAMERA,new Array(13).fill(1),'regression');
const bundle=()=>JSON.parse(exportVisionBrain({name:'test',controller:controllerCheckpoint(new SpikingNetwork(3)),vision:model(),fusion:{mode:'belief',fade:0,visionTemperature:1},memory:new MushroomBody({kenyonCells:128}).toJSON(),world:null}));
afterEach(()=>vi.unstubAllGlobals());

describe('checkpoint validation before installation',()=>{
  it('accepts valid camera and memory snapshots, including memory statistics',()=>{
    const b=bundle();b.memory.stats={updates:3,meanAbsError:.1,lapAbsError:.2,lapUpdates:2};
    const imported=importFile(JSON.stringify(b));expect(imported.vision?.spec.width).toBe(8);
    expect(MushroomBody.fromJSON(imported.memory!).toJSON().stats).toEqual(b.memory.stats);
  });
  it.each(['domain','params','variance','geometry','architecture','memory','fusion'])('rejects a corrupt %s before returning an installable controller',field=>{
    const b=bundle();
    if(field==='domain')b.vision.domain='world';
    if(field==='params')b.vision.params=encodeFloats(new Float32Array([NaN]));
    if(field==='variance')b.vision.varianceScale=[-1];
    if(field==='geometry')b.vision.camera.hfov=0;
    if(field==='architecture')b.vision.spec.width=1000000;
    if(field==='memory')b.memory.weights[0]=encodeFloats(new Float32Array(1));
    if(field==='fusion')b.fusion.mode='unknown';
    expect(()=>importFile(JSON.stringify(b))).toThrow();
  });
  it('rejects non-finite eye parameters even when their length matches the architecture',()=>{
    const m=model(),net=new VisionCnn(m.spec,1);net.params[0]=Infinity;m.params=encodeFloats(net.params);
    expect(()=>validateVisionModel(m)).toThrow(/non-finite/);
  });
  it('tolerates malformed optional provenance and correctly identifies modern sonar brains',()=>{
    const brain={...controllerCheckpoint(widenBrain(new SpikingNetwork(1).toJSON())),provenance:[null,7,{source:'valid'}]};
    const parsed=parseBrainFile(JSON.stringify(brain),{allowSonar:true});expect(parsed.meta.sources).toEqual(['valid']);expect(parsed.meta.upgradedFromLegacy).toBe(false);
  });
  it('does not relabel room input meanings as a racer',()=>{
    expect(()=>exportAsFlyKartV1(controllerCheckpoint(new SpikingNetwork(1),{domain:'world'}))).toThrow(/Room/);
  });
});

describe('reliable storage and sensor state',()=>{
  it('keeps a valid save on invalid replacement and falls back past corrupt storage records',async()=>{
    const values=new Map<string,string>(),brain=JSON.stringify(controllerCheckpoint(new SpikingNetwork(3)));
    vi.stubGlobal('indexedDB',undefined);vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
    await saveBrowserBrain('racer',brain);
    await expect(saveBrowserBrain('racer',JSON.stringify({format:'flykart-brain'}))).rejects.toThrow();
    expect((await loadBrowserBrain('racer')).text).toBe(brain);
    values.set('flykart.best-brain.v1',brain);values.set('flykart.shared-brain.racer','null');
    values.set('flykart.shared-brain.vision',JSON.stringify({stage:'racer',savedAt:'9999',text:'{}'}));
    expect((await loadBrowserBrain('racer')).text).toBe(brain);
  });
  it('timestamps manual sonar refresh at the current tick without a duplicate automatic ping',()=>{
    const episode=new TrackEpisode({track:'grand-loop',profile:ROBOT_PROFILE});episode.tick=7;const count=episode.sonarUnit!.count;
    episode.refreshSonar();expect(episode.sonarUnit!.lastTick).toBe(7);expect(episode.sonarUnit!.count).toBe(count+1);
    episode.sonarUnit!.update(7,{...episode.car.position,heading:episode.car.heading},[]);expect(episode.sonarUnit!.count).toBe(count+1);
    episode.sonarUnit!.update(8,{...episode.car.position,heading:episode.car.heading},[]);expect(episode.sonarUnit!.lastTick).toBe(8);
  });
  it('uses the requested checkpoint count for placement, map markers and controller bearing',()=>{
    const episode=new TrackEpisode({track:'grand-loop',checkpointCount:12});
    const d=episode.route.length*.42;episode.placeAt({distance:d});expect(episode.car.nextCheckpoint).toBe(6);
    const gate=trackCheckpoint(6,episode.route,12).point;expect(episode.nextGate()).toEqual(gate);
    const bearing=wrapAngle(Math.atan2(gate.y-episode.car.position.y,gate.x-episode.car.position.x)-episode.car.heading)/Math.PI;
    expect(episode.privileged()[13]).toBeCloseTo(bearing);expect(pointAtDistance(d,episode.route).point).toEqual(episode.car.position);
  });
});
