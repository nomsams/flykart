import { BrainSnapshot, SpikingNetwork } from "../core";
import { TrackSession, TrackSettings } from "./ui/sessions";
import { runCohort } from './cohort';

export type CameraTrainingResult={brain:BrainSnapshot;score:number;generation:number;validation:{parent:number;offspring:number;seeds:number[]};trainingSeeds:number[];scoreDefinition:string};
/** Evolve a cohort behind frozen eyes, using the same seeds for every ghost. */
export async function trainCameraController(settings:TrackSettings,generations:number,population:number,cancelled:()=>boolean,log:(s:string)=>void,progress:(sessions:TrackSession[],generation:number,seed:number)=>void=()=>{},speed=0):Promise<CameraTrainingResult|null>{
  if(!settings.vision)throw new Error('Choose a camera network before training.');
  const limit=Math.min(3000,settings.maxTicks??1500),seeds=[101,307],heldOut=[9001,12007];
  const evaluate=async(brains:BrainSnapshot[],testSeeds:number[],generation:number)=>{
    const scores=brains.map(()=>0);
    for(const seed of testSeeds){
      const sessions=brains.map(controller=>new TrackSession({...settings,controller,seed,mode:'belief',fade:0,memory:null,sensorOnly:true,maxTicks:limit}));
      if(!await runCohort(sessions,cancelled,s=>progress(s,generation,seed),speed))return null;
      sessions.forEach((session,i)=>{const c=session.episode.car,target=settings.lapTarget??1;
        scores[i]+=(settings.rewardConfig?c.score:c.totalProgress/target*1000+(c.finished?500:0)-c.rewardTotals.collision*5-(c.crashed?300:0)-c.offTrackTicks/Math.max(1,c.ticks)*100+c.score*.01)/testSeeds.length;
      });
    }return scores;
  };
  let parent=SpikingNetwork.fromJSON(settings.controller),best=-Infinity;
  const count=Math.max(2,Math.min(16,population)),total=Math.max(1,Math.min(50,generations));
  for(let gen=0;gen<total;gen++){
    const candidates=Array.from({length:count},(_,i)=>i===0?parent.clone():parent.mutate(.12,.16,61001+gen*100+i));
    const scores=await evaluate(candidates.map(c=>c.toJSON()),seeds,gen+1);if(!scores)return null;
    let winner=0;scores.forEach((score,i)=>{log(`Generation ${gen+1}, ghost ${i+1}: ${score.toFixed(2)} (camera + enabled physical sensors only)`);if(score>scores[winner])winner=i;});
    best=scores[winner];parent=candidates[winner];log(`Generation ${gen+1}: selected ${best.toFixed(2)}. Camera weights unchanged.`);
  }
  const validation=await evaluate([settings.controller,parent.toJSON()],heldOut,0);if(!validation)return null;
  const [baseline,offspring]=validation;
  log(`Held-out paired scores: parent ${baseline.toFixed(2)}, offspring ${offspring.toFixed(2)}. ${offspring>baseline?'Offspring improved on this small test.':'No demonstrated improvement on this small test.'}`);
  return{scoreDefinition:settings.rewardConfig?"Sum of transferred racing rewards and penalties (car.score)":"Legacy progress/survival score plus default racing rewards",brain:parent.toJSON(),score:best,generation:total,trainingSeeds:seeds,validation:{parent:baseline,offspring,seeds:heldOut}};
}
