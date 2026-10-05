import { TrackDefinition } from './core';

/** Keep the native selector and its events; thumbnails are an accessible shortcut. */
export function mountMapPicker(select:HTMLSelectElement,tracks:()=>TrackDefinition[]):void{
  const strip=document.createElement('div');strip.className='map-thumbnails';strip.setAttribute('aria-label','Map previews');select.closest('label')!.after(strip);
  const refresh=()=>{
    strip.replaceChildren();
    for(const option of Array.from(select.options)){
      const track=tracks().find(t=>t.id===option.value);if(!track)continue;
      const b=document.createElement('button');b.type='button';b.className='map-thumbnail';b.setAttribute('aria-pressed',String(select.value===option.value));b.disabled=select.disabled;
      const canvas=document.createElement('canvas');canvas.width=112;canvas.height=74;canvas.setAttribute('aria-hidden','true');const c=canvas.getContext('2d')!;
      c.fillStyle='#142327';c.fillRect(0,0,112,74);c.translate(56,37);c.scale(.13,.13);c.lineJoin='round';c.lineWidth=track.width;c.strokeStyle='#687787';c.beginPath();track.points.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();c.stroke();
      const label=document.createElement('span');label.textContent=option.text;b.append(canvas,label);b.onclick=()=>{if(select.disabled)return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));};strip.append(b);
    }
  };
  select.addEventListener('change',refresh);new MutationObserver(refresh).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});refresh();
}
