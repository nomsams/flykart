import { validateSonarSurface } from '../sonar-surfaces';
import { WorldDef, KART_RADIUS, surfaceAt, GoalCount, validateGoalCount, validateGoalRadius } from './world';
import { OBJECT_KINDS, blocked, furniture, clearance } from './objects';

export type ArenaFile={format:'flykart-world';version:1;world:WorldDef;start:{x:number;y:number;heading:number};goals?:{x:number;y:number}[];exercise?:{task:'forage'|'reverse'|'explore';searchWin:'sight'|'reach';goalPreset:'standard'|'near'|'far'|'random'|'pair';goalCount?:GoalCount;goalRadius?:number;repeatSearch?:boolean}};
export function validateArena(raw:unknown):ArenaFile{
  const a=raw as ArenaFile;
  const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
  if(!a||a.format!=='flykart-world'||a.version!==1||!a.world||!a.start)throw Error('Expected a FlyKart Open world scene (version 1).');
  const w=a.world;
  if(!finite(w.seed)||!finite(w.half)||w.half<100||w.half>1000||!Array.isArray(w.obstacles)||w.obstacles.length>500||!Array.isArray(w.patches)||w.patches.length>500)throw Error('Invalid world size or item count.');
  const circle=(o:{x:number;y:number;radius:number})=>finite(o.x)&&finite(o.y)&&finite(o.radius)&&o.radius>0&&o.radius<=w.half&&Math.abs(o.x)<=w.half&&Math.abs(o.y)<=w.half;
  if(w.obstacles.some(o=>!o||!circle(o)||!OBJECT_KINDS.includes(o.kind)||!finite(o.height)||o.height<=0||o.height>200||!finite(o.tone)||(o.clearance!==undefined&&(!furniture(o)||!finite(o.clearance)||o.clearance<0||o.clearance>=o.height))||(furniture(o)&&(clearance(o)>=o.height||o.radius<10)))||w.patches.some(p=>!p||!circle(p)||!['water','mud','sand'].includes(p.kind)))throw Error('Invalid world objects.');
  if(!finite(a.start.x)||!finite(a.start.y)||!finite(a.start.heading)||!clearPoint(w,a.start.x,a.start.y,KART_RADIUS))throw Error('Start pose must be on clear ground inside the fence.');
  if(a.goals!==undefined&&(!Array.isArray(a.goals)||!a.goals.length||a.goals.length>30||a.goals.some(g=>!g||!finite(g.x)||!finite(g.y)||!clearPoint(w,g.x,g.y))))throw Error('Saved target points must be on clear ground inside the fence.');
  if(a.exercise&&(!['forage','reverse','explore'].includes(a.exercise.task)||!['sight','reach'].includes(a.exercise.searchWin)||!['standard','near','far','random','pair'].includes(a.exercise.goalPreset)))throw Error('Invalid scene exercise.');
  if(a.exercise){validateGoalCount(a.exercise.goalCount);validateGoalRadius(a.exercise.goalRadius);}
  if(a.exercise?.repeatSearch!==undefined&&typeof a.exercise.repeatSearch!=='boolean')throw Error('Invalid live search continuation setting.');
  w.obstacles.forEach(o=>{if(o.sonarSurface!==undefined)validateSonarSurface(o.sonarSurface);});
  return structuredClone(a);
}
export function clearPoint(w:WorldDef,x:number,y:number,padding=KART_RADIUS+2):boolean{
  return Math.abs(x)<=w.half-padding&&Math.abs(y)<=w.half-padding&&surfaceAt(w,x,y)!=='water'&&!blocked(w,x,y,padding);
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
