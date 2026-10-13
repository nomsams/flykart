import {SearchJudge,SearchJudgeSettings,validateSearchJudge,DEFAULT_SEARCH_JUDGE} from '../vision/world/search-judge';
import {CM_PER_PIXEL} from '../vision/robot';
import type {Pose} from './model';

/** Opt-in simulation labels. Never physical odometry or a neural observation. */
export const DEFAULT_TRIAL_JUDGE:SearchJudgeSettings={...DEFAULT_SEARCH_JUDGE,enabled:false,blindReverse:false};
export function trialJudgeSettings(raw:unknown):SearchJudgeSettings{return validateSearchJudge(raw??DEFAULT_TRIAL_JUDGE);}
export class RobotTrialJudge{
  readonly judge:SearchJudge;
  private baselineContacts=0;
  constructor(settings:SearchJudgeSettings,pose:Pose,contacts=0){this.judge=new SearchJudge(trialJudgeSettings(settings));this.reset(pose,0,contacts);}
  reset(p:Pose,time=0,contacts=0){this.baselineContacts=contacts;this.judge.reset(p.x*100/CM_PER_PIXEL,p.z*100/CM_PER_PIXEL,time*30);}
  observe(p:Pose,time:number,drive:number,cue:number,goals:number,success:boolean,contacts:number){
    const cost=this.judge.observe(p.x*100/CM_PER_PIXEL,p.z*100/CM_PER_PIXEL,time*30,cue,goals,success,Math.max(0,contacts-this.baselineContacts),{visualSearch:true,reverse:drive<-.05,targetVisible:cue>0,heading:p.heading,drive});
    return {...cost,disqualified:this.judge.disqualified,reason:this.judge.reason};
  }
}
