import type { Obstacle, WorldDef } from './world';
import { mulberry32 } from '../rng';

export const OBJECT_KINDS = ['tree','rock','block','shoe','cable','mat','table','chair','bed'] as const;
export const BODY_HEIGHT = 6; // 6.6 cm at the robot profile's 1.1 cm / world unit.
export type Solid = { x:number;y:number;radius:number;halfLength?:number;halfWidth?:number };
export const furniture = (o:Obstacle):boolean => ['table','chair','bed'].includes(o.kind);
export const floorItem = (o:Obstacle):boolean => o.kind==='cable'||o.kind==='mat';
export const movable = (o:Obstacle):boolean => o.kind==='shoe';
export const clearance = (o:Obstacle):number => o.clearance ?? (o.kind==='table'?34:o.kind==='chair'?28:14);
export function legs(o:Obstacle):Solid[] {
  return [-1,1].flatMap(x=>[-1,1].map(y=>({x:o.x+x*(o.radius-3),y:o.y+y*(o.radius*.65-3),radius:2.5})));
}
export function solids(o:Obstacle):Solid[] {
  if(floorItem(o))return [];
  if(furniture(o))return clearance(o)>BODY_HEIGHT?legs(o):[{x:o.x,y:o.y,radius:0,halfLength:o.radius,halfWidth:o.radius*.65}];
  return [{x:o.x,y:o.y,radius:o.radius}];
}
/** Exact circle versus circle / rectangle contact, including rounded corners. */
export function contact(b:Solid,x:number,y:number,r:number):{nx:number;ny:number;depth:number}|null {
  const dx=x-b.x,dy=y-b.y;
  if(b.halfLength!==undefined){
    const hx=b.halfLength,hy=b.halfWidth!;
    const qx=Math.max(-hx,Math.min(hx,dx)),qy=Math.max(-hy,Math.min(hy,dy));
    const vx=dx-qx,vy=dy-qy,d=Math.hypot(vx,vy);
    if(d>=r)return null;
    if(d>1e-9)return {nx:vx/d,ny:vy/d,depth:r-d};
    const ex=hx-Math.abs(dx),ey=hy-Math.abs(dy);
    return ex<ey?{nx:Math.sign(dx)||1,ny:0,depth:r+ex}:{nx:0,ny:Math.sign(dy)||1,depth:r+ey};
  }
  const d=Math.hypot(dx,dy),reach=b.radius+r;
  return d<reach?{nx:d?dx/d:1,ny:d?dy/d:0,depth:reach-d}:null;
}
export function blocked(world:WorldDef,x:number,y:number,padding:number,ignore?:Obstacle):boolean {
  return Math.abs(x)>world.half-padding||Math.abs(y)>world.half-padding||world.obstacles.some(o=>o!==ignore&&solids(o).some(b=>contact(b,x,y,padding)));
}
/** Reproducible indoor clutter; density changes count, with a clear starting area. */
export function generateClutter(seed:number,density=.6,style:'room'|'workshop'|'bedroom'='room'):WorldDef {
  const random=mulberry32(seed*811+19),world:WorldDef={seed,half:460,obstacles:[],patches:[]};
  const kinds:Obstacle['kind'][]=style==='workshop'?['table','block','block','shoe','cable','mat']:style==='bedroom'?['bed','chair','shoe','mat','cable']:['table','chair','block','shoe','cable','mat'];
  const count=Math.round(8+Math.max(0,Math.min(1,density))*32);
  for(let i=0,tries=0;i<count&&tries<count*40;tries++){
    const kind=kinds[i%kinds.length],radius=kind==='table'?45:kind==='bed'?65:kind==='chair'?24:kind==='mat'?22:kind==='cable'?18:kind==='shoe'?10:13;
    const x=(random()*2-1)*360,y=(random()*2-1)*360;
    if(Math.hypot(x,y)<radius+90||world.obstacles.some(o=>Math.hypot(o.x-x,o.y-y)<o.radius+radius+12))continue;
    const height=kind==='cable'?1:kind==='mat'?.5:kind==='shoe'?7:kind==='block'?18:kind==='bed'?24:kind==='chair'?36:40;
    world.obstacles.push({kind,x,y,radius,height,tone:random()});i++;
  }
  return world;
}
