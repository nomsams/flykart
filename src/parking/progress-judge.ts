import {DEFAULT_SEARCH_JUDGE,validateSearchJudge,type SearchJudgeSettings} from '../vision/world/search-judge';
import type {ParkingSettings} from './model';
/** Only the shared futile-motion/contact policy travels; parking task rewards stay local. */
export function parkingProgressJudge(s:ParkingSettings):SearchJudgeSettings{
  return validateSearchJudge({...DEFAULT_SEARCH_JUDGE,enabled:s.progressPenalty||s.antiJiggle||s.strictCrash,zeroChill:s.strictCrash,blindReverse:false,loopGuard:false,antiJitter:s.antiJiggle,jitterWindowSeconds:s.jiggleWindowSeconds,jitterWeight:s.jiggleWeight,cutoffSeconds:Math.max(7,s.eradicatorSeconds),weight:Math.min(5,s.painRewardWeight)});
}
export function applyParkingProgressJudge(s:ParkingSettings,raw:unknown):ParkingSettings{
  if(raw===undefined)return s;const j=validateSearchJudge(raw);
  return {...s,progressPenalty:j.enabled,antiJiggle:j.enabled&&j.antiJitter!==false,strictCrash:j.enabled&&j.zeroChill,jiggleWindowSeconds:j.jitterWindowSeconds!,jiggleWeight:j.jitterWeight!,eradicatorSeconds:j.cutoffSeconds,painRewardWeight:j.weight};
}
