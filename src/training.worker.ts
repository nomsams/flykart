import {trainParking} from './parking/training';
import {trainCameraController} from './vision/browser-training';
import {trainWorldController} from './vision/world/training';
import {registerTrack} from './vision/proceduralTracks';
import {capturePreview,type TrainingSession} from './training-preview';
import type {GenerationCheckpoint} from './evolution-checkpoint';
import type {TrainingControls,TrainingJob,WorkerRequest,WorkerReply} from './training-worker-protocol';
import type {ParkingDonor} from './parking/gene-pool';

const port=globalThis as unknown as {postMessage:(message:WorkerReply)=>void;onmessage:((event:MessageEvent<WorkerRequest>)=>void)|null};
let controls:TrainingControls,cancelled=false,started=false,checkpointId=0,previewId=0,lastPreview=-Infinity,lastProgress=-Infinity;
let donors:ParkingDonor[]=[];let lastBatch:{sessions:TrainingSession[];generation:number;seed:number}|null=null;
const ids=new WeakMap<TrainingSession,number>(),acks=new Map<number,{resolve:()=>void;reject:(e:Error)=>void}>();
const visible=(g:number)=>controls.visible&&(controls.preview[g]??controls.preview[0]);
const rate=(g:number)=>controls.rates[controls.visible?g:0]??controls.rates[0];
const checkpoint=(c:GenerationCheckpoint)=>new Promise<void>((resolve,reject)=>{const id=++checkpointId;acks.set(id,{resolve,reject});port.postMessage({type:'checkpoint',id,checkpoint:c});});
function progress(sessions:TrainingSession[],generation:number,seed=0,force=false){
  lastBatch={sessions,generation,seed};
  const now=performance.now();if(!force&&now-lastProgress<200&&ids.has(sessions[0])&&sessions.some(s=>!s.done))return;lastProgress=now;const detailed=force||visible(generation)&&now-lastPreview>=200;if(detailed)lastPreview=now;
  const rows=sessions.map(s=>{if(!ids.has(s))ids.set(s,++previewId);return capturePreview(s,ids.get(s)!,detailed,force||generation===0&&detailed);});
  port.postMessage({type:'progress',rows,generation,seed});
}
async function run(job:TrainingJob){
  const log=(text:string)=>port.postMessage({type:'log',text}),cancel=()=>cancelled;
  try{
    let report;
    if(job.kind==='parking')report=await trainParking(job.brain,job.settings,{...job,getSpeed:rate,getGenePool:()=>donors,preview:visible,cancel,log,progress,onMetrics:metrics=>port.postMessage({type:'parking-metrics',metrics}),onGeneration:checkpoint});
    else if(job.kind==='track'){
      job.tracks.forEach(registerTrack);
      report=await trainCameraController(job.settings,job.generations,job.population,cancel,log,progress,job.speed,job.maps,()=>controls.visible?controls.budget:{workMs:32,idleMs:0},checkpoint);
    }else report=await trainWorldController(job.settings,job.generations,job.population,job.crashWeight,cancel,log,progress,job.speed,job.coach,job.retain,()=>controls.visible?controls.budget:{workMs:32,idleMs:0},{seed:job.seed,failureRetries:job.failureRetries,runId:job.runId,getSpeed:rate,breeding:job.breeding,ancestors:job.ancestors,recoveryState:job.recoveryState,getGenePool:()=>donors,onPopulation:population=>port.postMessage({type:'world-population',population}),onMetrics:metrics=>port.postMessage({type:'world-metrics',metrics}),onRecovery:recovery=>port.postMessage({type:'world-recovery',recovery}),onGeneration:checkpoint});
    if(lastBatch)progress(lastBatch.sessions,lastBatch.generation,lastBatch.seed,true);
    port.postMessage({type:'result',report});
  }catch(e){port.postMessage({type:'error',message:(e as Error).message});}
}
port.onmessage=({data})=>{
  if(data.type==='ack'){const a=acks.get(data.id);acks.delete(data.id);if(data.error)a?.reject(new Error(data.error));else a?.resolve();}
  else if(data.type==='controls')controls=data.controls;
  else if(data.type==='cancel')cancelled=true;
  else if(data.type==='gene-pool')donors=data.donors;
  else if(!started){started=true;controls=data.controls;void run(data.job);}
};
