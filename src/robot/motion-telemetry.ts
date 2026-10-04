import { Pose, RobotConfig, validateRobotConfig } from './model';
import { CalibrationProfile, DEFAULT_CALIBRATION, StateEstimator, angle, validateCalibration } from './state-estimator';
export type MotionSample={time:number;kind:'command'|'pose'|'wheels';pwm:[number,number];predicted:Pose;estimated:Pose;covariance:number[];measured?:Pose;accepted?:boolean};
export type MotionTrace={format:'robot-motion-trace';version:1;config:RobotConfig;calibration:CalibrationProfile;origin:Pose;samples:MotionSample[];notes:string};
const finitePose=(p:Pose)=>p&&[p.x,p.z,p.heading].every(Number.isFinite)&&Math.abs(p.x)<1000&&Math.abs(p.z)<1000;
export class MotionTelemetry {
  estimated:StateEstimator;private predicted:StateEstimator;private samples:MotionSample[]=[];private command:[number,number]=[0,0];private at:number|null=null;private origin:Pose;
  private issuedAt=-Infinity;private wheels:{time:number;left:number;right:number;pose:Pose;variance:number}|null=null;wheelSpeed:number|null=null;wheelAt=-Infinity;
  constructor(private config:RobotConfig,private calibration:CalibrationProfile=DEFAULT_CALIBRATION,origin:Pose={x:0,z:0,heading:0}){this.origin={...origin};this.estimated=new StateEstimator(origin,calibration);this.predicted=new StateEstimator(origin,calibration);}
  issue(pwm:[number,number],time:number):void {
    if(!Number.isFinite(time)||pwm.some(v=>!Number.isFinite(v)||Math.abs(v)>1)||this.at!==null&&time<this.at)throw new Error('Invalid issued command timestamp or PWM.');
    this.advance(time);this.command=[...pwm];this.issuedAt=time;this.record(time,'command');
  }
  private advance(time:number):void {
    if(this.at!==null){let cursor=this.at,left=Math.max(0,time-cursor);while(left>1e-8){if(cursor>this.issuedAt+4.5&&left>3){for(const state of [this.predicted,this.estimated]){state.velocity=[0,0];state.covariance[0]+=left*this.calibration.positionNoise**2*.002;state.covariance[4]+=left*this.calibration.positionNoise**2*.002;state.covariance[8]+=left*this.calibration.headingNoise**2*.002;}break;}const deadline=this.issuedAt+1.5,live=cursor<deadline,dt=Math.min(.1,left,live?deadline-cursor:.1),pwm: [number,number]=live?this.command:[0,0];this.predicted.predict(pwm,this.config,dt);this.estimated.predict(pwm,this.config,dt);cursor+=dt;left-=dt;}}
    this.at=time;
  }
  observe(pose:Pose,sigma:number,headingSigma:number,time:number):boolean {
    if(!finitePose(pose)||!Number.isFinite(time)||this.at!==null&&time<this.at)throw new Error('Invalid measured pose or timestamp.');this.advance(time);
    const accepted=this.estimated.observe(pose,sigma,headingSigma,time,'external tracker');this.record(time,'pose',pose,accepted);return accepted;
  }
  observeWheels(deviceTime:number,left:number,right:number,sigma:number,time:number):boolean {
    if(![deviceTime,left,right,sigma,time].every(Number.isFinite)||deviceTime<0||sigma<=0||sigma>.5||Math.abs(left)>10000||Math.abs(right)>10000||this.at!==null&&time<this.at)throw new Error('Invalid cumulative wheel measurement.');
    if(this.wheels&&deviceTime<=this.wheels.time)return false;
    this.advance(time);
    if(!this.wheels){this.wheels={time:deviceTime,left,right,pose:{...this.estimated.pose},variance:sigma**2};return false;}
    const old=this.wheels,dt=deviceTime-old.time,dl=left-old.left,dr=right-old.right;
    if(dt>5||Math.max(Math.abs(dl),Math.abs(dr))/dt>2)throw new Error('Wheel measurement gap or speed exceeds the robot protocol limits.');
    const distance=(dl+dr)/2,turn=(dl-dr)/(this.config.width-this.config.wheelWidth)*(dl-dr<0?this.calibration.turnLeft:this.calibration.turnRight),h=old.pose.heading+turn/2;
    const measured={x:old.pose.x+distance*Math.cos(h),z:old.pose.z+distance*Math.sin(h),heading:angle(old.pose.heading+turn)},variance=old.variance+sigma**2;
    this.wheels={time:deviceTime,left,right,pose:measured,variance};this.wheelSpeed=distance/dt;this.wheelAt=time;
    // Encoder heading is skid-steer odometry, not an independent IMU measurement.
    const accepted=this.estimated.observe(measured,Math.sqrt(variance),Math.max(.08,Math.sqrt(variance)/(this.config.width-this.config.wheelWidth)),time,'wheel encoders · uncertain skid odometry');this.record(time,'wheels',measured,accepted);return accepted;
  }
  resetWheels():void{this.wheels=null;this.wheelSpeed=null;this.wheelAt=-Infinity;}
  private record(time:number,kind:MotionSample['kind'],measured?:Pose,accepted?:boolean):void {this.samples.push({time,kind,pwm:[...this.command],predicted:{...this.predicted.pose},estimated:{...this.estimated.pose},covariance:[...this.estimated.covariance],...(measured?{measured:{...measured},accepted}: {})});if(this.samples.length>5000)this.samples.shift();}
  export():MotionTrace{return {format:'robot-motion-trace',version:1,config:{...this.config},calibration:structuredClone(this.calibration),origin:{...this.origin},samples:structuredClone(this.samples),notes:'Command prediction, filtered estimate and measured pose are separate. WHEELS uses cumulative signed wheel travel and uncertain skid-steer odometry. No encoder/IMU is simulated as installed hardware.'};}
}
export function validateMotionTrace(raw:unknown):MotionTrace {
  const t=raw as MotionTrace;if(!t||t.format!=='robot-motion-trace'||t.version!==1||!finitePose(t.origin)||!Array.isArray(t.samples)||t.samples.length>5000||typeof t.notes!=='string'||t.notes.length>4000)throw new Error('Invalid motion trace.');validateRobotConfig(t.config);validateCalibration(t.calibration);
  let at=-Infinity;for(const s of t.samples){if(!Number.isFinite(s.time)||s.time<at||!['command','pose','wheels'].includes(s.kind)||!Array.isArray(s.pwm)||s.pwm.length!==2||s.pwm.some(v=>!Number.isFinite(v)||Math.abs(v)>1)||!finitePose(s.predicted)||!finitePose(s.estimated)||!Array.isArray(s.covariance)||s.covariance.length!==9||s.covariance.some(v=>!Number.isFinite(v))||s.measured!==undefined&&(!finitePose(s.measured)||typeof s.accepted!=='boolean'))throw new Error('Invalid motion trace sample.');at=s.time;}return structuredClone(t);
}
export function drawMotionTrace(canvas:HTMLCanvasElement,trace:MotionTrace):void {
  const ctx=canvas.getContext('2d')!,points=trace.samples.flatMap(s=>[s.predicted,s.estimated,...(s.measured?[s.measured]:[])]),extent=Math.max(.25,...points.flatMap(p=>[Math.abs(p.x-trace.origin.x),Math.abs(p.z-trace.origin.z)])),scale=Math.min(canvas.width,canvas.height)*.38/extent;
  ctx.fillStyle='#142228';ctx.fillRect(0,0,canvas.width,canvas.height);
  for(const [key,colour]of [['predicted','#efba70'],['estimated','#61d9bd'],['measured','#ccd8ee']] as const){ctx.strokeStyle=colour;ctx.beginPath();let first=true;for(const row of trace.samples){const p=row[key];if(!p)continue;const x=canvas.width/2+(p.x-trace.origin.x)*scale,y=canvas.height/2+(p.z-trace.origin.z)*scale;if(first){ctx.moveTo(x,y);first=false;}else ctx.lineTo(x,y);}ctx.stroke();}
  ctx.fillStyle='#b8d6d4';ctx.font='11px monospace';ctx.fillText('Amber: commands · green: filtered · white: measured',8,18);
}
