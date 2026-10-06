export type PreviewMode='full'|'economy'|'headless';
export type CohortBudget={workMs:number;idleMs:number};
/** Changes wall-clock duty cycle and presentation, never sensor ticks or inputs. */
export class RuntimeBudget {
  mode:PreviewMode='full';
  private lastPaint=-Infinity;
  get cohort():CohortBudget{return this.mode==='full'?{workMs:12,idleMs:0}:this.mode==='economy'?{workMs:6,idleMs:24}:{workMs:4,idleMs:48};}
  get interval():number{return this.mode==='full'?0:this.mode==='economy'?50:100;}
  shouldPaint(now:number):boolean {
    if(this.mode==='headless')return false;
    if(now-this.lastPaint<(this.mode==='economy'?200:0))return false;
    this.lastPaint=now;return true;
  }
}
