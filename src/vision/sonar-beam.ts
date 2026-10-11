import type {SonarTarget} from './sonar';
import {MOUNT} from './robot';
export type AcousticPoint={x:number;y:number;z:number};
/** Display-only acoustic ray in the same pixel units as sonar targets.
 * Solid occlusion is independent of echo strength: an absorbing/slanted wall
 * can return no echo without allowing a transmitted beam through its body. */
export function acousticRayLimit(origin:AcousticPoint,direction:AcousticPoint,targets:readonly SonarTarget[],reach:number):number{
  let nearest=reach;
  for(const t of targets){
    if(t.z1<1.5)continue;
    let near=0,far=nearest;
    const slab=(p:number,v:number,lo:number,hi:number)=>{
      if(Math.abs(v)<1e-12)return p>=lo-1e-9&&p<=hi+1e-9;
      let a=(lo-p)/v,b=(hi-p)/v;if(a>b)[a,b]=[b,a];near=Math.max(near,a);far=Math.min(far,b);return near<=far+1e-9;
    };
    if(t.kind==='box'){
      const c=Math.cos(t.heading),s=Math.sin(t.heading),x=origin.x-t.x,y=origin.y-t.y;
      if(!slab(x*c+y*s,direction.x*c+direction.y*s,-t.halfLength,t.halfLength)||!slab(-x*s+y*c,-direction.x*s+direction.y*c,-t.halfWidth,t.halfWidth))continue;
    }else{
      const x=origin.x-t.x,y=origin.y-t.y,a=direction.x**2+direction.y**2,b=x*direction.x+y*direction.y,d=x*x+y*y-t.radius*t.radius;
      if(a<1e-12){if(d>0)continue;}else{const disc=b*b-a*d;if(disc<0)continue;const root=Math.sqrt(disc);near=Math.max(near,(-b-root)/a);far=Math.min(far,(-b+root)/a);if(near>far+1e-9)continue;}
    }
    if(!slab(origin.z,direction.z,t.z0,t.z1))continue;
    nearest=Math.max(0,Math.min(nearest,near));
  }
  return nearest;
}
export type AcousticFan={x:number;y:number;heading:number;range:number;beam:number;height?:number;pitch?:number};
/** Approximate horizontal beam footprint, clipped independently along each ray.
 * These points are renderer diagnostics, never measurements or neural inputs. */
export function sonarBeamPoints(p:AcousticFan,targets:readonly SonarTarget[]=[],segments=32):{x:number;y:number}[]{
  const half=p.beam*Math.PI/360,origin={x:p.x,y:p.y,z:p.height??MOUNT.height},dz=-Math.tan((p.pitch??0)*Math.PI/180);
  return Array.from({length:segments+1},(_,i)=>{const a=p.heading-half+2*half*i/segments,direction={x:Math.cos(a),y:Math.sin(a),z:dz},r=acousticRayLimit(origin,direction,targets,p.range);return{x:p.x+direction.x*r,y:p.y+direction.y*r};});
}
