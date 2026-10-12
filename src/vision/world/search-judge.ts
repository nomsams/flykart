import {ParkingMotionJudge} from '../../parking/motion-judge';
import {CM_PER_PIXEL} from '../robot';
export type SearchJudgeSettings={enabled:boolean;zeroChill:boolean;delaySeconds:number;cutoffSeconds:number;weight:number;loopGuard?:boolean;blindReverse?:boolean;antiJitter?:boolean;jitterWindowSeconds?:number;jitterWeight?:number};
export const DEFAULT_SEARCH_JUDGE:SearchJudgeSettings={enabled:true,zeroChill:false,delaySeconds:6,cutoffSeconds:12,weight:1,loopGuard:true,blindReverse:true,antiJitter:true,jitterWindowSeconds:4,jitterWeight:2};
export function validateSearchJudge(raw:unknown):SearchJudgeSettings{
  if(raw===undefined)return {...DEFAULT_SEARCH_JUDGE};
  const s=raw as SearchJudgeSettings;
  if(!s||typeof s.enabled!=='boolean'||typeof s.zeroChill!=='boolean'||!Number.isFinite(s.delaySeconds)||s.delaySeconds<2||s.delaySeconds>20||!Number.isFinite(s.cutoffSeconds)||s.cutoffSeconds<=s.delaySeconds||s.cutoffSeconds>60||!Number.isFinite(s.weight)||s.weight<.1||s.weight>5)throw Error('Invalid room progress judge settings. Cutoff must be longer than the grace period.');
  if(['loopGuard','blindReverse','antiJitter'].some(k=>s[k as 'loopGuard']!==undefined&&typeof s[k as 'loopGuard']!=='boolean'))throw Error('Invalid loop / reverse / jitter settings.');
  const window=s.jitterWindowSeconds??4,weight=s.jitterWeight??2;
  if(!Number.isFinite(window)||window<2||window>10||!Number.isFinite(weight)||weight<.1||weight>10)throw Error('Invalid room jitter window / weight.');
  return {...s,loopGuard:s.loopGuard??true,blindReverse:s.blindReverse??true,antiJitter:s.antiJitter??true,jitterWindowSeconds:window,jitterWeight:weight};
}
export type SearchMotion={visualSearch:boolean;reverse:boolean;targetVisible:boolean;heading?:number;drive?:number};
/** External training labels, never controller inputs or deployable odometry.
 * Heading changes and repeated RGB views do not count as new territory.
 * Visual search never consults a hidden target's position or distance.
 */
export class SearchJudge{
  readonly visited=new Set<string>();readonly credited=new Set<string>();
  seconds=0;pain=0;penalty=0;disqualified=false;reason='warming up';looping=false;blindReverseSeconds=0;
  jitterActive=false;jitterSeconds=0;jitterPain=0;jitterPenalty=0;reversalCount=0;motionTravelCm=0;motionNetCm=0;
  private lastTick=0;private progressTick=0;private bestCue=0;private goals=0;
  private motionJudge=new ParkingMotionJudge();private lastPose={x:0,z:0,heading:0};private approachTick=0;private jitterHold=0;
  private route:{x:number;y:number;tick:number}[]=[];private loopStart=0;
  constructor(readonly settings:SearchJudgeSettings,readonly cellSize=32){}
  reset(x:number,y:number,tick=0,goals=0):void{
    this.motionJudge=new ParkingMotionJudge();this.lastPose={x:x*CM_PER_PIXEL/100,z:y*CM_PER_PIXEL/100,heading:0};this.approachTick=tick;this.jitterHold=0;this.jitterActive=false;this.jitterSeconds=this.jitterPain=this.jitterPenalty=this.reversalCount=this.motionTravelCm=this.motionNetCm=0;
    this.visited.clear();this.visit(x,y);this.credited.clear();this.route=[{x,y,tick}];this.looping=false;this.loopStart=tick;this.blindReverseSeconds=0;this.seconds=0;this.pain=0;this.penalty=0;this.disqualified=false;this.reason='exploring';this.lastTick=this.progressTick=tick;this.bestCue=0;this.goals=goals;
  }
  get cells(){return this.visited.size;}
  get coverageReward(){return this.settings.enabled?Math.min(40,this.credited.size)*.5:0;}
  private visit(x:number,y:number):boolean{
    const key=`${Math.round(x/this.cellSize)},${Math.round(y/this.cellSize)}`;
    if(this.visited.has(key))return false;
    this.visited.add(key);return true;
  }
  private checkLoop(x:number,y:number,tick:number):void{
    if(tick-this.route.at(-1)!.tick<15)return;
    this.route.push({x,y,tick});while(this.route.length>49)this.route.shift();
    let length=0,turn=0,previousAngle:number|undefined,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(let i=0;i<this.route.length;i++){
      const p=this.route[i];minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);
      if(i===0)continue;const q=this.route[i-1],d=Math.hypot(p.x-q.x,p.y-q.y);if(d<.5)continue;
      const a=Math.atan2(p.y-q.y,p.x-q.x);length+=d;
      if(previousAngle!==undefined)turn+=Math.abs(Math.atan2(Math.sin(a-previousAngle),Math.cos(a-previousAngle)));previousAngle=a;
    }
    const first=this.route[0];
    this.looping=(tick-first.tick)/30>=4&&length>=this.cellSize*4&&turn>=Math.PI*1.5&&Math.hypot(x-first.x,y-first.y)/length<.35&&Math.hypot(maxX-minX,maxY-minY)<this.cellSize*10;
    if(this.looping){this.loopStart=first.tick;for(const key of this.credited){const [cx,cy]=key.split(',').map(Number);if(cx*this.cellSize>=minX-this.cellSize&&cx*this.cellSize<=maxX+this.cellSize&&cy*this.cellSize>=minY-this.cellSize&&cy*this.cellSize<=maxY+this.cellSize)this.credited.delete(key);}}
  }
  observe(x:number,y:number,tick:number,goalProgress:number,goals:number,success:boolean,contacts:number,motion?:SearchMotion):{pain:number;penalty:number}{
    if(tick<=this.lastTick||this.disqualified)return {pain:0,penalty:0};
    const dt=(tick-this.lastTick)/30;this.lastTick=tick;
    if(!this.settings.enabled){this.reason='off';return {pain:0,penalty:0};}
    if(success){this.seconds=0;this.jitterActive=false;this.jitterHold=0;this.reason='goal completed';return {pain:0,penalty:0};}
    const fresh=this.visit(x,y),advance=goalProgress>this.bestCue+.025||goals>this.goals;
    if(advance)this.bestCue=goalProgress;
    if(goals>this.goals){this.goals=goals;this.bestCue=goalProgress;}
    if(advance)this.approachTick=tick;
    const window=this.settings.jitterWindowSeconds??4;
    if(motion){
      const pose={x:x*CM_PER_PIXEL/100,z:y*CM_PER_PIXEL/100,heading:motion.heading??this.lastPose.heading};
      const report=this.motionJudge.observe(tick,this.lastPose,pose,motion.drive??(motion.reverse?-1:1),window,advance);this.lastPose=pose;
      this.reversalCount=report.reversals;this.motionTravelCm=report.travelCm;this.motionNetCm=report.netCm;
      // Reversing while exploring or making a multi-point approach is valid.
      // A sustained low-net rocking cycle is not progress, even with moving RGB.
      this.jitterActive=(this.settings.antiJitter!==false||this.settings.zeroChill)&&report.oscillating&&report.netCm<Math.max(4,report.travelCm*.25)&&report.netCm<this.cellSize*CM_PER_PIXEL*2&&tick-this.approachTick>=window*30;
    }else this.jitterActive=false;
    let jitterCost=0;
    if(this.jitterActive){
      this.jitterSeconds+=dt;this.jitterHold+=dt;jitterCost=Math.min(10,(this.settings.jitterWeight??2)*this.settings.weight*2**Math.min(10,this.jitterHold/2))*dt;
      this.jitterPain+=jitterCost;this.jitterPenalty+=jitterCost;
      for(const key of this.credited){const [cx,cy]=key.split(',').map(Number);if(Math.hypot(cx*this.cellSize-x,cy*this.cellSize-y)<=this.cellSize*2)this.credited.delete(key);}
    }else this.jitterHold=0;
    const blind=this.settings.blindReverse!==false&&motion?.visualSearch&&motion.reverse&&!advance;
    this.blindReverseSeconds=blind?this.blindReverseSeconds+dt:0;
    if(this.settings.loopGuard!==false)this.checkLoop(x,y,tick);
    if(advance){this.route=[{x,y,tick}];this.looping=false;}
    if(fresh&&!blind&&!this.looping&&!this.jitterActive){this.credited.add(`${Math.round(x/this.cellSize)},${Math.round(y/this.cellSize)}`);this.progressTick=tick;}
    if(advance)this.progressTick=tick;
    this.seconds=Math.max((tick-this.progressTick)/30,this.looping?(tick-this.loopStart)/30:0,this.blindReverseSeconds);
    const scale=this.settings.weight*Math.min(8,2**Math.min(10,Math.max(0,this.seconds-this.settings.delaySeconds)/4));
    const active=this.seconds>this.settings.delaySeconds;
    const pain=(active?.04*scale*dt:0)+jitterCost,penalty=(active?.5*scale*dt:0)+jitterCost;
    this.pain+=pain;this.penalty+=penalty;
    this.reason=this.jitterActive?'forward / reverse jitter without progress':this.looping?'localized orbit / repeated arc':blind?(motion?.targetVisible?'reverse without target approach':'blind reverse search'):active?'revisiting / no new progress':'exploring';
    if(this.settings.zeroChill&&(contacts>0||this.seconds>=this.settings.cutoffSeconds||this.jitterHold>=2)){
      this.disqualified=true;this.reason=contacts>0?'contact':this.jitterHold>=2?'persistent forward / reverse jitter':this.looping?'localized orbit':blind?'sustained blind reverse':'no-progress loop / idle';
    }
    return {pain,penalty};
  }
}
