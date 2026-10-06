import { Action, BrainSnapshot, SpikingNetwork, clamp, wrapAngle } from '../../core';
import { runCohort } from '../cohort';
import { WorldSession, WorldSettings } from '../ui/sessions';

export type GoalResult={arrived:boolean;ticks:number;collisions:number;progress:number;goals?:number;goalTarget?:number;reverseDistance:number;crashed:boolean;found?:boolean;firstSightTick?:number|null;visualViews?:number;objective?:"sight"|"reach";won?:boolean};
/** Arrival dominates partial progress. No time bonus for dying early. */
export function goalScore(r:GoalResult,limit:number,crashWeight:number):number{
  const weight=Math.max(0,Math.min(1,crashWeight));
  const safety=1/(1+Math.max(0,r.collisions));
  if(r.arrived&&!r.crashed)return 1000+1000*((1-weight)*Math.max(0,1-r.ticks/limit)+weight*safety);
  return Math.max(0,Math.min(1,r.progress))*400-400*weight*(1-safety)-(r.crashed?200:0);
}
/** Successful searches outrank every failure; finding sooner determines the winner. No hidden-distance bonus. */
export function discoveryScore(r:GoalResult,limit:number):number {
  return r.won&&!r.crashed?10000+1000*Math.max(0,1-(r.objective==='reach'?r.ticks:r.firstSightTick??r.ticks)/limit)-Math.min(8,r.collisions)*.001:Math.min(64,r.visualViews??0)*.02-(r.crashed?2:0);
}
export function goalResult(s:WorldSession,initialDistance:number):GoalResult{
  const r=s.episode.sim.status;
  return{...(s.discovery?{found:s.found,firstSightTick:s.discovery.firstSightTick,visualViews:s.discovery.visualViews,objective:s.settings.searchWin??'sight',won:s.won}:{}),arrived:r.goals>=s.episode.sim.goalLimit&&!r.crashed,ticks:r.ticks,collisions:r.collisions,goals:r.goals,goalTarget:s.episode.sim.goalLimit,progress:s.discovery?0:(r.goals+Math.max(0,1-r.distanceToGoal/Math.max(1,initialDistance)))/s.episode.sim.goalLimit,reverseDistance:s.reverseDistance,crashed:r.crashed};
}
export type WorldTrainingResult={brain:BrainSnapshot;score:number;generation:number;crashWeight:number;trainingSeeds:number[];validation:{parent:number;offspring:number;seeds:number[];parentTrials:GoalResult[];offspringTrials:GoalResult[]};trials:GoalResult[];task:string;scoreDefinition:string;coachFrames:number};
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
      sessions.forEach((s,i)=>{const r=goalResult(s,distances[i]);trials[i].push(r);scores[i]+=(settings.task==='explore'?discoveryScore(r,limit):goalScore(r,limit,crashWeight))/testSeeds.length;});
    }return{scores,trials};
  };
  if(settings.task==='explore')log(`Explore & find · ${(settings.searchWin??'sight')==='sight'?'first confirmed sighting':'see then reach'} wins · processed RGB colour detector, no compass or pheromone · same seed for every ghost.`);
  let parent=SpikingNetwork.fromJSON(settings.controller),score=-Infinity,lastTrials:GoalResult[]=[];
  const primed=coach&&settings.task==='reverse'?await primeReverseReadout(settings,cancelled):null;
  if(cancelled())return null;if(primed)log(`Reverse demonstration: ${primed.frames} camera + goal-compass frames taught one child’s motor readout. Parent unchanged.`);
  for(let g=0;g<generations;g++){
    const candidates=Array.from({length:population},(_,i)=>i===0?parent.clone():g===0&&primed?(i===1?SpikingNetwork.fromJSON(primed.brain):SpikingNetwork.fromJSON(primed.brain).mutate(.18,.28,71001+i)):parent.mutate(.18,.28,71001+g*101+i));
    const batch=await evaluate(candidates.map(c=>c.toJSON()),seeds,g+1);if(!batch)return null;
    let winner=0;batch.scores.forEach((s,i)=>{log(`Room generation ${g+1} · ghost ${i+1}: ${s.toFixed(2)} · ${settings.task==='explore'?'finds/wins':'arrivals'} ${batch.trials[i].filter(t=>settings.task==='explore'?t.won:t.arrived).length}/${seeds.length} · contacts ${batch.trials[i].reduce((n,t)=>n+t.collisions,0)}`);if(s>batch.scores[winner])winner=i;});
    if(settings.task==='explore')log(`Search selected ghost ${winner+1} · first sight seconds ${batch.trials[winner].map(t=>t.firstSightTick===null||t.firstSightTick===undefined?'not found':(t.firstSightTick/30).toFixed(3)).join(', ')} · wins ${batch.trials[winner].filter(t=>t.won).length}/${seeds.length}`);
    parent=candidates[winner];score=batch.scores[winner];lastTrials=batch.trials[winner];
  }
  const validation=await evaluate([settings.controller,parent.toJSON()],heldOut,0);if(!validation)return null;
  log(`Held-out room scores · parent ${validation.scores[0].toFixed(2)} · offspring ${validation.scores[1].toFixed(2)}. ${settings.world?'Same imported layout, new headings/light; geometry generalization not tested.':'Two unseen seeded layouts/headings.'}`);
  return{coachFrames:primed?.frames??0,brain:parent.toJSON(),score,generation:generations,crashWeight,task:settings.task??'forage',trainingSeeds:seeds,validation:{parent:validation.scores[0],offspring:validation.scores[1],seeds:heldOut,parentTrials:validation.trials[0],offspringTrials:validation.trials[1]},trials:lastTrials,scoreDefinition:settings.task==='explore'?'Search success: 10000 + 1000 × remaining time fraction at first confirmed visual sighting (or arrival after sighting), minus 0.001 × contacts as a tie-break. Failure: at most 1.28 points for distinct coarse RGB views, minus 2 on fatal crash. No distance/progress reward, goal compass, pheromone or hidden target position in inputs. Two consecutive fresh processed-camera frames confirm a pink colour component; not a learned target head. Neural mission slots: pixel bearing / pi and apparent size, zero when unseen. Fresh independent memory; common training seeds and held-out trials.':'Arrival: 1000 + 1000 × ((1 − crashWeight) × remaining time fraction + crashWeight / (1 + contacts)). Failure: partial progress × 400 − contact cost − 200 if crashed. Fixed target set (collect both in two-dot mode); fresh visual memory per trial; explicit goal compass; no reward or collision labels in neural inputs.'};
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
