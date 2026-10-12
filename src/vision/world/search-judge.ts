export type SearchJudgeSettings={enabled:boolean;zeroChill:boolean;delaySeconds:number;cutoffSeconds:number;weight:number};
export const DEFAULT_SEARCH_JUDGE:SearchJudgeSettings={enabled:true,zeroChill:false,delaySeconds:6,cutoffSeconds:12,weight:1};
export function validateSearchJudge(raw:unknown):SearchJudgeSettings{
  if(raw===undefined)return {...DEFAULT_SEARCH_JUDGE};
  const s=raw as SearchJudgeSettings;
  if(!s||typeof s.enabled!=='boolean'||typeof s.zeroChill!=='boolean'||!Number.isFinite(s.delaySeconds)||s.delaySeconds<2||s.delaySeconds>20||!Number.isFinite(s.cutoffSeconds)||s.cutoffSeconds<=s.delaySeconds||s.cutoffSeconds>60||!Number.isFinite(s.weight)||s.weight<.1||s.weight>5)throw Error('Invalid room progress judge settings. Cutoff must be longer than the grace period.');
  return {...s};
}
/** External training labels, never controller inputs or deployable odometry.
 * Heading changes and repeated RGB views do not count as new territory.
 * Visual search never consults a hidden target's position or distance.
 */
export class SearchJudge{
  readonly visited=new Set<string>();
  seconds=0;pain=0;penalty=0;disqualified=false;reason='warming up';
  private lastTick=0;private progressTick=0;private bestCue=0;private goals=0;
  constructor(readonly settings:SearchJudgeSettings,readonly cellSize=32){}
  reset(x:number,y:number,tick=0,goals=0):void{
    this.visited.clear();this.visit(x,y);this.seconds=0;this.pain=0;this.penalty=0;this.disqualified=false;this.reason='exploring';this.lastTick=this.progressTick=tick;this.bestCue=0;this.goals=goals;
  }
  get cells(){return this.visited.size;}
  get coverageReward(){return this.settings.enabled?Math.min(40,Math.max(0,this.cells-1))*.5:0;}
  private visit(x:number,y:number):boolean{
    const key=`${Math.round(x/this.cellSize)},${Math.round(y/this.cellSize)}`;
    if(this.visited.has(key))return false;
    this.visited.add(key);return true;
  }
  observe(x:number,y:number,tick:number,goalProgress:number,goals:number,success:boolean,contacts:number):{pain:number;penalty:number}{
    if(tick<=this.lastTick||this.disqualified)return {pain:0,penalty:0};
    const dt=(tick-this.lastTick)/30;this.lastTick=tick;
    if(!this.settings.enabled){this.reason='off';return {pain:0,penalty:0};}
    if(success){this.seconds=0;this.reason='goal completed';return {pain:0,penalty:0};}
    const fresh=this.visit(x,y),advance=goalProgress>this.bestCue+.025||goals>this.goals;
    if(advance)this.bestCue=goalProgress;
    if(goals>this.goals){this.goals=goals;this.bestCue=goalProgress;}
    if(fresh||advance)this.progressTick=tick;
    this.seconds=(tick-this.progressTick)/30;
    const scale=this.settings.weight*Math.min(8,2**Math.min(10,Math.max(0,this.seconds-this.settings.delaySeconds)/4));
    const active=this.seconds>this.settings.delaySeconds;
    const pain=active?.04*scale*dt:0,penalty=active?.5*scale*dt:0;
    this.pain+=pain;this.penalty+=penalty;
    this.reason=active?'revisiting / no new progress':'exploring';
    if(this.settings.zeroChill&&(contacts>0||this.seconds>=this.settings.cutoffSeconds)){
      this.disqualified=true;this.reason=contacts>0?'contact':'no-progress loop / idle';
    }
    return {pain,penalty};
  }
}
