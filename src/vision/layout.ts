/** Reorganize the existing controls and canvases; their listeners and state stay intact. */
export function organizeVision(repaint:()=>void): void {
  compactControls();
  for(const domain of ['track','world'] as const){
    const canvas=document.getElementById(domain+'-sonar-map')!,panel=canvas.closest('section')!;
    const settings=document.createElement('details');settings.className='scan-settings';settings.id=domain+'-scan-settings';
    settings.innerHTML='<summary>Scan settings & legend</summary>';
    settings.append(panel.querySelector('.scan-tools')!);
    // Keep the scan ahead of its controls and explanation, including on mobile.
    for(const note of Array.from(panel.querySelectorAll<HTMLElement>(':scope > p.note:not([role=status])')))settings.append(note);
    // Status and enable controls also belong beneath the map, not ahead of it.
    panel.querySelector('.panel-title')!.after(canvas);
    canvas.after(document.getElementById(domain+'-scan-status')!,document.getElementById(domain+'-scan-enable')!,settings);
    settings.addEventListener('toggle',()=>{if(settings.open)repaint();});
  }
  const sonar=document.getElementById('sonar-panel')!,camera=document.getElementById('track-eye')!.closest('.view-box')!;
  const eyeSettings=camera.querySelector('.eye-preview');
  if(eyeSettings)eyeSettings.before(sonar);else camera.append(sonar);
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

function compactControls():void{
  const deck=document.createElement('section');deck.className='vision-control-deck';deck.setAttribute('aria-label','Simulator controls');
  document.querySelector('.hero')!.after(deck);
  for(const selector of ['.profile-bar','.vision-runtime','.settings-history','.brain-file-bar','.browser-brain-shelf'])deck.append(document.querySelector(selector)!);
  const disclosure=(host:Element,label:string,nodes:Element[])=>{
    const details=document.createElement('details');details.className='compact-control-help';
    const summary=document.createElement('summary');summary.textContent=label;details.append(summary,...nodes);host.append(details);
  };
  const profile=deck.querySelector('.profile-bar')!;
  disclosure(profile,'Sensor details',[document.getElementById('profile-note')!,...Array.from(profile.querySelectorAll('.control-help-wrap'))]);
  disclosure(deck.querySelector('.vision-runtime')!,'Performance details',[document.getElementById('vision-runtime-note')!]);
  const shelf=deck.querySelector('.browser-brain-shelf')!;
  (shelf as HTMLDetailsElement).open=false;
  const notes=Array.from(shelf.querySelectorAll(':scope > small,:scope > .toolbar > small'));
  disclosure(shelf,'About browser & repository checkpoints',notes);
  // Details has an anonymous content box in some browsers; grid a real child.
  const storage=document.createElement('div');storage.className='brain-storage-controls';
  storage.append(...Array.from(shelf.querySelectorAll(':scope > .toolbar')));
  shelf.querySelector('summary')!.after(storage);
}
