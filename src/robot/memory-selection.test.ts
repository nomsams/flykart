import {describe,it,expect} from 'vitest';
import {RoomMemory,DEFAULT_MEMORY} from './memory';
import {mulberry32} from '../vision/rng';

// Independent reference of the original full, stable sort. Check exact IDs and
// tie order, not only an approximate recall score, across normal and legacy banks.
function reference(visual:Float32Array,count:number,sparsity:number,legacy:boolean){
  const feature=new Float32Array(27);feature.set(visual);
  if(legacy){feature[24]=1;feature[25]=visual[0]*visual[12];feature[26]=visual[5]*visual[17];}
  else{const mean=visual.reduce((a,b)=>a+b,0)/24,spread=Math.max(.04,Math.sqrt(visual.reduce((a,b)=>a+(b-mean)**2,0)/24));for(let k=0;k<24;k++)feature[k]=(visual[k]-mean)/spread;feature[24]=visual[0]-visual[12];feature[25]=visual[5]-visual[17];feature[26]=visual[8]-visual[20];}
  const random=mulberry32(751),scores=Array.from({length:count},(_,id)=>{const weights=Float32Array.from({length:27},()=>random()*2-1);let value=0;for(let k=0;k<27;k++)value+=weights[k]*feature[k];return{id,value};});
  return scores.sort((a,b)=>b.value-a.value).slice(0,legacy?16:Math.max(4,Math.round(count*sparsity))).map(s=>s.id);
}
describe('exact sparse Kenyon selection',()=>{
  it('matches full stable sorting, including all-equal scores and large banks',()=>{
    const random=mulberry32(817),frames=[new Float32Array(24),Float32Array.from({length:24},()=>random()),Float32Array.from({length:24},()=>random())];
    for(const count of [512,4096,40000])for(const sparsity of [.005,.05])for(const visual of frames){const m=new RoomMemory({...DEFAULT_MEMORY,count,sparsity});m.observe(visual,new Float32Array(10));expect(m.active).toEqual(reference(visual,count,sparsity,false));}
    const legacy=new RoomMemory({...DEFAULT_MEMORY,count:512},true);legacy.observe(frames[1],new Float32Array(10));expect(legacy.active).toEqual(reference(frames[1],512,.01,true));
  });
  it('shares no learned state between flies or with an exported checkpoint',()=>{
    const a=new RoomMemory(),b=new RoomMemory(),pixels=Float32Array.from({length:24},(_,i)=>i/24),estimates=new Float32Array(10).fill(.4);
    a.observe(pixels,estimates);expect(b.taught).toBe(0);const saved=a.toJSON();b.observe(new Float32Array(24),new Float32Array(10));expect(a.toJSON()).toEqual(saved);
    const restored=RoomMemory.fromJSON(saved);restored.observe(pixels,estimates);expect(a.toJSON()).toEqual(saved);
  });
});
