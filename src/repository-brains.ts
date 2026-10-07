import racer from '../assets/flykart-brain-racer.json?raw';

export const REPOSITORY_BRAINS = [
  { id:'racer', file:'flykart-brain-racer.json', label:`Racer v1 · generation ${JSON.parse(racer).generation}`, domain:'track', load:async()=>racer },
  { id:'visual', file:'flykart-visual.json', label:'Visual explorer · saved brain + eyes + setup', domain:'world', load:async()=>(await import('../assets/flykart-visual.json?raw')).default },
] as const;

export function repositorySelector(id:string, racerOnly=false):HTMLLabelElement {
  const label=document.createElement('label');label.textContent='Repository checkpoint';
  label.style.minWidth='0';label.style.maxWidth='100%';
  const select=document.createElement('select');select.id=id;select.dataset.repositoryChoice='';
  select.style.maxWidth='100%';
  for(const brain of REPOSITORY_BRAINS){const option=new Option(brain.label,brain.id);option.disabled=racerOnly&&brain.domain==='world';if(option.disabled)option.textContent+=' · open in Vision or 3D';select.add(option);}
  label.append(select);
  select.onchange=()=>{for(const other of Array.from(document.querySelectorAll<HTMLSelectElement>('[data-repository-choice]'))){other.value=select.value;if(other!==select)other.dispatchEvent(new Event('repositorychange'));}};
  return label;
}
