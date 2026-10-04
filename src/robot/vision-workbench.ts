import { Action, clamp, SpikingNetwork } from "../core";
import { Perceiver, VisionModel } from "../vision/perception";
import type { Proprioception } from "../vision/interface";
import { worldDomain } from "../vision/world/worldDomain";

export type VisionSettings = { normalize: boolean; smooth: boolean; temporal: number; layout: "single" | "circle3" | "circle5" | "scales3"; radius: number; vote?:'confidence'|'mean'|'median';memberWeights?:number[] };
export const DEFAULT_VISION: VisionSettings = {normalize:false,smooth:false,temporal:1,layout:"single",radius:.08};
export function validateVisionSettings(raw:unknown):VisionSettings {
  const s=raw as VisionSettings;
  if(!s||typeof s.normalize!=="boolean"||typeof s.smooth!=="boolean"||![1,4,16].includes(s.temporal)||!["single","circle3","circle5","scales3"].includes(s.layout)||!Number.isFinite(s.radius)||s.radius<0||s.radius>.2)throw new Error("Invalid visual processing settings.");
  if(s.vote!==undefined&&!['confidence','mean','median'].includes(s.vote)||s.memberWeights!==undefined&&(!Array.isArray(s.memberWeights)||s.memberWeights.length!==5||s.memberWeights.some(v=>!Number.isFinite(v)||v<0||v>10)||!s.memberWeights.slice(0,viewPatches(s).length).some(v=>v>0)))throw new Error('Invalid swarm vote/weights.');
  return {...s};
}
export type ViewPatch={x:number;y:number;scale:number};
export function viewPatches(s:VisionSettings):ViewPatch[] {
  const center={x:0,y:0,scale:1};
  if(s.layout==="single")return [center];
  if(s.layout==="scales3")return [center,{x:0,y:0,scale:.86},{x:0,y:0,scale:.72}];
  const n=s.layout==="circle3"?2:4;
  return [center,...Array.from({length:n},(_,i)=>({x:Math.cos(i/n*Math.PI*2)*s.radius,y:Math.sin(i/n*Math.PI*2)*s.radius,scale:1-2*s.radius}))];
}
export function visualFeatures(frame:Float32Array,w:number,h:number):Float32Array {
  const f=new Float32Array(24),counts=new Float32Array(8),n=w*h;
  for(let i=0;i<n;i++){const cell=Math.min(1,Math.floor(Math.floor(i/w)/h*2))*4+Math.min(3,Math.floor((i%w)/w*4));for(let k=0;k<3;k++)f[cell*3+k]+=frame[k*n+i];counts[cell]++;}
  for(let c=0;c<8;c++)for(let k=0;k<3;k++)f[c*3+k]/=Math.max(1,counts[c]);return f;
}
export function cropView(frame:Float32Array,w:number,h:number,p:ViewPatch):Float32Array {
  const result=new Float32Array(frame.length),n=w*h;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const sx=clamp((x/(w-1)-.5)*p.scale*(w-1)+(w-1)*.5+p.x*(w-1),0,w-1),sy=clamp((y/(h-1)-.5)*p.scale*(h-1)+(h-1)*.5+p.y*(h-1),0,h-1),ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;
    for(let k=0;k<3;k++){const at=(a:number,b:number)=>frame[k*n+Math.min(h-1,b)*w+Math.min(w-1,a)];result[k*n+y*w+x]=at(ix,iy)*(1-fx)*(1-fy)+at(ix+1,iy)*fx*(1-fy)+at(ix,iy+1)*(1-fx)*fy+at(ix+1,iy+1)*fx*fy;}
  }return result;
}
export class VisualFilter {
  private history:Float32Array[]=[];
  reset():void{this.history=[];}
  process(frame:Float32Array,w:number,h:number,s:VisionSettings):Float32Array {
    this.history.push(frame.slice());while(this.history.length>s.temporal)this.history.shift();
    let out=new Float32Array(frame.length);for(const f of this.history)for(let i=0;i<out.length;i++)out[i]+=f[i]/this.history.length;
    if(s.smooth){const next=out.slice(),n=w*h;for(let k=0;k<3;k++)for(let y=0;y<h;y++)for(let x=0;x<w;x++){let sum=0,count=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const a=x+dx,b=y+dy;if(a>=0&&a<w&&b>=0&&b<h){sum+=out[k*n+b*w+a];count++;}}next[k*n+y*w+x]=sum/count;}out=next;}
    if(s.normalize){const n=w*h;let mean=0,square=0;for(let i=0;i<n;i++){const v=(out[i]+out[n+i]+out[n*2+i])/3;mean+=v/n;square+=v*v/n;}const gain=Math.min(4,.16/Math.max(.02,Math.sqrt(Math.max(0,square-mean*mean))));for(let i=0;i<out.length;i++)out[i]=clamp(.5+(out[i]-mean)*gain,0,1);}
    return out;
  }
}
type Member={patch:ViewPatch;frame:Float32Array;mean:Float32Array;variance:Float32Array;weight:number};
export class VisualSwarm {
  readonly filter=new VisualFilter();
  private readers:Perceiver[];
  private brains:SpikingNetwork[]=[];
  private source:SpikingNetwork|null=null;
  readonly members:Member[]=[];
  disagreement=0;
  votes:Action[]=[];
  processed:Float32Array=new Float32Array(0);
  constructor(readonly model:VisionModel,readonly settings:VisionSettings){this.readers=viewPatches(settings).map(()=>new Perceiver(model));}
  reset():void {this.filter.reset();this.readers.forEach(p=>p.reset());this.brains=[];this.source=null;this.members.length=0;this.votes=[];this.disagreement=0;}
  see(frame:Float32Array,body:Proprioception,domain:"world"|"track"):Float32Array {
    const {width:w,height:h}=this.model.spec;this.processed=this.filter.process(frame,w,h,this.settings);this.members.length=0;
    const patches=domain==="world"?viewPatches(this.settings):[{x:0,y:0,scale:1}],base=new Float32Array(this.readers[0].estimateCount);
    const sum=new Float32Array(base.length),weights=new Float32Array(base.length);
    patches.forEach((patch,j)=>{
      const pixels=j===0?this.processed:cropView(this.processed,w,h,patch),perception=this.readers[j].see(pixels,body),mean=perception.mean.slice(),variance=perception.variance.slice();
      if(j===0)base.set(mean);
      const aligned=base.slice(),alignedVar=variance.slice();
      for(let k=0;k<mean.length;k++){
        const dest=domain==="world"&&k<9?Math.round(((k/8-.5)*patch.scale+patch.x+.5)*8):k;
        if(dest<0||dest>=mean.length)continue;
        const weight=1/Math.max(.02,variance[k]);sum[dest]+=mean[k]*weight;weights[dest]+=weight;aligned[dest]=mean[k];alignedVar[dest]=variance[k];
      }
      const weight=1/Math.max(.02,variance.reduce((a,b)=>a+b,0)/variance.length);
      this.members.push({patch,frame:pixels,mean:aligned,variance:alignedVar,weight});
    });
    const fused=base.map((v,k)=>weights[k]?sum[k]/weights[k]:v);let difference=0;
    for(const m of this.members)for(let k=0;k<fused.length;k++)difference+=(m.mean[k]-fused[k])**2;
    this.disagreement=Math.sqrt(difference/Math.max(1,this.members.length*fused.length));return fused;
  }
  step(controller:SpikingNetwork,inputs:number[],body:Proprioception,mission:[number,number],domain:"world"|"track"):Action {
    if(domain==="world"&&this.members.length>1&&this.source!==controller){this.brains=this.members.slice(1).map(()=>controller.clone());this.source=controller;}
    const primary=controller.step(inputs);
    this.votes=[primary];
    if(domain!=="world"||this.members.length<2)return primary;
    const votes=[primary,...this.brains.map((brain,i)=>{const local=[...inputs],mean=this.members[i+1].mean.slice();mean[4]=Math.max(mean[4],body.sonarCloseness??0);worldDomain.sensors(mean,mission,body,local);return brain.step(local);})],weights=this.members.map((m,i)=>(this.settings.memberWeights?.[i]??1)*(this.settings.vote==='mean'||this.settings.vote==='median'?1:m.weight)),weight=weights.reduce((a,v)=>a+v,0);
    this.votes=votes;
    const result:Action={steer:0,throttle:0,brake:0,reverse:0};
    if(this.settings.vote==='median'){for(const k of ['steer','throttle','brake','reverse'] as const){const values=votes.map((v,i)=>({v:v[k]??0,w:weights[i]})).filter(v=>v.w>0).sort((a,b)=>a.v-b.v);let cumulative=0;for(const v of values){cumulative+=v.w;if(cumulative>=weight/2){result[k]=v.v;break;}}}return result;}
    votes.forEach((a,i)=>{const v=weights[i]/Math.max(1e-8,weight);result.steer+=a.steer*v;result.throttle+=a.throttle*v;result.brake+=a.brake*v;result.reverse!+=(a.reverse??0)*v;});return result;
  }
}
