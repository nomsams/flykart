/** Undo simulation settings; editable text retains the browser's native undo. */
export function installSettingsHistory(root:HTMLElement, refresh:()=>void, busy:()=>boolean=()=>false):void {
  type Snapshot=Record<string,{value:string;checked:boolean}>;
  const read=():Snapshot=>Object.fromEntries(Array.from(root.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[id]:not([type=file]),select[id]')).map(e=>[e.id,{value:e.value,checked:e instanceof HTMLInputElement?e.checked:false}]));
  let current=read(), restoring=false;
  const past:Snapshot[]=[],future:Snapshot[]=[];
  const toolbar=document.createElement('div');toolbar.className='toolbar settings-history';
  toolbar.innerHTML='<button type="button" id="settings-undo" disabled>↶ Undo settings</button><button type="button" id="settings-redo" disabled>↷ Redo settings</button><small>Ctrl+Z · Ctrl+Shift+Z / Ctrl+Y. Settings only; does not rewind learning or motion.</small>';
  root.prepend(toolbar);
  const undo=toolbar.querySelector<HTMLButtonElement>('#settings-undo')!,redo=toolbar.querySelector<HTMLButtonElement>('#settings-redo')!;
  const sync=()=>{undo.disabled=!past.length||busy();redo.disabled=!future.length||busy();};
  const record=()=>{if(restoring)return;const next=read();if(JSON.stringify(next)===JSON.stringify(current))return;past.push(current);if(past.length>50)past.shift();future.length=0;current=next;sync();};
  root.addEventListener('change',record);
  root.addEventListener('click',e=>{const target=e.target as HTMLElement;if(target.closest('button')&&!target.closest('.settings-history'))queueMicrotask(record);});
  const restore=(next:Snapshot)=>{restoring=true;try{for(const [id,s]of Object.entries(next)){const e=document.getElementById(id);if(!(e instanceof HTMLInputElement||e instanceof HTMLSelectElement))continue;const changed=e.value!==s.value||(e instanceof HTMLInputElement&&e.checked!==s.checked);e.value=s.value;if(e instanceof HTMLInputElement)e.checked=s.checked;if(changed)e.dispatchEvent(new Event('change',{bubbles:true}));}refresh();current=read();}finally{restoring=false;sync();}};
  undo.onclick=()=>{if(busy()||!past.length)return;future.push(current);restore(past.pop()!);};
  redo.onclick=()=>{if(busy()||!future.length)return;past.push(current);restore(future.pop()!);};
  document.addEventListener('keydown',e=>{const t=e.target as HTMLElement,editable=t.closest('textarea,[contenteditable=true],input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button]):not([type=submit])');if(!(e.ctrlKey||e.metaKey)||e.altKey||editable)return;if(e.key.toLowerCase()==='z'){e.preventDefault();(e.shiftKey?redo:undo).click();}else if(e.key.toLowerCase()==='y'){e.preventDefault();redo.click();}});
}
