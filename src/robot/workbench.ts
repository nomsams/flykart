export type WorkbenchState={controller:string;senses:string;task:string;job:string;busy:boolean};
type Tool={key:string;title:string;note:string;panel:HTMLElement};
const HELP:Record<string,string>={
  'task-inheritance':'0 lets the visual task head act alone. 1 uses the inherited spiking fly. Validate the chosen mixture before deployment.',
  'task-shaping':'Extra training reward for getting closer. It uses evaluator measurements and never enters the neural observation.',
  'task-fade':'Fraction of approach shaping retained each generation. 0 removes it after the first generation; 1 keeps it.',
  'task-hold':'Follow the moving ball for this long to count a success. Approaching once is not sufficient.',
  'task-profile':'Baseline keeps the simple setup. Varied and stress add lighting, geometry and sensor latency challenges.',
  'task-suite-variants':'Ablations reuse the same layouts and seeds to isolate the effect of one component.',
  'train-episodes':'Independent room starts / noise seeds per candidate. More trials reduce selection based on one lucky episode.',
  'train-population':'Controllers compared per generation. More candidates take more time.',
  'train-rate':'Probability that an offspring weight changes. The incumbent is retained for comparison.',
  'train-amount':'Size of random weight changes. Larger values explore more but can disrupt an existing policy.',
  'train-seed':'Reproducible random stream for offspring and trials. Keep it fixed for fair comparisons.',
  'vision-radius':'Offset of the virtual gaze crops within the same camera frame. These are not separate physical cameras.',
  'vision-temporal':'Number of recent camera frames averaged. More averaging reduces noise but delays responses.',
  'kenyon-sparsity':'Fraction of Kenyon cells active per view. Sparse codes affect memory matching and capacity.',
  'kenyon-rare':'Give uncommon active cells more influence when matching a remembered view.',
  'objective-cue':'Cyan paint is visible to the camera. Scent uses virtual antenna readings and needs another sensor for physical deployment.',
  'cal-sigma':'Uncertainty of your measured position, not the target position. Smaller values give the measurement more influence.',
  'cal-yaw-sigma':'Uncertainty of the surveyed heading. Do not use command predictions as physical measurements.',
  'cal-compensate':'Apply the fitted inverse wheel gains to simulation and USB host commands. A distilled student already learns issued commands.',
  'cal-pid':'Correct straight-line heading using fresh tracker feedback. Open-loop motor commands cannot measure actual heading.',
  'student-cap':'Absolute PWM ceiling for the onboard student. This does not change its trained parameters.',
  'student-seconds':'Explicit time limit for an onboard run. The device also enforces its watchdog and sensor guards.',
  'serial-pwm-cap':'Clip physical motor requests to this PWM magnitude. Start low when validating a new build.',
  'wheel-feedback':'Use signed cumulative wheel distances only when real encoder telemetry is available. This kit has no built-in encoders.',
};

/** Reparent live controls without recreating them, preserving listeners and state. */
export class RobotWorkbench {
  readonly el=document.createElement('section');
  private tools:Tool[];private active:string;private all=false;
  private results:HTMLDivElement;private query:HTMLInputElement;private nav:HTMLElement;
  constructor(shell:HTMLElement,panels:{tasks:HTMLElement;senses:HTMLElement;train:HTMLElement;research:HTMLElement;calibrate:HTMLElement;logs:HTMLElement;hardware:HTMLElement},private state:()=>WorkbenchState,stop:()=>void){
    this.tools=[
      {key:'tasks',title:'Tasks & skills',note:'Blue-ball objectives, demonstrations and held-out tests',panel:panels.tasks},
      {key:'senses',title:'Senses & memory',note:'Sugar, trails, virtual gaze and Kenyon cells',panel:panels.senses},
      {key:'train',title:'Controller training',note:'Evaluate or evolve the fly in this room',panel:panels.train},
      {key:'research',title:'Experiments & replay',note:'Paired benchmarks, curriculum and onboard student',panel:panels.research},
      {key:'calibrate',title:'Calibration',note:'Marked floor runs, sensor alignment and measured drift',panel:panels.calibrate},
      {key:'logs',title:'Console & noise',note:'Copy readings, export frames and adjust sensor noise',panel:panels.logs},
      {key:'hardware',title:'Real robot',note:'USB telemetry, measured motion and firmware flashing',panel:panels.hardware},
    ];
    this.active='tasks';
    try{this.all=localStorage.getItem('flykart-workbench-view')==='all';}catch{/* Storage may be unavailable. */}
    if(new URLSearchParams(location.search).get('tools')==='all')this.all=true;
    this.el.id='robot-workbench';this.el.className='robot-workbench';
    this.el.innerHTML=`<div class="wb-header"><div><p class="eyebrow">BUILD → TEACH → TEST → TRANSFER</p><h2>Robot workbench</h2><p>Choose one workspace. Your scene, code and learned state stay in place.</p></div><div class="wb-view"><button id="workbench-focus">Focused view</button><button id="workbench-all">All tools</button></div></div>
      <div class="wb-overview"><div><span>CONTROLLER</span><strong data-wb="controller"></strong></div><div><span>CONNECTED SENSES</span><strong data-wb="senses"></strong></div><div><span>CURRENT OBJECTIVE</span><strong data-wb="task"></strong></div></div>
      <div class="wb-layout"><aside class="wb-navigation"><label for="workbench-search">Find a control</label><input id="workbench-search" type="search" placeholder="Try: sonar, PID, replay…" autocomplete="off" maxlength="100" aria-controls="workbench-results"><div id="workbench-results" class="wb-search-results" aria-live="polite"></div><nav aria-label="Robot workspaces"></nav><p class="wb-navigation-note">Start with a task. Inspect the senses, train, then test on unfamiliar rooms before transfer.</p><a href="#habitat" class="wb-back">↑ Back to the habitat</a></aside>
      <div class="wb-content"><div class="wb-job"><span class="wb-job-dot"></span><p id="workbench-job" role="status"></p><button id="workbench-stop" class="danger">■ Stop active run / job</button></div><div class="wb-current"><span id="workbench-tool-label"></span><p id="workbench-tool-note"></p></div><div class="wb-panels"></div></div></div>`;
    shell.querySelector('footer')!.before(this.el);
    this.nav=this.el.querySelector('.wb-navigation nav')!;this.results=this.el.querySelector('#workbench-results')!;this.query=this.el.querySelector('#workbench-search')!;
    const body=this.el.querySelector('.wb-panels')!;
    this.tools.forEach((t,i)=>{if(!t.panel.id)t.panel.id=`workbench-${t.key}-panel`;t.panel.classList.add('wb-panel');body.append(t.panel);const b=document.createElement('button');b.type='button';b.dataset.tool=t.key;b.setAttribute('aria-controls',t.panel.id);b.innerHTML=`<span class="wb-index">${String(i+1).padStart(2,'0')}</span><span><strong>${t.title}</strong><small>${t.note}</small></span>`;b.onclick=()=>this.select(t.key);this.nav.append(b);});
    this.el.querySelector('#workbench-focus')!.addEventListener('click',()=>this.mode(false));this.el.querySelector('#workbench-all')!.addEventListener('click',()=>this.mode(true));
    this.el.querySelector('#workbench-stop')!.addEventListener('click',stop);
    this.query.addEventListener('input',()=>this.search());this.query.addEventListener('keydown',e=>{if(e.key==='Escape'){this.query.value='';this.results.replaceChildren();}if(e.key==='ArrowDown'){const first=this.results.querySelector<HTMLButtonElement>('button');if(first){e.preventDefault();first.focus();}}});
    this.results.addEventListener('keydown',e=>{if(e.key==='Escape'){this.query.focus();this.query.value='';this.results.replaceChildren();}});
    document.addEventListener('click',event=>{const link=(event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');if(!link)return;const id=link.getAttribute('href')!.slice(1);const target=document.getElementById(id),tool=this.tools.find(t=>target&&t.panel.contains(target));if(!tool)return;event.preventDefault();this.reveal(target!,tool);});
    window.addEventListener('hashchange',()=>this.hash());
    this.addHelp();this.render(false);this.hash();this.refresh();
  }
  private mode(all:boolean):void{this.all=all;try{localStorage.setItem('flykart-workbench-view',all?'all':'focus');}catch{/* Keep the current view usable without persistence. */}this.render(!all);}
  private select(key:string):void{this.active=key;this.query.value='';this.results.replaceChildren();this.render(true);}
  private render(scroll:boolean):void{
    this.el.classList.toggle('wb-all',this.all);
    const selected=this.tools.find(t=>t.key===this.active)!;
    this.tools.forEach(t=>{t.panel.hidden=!this.all&&t.key!==this.active;this.nav.querySelector(`[data-tool="${t.key}"]`)!.setAttribute('aria-pressed',String(t.key===this.active));});
    for(const [id,on]of [['workbench-focus',!this.all],['workbench-all',this.all]] as const)this.el.querySelector('#'+id)!.setAttribute('aria-pressed',String(on));
    this.el.querySelector('#workbench-tool-label')!.textContent=this.all?'All robot tools':selected.title;this.el.querySelector('#workbench-tool-note')!.textContent=this.all?'Full layout. Use navigation or search to jump to a tool.':selected.note;
    if(!this.all){const outer=selected.panel.querySelector<HTMLDetailsElement>(':scope > details');if(outer)outer.open=true;}
    if(scroll){const target=this.all?selected.panel:this.el.querySelector('.wb-content')!;target.scrollIntoView({block:'start'});}
  }
  private reveal(target:HTMLElement,tool:Tool):void{this.active=tool.key;this.render(false);let parent:HTMLElement|null=target;while(parent&&parent!==this.el){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}target.scrollIntoView({block:'center'});if(target.matches('input,select,textarea,button'))target.focus({preventScroll:true});target.classList.add('wb-highlight');setTimeout(()=>target.classList.remove('wb-highlight'),1800);}
  private hash():void{const target=document.getElementById(location.hash.slice(1)),tool=this.tools.find(t=>target&&t.panel.contains(target));if(tool)this.reveal(target!,tool);}
  private search():void{
    const q=this.query.value.trim().toLowerCase();this.results.replaceChildren();if(q.length<2)return;
    const matches:{tool:Tool;target:HTMLElement;label:string}[]=[];
    for(const tool of this.tools)for(const target of Array.from(tool.panel.querySelectorAll<HTMLElement>('input[id]:not([type=file]):not(.scene-file),select[id],button[id],textarea[id]'))){
      const label=(target.getAttribute('aria-label')??(target instanceof HTMLButtonElement?target.textContent:target.closest('label')?.childNodes[0]?.textContent)??target.id).trim();
      if(`${label} ${target.id} ${target.title}`.toLowerCase().includes(q))matches.push({tool,target,label});
    }
    if(!matches.length){this.results.textContent='No matching control. Try a sensor or tool name.';return;}
    matches.slice(0,10).forEach(m=>{const b=document.createElement('button');b.type='button';const title=document.createElement('strong'),note=document.createElement('small');title.textContent=m.label;note.textContent=m.tool.title;b.append(title,note);b.onclick=()=>{this.query.value='';this.results.replaceChildren();this.reveal(m.target,m.tool);};this.results.append(b);});
  }
  private addHelp():void{for(const [id,text]of Object.entries(HELP)){const input=document.getElementById(id);if(!input||!this.el.contains(input))continue;input.title=text;const label=input.closest('label');if(!label||label.querySelector('.wb-help'))continue;const d=document.createElement('details');d.className='wb-help';const s=document.createElement('summary');s.textContent='What does this do?';const p=document.createElement('p');p.textContent=text;d.append(s,p);label.append(d);}}
  refresh():void{
    const s=this.state();
    for(const key of ['controller','senses','task'] as const){const target=this.el.querySelector(`[data-wb="${key}"]`)!;if(target.textContent!==s[key])target.textContent=s[key];}
    const job=this.el.querySelector('#workbench-job')!;
    if(job.textContent!==s.job)job.textContent=s.job;
    this.el.querySelector('.wb-job')!.classList.toggle('active',s.busy);
  }
}
