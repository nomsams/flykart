import {observerSettings,applyObserverSettings,watchObserverSettings} from '../observer-settings';
/** Same sonar uncertainty choices in every lab; projection/zoom remains local. */
export class ScanDisplay{
  readonly element=document.createElement('div');
  private evidence:HTMLSelectElement;private transmission:HTMLInputElement;
  constructor(prefix:string,host:HTMLElement,paint:()=>void){
    this.element.className='scan-display-controls';this.element.innerHTML=`<label>Evidence <select id="${prefix}-evidence"><option value="arcs">Echo uncertainty arcs</option><option value="cells">Legacy coarse cells</option></select></label><label><input id="${prefix}-transmission" type="checkbox"> Simulated transmission fan</label><small>Display preferences follow across labs and brain exports. Amber arcs have unknown bearing; legacy cells can bridge gaps. The transmission fan uses simulated bodies for illustration. No display geometry enters neural inputs.</small>`;
    host.append(this.element);this.evidence=this.element.querySelector('select')!;this.transmission=this.element.querySelector('input')!;
    const fill=(s=observerSettings())=>{this.evidence.value=s.scan.evidence;this.transmission.checked=s.scan.transmission;};fill();
    this.element.onchange=()=>applyObserverSettings({...observerSettings(),scan:this.options()});watchObserverSettings(s=>{fill(s);paint();});
  }
  options(){return {evidence:this.evidence.value as 'arcs'|'cells',transmission:this.transmission.checked};}
}
