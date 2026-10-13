import {parkingTradeoff,parkingSelectionScore,type ParkingTradeoff} from './selection';
export {parkingFitness} from './selection';
import type {GenerationCheckpoint} from '../evolution-checkpoint';
import {Action,BrainSnapshot,SpikingNetwork,createMutationPopulation} from '../core';
import {mulberry32} from '../vision/rng';
import {runCohort} from '../vision/cohort';
import {LESSONS,Lesson,ParkingSettings,validateParkingSettings} from './model';
import {ParkingBrain,ParkingSession} from './session';
import {ParkingResult} from './episode';
import {mixParkingDonors,validateParkingPool,type ParkingDonor} from './gene-pool';

export type ParkingTrial={seed:number;lesson:Lesson};
export type ParkingGenerationMetrics={generation:number;metrics:ParkingTradeoff[];winner:number};
export type DrivingExample={inputs:number[];target:Action};
export function coachChild(parent:SpikingNetwork,examples:DrivingExample[]):SpikingNetwork{
  if(examples.length>2000||examples.some(e=>!e||e.inputs.length!==parent.inputCount||e.inputs.some(v=>!Number.isFinite(v))||!e.target||!Number.isFinite(e.target.steer)||Math.abs(e.target.steer)>1||[e.target.throttle,e.target.brake,e.target.reverse??0].some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('Invalid manual sensor/action examples.');
  const child=parent.clone();
  for(let pass=0;pass<3;pass++){child.reset();for(const e of examples)child.trainActionReadout(e.inputs,e.target,.012/(pass+1));}
  child.reset();return child;
}
export type ParkingTrainingReport={format:'flykart-parking-training';version:1;settings:ParkingSettings;seed:number;generations:number;population:number;lessons:Lesson[];manualExamples:number;brain:BrainSnapshot;trials:{generation:number;scenarios:ParkingTrial[];results:ParkingResult[][];winner:number;metrics?:ParkingTradeoff[];genePool?:Omit<ParkingDonor,'controller'|'original'>[];donorParents?:Array<string|null>}[];validation:{scenarios:ParkingTrial[];parent:ParkingResult[];offspring:ParkingResult[];passed:boolean};memoryProtocol:string;inputAudit:string};
export async function trainParking(brain:ParkingBrain,settings:ParkingSettings,options:{generations:number;population:number;lessons:Lesson[];seed:number;speed:number;getSpeed?:(generation:number)=>number;preview?:(generation:number)=>boolean;getGenePool?:()=>ParkingDonor[];cancel:()=>boolean;log:(text:string)=>void;progress:(sessions:ParkingSession[],generation:number)=>void;demonstrations?:DrivingExample[];onMetrics?:(m:ParkingGenerationMetrics)=>void;onGeneration?:(c:GenerationCheckpoint)=>void|Promise<void>}):Promise<ParkingTrainingReport|null>{
  validateParkingSettings(settings);
  if(!Number.isInteger(options.seed)||options.seed<1||options.seed>999999999||![0,1,4,16,64,256].includes(options.speed)||options.lessons.some(l=>!LESSONS.some(v=>v.id===l)))throw Error('Invalid training seed, speed or lesson.');
  if(settings.phase==='frozen')throw Error('Frozen tests cannot evolve a controller. Choose shaped or sparse rewards.');
  if(!options.lessons.length||!Number.isInteger(options.generations)||options.generations<1||options.generations>1000||!Number.isInteger(options.population)||options.population<2||options.population>32)throw Error('Choose lessons, 1–1,000 generations and 2–32 ghosts.');
  options.log(`Breeding objective: ${settings.selection} · score / speed / safety weights ${settings.scoreWeight} / ${settings.speedWeight} / ${settings.safetyWeight}. Completed parking and crash disqualification remain enforced.`);
  const random=mulberry32(options.seed),used=new Set<number>(),fresh=()=>{let seed;do{seed=1+Math.floor(random()*999999998);}while(used.has(seed));used.add(seed);return seed;};
  const heldOut=options.lessons.map(lesson=>({lesson,seed:fresh()})),parent=SpikingNetwork.fromJSON(brain.controller);let champion=parent.clone();
  const trials:ParkingTrainingReport['trials']=[],demonstrations=options.demonstrations??[];
  const coached=demonstrations.length?coachChild(parent,demonstrations):null;
  if(coached)options.log(`Manual coach: ${demonstrations.length} sensor/action examples seed one child; the original parent remains candidate 1.`);
  const evaluate=async(networks:BrainSnapshot[],scenarios:ParkingTrial[],generation:number)=>{
    const results:ParkingResult[][]=networks.map(()=>[]);
    for(const scenario of scenarios){
      const sessions=networks.map((controller,index)=>new ParkingSession({...settings,...scenario},{...brain,controller},{learn:generation>0,diagnostics:()=>index<6&&(options.preview?.(generation)??true)}));
      options.log(`Generation ${generation} · ${scenario.lesson} · fresh lot seed ${scenario.seed} · ${networks.length} independent ghosts`);
      if(!await runCohort(sessions,options.cancel,s=>options.progress(s,generation),()=>options.getSpeed?.(generation)??options.speed,()=>({workMs:options.preview?.(generation)===false?32:12,idleMs:0})))return null;
      sessions.forEach((s,i)=>results[i].push(s.episode.result()));
    }return results;
  };
  let poolSource:ParkingDonor[]|undefined,pool:ParkingDonor[]=[];
  for(let g=1;g<=options.generations;g++){
    const next=options.getGenePool?.();if(next!==poolSource){pool=validateParkingPool(next??[]);poolSource=next;options.log(`Generation ${g} gene pool · ${pool.length} donor(s). Changes during a trial enter the next generation.`);}
    // Two new shared seeds for the current lesson plus rotating rehearsal; imported target coordinates are never reused.
    const scenarios:ParkingTrial[]=[{lesson:settings.lesson,seed:fresh()},{lesson:options.lessons[(g-1)%options.lessons.length],seed:fresh()}];
    const mutationSeed=options.seed+g*503,candidates=createMutationPopulation(options.population,champion,mutationSeed,.18,.25),donorParents=mixParkingDonors(candidates,champion,pool,mutationSeed,g);
    if(coached&&g===1){candidates[1]=coached;donorParents[1]=null;}
    const genePool=pool.map(({controller:_,original:__,...meta})=>meta);
    const results=await evaluate(candidates.map(n=>n.toJSON()),scenarios,g);if(!results)return null;
    const metrics=results.map(rows=>parkingTradeoff(rows,scenarios,settings)),average=(rows:ParkingResult[])=>parkingSelectionScore(metrics[results.indexOf(rows)],settings);let winner=-1;
    results.forEach((rows,i)=>{options.log(`Ghost ${i+1}${rows.some(r=>r.disqualified)?' · DISQUALIFIED ('+rows.filter(r=>r.disqualified).map(r=>r.eradicationReason??'rejected').join(', ')+')':''}: ${rows.filter(r=>r.success).length}/${rows.length} parks · score ${average(rows).toFixed(1)} · contacts ${rows.reduce((a,r)=>a+r.contacts,0)}`);if(!rows.some(r=>r.disqualified)&&(winner<0||average(rows)>average(results[winner])))winner=i;});
    if(winner>=0)champion=candidates[winner];else options.log('Zero tolerance: every ghost rejected; previous parent retained, no rejected winner saved.');trials.push({generation:g,scenarios,results,winner,metrics,genePool,donorParents});
    options.onMetrics?.({generation:g,metrics,winner});
    if(winner>=0)await options.onGeneration?.({brain:champion.toJSON(),generation:g,winner,score:average(results[winner]),training:{task:settings.lesson,runSeed:options.seed,mutationSeed,cue:settings.cue,phase:settings.phase,lessons:[...options.lessons],scenarios,settings:{...settings},population:options.population,manualExamples:demonstrations.length,selection:settings.selection,tradeoffs:metrics,genePool,donorParents,selectedDonor:donorParents[winner],execution:{speed:options.getSpeed?.(g)??options.speed,preview:options.preview?.(g)??true}}});
  }
  const validation=await evaluate([parent.toJSON(),champion.toJSON()],heldOut,0);if(!validation)return null;
  // Every selected earlier lesson must retain success count and avoid a substantial score regression.
  const passed=!validation[1].some(r=>r.disqualified)&&trials.some(t=>t.winner>=0)&&validation[0].every((r,i)=>!r.success||validation[1][i].success)&&parkingSelectionScore(parkingTradeoff(validation[1],heldOut,settings),settings)>=parkingSelectionScore(parkingTradeoff(validation[0],heldOut,settings),settings)-20;
  options.log(`Held-out mixed curriculum: ${passed?'PASS · offspring can be adopted':'FAIL · keep the parent'}; parent ${validation[0].filter(r=>r.success).length}/${heldOut.length}, offspring ${validation[1].filter(r=>r.success).length}/${heldOut.length}.`);
  return{format:'flykart-parking-training',version:1,settings:{...settings},seed:options.seed,generations:options.generations,population:options.population,lessons:[...options.lessons],manualExamples:demonstrations.length,brain:champion.toJSON(),trials,validation:{scenarios:heldOut,parent:validation[0],offspring:validation[1],passed},memoryProtocol:settings.memoryOn?'Every ghost begins with independent fresh memory and learns only its own visual estimates during its training trial. Held-out trials begin with fresh frozen memory. Live retained-memory practice is separate. No pose-indexed memory.':'Kenyon recall and learning are disabled for all training and held-out trials. Stored live memory is preserved but never queried. Camera and sonar remain active as configured.',inputAudit:(settings.gapHints?'Chassis-aware hints 15/16 use camera-estimated ranges, the chassis width and motor-model speed; no geometry or scan map. ':'Legacy World hints 15/16 retained. ')+(settings.bayPractice?'Seeded centered bay-entry and straight-back exit practice is enabled; initial poses are teaching setup, not added goal inputs. ':'')+'Camera estimates + sonar + motor-model speed estimate/last requests. Visual mode observes flag bearing/size and painted-marker direction from processed RGB only; compass mode explicitly supplies relative goal bearing/distance/orientation. No collision, reward, target world coordinates, path-coach route or diagnostic map inputs. Optional radius/reverse/path bonuses and no-progress costs are external judge labels, included in the score used for selection. Combined feedback tracks pain and immediate negative reward separately, including oscillation and eradication reasons. The external motion judge detects sustained direction reversals without new progress; zero chill disqualifies futile motion as well as crashes. Optional slow-driving costs use actual displacement as external labels outside the target safe zone; no actual-body speed is added to the neural inputs. Headless execution skips diagnostic maps, trails and effects, keeping inference and sensor acquisition timing identical.'};
}
