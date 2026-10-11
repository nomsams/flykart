import {describe,it,expect} from 'vitest';
import {ParkingEpisode,ParkingCue,PX} from './episode';
import {DEFAULT_PARKING,generateParking,validateParkingSettings,type ParkingSettings} from './model';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import {ping} from '../vision/sonar';
import {mulberry32} from '../vision/rng';
import {ParkingMotionJudge} from './motion-judge';
const idle={steer:0,throttle:0,brake:0,reverse:0};
function lot(patch:Partial<ParkingSettings>={}){const settings={...DEFAULT_PARKING,approachReward:false,progressPenalty:false,maxTicks:600,...patch},scene=generateParking(settings);scene.actors=[];scene.start={x:.8,z:0,heading:0};scene.target={...scene.target,x:0,z:0,heading:0};scene.bays=scene.bays.map(b=>b.id===scene.target.id?{...scene.target}:b);return new ParkingEpisode(settings,ROBOT_WORLD_CAMERA,scene);}
function rock(e:ParkingEpisode,ticks:number){let sign=1;e.physics.step=()=>{e.physics.pose.x+=sign*.0016;};for(let i=0;i<ticks&&!e.done;i++){sign=Math.floor(i/10)%2?-1:1;e.step({...idle,throttle:sign>0?1:0,reverse:sign<0?1:0});}}
describe('combined negative feedback and motion eradication',()=>{
  it('migrates legacy rules and validates every new control',()=>{
    const old={...DEFAULT_PARKING} as Record<string,unknown>;for(const key of ['painAndPenalty','painRewardWeight','antiJiggle','jiggleWindowSeconds','jiggleWeight','eradicatorSeconds'])delete old[key];expect(validateParkingSettings(old)).toEqual(DEFAULT_PARKING);
    for(const patch of [{painAndPenalty:1},{antiJiggle:'yes'},{painRewardWeight:0},{jiggleWindowSeconds:1},{jiggleWeight:NaN},{eradicatorSeconds:61}])expect(()=>validateParkingSettings({...old,...patch})).toThrow('motion judge');
    expect(validateParkingSettings({...old,slowMode:'both'}).slowMode).toBe('both');
  });
  it('applies pain and immediate negative sugar together without subtracting the sugar twice',()=>{
    const e=lot({slowDriving:true,slowMode:'both'});for(let i=0;i<60;i++)e.step(idle);
    expect(e.status.pain).toBeCloseTo(1);expect(e.status.slowPain).toBeCloseTo(1);expect(e.status.negativeReward).toBeCloseTo(1);expect(e.status.reward).toBeCloseTo(-1);expect(e.status.slowPenalty).toBe(0);expect(e.status.score).toBeCloseTo(-1-16-.4);
  });
  it('mirrors contact and sensor-stall pain when requested, including delayed and frozen evaluation',()=>{
    for(const phase of ['shaped','sparse','frozen'] as const){const e=lot({phase,painAndPenalty:true,painRewardWeight:2,delayReward:true});e.physics.step=()=>{e.physics.blocked=true;};e.step(idle);e.addPain(.5);
      expect(e.status.pain).toBeCloseTo(.6);expect(e.status.negativeReward).toBeCloseTo(1.2);expect(e.status.reward).toBeCloseTo(phase==='frozen'?0:-1.2);expect(e.status.pendingReward).toBe(0);expect(e.status.score).toBeCloseTo(-1.2-.6*16-1/30*.2);
    }
  });
  it('punishes repeated physical rocking with both channels even when Zero chill is off',()=>{
    const e=lot();rock(e,240);expect(e.status.disqualified).toBe(false);expect(e.status.jigglePain).toBeGreaterThan(0);expect(e.status.negativeReward).toBeGreaterThan(0);expect(e.status.reward).toBeLessThan(0);expect(e.status.jiggleSeconds).toBeGreaterThan(3);expect(e.status.reversalCount).toBeGreaterThanOrEqual(4);
    const off=lot({antiJiggle:false});rock(off,240);expect(off.status.jigglePain).toBe(0);expect(off.status.negativeReward).toBe(0);
  });
  it('eradicates persistent oscillators and leaves a reason/effect; a disqualified body never advances again',()=>{
    const e=lot({strictCrash:true});rock(e,300);expect(e.status.eradicationReason).toBe('oscillation');expect(e.status.disqualified).toBe(true);expect(e.tick).toBeLessThan(190);expect(e.effects.some(p=>p.kind==='eradicated')).toBe(true);expect(e.status.pain).toBeGreaterThan(e.status.jigglePain);const before=e.result();e.step(idle);expect(e.result()).toEqual(before);
    const headless=lot({strictCrash:true});headless.diagnostics=false;rock(headless,300);expect({...headless.result()}).toEqual(before);expect(headless.effects).toEqual([]);
  });
  it('rejects stationary no-progress trials after the chosen limit and exempts valid delayed parking',()=>{
    const e=lot({strictCrash:true,eradicatorSeconds:4,jiggleWindowSeconds:2});for(let i=0;i<150;i++)e.step(idle);expect(e.tick).toBe(120);expect(e.status.eradicationReason).toBe('stalled');expect(e.status.negativeReward).toBe(1);
    const parked=lot({strictCrash:true,eradicatorSeconds:4,jiggleWindowSeconds:2,delayReward:true,rewardDelaySeconds:8});parked.physics.pose={x:0,z:0,heading:0};for(let i=0;i<300;i++)parked.step(idle);expect(parked.status.success).toBe(true);expect(parked.status.disqualified).toBe(false);expect(parked.status.jigglePain).toBe(0);
  });
  it('preserves useful reversing and multi-point approaches instead of punishing every gear change',()=>{
    const e=lot({strictCrash:true});let sign=1;e.physics.step=()=>{e.physics.pose.x+=sign*(sign>0?.0004:.0016);};for(let i=0;i<240&&!e.done;i++){sign=Math.floor(i/10)%2?-1:1;e.step({...idle,throttle:sign>0?1:0,reverse:sign<0?1:0});}expect(e.status.disqualified).toBe(false);expect(e.status.jigglePain).toBe(0);expect(e.status.idleSeconds).toBeLessThan(1);
  });
  it('ignores tiny pose chatter and one-tick command glitches, but detects sustained blocked command rocking',()=>{
    const a=new ParkingMotionJudge(),b=new ParkingMotionJudge();let glitch,blocked;
    for(let tick=1;tick<=180;tick++){const sign=tick%2?1:-1;glitch=a.observe(tick,{x:0,z:0,heading:0},{x:sign*1e-6,z:0,heading:0},sign,4,false);blocked=b.observe(tick,{x:0,z:0,heading:0},{x:0,z:0,heading:0},Math.floor(tick/10)%2?1:-1,4,false);}
    expect(glitch!.oscillating).toBe(false);expect(blocked!.oscillating).toBe(true);
  });
});
describe('parked car surface and visual goal agreement',()=>{
  it('keeps car surfaces distinct from flag colour while a flag can be visible above an intervening car',()=>{
    for(const cars of [false,true])for(const heading of [0,Math.PI/2,.4]){
      const e=lot({cars}),a=generateParking(DEFAULT_PARKING).actors[0];a.pose={x:1.2,z:0,heading};e.scene.actors=[a];e.scene.target.x=1.8;e.scene.target.z=0;e.render();const cue=new ParkingCue(e.camera);cue.observe(e.frame,0);expect(cue.tracker.current.visible).toBe(true);
      const spec={...e.sonarUnit.spec,noiseBaseCm:0,noiseProportional:0,soundScaleSigma:0,speckleSigma:0,ghostProbability:0,resolutionCm:.001};
      const reading=ping(spec,e.pose,e.targets(),mulberry32(1));expect(reading.echo).toBe(true);expect(reading.range/PX).toBeLessThan(.3);
      // Remove the real target from the camera; blue/grey car faces cannot become a pink flag.
      e.scene.target.x=-1.8;e.render();cue.reset();cue.observe(e.frame,1);expect(cue.tracker.current.visible).toBe(false);
      expect(ping(spec,e.pose,e.targets(),mulberry32(1))).toEqual(reading);
    }
  });
});
