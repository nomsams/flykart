import { Sonar, SonarPose } from './sonar';
import { CM_PER_PIXEL } from './robot';
import {MotionRangeFilter,RangeEstimate} from './sonar-motion';
import {drawScanReference,ScanReference} from './scan-overlay';
export type MappedPing={x:number;y:number;heading:number;range:number;echo:boolean;beam:number;time?:number;sigma?:number};
export type ScanSnapshot={format:'flykart-scan-memory';version:1;samples:MappedPing[];cells:[string,number][];filter?:'kalman';filteredCells?:[string,number][]};
const CELL=8,MAX_CELLS=12000;
/** Diagnostic range evidence, never a hidden lidar or extra neural input. */
export class SonarHistory{
  readonly samples:MappedPing[]=[];
  readonly cells=new Map<string,number>();
  filterMode:'raw'|'kalman'='raw';
  private persistedFiltered:Map<string,number>|null=null;
  private lastCount=-1;
  private revision=0;
  private estimator=new MotionRangeFilter();
  private cache:{revision:number;samples:MappedPing[];cells:Map<string,number>;diagnostic:RangeEstimate|null}|null=null;
  clear():void{this.samples.length=0;this.cells.clear();this.lastCount=-1;this.revision++;this.cache=null;this.persistedFiltered=null;this.estimator.reset();}
  record(unit:Sonar|null,pose:SonarPose,on=true):void{
    if(!unit||unit.count===this.lastCount)return;
    this.lastCount=unit.count;if(!on)return;
    const s=unit.spec;pose=unit.samplePose??pose;
    const p:MappedPing={x:pose.x+Math.cos(pose.heading)*s.mountForward,y:pose.y+Math.sin(pose.heading)*s.mountForward,heading:pose.heading+(s.yawDeg??0)*Math.PI/180,range:unit.reading.range,echo:unit.reading.echo,beam:s.lobeSigmaDeg*1.25,
      ...(unit.lastTick>=0?{time:unit.lastTick/30,sigma:Math.max(.001,(s.noiseBaseCm+s.noiseProportional*unit.reading.range*CM_PER_PIXEL)/100)}:{})};
    if(this.filterMode==='kalman'&&!this.cache)this.viewData();
    this.samples.push(p);if(this.samples.length>600)this.samples.shift();this.revision++;
    if(this.cache){this.appendFiltered(p,this.samples.length-1);this.cache.revision=this.revision;}
    if(p.echo)addEvidence(this.cells,p);
  }
  private appendFiltered(p:MappedPing,index:number){
    const data=this.cache!;
    data.diagnostic=this.estimator.observe({time:p.time??index/15,range:p.range*CM_PER_PIXEL/100,echo:p.echo,pose:{x:p.x*CM_PER_PIXEL/100,y:p.y*CM_PER_PIXEL/100,heading:p.heading},sigma:p.sigma??.01});
    const d=data.diagnostic,mapped={...p,range:d.range===null?p.range:d.range*100/CM_PER_PIXEL,echo:p.echo&&d.range!==null};
    data.samples.push(mapped);if(data.samples.length>600)data.samples.shift();
    if(mapped.echo)addEvidence(data.cells,mapped);
  }
  /** Filter diagnostics are calculated once per acquisition, never once per render. */
  viewData(){
    if(!this.cache||this.cache.revision!==this.revision){
      this.estimator.reset();this.cache={revision:this.revision,samples:[],cells:new Map(),diagnostic:null};
      this.samples.forEach((p,i)=>this.appendFiltered(p,i));
      if(this.persistedFiltered){this.cache.cells=this.persistedFiltered;this.persistedFiltered=null;}
    }
    return this.filterMode==='kalman'?this.cache:{samples:this.samples,cells:this.cells,diagnostic:this.cache.diagnostic};
  }
  toJSON():ScanSnapshot{return{format:'flykart-scan-memory',version:1,samples:this.samples.map(p=>({...p})),cells:[...this.cells],...(this.filterMode==='kalman'?{filter:'kalman' as const,filteredCells:[...this.viewData().cells]}:{})};}
  restore(raw:unknown):void{const h=SonarHistory.fromJSON(raw);this.clear();this.filterMode=h.filterMode;this.samples.push(...h.samples);h.cells.forEach((v,k)=>this.cells.set(k,v));this.persistedFiltered=h.persistedFiltered;}
  static fromJSON(raw:unknown):SonarHistory{
    const s=raw as ScanSnapshot;
    if(!s||s.format!=='flykart-scan-memory'||s.version!==1||s.filter!==undefined&&s.filter!=='kalman'||!Array.isArray(s.samples)||s.samples.length>600||s.samples.some(p=>!p||![p.x,p.y,p.heading,p.range,p.beam].every(Number.isFinite)||Math.abs(p.x)>100000||Math.abs(p.y)>100000||p.range<0||p.range>5000||p.beam<=0||p.beam>90||typeof p.echo!=='boolean'||p.time!==undefined&&(!Number.isFinite(p.time)||p.time<0)||p.sigma!==undefined&&(!Number.isFinite(p.sigma)||p.sigma<=0||p.sigma>1))||!Array.isArray(s.cells)||s.cells.length>MAX_CELLS||s.cells.some(r=>!Array.isArray(r)||r.length!==2||typeof r[0]!=='string'||!/^[-]?\d+,[-]?\d+$/.test(r[0])||r[0].split(',').some(v=>Math.abs(Number(v))>20000)||!Number.isFinite(r[1])||Math.abs(r[1])>4))throw Error('Invalid sonar scan memory.');
    if(s.filteredCells!==undefined&&(s.filter!=='kalman'||!Array.isArray(s.filteredCells)||s.filteredCells.length>MAX_CELLS||s.filteredCells.some(r=>!Array.isArray(r)||r.length!==2||typeof r[0]!=='string'||!/^[-]?\d+,[-]?\d+$/.test(r[0])||r[0].split(',').some(v=>Math.abs(Number(v))>20000)||!Number.isFinite(r[1])||Math.abs(r[1])>4)))throw Error('Invalid filtered sonar scan memory.');
    const h=new SonarHistory();h.filterMode=s.filter??'raw';h.persistedFiltered=s.filteredCells?new Map(s.filteredCells):null;h.samples.push(...s.samples.map(p=>({...p})));s.cells.forEach(([k,v])=>h.cells.set(k,v));return h;
  }
}
function addEvidence(cells:Map<string,number>,p:MappedPing){
  const evidence=new Map<string,number>(),half=p.beam*Math.PI/360,margin=Math.max(CELL,p.range*.04);
  const add=(r:number,a:number,v:number)=>{const key=[Math.floor((p.x+Math.cos(a)*r)/CELL),Math.floor((p.y+Math.sin(a)*r)/CELL)].join(',');const old=evidence.get(key);if(old===undefined||v>old)evidence.set(key,v);};
  for(let i=-3;i<=3;i++){
    const a=p.heading+half*i/3;
    for(let r=CELL;r<p.range-margin;r+=CELL)add(r,a,-.12);
    for(let r=Math.max(0,p.range-margin);r<=p.range+margin;r+=CELL)add(r,a,.22);
  }
  for(const [key,value] of evidence)cells.set(key,Math.max(-4,Math.min(4,(cells.get(key)??0)+value)));
  while(cells.size>MAX_CELLS)cells.delete(cells.keys().next().value!);
}
export type ScanView={mode?:'perspective'|'top';extent?:number;history?:boolean;beam?:boolean;available?:boolean;reference?:ScanReference;opacity?:number};
/** An isometric ground map. Return markers have illustrative height, not measured object height. */
export function drawSonarHistory(canvas:HTMLCanvasElement,history:SonarHistory,pose:SonarPose,on:boolean,options:ScanView={}):void{
  const c=canvas.getContext('2d')!,w=canvas.width,h=canvas.height,iso=options.mode!=='top';
  const data=history.viewData();canvas.dataset.referenceCount=String(options.reference?.objects.length??0);canvas.dataset.filter=history.filterMode;
  c.fillStyle='#0b151e';c.fillRect(0,0,w,h);
  const extent=options.extent??Math.max(460,Math.abs(pose.x)+70,Math.abs(pose.y)+70,...data.samples.flatMap(p=>[Math.abs(p.x)+p.range,Math.abs(p.y)+p.range]));
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
    for(const [key,value] of data.cells){const [x,y]=key.split(',').map(Number).map(v=>v*CELL);c.fillStyle=value>0?`rgba(255,209,72,${Math.min(.9,.4+value*.2)})`:`rgba(95,220,147,${Math.min(.8,.3-value*.12)})`;poly([project(x,y),project(x+CELL,y),project(x+CELL,y+CELL),project(x,y+CELL)]);}
    if(iso)for(const [key,value] of data.cells){if(value<=.3)continue;const [x,y]=key.split(',').map(Number).map(v=>(v+.5)*CELL),base=project(x,y),top=project(x,y,Math.min(12,3+value*2));c.strokeStyle='rgba(255,189,90,.55)';c.lineWidth=2;line(base,top);}
    c.strokeStyle='rgba(166,203,222,.4)';c.lineWidth=1;c.beginPath();data.samples.forEach((p,i)=>{const q=project(p.x,p.y);if(i===0||Math.hypot(p.x-data.samples[i-1].x,p.y-data.samples[i-1].y)>80)c.moveTo(q.x,q.y);else c.lineTo(q.x,q.y);});c.stroke();
  }
  if(options.reference)drawScanReference(c,options.reference,(x,y,z=0)=>project(x,y,z*scale),options.opacity??.45,iso);
  const p=data.samples.at(-1);
  if(p&&on&&options.beam!==false){const points=[project(p.x,p.y)],half=p.beam*Math.PI/360;for(let i=0;i<=16;i++){const a=p.heading-half+2*half*i/16;points.push(project(p.x+Math.cos(a)*p.range,p.y+Math.sin(a)*p.range));}c.fillStyle=p.echo?'rgba(255,190,86,.17)':'rgba(150,173,188,.07)';poly(points);c.strokeStyle=p.echo?'#ffc266':'#83929d';c.lineWidth=1.5;line(points[0],points[1]);line(points[0],points.at(-1)!);}
  const robot=project(pose.x,pose.y),front=project(pose.x+Math.cos(pose.heading)*24,pose.y+Math.sin(pose.heading)*24);
  c.fillStyle='#fff0b2';c.beginPath();c.arc(robot.x,robot.y,4,0,Math.PI*2);c.fill();c.strokeStyle='#fff0b2';c.lineWidth=2;line(robot,front);
  c.fillStyle='#d3e2ec';c.font='11px system-ui';c.fillText(`${iso?'Perspective':'Top view'} · ${options.available===false?'camera-only head · select Robot':on?'sonar on':'sonar ignored'} · ${data.samples.length} pings`,10,17);
  c.fillStyle='#9eb7c9';c.fillText(`${data.cells.size} remembered cells · ${(extent*2*CM_PER_PIXEL/100).toFixed(1)} m across`,10,h-10);
}
