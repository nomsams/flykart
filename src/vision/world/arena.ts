import { WorldDef, KART_RADIUS, surfaceAt } from './world';

export type ArenaFile={format:'flykart-world';version:1;world:WorldDef;start:{x:number;y:number;heading:number}};
export function validateArena(raw:unknown):ArenaFile{
  const a=raw as ArenaFile;
  const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
  if(!a||a.format!=='flykart-world'||a.version!==1||!a.world||!a.start)throw Error('Expected a FlyKart Open world scene (version 1).');
  const w=a.world;
  if(!finite(w.seed)||!finite(w.half)||w.half<100||w.half>1000||!Array.isArray(w.obstacles)||w.obstacles.length>500||!Array.isArray(w.patches)||w.patches.length>500)throw Error('Invalid world size or item count.');
  const circle=(o:{x:number;y:number;radius:number})=>finite(o.x)&&finite(o.y)&&finite(o.radius)&&o.radius>0&&o.radius<=w.half&&Math.abs(o.x)<=w.half&&Math.abs(o.y)<=w.half;
  if(w.obstacles.some(o=>!o||!circle(o)||!['tree','rock'].includes(o.kind)||!finite(o.height)||o.height<=0||o.height>200||!finite(o.tone))||w.patches.some(p=>!p||!circle(p)||!['water','mud','sand'].includes(p.kind)))throw Error('Invalid world objects.');
  if(!finite(a.start.x)||!finite(a.start.y)||!finite(a.start.heading)||!clearPoint(w,a.start.x,a.start.y))throw Error('Start pose must be on clear ground inside the fence.');
  return structuredClone(a);
}
export function clearPoint(w:WorldDef,x:number,y:number,padding=KART_RADIUS+2):boolean{
  return Math.abs(x)<w.half-padding&&Math.abs(y)<w.half-padding&&surfaceAt(w,x,y)!=='water'&&!w.obstacles.some(o=>Math.hypot(o.x-x,o.y-y)<o.radius+padding);
}
/** Find a clear, short corridor behind the start; never delete obstacles. */
export function reverseGoal(w:WorldDef,start:{x:number;y:number;heading:number},distance=100):{x:number;y:number}{
  for(let d=distance;d>=40;d-=10)for(const offset of [0,-.12,.12,-.24,.24]){
    const h=start.heading+Math.PI+offset,x=start.x+Math.cos(h)*d,y=start.y+Math.sin(h)*d;
    if(!clearPoint(w,x,y,26))continue;
    let clear=true;for(let t=0;t<=1;t+=.05)if(!clearPoint(w,start.x+(x-start.x)*t,start.y+(y-start.y)*t)){clear=false;break;}
    if(clear)return{x,y};
  }
  throw Error('No clear reverse corridor here. Choose the clear practice field or move the scene start.');
}
