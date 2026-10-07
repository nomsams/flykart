/** Keep the original live canvases beside the entire lab, including the lower tools. */
export function setupMonitorLayout(shell: HTMLElement): void {
  const workspace = shell.querySelector<HTMLElement>('.workspace')!;
  const sensors = workspace.querySelector<HTMLElement>('.sensors')!;
  const layout = document.createElement('div'); layout.className = 'habitat-layout';
  const content = document.createElement('div'); content.className = 'habitat-content';
  sensors.classList.add('sensor-rail');
  sensors.setAttribute('role', 'complementary');
  sensors.setAttribute('aria-label', 'Live camera, fly vision and room memory');
  const cards=Array.from(sensors.querySelectorAll<HTMLElement>('.sensor-card'));
  const controls=document.createElement('div');controls.className='monitor-controls';controls.setAttribute('aria-label','Sensor view size');
  let focused=-1;
  const focus=(index:number)=>{
    focused=index;sensors.classList.toggle('monitor-focused',index>=0);layout.classList.toggle('monitor-wide',index>=0);
    cards.forEach((card,i)=>{card.hidden=index>=0&&i!==index;const help=card.querySelector<HTMLDetailsElement>('.monitor-help');if(help)help.open=index>=0&&i===index;});
    controls.querySelectorAll('button').forEach((b,i)=>b.setAttribute('aria-pressed',String(i-1===index)));
  };
  ['All','Camera','Fly eye','Sonar map'].forEach((label,i)=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.monitor=String(i-1);button.onclick=()=>focus(i-1);controls.append(button);});
  sensors.prepend(controls);focus(-1);
  cards.forEach((card,i)=>{const title=card.querySelector('.sensor-title')!;const button=document.createElement('button');button.type='button';button.className='monitor-expand';button.textContent='⤢';button.setAttribute('aria-label',`Expand ${['camera','fly eye','sonar map'][i]}`);button.onclick=()=>focus(focused===i?-1:i);title.append(button);
    const help=card.querySelector('small');if(help){const details=document.createElement('details');details.className='monitor-help';details.innerHTML='<summary>Details & live activity</summary>';const metrics=Array.from(card.querySelectorAll('.map-pose-control,.input-bars,.neural-labels,.memory-row'));help.before(details);details.append(...metrics.filter(e=>e.matches('.map-pose-control')),help,...metrics.filter(e=>!e.matches('.map-pose-control')));}
  });
  workspace.before(layout);
  // The run and program bars stay above the grid; all remaining tools share its left column.
  while (layout.nextElementSibling) content.append(layout.nextElementSibling);
  layout.append(content);
  const mobile = window.matchMedia('(max-width: 720px)');
  const place = () => {
    if (mobile.matches) workspace.querySelector('.sidebar')!.before(sensors);
    else layout.append(sensors);
  };
  place(); mobile.addEventListener('change', place);
  // Budget from the actual top bars, including wrapping on smaller laptop windows.
  const fit = () => {
    const top = layout.getBoundingClientRect().top + window.scrollY;
    layout.style.setProperty('--monitor-height', `${Math.max(360, Math.min(900, window.innerHeight - top - 16))}px`);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(shell.querySelector('.toolbar')!);
  observer.observe(shell.querySelector('.experiment')!);
  observer.observe(document.querySelector('header')!);
  window.addEventListener('resize', fit); fit();
}
