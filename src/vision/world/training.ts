import type { CohortBudget } from '../runtime-budget';
import { Action, BrainSnapshot, SpikingNetwork, clamp, wrapAngle } from '../../core';
import { worldExpert } from './worldDomain';
import { runCohort } from '../cohort';
import { WorldSession, WorldSettings } from '../ui/sessions';

export type GoalResult={arrived:boolean;ticks:number;collisions:number;pain?:number;stallPain?:number;progress:number;goals?:number;goalTarget?:number;reverseDistance:number;crashed:boolean;found?:boolean;firstSightTick?:number|null;visualViews?:number;objective?:"sight"|"reach";won?:boolean};
/** Arrival dominates partial progress. No time bonus for dying early. */
export function goalScore(r:GoalResult,limit:number,crashWeight:number):number{
  const weight=Math.max(0,Math.min(1,crashWeight));
  const safety=1/(1+Math.max(0,r.pain??r.collisions));
  if(r.arrived&&!r.crashed)return 1000+1000*((1-weight)*Math.max(0,1-r.ticks/limit)+weight*safety);
  return Math.max(0,Math.min(1,r.progress))*400-400*weight*(1-safety)-(r.crashed?200:0);
}
/** Successful searches outrank every failure; the speed / impact slider ranks successful searches. No hidden-distance bonus. */
export function discoveryScore(r:GoalResult,limit:number,crashWeight=0):number {
  const weight=Math.max(0,Math.min(1,crashWeight)),pain=Math.max(0,r.pain??r.collisions);
  const speed=Math.max(0,Math.min(1,1-(r.objective==='reach'?r.ticks:r.firstSightTick??r.ticks)/limit));
  return r.won&&!r.crashed?10000+1000*((1-weight)*speed+weight/(1+pain))-Math.min(8,pain)*.001:Math.min(64,r.visualViews??0)*.02-(r.crashed?2:0);
}
export function goalResult(s:WorldSession,initialDistance:number):GoalResult{
  const r=s.episode.sim.status;
  return{...(s.discovery?{found:s.found,firstSightTick:s.discovery.firstSightTick,visualViews:s.discovery.visualViews,objective:s.settings.searchWin??'sight',won:s.won}:{}),arrived:r.goals>=s.episode.sim.goalLimit&&!r.crashed,ticks:r.ticks,collisions:r.collisions,pain:r.pain,stallPain:s.stallPain,goals:r.goals,goalTarget:s.episode.sim.goalLimit,progress:s.discovery?0:(r.goals+Math.max(0,1-r.distanceToGoal/Math.max(1,initialDistance)))/s.episode.sim.goalLimit,reverseDistance:s.reverseDistance,crashed:r.crashed};
}
export type RetentionResult={parent:number;offspring:number;parentTrials:GoalResult[];offspringTrials:GoalResult[];passed:boolean};
/** Preserve arrival count; allow at most 20 points per trial of score regression. */
export function retainsForward(parent:GoalResult[],child:GoalResult[],limit:number,weight:number):boolean {
  return child.filter(t=>t.arrived&&!t.crashed).length>=parent.filter(t=>t.arrived&&!t.crashed).length&&child.reduce((s,t)=>s+goalScore(t,limit,weight),0)>=parent.reduce((s,t)=>s+goalScore(t,limit,weight),0)-20*parent.length;
}
export type WorldTrainingResult={brain:BrainSnapshot;score:number;generation:number;crashWeight:number;trainingSeeds:number[];validation:{parent:number;offspring:number;seeds:number[];parentTrials:GoalResult[];offspringTrials:GoalResult[]};retention?:RetentionResult;trials:GoalResult[];task:string;scoreDefinition:string;coachFrames:number};
export async function trainWorldController(settings:WorldSettings,generations:number,population:number,crashWeight:number,cancelled:()=>boolean,log:(line:string)=>void,progress:(sessions:WorldSession[],generation:number,seed:number)=>void,speed=0,coach=false,retain=true,budget?:()=>CohortBudget):Promise<WorldTrainingResult|null>{
  if(!settings.vision)throw Error('Open world training requires a world camera network.');
  const seeds=[settings.seed,settings.seed+103],heldOut=[settings.seed+9001,settings.seed+12007],limit=settings.maxTicks??900;
  // The imported layout is retained; held-out seeds change heading and lighting, not its geometry.
  const evaluate=async(brains:BrainSnapshot[],testSeeds:number[],generation:number,forward=false)=>{
    const scores=brains.map(()=>0),trials:GoalResult[][]=brains.map(()=>[]);
    for(const seed of testSeeds){
      const start=settings.start?{...settings.start,heading:settings.start.heading+(seed-settings.seed)*.173}:undefined;
      const sessions=brains.map(controller=>new WorldSession({...settings,start,controller,seed,kind:'vision',fade:0,sensorOnly:true,roomMemory:undefined,...(forward?{task:'forage' as const,practiceForward:true,goalPreset:'near' as const}:{})}));
      const distances=sessions.map(s=>s.episode.sim.status.distanceToGoal);
      if(!await runCohort(sessions,cancelled,s=>progress(s,generation,seed),speed,budget))return null;
      sessions.forEach((s,i)=>{const r=goalResult(s,distances[i]);trials[i].push(r);scores[i]+=(settings.task==='explore'?discoveryScore(r,limit,crashWeight)-s.stallPain*12:goalScore(r,limit,crashWeight))/testSeeds.length;});
    }return{scores,trials};
  };
  if(settings.task==='explore')log(`Explore & find · ${(settings.searchWin??'sight')==='sight'?'first confirmed sighting':'see then reach'} wins · processed RGB colour detector, no compass or pheromone · same seed for every ghost.`);
  let parent=SpikingNetwork.fromJSON(settings.controller),score=-Infinity,lastTrials:GoalResult[]=[];
  const protect=retain&&settings.task==='reverse';
  const primed=coach&&settings.task!=='explore'?await primeReverseReadout(settings,cancelled,protect,budget):null;
  if(cancelled())return null;if(primed)log(`${protect?'Mixed forward / reverse rehearsal':settings.task==='reverse'?'Reverse specialist demonstration':'Forward navigation rehearsal'}: ${primed.frames} camera + goal-compass frames taught one child’s motor readout. Parent unchanged.`);
  for(let g=0;g<generations;g++){
    const candidates=Array.from({length:population},(_,i)=>i===0?parent.clone():g===0&&primed?(i===1?SpikingNetwork.fromJSON(primed.brain):SpikingNetwork.fromJSON(primed.brain).mutate(.18,.28,71001+i)):parent.mutate(.18,.28,71001+g*101+i));
    const batch=await evaluate(candidates.map(c=>c.toJSON()),seeds,g+1);if(!batch)return null;
    const rehearsal=protect?await evaluate(candidates.map(c=>c.toJSON()),seeds,g+1,true):null;if(protect&&!rehearsal)return null;
    let winner=0;batch.scores.forEach((s,i)=>{log(`Room generation ${g+1} · ghost ${i+1}: ${s.toFixed(2)} · ${settings.task==='explore'?'finds/wins':'arrivals'} ${batch.trials[i].filter(t=>settings.task==='explore'?t.won:t.arrived).length}/${seeds.length} · contacts ${batch.trials[i].reduce((n,t)=>n+t.collisions,0)}`);if(s>batch.scores[winner])winner=i;});
    if(settings.task==='explore')log(`Search selected ghost ${winner+1} · first sight seconds ${batch.trials[winner].map(t=>t.firstSightTick===null||t.firstSightTick===undefined?'not found':(t.firstSightTick/30).toFixed(3)).join(', ')} · wins ${batch.trials[winner].filter(t=>t.won).length}/${seeds.length}`);
    if(rehearsal){winner=0;for(let i=1;i<candidates.length;i++)if(retainsForward(rehearsal.trials[0],rehearsal.trials[i],limit,crashWeight)&&batch.scores[i]>batch.scores[winner])winner=i;log(`Forward retention · selected ghost ${winner+1}; forward score ${rehearsal.scores[winner].toFixed(2)} vs current parent ${rehearsal.scores[0].toFixed(2)}. Reverse-only regressions rejected.`);}
    parent=candidates[winner];score=batch.scores[winner];lastTrials=batch.trials[winner];
  }
  const validation=await evaluate([settings.controller,parent.toJSON()],heldOut,0);if(!validation)return null;
  const check=protect?await evaluate([settings.controller,parent.toJSON()],heldOut,0,true):null;if(protect&&!check)return null;
  const retention=check?{parent:check.scores[0],offspring:check.scores[1],parentTrials:check.trials[0],offspringTrials:check.trials[1],passed:retainsForward(check.trials[0],check.trials[1],limit,crashWeight)}:undefined;
  if(retention)log(`Held-out forward retention ${retention.passed?'PASS':'FAIL · adoption blocked'} · parent ${retention.parent.toFixed(2)}, offspring ${retention.offspring.toFixed(2)}.`);
  log(`Held-out room scores · parent ${validation.scores[0].toFixed(2)} · offspring ${validation.scores[1].toFixed(2)}. ${settings.world?'Same imported layout, new headings/light; geometry generalization not tested.':'Two unseen seeded layouts/headings.'}`);
  return{retention,coachFrames:primed?.frames??0,brain:parent.toJSON(),score,generation:generations,crashWeight,task:settings.task??'forage',trainingSeeds:seeds,validation:{parent:validation.scores[0],offspring:validation.scores[1],seeds:heldOut,parentTrials:validation.trials[0],offspringTrials:validation.trials[1]},trials:lastTrials,scoreDefinition:settings.task==='explore'?'Search success: 10000 + 1000 × ((1 − crashWeight) × remaining time fraction at first confirmed visual sighting (or arrival after sighting) + crashWeight / (1 + impact pain)), minus 0.001 × impact pain as a tie-break. Failure: at most 1.28 points for distinct coarse RGB views, minus 2 on fatal crash. No distance/progress reward, goal compass, pheromone or hidden target position in inputs. Two consecutive fresh processed-camera frames confirm a pink colour component; not a learned target head. Neural mission slots: pixel bearing / pi and apparent size, zero when unseen. Fresh independent memory; common training seeds and held-out trials.':'Arrival: 1000 + 1000 × ((1 − crashWeight) × remaining time fraction + crashWeight / (1 + impact pain)). Failure: partial progress × 400 − contact cost − 200 if crashed. Fixed target set (collect both in two-dot mode); fresh visual memory per trial; explicit goal compass; no reward or collision labels in neural inputs.'};
}

/** Motor-only imitation. The coach sees exactly the same estimated inputs; no reward labels enter the learner. */
export function reverseCoach(inputs:ArrayLike<number>):Action{
  const error=wrapAngle(inputs[0]*Math.PI+Math.PI);
  return {steer:-clamp(error/.45,-1,1),throttle:0,brake:inputs[11]>.03?1:0,reverse:inputs[11]>.03?0:.8};
}
async function primeReverseReadout(settings:WorldSettings,cancelled:()=>boolean,mixed:boolean,budget?:()=>CohortBudget):Promise<{brain:BrainSnapshot;frames:number}|null>{
  const student=SpikingNetwork.fromJSON(settings.controller),rows:{input:number[];action:Action}[][]=[];
  for(const seed of [settings.seed,settings.seed+103])for(const forward of settings.task==='reverse'?(mixed?[true,false]:[false]):[true]){
    const session=new WorldSession({...settings,seed,kind:'vision',sensorOnly:true,fade:0,roomMemory:undefined,maxTicks:300,...(forward?{task:'forage',practiceForward:true,goalPreset:'near'}:{})});
    const demo:{input:number[];action:Action}[]=[];
    while(!session.done){
      if(cancelled())return null;
      const frame=session.driver!.act(session.episode),teacher=forward?worldExpert(frame.sensors):reverseCoach(frame.sensors);
      demo.push({input:[...frame.sensors],action:teacher});session.episode.step(teacher);
      if(demo.length%12===0)await new Promise<void>(r=>setTimeout(r,budget?.().idleMs??0));
    }rows.push(demo);
  }
  // Rehearse complete trajectories with independent recurrent state. Rear and
  // forward examples stay balanced; finish each epoch on a forward trajectory.
  let frames=0;student.reset();
  const ordered=mixed?[rows[1],rows[0],rows[3],rows[2]]:rows;
  for(let epoch=0;epoch<3;epoch++)for(const demo of ordered){student.reset();for(const row of demo){if(cancelled())return null;student.trainActionReadout(row.input,row.action,.012/(epoch+1));frames++;}await new Promise<void>(r=>setTimeout(r,budget?.().idleMs??0));}
  return{brain:student.toJSON(),frames};
}
