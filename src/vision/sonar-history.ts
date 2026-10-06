import { Sonar, SonarPose } from './sonar';
import { CM_PER_PIXEL } from './robot';
export type MappedPing={x:number;y:number;heading:number;range:number;echo:boolean;beam:number};
export type ScanSnapshot={format:'flykart-scan-memory';version:1;samples:MappedPing[];cells:[string,number][]};
const CELL=8,MAX_CELLS=12000;
/** Diagnostic range evidence, never a hidden lidar or extra neural input. */
export class SonarHistory{
  readonly samples:MappedPing[]=[];
  readonly cells=new Map<string,number>();
  private lastCount=-1;
  clear():void{this.samples.length=0;this.cells.clear();this.lastCount=-1;}
  record(unit:Sonar|null,pose:SonarPose,on=true):void{
    if(!unit||unit.count===this.lastCount)return;
    this.lastCount=unit.count;if(!on)return;
    const s=unit.spec;
    const p={x:pose.x+Math.cos(pose.heading)*s.mountForward,y:pose.y+Math.sin(pose.heading)*s.mountForward,heading:pose.heading+(s.yawDeg??0)*Math.PI/180,range:unit.reading.range,echo:unit.reading.echo,beam:s.lobeSigmaDeg*1.25};
    this.samples.push(p);if(this.samples.length>600)this.samples.shift();
    // No echo is unknown. An echo supports a conservative clear approach plus
    // a band of possible returns across the beam, not one exact laser endpoint.
    if(!p.echo)return;
    const evidence=new Map<string,number>(),half=p.beam*Math.PI/360,margin=Math.max(CELL,p.range*.04);
    const add=(r:number,a:number,v:number)=>{const key=[Math.floor((p.x+Math.cos(a)*r)/CELL),Math.floor((p.y+Math.sin(a)*r)/CELL)].join(',');const old=evidence.get(key);if(old===undefined||v>old)evidence.set(key,v);};
    for(let i=-3;i<=3;i++){
      const a=p.heading+half*i/3;
      for(let r=CELL;r<p.range-margin;r+=CELL)add(r,a,-.12);
      for(let r=Math.max(0,p.range-margin);r<=p.range+margin;r+=CELL)add(r,a,.22);
    }
    for(const [key,value] of evidence){this.cells.set(key,Math.max(-4,Math.min(4,(this.cells.get(key)??0)+value)));}
    while(this.cells.size>MAX_CELLS)this.cells.delete(this.cells.keys().next().value!);
  }
  toJSON():ScanSnapshot{return{format:'flykart-scan-memory',version:1,samples:this.samples.map(p=>({...p})),cells:[...this.cells]};}
  restore(raw:unknown):void{const h=SonarHistory.fromJSON(raw);this.clear();this.samples.push(...h.samples);h.cells.forEach((v,k)=>this.cells.set(k,v));}
  static fromJSON(raw:unknown):SonarHistory{
    const s=raw as ScanSnapshot;
    if(!s||s.format!=='flykart-scan-memory'||s.version!==1||!Array.isArray(s.samples)||s.samples.length>600||s.samples.some(p=>!p||![p.x,p.y,p.heading,p.range,p.beam].every(Number.isFinite)||Math.abs(p.x)>100000||Math.abs(p.y)>100000||p.range<0||p.range>5000||p.beam<=0||p.beam>90||typeof p.echo!=='boolean')||!Array.isArray(s.cells)||s.cells.length>MAX_CELLS||s.cells.some(r=>!Array.isArray(r)||r.length!==2||typeof r[0]!=='string'||!/^[-]?\d+,[-]?\d+$/.test(r[0])||r[0].split(',').some(v=>Math.abs(Number(v))>20000)||!Number.isFinite(r[1])||Math.abs(r[1])>4))throw Error('Invalid sonar scan memory.');
    const h=new SonarHistory();h.samples.push(...s.samples.map(p=>({...p})));s.cells.forEach(([k,v])=>h.cells.set(k,v));return h;
  }
}
export type ScanView={mode?:'perspective'|'top';extent?:number;history?:boolean;beam?:boolean;available?:boolean};
/** An isometric ground map. Return markers have illustrative height, not measured object height. */
export function drawSonarHistory(canvas:HTMLCanvasElement,history:SonarHistory,pose:SonarPose,on:boolean,options:ScanView={}):void{
  const c=canvas.getContext('2d')!,w=canvas.width,h=canvas.height,iso=options.mode!=='top';
  c.fillStyle='#0b151e';c.fillRect(0,0,w,h);
  const extent=options.extent??Math.max(460,Math.abs(pose.x)+70,Math.abs(pose.y)+70,...history.samples.flatMap(p=>[Math.abs(p.x)+p.range,Math.abs(p.y)+p.range]));
  const scale=Math.min((w-36)/(iso?2.9:2),(h-56)/(iso?1.55:2))/extent;
  // Fixed world origin: memory never shifts when the robot moves.
  const project=(x:number,y:number,z=0)=>({x:w/2+(iso?(x-y)*.72:x)*scale,y:h/2+12+(iso?(x+y)*.36:y)*scale-z});
  const line=(a:{x:number;y:number},b:{x:number;y:number})=>{c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();};
  const poly=(points:{x:number;y:number}[])=>{c.beginPath();points.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();c.fill();};
  c.fillStyle='#14232c';poly([project(-extent,-extent),project(extent,-extent),project(extent,extent),project(-extent,extent)]);
  c.strokeStyle='#293f4d';c.lineWidth=.6;
  const grid=100;for(let a=Math.ceil(-extent/grid)*grid;a<=extent;a+=grid){line(project(-extent,a),project(extent,a));line(project(a,-extent),project(a,extent));}
  const visible=options.history!==false;
  if(visible){
    for(const [key,value] of history.cells){const [x,y]=key.split(',').map(Number).map(v=>v*CELL);c.fillStyle=value>0?`rgba(255,177,72,${Math.min(.85,.2+value*.2)})`:`rgba(91,193,199,${Math.min(.65,.16-value*.12)})`;poly([project(x,y),project(x+CELL,y),project(x+CELL,y+CELL),project(x,y+CELL)]);}
    if(iso)for(const [key,value] of history.cells){if(value<=.3)continue;const [x,y]=key.split(',').map(Number).map(v=>(v+.5)*CELL),base=project(x,y),top=project(x,y,Math.min(12,3+value*2));c.strokeStyle='rgba(255,189,90,.55)';c.lineWidth=2;line(base,top);}
    c.strokeStyle='rgba(166,203,222,.4)';c.lineWidth=1;c.beginPath();history.samples.forEach((p,i)=>{const q=project(p.x,p.y);if(i===0||Math.hypot(p.x-history.samples[i-1].x,p.y-history.samples[i-1].y)>80)c.moveTo(q.x,q.y);else c.lineTo(q.x,q.y);});c.stroke();
  }
  const p=history.samples.at(-1);
  if(p&&on&&options.beam!==false){const points=[project(p.x,p.y)],half=p.beam*Math.PI/360;for(let i=0;i<=16;i++){const a=p.heading-half+2*half*i/16;points.push(project(p.x+Math.cos(a)*p.range,p.y+Math.sin(a)*p.range));}c.fillStyle=p.echo?'rgba(255,190,86,.17)':'rgba(150,173,188,.07)';poly(points);c.strokeStyle=p.echo?'#ffc266':'#83929d';c.lineWidth=1.5;line(points[0],points[1]);line(points[0],points.at(-1)!);}
  const robot=project(pose.x,pose.y),front=project(pose.x+Math.cos(pose.heading)*24,pose.y+Math.sin(pose.heading)*24);
  c.fillStyle='#fff0b2';c.beginPath();c.arc(robot.x,robot.y,4,0,Math.PI*2);c.fill();c.strokeStyle='#fff0b2';c.lineWidth=2;line(robot,front);
  c.fillStyle='#d3e2ec';c.font='11px system-ui';c.fillText(`${iso?'Perspective':'Top view'} · ${options.available===false?'camera-only head · select Robot':on?'sonar on':'sonar ignored'} · ${history.samples.length} pings`,10,17);
  c.fillStyle='#9eb7c9';c.fillText(`${history.cells.size} remembered cells · ${(extent*2*CM_PER_PIXEL/100).toFixed(1)} m across`,10,h-10);
}
