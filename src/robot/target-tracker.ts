import { ColourTarget, rgbHue } from './sensor-contract';
export type TargetSight={bearing:number;area:number;visible:boolean};
export type TargetComponent=TargetSight & {vertical:number;pixels:number;fill:number;aspect:number};
export type TargetTrack=TargetSight & {id:number|null;components:number;misses:number;confidence:number};
export const EMPTY_TARGET:TargetTrack={bearing:0,area:0,visible:false,id:null,components:0,misses:0,confidence:0};
export function targetComponents(frame:Float32Array,w:number,h:number,target:ColourTarget):TargetComponent[]{
  const n=w*h;if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>160||h>120||frame.length!==n*3)throw new Error('Invalid target camera frame.');
  const mask=new Uint8Array(n),queue=new Int32Array(n),found:TargetComponent[]=[];
  for(let i=0;i<n;i++){const [hue,s,v]=rgbHue(frame[i],frame[n+i],frame[2*n+i]),d=Math.abs(hue-target.hue);mask[i]=+(Math.min(d,360-d)<=target.tolerance&&s>=target.minSaturation&&v>=target.minValue);}
  for(let i=0;i<n;i++)if(mask[i]){
    let head=0,tail=1,sx=0,sy=0,minX=w,maxX=0,minY=h,maxY=0;queue[0]=i;mask[i]=0;
    while(head<tail){const k=queue[head++],x=k%w,y=Math.floor(k/w);sx+=x;sy+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const next of [x>0?k-1:-1,x<w-1?k+1:-1,y>0?k-w:-1,y<h-1?k+w:-1])if(next>=0&&mask[next]){mask[next]=0;queue[tail++]=next;}
    }
    if(tail>=Math.max(3,n*.002))found.push({visible:true,bearing:sx/tail/Math.max(1,w-1)*2-1,vertical:sy/tail/Math.max(1,h-1)*2-1,area:tail/n,pixels:tail,fill:tail/((maxX-minX+1)*(maxY-minY+1)),aspect:(maxX-minX+1)/(maxY-minY+1)});
  }
  return found;
}
const quality=(c:TargetComponent)=>c.area*Math.min(c.aspect,1/c.aspect)*c.fill;
export function targetSight(frame:Float32Array,w:number,h:number,target:ColourTarget):TargetSight {const c=targetComponents(frame,w,h,target).sort((a,b)=>quality(b)-quality(a))[0];return c?{bearing:c.bearing,area:c.area,visible:true}:{bearing:0,area:0,visible:false};}
export class TargetTracker {
  current:TargetTrack={...EMPTY_TARGET};private previous:TargetComponent|null=null;private sequence=0;private at=-Infinity;private targetKey='';
  reset():void{this.current={...EMPTY_TARGET};this.previous=null;this.sequence=0;this.at=-Infinity;this.targetKey='';}
  see(frame:Float32Array,w:number,h:number,target:ColourTarget,time:number,valid=true):TargetTrack {
    if(!Number.isFinite(time))throw new Error('Invalid tracker timestamp.');const key=JSON.stringify([w,h,target]);if(key!==this.targetKey||time<this.at){this.reset();this.targetKey=key;}
    if(time===this.at)return {...this.current};this.at=time;
    const components=valid?targetComponents(frame,w,h,target):[];
    let chosen:TargetComponent|undefined;
    if(this.previous){const old=this.previous;chosen=components.map(c=>({c,d:Math.hypot(c.bearing-old.bearing,c.vertical-old.vertical)+Math.abs(Math.log(c.area/old.area))*.15})).filter(v=>v.d<.65).sort((a,b)=>a.d-b.d)[0]?.c;}
    else chosen=components.sort((a,b)=>quality(b)-quality(a))[0];
    if(!chosen){const misses=this.current.misses+1;this.current={...EMPTY_TARGET,id:this.current.id,components:components.length,misses};if(misses>=3){this.previous=null;this.current.id=null;}return {...this.current};}
    const id=this.previous?this.current.id:++this.sequence;this.previous=chosen;
    this.current={bearing:chosen.bearing,area:chosen.area,visible:true,id,components:components.length,misses:0,confidence:Math.min(1,chosen.fill*Math.min(chosen.aspect,1/chosen.aspect))};return {...this.current};
  }
}
