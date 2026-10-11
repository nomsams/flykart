import {describe,it,expect} from 'vitest';
import {acousticRayLimit,sonarBeamPoints} from './sonar-beam';
import {Sonar,type SonarTarget,ping} from './sonar';
import {SonarHistory} from './sonar-history';
import {HC_SR04,CM_PER_PIXEL} from './robot';
import {mulberry32} from './rng';
import {RoomMemory} from '../robot/memory';
import {ParkingEpisode,PX} from '../parking/episode';
import {DEFAULT_PARKING} from '../parking/model';
import {ROBOT_WORLD_CAMERA} from './robot';
const wall:SonarTarget={kind:'box',x:30,y:0,heading:Math.PI/2,halfLength:100,halfWidth:1,z0:0,z1:60};
describe('solid acoustic beam occlusion',()=>{
  it('clips at absorbing/slanted walls even when there is no measured echo',()=>{
    const p={x:0,y:0,heading:.6,range:400/CM_PER_PIXEL,beam:15,height:HC_SR04.mountHeight};
    for(const surface of ['legacy','soft','smooth'] as const){const rays=sonarBeamPoints(p,[{...wall,surface}]);expect(rays).toHaveLength(33);for(const point of rays)expect(point.x).toBeCloseTo(29,8);}
    const unit=new Sonar({...HC_SR04,mountForward:0,ghostProbability:0},mulberry32(7)),history=new SonarHistory();unit.update(0,{x:0,y:0,heading:.6},[{...wall,surface:'soft'}]);unit.reading={range:400/CM_PER_PIXEL,echo:false,strength:0};history.record(unit,{x:0,y:0,heading:.6});const raw=unit.reading;
    sonarBeamPoints(history.samples[0],[wall]);expect(unit.reading).toBe(raw);expect(history.cells.size).toBe(0);
  });
  it('stays inside all four actual parking corners at straight, diagonal, grazing and blind-zone poses',()=>{
    const e=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA),targets=e.targets(),inside=(e.scene.half-.0125)*PX;
    for(const sx of [-1,1])for(const sy of [-1,1])for(const gap of [.001,.015,.1,.5,1])for(const turn of [-.6,-.15,0,.15,.6]){
      const p={x:sx*(inside-gap*PX),y:sy*(inside-gap*PX),heading:Math.atan2(sy,sx)+turn,range:400/CM_PER_PIXEL,beam:15,height:HC_SR04.mountHeight};
      expect(sonarBeamPoints(p).some(point=>Math.abs(point.x)>inside||Math.abs(point.y)>inside)).toBe(true);
      for(const point of sonarBeamPoints(p,targets)){expect(Math.abs(point.x)).toBeLessThanOrEqual(inside+1e-7);expect(Math.abs(point.y)).toBeLessThanOrEqual(inside+1e-7);}
    }
  });
  it('handles origins inside solids, tangents, rotated walls and real openings',()=>{
    const origin={x:30,y:0,z:HC_SR04.mountHeight};expect(acousticRayLimit(origin,{x:1,y:0,z:0},[wall],400)).toBe(0);
    const circle:SonarTarget={kind:'circle',x:30,y:3,radius:3,z0:0,z1:20};expect(acousticRayLimit({x:0,y:0,z:5},{x:1,y:0,z:0},[circle],400)).toBeCloseTo(30,8);
    const split=[{...wall,y:-60,halfLength:50},{...wall,y:60,halfLength:50}];expect(acousticRayLimit({x:0,y:0,z:5},{x:1,y:0,z:0},split,400)).toBe(400);
    expect(acousticRayLimit({x:0,y:0,z:5},{x:1,y:0,z:0},[{...wall,heading:.4,halfLength:2,halfWidth:10}],400)).toBeGreaterThan(20);
  });
  it('allows passage under high furniture, above flat floor items and through open space, including pitched beams',()=>{
    const at={x:0,y:0,z:5},d={x:1,y:0,z:0};expect(acousticRayLimit(at,d,[{...wall,z0:30,z1:40}],400)).toBe(400);expect(acousticRayLimit(at,d,[{...wall,z0:0,z1:.4}],400)).toBe(400);expect(acousticRayLimit(at,{...d,z:1},[{...wall,z0:30,z1:40}],400)).toBe(29);
    expect(sonarBeamPoints({x:0,y:0,heading:0,range:100,beam:15},[])[16].x).toBe(100);
  });
  it('leaves raw wall/timeout/noise measurements and controller range values unchanged',()=>{
    for(let seed=1;seed<=30;seed++){const pose={x:0,y:0,heading:.7},a=mulberry32(seed),b=mulberry32(seed),expected=ping(HC_SR04,pose,[wall],a);sonarBeamPoints({x:HC_SR04.mountForward,y:0,heading:.7,range:expected.range,beam:15},[wall]);expect(ping(HC_SR04,pose,[wall],b)).toEqual(expected);}
  });
});
describe('conservative scan evidence',()=>{
  it('round-trips actual mount geometry, accepts legacy scans and rejects invalid mounts atomically',()=>{
    const unit=new Sonar({...HC_SR04,mountHeight:8,pitchDeg:12},mulberry32(3)),h=new SonarHistory(),pose={x:0,y:0,heading:0};unit.update(0,pose,[]);h.record(unit,pose);
    const saved=h.toJSON();expect(saved.samples[0]).toMatchObject({height:8,pitch:12});expect(SonarHistory.fromJSON(saved).toJSON()).toEqual(saved);
    const legacy=structuredClone(saved);delete legacy.samples[0].height;delete legacy.samples[0].pitch;expect(SonarHistory.fromJSON(legacy).toJSON()).toEqual(legacy);
    for(const mount of [{height:NaN},{height:-1},{height:5001},{pitch:90},{pitch:-90},{pitch:Infinity}]){const invalid=structuredClone(saved);Object.assign(invalid.samples[0],mount);expect(()=>h.restore(invalid)).toThrow(/Invalid sonar scan mount/);expect(h.toJSON()).toEqual(saved);}
  });
  it('cannot carve through a confirmed wall or insert far hits behind it',()=>{
    const unit=new Sonar({...HC_SR04,mountForward:0},mulberry32(3)),h=new SonarHistory(),pose={x:0,y:0,heading:0};
    const record=(tick:number,range:number,echo=true)=>{unit.update(tick,pose,[]);unit.reading={range,echo,strength:1};h.record(unit,pose);};
    for(let i=0;i<4;i++)record(i*2,80);const wallCells=[...h.cells].filter(([,v])=>v>0);for(let i=4;i<40;i++)record(i*2,200);
    for(const [key,value]of wallCells)expect(h.cells.get(key)).toBeGreaterThanOrEqual(value);
    expect([...h.cells].some(([key])=>Number(key.split(',')[0])>=20)).toBe(false);
    const before=[...h.cells];record(80,400,false);expect([...h.cells]).toEqual(before);
  });
  it('does not add a far endpoint behind repeated 3D room wall evidence',()=>{const m=new RoomMemory({count:512,sparsity:.01,rareWeighting:true});m.map.set('4,0',1.6);m.mapPing({x:0,z:0,heading:0},0,2,true);expect(m.map.has('20,0')).toBe(false);expect(m.map.get('4,0')).toBe(1.6);});
  it('keeps the room map bounded when free cells precede a confirmed wall',()=>{
    const m=new RoomMemory({count:512,sparsity:.01,rareWeighting:true});for(let i=0;i<11999;i++)m.map.set(`${i},1000`,1);m.map.set('4,0',1.6);
    m.mapPing({x:0,z:0,heading:0},0,2,true);expect(m.map.size).toBe(12000);expect(m.map.has('20,0')).toBe(false);expect(m.map.get('4,0')).toBe(1.6);
    m.mapPing({x:0,z:1,heading:0},0,4,true);expect(m.map.size).toBe(12000);
  });
});
