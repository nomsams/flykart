import type {GenerationCheckpoint} from '../evolution-checkpoint';
import {Action,BrainSnapshot,SpikingNetwork,createMutationPopulation} from '../core';
import {mulberry32} from '../vision/rng';
import {runCohort} from '../vision/cohort';
import {LESSONS,Lesson,ParkingSettings,validateParkingSettings} from './model';
import {ParkingBrain,ParkingSession} from './session';
import {ParkingResult} from './episode';

export type ParkingTrial={seed:number;lesson:Lesson};
export type DrivingExample={inputs:number[];target:Action};
export function coachChild(parent:SpikingNetwork,examples:DrivingExample[]):SpikingNetwork{
  if(examples.length>2000||examples.some(e=>!e||e.inputs.length!==parent.inputCount||e.inputs.some(v=>!Number.isFinite(v))||!e.target||!Number.isFinite(e.target.steer)||Math.abs(e.target.steer)>1||[e.target.throttle,e.target.brake,e.target.reverse??0].some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('Invalid manual sensor/action examples.');
  const child=parent.clone();
  for(let pass=0;pass<3;pass++){child.reset();for(const e of examples)child.trainActionReadout(e.inputs,e.target,.012/(pass+1));}
  child.reset();return child;
}
export type ParkingTrainingReport={format:'flykart-parking-training';version:1;settings:ParkingSettings;seed:number;generations:number;population:number;lessons:Lesson[];manualExamples:number;brain:BrainSnapshot;trials:{generation:number;scenarios:ParkingTrial[];results:ParkingResult[][];winner:number}[];validation:{scenarios:ParkingTrial[];parent:ParkingResult[];offspring:ParkingResult[];passed:boolean};memoryProtocol:string;inputAudit:string};
export function parkingFitness(r:ParkingResult):number{return r.success?1000+r.score:Math.min(99,r.quality*30+r.score)-r.pedestrianHits*1000;}
export async function trainParking(brain:ParkingBrain,settings:ParkingSettings,options:{generations:number;population:number;lessons:Lesson[];seed:number;speed:number;cancel:()=>boolean;log:(text:string)=>void;progress:(sessions:ParkingSession[],generation:number)=>void;demonstrations?:DrivingExample[];onGeneration?:(c:GenerationCheckpoint)=>void|Promise<void>}):Promise<ParkingTrainingReport|null>{
  validateParkingSettings(settings);
  if(!Number.isInteger(options.seed)||options.seed<1||options.seed>999999999||![0,1,4,16].includes(options.speed)||options.lessons.some(l=>!LESSONS.some(v=>v.id===l)))throw Error('Invalid training seed, speed or lesson.');
  if(settings.phase==='frozen')throw Error('Frozen tests cannot evolve a controller. Choose shaped or sparse rewards.');
  if(!options.lessons.length||!Number.isInteger(options.generations)||options.generations<1||options.generations>50||!Number.isInteger(options.population)||options.population<2||options.population>16)throw Error('Choose lessons, 1–50 generations and 2–16 ghosts.');
  const random=mulberry32(options.seed),used=new Set<number>(),fresh=()=>{let seed;do{seed=1+Math.floor(random()*999999998);}while(used.has(seed));used.add(seed);return seed;};
  const heldOut=options.lessons.map(lesson=>({lesson,seed:fresh()})),parent=SpikingNetwork.fromJSON(brain.controller);let champion=parent.clone();
  const trials:ParkingTrainingReport['trials']=[],demonstrations=options.demonstrations??[];
  const coached=demonstrations.length?coachChild(parent,demonstrations):null;
  if(coached)options.log(`Manual coach: ${demonstrations.length} sensor/action examples seed one child; the original parent remains candidate 1.`);
  const evaluate=async(networks:BrainSnapshot[],scenarios:ParkingTrial[],generation:number)=>{
    const results:ParkingResult[][]=networks.map(()=>[]);
    for(const scenario of scenarios){
      const sessions=networks.map(controller=>new ParkingSession({...settings,...scenario},{...brain,controller},{learn:generation>0}));
      options.log(`Generation ${generation} · ${scenario.lesson} · fresh lot seed ${scenario.seed} · ${networks.length} independent ghosts`);
      if(!await runCohort(sessions,options.cancel,s=>options.progress(s,generation),options.speed,()=>({workMs:10,idleMs:options.speed===0?2:0})))return null;
      sessions.forEach((s,i)=>results[i].push(s.episode.result()));
    }return results;
  };
  for(let g=1;g<=options.generations;g++){
    // Two new shared seeds for the current lesson plus rotating rehearsal; imported target coordinates are never reused.
    const scenarios:ParkingTrial[]=[{lesson:settings.lesson,seed:fresh()},{lesson:options.lessons[(g-1)%options.lessons.length],seed:fresh()}];
    const candidates=createMutationPopulation(options.population,champion,options.seed+g*503,.18,.25);if(coached&&g===1)candidates[1]=coached;
    const results=await evaluate(candidates.map(n=>n.toJSON()),scenarios,g);if(!results)return null;
    const average=(rows:ParkingResult[])=>rows.reduce((a,r)=>a+parkingFitness(r),0)/rows.length;let winner=0;
    results.forEach((rows,i)=>{options.log(`Ghost ${i+1}: ${rows.filter(r=>r.success).length}/${rows.length} parks · score ${average(rows).toFixed(1)} · contacts ${rows.reduce((a,r)=>a+r.contacts,0)}`);if(average(rows)>average(results[winner]))winner=i;});
    champion=candidates[winner];trials.push({generation:g,scenarios,results,winner});
    await options.onGeneration?.({brain:champion.toJSON(),generation:g,winner,score:average(results[winner]),training:{task:settings.lesson,runSeed:options.seed,mutationSeed:options.seed+g*503,cue:settings.cue,phase:settings.phase,lessons:[...options.lessons],scenarios,settings:{...settings},population:options.population,manualExamples:demonstrations.length}});
  }
  const validation=await evaluate([parent.toJSON(),champion.toJSON()],heldOut,0);if(!validation)return null;
  // Every selected earlier lesson must retain success count and avoid a substantial score regression.
  const passed=validation[0].every((r,i)=>!r.success||validation[1][i].success)&&validation[1].reduce((a,r)=>a+parkingFitness(r),0)>=validation[0].reduce((a,r)=>a+parkingFitness(r),0)-20*heldOut.length;
  options.log(`Held-out mixed curriculum: ${passed?'PASS · offspring can be adopted':'FAIL · keep the parent'}; parent ${validation[0].filter(r=>r.success).length}/${heldOut.length}, offspring ${validation[1].filter(r=>r.success).length}/${heldOut.length}.`);
  return{format:'flykart-parking-training',version:1,settings:{...settings},seed:options.seed,generations:options.generations,population:options.population,lessons:[...options.lessons],manualExamples:demonstrations.length,brain:champion.toJSON(),trials,validation:{scenarios:heldOut,parent:validation[0],offspring:validation[1],passed},memoryProtocol:'Every ghost begins with independent fresh memory and learns only its own visual estimates during its training trial. Held-out trials begin with fresh frozen memory. Live retained-memory practice is separate. No pose-indexed memory.',inputAudit:'Camera estimates + sonar + motor-model speed estimate/last requests. Visual mode observes flag bearing/size and painted-marker direction from processed RGB only; compass mode explicitly supplies relative goal bearing/distance/orientation. No collision, reward, target world coordinates or diagnostic map inputs.'};
}
