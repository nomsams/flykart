// npm run parking:train -- --from=assets/flykart-visual.json --gens=100 --pop=8 --out=.cache/parking/winner.json
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {RoomMemory,DEFAULT_MEMORY,validateMemorySettings} from '../src/robot/memory';
import {DEFAULT_VISION,validateVisionSettings} from '../src/robot/vision-workbench';
import {importFile} from '../src/vision/format';
import {validateVisionModel} from '../src/vision/perception';
import {widenBrain} from '../src/vision/inputs';
import {DEFAULT_PARKING,validateParkingSettings,LESSONS,Lesson} from '../src/parking/model';
import type {ParkingBrain} from '../src/parking/session';
import {parkingBrainText,parseParkingLab} from '../src/parking/files';
import {trainParking} from '../src/parking/training';
import {describeEvolution,generationFile,validatedGeneration} from '../src/evolution-checkpoint';

async function main(){
  const args=new Map(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return i<0?[arg.replace(/^--/,''),'true']:[arg.slice(0,i).replace(/^--/,''),arg.slice(i+1)];}));
  if(args.has('help')){console.log('parking:train --from=<world fly+eyes JSON> OR --state=<parking lab JSON> --gens=100 --pop=8 --seed=7331 --lessons=arrival,exit --ticks=900 --out=.cache/parking/winner.json\nOptional: --lesson=parallel --phase=shaped|sparse --slow=penalty|pain --min-speed=5 --slow-weight=1 --safe-radius=.45 --memory=4096. Limits: 1–1000 generations, 2–32 ghosts. Full headless execution keeps all inference and sensors. Ctrl+C retains the last completed generation. Each generation saves portable fly+eyes/history; final held-out tests and a report accompany the winner. Fresh generated lots are used; imported replay geometry is not the evolution curriculum.');return;}
  let brain:ParkingBrain,settings={...DEFAULT_PARKING};
  if(args.has('state')){const lab=parseParkingLab(JSON.parse(await readFile(args.get('state')!,'utf8')));brain=lab.brain;settings=lab.settings;}
  else{
    const text=await readFile(args.get('from')??'assets/flykart-visual.json','utf8'),f=importFile(text),d=describeEvolution(text);
    if(!f.controller||f.controller.domain!=='world'||!f.vision)throw Error('Use a complete world/visual brain with eyes. Adapt racer parents in Parking and export fly + eyes first.');
    const previousSettings=d.provenance.findLast((p:{stage?:string;settings?:unknown})=>p?.stage==='parking'&&p.settings)?.settings;if(previousSettings)settings=validateParkingSettings(previousSettings);
    const memory=f.worldMemory?RoomMemory.fromJSON(f.worldMemory).settings:DEFAULT_MEMORY;
    brain={controller:widenBrain(f.controller.snapshot),eyes:validateVisionModel(f.vision,'world'),visual:validateVisionSettings(f.experiment?.visual??DEFAULT_VISION),memory:validateMemorySettings(memory),metadata:{name:d.name,generation:d.generation,provenance:d.provenance,fitness:f.controller.meta.fitness,track:f.controller.meta.track}};
  }
  settings=validateParkingSettings({...settings,...(args.has('lesson')?{lesson:args.get('lesson')}:{}),...(args.has('phase')?{phase:args.get('phase')}:{}),...(args.has('ticks')?{maxTicks:Number(args.get('ticks'))}:{}),...(args.has('slow')?{slowDriving:true,slowMode:args.get('slow')}:{}),...(args.has('min-speed')?{slowSpeedCm:Number(args.get('min-speed'))}:{}),...(args.has('slow-weight')?{slowWeight:Number(args.get('slow-weight'))}:{}),...(args.has('safe-radius')?{slowZoneRadius:Number(args.get('safe-radius'))}:{})});
  if(args.has('memory'))brain.memory=validateMemorySettings({...brain.memory,count:Number(args.get('memory'))});
  const lessons=(args.get('lessons')??settings.lesson).split(',') as Lesson[];
  if(lessons.some(l=>!LESSONS.some(v=>v.id===l)))throw Error('Unknown lesson. Choose '+LESSONS.map(l=>l.id).join(', '));
  const out=resolve(args.get('out')??'.cache/parking/winner.json');if(out===resolve(args.get('state')??args.get('from')??'assets/flykart-visual.json'))throw Error('Choose an output different from the source parent/state.');const base=parkingBrainText(brain,new RoomMemory(brain.memory),settings),runId='cli-'+Date.now(),baseGeneration=describeEvolution(base).generation;
  let latest=base,cancelled=false,completed=0;
  const atomic=async(path:string,text:string)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',text);await rename(path+'.tmp',path);};
  const stop=()=>{cancelled=true;console.log('Stopping after the current compute batch; completed-generation checkpoint is retained.');};process.on('SIGINT',stop);
  try{
    const report=await trainParking(brain,settings,{generations:Number(args.get('gens')??100),population:Number(args.get('pop')??8),seed:Number(args.get('seed')??7331),lessons,speed:0,preview:()=>false,cancel:()=>cancelled,log:console.log,progress:()=>{},onGeneration:async c=>{latest=generationFile(base,latest,'parking',runId,c,baseGeneration);await atomic(out,latest);completed=c.generation;console.log(`Saved generation ${baseGeneration+completed} → ${out}`);}});
    if(report){latest=validatedGeneration(latest,runId,report.validation);await atomic(out,latest);await atomic(out+'.report.json',JSON.stringify(report));console.log(`Finished: held-out ${report.validation.passed?'PASS':'FAIL · candidate saved for review'}; ${completed} completed generations. No display rendering or diagnostic-map accumulation.`);}
    else console.log(`Cancelled: ${completed} completed generations saved${completed?' at '+out:'; parent unchanged, no new checkpoint written'}.`);
  }finally{process.off('SIGINT',stop);}
}
main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
