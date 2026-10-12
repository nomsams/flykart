import {SpikingNetwork} from '../../core';
import {brainIdentity} from '../../evolution-checkpoint';
import {importFile} from '../format';
import {validateRecoveryState,type WorldGeneration} from './breeding';
export type WorldHistoryNode={id:string;parent:string|null;donors:string[];run:string;generation:number;at:string;brain:ReturnType<SpikingNetwork['toJSON']>;score:number;milestone:boolean;base?:string;metrics?:WorldGeneration;source?:{name:string;id:string;domain:'track'|'world';generation:number;original:ReturnType<SpikingNetwork['toJSON']>}};
export function validateHistoryNode(raw:unknown):WorldHistoryNode{
  const n=raw as WorldHistoryNode;if(!n||typeof n.id!=='string'||!n.id||n.id.length>200||!(n.parent===null||typeof n.parent==='string')||!Array.isArray(n.donors)||n.donors.some(d=>typeof d!=='string')||typeof n.run!=='string'||!Number.isInteger(n.generation)||n.generation<0||typeof n.at!=='string'||!Number.isFinite(n.score)||typeof n.milestone!=='boolean')throw Error('Invalid evolution tree node.');
  const brain=SpikingNetwork.fromJSON(n.brain).toJSON();if(n.base&&!importFile(n.base).controller)throw Error('Tree root requires a complete brain setup.');
  if(n.source){if(typeof n.source.name!=='string'||typeof n.source.id!=='string'||!['track','world'].includes(n.source.domain)||!Number.isInteger(n.source.generation))throw Error('Invalid donor origin');SpikingNetwork.fromJSON(n.source.original);}
  if(n.metrics){const m=n.metrics;if(!Number.isInteger(m.generation)||m.generation<1||!Number.isInteger(m.winner)||!Array.isArray(m.scores)||m.scores.length<2||m.scores.length>32||m.scores.some(s=>!Number.isFinite(s))||m.winner< -1||m.winner>=m.scores.length||!Array.isArray(m.trials)||m.trials.length!==m.scores.length||m.trials.some(a=>!Array.isArray(a)||a.length>4||a.some(r=>!r||typeof r.arrived!=='boolean'||typeof r.crashed!=='boolean'||!['ticks','collisions','progress','reverseDistance'].every(k=>Number.isFinite(r[k as 'ticks']))))||typeof m.context!=='string'||!Number.isInteger(m.plateau)||typeof m.milestone!=='boolean')throw Error('Invalid tree generation metrics.');validateRecoveryState(m.state);}
  return {...n,brain};
}
export type WorldHistoryEvent={id:string;at:string;metrics:WorldGeneration};
/** Rejected generations still advance the trend ledger. Their breeding parent
 * may be a rollback ancestor, so resume against the last accepted controller
 * in that run (or its root), rather than accidentally adopting that ancestor. */
export function savedRecovery(nodes:WorldHistoryNode[],events:WorldHistoryEvent[],brain:unknown,context:string){
  const identity=brainIdentity(brain),cache=new Map<string,string>();
  for(const e of events.slice().reverse()){
    if(e.metrics.context!==context)continue;
    const run=e.id.slice(0,e.id.lastIndexOf(':'));
    const incumbent=nodes.filter(n=>n.run===run&&n.metrics&&n.generation<=e.metrics.generation).sort((a,b)=>a.generation-b.generation).at(-1)??nodes.find(n=>n.id===run+':root');
    if(!incumbent)continue;if(!cache.has(incumbent.id))cache.set(incumbent.id,brainIdentity(incumbent.brain));
    if(cache.get(incumbent.id)===identity)return validateRecoveryState(e.metrics.state);
  }
  const legacy=nodes.slice().reverse().find(n=>n.metrics?.context===context&&brainIdentity(n.brain)===identity);return legacy?.metrics?.state;
}
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{let failed=false;const r=indexedDB.open('flykart-world-tree',2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('nodes'))r.result.createObjectStore('nodes',{keyPath:'id'});if(!r.result.objectStoreNames.contains('events'))r.result.createObjectStore('events',{keyPath:'id'});};r.onsuccess=()=>{if(failed)r.result.close();else resolve(r.result);};r.onerror=()=>{failed=true;reject(r.error);};r.onblocked=()=>{failed=true;reject(Error('Tree storage blocked'));};});}
export async function storeWorldNode(node:WorldHistoryNode):Promise<void>{
  const n=validateHistoryNode(node),db=await database();try{await new Promise<void>((resolve,reject)=>{const t=db.transaction('nodes','readwrite');t.objectStore('nodes').put(n);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}finally{db.close();}
}
export async function loadWorldNodes():Promise<WorldHistoryNode[]>{
  const db=await database();try{return (await new Promise<unknown[]>((resolve,reject)=>{const r=db.transaction('nodes').objectStore('nodes').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);})).map(validateHistoryNode).sort((a,b)=>a.at.localeCompare(b.at));}finally{db.close();}
}
export async function storeWorldEvent(event:WorldHistoryEvent):Promise<void>{const db=await database();try{await new Promise<void>((resolve,reject)=>{const t=db.transaction('events','readwrite');t.objectStore('events').put(event);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}finally{db.close();}}
export async function loadWorldEvents():Promise<WorldHistoryEvent[]>{const db=await database();try{return await new Promise((resolve,reject)=>{const r=db.transaction('events').objectStore('events').getAll();r.onsuccess=()=>resolve(r.result.sort((a:WorldHistoryEvent,b:WorldHistoryEvent)=>a.at.localeCompare(b.at)));r.onerror=()=>reject(r.error);});}finally{db.close();}}
export function worldTreeText(nodes:WorldHistoryNode[],events:WorldHistoryEvent[]=[]):string{return JSON.stringify({format:'flykart-world-evolution-tree',version:1,nodes,events});}
export function parseWorldTree(text:string):WorldHistoryNode[]{const f=JSON.parse(text);if(f?.format!=='flykart-world-evolution-tree'||f.version!==1||!Array.isArray(f.nodes)||f.nodes.length>5000)throw Error('Invalid world tree file.');const nodes:WorldHistoryNode[]=f.nodes.map(validateHistoryNode),ids=new Set<string>();for(const n of nodes){if(ids.has(n.id))throw Error('Duplicate tree node');ids.add(n.id);}for(const n of nodes){if(n.parent!==null&&!ids.has(n.parent))throw Error('Missing tree parent');if(n.donors.some(id=>!ids.has(id)))throw Error('Missing donor ancestor');}const remaining=new Map(nodes.map(n=>[n.id,new Set([...(n.parent?[n.parent]:[]),...n.donors])])),children=new Map<string,string[]>();for(const [id,parents] of remaining)for(const p of parents)children.set(p,[...(children.get(p)??[]),id]);const ready=nodes.filter(n=>remaining.get(n.id)!.size===0).map(n=>n.id);let visited=0;while(ready.length){const id=ready.pop()!;visited++;for(const c of children.get(id)??[]){remaining.get(c)!.delete(id);if(remaining.get(c)!.size===0)ready.push(c);}}if(visited!==nodes.length)throw Error('Cyclic evolution ancestry');return nodes;}
export function parseWorldTreeEvents(text:string,nodes:WorldHistoryNode[]):WorldHistoryEvent[]{const f=JSON.parse(text),events=f.events??[];if(!Array.isArray(events)||events.length>5000)throw Error('Invalid tree events');const ids=new Set<string>();return events.map((e:WorldHistoryEvent)=>{if(!e||typeof e.id!=='string'||ids.has(e.id)||typeof e.at!=='string'||!e.metrics)throw Error('Invalid/duplicate tree event');ids.add(e.id);const parent=nodes.find(n=>n.id===e.metrics.parent);if(!parent)throw Error('Missing event parent');validateHistoryNode({...parent,id:e.id,generation:e.metrics.generation,metrics:e.metrics});return {...e,metrics:{...e.metrics,brain:null}};});}
export function nodeBrainText(node:WorldHistoryNode,nodes:WorldHistoryNode[]):string{
  const root=nodes.find(n=>n.run===node.run&&n.base)||node;if(!root.base)throw Error('The original eyes/setup are missing; import the complete tree.');
  const f=JSON.parse(root.base);f.controller.network=node.brain;f.controller.generation=(f.controller.generation??0)+node.generation;f.controller.fitness=node.score;if(f.world)f.world.controller={...f.controller};f.name='World tree · '+node.id;
  f.controller.provenance=[...(f.controller.provenance??[]),{stage:'world-tree',node:node.id,parent:node.parent,donors:node.donors,milestone:node.milestone}];if(f.world)f.world.controller={...f.controller};const text=JSON.stringify(f);importFile(text);return text;
}
