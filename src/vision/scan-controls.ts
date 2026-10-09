import {CM_PER_PIXEL} from './robot';
import {SonarHistory} from './sonar-history';

export function scanComparisonControls(prefix:string):string{
  return `<div class="scan-compare"><label><input id="${prefix}-reference" type="checkbox"> Overlay scene geometry</label><label>Overlay opacity <input id="${prefix}-opacity" type="range" min=".1" max=".9" step=".05" value=".45"></label><label>Map processing <select id="${prefix}-filter"><option value="raw">Raw echo ranges</option><option value="kalman">Motion-aware Kalman</option></select></label><small>Cyan outlines = known scene geometry, including overhead parts. Green/yellow = sonar evidence. This comparison never enters the brain. Filtering uses acquisition time and pose; it preserves no-echo gaps and resets on turns/new close returns. HC-SR04 reports travel time, not Doppler frequency. Flight/Doppler estimates are diagnostic; no frequency correction is applied.</small><p id="${prefix}-motion" class="note" role="status"></p></div>`;
}
export function bindScanComparison(prefix:string,paint:()=>void){
  for(const suffix of ['reference','opacity','filter'])document.getElementById(prefix+'-'+suffix)!.addEventListener('input',()=>{save();paint();});
  const save=()=>{try{localStorage.setItem('flykart.'+prefix,JSON.stringify({reference:input('reference').checked,opacity:input('opacity').value,filter:input('filter').value}));}catch{}};
  const input=(name:string)=>document.getElementById(prefix+'-'+name) as HTMLInputElement;
  try{const s=JSON.parse(localStorage.getItem('flykart.'+prefix)??'null');if(s){input('reference').checked=s.reference===true;if(Number(s.opacity)>=.1&&Number(s.opacity)<=.9)input('opacity').value=String(s.opacity);if(['raw','kalman'].includes(s.filter))input('filter').value=s.filter;}}catch{}
}
export function scanComparison(prefix:string,history:SonarHistory){
  const input=(name:string)=>document.getElementById(prefix+'-'+name) as HTMLInputElement;
  history.filterMode=input('filter').value==='kalman'?'kalman':'raw';
  const d=history.viewData().diagnostic,raw=history.samples.at(-1);
  document.getElementById(prefix+'-motion')!.textContent=d&&raw?`Raw ${raw.echo?(raw.range*CM_PER_PIXEL).toFixed(1)+' cm':'unknown'} · ${d.range===null?'filtered unknown':`filtered ${(d.range*100).toFixed(1)} ± ${(d.sigma*100).toFixed(1)} cm (1σ)`} · ${d.status}. Travel-time estimate ${d.flightMs.toFixed(1)} ms / ${d.travelMm.toFixed(2)} mm motion; theoretical Doppler ${d.dopplerHz.toFixed(0)} Hz at 40 kHz (stationary reflector, simulated pose; not measured). Raw neural sonar is unchanged.`:'Move and scan to compare acquisition-timed raw and filtered ranges. Raw neural sonar is unchanged.';
  return {reference:input('reference').checked,opacity:Number(input('opacity').value)};
}
