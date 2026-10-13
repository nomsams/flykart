import {it,expect} from 'vitest';
import {parkingGapHints} from './gap-hints';
import {parkingInputDomain,parkingDomain} from './session';
import {openHeading} from '../vision/world/worldDomain';
import {DEFAULT_PARKING,generateParking,validateParkingSettings,validateParkingScene} from './model';
import {ParkingEpisode,PX} from './episode';
import {ROBOT_WORLD_CAMERA,HC_SR04,CM_PER_PIXEL} from '../vision/robot';
import {ping,Sonar} from '../vision/sonar';
import {mulberry32} from '../vision/rng';
import {SonarHistory,echoArcs,drawSonarHistory} from '../vision/sonar-history';
import {sonarBeamPoints} from '../vision/sonar-beam';
it('does not inflate distant flanking camera estimates into a full frontal wall',()=>{
  const a=Array(9).fill(.08);a[3]=.65;a[4]=.23;a[5]=.17;
  expect(Math.abs(openHeading(a,0))).toBeGreaterThan(.1);
  const h=parkingGapHints(a,0,0);expect(h.heading).toBeCloseTo(0);expect(h.forwardSpace).toBeGreaterThan(.5);expect(h.speed).toBeGreaterThan(.8);
});
it('keeps close central obstructions and insufficient chassis clearance restrictive, including at speed',()=>{
  const a=Array(9).fill(.05);a[4]=.95;const h=parkingGapHints(a,0,.5);expect(h.speed).toBe(0);expect(Number.isFinite(h.heading)).toBe(true);a[4]=.85;expect(Math.abs(parkingGapHints(a,0,.5).heading)).toBeGreaterThan(.1);
  const narrow=Array(9).fill(.05);narrow[3]=narrow[5]=.98;expect(parkingGapHints(narrow,0,0).speed).toBe(0);
  const moderate=Array(9).fill(.05);moderate[4]=.8;expect(parkingGapHints(moderate,0,0).speed).toBeLessThan(parkingGapHints(Array(9).fill(0),0,0).speed);
});
it('changes only derived camera hint slots, preserves legacy mode, and keeps mirrored bearings symmetric',()=>{
  const estimates=Array(10).fill(.08),mission=[.1,.2],body={speed:.2,lastSteer:.1,lastDrive:.2,sonarCloseness:.7,sonarStrength:.3};estimates[3]=.65;estimates[4]=.23;
  const old=parkingDomain.sensors(estimates,mission,body),next=parkingInputDomain(DEFAULT_PARKING).sensors(estimates,mission,body);
  expect(next.slice(0,15)).toEqual(old.slice(0,15));expect(parkingInputDomain({...DEFAULT_PARKING,gapHints:false}).sensors(estimates,mission,body)).toEqual(old);
  const a=parkingGapHints(estimates,.6,.1),b=parkingGapHints(estimates.slice(0,9).reverse(),-.6,.1);expect(a.heading).toBeCloseTo(-b.heading);
});
it('generates reproducible centered entry and nearly straight-back exits without putting the robot in cars',()=>{
  for(const layout of ['standard','tight','angled','double-row'] as const)for(let seed=1;seed<=20;seed++)for(const lesson of ['arrival','exit'] as const){
    const settings={...DEFAULT_PARKING,layout,lesson,seed,bayPractice:true},s=generateParking(settings);expect(validateParkingScene(s)).toEqual(s);expect(generateParking(settings)).toEqual(s);
    if(lesson==='arrival'){expect(s.start.z-s.target.z).toBeGreaterThanOrEqual(.8);expect(s.start.z-s.target.z).toBeLessThanOrEqual(1.2);expect(Math.abs(s.start.x-s.target.x)).toBeLessThanOrEqual(.06);}else expect(Math.abs(s.start.x-s.target.x)).toBeLessThanOrEqual(.04);
  }
  expect(()=>validateParkingSettings({...DEFAULT_PARKING,gapHints:1})).toThrow();
});
it('actual default parked solids leave a physical central gap and sonar does not fabricate a near wall there',()=>{
  const e=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA),b=e.scene.target;e.physics.pose={x:b.x,z:b.z+.8,heading:-Math.PI/2};
  const spec={...e.sonarUnit.spec,noiseBaseCm:0,noiseProportional:0,soundScaleSigma:0,speckleSigma:0,ghostProbability:0};const r=ping(spec,e.pose,e.targets(),mulberry32(4));expect(!r.echo||r.range/PX>.6).toBe(true);
  const p={x:e.pose.x,y:e.pose.y-spec.mountForward,heading:-Math.PI/2,range:spec.maxRangeCm/CM_PER_PIXEL,beam:15,height:spec.mountHeight};const fan=sonarBeamPoints(p,e.targets());expect(Math.abs(fan[16].y-p.y)/PX).toBeGreaterThan(.6);
});
it('draws uncertainty arcs without accumulating duplicate pings into walls or modifying stored evidence',()=>{
  const u=new Sonar({...HC_SR04,mountForward:0},mulberry32(4)),h=new SonarHistory();for(let i=0;i<40;i++){u.update(i*2,{x:0,y:0,heading:0},[]);u.reading={range:80,echo:true,strength:1};h.record(u,{x:0,y:0,heading:0});}
  expect(echoArcs(h.samples)).toHaveLength(1);const before=h.toJSON();const ctx=new Proxy({}, {get:()=>()=>{}}) as CanvasRenderingContext2D,canvas={width:480,height:280,dataset:{},getContext:()=>ctx} as unknown as HTMLCanvasElement;
  drawSonarHistory(canvas,h,{x:0,y:0,heading:0},true,{evidence:'arcs'});expect(canvas.dataset.evidence).toBe('arcs');expect(canvas.dataset.echoArcs).toBe('1');expect(h.toJSON()).toEqual(before);
  const parsed=SonarHistory.fromJSON(before);expect(parsed.toJSON()).toEqual(before);expect(()=>parsed.restore({...before,samples:[{...before.samples[0],maxRange:NaN}]})).toThrow();expect(parsed.toJSON()).toEqual(before);
});
it('the transmission illustration resolves per-ray openings separately from one off-axis measured return',()=>{
  const u=new Sonar({...HC_SR04,mountForward:0},mulberry32(4)),h=new SonarHistory();u.update(0,{x:0,y:0,heading:0},[]);u.reading={range:80,echo:true,strength:1};h.record(u,{x:0,y:0,heading:0});
  const targets=[-1,1].map(sign=>({kind:'box' as const,x:80,y:sign*18,heading:0,halfLength:4,halfWidth:8,z0:0,z1:20}));
  const ctx=new Proxy({}, {get:()=>()=>{}}) as CanvasRenderingContext2D,canvas={width:480,height:280,dataset:{},getContext:()=>ctx} as unknown as HTMLCanvasElement;
  const raw={...u.reading};drawSonarHistory(canvas,h,{x:0,y:0,heading:0},true,{evidence:'arcs',occluders:targets,transmission:true});const fan=JSON.parse(canvas.dataset.beamFootprint!);expect(fan[16].x).toBeGreaterThan(300);expect(fan[0].x).toBeLessThan(90);expect(canvas.dataset.beamKind).toBe('simulated transmission');expect(u.reading).toEqual(raw);
  drawSonarHistory(canvas,h,{x:0,y:0,heading:0},true,{occluders:targets,transmission:false});expect(JSON.parse(canvas.dataset.beamFootprint!)[16].x).toBeCloseTo(80);
});
