import {cartNavigation} from '../../cart-inspection';
import type {TrackSession} from './sessions';
export class TrackGhostInspector{
  readonly element=document.createElement('div');private sessions:TrackSession[]=[];private generation=0;private retained=false;private readonly select:HTMLSelectElement;
  constructor(map:HTMLCanvasElement,repaint:()=>void){
    this.element.className='vision-ghost-inspector';this.element.innerHTML='<label>Inspect cart <select id="track-inspect-ghost" disabled><option value="-1">Live robot</option></select></label><small id="track-ghost-controls">During evolution, click a coloured cart or choose it here to follow its camera, sonar, brain and controls.</small>';
    map.closest('.canvas-wrap')!.before(this.element);this.select=this.element.querySelector('select')!;this.select.onchange=repaint;this.element.querySelector('label')!.after(cartNavigation(this.select,repaint));
    map.addEventListener('pointerup',e=>{
      if(!this.sessions.length)return;const b=map.getBoundingClientRect(),W=Number(map.dataset.w??760),H=Number(map.dataset.h??500),scale=Math.min(W/780,H/500);
      const x=((e.clientX-b.left)*W/b.width-W/2)/scale,y=((e.clientY-b.top)*H/b.height-H/2)/scale;
      const hits=this.sessions.map((s,i)=>({i,d:Math.hypot(s.episode.car.position.x-x,s.episode.car.position.y-y)})).filter(h=>h.d<Math.max(20,12*W/b.width/scale)).sort((a,b)=>a.d-b.d);
      if(hits.length){const closest=hits.filter(h=>h.d<=hits[0].d+3),next=closest.find(h=>h.i>this.index)??closest[0];this.select.value=String(next.i);repaint();}
    });
  }
  get index(){return Number(this.select.value);}
  update(sessions:TrackSession[],generation:number){
    if(this.sessions.length!==sessions.length||this.generation!==generation){const old=this.index;this.select.replaceChildren(new Option('Live robot','-1'),...sessions.map((_,i)=>new Option(`${generation?'G'+generation:'Held-out'} · cart ${i+1}`,String(i))));this.select.value=String(old>=0?Math.min(old,sessions.length-1):this.sessions.length? -1:0);}
    this.retained=false;this.sessions=sessions;this.generation=generation;this.select.disabled=!sessions.length;
  }
  view(s:TrackSession){const a=s.episode.car.action;this.element.querySelector('small')!.textContent=`${this.index<0?'Live robot':(this.generation?'G'+this.generation:'Held-out')+' · cart '+(this.index+1)} · ${this.index<0?'live simulation':this.retained?'frozen comparison':'live training'} · Fwd ${(a.throttle*100).toFixed(0)}% · Back ${((a.reverse??0)*100).toFixed(0)}% · Steer ${a.steer.toFixed(2)} · Sonar ${s.episode.sonarUnit&&s.settings.sonarOn!==false?'ON':'OFF'} · ${s.episode.car.collisions} contacts`;}
  finish(retain=false){this.retained=retain;if(retain)return;this.sessions=[];this.select.replaceChildren(new Option('Live robot','-1'));this.select.disabled=true;}
}
