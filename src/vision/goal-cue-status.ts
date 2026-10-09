import type { FlagDiscovery } from './world/discovery';

/** Display the actual controller input slots. This diagnostic never changes observations. */
export function goalCueStatus(source:'pixels'|'compass'|'privileged',sensors:ArrayLike<number>|undefined,discovery:FlagDiscovery|null,tick:number):string {
  const value=(i:number)=>Number.isFinite(sensors?.[i])?sensors![i].toFixed(3):'—';
  if(source==='privileged')return 'TARGET: PRIVILEGED DRIVER · expert or exact surroundings enabled.';
  if(source==='compass')return `TARGET: COMPASS ON · hidden goals supply bearing ${value(0)} / closeness ${value(1)}. Select visual exploration to remove this help.`;
  const sample=discovery?.sampleTick;
  const state=sample==null?'awaiting camera frame':discovery!.tracker.current.visible?'flag visible':'flag unseen';
  const age=sample==null?'':` · frame ${Math.max(0,tick-sample)/30 < .01?'fresh':(Math.max(0,tick-sample)/30).toFixed(2)+' s old'}`;
  return `TARGET: CAMERA ONLY · ${state} · image bearing ${value(0)} / size ${value(1)}${age}. Forward lens; swarm crops have no rear view.`;
}
