import type { Obstacle, WorldDef } from './world';
import { mulberry32 } from '../rng';

export const OBJECT_KINDS = ['tree','rock','block','shoe','cable','mat','table','chair','bed','prop'] as const;
export const BODY_HEIGHT = 6; // 6.6 cm at the robot profile's 1.1 cm / world unit.
/** Anything whose top is below this (about 1.3 cm) is a threshold, a cable or paint: the wheels roll over it. */
export const STEP_OVER = 1.2;
export type Solid = { x:number;y:number;radius:number;halfLength?:number;halfWidth?:number;/** Orientation of a box (radians). Omitted means axis-aligned. */heading?:number };

/**
 * One piece of a compound prop (a sofa foot, a table leg, a branch...). Boxes are oriented
 * rectangles of any heading; cylinders use `halfLength` as their radius. Heights are above the floor.
 * Everything is in world pixels (1 px = 1.1 cm at the robot profile).
 */
export type PropPart = {
  shape:'box'|'cyl';
  x:number;y:number;heading?:number;
  halfLength:number;halfWidth:number;
  z0:number;z1:number;
  color?:[number,number,number];
  /** Fabric / foliage: stops the kart like anything else, but returns a weak echo. */
  sonarSurface?:import('../sonar-surfaces').SonarSurface;
  name?:string;
};

export const furniture = (o:Obstacle):boolean => ['table','chair','bed'].includes(o.kind);
export const floorItem = (o:Obstacle):boolean => o.kind==='cable'||o.kind==='mat';
export const movable = (o:Obstacle):boolean => o.kind==='shoe';
export const clearance = (o:Obstacle):number => o.clearance ?? (o.kind==='table'?34:o.kind==='chair'?28:14);
export function legs(o:Obstacle):Solid[] {
  return [-1,1].flatMap(x=>[-1,1].map(y=>({x:o.x+x*(o.radius-3),y:o.y+y*(o.radius*.65-3),radius:2.5})));
}
/** The footprint of one part, or null when the wheels simply roll over it or it is above the body. */
export function partSolid(p:PropPart):Solid|null {
  if(p.z1<=STEP_OVER||p.z0>=BODY_HEIGHT)return null;
  return p.shape==='cyl'?{x:p.x,y:p.y,radius:p.halfLength}:{x:p.x,y:p.y,radius:0,halfLength:p.halfLength,halfWidth:p.halfWidth,heading:p.heading??0};
}
const partCache=new WeakMap<Obstacle,Solid[]>();
export function solids(o:Obstacle):Solid[] {
  if(o.parts){
    // Compound props never move, so their collision footprints are computed once.
    let cached=partCache.get(o);
    if(!cached){cached=o.parts.flatMap(p=>{const s=partSolid(p);return s?[s]:[];});partCache.set(o,cached);}
    return cached;
  }
  if(floorItem(o))return [];
  if(furniture(o))return clearance(o)>BODY_HEIGHT?legs(o):[{x:o.x,y:o.y,radius:0,halfLength:o.radius,halfWidth:o.radius*.65}];
  return [{x:o.x,y:o.y,radius:o.radius}];
}
/** Exact circle versus circle / (oriented) rectangle contact, including rounded corners. */
export function contact(b:Solid,x:number,y:number,r:number):{nx:number;ny:number;depth:number}|null {
  let dx=x-b.x,dy=y-b.y;
  if(b.halfLength!==undefined){
    const hx=b.halfLength,hy=b.halfWidth!,h=b.heading??0,c=h?Math.cos(h):1,s=h?Math.sin(h):0;
    // Into the box frame (a no-op for the common axis-aligned case).
    if(h){const lx=dx*c+dy*s,ly=-dx*s+dy*c;dx=lx;dy=ly;}
    const qx=Math.max(-hx,Math.min(hx,dx)),qy=Math.max(-hy,Math.min(hy,dy));
    const vx=dx-qx,vy=dy-qy,d=Math.hypot(vx,vy);
    if(d>=r)return null;
    let nx:number,ny:number,depth:number;
    if(d>1e-9){nx=vx/d;ny=vy/d;depth=r-d;}
    else{
      const ex=hx-Math.abs(dx),ey=hy-Math.abs(dy);
      if(ex<ey){nx=Math.sign(dx)||1;ny=0;depth=r+ex;}else{nx=0;ny=Math.sign(dy)||1;depth=r+ey;}
    }
    // Normal back to world axes.
    return h?{nx:nx*c-ny*s,ny:nx*s+ny*c,depth}:{nx,ny,depth};
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
