import {Action} from '../core';

export type RecoveryObservation={cm:number|null;age:number;impact:boolean;impactValid:boolean;turnBias?:number;cameraMotion?:number|null;issued:[number,number]};
/** Change in fresh, textured RGB frames; unknown for dropout or flat images. */
export class CameraMotion {
  private previous:Float32Array|null=null;private stamp=-Infinity;motion:number|null=null;
  reset(){this.previous=null;this.stamp=-Infinity;this.motion=null;}
  see(frame:Float32Array,stamp:number,valid:boolean):void {
    if(stamp===this.stamp)return;this.stamp=stamp;
    if(!valid||!frame.length){this.previous=null;this.motion=null;return;}
    const n=frame.length/3,stride=Math.max(1,Math.floor(n/64));let delta=0,count=0,contrast=0;
    for(let k=0;k<3;k++){let sum=0,sq=0,samples=0;for(let i=0;i<n;i+=stride){const v=frame[k*n+i];sum+=v;sq+=v*v;samples++;if(this.previous?.length===frame.length){delta+=Math.abs(v-this.previous[k*n+i]);count++;}}contrast+=sq/samples-(sum/samples)**2;}
    this.motion=count&&contrast>.006?delta/count:null;this.previous=frame.slice();
  }
}
/** Explicit sensor-history assistance/teacher, never a claim about learned weights.
 * No pose, room geometry, simulated speed or collision labels are accepted. */
export class RecoveryDrive {
  phase:'idle'|'brake'|'reverse'|'turn'|'release'='idle';
  private time=0;private stalled=0;private visualStall=0;private impact=false;private direction=1;
  attempts=0;
  reset(){this.phase='idle';this.time=this.stalled=this.visualStall=0;this.impact=false;this.direction=1;this.attempts=0;}
  step(o:RecoveryObservation,requested:Action,dt:number):Action|null {
    const fresh=o.cm!==null&&o.age<=.3,near=fresh&&o.cm!<12;
    const hit=o.impactValid&&o.impact&&!this.impact;this.impact=o.impactValid&&o.impact;
    const trying=requested.throttle>.08||o.issued[0]+o.issued[1]>.15;
    // A stopped policy at a close obstacle can still need recovery. Only a valid
    // range triggers that case; unchanged pixels alone cannot distinguish rest.
    this.stalled=near&&(trying||!(requested.reverse??0))?this.stalled+dt:Math.max(0,this.stalled-dt*2);
    this.visualStall=o.cameraMotion!=null&&o.cameraMotion<.002&&Math.max(...o.issued.map(Math.abs))>.25?this.visualStall+dt:0;
    const retry=hit&&(this.phase==='turn'||this.phase==='release');
    if(retry||this.phase==='idle'&&(hit||this.stalled>.6||this.visualStall>1.5||(trying&&fresh&&o.cm!<5))){this.phase='brake';this.time=0;this.attempts++;const hint=Math.abs(o.turnBias??0)>.05?Math.sign(o.turnBias!):1;this.direction=hint*(this.attempts%2?1:-1);this.stalled=this.visualStall=0;}
    if(this.phase==='idle')return null;
    this.time+=dt;
    const next=(phase:RecoveryDrive['phase'])=>{this.phase=phase;this.time=0;};
    if(this.phase==='brake'){if(this.time>=.16)next('reverse');return {steer:0,throttle:0,reverse:0,brake:1};}
    if(this.phase==='reverse'){
      // Front-only sonar gives no rear clearance. Keep retreats short and stop
      // on a new installed impact pulse, including one during reverse travel.
      if(hit){next('turn');return {steer:0,throttle:0,brake:1};}
      if(this.time>=1.2)next('turn');
      return {steer:0,throttle:0,reverse:.35,brake:0};
    }
    if(this.phase==='turn'){if(this.time>=1.1)next('release');return {steer:this.direction*.95,throttle:0,reverse:0,brake:0};}
    if(this.time>=.8){next('idle');this.stalled=0;}
    return near?{steer:this.direction*.8,throttle:0,reverse:.2,brake:0}:{steer:0,throttle:.24,reverse:0,brake:0};
  }
}
