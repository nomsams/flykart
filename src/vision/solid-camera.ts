import type {CameraConfig,Pose,Rgb,Scene,Sprite} from './camera';

type Box={x:number;y:number;heading:number;length:number;width:number;z0:number;z1:number;color:Rgb};
type RayBox=Box&{c:number;s:number;ox:number;oy:number};
type Projection={f:number;cx:number;cy:number;sinP:number;cosP:number};
/** Actual oriented prisms, independent of WebGL: training and browser inference see the same surfaces. */
export function solidParts(s:Sprite):Box[]{
  if(s.shape==='oriented-box')return [s];
  if(s.shape!=='solid-car')return [];
  const h=s.z1-s.z0;
  return [{...s,z1:s.z0+h*.62},{...s,length:s.length*.5,width:s.width*.82,z0:s.z0+h*.62,color:[.16,.24,.31]}];
}
function intersect(b:RayBox,oz:number,dx:number,dy:number,dz:number):{depth:number;shade:number}|null{
  const along=dx*b.c+dy*b.s,across=-dx*b.s+dy*b.c;
  let near=-Infinity,far=Infinity,nearAxis=0,farAxis=0;
  for(let axis=0;axis<3;axis++){
    const origin=axis===0?b.ox:axis===1?b.oy:oz,direction=axis===0?along:axis===1?across:dz,lo=axis===0?-b.length/2:axis===1?-b.width/2:b.z0,hi=axis===0?b.length/2:axis===1?b.width/2:b.z1;
    if(Math.abs(direction)<1e-9){if(origin<lo||origin>hi)return null;continue;}
    let a=(lo-origin)/direction,z=(hi-origin)/direction;if(a>z){const t=a;a=z;z=t;}
    if(a>near){near=a;nearAxis=axis;}if(z<far){far=z;farAxis=axis;}if(near>far)return null;
  }
  if(far<=.02)return null;
  const axis=near>.02?nearAxis:farAxis,depth=near>.02?near:far;
  return{depth,shade:axis===2?1.12:axis===0?.74:.94};
}
export function drawSolids(scene:Scene,pose:Pose,camera:CameraConfig,p:Projection,out:Float32Array):Float32Array|null{
  const boxes=scene.sprites.flatMap(solidParts).map(b=>{const c=Math.cos(b.heading),s=Math.sin(b.heading),x=pose.x-b.x,y=pose.y-b.y;return{...b,c,s,ox:x*c+y*s,oy:-x*s+y*c};});if(!boxes.length)return null;
  const {width:w,height:h,mountHeight}=camera,n=w*h,depths=new Float32Array(n);depths.fill(Infinity);
  const fx=Math.cos(pose.heading),fy=Math.sin(pose.heading);
  for(let v=0;v<h;v++)for(let u=0;u<w;u++){
    const at=v*w+u;let r=0,g=0,b=0;
    for(let sv=0;sv<2;sv++)for(let su=0;su<2;su++){
      const row=(v+(sv+.5)/2-p.cy)/p.f,right=(u+(su+.5)/2-p.cx)/p.f;
      const forward=p.cosP-row*p.sinP,vertical=-p.sinP-row*p.cosP,dx=fx*forward-fy*right,dy=fy*forward+fx*right;
      let best=vertical<0?-mountHeight/vertical:Infinity,color:Rgb|null=null,shade=1;
      for(const box of boxes){const hit=intersect(box,mountHeight,dx,dy,vertical);if(hit&&hit.depth<best){best=hit.depth;color=box.color;shade=hit.shade;}}
      if(color){depths[at]=Math.min(depths[at],best);const haze=1-Math.exp(-best*Math.hypot(dx,dy)/scene.style.fogDistance);r+=color[0]*shade*(1-haze)+scene.style.fog[0]*haze;g+=color[1]*shade*(1-haze)+scene.style.fog[1]*haze;b+=color[2]*shade*(1-haze)+scene.style.fog[2]*haze;}
      else{r+=out[at];g+=out[n+at];b+=out[2*n+at];}
    }
    out[at]=r/4;out[n+at]=g/4;out[2*n+at]=b/4;
  }
  return depths;
}
