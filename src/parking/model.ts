import {clamp,wrapAngle} from '../core';
import {DEFAULT_ROBOT,Pose,WorldObject,overlaps,RobotConfig} from '../robot/model';
import {mulberry32} from '../vision/rng';

export const LESSONS=[
  {id:'arrival',title:'01 · Find a bay',detail:'Reach the yellow area between two blocks. Small overshoot is allowed; heading is ignored.'},
  {id:'exit',title:'02 · Leave a parked bay',detail:'Start nose-in. Reverse into the aisle and reach the clear pink flag.'},
  {id:'switch',title:'03 · Switch bays',detail:'Leave one vacant bay and park in a different vacant bay. Occupied bays are never goals.'},
  {id:'oriented',title:'04 · Park with direction',detail:'Fit the entire chassis in the square, face the cyan end from the orange end, and stop for one second.'},
  {id:'parallel',title:'05 · Parallel parking',detail:'Park between five occupied blocks along a kerb. Match their direction and stop inside the bay.'},
  {id:'traffic',title:'06 · Share the parking lot',detail:'Switch bays around following traffic and pedestrians. Traffic yields to nearby parking manoeuvres.'},
] as const;
export type Lesson=typeof LESSONS[number]['id'];
export type ParkingSettings={lesson:Lesson;cue:'compass'|'visual';phase:'shaped'|'sparse'|'frozen';seed:number;maxTicks:number;crashWeight:number;traffic:number;pedestrians:number;cars:boolean;shapeJitter:boolean;remember:boolean};
export const DEFAULT_PARKING:ParkingSettings={lesson:'arrival',cue:'visual',phase:'shaped',seed:1701,maxTicks:900,crashWeight:.2,traffic:3,pedestrians:2,cars:false,shapeJitter:false,remember:false};
export function validateParkingSettings(raw:unknown):ParkingSettings{
  const s=raw as ParkingSettings;
  if(!s||!LESSONS.some(l=>l.id===s.lesson)||!['compass','visual'].includes(s.cue)||!['shaped','sparse','frozen'].includes(s.phase)||!Number.isInteger(s.seed)||s.seed<1||s.seed>999999999||!Number.isInteger(s.maxTicks)||s.maxTicks<60||s.maxTicks>5400||!Number.isFinite(s.crashWeight)||s.crashWeight<0||s.crashWeight>1||!Number.isInteger(s.traffic)||s.traffic<0||s.traffic>8||!Number.isInteger(s.pedestrians)||s.pedestrians<0||s.pedestrians>8||['cars','shapeJitter','remember'].some(k=>typeof s[k as keyof ParkingSettings]!=='boolean'))throw Error('Invalid parking lesson settings.');
  return {...s};
}
export type Bay={id:string;x:number;z:number;heading:number;length:number;width:number;occupied:boolean};
export type Actor={id:string;kind:'vehicle'|'pedestrian';pose:Pose;length:number;width:number;height:number;speed:number;parked:boolean;route:{x:number;z:number}[];waypoint:number;waitTicks:number;visits?:string;yielding?:string};
export type ParkingScene={format:'flykart-parking-scene';version:1;seed:number;half:number;lesson:Lesson;start:Pose;target:Bay;bays:Bay[];actors:Actor[]};
export function generateParking(s:ParkingSettings):ParkingScene{
  validateParkingSettings(s);const random=mulberry32(s.seed),bays:Bay[]=[],actors:Actor[]=[];
  const parallel=s.lesson==='parallel',count=parallel?6:8,targetIndex=parallel?1+Math.floor(random()*4):s.lesson==='arrival'?1+Math.floor(random()*6):Math.floor(random()*8),startIndex=(targetIndex+2+Math.floor(random()*4))%8;
  const parked=(bay:Bay)=>{const scale=s.shapeJitter ? .96+random()*.08 : 1;actors.push({id:'car-'+bay.id,kind:'vehicle',pose:{x:bay.x,z:bay.z,heading:parallel?0:-Math.PI/2},length:.26*scale,width:.17*scale,height:.11,speed:0,parked:true,route:[],waypoint:0,waitTicks:0});};
  for(let i=0;i<count;i++){
    const bay:Bay={id:'bay-'+i,x:(i-(count-1)/2)*(parallel ? .48 : .44),z:-.8,heading:parallel?0:-Math.PI/2,length:parallel ? .44 : .52,width:.36,occupied:i!==targetIndex&&!(s.lesson!=='arrival'&&!parallel&&i===startIndex)};
    if(s.lesson==='arrival')bay.occupied=i===targetIndex-1||i===targetIndex+1||targetIndex===0&&i===2||targetIndex===7&&i===5;
    bays.push(bay);if(bay.occupied)parked(bay);
  }
  const target={...bays[targetIndex]};if(['oriented','traffic'].includes(s.lesson))target.heading=random()<.5?-Math.PI/2:Math.PI/2;
  let start:Pose={x:target.x+(random()-.5)*.8,z:.45+random()*.25,heading:-Math.PI/2+(random()-.5)*.8};
  if(['switch','oriented','traffic','exit'].includes(s.lesson))start={x:bays[startIndex].x,z:bays[startIndex].z,heading:-Math.PI/2};
  if(parallel)start={x:-1.2,z:-.1,heading:0};
  if(s.lesson==='exit')Object.assign(target,{id:'aisle-exit',x:start.x+(random()-.5)*.5,z:.35,heading:Math.PI/2,length:.6,width:.6,occupied:false});
  if(s.lesson==='traffic'){
    // A single clockwise lane, ordered headway, pedestrian priority and manoeuvre yielding.
    const route=[{x:-2.2,z:.25},{x:2.2,z:.25},{x:2.2,z:1.45},{x:-2.2,z:1.45}];
    for(let i=0;i<s.traffic;i++)actors.push({id:'traffic-'+i,kind:'vehicle',pose:{x:-2+i*.48,z:1.45,heading:Math.PI},length:.26,width:.17,height:.11,speed:0,parked:false,route:structuredClone(route),waypoint:3,waitTicks:0});
    for(let i=0;i<s.pedestrians;i++){
      const car=actors.filter(a=>a.parked)[i%actors.filter(a=>a.parked).length];
      const x=car?.pose.x??(-1+i*.3),storeZ=-1.6-Math.floor(i/6)*.16,route=[{x,z:storeZ},{x:x+.21,z:-1.2},{x:x+.21,z:-.8}];
      actors.push({id:'walker-'+i,kind:'pedestrian',pose:{x,z:storeZ,heading:Math.PI/2},length:.065,width:.065,height:.3,speed:0,parked:false,route,waypoint:1,waitTicks:45*i,visits:car?.id});
    }
  }
  return{format:'flykart-parking-scene',version:1,seed:s.seed,half:3,lesson:s.lesson,start,target,bays,actors};
}
export function validateParkingScene(raw:unknown):ParkingScene{
  const a=raw as ParkingScene,finite=(n:unknown)=>typeof n==='number'&&Number.isFinite(n),pose=(p:Pose)=>p&&[p.x,p.z,p.heading].every(finite)&&Math.abs(p.x)<3&&Math.abs(p.z)<3&&Math.abs(p.heading)<=Math.PI*100;
  const bay=(b:Bay)=>b&&typeof b.id==='string'&&b.id.length>0&&b.id.length<100&&pose({...b,heading:b.heading})&&[b.length,b.width].every(n=>finite(n)&&n>=.3&&n<=1)&&typeof b.occupied==='boolean';
  if(!a||a.format!=='flykart-parking-scene'||a.version!==1||!Number.isInteger(a.seed)||a.seed<1||a.seed>999999999||a.half!==3||!LESSONS.some(l=>l.id===a.lesson)||!pose(a.start)||!bay(a.target)||a.target.occupied||!Array.isArray(a.bays)||a.bays.length>30||!a.bays.every(bay)||!Array.isArray(a.actors)||a.actors.length>40||a.actors.some(v=>!v||typeof v.id!=='string'||!v.id||v.id==='@robot'||v.id.length>100||!['vehicle','pedestrian'].includes(v.kind)||!pose(v.pose)||![v.length,v.width,v.height].every(n=>finite(n)&&n>=.03&&n<=.6)||!finite(v.speed)||Math.abs(v.speed)>.4||typeof v.parked!=='boolean'||!Array.isArray(v.route)||v.route.length>20||v.route.some(p=>!p||![p.x,p.z].every(finite)||Math.abs(p.x)>2.8||Math.abs(p.z)>2.8)||!Number.isInteger(v.waypoint)||v.waypoint<0||v.waypoint>=Math.max(1,v.route.length)||!Number.isInteger(v.waitTicks)||v.waitTicks<0||v.waitTicks>10000||v.visits!==undefined&&typeof v.visits!=='string'))throw Error('Invalid parking scene; keep poses, bays and routes inside the lot.');
  if(new Set(a.bays.map(v=>v.id)).size!==a.bays.length)throw Error('Duplicate parking bay identifiers.');
  if(a.target.id!=='aisle-exit'&&!a.bays.some(b=>b.id===a.target.id&&!b.occupied&&b.x===a.target.x&&b.z===a.target.z))throw Error('The target must be a vacant bay.');
  if(new Set(a.actors.map(v=>v.id)).size!==a.actors.length||a.actors.some(v=>overlaps(bodySolid(a.start,DEFAULT_ROBOT.length,DEFAULT_ROBOT.width),actorSolid(v))))throw Error('Parking scene starts inside an object.');
  return structuredClone(a);
}
export function bodySolid(p:Pose,length:number,width:number){return{x:p.x,z:p.z,yaw:p.heading,width:length,depth:width,bottom:0,top:.11};}
export function actorSolid(a:Actor){return bodySolid(a.pose,a.length,a.width);}
export function actorObject(a:Actor):WorldObject{return{id:a.id,kind:'block',x:a.pose.x,z:a.pose.z,yaw:a.pose.heading,width:a.length,depth:a.width,height:a.height};}
export function parkingQuality(p:Pose,b:Bay,c:RobotConfig=DEFAULT_ROBOT){
  const dx=p.x-b.x,dz=p.z-b.z,x=dx*Math.cos(b.heading)+dz*Math.sin(b.heading),z=-dx*Math.sin(b.heading)+dz*Math.cos(b.heading),error=Math.abs(wrapAngle(p.heading-b.heading));
  const hl=(Math.abs(Math.cos(error))*c.length+Math.abs(Math.sin(error))*c.width)/2,hw=(Math.abs(Math.sin(error))*c.length+Math.abs(Math.cos(error))*c.width)/2;
  const inside=Math.abs(x)+hl<=b.length/2&&Math.abs(z)+hw<=b.width/2;
  const centring=clamp(1-Math.hypot(x/(b.length/2),z/(b.width/2)),0,1),alignment=(1+Math.cos(error))/2;
  return{inside,error,centring,alignment,quality:centring*.6+alignment*.4,distance:Math.hypot(dx,dz)};
}
