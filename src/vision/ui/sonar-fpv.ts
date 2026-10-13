import './sonar-fpv.css';
import type {CameraConfig} from '../camera';
import type {Sonar,SonarPose} from '../sonar';
import type {SonarSpec} from '../robot';
import {CM_PER_PIXEL} from '../robot';
import {drawEye} from './draw';
import {observerSettings,applyObserverSettings,watchObserverSettings} from '../../observer-settings';
export type FpvSonar=Pick<Sonar,'spec'|'reading'|'samplePose'|'lastTick'>;

export type FpvMode='camera'|'sonar'|'overlay';
type Point={x:number;y:number};
/** Project only the ranger's angular uncertainty, never hidden scene geometry. */
export function sonarFootprint(camera:CameraConfig,spec:SonarSpec,range:number,sample:SonarPose,pose:SonarPose,halfDeg=spec.lobeSigmaDeg*.625):Array<Point|null>{
  const f=camera.width/(2*Math.tan(camera.hfov/2)),c=Math.cos(camera.pitch),s=Math.sin(camera.pitch);
  const dx=sample.x+Math.cos(sample.heading)*spec.mountForward-pose.x-Math.cos(pose.heading)*camera.mountForward;
  const dy=sample.y+Math.sin(sample.heading)*spec.mountForward-pose.y-Math.sin(pose.heading)*camera.mountForward;
  const ox=dx*Math.cos(pose.heading)+dy*Math.sin(pose.heading),oy=-dx*Math.sin(pose.heading)+dy*Math.cos(pose.heading);
  const yaw=sample.heading-pose.heading+(spec.yawDeg??0)*Math.PI/180,pitch=(spec.pitchDeg??0)*Math.PI/180,half=halfDeg*Math.PI/180;
  return Array.from({length:65},(_,i)=>{
    const a=i*Math.PI/32,h=yaw+Math.cos(a)*half,v=pitch+Math.sin(a)*half;
    const forward=ox+range*Math.cos(v)*Math.cos(h),right=oy+range*Math.cos(v)*Math.sin(h),down=camera.mountHeight-spec.mountHeight+range*Math.sin(v);
    const depth=forward*c+down*s;if(depth<=.01)return null;
    return {x:camera.width/2+f*right/depth,y:camera.height/2+f*(down*c-forward*s)/depth};
  });
}
/** A sonar-only viewport can be wider than the physical camera. */
export function sonarViewport(camera:CameraConfig,spec:SonarSpec):CameraConfig{
  const half=spec.lobeSigmaDeg*.625*Math.PI/180,vertical=Math.atan(Math.tan(camera.hfov/2)*camera.height/camera.width);
  const pitch=(spec.pitchDeg??0)*Math.PI/180,low=Math.min(camera.pitch-vertical,pitch-half),high=Math.max(camera.pitch+vertical,pitch+half);
  const hfov=Math.min(170*Math.PI/180,Math.max(camera.hfov,2*(Math.abs(spec.yawDeg??0)*Math.PI/180+half+.05),2*Math.atan(Math.tan((high-low)/2)*camera.width/camera.height)));
  return {...camera,hfov,pitch:(low+high)/2};
}
export function cameraOutline(camera:CameraConfig,view:CameraConfig):Array<Point|null>{
  const f=view.width/(2*Math.tan(view.hfov/2)),right=Math.tan(camera.hfov/2),down=right*camera.height/camera.width;
  return [[-right,-down],[right,-down],[right,down],[-right,down],[-right,-down]].map(([x,y])=>{
    const forward=Math.cos(camera.pitch)-y*Math.sin(camera.pitch),vertical=Math.sin(camera.pitch)+y*Math.cos(camera.pitch),depth=forward*Math.cos(view.pitch)+vertical*Math.sin(view.pitch);
    return depth<=.01?null:{x:view.width/2+f*x/depth,y:view.height/2+f*(vertical*Math.cos(view.pitch)-forward*Math.sin(view.pitch))/depth};
  });
}
export class SensorFpv{
  readonly controls=document.createElement('div');private readonly select:HTMLSelectElement;private readonly note:HTMLElement;private readonly opacity:HTMLInputElement;
  constructor(readonly prefix:string,readonly canvas:HTMLCanvasElement,repaint:()=>void,private rawCanvas?:HTMLCanvasElement){
    this.controls.className='fpv-controls';
    this.controls.innerHTML=`<label>Front view <select id="${prefix}-fpv-mode"><option value="camera">Camera RGB</option><option value="sonar">Sonar only</option><option value="overlay">Camera + sonar overlay</option></select></label><label class="fpv-opacity" hidden>Layer <input id="${prefix}-fpv-opacity" type="range" min="10" max="80" value="35" aria-label="Sonar overlay opacity"></label><small id="${prefix}-fpv-status" role="status"></small><details><summary>What this view means</summary><small>Amber shows the sonar’s main lobe (~15° at default calibration), with a soft outer sensitivity guide. One echo gives a range, not a pixel image or exact direction: the return could be anywhere within the beam. Grey/outside the beam is unknown; no echo does not mean clear. Mount height, yaw, pitch and held-sample pose affect alignment. Sonar-only can widen the viewport to include coverage outside the camera. These display layers never enter the brain’s RGB or neural inputs.</small></details>`;
    const wrap=canvas.closest('.canvas-wrap');if(wrap)wrap.before(this.controls);else canvas.before(this.controls);
    this.select=this.controls.querySelector('select')!;this.note=this.controls.querySelector('[role=status]')!;this.opacity=this.controls.querySelector('input')!;
    const fill=(s=observerSettings())=>{this.select.value=s.fpv.mode;this.opacity.value=String(s.fpv.opacity);};fill();
    this.select.onchange=this.opacity.oninput=()=>applyObserverSettings({...observerSettings(),fpv:{mode:this.select.value as FpvMode,opacity:Number(this.opacity.value)}});
    watchObserverSettings(s=>{fill(s);repaint();});
    this.controls.querySelector('details small')!.append(' View preferences are shared across labs and included in exports; the active brain is loaded separately.');
  }
  paint(frame:Float32Array,camera:CameraConfig,unit:FpvSonar|null,pose:SonarPose,tick:number,on:boolean,neural:boolean,cart:string):void{
    const mode=this.select.value as FpvMode,ctx=this.canvas.getContext('2d')!,W=this.canvas.width,H=this.canvas.height;
    const title=this.canvas.closest('.view-box,.monitor,.sensor-card')?.querySelector('.view-title > span:first-child,h2,.sensor-title');
    if(title?.firstChild?.nodeType===3)title.firstChild.nodeValue=(['parking','robot'].includes(this.prefix)?'01 / ':'')+(mode==='camera'?'Camera RGB':mode==='sonar'?'Sonar front view':'Camera + sonar overlay')+' ';
    if(this.rawCanvas){this.rawCanvas.hidden=mode!=='camera';this.canvas.hidden=mode==='camera';}
    this.controls.querySelector<HTMLElement>('.fpv-opacity')!.hidden=mode!=='overlay';
    this.canvas.dataset.fpvMode=mode;this.canvas.dataset.cart=cart;
    if(mode!=='sonar')drawEye(this.canvas,frame,camera);else{ctx.clearRect(0,0,W,H);ctx.fillStyle='#101a23';ctx.fillRect(0,0,W,H);}
    const spec=unit?.spec,age=unit?Math.max(0,tick-unit.lastTick)/30:0;
    this.note.textContent=`${cart} · camera ${(camera.hfov*180/Math.PI).toFixed(0)}° · ${!unit?'sonar not fitted':!on?'sonar OFF':`sonar main lobe ${(spec!.lobeSigmaDeg*1.25).toFixed(1)}° · ${unit.reading.echo?(unit.reading.range*CM_PER_PIXEL).toFixed(1)+' cm':'no echo · unknown'} · sample ${(age*1000).toFixed(0)} ms old · ${neural?'connected to brain':'observer only'}`}`;
    if(mode==='camera')return;
    if(!unit||!on||!unit.samplePose){ctx.fillStyle='#d1dce5';ctx.font='15px sans-serif';ctx.fillText(!unit?'No sonar fitted':!on?'Sonar disabled':'Waiting for first ping',12,28);return;}
    const view=mode==='sonar'?sonarViewport(camera,spec!):camera;
    ctx.save();ctx.beginPath();ctx.rect(0,0,W,H);ctx.clip();ctx.scale(W/view.width,H/view.height);
    const polygon=(points:Array<Point|null>,fill:string,stroke:string,dash:number[]=[])=>{
      ctx.beginPath();let start=true;for(const p of points){if(!p){start=true;continue;}if(start){ctx.moveTo(p.x,p.y);start=false;}else ctx.lineTo(p.x,p.y);}
      ctx.setLineDash(dash);ctx.lineWidth=.18;ctx.strokeStyle=stroke;if(points.every(Boolean)){ctx.closePath();ctx.fillStyle=fill;ctx.fill();}ctx.stroke();ctx.setLineDash([]);
    };
    const r=unit.reading.echo?unit.reading.range:spec!.maxRangeCm/CM_PER_PIXEL;
    const main=sonarFootprint(view,spec!,r,unit.samplePose,pose),outer=sonarFootprint(view,spec!,r,unit.samplePose,pose,spec!.lobeSigmaDeg*1.25);
    polygon(outer,'rgba(255,181,75,.035)','rgba(255,181,75,.35)',[.4,.3]);
    polygon(main,`rgba(255,181,75,${mode==='overlay'?Number(this.opacity.value)/100:.16})`,'#ffbd55');
    if(mode==='sonar'){
      polygon(cameraOutline(camera,view),'transparent','#80cbef',[.5,.4]);
    }
    const points=main.filter((p):p is Point=>p!==null),visible=points.length>0&&Math.min(...points.map(p=>p.x))<=view.width&&Math.max(...points.map(p=>p.x))>=0&&Math.min(...points.map(p=>p.y))<=view.height&&Math.max(...points.map(p=>p.y))>=0;
    ctx.restore();ctx.fillStyle='#ffe0a8';ctx.font='12px sans-serif';ctx.fillText(unit.reading.echo?'Echo range · bearing unresolved':'No echo · coverage guide only',10,H-12);
    if(!visible)this.note.textContent+=' · sonar return outside this viewport';
    if(mode==='sonar')this.note.textContent+=` · display ${(view.hfov*180/Math.PI).toFixed(0)}° (blue outline = camera)`;
  }
}
