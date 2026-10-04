import { mulberry32 } from '../vision/rng';

export type VibrationSettings = { enabled:boolean; activeLow:boolean; sensitivity:number; debounceMs:number; holdMs:number; gpio33Access:boolean };
export const DEFAULT_VIBRATION:VibrationSettings={enabled:false,activeLow:true,sensitivity:.5,debounceMs:15,holdMs:150,gpio33Access:false};
export function validateVibration(raw:unknown):VibrationSettings {
  if(raw===undefined)return {...DEFAULT_VIBRATION};
  const s=raw as VibrationSettings;
  if(!s||['enabled','activeLow','gpio33Access'].some(k=>typeof s[k as keyof VibrationSettings]!=='boolean')||!Number.isFinite(s.sensitivity)||s.sensitivity<0||s.sensitivity>1||!Number.isFinite(s.debounceMs)||s.debounceMs<1||s.debounceMs>100||!Number.isFinite(s.holdMs)||s.holdMs<20||s.holdMs>2000)throw new Error('Invalid SW-420 sensitivity / debounce / hold settings.');
  return {...s};
}
export type VibrationReading={level:0|1;active:boolean;valid:boolean;count:number};
/** Capture short active edges; suppress switch bounce, then hold the event for the controller. */
export class VibrationSensor {
  reading:VibrationReading={level:1,active:false,valid:false,count:0};
  private lastEdge=-Infinity;private heldUntil=-Infinity;private wasActive=false;private time=-Infinity;
  private random:()=>number;
  constructor(seed=420){this.random=mulberry32(seed);}
  sample(level:0|1,timeMs:number,s:VibrationSettings,valid=true):VibrationReading {
    if(!Number.isFinite(timeMs)||timeMs<this.time)throw new Error('Vibration clock must be monotonic.');this.time=timeMs;
    if(!s.enabled||!valid){this.wasActive=false;this.heldUntil=-Infinity;return this.reading={level,active:false,valid:false,count:this.reading.count};}
    const on=s.activeLow?level===0:level===1;
    if(on&&!this.wasActive&&timeMs-this.lastEdge>=s.debounceMs){this.lastEdge=timeMs;this.heldUntil=timeMs+s.holdMs;this.reading.count++;}
    this.wasActive=on;return this.reading={level,active:timeMs<this.heldUntil,valid:true,count:this.reading.count};
  }
  simulate(timeMs:number,s:VibrationSettings,impact:number,surface:boolean,speed:number,dt:number):VibrationReading {
    // Approximate mounting-dependent switch triggering, not a force measurement.
    const threshold=.012+(1-s.sensitivity)*.22;
    const shake=impact>threshold||surface&&Math.abs(speed)>.03||Math.abs(speed)>.03&&this.random()<dt*s.sensitivity*.45;
    return this.sample((shake===s.activeLow?0:1),timeMs,s);
  }
}
export type VibrationTelemetry={deviceMs:number;level:0|1;count:number;active:boolean};
export function parseVibrationLine(line:string):VibrationTelemetry|null {
  if(!line.startsWith('VIB '))return null;
  const m=/^VIB (\d+) ([01]) (\d+) ([01])$/.exec(line.trim());
  if(!m||![m[1],m[3]].every(v=>Number.isSafeInteger(Number(v))&&Number(v)<=0xffffffff))throw new Error('Malformed SW-420 telemetry.');
  return {deviceMs:Number(m[1]),level:Number(m[2]) as 0|1,count:Number(m[3]),active:m[4]==='1'};
}
