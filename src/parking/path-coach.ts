import {clamp,wrapAngle} from '../core';
import {DEFAULT_ROBOT,Pose,overlaps} from '../robot/model';
import {ParkingScene,actorSolid,bodySolid,parkingQuality} from './model';

export type CoachPose=Pose&{reverse:boolean};
export type CoachPath={poses:CoachPose[];length:number;cost:number;expanded:number;reason:'ready'|'blocked'|'budget'};
const STEP=.06,TURN=Math.PI/4,MAX_NODES=24000;
const cache=new Map<string,CoachPath>();
/** External teacher only. Shortest wheel-travel cost on a 6 cm / 45° lattice,
 * with forward, reverse and in-place turns. Static parked cars only; no claim
 * of a continuous optimal trajectory or a plan through moving traffic. */
export function planParkingPath(scene:ParkingScene):CoachPath{
  const key=JSON.stringify([scene.start,scene.target,scene.lesson,scene.half,scene.actors.filter(a=>a.parked).map(a=>[a.pose,a.length,a.width])]);
  const saved=cache.get(key);if(saved)return structuredClone(saved);
  const obstacles=scene.actors.filter(a=>a.parked).map(actorSolid),precise=!['arrival','exit','switch'].includes(scene.lesson);
  const clear=(p:Pose)=>{const body=bodySolid(p,DEFAULT_ROBOT.length+.008,DEFAULT_ROBOT.width+.008),c=Math.abs(Math.cos(p.heading)),s=Math.abs(Math.sin(p.heading));
    return Math.abs(p.x)+(body.width*c+body.depth*s)/2<scene.half-.0125&&Math.abs(p.z)+(body.width*s+body.depth*c)/2<scene.half-.0125&&!obstacles.some(o=>overlaps(body,o));};
  const sweep=(a:Pose,b:Pose)=>{const angle=wrapAngle(b.heading-a.heading);for(let i=0;i<=6;i++){const f=i/6;if(!clear({x:a.x+(b.x-a.x)*f,z:a.z+(b.z-a.z)*f,heading:a.heading+angle*f}))return false;}return true;};
  type Node={x:number;z:number;h:number;g:number;f:number;parent:Node|null;reverse:boolean};
  const queue:Node[]=[],best=new Map<string,number>(),pose=(n:Node):Pose=>({x:scene.start.x+n.x*STEP,z:scene.start.z+n.z*STEP,heading:n.h*TURN});
  const push=(n:Node)=>{let i=queue.length;queue.push(n);while(i){const p=(i-1)>>1;if(queue[p].f<=n.f)break;queue[i]=queue[p];i=p;}queue[i]=n;};
  const pop=()=>{const first=queue[0],tail=queue.pop()!;if(queue.length){let i=0;while(i*2+1<queue.length){let j=i*2+1;if(j+1<queue.length&&queue[j+1].f<queue[j].f)j++;if(queue[j].f>=tail.f)break;queue[i]=queue[j];i=j;}queue[i]=tail;}return first;};
  const id=(n:Node)=>`${n.x},${n.z},${n.h}`,distance=(p:Pose)=>Math.hypot(p.x-scene.target.x,p.z-scene.target.z);
  const h=(Math.round(scene.start.heading/TURN)%8+8)%8,start:Node={x:0,z:0,h,g:0,f:0,parent:null,reverse:false};
  const initial=pose(start);let expanded=0,end:Node|null=null;
  if(sweep(scene.start,initial)){start.g=Math.abs(wrapAngle(initial.heading-scene.start.heading))*DEFAULT_ROBOT.width/2;start.f=start.g+Math.max(0,distance(initial)-.075);push(start);best.set(id(start),start.g);}
  while(queue.length&&expanded<MAX_NODES){const n=pop();if(n.g!==best.get(id(n)))continue;expanded++;const p=pose(n),q=parkingQuality(p,scene.target);
    if(q.distance<.075&&(!precise||q.inside&&q.error<Math.PI/12)){end=n;break;}
    for(const mode of [-2,-1,1,2]){const turn=Math.abs(mode)===2,next:Node={x:n.x,z:n.z,h:n.h,g:0,f:0,parent:n,reverse:mode===-1};
      if(turn)next.h=(n.h+(mode>0?1:7))%8;else{next.x+=Math.round(Math.cos(p.heading))*mode;next.z+=Math.round(Math.sin(p.heading))*mode;}
      const to=pose(next),cost=turn?TURN*DEFAULT_ROBOT.width/2:Math.hypot(to.x-p.x,to.z-p.z);next.g=n.g+cost;
      if(next.g>=(best.get(id(next))??Infinity)||!sweep(p,to))continue;
      best.set(id(next),next.g);next.f=next.g+Math.max(0,distance(to)-.075);push(next);
    }
  }
  const poses:CoachPose[]=[],result:CoachPath={poses,length:0,cost:end?.g??0,expanded,reason:end?'ready':queue.length?'budget':'blocked'};
  for(let n=end;n;n=n.parent)poses.push({...pose(n),reverse:n.reverse});poses.reverse();
  if(poses.length)poses.unshift({...scene.start,reverse:false});
  for(let i=1;i<poses.length;i++)result.length+=Math.hypot(poses[i].x-poses[i-1].x,poses[i].z-poses[i-1].z);
  if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,structuredClone(result));return result;
}
/** Distance along the closest segment; no route is supplied to the neural driver. */
export function pathPosition(path:CoachPath,p:Pose){let along=0,best=Infinity,progress=0;
  for(let i=1;i<path.poses.length;i++){const a=path.poses[i-1],b=path.poses[i],dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz);if(l<1e-8)continue;
    const t=clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/(l*l),0,1),d=Math.hypot(p.x-a.x-dx*t,p.z-a.z-dz*t);if(d<best){best=d;progress=along+t*l;}along+=l;
  }
  if(!Number.isFinite(best)&&path.poses.length)best=Math.hypot(p.x-path.poses[0].x,p.z-path.poses[0].z);
  return {distance:best,progress,remaining:Math.max(0,path.length-progress)};
}
