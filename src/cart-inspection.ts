/** Cycle overlapping comparison carts, in rendered canvas coordinates. */
export function cartHit(points:{x:number;y:number}[],x:number,y:number,current:number,radius:number):number{
  const hits=points.map((p,i)=>({i,d:Math.hypot(p.x-x,p.y-y)})).filter(p=>p.d<=radius).sort((a,b)=>a.d-b.d||a.i-b.i);
  if(!hits.length)return -1;
  const near=hits.filter(p=>p.d<=hits[0].d+Math.min(3,radius*.15)).sort((a,b)=>a.i-b.i);
  return (near.find(p=>p.i>current)??near[0]).i;
}
export function cartNavigation(select:HTMLSelectElement,change:()=>void):HTMLElement{
  const nav=document.createElement('span');nav.className='cart-navigation';
  for(const [step,label] of [[-1,'Previous cart'],[1,'Next cart']] as const){
    const button=document.createElement('button');button.type='button';button.textContent=step<0?'← Previous':'Next →';button.setAttribute('aria-label',label);
    button.onclick=()=>{if(select.disabled||!select.options.length)return;select.selectedIndex=(select.selectedIndex+step+select.options.length)%select.options.length;change();};nav.append(button);
  }
  const sync=()=>nav.querySelectorAll('button').forEach(b=>b.disabled=select.disabled||select.options.length<2);
  new MutationObserver(sync).observe(select,{attributes:true,childList:true});sync();return nav;
}
