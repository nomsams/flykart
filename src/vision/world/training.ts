import {transferContract} from './transfer';
import {RecoveryLedger,worldPopulation,validateWorldBreeding,worldBreedingContext,type WorldBreeding,type WorldAncestor,type WorldRecoveryState,type WorldPopulation,type WorldGeneration,type WorldRecovery} from './breeding';
import {validateParkingPool,type ParkingDonor} from '../../parking/gene-pool';
import {validateSearchJudge} from './search-judge';
import type {GenerationCheckpoint} from '../../evolution-checkpoint';
import type { CohortBudget } from '../runtime-budget';
import { Action, BrainSnapshot, SpikingNetwork, clamp, wrapAngle } from '../../core';
import { mulberry32 } from '../rng';
import { worldExpert } from './worldDomain';
import { runCohort } from '../cohort';
import { WorldSession, WorldSettings } from '../ui/sessions';
import { TargetCurriculum, TargetTrial } from './target-curriculum';

export type GoalResult={arrived:boolean;ticks:number;collisions:number;pain?:number;stallPain?:number;progress:number;goals?:number;goalTarget?:number;reverseDistance:number;crashed:boolean;found?:boolean;firstSightTick?:number|null;visualViews?:number;objective?:"sight"|"reach";won?:boolean;coverageCells?:number;coverageReward?:number;noProgressPain?:number;noProgressPenalty?:number;noProgressSeconds?:number;disqualified?:boolean;rejectionReason?:string};
/** Arrival dominates partial progress. No time bonus for dying early. */
export function goalScore(r:GoalResult,limit:number,crashWeight:number):number{
  if(r.disqualified)return -1000000;
  const penalty=Math.max(0,r.noProgressPenalty??0);
  const weight=Math.max(0,Math.min(1,crashWeight));
  const safety=1/(1+Math.max(0,r.pain??r.collisions));
  if(r.arrived&&!r.crashed)return 1000+1000*((1-weight)*Math.max(0,1-r.ticks/limit)+weight*safety)-Math.min(200,penalty);
  return Math.max(0,Math.min(1,r.progress))*400-400*weight*(1-safety)-(r.crashed?200:0)-penalty;
}
/** Successful searches outrank every failure; the speed / impact slider ranks successful searches. No hidden-distance bonus. */
export function discoveryScore(r:GoalResult,limit:number,crashWeight=0):number {
  if(r.disqualified)return -1000000;
  const penalty=Math.max(0,r.noProgressPenalty??0);
  const weight=Math.max(0,Math.min(1,crashWeight)),pain=Math.max(0,r.pain??r.collisions);
  const speed=Math.max(0,Math.min(1,1-(r.objective==='reach'?r.ticks:r.firstSightTick??r.ticks)/limit));
  return r.won&&!r.crashed?10000+1000*((1-weight)*speed+weight/(1+pain))-Math.min(8,pain)*.001-Math.min(200,penalty):Math.min(64,r.visualViews??0)*.02+Math.min(20,r.coverageReward??0)-(r.crashed?2:0)-penalty;
}
export function goalResult(s:WorldSession,initialDistance:number):GoalResult{
  const r=s.episode.sim.status;
  const judge=s.searchJudge;
  return{coverageCells:judge.cells,coverageReward:judge.coverageReward,noProgressPain:judge.pain,noProgressPenalty:judge.penalty,noProgressSeconds:judge.seconds,disqualified:judge.disqualified,...(judge.disqualified?{rejectionReason:judge.reason}:{}),...(s.discovery?{found:s.found,firstSightTick:s.discovery.firstSightTick,visualViews:s.discovery.visualViews,objective:s.settings.searchWin??'sight',won:s.won}:{}),arrived:!judge.disqualified&&r.goals>=s.episode.sim.goalLimit&&!r.crashed,ticks:r.ticks,collisions:r.collisions,pain:r.pain+judge.pain,stallPain:s.stallPain,goals:r.goals,goalTarget:s.episode.sim.goalLimit,progress:s.discovery?0:(r.goals+Math.max(0,1-r.distanceToGoal/Math.max(1,initialDistance)))/s.episode.sim.goalLimit,reverseDistance:s.reverseDistance,crashed:r.crashed};
}
export type RetentionResult={parent:number;offspring:number;parentTrials:GoalResult[];offspringTrials:GoalResult[];passed:boolean};
/** Preserve arrival count; allow at most 20 points per trial of score regression. */
export function retainsForward(parent:GoalResult[],child:GoalResult[],limit:number,weight:number):boolean {
  return child.filter(t=>t.arrived&&!t.crashed).length>=parent.filter(t=>t.arrived&&!t.crashed).length&&child.reduce((s,t)=>s+goalScore(t,limit,weight),0)>=parent.reduce((s,t)=>s+goalScore(t,limit,weight),0)-20*parent.length;
}
export type WorldTargetTrial=TargetTrial&{generation:number;phase:'training'|'validation'|'forward';start:{x:number;y:number;heading:number};targets:{x:number;y:number}[]};
export type WorldTrainingOptions={seed?:number;failureRetries?:number;runId?:string;breeding?:WorldBreeding;ancestors?:WorldAncestor[];recoveryState?:WorldRecoveryState;getSpeed?:(generation:number)=>number;getGenePool?:()=>ParkingDonor[];onPopulation?:(p:WorldPopulation)=>void;onMetrics?:(m:WorldGeneration)=>void|Promise<void>;onRecovery?:(r:WorldRecovery)=>void;onGeneration?:(c:GenerationCheckpoint)=>void|Promise<void>};
export type WorldTrainingResult={transfer:ReturnType<typeof transferContract>;targetSeed:number;failureRetries:number;targetTrials:WorldTargetTrial[];brain:BrainSnapshot;score:number;generation:number;crashWeight:number;trainingSeeds:number[];validation:{passed:boolean;parent:number;offspring:number;seeds:number[];parentTrials:GoalResult[];offspringTrials:GoalResult[]};retention?:RetentionResult;trials:GoalResult[];task:string;scoreDefinition:string;coachFrames:number;viableGenerations:number;attemptedGenerations:number;searchJudge:ReturnType<typeof validateSearchJudge>};
export async function trainWorldController(settings:WorldSettings,generations:number,population:number,crashWeight:number,cancelled:()=>boolean,log:(line:string)=>void,progress:(sessions:WorldSession[],generation:number,seed:number)=>void,speed=0,coach=false,retain=true,budget?:()=>CohortBudget,options:WorldTrainingOptions={}):Promise<WorldTrainingResult|null>{
  if(!settings.vision)throw Error('Open world training requires a world camera network.');
  const judgeSettings=validateSearchJudge(settings.searchJudge);
  settings={...settings,searchJudge:judgeSettings};
  let viableGenerations=0,lastWinnerGeneration=0;
  const curriculum=new TargetCurriculum(options.seed??settings.seed,options.failureRetries??1);
  const heldOut=[curriculum.fresh(),curriculum.fresh()],limit=settings.maxTicks??900;
  const trainingSeeds:number[]=[],targetTrials:WorldTargetTrial[]=[];
  // Scene replay preserves saved dots. Evolution preserves the room, but samples new dots.
  const evaluate=async(brains:BrainSnapshot[],scenarios:TargetTrial[],generation:number,forward=false)=>{
    const scores=brains.map(()=>0),trials:GoalResult[][]=brains.map(()=>[]);
    for(const scenario of scenarios){
      const {seed}=scenario;
      const start=settings.start?{...settings.start,heading:wrapAngle(settings.start.heading+(mulberry32(seed)()*2-1)*Math.PI)}:undefined;
      const sessions=brains.map(controller=>new WorldSession({...settings,goals:undefined,start,controller,seed,kind:'vision',fade:0,sensorOnly:true,roomMemory:undefined,...(forward?{task:'forage' as const,practiceForward:true,goalPreset:'near' as const}:{})}));
      const targets=sessions[0].episode.sim.goals.map(g=>({...g}));
      targetTrials.push({...scenario,generation,phase:forward?'forward':generation===0?'validation':'training',start:{...sessions[0].initialPose},targets});
      log(`${forward?'Forward rehearsal':generation===0?'Held-out':`Generation ${generation}`} · ${scenario.retry?`failure retry ${scenario.retry}/${curriculum.failureRetries}`:'fresh targets'} · seed ${seed} · dots ${targets.map(g=>`(${g.x.toFixed(1)}, ${g.y.toFixed(1)})`).join(' ')}.`);
      const distances=sessions.map(s=>s.episode.sim.status.distanceToGoal);
      progress(sessions,generation,seed);
      if(!await runCohort(sessions,cancelled,s=>progress(s,generation,seed),()=>options.getSpeed?.(generation)??speed,budget))return null;
      sessions.forEach((s,i)=>{const r=goalResult(s,distances[i]);trials[i].push(r);scores[i]+=(!forward&&settings.task==='explore'?discoveryScore(r,limit,crashWeight)-s.stallPain*12:goalScore(r,limit,crashWeight))/scenarios.length;});
    }return{scores,trials};
  };
  log(`Random target curriculum · run seed ${curriculum.seed} · two fresh trials each generation + at most one failed-trial replay · ${curriculum.failureRetries} retries per failed trial. Imported saved dots are used for live scene replay only.`);
  if(settings.task==='explore')log(`Explore & find · ${(settings.searchWin??'sight')==='sight'?'first confirmed sighting':'see then reach'} wins · processed RGB colour detector, no compass or pheromone · same seed for every ghost.`);
  let parent=SpikingNetwork.fromJSON(settings.controller),lastAccepted=parent.clone(),score=-Infinity,lastTrials:GoalResult[]=[];
  const breeding=validateWorldBreeding(options.breeding),runId=options.runId??('world-'+curriculum.seed),root={id:runId+':root',brain:parent.toJSON()};
  const context=worldBreedingContext(settings,breeding,{crashWeight,coach,retain});
  const ancestors=(options.ancestors??[]).map(a=>({...a,brain:SpikingNetwork.fromJSON(a.brain).toJSON()})).filter(a=>a.brain.inputCount===parent.inputCount);
  const ledger=new RecoveryLedger(breeding,root,ancestors,options.recoveryState);let parentRef=root.id,scale=1,poolSource:ParkingDonor[]|undefined,pool:ParkingDonor[]=[];
  const protect=retain&&settings.task==='reverse';
  const primed=coach&&settings.task!=='explore'?await primeReverseReadout({...settings,goals:undefined},cancelled,protect,budget,[curriculum.fresh().seed,curriculum.fresh().seed]):null;
  if(cancelled())return null;if(primed)log(`${protect?'Mixed forward / reverse rehearsal':settings.task==='reverse'?'Reverse specialist demonstration':'Forward navigation rehearsal'}: ${primed.frames} camera + goal-compass frames taught one child’s motor readout. Parent unchanged.`);
  for(let g=0;g<generations;g++){
    const rolled=ledger.take();if(rolled){parent=SpikingNetwork.fromJSON(rolled.ancestor.brain);parentRef=rolled.ancestor.id;scale=rolled.recovery.mutationScale;options.onRecovery?.(rolled.recovery);log('WORLD_RECOVERY '+JSON.stringify(rolled.recovery));}
    const incoming=options.getGenePool?.();if(incoming!==poolSource){pool=validateParkingPool(incoming??[]);poolSource=incoming;log('World gene pool: '+pool.length+' donor(s), admitted at the generation boundary.');}
    const mutationSeed=(curriculum.seed+g*503+ledger.branch*7919)>>>0;
    const {brains:candidates,donorParents}=worldPopulation(parent,population,pool,mutationSeed,g+1,breeding,scale);
    if(g===0&&primed){candidates[1]=SpikingNetwork.fromJSON(primed.brain);donorParents[1]=null;}
    const generationParent=parentRef;
    options.onPopulation?.({generation:g+1,brains:candidates.map(n=>n.toJSON()),parent:generationParent,donorParents,mutationSeed,recovery:rolled?.recovery??null,donors:pool});
    const completed=async(winner:number,rows:{scores:number[];trials:GoalResult[][]})=>{
      const node=runId+':'+(g+1),brain=winner>=0?candidates[winner].toJSON():null,wins=winner>=0?rows.trials[winner].filter(t=>settings.task==='explore'?t.won:t.arrived).length:0;
      const milestone=ledger.complete(g+1,brain?{id:node,brain}:null,winner>=0?rows.scores[winner]:-1000000,Math.round(wins/Math.max(1,rows.trials[winner]?.length??1)*1000),brain?node:parentRef);
      await options.onMetrics?.({generation:g+1,winner,scores:rows.scores,trials:rows.trials,parent:generationParent,donorParents,node,brain,plateau:ledger.stale,milestone,recovery:rolled?.recovery??null,state:ledger.snapshot(),context});return node;
    };
    const scenarios=curriculum.next();trainingSeeds.push(...scenarios.map(t=>t.seed));
    const batch=await evaluate(candidates.map(c=>c.toJSON()),scenarios,g+1);if(!batch)return null;
    const rehearsal=protect?await evaluate(candidates.map(c=>c.toJSON()),scenarios,g+1,true):null;if(protect&&!rehearsal)return null;
    let winner=-1;batch.scores.forEach((s,i)=>{log(`Room generation ${g+1} · ghost ${i+1}: ${s.toFixed(2)} · ${settings.task==='explore'?'finds/wins':'arrivals'} ${batch.trials[i].filter(t=>settings.task==='explore'?t.won:t.arrived).length}/${scenarios.length} · contacts ${batch.trials[i].reduce((n,t)=>n+t.collisions,0)} · new-ground cells ${batch.trials[i].map(t=>t.coverageCells).join("/")} · no-progress cost ${batch.trials[i].reduce((n,t)=>n+(t.noProgressPenalty??0),0).toFixed(2)}${batch.trials[i].some(t=>t.disqualified)?" · DISQUALIFIED":""}`);if(!batch.trials[i].some(t=>t.disqualified)&&(winner<0||s>batch.scores[winner]))winner=i;});
    if(winner<0){log('Zero chill: all ghosts disqualified; previous parent retained, no rejected brain autosaved.');curriculum.remember(scenarios,scenarios.map(()=>false));lastTrials=batch.trials[0];score=batch.scores[0];await completed(-1,batch);continue;}
    if(settings.task==='explore')log(`Search selected ghost ${winner+1} · first sight seconds ${batch.trials[winner].map(t=>t.firstSightTick===null||t.firstSightTick===undefined?'not found':(t.firstSightTick/30).toFixed(3)).join(', ')} · wins ${batch.trials[winner].filter(t=>t.won).length}/${scenarios.length}`);
    if(rehearsal){winner=-1;for(let i=0;i<candidates.length;i++)if(!batch.trials[i].some(t=>t.disqualified)&&retainsForward(rehearsal.trials[0],rehearsal.trials[i],limit,crashWeight)&&(winner<0||batch.scores[i]>batch.scores[winner]))winner=i;if(winner<0){log('No eligible child retains forward skill; previous parent retained, no rejected brain autosaved.');curriculum.remember(scenarios,scenarios.map(()=>false));lastTrials=batch.trials[0];score=batch.scores[0];await completed(-1,batch);continue;}log(`Forward retention · selected ghost ${winner+1}; forward score ${rehearsal.scores[winner].toFixed(2)} vs current parent ${rehearsal.scores[0].toFixed(2)}. Reverse-only regressions rejected.`);}
    viableGenerations++;lastWinnerGeneration=g+1;
    curriculum.remember(scenarios,batch.trials[winner].map(t=>settings.task==='explore'?Boolean(t.won):t.arrived&&!t.crashed));
    parent=candidates[winner];lastAccepted=parent.clone();score=batch.scores[winner];lastTrials=batch.trials[winner];parentRef=await completed(winner,batch);
    await options.onGeneration?.({brain:parent.toJSON(),generation:g+1,winner,score,training:{transfer:transferContract(settings),task:settings.task??'forage',runSeed:curriculum.seed,failureRetries:curriculum.failureRetries,searchWin:settings.searchWin??'sight',goalPreset:settings.goalPreset,scenarios:targetTrials.filter(t=>t.generation===g+1),population,crashWeight,parentNode:generationParent,node:parentRef,donorParents,genePool:pool.map(({controller,original,...d})=>d),mutationSeed,breeding,recovery:rolled?.recovery??null,searchJudge:judgeSettings,ticks:limit,coachFrames:primed?.frames??0,retainForward:protect}});
  }
  parent=lastAccepted;
  options.onPopulation?.({generation:0,brains:[settings.controller,parent.toJSON()],parent:root.id,donorParents:[null,null],mutationSeed:0,recovery:null});
  const validation=await evaluate([settings.controller,parent.toJSON()],heldOut,0);if(!validation)return null;
  const check=protect?await evaluate([settings.controller,parent.toJSON()],heldOut,0,true):null;if(protect&&!check)return null;
  const retention=check?{parent:check.scores[0],offspring:check.scores[1],parentTrials:check.trials[0],offspringTrials:check.trials[1],passed:retainsForward(check.trials[0],check.trials[1],limit,crashWeight)}:undefined;
  if(retention)log(`Held-out forward retention ${retention.passed?'PASS':'FAIL · adoption blocked'} · parent ${retention.parent.toFixed(2)}, offspring ${retention.offspring.toFixed(2)}.`);
  log(`Held-out room scores · parent ${validation.scores[0].toFixed(2)} · offspring ${validation.scores[1].toFixed(2)}. ${settings.world?'Same imported layout, new targets/headings/light; geometry generalization not tested.':'Two unseen seeded layouts/headings.'}`);
  const testWins=(rows:GoalResult[])=>rows.filter(t=>settings.task==='explore'?t.won&&!t.disqualified:t.arrived&&!t.crashed&&!t.disqualified).length;
  const passed=testWins(validation.trials[1])>=testWins(validation.trials[0])&&validation.trials[1].filter(t=>t.disqualified||t.crashed).length<=validation.trials[0].filter(t=>t.disqualified||t.crashed).length&&validation.scores[1]>=validation.scores[0]-20;
  log(`Held-out adoption gate ${passed?'PASS':'FAIL · keep driving parent'} · preserve success / failure count and score within 20 points; simulation-only check.`);
  return{transfer:transferContract(settings),viableGenerations,attemptedGenerations:generations,targetSeed:curriculum.seed,failureRetries:curriculum.failureRetries,targetTrials,searchJudge:judgeSettings,retention,coachFrames:primed?.frames??0,brain:parent.toJSON(),score,generation:lastWinnerGeneration,crashWeight,task:settings.task??'forage',trainingSeeds,validation:{passed,parent:validation.scores[0],offspring:validation.scores[1],seeds:heldOut.map(t=>t.seed),parentTrials:validation.trials[0],offspringTrials:validation.trials[1]},trials:lastTrials,scoreDefinition:settings.task==='explore'?'Search success: 10000 + 1000 × ((1 − crashWeight) × remaining time fraction at first confirmed visual sighting (or arrival after sighting) + crashWeight / (1 + impact pain)), minus 0.001 × impact pain as a tie-break. Failure: at most 1.28 points for distinct coarse RGB views plus up to 20 points for new ground cells when the progress judge is enabled, minus escalating no-progress cost and 2 on fatal crash. Successful searches retain priority. Zero chill disqualifies contacts or sustained futile motion and excludes these candidates from breeding/autosaves. No distance/progress reward toward an unseen target, goal compass, pheromone or hidden target position in inputs. Two consecutive fresh processed-camera frames confirm a pink colour component; not a learned target head. Neural mission slots: pixel bearing / pi and apparent size, zero when unseen. Fresh independent memory and fresh random target trials each generation, shared fairly by all ghosts; bounded failure replays and independent held-out targets.':'Arrival: 1000 + 1000 × ((1 − crashWeight) × remaining time fraction + crashWeight / (1 + impact pain)). Failure: partial progress × 400 − contact cost − 200 if crashed. Fresh random target sets each generation (collect both in two-dot mode), shared fairly by all ghosts; bounded failure replays; fresh visual memory per trial; explicit goal compass; no reward or collision labels in neural inputs. Enabled external progress judge applies escalating pain/negative reward for no new ground, goal progress or collection; success deduction capped at 200. Zero chill disqualifies contacts or sustained futile motion; rejected brains never breed/autosave.'};
}

/** Motor-only imitation. The coach sees exactly the same estimated inputs; no reward labels enter the learner. */
export function reverseCoach(inputs:ArrayLike<number>):Action{
  const error=wrapAngle(inputs[0]*Math.PI+Math.PI);
  return {steer:-clamp(error/.45,-1,1),throttle:0,brake:inputs[11]>.03?1:0,reverse:inputs[11]>.03?0:.8};
}
async function primeReverseReadout(settings:WorldSettings,cancelled:()=>boolean,mixed:boolean,budget?:()=>CohortBudget,seeds=[settings.seed,settings.seed+103]):Promise<{brain:BrainSnapshot;frames:number}|null>{
  const student=SpikingNetwork.fromJSON(settings.controller),rows:{input:number[];action:Action}[][]=[];
  for(const seed of seeds)for(const forward of settings.task==='reverse'?(mixed?[true,false]:[false]):[true]){
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
