import {expect,it} from 'vitest';
import {CommandSpeed,transferContract} from './transfer';
import {WorldEpisode} from './worldDomain';
import {SearchJudge,DEFAULT_SEARCH_JUDGE} from './search-judge';
import {HC_SR04,SONAR_USEFUL_RANGE_PX} from '../robot';
import {sonarInputs} from '../sonar';
it('hardware sonar inputs expose detection instead of unmeasurable analogue echo amplitude',()=>{
  const e=new WorldEpisode({seed:1,headless:true,sonar:HC_SR04,sonarFeedback:'echo-valid'});
  e.sonarUnit!.reading={range:80,echo:true,strength:1};const weak=sonarInputs(e.sonar()!,SONAR_USEFUL_RANGE_PX);
  e.sonarUnit!.reading.strength=999;expect(sonarInputs(e.sonar()!,SONAR_USEFUL_RANGE_PX)).toEqual(weak);expect(weak[1]).toBe(1);expect(e.proprioception().sonarStrength).toBe(1);expect(e.sonarUnit!.reading.strength).toBe(999);
  e.sonarUnit!.reading.echo=false;expect(sonarInputs(e.sonar()!,SONAR_USEFUL_RANGE_PX)).toEqual([0,0]);
  const legacy=new WorldEpisode({seed:1,headless:true,sonar:HC_SR04});legacy.sonarUnit!.reading={range:80,echo:true,strength:1};expect(sonarInputs(legacy.sonar()!,SONAR_USEFUL_RANGE_PX)[1]).toBe(0);
});
it('command feedback stays independent of blocked wheels and simulator truth',()=>{
  const a=new WorldEpisode({seed:1,headless:true,speedFeedback:'command'}),b=new WorldEpisode({seed:1,headless:true,speedFeedback:'command'});
  const drive={steer:0,throttle:1,brake:0,reverse:0};
  for(let i=0;i<60;i++){a.step(drive);b.step(drive);b.sim.kart.speed=0;b.sim.kart.x=0;b.sim.kart.y=0;}
  expect(a.proprioception().speed).toEqual(b.proprioception().speed);expect(b.proprioception().speed).toBeGreaterThan(.4);
  const measured=new WorldEpisode({seed:1,headless:true,speedFeedback:'measured'});measured.sim.kart.speed=45;expect(measured.proprioception().speed).toBe(.5);
});
it('braking estimate stops without oscillating across zero and permits reverse commands',()=>{
  const m=new CommandSpeed();for(let i=0;i<90;i++)m.step({steer:0,throttle:1,brake:0});for(let i=0;i<90;i++)m.step({steer:0,throttle:0,brake:1});expect(m.value).toBe(0);
  for(let i=0;i<30;i++)m.step({steer:0,throttle:0,brake:0,reverse:1});expect(m.value).toBeLessThan(0);
});
it('a visible flag does not reward endless reversing away; actual approach remains eligible',()=>{
  const j=new SearchJudge({...DEFAULT_SEARCH_JUDGE});j.reset(0,0);for(let t=1;t<=300;t++)j.observe(-t,0,t,0,0,false,0,{visualSearch:true,reverse:true,targetVisible:true});
  expect(j.coverageReward).toBe(0);expect(j.penalty).toBeGreaterThan(0);
  const approach=new SearchJudge({...DEFAULT_SEARCH_JUDGE});approach.reset(0,0);for(let t=1;t<=300;t++)approach.observe(-t,0,t,t/300,0,false,0,{visualSearch:true,reverse:true,targetVisible:true});expect(approach.penalty).toBe(0);
});
it('transfer metadata never claims a simulator brain is hardware validated',()=>{
  const c=transferContract({task:'explore',speedFeedback:'command',sonarFeedback:'echo-valid',sonarOn:true,profile:{sonar:{}},controller:{inputCount:19},vision:{spec:{width:48,height:24}}});
  expect(c.hardwareValidated).toBe(false);expect(c.goalSource).toBe('processed camera pixels');expect(c.sonar).toMatch(/HC-SR04/);expect(c.reverseClearance).toMatch(/rear/);
});
