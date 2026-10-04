import { clamp } from '../core';
import type { Pose, RobotConfig } from './model';

export const angle = (v:number):number => Math.atan2(Math.sin(v),Math.cos(v));
export type CalibrationProfile = { version:1; name:string; forward:[number,number]; reverse:[number,number]; turnLeft:number; turnRight:number; sonarScale:number; sonarOffset:number; positionNoise:number; headingNoise:number; notes:string };
export const DEFAULT_CALIBRATION:CalibrationProfile={version:1,name:'Uncalibrated commands',forward:[1,1],reverse:[1,1],turnLeft:.72,turnRight:.72,sonarScale:1,sonarOffset:0,positionNoise:.05,headingNoise:.08,notes:'Effective command model; no wheel encoders.'};
export function validateCalibration(raw:unknown):CalibrationProfile {
  const p=raw as CalibrationProfile;
  if(!p||p.version!==1||typeof p.name!=='string'||p.name.length>120||typeof p.notes!=='string'||p.notes.length>4000||![p.forward,p.reverse].every(a=>Array.isArray(a)&&a.length===2&&a.every(v=>Number.isFinite(v)&&v>=.2&&v<=3))||![p.turnLeft,p.turnRight].every(v=>Number.isFinite(v)&&v>=.1&&v<=2)||!Number.isFinite(p.sonarScale)||p.sonarScale<.5||p.sonarScale>1.5||!Number.isFinite(p.sonarOffset)||Math.abs(p.sonarOffset)>.2||![p.positionNoise,p.headingNoise].every(v=>Number.isFinite(v)&&v>=.001&&v<=1))throw new Error('Invalid calibration profile.');
  return structuredClone(p);
}
export const wheelSpeed=(pwm:number,c:RobotConfig):number => Math.abs(pwm)<c.deadband?0:clamp(pwm,-1,1)*c.rpm/60*Math.PI*c.wheelDiameter*clamp((c.voltage-c.bridgeDrop)/6,0,1.2);
export function compensate(pwm:[number,number],p:CalibrationProfile):[number,number] {return pwm.map((v,i)=>clamp(v/(v<0?p.reverse[i]:p.forward[i]),-1,1)) as [number,number];}
export type PIDSettings={kp:number;ki:number;kd:number;limit:number};
export const DEFAULT_PID:PIDSettings={kp:.7,ki:.06,kd:.08,limit:.25};
export function validatePID(s:PIDSettings):PIDSettings{if(!s||![s.kp,s.ki,s.kd,s.limit].every(Number.isFinite)||s.kp<0||s.kp>5||s.ki<0||s.ki>2||s.kd<0||s.kd>1||s.limit<=0||s.limit>.3)throw new Error('PID limits: Kp 0–5, Ki 0–2, Kd 0–1, correction 0–0.3.');return {...s};}

/** Command odometry is an uncertain prediction. Only observations can correct it. */
export class StateEstimator {
  pose:Pose; covariance:number[]=[.0004,0,0,0,.0004,0,0,0,.0009]; velocity:[number,number]=[0,0];
  source='command prediction'; accepted=0; rejected=0; observationAt=-Infinity;
  constructor(pose:Pose,public profile:CalibrationProfile={...DEFAULT_CALIBRATION}) {this.pose={...pose};}
  predict(pwm:[number,number],c:RobotConfig,dt:number):void {
    if(!Number.isFinite(dt)||dt<=0||dt>.5)throw new Error('Invalid estimator timestep.');
    for(let i=0;i<2;i++){const target=wheelSpeed(pwm[i],c)*(pwm[i]<0?this.profile.reverse[i]:this.profile.forward[i]);this.velocity[i]+=(target-this.velocity[i])*(1-Math.exp(-dt/.16));}
    const [l,r]=this.velocity,v=(l+r)/2,w=(l-r)/(c.width-c.wheelWidth)*(l-r<0?this.profile.turnLeft:this.profile.turnRight),dh=w*dt,h=this.pose.heading+dh/2;
    const dx=v*dt*Math.cos(h),dz=v*dt*Math.sin(h),F=[1,0,-dz,0,1,dx,0,0,1];
    this.pose={x:this.pose.x+dx,z:this.pose.z+dz,heading:angle(this.pose.heading+dh)};
    const q=this.profile.positionNoise**2*(Math.abs(v)*dt+.002*dt),qh=this.profile.headingNoise**2*(Math.abs(dh)+.002*dt);
    this.covariance=add(mul(mul(F,this.covariance,3,3,3),transpose(F,3,3),3,3,3),[q,0,0,0,q,0,0,0,qh]);
  }
  observe(p:Pose,sigmaMetres:number,sigmaRadians:number,time:number,source='measured marks'):boolean {
    if(![p.x,p.z,p.heading,sigmaMetres,sigmaRadians,time].every(Number.isFinite)||sigmaMetres<=0||sigmaRadians<=0)throw new Error('Pose observations require finite values and positive uncertainty.');
    const residual=[p.x-this.pose.x,p.z-this.pose.z,angle(p.heading-this.pose.heading)],R=[sigmaMetres**2,0,0,0,sigmaMetres**2,0,0,0,sigmaRadians**2],S=add(this.covariance,R),inv=inverse3(S);
    const innovation=residual.reduce((sum,v,i)=>sum+v*residual.reduce((a,r,j)=>a+inv[i*3+j]*r,0),0);
    if(innovation>16.27){this.rejected++;return false;}
    const K=mul(this.covariance,inv,3,3,3),correction=mul(K,residual,3,3,1);
    this.pose={x:this.pose.x+correction[0],z:this.pose.z+correction[1],heading:angle(this.pose.heading+correction[2])};
    const A=add([1,0,0,0,1,0,0,0,1],K.map(v=>-v));
    // Joseph form retains a positive covariance under floating-point error.
    this.covariance=add(mul(mul(A,this.covariance,3,3,3),transpose(A,3,3),3,3,3),mul(mul(K,R,3,3,3),transpose(K,3,3),3,3,3));
    this.accepted++;this.source=source;this.observationAt=time;return true;
  }
  /** A surveyed plane n·position=offset. Not usable for arbitrary unknown obstacles. */
  wallRange(cm:number,normal:[number,number],offset:number,mount:number,sigma:number,time:number):boolean {
    const [nx,nz]=normal,a=nx*Math.cos(this.pose.heading)+nz*Math.sin(this.pose.heading),b=offset-nx*this.pose.x-nz*this.pose.z;
    if(![cm,nx,nz,offset,mount,sigma,time].every(Number.isFinite)||Math.abs(Math.hypot(nx,nz)-1)>.001||a<.5||b<=0||cm<2||cm>400||sigma<=0)return false;
    const H=[-nx/a,-nz/a,b*(nx*Math.sin(this.pose.heading)-nz*Math.cos(this.pose.heading))/(a*a)],P=this.covariance,PH=mul(P,H,3,3,1),S=H.reduce((s,v,i)=>s+v*PH[i],sigma**2),residual=cm*.01*this.profile.sonarScale+this.profile.sonarOffset-(b/a-mount);
    if(residual**2/S>9){this.rejected++;return false;}const K=PH.map(v=>v/S);
    this.pose.x+=K[0]*residual;this.pose.z+=K[1]*residual;this.pose.heading=angle(this.pose.heading+K[2]*residual);
    const A=add([1,0,0,0,1,0,0,0,1],mul(K,H,3,1,3).map(v=>-v));
    this.covariance=add(mul(mul(A,P,3,3,3),transpose(A,3,3),3,3,3),mul(K,K,3,1,3).map(v=>v*sigma**2));this.accepted++;this.source='surveyed wall range';this.observationAt=time;return true;
  }
}
function add(a:number[],b:number[]):number[]{return a.map((v,i)=>v+b[i]);}
function mul(a:number[],b:number[],rows:number,inner:number,cols:number):number[]{return Array.from({length:rows*cols},(_,i)=>{let s=0;for(let k=0;k<inner;k++)s+=a[Math.floor(i/cols)*inner+k]*b[k*cols+i%cols];return s;});}
function transpose(a:number[],rows:number,cols:number):number[]{return Array.from({length:a.length},(_,i)=>a[i%rows*cols+Math.floor(i/rows)]);}
function inverse3(m:number[]):number[]{const [a,b,c,d,e,f,g,h,i]=m,A=e*i-f*h,B=c*h-b*i,C=b*f-c*e,D=f*g-d*i,E=a*i-c*g,F=c*d-a*f,G=d*h-e*g,H=b*g-a*h,I=a*e-b*d,det=a*A+b*D+c*G;if(Math.abs(det)<1e-20)throw new Error('Singular observation covariance.');return [A,B,C,D,E,F,G,H,I].map(v=>v/det);}

export class HeadingPID {
  integral=0;private previous=0;private derivative=0;
  constructor(public kp=.7,public ki=.06,public kd=.08,public limit=.25){}
  reset():void {this.integral=0;this.previous=0;this.derivative=0;}
  step(target:number,measured:number,dt:number,age:number):number {
    if(![target,measured,dt,age].every(Number.isFinite)||dt<=0||age<0||age>.5){this.reset();return 0;}
    const error=angle(target-measured),d=angle(error-this.previous)/dt;this.previous=error;this.derivative+=(d-this.derivative)*(1-Math.exp(-dt/.08));
    const candidate=clamp(this.integral+error*dt,-2,2),raw=this.kp*error+this.ki*candidate+this.kd*this.derivative,out=clamp(raw,-this.limit,this.limit);
    if(raw===out||Math.sign(error)!==Math.sign(raw))this.integral=candidate;return out;
  }
}
