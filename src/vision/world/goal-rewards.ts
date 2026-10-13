export type GoalRewards={noseFirst:boolean;noseBonus:number;adaptiveTime:boolean;secondsPerGoal:number;growthSeconds:number};
export const DEFAULT_GOAL_REWARDS:GoalRewards={noseFirst:false,noseBonus:30,adaptiveTime:false,secondsPerGoal:10,growthSeconds:5};
export function validateGoalRewards(raw:unknown):GoalRewards{
  if(raw===undefined)return {...DEFAULT_GOAL_REWARDS};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid goal reward settings.');
  const s={...DEFAULT_GOAL_REWARDS,...raw} as GoalRewards;
  if(typeof s.noseFirst!=='boolean'||typeof s.adaptiveTime!=='boolean')throw Error('Invalid goal reward switches.');
  for(const [key,min,max] of [['noseBonus',0,100],['secondsPerGoal',1,60],['growthSeconds',0,30]] as const){
    const v=s[key];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(`Invalid goal reward ${key}.`);
  }
  return {noseFirst:s.noseFirst,noseBonus:s.noseBonus,adaptiveTime:s.adaptiveTime,secondsPerGoal:s.secondsPerGoal,growthSeconds:s.growthSeconds};
}
/** Award only an actual forward arrival facing the collected target, never a sighting. */
export function noseArrivalBonus(s:GoalRewards,heading:number,speed:number,dx:number,dy:number):number{
  const distance=Math.hypot(dx,dy);
  return s.noseFirst&&speed>.5&&distance>1e-6&&(Math.cos(heading)*dx+Math.sin(heading)*dy)/distance>=Math.SQRT1_2?s.noseBonus:0;
}
/** Bounded collection count makes extensions finite; last goal needs no extension. */
export function goalTimeBonus(s:GoalRewards,collected:number,limit:number):number{
  return s.adaptiveTime&&collected>0&&collected<limit?Math.round(30*(s.secondsPerGoal+(collected-1)*s.growthSeconds)):0;
}
