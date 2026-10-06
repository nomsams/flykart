import {Action,clamp} from '../core';
import {EnergyState} from './homeostasis';
import {Point,polygonsOverlap,rectangle} from './contacts';
import {Pose,RobotConfig,WorldObject,robotContactParts} from './model';
import {SensoryCue,EMPTY_CUE} from './objectives';

export type RobotSupport={recovery:boolean;feeding:boolean;lowCharge:number};
export const DEFAULT_SUPPORT:RobotSupport={recovery:false,feeding:false,lowCharge:.25};
export function validateSupport(raw:unknown=DEFAULT_SUPPORT):RobotSupport {
  const s=raw as RobotSupport;if(!s||typeof s.recovery!=='boolean'||typeof s.feeding!=='boolean'||!Number.isFinite(s.lowCharge)||s.lowCharge<.05||s.lowCharge>.45)throw Error('Invalid recovery / feeding settings.');return {...s};
}
/** Environment lays a trail, using actual contact geometry and conservative
 * turn clearance. The controller receives local concentration samples only. */
export function feedingTrail(start:Pose,dock:WorldObject,objects:WorldObject[],config:RobotConfig):Point[] {
  const stand=config.length/2+dock.width/2+.035,end={x:dock.x-Math.cos(dock.yaw)*stand,z:dock.z-Math.sin(dock.yaw)*stand};
  const parts=objects.flatMap(o=>robotContactParts(o,config));
  const clearance=Math.hypot(config.length,config.width)+.025;
  const bounds=parts.map(part=>({part,minX:Math.min(...part.polygon.map(p=>p.x)),maxX:Math.max(...part.polygon.map(p=>p.x)),minZ:Math.min(...part.polygon.map(p=>p.z)),maxZ:Math.max(...part.polygon.map(p=>p.z))}));
  const clear=(p:Point)=>{if(Math.abs(p.x)>=3.3||Math.abs(p.z)>=3.3)return false;const foot=rectangle({x:p.x,z:p.z,yaw:0,width:clearance,depth:clearance});return !bounds.some(b=>p.x+clearance/2>b.minX&&p.x-clearance/2<b.maxX&&p.z+clearance/2>b.minZ&&p.z-clearance/2<b.maxZ&&polygonsOverlap(foot,b.part.polygon));};
  const segment=(a:Point,b:Point)=>{const n=Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/.04);for(let i=0;i<=n;i++)if(!clear({x:a.x+(b.x-a.x)*i/Math.max(1,n),z:a.z+(b.z-a.z)*i/Math.max(1,n)}))return false;return true;};
  // The final dock approach has a measured orientation, so use its oriented
  // footprint rather than the conservative turning circle.
  const aligned={x:end.x,z:end.z,yaw:dock.yaw,width:config.length+.01,depth:config.width+.01};
  if(parts.some(p=>polygonsOverlap(rectangle(aligned),p.polygon)))throw Error('Charging contact is obstructed; move the pod.');
  const approach={x:end.x-Math.cos(dock.yaw)*.3,z:end.z-Math.sin(dock.yaw)*.3};
  if(!clear(approach))throw Error('Pod needs a clear approach in front.');
  // Check the complete aligned last segment against furniture, not just its endpoint.
  for(let i=0;i<=15;i++){const t=i/15,foot=rectangle({...aligned,x:approach.x+(end.x-approach.x)*t,z:approach.z+(end.z-approach.z)*t});if(parts.some(p=>polygonsOverlap(foot,p.polygon)))throw Error('Pod approach intersects an object.');}
  if(segment(start,approach))return [{x:start.x,z:start.z},approach,end];
  const grid=.16,key=(p:Point)=>`${Math.round(p.x/grid)},${Math.round(p.z/grid)}`,point=(k:string)=>{const [x,z]=k.split(',').map(Number);return{x:x*grid,z:z*grid};};
  const root=key(start),queue=[root],parents=new Map<string,string|null>([[root,null]]);let found:string|null=null;
  for(let i=0;i<queue.length&&i<2200;i++){const k=queue[i],p=point(k);if(Math.hypot(p.x-approach.x,p.z-approach.z)<.24&&segment(p,approach)){found=k;break;}
    for(const [dx,dz]of [[grid,0],[-grid,0],[0,grid],[0,-grid]]){const q={x:p.x+dx,z:p.z+dz},qk=key(q);if(!parents.has(qk)&&segment(i===0?start:p,q)){parents.set(qk,k);queue.push(qk);}}
  }
  if(!found)throw Error('No clear feeding trail; move the robot or pod.');
  const path:Point[]=[];for(let k:string|null=found;k;k=parents.get(k)??null)path.unshift(point(k));path[0]={x:start.x,z:start.z};path.push(approach,end);
  // Simplify only through checked corridors.
  const smooth=[path[0]];for(let i=0;i<path.length-2;){let j=path.length-2;while(j>i+1&&!segment(path[i],path[j]))j--;smooth.push(path[j]);i=j;}smooth.push(end);return smooth;
}
/** A local virtual nose: stronger toward the end of the trail, finite reach.
 * Pose is used by the environment to sample scent, never returned as a goal. */
export function feedingScent(pose:Pose,trail:Point[]):SensoryCue {
  if(trail.length<2)return {...EMPTY_CUE,antennae:[0,0,0]};
  const lengths=trail.slice(1).map((p,i)=>Math.hypot(p.x-trail[i].x,p.z-trail[i].z)),total=lengths.reduce((a,b)=>a+b,0);
  const concentration=(p:Point)=>{let value=0,along=0;for(let i=1;i<trail.length;i++){const a=trail[i-1],b=trail[i],length=lengths[i-1],t=clamp(((p.x-a.x)*(b.x-a.x)+(p.z-a.z)*(b.z-a.z))/Math.max(1e-9,length*length),0,1),d=Math.hypot(p.x-a.x-t*(b.x-a.x),p.z-a.z-t*(b.z-a.z));if(d<.45)value=Math.max(value,Math.exp(-d*d/(2*.1*.1))*(.2+.8*(along+t*length)/Math.max(.001,total)));along+=length;}return value;};
  const centre=concentration(pose);let x=0,z=0,strength=centre;const antennae:number[]=[];
  for(let i=0;i<16;i++){const angle=pose.heading+i*Math.PI/8,c=concentration({x:pose.x+Math.cos(angle)*.09,z:pose.z+Math.sin(angle)*.09});const rise=Math.max(0,c-centre);x+=Math.cos(i*Math.PI/8)*rise;z+=Math.sin(i*Math.PI/8)*rise;strength=Math.max(strength,c);if(i===15||i===0||i===1)antennae.push(c);}
  return{bearing:Math.hypot(x,z)>1e-6?Math.atan2(z,x)/Math.PI:0,strength,antennae:antennae as [number,number,number]};
}
export class FeedingCycle {
  phase:'roam'|'seek'|'dock'|'release'|'unreachable'='roam';trail:Point[]=[];private releaseTime=0;
  reset(){this.phase='roam';this.trail=[];this.releaseTime=0;}
  request(energy:EnergyState,low=.25){energy.injectLow(Math.min(.12,low/2));this.reset();}
  update(energy:EnergyState,low:number,contact:boolean,dt:number):void {
    if(this.phase==='roam'&&energy.energy<=low)this.phase='seek';
    if(this.phase==='seek'&&contact)this.phase='dock';
    if(this.phase==='dock'){
      if(!contact){this.phase='seek';return;}
      if(energy.energy>=energy.settings.sated){this.phase='release';this.releaseTime=0;}
    }
    if(this.phase==='release'){this.releaseTime+=dt;if(this.releaseTime>=1.2){this.phase='roam';this.trail=[];}}
  }
  action(cue:SensoryCue,cm:number|null,visible:boolean,bearing:number):Action|null {
    if(this.phase==='roam')return null;
    if(this.phase==='dock'||this.phase==='unreachable')return {steer:0,throttle:0,brake:1};
    if(this.phase==='release')return {steer:0,throttle:0,reverse:.25,brake:0};
    // A front range alone cannot identify the dock; require its camera cue.
    if(visible&&Math.abs(bearing)<.25&&cm!==null&&cm<=5)return {steer:0,throttle:0,brake:1};
    if(cue.strength<.005)return {steer:.65,throttle:.16,brake:0};
    return{steer:clamp(cue.bearing*3,-1,1),throttle:Math.abs(cue.bearing)>.2?0:.23,brake:0};
  }
}
