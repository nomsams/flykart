import {clamp} from '../core';
export type GuardSettings={enabled:boolean;margin:number;reaction:number;deceleration:number;stale:number;unknown:'stop'|'crawl';crawl:number};
export const DEFAULT_GUARD:GuardSettings={enabled:false,margin:.04,reaction:.2,deceleration:.7,stale:.3,unknown:'stop',crawl:.15};
export function validateGuard(raw:unknown=DEFAULT_GUARD):GuardSettings{
  const s=raw as GuardSettings;
  if(!s||typeof s.enabled!=='boolean'||!['stop','crawl'].includes(s.unknown))throw new Error('Invalid collision guard.');
  for(const [key,[min,max]]of Object.entries({margin:[.01,.25],reaction:[.05,2],deceleration:[.1,3],stale:[.1,3],crawl:[.05,.3]})){const v=s[key as keyof GuardSettings];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('Invalid guard parameter: '+key);}
  return {...s};
}
export function guardMotors(pwm:[number,number],cm:number|null,age:number,maxSpeed:number,s:GuardSettings):{pwm:[number,number];reason:string;stopDistance:number}{
  const forward=Math.max(0,(pwm[0]+pwm[1])/2),speed=forward*maxSpeed,stopDistance=s.margin+speed*s.reaction+speed*speed/(2*s.deceleration);
  if(!s.enabled||!forward)return {pwm:[...pwm],reason:s.enabled?'Reverse / pivot outside forward sonar coverage':'Guard off',stopDistance};
  if(!Number.isFinite(age)||age>s.stale)return {pwm:[0,0],reason:'Stopped · stale sonar sample',stopDistance};
  let factor=1,reason='Clear forward range';
  if(cm===null){factor=s.unknown==='stop'?0:Math.min(1,s.crawl/forward);reason=s.unknown==='stop'?'Stopped · unknown echo':'Crawl · unknown echo';}
  else if(cm/100<=stopDistance){factor=0;reason='Stopped · braking envelope';}
  else if(cm/100<stopDistance*2){factor=clamp((cm/100-stopDistance)/stopDistance,.1,1);reason='Slowing · braking envelope';}
  return {pwm:[pwm[0]*factor,pwm[1]*factor],reason,stopDistance};
}
