import { BrainSnapshot, SpikingNetwork } from "../core";
import { TrackSession, TrackSettings } from "./ui/sessions";

export type CameraTrainingResult={brain:BrainSnapshot;score:number;generation:number;validation:{parent:number;offspring:number;seeds:number[]};trainingSeeds:number[];scoreDefinition:string};
/** Evolve the controller behind frozen camera weights. Labels only select
 * offspring: VisionDriver.sensorOnly keeps them out of the neural inputs. */
export async function trainCameraController(settings:TrackSettings,generations:number,population:number,cancelled:()=>boolean,log:(s:string)=>void):Promise<CameraTrainingResult|null>{
  if(!settings.vision)throw new Error('Choose a camera network before training.');
  const limit=Math.min(3000,settings.maxTicks??1500), seeds=[101,307], heldOut=[9001,12007];
  const evaluate=async(brain:BrainSnapshot,testSeeds:number[])=>{
    let sum=0;
    for(const seed of testSeeds){
      if(cancelled())return null;
      const session=new TrackSession({...settings,controller:brain,seed,mode:'belief',fade:0,memory:null,sensorOnly:true,maxTicks:limit});
      let deadline=performance.now()+12;
      while(!session.done){session.step();if(performance.now()>deadline){await new Promise<void>(r=>setTimeout(r,0));if(cancelled())return null;deadline=performance.now()+12;}}
      const c=session.episode.car, target=settings.lapTarget??1;
      // No early-death pace bonus. Completion means all requested laps survived.
      sum+=settings.rewardConfig?c.score:c.totalProgress/target*1000+(c.finished?500:0)-c.rewardTotals.collision*5-(c.crashed?300:0)-c.offTrackTicks/Math.max(1,c.ticks)*100+c.score*.01;
    }return sum/testSeeds.length;
  };
  let parent=SpikingNetwork.fromJSON(settings.controller),best=-Infinity;
  for(let gen=0;gen<Math.max(1,Math.min(50,generations));gen++){
    let winner=parent;
    best=-Infinity;
    for(let i=0;i<Math.max(2,Math.min(16,population));i++){
      const candidate=i===0?parent.clone():parent.mutate(.12,.16,61001+gen*100+i);
      const score=await evaluate(candidate.toJSON(),seeds);if(score===null)return null;
      log(`Generation ${gen+1}, candidate ${i+1}: ${score.toFixed(2)} (camera + enabled physical sensors only)`);
      if(score>best){best=score;winner=candidate;}
    }
    parent=winner;log(`Generation ${gen+1}: selected ${best.toFixed(2)}. Camera weights unchanged.`);
  }
  const baseline=await evaluate(settings.controller,heldOut),offspring=await evaluate(parent.toJSON(),heldOut);
  if(baseline===null||offspring===null)return null;
  log(`Held-out paired scores: parent ${baseline.toFixed(2)}, offspring ${offspring.toFixed(2)}. ${offspring>baseline?'Offspring improved on this small test.':'No demonstrated improvement on this small test.'}`);
  return {scoreDefinition:settings.rewardConfig?"Sum of transferred racing rewards and penalties (car.score)":"Legacy progress/survival score plus default racing rewards",brain:parent.toJSON(),score:best,generation:generations,trainingSeeds:seeds,validation:{parent:baseline,offspring,seeds:heldOut}};
}
