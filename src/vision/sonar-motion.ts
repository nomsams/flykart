import {wrapAngle} from '../core';

export type RangePose={x:number;y:number;heading:number};
export type RangeObservation={time:number;range:number;echo:boolean;pose:RangePose;sigma:number};
export type RangeEstimate={range:number|null;sigma:number;status:string;speed:number;flightMs:number;travelMm:number;dopplerHz:number};
/** Stationary reflector approximation; HC-SR04 exposes timing, not Doppler frequency. */
export function acousticMotion(range:number,radialSpeed:number,soundSpeed=343){
  const speed=Math.max(-5,Math.min(5,radialSpeed)),flight=2*Math.max(0,range)/(soundSpeed+speed);
  return {flightMs:flight*1000,travelMm:Math.abs(speed)*flight*1000,dopplerHz:40000*((soundSpeed+speed)/(soundSpeed-speed)-1)};
}

/** Range + reflector range-rate Kalman estimate in metres. Pose is supplied odometry,
 * never target geometry. It compensates translation between acquisition timestamps.
 * Turns, gaps and closer objects restart the filter; no echo never invents a wall. */
export class MotionRangeFilter{
  private previous:RangeObservation|null=null;
  private r=0;private v=0;private p00=0;private p01=0;private p11=1;
  private far:number|null=null;
  reset(){this.previous=null;this.far=null;}
  observe(s:RangeObservation):RangeEstimate{
    const old=this.previous,dt=old?s.time-old.time:0;
    const travel=old?(s.pose.x-old.pose.x)*Math.cos(old.pose.heading)+(s.pose.y-old.pose.y)*Math.sin(old.pose.heading):0;
    const speed=dt>0?travel/dt:0,motion=acousticMotion(s.echo?s.range:0,speed);
    const result=(range:number|null,status:string,sigma=s.sigma):RangeEstimate=>({range,status,sigma,speed,...motion});
    if(!s.echo){this.reset();return result(null,'No echo · unknown');}
    const restart=(status:string)=>{this.r=s.range;this.v=0;this.p00=s.sigma**2;this.p01=0;this.p11=1;this.previous={...s,pose:{...s.pose}};this.far=null;return result(s.range,status);};
    if(!old||dt<=0||dt>.4||Math.hypot(s.pose.x-old.pose.x,s.pose.y-old.pose.y)>.25||Math.abs(wrapAngle(s.pose.heading-old.pose.heading))>Math.PI/36)return restart('New beam / acquisition');
    const q=.5**2,p00=this.p00+2*dt*this.p01+dt**2*this.p11+q*dt**4/4,p01=this.p01+dt*this.p11+q*dt**3/2,p11=this.p11+q*dt**2;
    const prediction=this.r+this.v*dt-travel,variance=p00+s.sigma**2,delta=s.range-prediction;
    // Do not smooth away a newly close obstacle. A far spike cannot carve a false opening.
    if(delta < -Math.max(.03,4*Math.sqrt(variance)))return restart('Closer return · immediate reset');
    if(delta > Math.max(.12,4*Math.sqrt(variance))){
      if(this.far!==null&&Math.abs(s.range-this.far)<Math.max(.04,3*s.sigma))return restart('New farther surface confirmed');
      this.far=s.range;return result(null,'Far jump · awaiting confirmation');
    }
    this.far=null;const k0=p00/variance,k1=p01/variance;
    this.r=Math.max(0,prediction+k0*delta);this.v+=k1*delta;
    this.p00=(1-k0)*p00;this.p01=(1-k0)*p01;this.p11=Math.max(1e-9,p11-k1*p01);
    this.previous={...s,pose:{...s.pose}};return result(this.r,'Motion-aware Kalman',Math.sqrt(this.p00));
  }
}
