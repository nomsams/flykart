import { mulberry32 } from "../vision/rng";
import { Pose } from "./model";

export const MEMORY_SIZES = [512, 2048, 4096, 10000, 20000, 40000] as const;
export type MemorySettings = { count: number; sparsity: number; rareWeighting: boolean };
export const DEFAULT_MEMORY: MemorySettings = { count: 4096, sparsity: .01, rareWeighting: true };
export function validateMemorySettings(raw: unknown): MemorySettings {
  const s = raw as MemorySettings;
  if (!s || !MEMORY_SIZES.includes(s.count as typeof MEMORY_SIZES[number]) || !Number.isFinite(s.sparsity) || s.sparsity < .005 || s.sparsity > .05 || typeof s.rareWeighting !== "boolean") throw new Error("Invalid Kenyon memory settings.");
  return { count: s.count, sparsity: s.sparsity, rareWeighting: s.rareWeighting };
}
export type RoomMemorySnapshot = { format: "robot-kenyon-memory"; version: 1 | 2; mapPoseSource?:'simulated'|'estimated';mapFilter?:'raw'|'kalman';settings?: MemorySettings; counts: number[]; means: number[][]; prototypes: (number[] | null)[]; map: [string, number][] };
/** Graded, sparse visual memory; no world meshes or true robot pose in visual recall. */
export class RoomMemory {
  readonly count: number;
  readonly active: number[] = [];
  readonly counts: Float32Array;
  private readonly projections: Float32Array[];
  private readonly means: Float32Array[];
  private readonly prototypes: (Float32Array | null)[];
  readonly map = new Map<string, number>();
  mapPoseSource:'simulated'|'estimated'='simulated';
  mapFilter:'raw'|'kalman'='raw';
  legacyMapReference=false;
  recalled = false;
  confidence = 0;
  private legacy: boolean;
  constructor(readonly settings: MemorySettings = { ...DEFAULT_MEMORY }, legacy = false) {
    validateMemorySettings(settings); this.count = settings.count; this.legacy = legacy;
    this.counts = new Float32Array(this.count);
    this.means = Array.from({ length: this.count }, () => new Float32Array(10));
    this.prototypes = Array(this.count).fill(null);
    const random = mulberry32(751);
    this.projections = Array.from({ length: this.count }, () => Float32Array.from({ length: 27 }, () => random() * 2 - 1));
  }
  get taught(): number { return this.counts.filter(n => n > 0).length; }
  get occupancy(): number { return this.taught / this.count; }
  fresh(): RoomMemory { const next=new RoomMemory({...this.settings},this.legacy);next.mapPoseSource=this.mapPoseSource;next.mapFilter=this.mapFilter;return next; }
  observe(visual: Float32Array, estimates: ArrayLike<number>, learn = true): Float32Array | null {
    if (visual.length !== 24 || [...visual].some(v => !Number.isFinite(v))) throw new Error("Room memory expects 24 finite visual features.");
    const feature = new Float32Array(27); feature.set(visual);
    if (this.legacy) { feature[24] = 1; feature[25] = visual[0] * visual[12]; feature[26] = visual[5] * visual[17]; }
    else {
      const mean = visual.reduce((a,b) => a+b,0)/24;
      const spread = Math.max(.04,Math.sqrt(visual.reduce((a,b) => a+(b-mean)**2,0)/24));
      for(let k=0;k<24;k++) feature[k]=(visual[k]-mean)/spread;
      feature[24]=visual[0]-visual[12];feature[25]=visual[5]-visual[17];feature[26]=visual[8]-visual[20];
    }
    const candidates = this.projections.map((weights,id) => { let value=0;for(let k=0;k<27;k++)value+=weights[k]*feature[k];return {id,value}; })
      .sort((a,b)=>b.value-a.value).slice(0,this.legacy?16:Math.max(4,Math.round(this.count*this.settings.sparsity)));
    this.active.splice(0,this.active.length,...candidates.map(c=>c.id));
    const recall=new Float32Array(10);let matched=0,total=0;
    for(const {id} of candidates) {
      const prototype=this.prototypes[id];let error=0;
      if(prototype)for(let k=0;k<24;k++)error+=(visual[k]-prototype[k])**2;
      if(this.counts[id]>=3 && prototype && error/24<.012) {
        const weight=this.settings.rareWeighting?1/Math.sqrt(1+this.counts[id]/20):1;
        for(let k=0;k<10;k++)recall[k]+=this.means[id][k]*weight;total+=weight;matched++;
      }
    }
    this.confidence=matched/candidates.length;this.recalled=this.confidence>=.375;
    if(learn)for(const {id} of candidates) {
      const rate=1/(Math.min(this.counts[id],50)+1);this.prototypes[id]??=visual.slice();
      for(let k=0;k<24;k++)this.prototypes[id]![k]+=rate*(visual[k]-this.prototypes[id]![k]);
      for(let k=0;k<10;k++)this.means[id][k]+=rate*((estimates[k]??0)-this.means[id][k]);this.counts[id]++;
    }
    return this.recalled?recall.map(v=>v/total):null;
  }
  /** Sonar-only evidence at the selected diagnostic pose; never part of visual recall. */
  mapPing(pose: Pose, mountForward: number, distance: number, echo: boolean): void {
    // A timeout, blind-zone miss or specular reflection proves no free space.
    // Keep earlier wall evidence; a missing echo must never carve a 4 m opening.
    if(!echo||!Number.isFinite(distance)||distance<.02||distance>4)return;
    const max=distance,startX=pose.x+Math.cos(pose.heading)*mountForward,startZ=pose.z+Math.sin(pose.heading)*mountForward;
    // A farther noisy/off-axis echo cannot turn earlier occupied cells into a doorway.
    // Stop carving at repeated wall evidence; isolated uncertain hits also keep their sign.
    for(let r=.04;r<max-.1;r+=.07){const key=[Math.floor((startX+Math.cos(pose.heading)*r)/.1),Math.floor((startZ+Math.sin(pose.heading)*r)/.1)].join(","),occupied=this.map.get(key)??0;if(occupied>=1.6)break;if(occupied<=0)this.map.set(key,Math.max(-5,occupied-.25));}
    if(echo){const key=[Math.floor((startX+Math.cos(pose.heading)*distance)/.1),Math.floor((startZ+Math.sin(pose.heading)*distance)/.1)].join(",");this.map.set(key,Math.min(5,(this.map.get(key)??0)+.8));}
    if(this.map.size>12000)this.map.delete(this.map.keys().next().value!);
  }
  toJSON(): RoomMemorySnapshot { return {format:"robot-kenyon-memory",version:this.legacy?1:2,mapPoseSource:this.mapPoseSource,mapFilter:this.mapFilter,settings:{...this.settings},counts:Array.from(this.counts),means:this.means.map(m=>Array.from(m)),prototypes:this.prototypes.map(m=>m?Array.from(m):null),map:[...this.map]}; }
  static fromJSON(raw: unknown): RoomMemory {
    const s=raw as RoomMemorySnapshot;
    if(!s||s.format!=="robot-kenyon-memory"||![1,2].includes(s.version))throw new Error("Invalid room memory.");
    const settings=s.version===1?{count:512,sparsity:16/512,rareWeighting:false}:validateMemorySettings(s.settings),n=settings.count;
    const finiteRow=(r:number[],size:number)=>Array.isArray(r)&&r.length===size&&r.every(Number.isFinite);
    if(!finiteRow(s.counts,n)||s.counts.some(v=>v<0)||!Array.isArray(s.means)||s.means.length!==n||s.means.some(r=>!finiteRow(r,10))||!Array.isArray(s.prototypes)||s.prototypes.length!==n||s.prototypes.some(r=>r!==null&&!finiteRow(r,24))||!Array.isArray(s.map)||s.map.length>12000||s.map.some(r=>!Array.isArray(r)||r.length!==2||typeof r[0]!=="string"||!/^[-]?\d+,[-]?\d+$/.test(r[0])||!Number.isFinite(r[1])))throw new Error("Invalid room memory values.");
    if(s.mapPoseSource!==undefined&&!['simulated','estimated'].includes(s.mapPoseSource))throw new Error('Invalid scan map pose source.');
    if(s.mapFilter!==undefined&&!['raw','kalman'].includes(s.mapFilter))throw new Error('Invalid scan map processing.');
    const memory=new RoomMemory(settings,s.version===1);memory.mapFilter=s.mapFilter??'raw';memory.legacyMapReference=s.mapPoseSource===undefined&&s.map.length>0;memory.mapPoseSource=s.mapPoseSource??(s.map.length?'estimated':'simulated');memory.counts.set(s.counts);s.means.forEach((r,i)=>memory.means[i].set(r));memory.prototypes.splice(0,n,...s.prototypes.map(r=>r?Float32Array.from(r):null));s.map.forEach(([key,value])=>memory.map.set(key,value));return memory;
  }
}
