import {Action,clamp,wrapAngle} from '../core';
import {DEFAULT_ROBOT,RobotPhysics,overlaps} from '../robot/model';
import {DEFAULT_ADAPTER,motorRequests} from '../robot/controls';
import {CameraConfig,DEFAULT_STYLE,frameLength,renderFrame,Rgb,Scene,Sprite,groundDistanceAtRow} from '../vision/camera';
import {VisionEpisode} from '../vision/domain';
import {mulberry32} from '../vision/rng';
import {CM_PER_PIXEL,HC_SR04,SONAR_USEFUL_RANGE_PX} from '../vision/robot';
import {Sonar,sonarInputs,SonarTarget} from '../vision/sonar';
import {FlagDiscovery} from '../vision/world/discovery';
import {parkingFloorColour,type ParkingFloor} from './floor';
import {PARKING_FLAG,ParkingSettings,ParkingScene,actorObject,actorSolid,bodySolid,parkingQuality,generateParking,validateParkingScene} from './model';

export const PX=100/CM_PER_PIXEL;
/** Keep the imported kart's steering convention when backing: right input turns the nose left. */
export function parkingMotorRequests(action:Action){const drive=action.throttle-(action.reverse??0);return motorRequests({...action,steer:action.steer*(drive<0?-1:1)},DEFAULT_ADAPTER);}
export type ParkingResult={seed:number;lesson:string;success:boolean;quality:number;offsetCm:number;angleDeg:number;ticks:number;contacts:number;pedestrianHits:number;pain:number;reward:number;pendingReward:number;score:number};
export type ImpactEffect={x:number;z:number;kind:'blood'|'explosion'|'smoke';tick:number};

/** Camera geometry sees exactly the same actor footprints as contact and sonar. */
export class ParkingCameraScene implements Scene{
  readonly style={...DEFAULT_STYLE,noise:.006,fogDistance:900};sprites:Sprite[]=[];
  constructor(readonly scene:ParkingScene,readonly cars=false,readonly floor:ParkingFloor='transfer'){}
  prepare():void{
    this.sprites=this.scene.actors.map(a=>({x:a.pose.x*PX,y:a.pose.z*PX,heading:a.pose.heading,width:a.width*PX,length:a.length*PX,z0:0,z1:a.height*PX,color:a.kind==='pedestrian'?[.72,.55,.3] as Rgb:[.35,.47,.6] as Rgb,shape:a.kind==='pedestrian'?'post':this.cars?'solid-car':'oriented-box'}));
    const b=this.scene.target;this.sprites.push({x:b.x*PX,y:b.z*PX,heading:0,width:PARKING_FLAG.width*PX,length:PARKING_FLAG.width*PX,z0:0,z1:PARKING_FLAG.height*PX,color:[1,.2,.62],shape:'flag'});
    const h=this.scene.half*PX;
    for(const [x,y,heading] of [[0,-h,0],[0,h,0],[-h,0,Math.PI/2],[h,0,Math.PI/2]])this.sprites.push({x,y,heading,width:.025*PX,length:h*2,z0:0,z1:.2*PX,color:[.7,.7,.66],shape:'oriented-box'});
  }
  ground(px:number,py:number,out:Rgb):void{
    const x=px/PX,z=py/PX,b=this.scene.target;let color:Rgb=parkingFloorColour(this.floor,px,py);
    for(const bay of this.scene.bays){const dx=x-bay.x,dz=z-bay.z,along=dx*Math.cos(bay.heading)+dz*Math.sin(bay.heading),across=-dx*Math.sin(bay.heading)+dz*Math.cos(bay.heading);
      if(Math.abs(along)<bay.length/2+.012&&Math.abs(across)<bay.width/2+.012&&(Math.abs(Math.abs(along)-bay.length/2)<.012||Math.abs(Math.abs(across)-bay.width/2)<.012))color=[.8,.83,.82];}
    const dx=x-b.x,dz=z-b.z,along=dx*Math.cos(b.heading)+dz*Math.sin(b.heading),across=-dx*Math.sin(b.heading)+dz*Math.cos(b.heading);
    if(Math.hypot(dx,dz)<.23&&Math.hypot(dx,dz)>.205)color=[1,.84,.2];
    if(Math.abs(along)<b.length/2+.016&&Math.abs(across)<b.width/2+.016&&(Math.abs(Math.abs(along)-b.length/2)<.016||Math.abs(Math.abs(across)-b.width/2)<.016))color=[1,.84,.2];
    // Cyan nose and orange tail are painted on the ground, so the camera must see them.
    if(Math.abs(across)<.1&&Math.abs(along-.14)<.075)color=[.05,.95,1];
    if(Math.abs(across)<.1&&Math.abs(along+.14)<.075)color=[1,.38,.04];
    out[0]=color[0];out[1]=color[1];out[2]=color[2];
  }
}

/** Pixel-only marker pose. No hidden robot/goal coordinates or orientation enter this detector. */
export class ParkingCue extends FlagDiscovery{
  alignment=0;confidence=0;
  constructor(readonly camera:CameraConfig){super(camera.width,camera.height,camera.hfov);}
  override reset():void{super.reset();this.alignment=0;this.confidence=0;}
  override observe(pixels:Float32Array,tick:number):void{
    super.observe(pixels,tick);const {width:w,height:h,hfov}=this.camera,n=w*h,f=w/(2*Math.tan(hfov/2)),points:number[][]=[[],[]];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x,r=pixels[i],g=pixels[n+i],b=pixels[2*n+i],kind=g>.45&&b>.5&&r<.3&&r<g*.65?0:r>.55&&g>.12&&g<r*.68&&b<g*.65?1:-1;
      if(kind<0)continue;const forward=groundDistanceAtRow(this.camera,y);if(forward<=0||forward>PX*4)continue;
      const row=(y+.5-h/2)/f,down=Math.sin(this.camera.pitch)+row*Math.cos(this.camera.pitch),lateral=this.camera.mountHeight/down*(x+.5-w/2)/f;
      points[kind].push(forward,lateral);
    }
    this.confidence=0;this.alignment=0;
    if(points.every(p=>p.length>=4)){
      const mean=(p:number[],offset:number)=>p.filter((_,i)=>i%2===offset).reduce((a,b)=>a+b,0)/(p.length/2),forward=mean(points[0],0)-mean(points[1],0),right=mean(points[0],1)-mean(points[1],1);
      if(Math.hypot(forward,right)>2){this.alignment=Math.atan2(right,forward)/Math.PI;this.confidence=1;}
    }
  }
  override cue():number[]{return [...super.cue(),this.alignment,this.confidence];}
}

export class ParkingEpisode implements VisionEpisode{
  readonly scene:ParkingScene;readonly physics=new RobotPhysics({...DEFAULT_ROBOT});readonly frame:Float32Array;readonly sonarUnit:Sonar;
  readonly cameraScene:ParkingCameraScene;readonly effects:ImpactEffect[]=[];readonly trail:{x:number;z:number}[]=[];
  readonly status={ticks:0,contacts:0,pedestrianHits:0,pain:0,reward:0,pendingReward:0,score:0,success:false,hold:0};
  private lastCommand:Action={steer:0,throttle:0,brake:0,reverse:0};private lastContact=-Infinity;private potential=0;private cooldown=new Map<string,number>();
  constructor(readonly settings:ParkingSettings,readonly camera:CameraConfig,scene?:ParkingScene){
    this.scene=scene?validateParkingScene(scene):generateParking(settings);this.physics.pose={...this.scene.start};this.physics.odometry={...this.scene.start};this.frame=new Float32Array(frameLength(camera));this.cameraScene=new ParkingCameraScene(this.scene,settings.cars,settings.floor);
    this.sonarUnit=new Sonar({...HC_SR04,lobeSigmaDeg:12,mountForward:DEFAULT_ROBOT.length*.48*PX},mulberry32(settings.seed*31));this.potential=this.progressPotential();this.ping();this.render();
  }
  get tick(){return this.status.ticks;}get done(){return this.status.success||this.status.pedestrianHits>0||this.tick>=this.settings.maxTicks;}
  get controlsReleased(){return [this.lastCommand.steer,this.lastCommand.throttle,this.lastCommand.brake,this.lastCommand.reverse??0].every(v=>Math.abs(v)<=.03);}
  get parkedInTarget(){const q=this.judgedQuality();return ['arrival','exit','switch'].includes(this.settings.lesson)?q.distance<.27:q.inside&&q.error<Math.PI/12;}
  get requiredHold(){return 30+(this.settings.delayReward?Math.ceil(this.settings.rewardDelaySeconds*30):0);}
  get pose(){const p=this.physics.pose;return{x:p.x*PX,y:p.z*PX,heading:p.heading};}
  private targets():SonarTarget[]{const h=this.scene.half*PX;return[...this.scene.actors.map(a=>a.kind==='pedestrian'?{kind:'circle' as const,x:a.pose.x*PX,y:a.pose.z*PX,radius:a.width*PX/2,z0:0,z1:a.height*PX}:{kind:'box' as const,x:a.pose.x*PX,y:a.pose.z*PX,heading:a.pose.heading,halfLength:a.length*PX/2,halfWidth:a.width*PX/2,z0:0,z1:a.height*PX}),...[-1,1].flatMap(sign=>[{kind:'box' as const,x:0,y:sign*h,heading:0,halfLength:h,halfWidth:.0125*PX,z0:0,z1:.2*PX},{kind:'box' as const,x:sign*h,y:0,heading:Math.PI/2,halfLength:h,halfWidth:.0125*PX,z0:0,z1:.2*PX}])];}
  private ping(){this.sonarUnit.update(this.tick,this.pose,this.targets());}sonar(){return this.sonarUnit.reading;}
  render(){return renderFrame(this.cameraScene,this.pose,this.camera,this.frame,mulberry32(this.settings.seed+this.tick*17));}
  proprioception(){const a=this.lastCommand,pair=this.settings.sonarOn?sonarInputs(this.sonar(),SONAR_USEFUL_RANGE_PX):[0,0];return{speed:clamp((this.physics.left+this.physics.right)/2*PX/90,-1,1),lastSteer:a.steer,lastDrive:clamp(a.throttle-a.brake,-1,1),sonarCloseness:pair[0],sonarStrength:pair[1]};}
  truth(out:number[]=new Array(10).fill(0)){out.fill(0);return out;} // Camera controller must never call privileged clearance.
  mission(){if(this.settings.cue!=='compass')throw Error('Visual parking cannot query the goal compass.');const p=this.physics.pose,b=this.scene.target;return[wrapAngle(Math.atan2(b.z-p.z,b.x-p.x)-p.heading)/Math.PI,clamp(1-Math.hypot(b.x-p.x,b.z-p.z)/2.2,0,1),wrapAngle(b.heading-p.heading)/Math.PI,1];}
  lapContext(){return null;}summary(){return{progress:this.status.success?1:0,finished:this.status.success,crashed:this.status.pedestrianHits>0};}
  private judgedQuality(){const q=parkingQuality(this.physics.pose,this.scene.target);return {...q,quality:['arrival','exit','switch'].includes(this.settings.lesson)?q.centring:q.quality};}
  private progressPotential(){const q=this.judgedQuality();return 15*Math.exp(-q.distance)+10*q.quality;}
  private traffic(){
    const ego=this.physics.pose,old=structuredClone(this.scene.actors),dt=1/30;
    for(const a of this.scene.actors){a.yielding=undefined;if(a.waitTicks>0){a.waitTicks--;a.speed=0;continue;}if(a.parked||!a.route.length){a.speed=0;continue;}
      const dest=a.route[a.waypoint],distance=Math.hypot(dest.x-a.pose.x,dest.z-a.pose.z);
      if(distance<.06){a.waypoint=(a.waypoint+1)%a.route.length;
        if(a.kind==='pedestrian'&&a.waypoint===0&&a.visits){const car=this.scene.actors.find(c=>c.id===a.visits);if(car?.parked){car.parked=false;car.waitTicks=90;car.route=[{x:car.pose.x,z:.25},{x:2.2,z:.25},{x:2.2,z:1.45},{x:-2.2,z:1.45},{x:-2.2,z:.25}];car.waypoint=0;}a.waitTicks=180;}
        continue;
      }
      const bearing=Math.atan2(dest.z-a.pose.z,dest.x-a.pose.x);a.pose.heading=wrapAngle(a.pose.heading+clamp(wrapAngle(bearing-a.pose.heading),-1.5*dt,1.5*dt));
      const ahead=(p:{x:number;z:number},margin:number)=>{const dx=p.x-a.pose.x,dz=p.z-a.pose.z;return dx*Math.cos(a.pose.heading)+dz*Math.sin(a.pose.heading)>-.02&&Math.hypot(dx,dz)<margin;};
      const manoeuvring=Math.hypot(ego.x-this.scene.target.x,ego.z-this.scene.target.z)<.85||Math.hypot(ego.x-this.scene.start.x,ego.z-this.scene.start.z)<.5&&ego.z<-.3;
      if(a.kind==='vehicle'&&(ahead(ego,.65)||manoeuvring&&Math.hypot(ego.x-a.pose.x,ego.z-a.pose.z)<1)){a.yielding='Parking manoeuvre';a.speed=0;continue;}
      if(a.kind==='vehicle'&&old.some(o=>o.id!==a.id&&!o.parked&&ahead(o.pose,o.kind==='pedestrian'?.55:.43))){a.yielding='Headway / pedestrian priority';a.speed=0;continue;}
      const desired=a.kind==='pedestrian'?.075:.16;a.speed=Math.min(desired,a.speed+.2*dt);const next={...a.pose,x:a.pose.x+Math.cos(a.pose.heading)*a.speed*dt,z:a.pose.z+Math.sin(a.pose.heading)*a.speed*dt};
      if(overlaps(bodySolid(next,a.length+.025,a.width+.025),bodySolid(ego,DEFAULT_ROBOT.length,DEFAULT_ROBOT.width))||old.some(o=>o.id!==a.id&&overlaps(bodySolid(next,a.length+.025,a.width+.025),actorSolid(o)))){a.yielding='Occupied path';a.speed=0;continue;}a.pose=next;
    }
  }
  step(action:Action){
    if(this.done)return;const before={...this.physics.pose},incoming=this.physics.speed,pwm=parkingMotorRequests(action);this.lastCommand={...action};this.traffic();
    const boundary=[-1,1].flatMap(sign=>[{id:'edge-x'+sign,kind:'wall' as const,x:sign*3,z:0,yaw:Math.PI/2,width:6,depth:.025,height:.2},{id:'edge-z'+sign,kind:'wall' as const,x:0,z:sign*3,yaw:0,width:6,depth:.025,height:.2}]);
    this.physics.step(pwm.left/255,pwm.right/255,[...this.scene.actors.map(actorObject),...boundary],1/30);
    const body=bodySolid(this.physics.pose,DEFAULT_ROBOT.length,DEFAULT_ROBOT.width),hit=this.scene.actors.find(a=>overlaps(body,actorSolid(a)))??this.scene.actors.find(a=>a.id===this.physics.contact?.objectId);
    if(this.physics.blocked||hit){
      this.lastContact=this.tick;const id=hit?.id??'boundary';if((this.cooldown.get(id)??-100)<this.tick-15){
        this.cooldown.set(id,this.tick);const normal=hit?Math.atan2(hit.pose.z-before.z,hit.pose.x-before.x):before.heading,relative=Math.abs(incoming*Math.cos(before.heading-normal)-(hit?.speed??0)*Math.cos((hit?.pose.heading??0)-normal));
        const pain=.1+Math.pow(relative/.3,2)*(hit?.kind==='pedestrian'?10:1);this.status.contacts++;this.status.pain+=pain;if(hit?.kind==='pedestrian')this.status.pedestrianHits++;
        this.effects.push({x:before.x,z:before.z,kind:hit?.kind==='pedestrian'?'blood':relative>.25?'explosion':'smoke',tick:this.tick});
      }
    }
    this.status.ticks++;this.ping();const q=this.judgedQuality(),loose=['arrival','exit','switch'].includes(this.settings.lesson),fits=loose?q.distance<.27:q.inside&&q.error<Math.PI/12;
    this.status.hold=fits&&Math.abs(this.physics.speed)<.035&&this.tick-this.lastContact>15&&(!this.settings.delayReward||this.controlsReleased)?this.status.hold+1:0;
    this.status.success=this.status.hold>=this.requiredHold&&this.status.pedestrianHits===0;
    const nextPotential=this.progressPotential();if(this.settings.phase==='shaped'){if(this.settings.delayReward)this.status.pendingReward+=nextPotential-this.potential;else this.status.reward+=nextPotential-this.potential;}this.potential=nextPotential;
    if(this.status.success&&this.settings.phase!=='frozen'){this.status.reward+=100+40*q.quality+this.status.pendingReward;this.status.pendingReward=0;}
    if(!this.status.success&&(this.tick>=this.settings.maxTicks||this.status.pedestrianHits>0))this.status.pendingReward=0;
    this.status.score=this.status.reward-this.tick/30*.2-this.status.pain*(4+this.settings.crashWeight*60)-this.status.pedestrianHits*1000;
    if(!this.trail.length||Math.hypot(this.physics.pose.x-this.trail.at(-1)!.x,this.physics.pose.z-this.trail.at(-1)!.z)>.025){this.trail.push({x:this.physics.pose.x,z:this.physics.pose.z});if(this.trail.length>1800)this.trail.shift();}
    while(this.effects.length&&this.tick-this.effects[0].tick>90)this.effects.shift();
  }
  result():ParkingResult{const q=this.judgedQuality();return{seed:this.settings.seed,lesson:this.settings.lesson,success:this.status.success,quality:q.quality,offsetCm:q.distance*100,angleDeg:q.error*180/Math.PI,ticks:this.tick,contacts:this.status.contacts,pedestrianHits:this.status.pedestrianHits,pain:this.status.pain,reward:this.status.reward,pendingReward:this.status.pendingReward,score:this.status.score};}
}
