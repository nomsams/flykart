/** Reorganize the existing controls and canvases; their listeners and state stay intact. */
export function organizeVision(repaint:()=>void): void {
  const track=document.querySelector<HTMLElement>('#tab-track')!, workspace=track.querySelector('.workspace')!;
  const experiments=document.querySelector<HTMLElement>('#camera-experiment')!;
  experiments.classList.add('vision-experiments');workspace.after(experiments);
  const shortcuts=document.createElement('div');shortcuts.className='vision-shortcuts';
  shortcuts.innerHTML='<span>RACE LAB</span><a href="#camera-experiment">Train with camera</a><a href="#sensor-log">Sensor console</a><button type="button" id="vision-diagnostics">Show diagnostics</button>';
  track.querySelector('.toolbar')!.after(shortcuts);
  shortcuts.querySelectorAll<HTMLAnchorElement>('a').forEach(link=>link.addEventListener('click',event=>{
    const target=document.querySelector<HTMLElement>(link.getAttribute('href')!);if(!target)return;
    event.preventDefault();let parent=target.parentElement;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}
    target.scrollIntoView({block:'start'});if(target instanceof HTMLTextAreaElement)target.focus({preventScroll:true});
  }));
  const groups:HTMLDetailsElement[]=[];
  for(const section of Array.from(document.querySelectorAll<HTMLElement>('#tab-track .game-card>.panel,#tab-world .game-card>.panel'))){
    const heading=section.querySelector<HTMLElement>('.panel-title strong')?.textContent;
    if(!heading||section.id==='sonar-panel')continue;
    const details=document.createElement('details');details.className='vision-inspector';details.open=heading.startsWith('Scan memory');
    const summary=document.createElement('summary');summary.textContent=heading;details.append(summary);
    section.before(details);details.append(section);groups.push(details);
    // Repaint hidden canvases after disclosure so their responsive drawing size is available.
    details.addEventListener('toggle',()=>{if(details.open)repaint();});
  }
  document.querySelector('#vision-diagnostics')!.addEventListener('click',event=>{
    const open=groups.some(d=>!d.open);groups.forEach(d=>d.open=open);
    (event.currentTarget as HTMLButtonElement).textContent=open?'Hide diagnostics':'Show diagnostics';
  });
}
