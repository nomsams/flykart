import type { Action } from '../core';
import type { SonarReading } from './sonar';
import { CM_PER_PIXEL } from './robot';
export type StallSettings={enabled:boolean;delaySeconds:number;doublingSeconds:number;maxRate:number};
export const DEFAULT_STALL:StallSettings={enabled:false,delaySeconds:1.2,doublingSeconds:2,maxRate:1};
export function validateStall(raw:unknown):StallSettings {
  if(raw===undefined)return {...DEFAULT_STALL};
  const s=raw as StallSettings;
  if(!s||typeof s.enabled!=='boolean'||!Number.isFinite(s.delaySeconds)||s.delaySeconds<.5||s.delaySeconds>5||!Number.isFinite(s.doublingSeconds)||s.doublingSeconds<.5||s.doublingSeconds>10||!Number.isFinite(s.maxRate)||s.maxRate<.1||s.maxRate>3)throw Error('Invalid visual stall settings.');
  return {...s};
}
/** Portable diagnostic: pixels, sent motor command, sonar and clock only.
 * No simulator position, true speed, contact labels or goal coordinates.
 * A low-resolution image-change heuristic, not full optical flow or odometry.
 */
export class VisualStall {
  bit:0|1=0;valid=false;seconds=0;motion=0;rate=0;reason='off';
  private previous:Float32Array|null=null;
  private tick=-Infinity;private closeRange=Infinity;private closeFrames=0;
  constructor(readonly width:number,readonly height:number,readonly settings:StallSettings){}
  reset():void{this.previous=null;this.tick=-Infinity;this.closeRange=Infinity;this.closeFrames=0;this.bit=0;this.valid=false;this.seconds=0;this.motion=0;this.rate=0;this.reason='warming up';}
  observe(pixels:Float32Array,tick:number,command:Action,sonar:SonarReading|null):void {
    if(!this.settings.enabled){this.reset();this.reason='off';return;}
    if(tick===this.tick)return; // Held frames are not repeated evidence.
    const elapsed=(tick-this.tick)/30;
    const demand=Math.max(command.throttle,command.reverse??0)>=.35&&command.brake<.2;
    const n=this.width*this.height,coarse=new Float32Array(32);
    if(pixels.length!==n*3||!pixels.every(Number.isFinite)){this.reset();this.reason='invalid camera';return;}
    for(let y=0;y<4;y++)for(let x=0;x<8;x++){
      let sum=0,count=0;
      for(let py=Math.floor(y*this.height/4);py<Math.floor((y+1)*this.height/4);py++)for(let px=Math.floor(x*this.width/8);px<Math.floor((x+1)*this.width/8);px++){const at=py*this.width+px;sum+=.299*pixels[at]+.587*pixels[n+at]+.114*pixels[2*n+at];count++;}
      coarse[y*8+x]=sum/Math.max(1,count);
    }
    const mean=coarse.reduce((a,v)=>a+v,0)/32;
    const variance=coarse.reduce((a,v)=>a+(v-mean)**2,0)/32;
    const near=Boolean(sonar?.echo&&sonar.range*CM_PER_PIXEL<20&&command.throttle>(command.reverse??0));
    this.closeFrames=near&&Math.abs((sonar?.range??Infinity)-this.closeRange)<3?this.closeFrames+1:0;this.closeRange=sonar?.range??Infinity;
    const previous=this.previous,previousMean=previous?previous.reduce((a,v)=>a+v,0)/32:0;
    // Remove uniform exposure shifts; texture/motion is still needed, or a
    // stable near-front echo to corroborate a featureless facing wall.
    this.motion=previous?coarse.reduce((a,v,i)=>a+Math.abs((v-mean)-(previous[i]-previousMean)),0)/32:Infinity;
    this.valid=Boolean(previous&&elapsed>0&&elapsed<=.2&&mean>.04&&(variance>.0006||this.closeFrames>=2));
    const blocked=demand&&this.valid&&this.motion<.012;
    this.seconds=blocked?this.seconds+elapsed:0;
    this.bit=this.seconds>=this.settings.delaySeconds?1:0;
    this.rate=this.bit?Math.min(this.settings.maxRate,.08*2**Math.min(20,(this.seconds-this.settings.delaySeconds)/this.settings.doublingSeconds)):0;
    this.reason=!demand?'no drive demand':!this.valid?'insufficient camera evidence':this.bit?'suspected stall':blocked?'confirming low motion':'visual motion';
    this.previous=coarse;this.tick=tick;
  }
  painForTick(tick:number):number {
    if(tick-this.tick>6||tick<this.tick){this.bit=0;this.valid=false;this.rate=0;this.seconds=0;this.reason='camera stale';return 0;}
    return this.rate/30;
  }
}
