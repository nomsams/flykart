import { VisualFilter, cropView, viewPatches, VisionSettings } from "../robot/vision-workbench";
import { Proprioception } from "./interface";
import { Perceiver, Perception } from "./perception";
import type { RacingSettings } from "./racing-settings";

/** Degrade colour resolution without changing the trained network's tensor shape. */
export function lowResolution(frame:Float32Array,w:number,h:number,resolution:RacingSettings['resolution']):Float32Array {
  if(resolution==='native')return frame;
  const [rw,rh]=resolution.split('x').map(Number), n=w*h, sum=new Float32Array(rw*rh*3), count=new Uint32Array(rw*rh);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const cell=Math.min(rh-1,Math.floor(y*rh/h))*rw+Math.min(rw-1,Math.floor(x*rw/w));count[cell]++;for(let k=0;k<3;k++)sum[k*rw*rh+cell]+=frame[k*n+y*w+x];}
  const out=frame.slice();
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const cell=Math.min(rh-1,Math.floor(y*rh/h))*rw+Math.min(rw-1,Math.floor(x*rw/w));for(let k=0;k<3;k++)out[k*n+y*w+x]=sum[k*rw*rh+cell]/Math.max(1,count[cell]);}
  return out;
}
export class VisionEnsemble {
  private filter=new VisualFilter();
  private readers:Perceiver[];
  frames:Float32Array[]=[];
  processed:Float32Array=new Float32Array(0);
  disagreement=0;
  constructor(readonly primary:Perceiver,readonly settings:VisionSettings,readonly resolution:RacingSettings['resolution']){
    this.readers=viewPatches(settings).map((_,i)=>i===0?primary:new Perceiver(primary.model));
  }
  reset():void{this.filter.reset();this.readers.forEach(r=>r.reset());this.frames=[];this.disagreement=0;}
  see(frame:Float32Array,body:Proprioception):Perception {
    const {width:w,height:h}=this.primary.model.spec;
    if(frame.length!==w*h*3)throw new Error('Camera frame dimensions do not match the eye network.');
    this.processed=this.filter.process(lowResolution(frame,w,h,this.resolution),w,h,this.settings);
    this.frames=viewPatches(this.settings).map((p,i)=>i===0?this.processed:cropView(this.processed,w,h,p));
    const opinions=this.readers.map((r,i)=>r.see(this.frames[i],body));
    if(opinions.length===1)return opinions[0];
    const first=opinions[0], result:Perception={mean:first.mean.slice(),variance:first.variance.slice(),action:first.action.slice(),embedding:first.embedding.slice()};
    let diff=0;
    for(let k=0;k<result.mean.length;k++){
      const weights=opinions.map(p=>1/Math.max(.02,p.variance[k])), total=weights.reduce((a,b)=>a+b,0);
      const mean=opinions.reduce((a,p,i)=>a+p.mean[k]*weights[i]/total,0);
      const spread=opinions.reduce((a,p,i)=>a+weights[i]/total*(p.mean[k]-mean)**2,0);
      result.mean[k]=mean;
      // Correlated views do not create independent evidence: never divide uncertainty by member count.
      result.variance[k]=opinions.reduce((a,p,i)=>a+p.variance[k]*weights[i]/total,0)+spread;
      diff+=spread;
    }
    for(let k=0;k<result.action.length;k++)result.action[k]=opinions.reduce((a,p)=>a+p.action[k]/opinions.length,0);
    this.disagreement=Math.sqrt(diff/result.mean.length);
    return result;
  }
}
