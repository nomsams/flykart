import {describe,it,expect} from 'vitest';
import {MotionRangeFilter,acousticMotion,RangeObservation} from './sonar-motion';
import {SonarHistory} from './sonar-history';
import {Sonar} from './sonar';
import {HC_SR04,CM_PER_PIXEL} from './robot';
import {drawScanReference} from './scan-overlay';
import {RoomMemory} from '../robot/memory';
const observation=(time:number,range=1,x=0,heading=0):RangeObservation=>({time,range,echo:true,pose:{x,y:0,heading},sigma:.02});
describe('Acquisition-timed sonar diagnostics',()=>{
  it('shows a small stationary-reflector motion estimate, with signed Doppler',()=>{
    const m=acousticMotion(2,.5);expect(m.flightMs).toBeCloseTo(11.6448,3);expect(m.travelMm).toBeCloseTo(5.8224,3);expect(m.dopplerHz).toBeGreaterThan(100);expect(acousticMotion(2,-.5).dopplerHz).toBeLessThan(0);expect(acousticMotion(2,0).travelMm).toBe(0);
  });
  it('tracks an approaching wall at the acquisition position rather than lagging behind motion',()=>{
    const f=new MotionRangeFilter();for(let i=0;i<90;i++){const x=i*.005,d=f.observe(observation(i/15,2-x,x));expect(d.range).toBeCloseTo(2-x,8);}
  });
  it('reduces stationary alternating range noise',()=>{
    const f=new MotionRangeFilter();let raw=0,filtered=0;for(let i=0;i<120;i++){const range=1+(i%2?.02:-.02),d=f.observe(observation(i/15,range));if(i>20){raw+=(range-1)**2;filtered+=(d.range!-1)**2;}}expect(filtered).toBeLessThan(raw*.35);
  });
  it('keeps timeouts unknown, accepts a new close wall immediately and confirms far jumps',()=>{
    const f=new MotionRangeFilter();for(let i=0;i<30;i++)f.observe(observation(i/15));let d=f.observe(observation(2,.2));expect(d.range).toBe(.2);expect(d.status).toMatch(/Closer/);
    d=f.observe(observation(2.067,2));expect(d.range).toBeNull();expect(d.status).toMatch(/confirmation/);
    d=f.observe(observation(2.134,2.01));expect(d.range).toBe(2.01);expect(d.status).toMatch(/confirmed/);
    d=f.observe({...observation(2.2,4),echo:false});expect(d.range).toBeNull();expect(d.flightMs).toBe(0);
  });
  it('restarts after a turn, time discontinuity, long gap or manual teleport',()=>{
    for(const next of [observation(.1,.5,0,.2),observation(-1,.5),observation(1,.5),observation(.1,.5,1)]){const f=new MotionRangeFilter();f.observe(observation(0));const d=f.observe(next);expect(d.range).toBe(.5);expect(d.status).toMatch(/New beam/);}
  });
  it('records the acquisition pose once and never remaps held ranges at a later pose',()=>{
    const unit=new Sonar({...HC_SR04},()=>.5),h=new SonarHistory();const pose={x:0,y:0,heading:0};unit.update(0,pose,[]);h.record(unit,{x:200,y:200,heading:1});expect(h.samples[0].x).toBe(HC_SR04.mountForward);expect(h.samples[0].y).toBe(0);expect(h.samples[0].time).toBe(0);h.record(unit,{x:400,y:400,heading:2});expect(h.samples).toHaveLength(1);expect(unit.samplePose).toEqual(pose);
  });
  it('preserves raw readings and lifetime filtered evidence through bounded history round trips',()=>{
    const unit=new Sonar({...HC_SR04},()=>.5),h=new SonarHistory();h.filterMode='kalman';
    for(let i=0;i<640;i++){unit.update(i*2,{x:i,y:0,heading:0},[]);unit.reading={range:1/CM_PER_PIXEL*100,echo:true,strength:1};h.record(unit,{x:999,y:999,heading:0});}
    const raw=structuredClone(h.samples),cells=[...h.cells],json=h.toJSON();expect(json.samples).toHaveLength(600);expect(json.filteredCells?.length).toBeGreaterThan(0);
    const next=SonarHistory.fromJSON(JSON.parse(JSON.stringify(json)));expect([...next.viewData().cells]).toEqual(json.filteredCells);expect(next.samples).toEqual(raw);expect([...h.cells]).toEqual(cells);
    const restored=new SonarHistory();restored.restore(json);expect(restored.toJSON()).toEqual(json);expect(()=>restored.restore({...json,filteredCells:[['0,0',Infinity]]})).toThrow();expect(restored.toJSON()).toEqual(json);
  });
  it('accepts legacy unfiltered scan snapshots and rejects invalid timing',()=>{
    const h=SonarHistory.fromJSON({format:'flykart-scan-memory',version:1,samples:[],cells:[]});expect(h.filterMode).toBe('raw');expect(h.toJSON()).not.toHaveProperty('filter');expect(()=>SonarHistory.fromJSON({...h.toJSON(),samples:[{x:0,y:0,heading:0,range:1,echo:true,beam:15,time:-1}]})).toThrow();
  });
  it('draws supplied roof heights without changing geometry, raw scan or neural inputs',()=>{
    const calls:number[][]=[],ctx={save(){},restore(){},setLineDash(){},beginPath(){},moveTo(x:number,y:number){calls.push([x,y]);},lineTo(x:number,y:number){calls.push([x,y]);},closePath(){},stroke(){},fill(){}} as unknown as CanvasRenderingContext2D;
    const objects=[{kind:'box' as const,x:0,y:0,heading:0,halfLength:1,halfWidth:.5,z0:.6,z1:.8}],before=structuredClone(objects);drawScanReference(ctx,{objects},(x,y,z=0)=>({x,y:y-z}),.45,true);expect(calls.some(p=>p[1]===-1.3)).toBe(true);expect(objects).toEqual(before);
  });
  it('persists 3D processing and keeps learned memory when scan preferences change',()=>{
    const m=new RoomMemory({count:512,sparsity:.01,rareWeighting:true});m.mapFilter='kalman';m.mapPoseSource='estimated';m.mapPing({x:0,z:0,heading:0},.12,1,true);const restored=RoomMemory.fromJSON(m.toJSON());expect(restored.mapFilter).toBe('kalman');expect([...restored.map]).toEqual([...m.map]);expect(m.fresh().mapFilter).toBe('kalman');expect(()=>RoomMemory.fromJSON({...m.toJSON(),mapFilter:'oracle'})).toThrow();
  });
});
