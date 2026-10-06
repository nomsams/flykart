import { Action, BrainSnapshot, SpikingNetwork, clamp, wrapAngle } from '../../core';
import { runCohort } from '../cohort';
import { WorldSession, WorldSettings } from '../ui/sessions';

export type GoalResult={arrived:boolean;ticks:number;collisions:number;progress:number;goals?:number;goalTarget?:number;reverseDistance:number;crashed:boolean};
/** Arrival dominates partial progress. No time bonus for dying early. */
export function goalScore(r:GoalResult,limit:number,crashWeight:number):number{
  const weight=Math.max(0,Math.min(1,crashWeight));
  const safety=1/(1+Math.max(0,r.collisions));
  if(r.arrived&&!r.crashed)return 1000+1000*((1-weight)*Math.max(0,1-r.ticks/limit)+weight*safety);
  return Math.max(0,Math.min(1,r.progress))*400-400*weight*(1-safety)-(r.crashed?200:0);
}
export function goalResult(s:WorldSession,initialDistance:number):GoalResult{
  const r=s.episode.sim.status;
  return{arrived:r.goals>=s.episode.sim.goalLimit&&!r.crashed,ticks:r.ticks,collisions:r.collisions,goals:r.goals,goalTarget:s.episode.sim.goalLimit,progress:(r.goals+Math.max(0,1-r.distanceToGoal/Math.max(1,initialDistance)))/s.episode.sim.goalLimit,reverseDistance:s.reverseDistance,crashed:r.crashed};
}
export type WorldTrainingResult={brain:BrainSnapshot;score:number;generation:number;crashWeight:number;trainingSeeds:number[];validation:{parent:number;offspring:number;seeds:number[]};trials:GoalResult[];task:string;scoreDefinition:string;coachFrames:number};
export async function trainWorldController(settings:WorldSettings,generations:number,population:number,crashWeight:number,cancelled:()=>boolean,log:(line:string)=>void,progress:(sessions:WorldSession[],generation:number,seed:number)=>void,speed=0,coach=false):Promise<WorldTrainingResult|null>{
  if(!settings.vision)throw Error('Open world training requires a world camera network.');
  const seeds=[settings.seed,settings.seed+103],heldOut=[settings.seed+9001,settings.seed+12007],limit=settings.maxTicks??900;
  // The imported layout is retained; held-out seeds change heading and lighting, not its geometry.
  const evaluate=async(brains:BrainSnapshot[],testSeeds:number[],generation:number)=>{
    const scores=brains.map(()=>0),trials:GoalResult[][]=brains.map(()=>[]);
    for(const seed of testSeeds){
      const start=settings.start?{...settings.start,heading:settings.start.heading+(seed-settings.seed)*.173}:undefined;
      const sessions=brains.map(controller=>new WorldSession({...settings,start,controller,seed,kind:'vision',fade:0,sensorOnly:true,roomMemory:undefined}));
      const distances=sessions.map(s=>s.episode.sim.status.distanceToGoal);
      if(!await runCohort(sessions,cancelled,s=>progress(s,generation,seed),speed))return null;
      sessions.forEach((s,i)=>{const r=goalResult(s,distances[i]);trials[i].push(r);scores[i]+=goalScore(r,limit,crashWeight)/testSeeds.length;});
    }return{scores,trials};
  };
  let parent=SpikingNetwork.fromJSON(settings.controller),score=-Infinity,lastTrials:GoalResult[]=[];
  const primed=coach&&settings.task==='reverse'?await primeReverseReadout(settings,cancelled):null;
  if(cancelled())return null;if(primed)log(`Reverse demonstration: ${primed.frames} camera + goal-compass frames taught one child’s motor readout. Parent unchanged.`);
  for(let g=0;g<generations;g++){
    const candidates=Array.from({length:population},(_,i)=>i===0?parent.clone():g===0&&primed?(i===1?SpikingNetwork.fromJSON(primed.brain):SpikingNetwork.fromJSON(primed.brain).mutate(.18,.28,71001+i)):parent.mutate(.18,.28,71001+g*101+i));
    const batch=await evaluate(candidates.map(c=>c.toJSON()),seeds,g+1);if(!batch)return null;
    let winner=0;batch.scores.forEach((s,i)=>{log(`Room generation ${g+1} · ghost ${i+1}: ${s.toFixed(2)} · arrivals ${batch.trials[i].filter(t=>t.arrived).length}/${seeds.length} · contacts ${batch.trials[i].reduce((n,t)=>n+t.collisions,0)}`);if(s>batch.scores[winner])winner=i;});
    parent=candidates[winner];score=batch.scores[winner];lastTrials=batch.trials[winner];
  }
  const validation=await evaluate([settings.controller,parent.toJSON()],heldOut,0);if(!validation)return null;
  log(`Held-out room scores · parent ${validation.scores[0].toFixed(2)} · offspring ${validation.scores[1].toFixed(2)}. ${settings.world?'Same imported layout, new headings/light; geometry generalization not tested.':'Two unseen seeded layouts/headings.'}`);
  return{coachFrames:primed?.frames??0,brain:parent.toJSON(),score,generation:generations,crashWeight,task:settings.task??'forage',trainingSeeds:seeds,validation:{parent:validation.scores[0],offspring:validation.scores[1],seeds:heldOut},trials:lastTrials,scoreDefinition:'Arrival: 1000 + 1000 × ((1 − crashWeight) × remaining time fraction + crashWeight / (1 + contacts)). Failure: partial progress × 400 − contact cost − 200 if crashed. Fixed target set (collect both in two-dot mode); fresh visual memory per trial; explicit goal compass; no reward or collision labels in neural inputs.'};
}

/** Motor-only imitation. The coach sees exactly the same estimated inputs; no reward labels enter the learner. */
export function reverseCoach(inputs:ArrayLike<number>):Action{
  const error=wrapAngle(inputs[0]*Math.PI+Math.PI);
  return {steer:-clamp(error/.45,-1,1),throttle:0,brake:inputs[11]>.03?1:0,reverse:inputs[11]>.03?0:.8};
}
async function primeReverseReadout(settings:WorldSettings,cancelled:()=>boolean):Promise<{brain:BrainSnapshot;frames:number}|null>{
  const student=SpikingNetwork.fromJSON(settings.controller);let frames=0;
  for(const seed of [settings.seed,settings.seed+103]){
    const session=new WorldSession({...settings,seed,kind:'vision',sensorOnly:true,fade:0,roomMemory:undefined,maxTicks:300});student.reset();
    while(!session.done){
      if(cancelled())return null;
      const frame=session.driver!.act(session.episode),teacher=reverseCoach(frame.sensors);
      student.trainActionReadout(frame.sensors,teacher,.018);session.episode.step(teacher);frames++;
      if(frames%12===0)await new Promise<void>(r=>setTimeout(r,0));
    }
  }
  return{brain:student.toJSON(),frames};
}
