import {clamp} from '../core';
import {DEFAULT_ROBOT,Pose,overlaps} from '../robot/model';
import {ParkingScene,actorSolid,bodySolid,parkingQuality} from './model';

export type CoachPose=Pose&{reverse:boolean};
export type CoachPath={poses:CoachPose[];length:number;cost:number;expanded:number;reason:'ready'|'blocked'|'budget'};
const STEP=.075,GRID=.035,TURN=Math.PI/12,MAX_NODES=18000;
const cache=new Map<string,CoachPath>();
/** Bounded weighted hybrid A*: exact differential-drive arcs, forward/reverse and an
 * expensive pivot fallback. Costs prefer shorter, gentle routes with fewer
 * direction changes. A feasible guide, not a guarantee of global optimality.
 * Only the external judge receives this route; it never enters the camera. */
export function planParkingPath(scene:ParkingScene):CoachPath{
  const key=JSON.stringify([scene.start,scene.target,scene.lesson,scene.half,scene.actors.filter(a=>a.parked).map(a=>[a.pose,a.length,a.width])]);
  const saved=cache.get(key);if(saved)return structuredClone(saved);
  const obstacles=scene.actors.filter(a=>a.parked).map(a=>{const solid=actorSolid(a),c=Math.abs(Math.cos(a.pose.heading)),s=Math.abs(Math.sin(a.pose.heading));return {...solid,hx:(a.length*c+a.width*s)/2,hz:(a.length*s+a.width*c)/2};}),precise=!['arrival','exit','switch'].includes(scene.lesson);
  const clear=(p:Pose)=>{const body=bodySolid(p,DEFAULT_ROBOT.length+.008,DEFAULT_ROBOT.width+.008),c=Math.abs(Math.cos(p.heading)),s=Math.abs(Math.sin(p.heading));
    return Math.abs(p.x)+(body.width*c+body.depth*s)/2<scene.half-.0125&&Math.abs(p.z)+(body.width*s+body.depth*c)/2<scene.half-.0125&&!obstacles.some(o=>Math.abs(p.x-o.x)<(body.width*c+body.depth*s)/2+o.hx&&Math.abs(p.z-o.z)<(body.width*s+body.depth*c)/2+o.hz&&overlaps(body,o));};
  type Node={p:Pose;g:number;f:number;parent:Node|null;reverse:boolean;curve:number;segment:CoachPose[]};
  const queue:Node[]=[],best=new Map<string,number>();
  const push=(n:Node)=>{let i=queue.length;queue.push(n);while(i){const p=(i-1)>>1;if(queue[p].f<=n.f)break;queue[i]=queue[p];i=p;}queue[i]=n;};
  const pop=()=>{const first=queue[0],tail=queue.pop()!;if(queue.length){let i=0;while(i*2+1<queue.length){let j=i*2+1;if(j+1<queue.length&&queue[j+1].f<queue[j].f)j++;if(queue[j].f>=tail.f)break;queue[i]=queue[j];i=j;}queue[i]=tail;}return first;};
  const id=(n:Node)=>`${Math.round(n.p.x/GRID)},${Math.round(n.p.z/GRID)},${(Math.round(n.p.heading/TURN)%24+24)%24},${+n.reverse}`;
  const heuristic=(p:Pose)=>1.5*(Math.max(0,Math.hypot(p.x-scene.target.x,p.z-scene.target.z)-.06)+(precise?.09*Math.max(0,Math.abs(Math.atan2(Math.sin(p.heading-scene.target.heading),Math.cos(p.heading-scene.target.heading)))-Math.PI/12):0));
  const start:Node={p:{...scene.start},g:0,f:heuristic(scene.start),parent:null,reverse:false,curve:0,segment:[]};let expanded=0,end:Node|null=null;
  if(clear(start.p)){push(start);best.set(id(start),0);}
  // Minimum arc radius exceeds half the effective track / turn grip: both
  // wheels can turn in the same direction at the configured steering grip.
  const radius=Math.max(.18,(DEFAULT_ROBOT.width-DEFAULT_ROBOT.wheelWidth)/(2*DEFAULT_ROBOT.turnGrip));
  const curves=[0,1/.65,-1/.65,1/.35,-1/.35,1/radius,-1/radius];
  while(queue.length&&expanded<MAX_NODES){const n=pop();if(n.g!==best.get(id(n)))continue;expanded++;const q=parkingQuality(n.p,scene.target);
    if(q.distance<=.06&&(!precise||q.inside&&q.error<Math.PI/12)){end=n;break;}
    for(const direction of [1,-1])for(let kind=0;kind<curves.length+1;kind++){
      const pivot=kind===curves.length,k=curves[kind]??0,reverse=direction<0,segment:CoachPose[]=[];
      // Sample the exact swept chassis every <1 cm and <3 degrees, including pivots.
      for(let j=1;j<=8;j++){const travel=direction*STEP*j/8,angle=pivot?direction*TURN*j/8:travel*k,h=n.p.heading+angle;
        const p:CoachPose=pivot?{...n.p,heading:h,reverse}:{x:n.p.x+(k?(Math.sin(h)-Math.sin(n.p.heading))/k:Math.cos(h)*travel),z:n.p.z+(k?(-Math.cos(h)+Math.cos(n.p.heading))/k:Math.sin(h)*travel),heading:h,reverse};
        if(!clear(p))break;segment.push(p);
      }
      if(segment.length!==8)continue;
      const cost=pivot?TURN*(DEFAULT_ROBOT.width-DEFAULT_ROBOT.wheelWidth)/2/DEFAULT_ROBOT.turnGrip+.035:STEP*(reverse?1.08:1)*(1+.025*Math.abs(k));
      const g=n.g+cost+(n.parent&&reverse!==n.reverse?.09:0)+(n.parent&&kind!==n.curve?.012:0);
      const next:Node={p:segment[7],g,f:0,parent:n,reverse,curve:kind,segment};if(g>=(best.get(id(next))??Infinity))continue;
      best.set(id(next),g);next.f=g+heuristic(next.p);push(next);
    }
  }
  const nodes:Node[]=[],poses:CoachPose[]=[],result:CoachPath={poses,length:0,cost:end?.g??0,expanded,reason:end?'ready':queue.length?'budget':'blocked'};
  for(let n=end;n;n=n.parent)nodes.push(n);nodes.reverse();
  if(nodes.length)poses.push({...scene.start,reverse:false});for(const n of nodes)poses.push(...n.segment);
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
