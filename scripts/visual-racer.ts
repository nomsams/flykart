// Pure camera fine-tuning: no oracle/noisy-truth suite and no pose-indexed lap memory.
// npx vite-node scripts/visual-racer.ts --from=my-racer.json --eyes=public/vision/robot/vision-net.json --out=training/my-visual-racer.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SpikingNetwork } from '../src/core';
import { importFile, controllerCheckpoint, exportVisionBrain } from '../src/vision/format';
import type { CameraEpisodeSpec } from '../src/vision/cameraRun';
import type { EpisodeSummary } from '../src/vision/robust';
import { robustScore } from '../src/vision/robust';
import { Perceiver, VisionModel } from '../src/vision/perception';
import { widenBrain } from '../src/vision/inputs';
import { Pool } from './pool';
const args=new Map(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return [k,v.join('=')||'true'];}));
const from=args.get('from')??'public/sample-brain.json',eyesFile=args.get('eyes')??'public/vision/robot/vision-net.json',out=args.get('out')??'training/visual-racer.json';
const integer=(key:string,def:number,min:number,max:number)=>{const v=Number(args.get(key)??def);if(!Number.isInteger(v)||v<min||v>max)throw new Error(`${key} must be ${min}–${max}.`);return v;};
const generations=integer('gens',10,1,100),population=integer('pop',6,2,20),ticks=integer('ticks',1200,30,4200),episodes=integer('episodes',4,2,12),seed=integer('seed',4100,0,1000000),workers=integer('workers',1,1,3),sonar=args.get('sonar')==='true';
if(resolve(from)===resolve(out)||resolve(out).startsWith(resolve('public')+'/')||resolve(out).startsWith(resolve('public')+'\\')||existsSync(out)||existsSync(out+'.report.json'))throw new Error('Choose a new output outside public/. Existing checkpoints and bundled brains are protected.');
const imported=importFile(readFileSync(from,'utf8'));if(!imported.controller||imported.controller.domain!=='track')throw new Error('Import a track racer, not a room controller.');
const eyes=JSON.parse(readFileSync(eyesFile,'utf8')) as VisionModel;if((eyes.domain??'track')!=='track')throw new Error('Racing needs track-domain eyes.');new Perceiver(eyes);
let parent=SpikingNetwork.fromJSON(sonar?widenBrain(imported.controller.snapshot):imported.controller.snapshot);const initial=parent.toJSON();
const suite=(heldOut:boolean,generation:number):CameraEpisodeSpec[]=>Array.from({length:episodes},(_,i)=>({track:(heldOut?['hairpin','chicane']:['grand-loop','switchback'])[i%2] as CameraEpisodeSpec['track'],seed:seed+(heldOut?100000:0)+generation*31+i,maxTicks:ticks,rivals:i%2,roadObjects:i%3,objectKind:'mixed',look:(heldOut?'varied':i%2?'night':'day') as CameraEpisodeSpec['look'],profile:'robot',sonarOff:!sonar,physicsVariation:heldOut?.1:0}));
const pool=await Pool.create('scripts/worker-tasks.ts','visual-racer-worker',workers),history:unknown[]=[];
mkdirSync(dirname(out),{recursive:true});
try {
  for(let generation=1;generation<=generations;generation++){
    const candidates=[parent.clone(),...Array.from({length:population-1},(_,i)=>parent.mutate(.15,.15,seed+generation*100+i))],specs=suite(false,generation),results=await Promise.all(candidates.map(c=>pool.run<EpisodeSummary[]>({type:'camera',network:c.toJSON(),eyesFile,specs}))),scores=results.map(r=>robustScore(r,2,.2)),winner=scores.indexOf(Math.max(...scores));parent=candidates[winner];history.push({generation,specs,winner,scores,results});console.log(`Visual generation ${generation}/${generations} · winner ${winner} · score ${scores[winner].toFixed(3)}`);
  }
  const specs=suite(true,0),validation=await pool.run<EpisodeSummary[]>({type:'camera',network:parent.toJSON(),eyesFile,specs}),checkpoint=controllerCheckpoint(parent,{domain:'track',generation:(imported.controller.meta.generation??0)+generations,fitness:robustScore(validation,2,.2)}),file=JSON.parse(exportVisionBrain({name:'Camera-only visual racer offspring',controller:checkpoint,profile:'robot',vision:eyes,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,world:null,notes:'Controller fine-tuned exclusively on camera episodes; optional sonar recorded in visualTraining. Reward/progress/contact are external fitness labels. Held-out racing success is not room or real-world transfer.'}));
  file.visualTraining={format:'flykart-visual-training',version:1,sensorOnly:true,sonar,parent:controllerCheckpoint(initial,{domain:'track'}),from,eyesFile,seed,generations,population,validation};writeFileSync(out,JSON.stringify(file,null,2),{flag:'wx'});writeFileSync(out+'.report.json',JSON.stringify({sensorOnly:true,sonar,seed,history,validationSpecs:specs,validation},null,2),{flag:'wx'});console.log(`Saved new offspring ${out}; held-out ${validation.filter(r=>r.finished).length}/${validation.length} laps. Parent untouched.`);
} finally {await pool.close();}
