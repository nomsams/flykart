import { mulberry32 } from '../rng';

export type TargetTrial = { seed:number; retry:number };

/** Two fresh, common trials every generation; at most one bounded failure replay. */
export class TargetCurriculum {
  private readonly random:()=>number;
  private readonly used=new Set<number>();
  private pending:TargetTrial|null=null;
  constructor(readonly seed:number,readonly failureRetries=1) {
    if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw Error('Invalid target curriculum seed.');
    if(!Number.isInteger(failureRetries)||failureRetries<0||failureRetries>2)throw Error('Failure retries must be 0–2.');
    this.random=mulberry32(seed);
  }
  fresh():TargetTrial {
    let seed:number;
    do{seed=1+Math.floor(this.random()*0x7ffffffe);}while(this.used.has(seed));
    this.used.add(seed);return{seed,retry:0};
  }
  next():TargetTrial[] {
    const trials=[this.fresh(),this.fresh()];
    if(this.pending)trials.push(this.pending);
    this.pending=null;return trials;
  }
  /** Only the selected offspring's failures can carry into the next generation. */
  remember(trials:TargetTrial[],won:boolean[]):void {
    // Finish a pending retry before picking another failure; a seed can never loop forever.
    const failed=trials.find((t,i)=>t.retry>0&&!won[i]&&t.retry<this.failureRetries)
      ??trials.find((t,i)=>!won[i]&&t.retry<this.failureRetries);
    this.pending=failed?{seed:failed.seed,retry:failed.retry+1}:null;
  }
}
