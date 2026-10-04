import type { Pose, RobotConfig } from './model';
import { angle, CalibrationProfile, DEFAULT_CALIBRATION, StateEstimator, wheelSpeed } from './state-estimator';
export type CalibrationKind='forward'|'reverse'|'left'|'right'|'out-back'|'turn-left-right'|'turn-right-left'|'square-left'|'square-right';
export type MarkSegment={label:string;pwm:[number,number];seconds:number;expected:Pose};
export type MarkRecord={run?:string;kind:CalibrationKind;label:string;source:'simulation'|'measured';start:Pose;expected:Pose;predicted:Pose;measured:Pose;seconds:number;pwm:[number,number];wheelTravel:[number,number];sigma:number;headingSigma:number;blocked:boolean;pid?:boolean;config:RobotConfig};
export function validateMarks(raw:unknown):MarkRecord[]{if(!Array.isArray(raw)||raw.length>256)throw new Error('Invalid floor-mark records.');for(const r of raw){if(!r||!['forward','reverse','left','right','out-back','turn-left-right','turn-right-left','square-left','square-right'].includes(r.kind)||!['simulation','measured'].includes(r.source)||typeof r.label!=='string'||r.label.length>200||r.run!==undefined&&(typeof r.run!=='string'||r.run.length>100)||![r.seconds,r.sigma,r.headingSigma].every(Number.isFinite)||r.seconds<=0||r.seconds>60||r.sigma<=0||r.headingSigma<=0||typeof r.blocked!=='boolean'||r.pid!==undefined&&typeof r.pid!=='boolean'||[r.start,r.expected,r.predicted,r.measured].some(p=>!p||![p.x,p.z,p.heading].every(Number.isFinite)||Math.abs(p.x)>10||Math.abs(p.z)>10)||[r.pwm,r.wheelTravel].some(a=>!Array.isArray(a)||a.length!==2||a.some(v=>!Number.isFinite(v)))||r.pwm.some((v:number)=>Math.abs(v)>1)||!r.config||Object.values(r.config).some(v=>typeof v==='number'&&!Number.isFinite(v))||![r.config.width,r.config.wheelWidth,r.config.wheelDiameter,r.config.rpm,r.config.voltage,r.config.bridgeDrop,r.config.deadband].every(Number.isFinite)||r.config.width<=r.config.wheelWidth||r.config.wheelDiameter<=0||r.config.rpm<=0)throw new Error('Invalid floor mark, motor pulse or configuration.');}return structuredClone(raw);}
export const localPose=(p:Pose,origin:Pose):Pose=>{const dx=p.x-origin.x,dz=p.z-origin.z,c=Math.cos(origin.heading),s=Math.sin(origin.heading);return {x:dx*c+dz*s,z:-dx*s+dz*c,heading:angle(p.heading-origin.heading)};};
export const globalPose=(p:Pose,origin:Pose):Pose=>({x:origin.x+p.x*Math.cos(origin.heading)-p.z*Math.sin(origin.heading),z:origin.z+p.x*Math.sin(origin.heading)+p.z*Math.cos(origin.heading),heading:angle(p.heading+origin.heading)});
export function markedPlan(kind:CalibrationKind,c:RobotConfig,profile:CalibrationProfile,length=.5,power=.55):MarkSegment[] {
  if(length<.1||length>1.5||power<c.deadband||power>1)throw new Error('Use a 10–150 cm leg and PWM above the motor deadband.');
  const nominal=Math.abs(wheelSpeed(power,c)),linearTime=length/nominal+.16,turn=(left:boolean)=>Math.PI/2*(c.width-c.wheelWidth)/(2*nominal*(left?profile.turnLeft:profile.turnRight))+.16;
  if(nominal<.001)throw new Error('The configured supply, bridge drop or deadband cannot move the robot.');
  let pose:Pose={x:0,z:0,heading:0};const out:MarkSegment[]=[];
  const straight=(reverse=false)=>{pose={...pose,x:pose.x+(reverse?-length:length)*Math.cos(pose.heading),z:pose.z+(reverse?-length:length)*Math.sin(pose.heading)};out.push({label:`Mark ${out.length+1} · ${reverse?'reverse':'straight'} ${length*100} cm`,pwm:[reverse?-power:power,reverse?-power:power],seconds:linearTime,expected:{...pose}});};
  const pivot=(left:boolean)=>{pose={...pose,heading:angle(pose.heading+(left?-1:1)*Math.PI/2)};out.push({label:`Mark ${out.length+1} · ${left?'left':'right'} 90°`,pwm:left?[-power,power]:[power,-power],seconds:turn(left),expected:{...pose}});};
  if(kind==='forward')straight();else if(kind==='reverse')straight(true);else if(kind==='left'||kind==='right')pivot(kind==='left');else if(kind==='out-back'){straight();straight(true);}else if(kind==='turn-left-right'||kind==='turn-right-left'){pivot(kind==='turn-left-right');pivot(kind!=='turn-left-right');}else for(let i=0;i<4;i++){straight();pivot(kind==='square-left');}
  if(out.some(s=>!Number.isFinite(s.seconds)||s.seconds>30))throw new Error('This pulse would exceed 30 seconds. Increase PWM, shorten the leg or check drivetrain settings.');return out;
}
export function predictMark(start:Pose,pwm:[number,number],seconds:number,c:RobotConfig,profile:CalibrationProfile):{pose:Pose;travel:[number,number]} {
  const e=new StateEstimator(start,profile),travel:[number,number]=[0,0];let t=0;
  while(t<seconds){const dt=Math.min(1/30,seconds-t);e.predict(pwm,c,dt);for(let i=0;i<2;i++)travel[i]+=e.velocity[i]*dt;t+=dt;}
  // Record unscaled wheel travel for fitting; the prediction remains profile-dependent.
  for(let i=0;i<2;i++)travel[i]/=pwm[i]<0?profile.reverse[i]:profile.forward[i];return {pose:e.pose,travel};
}
const median=(a:number[])=>{const s=[...a].sort((a,b)=>a-b);return s.length?s.length%2?s[s.length>>1]:(s[s.length/2-1]+s[s.length/2])/2:NaN;};
export function fitCalibration(records:MarkRecord[],base:CalibrationProfile=DEFAULT_CALIBRATION):{profile:CalibrationProfile;warnings:string[];used:number} {
  // Never mix a demonstration's hidden truth with physical measurements.
  const source=records.some(r=>r.source==='measured')?'measured':'simulation',usable=records.filter(r=>r.source===source&&!r.blocked&&!r.pid),forward:[number[],number[]]=[[],[]],reverse:[number[],number[]]=[[],[]],turns:[number[],number[]]=[[],[]],p=structuredClone(base),warnings:string[]=[];
  for(const r of usable.filter(r=>r.kind==='forward'||r.kind==='reverse')){const local=localPose(r.measured,r.start),theta=local.heading,chord=Math.hypot(local.x,local.z),sinc=Math.abs(theta)<1e-6?1:Math.sin(theta/2)/(theta/2),centre=Math.sign(r.pwm[0])*chord/sinc,track=r.config.width-r.config.wheelWidth,turnScale=theta<0?base.turnLeft:base.turnRight,travels=[centre+theta*track/(2*turnScale),centre-theta*track/(2*turnScale)];
    if(Math.abs(theta)>Math.PI/2){warnings.push('A straight run turned more than 90°; omitted from wheel fit.');continue;}
    const target=r.kind==='forward'?forward:reverse;for(let i=0;i<2;i++){const gain=travels[i]/r.wheelTravel[i];if(Number.isFinite(gain)&&gain>=.2&&gain<=3)target[i].push(gain);}
  }
  for(const [name,groups] of [['forward',forward],['reverse',reverse]] as const)for(let i=0;i<2;i++){if(groups[i].length)p[name][i]=median(groups[i]);if(groups[i].length<3)warnings.push(`${name} wheel ${i?'right':'left'}: ${groups[i].length}/3 recommended repeats.`);}
  for(const r of usable.filter(r=>r.kind==='left'||r.kind==='right')){const wheels=r.wheelTravel.map((v,i)=>v*(v<0?p.reverse[i]:p.forward[i])),nominal=(wheels[0]-wheels[1])/(r.config.width-r.config.wheelWidth),yaw=angle(r.measured.heading-r.start.heading),scale=yaw/nominal;if(scale>=.1&&scale<=2)turns[r.kind==='left'?0:1].push(scale);}
  if(turns[0].length)p.turnLeft=median(turns[0]);if(turns[1].length)p.turnRight=median(turns[1]);turns.forEach((a,i)=>{if(a.length<3)warnings.push(`${i?'Right':'Left'} turns: ${a.length}/3 recommended repeats.`);});
  const errors=usable.map(r=>Math.hypot(r.predicted.x-r.measured.x,r.predicted.z-r.measured.z)),yawErrors=usable.map(r=>Math.abs(angle(r.predicted.heading-r.measured.heading)));
  if(errors.length){p.positionNoise=Math.max(.005,Math.min(1,median(errors)));p.headingNoise=Math.max(.01,Math.min(1,median(yawErrors)));}
  p.name=source==='simulation'?'Simulation demonstration fit':'Measured floor calibration';p.notes=`${usable.length} ${source} segments. Effective motor/turn gains at recorded voltage, RPM and surface. Track width held fixed. Squares are validation, not fit inputs. Noise is a conservative endpoint residual scale, not identified continuous process noise.`;
  warnings.push('Commands alone cannot distinguish wheel diameter, voltage, traction and track-width errors. Recheck at another PWM, battery level and floor.');return {profile:p,warnings,used:usable.length};
}
export function markErrors(r:MarkRecord):{predictionCm:number;targetCm:number;yawDeg:number}{return {predictionCm:100*Math.hypot(r.predicted.x-r.measured.x,r.predicted.z-r.measured.z),targetCm:100*Math.hypot(r.expected.x-r.measured.x,r.expected.z-r.measured.z),yawDeg:angle(r.measured.heading-r.expected.heading)*180/Math.PI};}
export function fitSonar(samples:{trueCm:number;readCm:number|null}[]):{scale:number;offset:number;sigmaCm:number;dropout:number} {
  const valid=samples.filter(s=>s.readCm!==null&&[s.trueCm,s.readCm].every(Number.isFinite)&&s.trueCm>=2&&s.trueCm<=400&&s.readCm!>=2&&s.readCm!<=400);
  if(valid.length<3)throw new Error('Measure at least three valid sonar reference distances.');
  const x=valid.map(s=>s.readCm!),y=valid.map(s=>s.trueCm),xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length,den=x.reduce((s,v)=>s+(v-xm)**2,0);if(den<100)throw new Error('Reference distances need a wider spread.');
  const scale=x.reduce((s,v,i)=>s+(v-xm)*(y[i]-ym),0)/den,offset=(ym-scale*xm)/100;if(scale<.5||scale>1.5||Math.abs(offset)>.2)throw new Error('Implausible sonar fit; check units and reference faces.');
  return {scale,offset,sigmaCm:Math.sqrt(x.reduce((s,v,i)=>s+(v*scale+offset*100-y[i])**2,0)/Math.max(1,x.length-2)),dropout:1-valid.length/samples.length};
}
export function cameraFov(widthCm:number,distanceCm:number,pixels:number):number {if(![widthCm,distanceCm,pixels].every(Number.isFinite)||widthCm<=0||distanceCm<=0||pixels<5||pixels>150)throw new Error('Use a centred, face-on reference 5–150 pixels wide.');return 2*Math.atan(widthCm/(2*distanceCm*(pixels/160)))*180/Math.PI;}
