import {clamp} from '../core';
import {generateParking,type ParkingSettings,type Lesson} from './model';
import type {ParkingResult} from './episode';
export type ParkingTradeoff={fitness:number;score:number;progress:number;progressPerSecond:number;crashesPerProgress:number;contacts:number;pain:number;seconds:number;quality:number;successes:number;trials:number;valid:boolean};
export function parkingFitness(r:ParkingResult):number{if(r.disqualified)return -100000;return r.success?1000+r.score:Math.min(99,r.quality*30+r.score)-r.pedestrianHits*1000;}
/** External evaluation axes; never inputs, camera overlays or a hidden compass. */
export function parkingTradeoff(rows:ParkingResult[],scenarios:{seed:number;lesson:Lesson}[],settings:ParkingSettings):ParkingTradeoff{
  const n=rows.length,progress=rows.map((r,i)=>{const lot=generateParking({...settings,...scenarios[i]}),d=Math.hypot(lot.start.x-lot.target.x,lot.start.z-lot.target.z);return r.success?1:clamp(1-r.offsetCm/100/Math.max(.01,d),0,1);});
  const mean=(fn:(r:ParkingResult,i:number)=>number)=>rows.reduce((a,r,i)=>a+fn(r,i),0)/Math.max(1,n),contacts=rows.reduce((a,r)=>a+r.contacts,0);
  return{fitness:mean(parkingFitness),score:mean(r=>r.score),progress:progress.reduce((a,b)=>a+b,0)/Math.max(1,n),progressPerSecond:mean((r,i)=>progress[i]/Math.max(1,r.ticks/30)),crashesPerProgress:contacts/Math.max(.05*n,progress.reduce((a,b)=>a+b,0)),contacts,pain:mean(r=>r.pain),seconds:mean(r=>r.ticks/30),quality:mean(r=>r.quality),successes:rows.filter(r=>r.success).length,trials:n,valid:rows.every(r=>!r.disqualified)&&n>0};
}
export function parkingSelectionScore(m:ParkingTradeoff,s:ParkingSettings):number{
  if(s.selection==='score')return m.fitness;if(!m.valid)return -100000;
  const base=1000*m.successes/Math.max(1,m.trials),score=clamp((m.fitness-base)/2,-200,200),speed=50*m.progress+150*Math.min(1,m.progressPerSecond),safety=200*m.progress/(1+m.crashesPerProgress)-Math.min(200,m.pain);
  const weights=s.scoreWeight+s.speedWeight+s.safetyWeight;
  // Completed parking remains dominant. Safety is gated by useful progress;
  // a motionless, crash-free fly cannot win the safety objective by doing nothing.
  return base+(s.selection==='speed'?speed:s.selection==='safety'?safety:(score*s.scoreWeight+speed*s.speedWeight+safety*s.safetyWeight)/weights);
}
