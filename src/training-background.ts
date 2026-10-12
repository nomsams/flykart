import type {WorldPopulation,WorldGeneration,WorldRecovery} from './vision/world/breeding';
import {TRACKS} from './core';
import {TrainingPreviews} from './training-preview';
import type {TrainingSession} from './training-preview';
import type {TrainingControls,TrainingJob,TrainingReport,WorkerRequest,WorkerReply} from './training-worker-protocol';
import type {GenerationCheckpoint} from './evolution-checkpoint';
import type {ParkingSession} from './parking/session';
import type {ParkingTrainingReport,ParkingGenerationMetrics,trainParking} from './parking/training';
import type {TrackSession,WorldSession} from './vision/ui/sessions';
import type {trainCameraController,CameraTrainingResult} from './vision/browser-training';
import type {trainWorldController,WorldTrainingResult} from './vision/world/training';
import type {ParkingDonor} from './parking/gene-pool';

type Callbacks={worldPopulation?:(p:WorldPopulation)=>void;worldMetrics?:(m:WorldGeneration)=>void|Promise<void>;worldRecovery?:(r:WorldRecovery)=>void;cancel:()=>boolean;log:(text:string)=>void;progress:(s:TrainingSession[],generation:number,seed:number)=>void;metrics?:(m:ParkingGenerationMetrics)=>void;checkpoint?:(c:GenerationCheckpoint)=>void|Promise<void>;genePool?:()=>ParkingDonor[];controls:()=>TrainingControls};
/** All simulation/inference/selection lives in the worker. Window timers and paint callbacks never gate it. */
function background(job:TrainingJob,callbacks:Callbacks):Promise<TrainingReport>{
  if(typeof Worker==='undefined')return Promise.reject(new Error('Background workers are unavailable. Use npm run parking:train for browser-free training.'));
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./training.worker.ts',import.meta.url),{type:'module',name:'FlyKart '+job.kind+' evolution'}),views=new TrainingPreviews(job);
    let finished=false,sentCancel=false;let worldEvents=Promise.resolve();
    let sentPool:ParkingDonor[]|undefined;
    const send=(data:WorkerRequest)=>worker.postMessage(data);
    const syncPool=()=>{const pool=callbacks.genePool?.();if(pool!==sentPool){sentPool=pool;send({type:'gene-pool',donors:pool??[]});}};
    const sync=()=>{if(finished)return;if(callbacks.cancel()&&!sentCancel){sentCancel=true;send({type:'cancel'});}syncPool();send({type:'controls',controls:callbacks.controls()});};
    // Native event listeners can run microtasks before the target's handler.
    // A message task observes the finished click/change, without hidden-tab timers.
    const controlEvents=new MessageChannel();controlEvents.port1.onmessage=sync;
    const event=()=>controlEvents.port2.postMessage(null);
    const cleanup=()=>{finished=true;worker.terminate();controlEvents.port1.close();controlEvents.port2.close();document.removeEventListener('visibilitychange',event);window.removeEventListener('change',event,true);window.removeEventListener('click',event,true);window.removeEventListener('flykart-genepool',event);};
    const fail=(error:unknown)=>{if(finished)return;cleanup();reject(error);};
    worker.onerror=e=>fail(new Error('Background training worker: '+e.message+' ('+e.filename+':'+e.lineno+')'));worker.onmessageerror=()=>fail(new Error('Unable to read a background training snapshot.'));
    worker.onmessage=({data}:MessageEvent<WorkerReply>)=>{
      if(finished)return;
      try{
        if(data.type==='log')callbacks.log(data.text);
        else if(data.type==='progress'){callbacks.progress(views.update(data.rows),data.generation,data.seed);}
        else if(data.type==='parking-metrics')callbacks.metrics?.(data.metrics);
        else if(data.type==='world-population')callbacks.worldPopulation?.(data.population);
        else if(data.type==='world-recovery')callbacks.worldRecovery?.(data.recovery);
        else if(data.type==='world-metrics'){worldEvents=worldEvents.then(()=>callbacks.worldMetrics?.(data.metrics));worldEvents.catch(fail);}
        else if(data.type==='checkpoint')worldEvents.then(()=>callbacks.checkpoint?.(data.checkpoint)).then(()=>{if(!finished)send({type:'ack',id:data.id});},e=>{if(!finished)send({type:'ack',id:data.id,error:(e as Error).message});});
        else if(data.type==='result'){worldEvents.then(()=>{cleanup();resolve(data.report);},fail);}
        else fail(new Error(data.message));
      }catch(e){fail(e);}
    };
    document.addEventListener('visibilitychange',event);window.addEventListener('change',event,true);window.addEventListener('click',event,true);
    window.addEventListener('flykart-genepool',event);
    try{syncPool();send({type:'start',job,controls:callbacks.controls()});}catch(e){fail(e);}
  });
}
export function trainParkingBackground(brain:Parameters<typeof trainParking>[0],settings:Parameters<typeof trainParking>[1],options:Parameters<typeof trainParking>[2]):Promise<ParkingTrainingReport|null>{
  return background({kind:'parking',brain,settings,generations:options.generations,population:options.population,lessons:options.lessons,seed:options.seed,speed:options.speed,demonstrations:options.demonstrations},{cancel:options.cancel,log:options.log,progress:(s,g)=>options.progress(s as ParkingSession[],g),metrics:options.onMetrics,checkpoint:options.onGeneration,genePool:options.getGenePool,controls:()=>({visible:!document.hidden,preview:Array.from({length:options.generations+1},(_,g)=>options.preview?.(g)??true),rates:Array.from({length:options.generations+1},(_,g)=>options.getSpeed?.(g)??options.speed),budget:{workMs:32,idleMs:0}})}) as Promise<ParkingTrainingReport|null>;
}
export function trainCameraBackground(...args:Parameters<typeof trainCameraController>):Promise<CameraTrainingResult|null>{
  const [settings,generations,population,cancel,log,progress=()=>{},speed=0,maps=[settings.trackId],budget=()=>({workMs:12,idleMs:0}),checkpoint]=args;
  return background({kind:'track',settings:{...settings,memory:null},generations,population,speed,maps,tracks:TRACKS.filter(t=>maps.includes(t.id))},{cancel,log,progress:(s,g,seed)=>progress(s as TrackSession[],g,seed),checkpoint,controls:()=>({visible:!document.hidden,preview:Array(generations+1).fill([6,12].includes(budget().workMs)),rates:[speed],budget:budget()})}) as Promise<CameraTrainingResult|null>;
}
export function trainWorldBackground(...args:Parameters<typeof trainWorldController>):Promise<WorldTrainingResult|null>{
  const [settings,generations,population,crashWeight,cancel,log,progress,speed=0,coach=false,retain=true,budget=()=>({workMs:12,idleMs:0}),options={}]=args;
  return background({kind:'world',settings:{...settings,roomMemory:null},generations,population,speed,crashWeight,coach,retain,seed:options.seed??settings.seed,failureRetries:options.failureRetries??1,runId:options.runId,breeding:options.breeding,ancestors:options.ancestors,recoveryState:options.recoveryState},{worldPopulation:options.onPopulation,worldMetrics:options.onMetrics,worldRecovery:options.onRecovery,genePool:options.getGenePool,cancel,log,progress:(s,g,seed)=>progress(s as WorldSession[],g,seed),checkpoint:options.onGeneration,controls:()=>({visible:!document.hidden,preview:Array(generations+1).fill([6,12].includes(budget().workMs)),rates:[options.getSpeed?.(0)??speed],budget:budget()})}) as Promise<WorldTrainingResult|null>;
}
