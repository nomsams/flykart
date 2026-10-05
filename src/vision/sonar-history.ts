import { Sonar, SonarPose } from './sonar';
import { CM_PER_PIXEL } from './robot';

export type MappedPing={x:number;y:number;heading:number;range:number;echo:boolean;beam:number};
/** A diagnostic overlay, not an extra neural input or perfect obstacle map. */
export class SonarHistory{
  readonly samples:MappedPing[]=[];
  private lastCount=-1;
  clear():void{this.samples.length=0;this.lastCount=-1;}
  record(unit:Sonar|null,pose:SonarPose):void{
    if(!unit||unit.count===this.lastCount)return;
    this.lastCount=unit.count;
    const s=unit.spec;
    this.samples.push({x:pose.x+Math.cos(pose.heading)*s.mountForward,y:pose.y+Math.sin(pose.heading)*s.mountForward,heading:pose.heading+(s.yawDeg??0)*Math.PI/180,range:unit.reading.range,echo:unit.reading.echo,beam:s.lobeSigmaDeg*1.25});
    if(this.samples.length>600)this.samples.shift();
  }
}
export function drawSonarHistory(canvas:HTMLCanvasElement,history:SonarHistory,pose:SonarPose,on:boolean):void{
  const c=canvas.getContext('2d')!,w=canvas.width,h=canvas.height;
  c.fillStyle='#0b151e';c.fillRect(0,0,w,h);
  const extent=Math.max(180,...history.samples.flatMap(p=>[Math.abs(p.x-pose.x)+p.range,Math.abs(p.y-pose.y)+p.range])),scale=(Math.min(w,h)-32)/(extent*2);
  c.save();c.translate(w/2,h/2);c.scale(scale,scale);c.translate(-pose.x,-pose.y);
  c.strokeStyle='#284052';c.lineWidth=1/scale;
  for(let a=-extent;a<=extent;a+=50){c.beginPath();c.moveTo(pose.x-extent,pose.y+a);c.lineTo(pose.x+extent,pose.y+a);c.stroke();}
  if(on)for(const p of history.samples){
    const half=p.beam*Math.PI/360;
    c.strokeStyle=p.echo?'rgba(255,183,81,.32)':'rgba(105,182,198,.07)';c.lineWidth=2/scale;c.beginPath();c.arc(p.x,p.y,p.range,p.heading-half,p.heading+half);c.stroke();
  }
  c.fillStyle='#ffd166';c.beginPath();c.arc(pose.x,pose.y,4/scale,0,Math.PI*2);c.fill();c.strokeStyle='#fff3c0';c.beginPath();c.moveTo(pose.x,pose.y);c.lineTo(pose.x+Math.cos(pose.heading)*15/scale,pose.y+Math.sin(pose.heading)*15/scale);c.stroke();c.restore();
  c.fillStyle='#b9cfe0';c.font='11px system-ui';c.fillText(`${on?history.samples.length+' pings':'Sonar ignored'} · ${(extent*2*CM_PER_PIXEL/100).toFixed(1)} m across`,10,h-10);
}
