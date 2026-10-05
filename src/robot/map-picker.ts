import { WorldObject } from './model';
export function mountHabitatPicker(select:HTMLSelectElement,items:(name:string)=>WorldObject[]):void{
  const picker=document.createElement('details');picker.className='habitat-map-picker';
  const summary=document.createElement('summary'),preview=document.createElement('canvas');preview.width=100;preview.height=76;preview.setAttribute('aria-hidden','true');summary.append(preview,document.createTextNode('Maps'));picker.append(summary);
  const strip=document.createElement('div');strip.className='habitat-map-previews';strip.setAttribute('aria-label','Habitat previews');picker.append(strip);select.closest('label')!.after(picker);
  picker.addEventListener('toggle',()=>{if(!picker.open)return;const r=summary.getBoundingClientRect(),width=Math.min(348,innerWidth-24);strip.style.width=`${width}px`;strip.style.left=`${Math.max(12,Math.min(innerWidth-width-12,r.left))}px`;strip.style.top=`${Math.min(innerHeight-210,r.bottom+5)}px`;});
  document.addEventListener('scroll',e=>{if(picker.open&&!strip.contains(e.target as Node))picker.open=false;},true);
  for(const option of Array.from(select.options)){
    const b=document.createElement('button');b.type='button';b.dataset.map=option.value;b.setAttribute('aria-pressed',String(select.value===option.value));
    const canvas=document.createElement('canvas');canvas.width=100;canvas.height=76;canvas.setAttribute('aria-hidden','true');const c=canvas.getContext('2d')!;c.fillStyle='#adbea6';c.fillRect(0,0,100,76);c.translate(50,38);c.scale(11,11);
    for(const o of items(option.value)){c.save();c.translate(o.x,o.z);c.rotate(o.yaw);c.fillStyle=o.kind==='wall'?'#465753':o.kind==='water'?'#548fb7':o.kind==='bush'||o.kind==='tree'?'#527e5b':'#ab7850';c.fillRect(-o.width/2,-o.depth/2,o.width,o.depth);c.restore();}
    const label=document.createElement('span');label.textContent=option.text;b.append(canvas,label);b.onclick=()=>{if(select.disabled)return;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));picker.open=false;};strip.append(b);
  }
  const refresh=()=>{strip.querySelectorAll<HTMLButtonElement>('button').forEach(b=>{const selected=b.dataset.map===select.value;b.setAttribute('aria-pressed',String(selected));if(selected)preview.getContext('2d')!.drawImage(b.querySelector('canvas')!,0,0);});};
  select.addEventListener('change',refresh);refresh();
}
