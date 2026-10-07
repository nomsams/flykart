import { describe, expect, it } from 'vitest';
import { TargetCurriculum } from './target-curriculum';

describe('Random ghost target curriculum',()=>{
  it('always adds two fresh trials, even when every trial fails forever',()=>{
    for(const retries of [0,1,2]){
      const curriculum=new TargetCurriculum(7,retries),counts=new Map<number,number>();
      for(let generation=0;generation<50;generation++){
        const trials=curriculum.next();
        expect(trials.filter(t=>t.retry===0)).toHaveLength(2);
        expect(trials.length).toBeLessThanOrEqual(3);
        for(const trial of trials)counts.set(trial.seed,(counts.get(trial.seed)??0)+1);
        curriculum.remember(trials,trials.map(()=>false));
      }
      expect(counts.size).toBe(100);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(retries+1);
    }
  });
  it('never retries a successful trial and reserves independent validation seeds',()=>{
    const curriculum=new TargetCurriculum(7,2),validation=[curriculum.fresh(),curriculum.fresh()];
    for(let generation=0;generation<5;generation++){
      const trials=curriculum.next();expect(trials).toHaveLength(2);
      expect(trials.some(t=>validation.some(v=>v.seed===t.seed))).toBe(false);
      curriculum.remember(trials,[true,true]);
    }
  });
  it('is reproducible from its exported run seed and differs between runs',()=>{
    const schedule=(seed:number)=>{
      const c=new TargetCurriculum(seed,2),trials=[];
      for(let i=0;i<5;i++){const batch=c.next();trials.push(batch);c.remember(batch,batch.map(()=>false));}
      return trials;
    };
    expect(schedule(7)).toEqual(schedule(7));expect(schedule(8)).not.toEqual(schedule(7));
    expect(()=>new TargetCurriculum(7,3)).toThrow(/0–2/);
  });
});
