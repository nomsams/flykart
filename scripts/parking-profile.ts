// Reproducible CPU profile: npm exec vite-node scripts/parking-profile.ts
// Timings are inclusive (nested rows must not be added). No hardware or rendered UI.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ParkingSession, type ParkingBrain} from '../src/parking/session';
import {ParkingEpisode} from '../src/parking/episode';
import {DEFAULT_PARKING} from '../src/parking/model';
import {RoomMemory,DEFAULT_MEMORY} from '../src/robot/memory';
import {DEFAULT_VISION} from '../src/robot/vision-workbench';
import {RobotPhysics} from '../src/robot/model';
import {Perceiver} from '../src/vision/perception';
import {VisionCnn} from '../src/vision/cnn';
import {Sonar} from '../src/vision/sonar';
import {VisionDriver} from '../src/vision/pipeline';
import {capturePreview,TrainingPreviews} from '../src/training-preview';
import {importFile} from '../src/vision/format';

const measures=new Map<string,{ms:number;calls:number;maxMs:number}>();
function measure(proto:any,key:string){const original=proto[key],name=proto.constructor.name+'.'+key;
  proto[key]=function(...args:any[]){const start=performance.now();try{return original.apply(this,args);}finally{const row=measures.get(name)??{ms:0,calls:0,maxMs:0},elapsed=performance.now()-start;row.ms+=elapsed;row.maxMs=Math.max(row.maxMs,elapsed);row.calls++;measures.set(name,row);}};
}
for(const [type,keys] of [[ParkingEpisode,['render','step']],[RobotPhysics,['step']],[RoomMemory,['observe']],[Perceiver,['see']],[VisionCnn,['forward']],[Sonar,['update']],[VisionDriver,['act']]] as const)for(const key of keys)measure(type.prototype,key);
const brain:ParkingBrain={controller:importFile(readFileSync('public/vision/robot/world-controller.json','utf8')).controller!.snapshot,eyes:JSON.parse(readFileSync('public/vision/robot/world-vision-net.json','utf8')),visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY}};
const results=[];let ticks=0;const start=performance.now(),cpuStart=process.cpuUsage();
for(let round=0;round<3;round++){
  const settings={...DEFAULT_PARKING,seed:137+round,maxTicks:180},sessions=Array.from({length:4},()=>new ParkingSession(settings,brain,{diagnostics:()=>false}));
  for(let tick=0;tick<180;tick++)for(const s of sessions)if(!s.done){s.step();ticks++;}
  const snapshotStart=performance.now(),rows=sessions.map((s,i)=>structuredClone(capturePreview(s,i+1,false))),captureMs=performance.now()-snapshotStart;
  const hydrateStart=performance.now();new TrainingPreviews({kind:'parking',settings,brain}).update(rows);const hydrateMs=performance.now()-hydrateStart;
  results.push({captureMs,hydrateMs,runs:sessions.map(s=>({result:s.episode.result(),frame:Array.from(s.episode.frame),sensors:s.driver.sensors,memory:s.memory.toJSON()}))});
}
const elapsedMs=performance.now()-start,digest=createHash('sha256').update(JSON.stringify(results.map(r=>r.runs))).digest('hex');
const cpu=process.cpuUsage(cpuStart);
const output={cpuMs:(cpu.user+cpu.system)/1000,elapsedMs,ticks,ticksPerSecond:ticks/(elapsedMs/1000),digest,preview:results.map(({captureMs,hydrateMs})=>({captureMs,hydrateMs})),profile:Object.fromEntries([...measures].sort((a,b)=>b[1].ms-a[1].ms))};
console.log(JSON.stringify(output,null,2));if(process.env.PARKING_PROFILE_OUT)writeFileSync(process.env.PARKING_PROFILE_OUT,JSON.stringify(output,null,2));
