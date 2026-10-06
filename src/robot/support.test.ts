import {describe,it,expect} from 'vitest';
import {CameraMotion,RecoveryDrive} from './recovery';
import {DEFAULT_HUNGER,EnergyState} from './homeostasis';
import {FeedingCycle,feedingTrail,feedingScent,validateSupport} from './feeding';
import {DEFAULT_ROBOT,makeObject,RobotPhysics,RobotSonar} from './model';
import {DEFAULT_NOISE,NoiseSource} from './noise';
import {motorRequests,DEFAULT_ADAPTER} from './controls';
import {placementError} from './placement';
import {DEFAULT_TASK,taskCase,validateTaskSettings} from './lifecycle';
import {retainsForward} from '../vision/world/training';

const forward:import('../core').Action={steer:0,throttle:.4,brake:0};
const sensor={cm:8,age:0,impact:false,impactValid:false,turnBias:-.5,issued:[.4,.4] as [number,number]};
describe('Sensor recovery teacher / explicit assistance',()=>{
  it('measures fresh RGB change and rejects missing or spatially flat camera frames',()=>{const m=new CameraMotion(),flat=new Float32Array(64*3).fill(.5),textured=Float32Array.from({length:64*3},(_,i)=>i%2?.9:.1);m.see(flat,0,true);m.see(flat,1,true);expect(m.motion).toBeNull();m.see(textured,2,true);m.see(textured,3,true);expect(m.motion).toBe(0);m.see(flat,3,true);expect(m.motion).toBe(0);m.see(textured,4,false);expect(m.motion).toBeNull();});
  it('can detect a commanded but visually stationary cart when sonar misses',()=>{const r=new RecoveryDrive();for(let i=0;i<60;i++)r.step({...sensor,cm:null,cameraMotion:0},forward,1/30);expect(r.attempts).toBe(1);expect(r.phase).not.toBe('idle');});
  it('ignores unknown and stale ranges, and disabled impact inputs',()=>{const r=new RecoveryDrive();for(let i=0;i<120;i++)expect(r.step({...sensor,cm:null,impact:true},forward,1/30)).toBeNull();for(let i=0;i<120;i++)expect(r.step({...sensor,age:1},forward,1/30)).toBeNull();expect(r.attempts).toBe(0);});
  it('bounds each reverse burst and resumes forward when the front clears',()=>{const r=new RecoveryDrive();let reverse=0,turn=0;for(let i=0;i<240;i++){const a=r.step({...sensor,cm:i<25?8:100},forward,1/30);if(a?.reverse)reverse++;if(a?.steer)turn++;}expect(r.attempts).toBe(1);expect(reverse/30).toBeLessThanOrEqual(1.3);expect(turn).toBeGreaterThan(20);expect(r.phase).toBe('idle');});
  it('responds to a fresh installed pulse and stops a retreat on another pulse',()=>{const r=new RecoveryDrive();expect(r.step({...sensor,cm:null,impact:true,impactValid:true},forward,.1)?.brake).toBe(1);r.step({...sensor,cm:null,impact:false,impactValid:true},forward,.2);expect(r.phase).toBe('reverse');expect(r.step({...sensor,cm:null,impact:true,impactValid:true},forward,.1)?.brake).toBe(1);expect(r.phase).toBe('turn');});
  it('moves away from a real corner using only simulated sonar readings',()=>{
    const p=new RobotPhysics({...DEFAULT_ROBOT}),r=new RecoveryDrive(),sonar=new RobotSonar(),noise=new NoiseSource({...DEFAULT_NOISE}),wall={...makeObject('wall',.21,0),width:.06,depth:.8},side={...makeObject('wall',0,.3),width:.8,depth:.06};p.pose={x:0,z:0,heading:0};p.odometry={...p.pose};let pwm:[number,number]=[0,0],reverse=0;
    for(let i=0;i<210;i++){sonar.update(i/30,p.pose,[wall,side],p.config,noise);const a=r.step({...sensor,cm:sonar.reading.echo?sonar.metres*100:null,age:i/30-sonar.lastTime,issued:pwm},forward,1/30)??forward;reverse+=+(!!a.reverse);const m=motorRequests(a,{...DEFAULT_ADAPTER,steering:'pivot'});pwm=[m.left/255,m.right/255];p.step(...pwm,[wall,side],1/30);}
    expect(reverse).toBeGreaterThan(0);expect(Math.hypot(p.pose.x,p.pose.z)).toBeGreaterThan(.15);expect(p.blocked).toBe(false);
  });
});
describe('Feeding lifecycle and local virtual scent',()=>{
  it('the low-charge button goes below custom thresholds and rejects invalid energy',()=>{const e=new EnergyState({...DEFAULT_HUNGER,enabled:true}),f=new FeedingCycle();f.request(e,.05);f.update(e,.05,false,0);expect(f.phase).toBe('seek');expect(e.energy).toBe(.025);expect(()=>e.injectLow(NaN)).toThrow();});
  it('returns on low charge, dwells until satiated, releases and can repeat',()=>{const e=new EnergyState({...DEFAULT_HUNGER,enabled:true,initial:1,idleDrain:0,motionDrain:0,dockHold:.2}),f=new FeedingCycle();f.update(e,.25,false,.1);expect(f.phase).toBe('roam');f.request(e);expect(e.energy).toBe(.12);expect(e.cycles).toBe(0);f.update(e,.25,false,.1);expect(f.phase).toBe('seek');f.update(e,.25,true,.1);expect(f.phase).toBe('dock');let reward=0;for(let i=0;i<60;i++){reward+=e.step(.1,0,true);f.update(e,.25,true,.1);}expect(e.charged).toBeGreaterThan(.7);expect(reward).toBeGreaterThan(0);expect(e.cycles).toBe(1);expect(f.phase).toBe('release');for(let i=0;i<15;i++)f.update(e,.25,false,.1);expect(f.phase).toBe('roam');f.request(e);f.update(e,.25,false,.1);expect(f.phase).toBe('seek');});
  it('losing contact interrupts dwell; no replenishment while travelling',()=>{const e=new EnergyState({...DEFAULT_HUNGER,enabled:true}),f=new FeedingCycle();f.update(e,.25,false,.1);f.update(e,.25,true,.1);f.update(e,.25,false,.1);expect(f.phase).toBe('seek');for(let i=0;i<50;i++)e.step(.1,.5,false);expect(e.charged).toBe(0);expect(e.energy).toBeLessThan(.12);});
  it('scent is local, directional along a trail, and absent far from it',()=>{const trail=[{x:0,z:0},{x:1,z:0}];expect(feedingScent({x:.3,z:0,heading:0},trail).bearing).toBeCloseTo(0);expect(Math.abs(feedingScent({x:.3,z:0,heading:Math.PI},trail).bearing)).toBeGreaterThan(.9);expect(feedingScent({x:.3,z:2,heading:0},trail).strength).toBe(0);expect(feedingScent({x:.3,z:2,heading:0},trail).bearing).toBe(0);});
  it('routes around blocking geometry, permits clear furniture undersides and rejects blocked docks',()=>{const pod=makeObject('pod',1,0),wall={...makeObject('wall',0,0),width:.1,depth:1},start={x:-1,z:0,heading:0};const path=feedingTrail(start,pod,[wall,pod],DEFAULT_ROBOT);expect(path.some(p=>Math.abs(p.z)>.65)).toBe(true);for(const p of path)expect(placementError({...p,heading:0},DEFAULT_ROBOT,[wall,pod])).toBeNull();const table=makeObject('table',0,0);expect(feedingTrail(start,pod,[table,pod],DEFAULT_ROBOT)).toHaveLength(3);const bad={...makeObject('block',.65,0),width:.3,depth:.5};expect(()=>feedingTrail(start,pod,[pod,bad],DEFAULT_ROBOT)).toThrow(/obstructed|approach/);});
  it('validates portable support and builds recovery cases without an overlapping start',()=>{expect(()=>validateSupport({recovery:true,feeding:true,lowCharge:NaN})).toThrow();expect(()=>validateTaskSettings({...DEFAULT_TASK,support:{recovery:false,feeding:true,lowCharge:.25}})).toThrow(/energy/);const c=taskCase(4101,false,{...DEFAULT_TASK,mode:'approach',recoveryPractice:true});expect(c.objects.some(o=>o.id==='recovery-front')).toBe(true);expect(placementError(c.pose,DEFAULT_ROBOT,c.objects)).toBeNull();});
});
describe('Forward retention after reverse practice',()=>{
  const r={arrived:true,ticks:100,collisions:0,progress:1,reverseDistance:0,crashed:false};
  it('rejects fast backing specialists that lose forward arrivals or safety',()=>{expect(retainsForward([r],[{...r,arrived:false,progress:.9,reverseDistance:100}],300,.2)).toBe(false);expect(retainsForward([r],[{...r,collisions:10}],300,.2)).toBe(false);expect(retainsForward([r],[{...r,ticks:90}],300,.2)).toBe(true);expect(retainsForward([r],[r],300,.2)).toBe(true);});
});
