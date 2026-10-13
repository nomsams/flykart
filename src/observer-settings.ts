/** Portable spectator preferences. Never a controller, sensor or training option. */
export type ObserverSettings={version:1;fpv:{mode:'camera'|'sonar'|'overlay';opacity:number};scan:{evidence:'arcs'|'cells';transmission:boolean}};
export const DEFAULT_OBSERVER:ObserverSettings={version:1,fpv:{mode:'camera',opacity:35},scan:{evidence:'arcs',transmission:true}};
export const OBSERVER_KEY='flykart.observer.v1';
let sessionSettings:ObserverSettings=DEFAULT_OBSERVER;
export function validateObserverSettings(raw:unknown):ObserverSettings{
  const s=raw as ObserverSettings;
  if(!s||s.version!==1||!s.fpv||!['camera','sonar','overlay'].includes(s.fpv.mode)||!Number.isFinite(s.fpv.opacity)||s.fpv.opacity<10||s.fpv.opacity>80||!s.scan||!['arcs','cells'].includes(s.scan.evidence)||typeof s.scan.transmission!=='boolean')throw Error('Invalid observer view settings.');
  return {version:1,fpv:{mode:s.fpv.mode,opacity:s.fpv.opacity},scan:{evidence:s.scan.evidence,transmission:s.scan.transmission}};
}
export function observerSettings():ObserverSettings{
  try{const raw=localStorage.getItem(OBSERVER_KEY);if(raw)return validateObserverSettings(JSON.parse(raw));}catch{/* optional storage */}
  return validateObserverSettings(sessionSettings);
}
export function applyObserverSettings(raw:unknown):ObserverSettings{
  const s=validateObserverSettings(raw);sessionSettings=s;try{localStorage.setItem(OBSERVER_KEY,JSON.stringify(s));}catch{/* views remain usable */}
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('flykart-observer-settings',{detail:s}));return s;
}
export function watchObserverSettings(callback:(s:ObserverSettings)=>void):()=>void{
  const event=(e:Event)=>{try{callback(validateObserverSettings((e as CustomEvent).detail));}catch{/* ignore invalid event */}};
  const storage=(e:StorageEvent)=>{if(e.key!==OBSERVER_KEY||!e.newValue)return;try{const s=validateObserverSettings(JSON.parse(e.newValue));sessionSettings=s;callback(s);}catch{/* ignore invalid storage */}};
  window.addEventListener('flykart-observer-settings',event);window.addEventListener('storage',storage);
  return()=>{window.removeEventListener('flykart-observer-settings',event);window.removeEventListener('storage',storage);};
}
