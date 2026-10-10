import {RoomMemory,validateMemorySettings} from '../robot/memory';
import {validateVisionSettings} from '../robot/vision-workbench';
import {DEFAULT_OBJECTIVE,SugarPolicy} from '../robot/objectives';
import {controllerCheckpoint,exportVisionBrain,importFile} from '../vision/format';
import {widenBrain} from '../vision/inputs';
import {SonarHistory} from '../vision/sonar-history';
import {actorObject,ParkingScene,ParkingSettings,validateParkingScene,validateParkingSettings} from './model';
import {ParkingBrain,parkingCamera} from './session';
import {CM_PER_PIXEL} from '../vision/robot';
import {ParkingTrainingReport} from './training';

export function parkingBrainText(brain:ParkingBrain,memory:RoomMemory,settings:ParkingSettings,parent?:unknown,report?:ParkingTrainingReport|null):string{
  report=report?.brain===brain.controller?report:null;
  const c=parkingCamera(settings,brain),camera={hfov:c.hfov*180/Math.PI,heightCm:c.mountHeight*CM_PER_PIXEL,forwardCm:c.mountForward*CM_PER_PIXEL,pitchDeg:c.pitch*180/Math.PI};
  return exportVisionBrain({name:brain.metadata?.name??'Parking simulator offspring',profile:'robot',controller:controllerCheckpoint(brain.controller,{...brain.metadata,domain:'world',generation:brain.metadata?.generation??0,fitness:report?.validation.offspring.reduce((a,r)=>a+r.score,0)??brain.metadata?.fitness??0,provenance:[...(brain.metadata?.provenance??[]),{stage:'parking',version:1,settings,advisory:settings.bayAlignment?'Precise lessons add visible bay alignment to slot 15; retrain/test in 3D before deployment.':'Original open-world input meanings retained. Robot wheel dynamics and parking geometry require measured adaptation.',...(parent?{parent}:{}),...(report?{heldOut:report.validation,memoryProtocol:report.memoryProtocol,inputAudit:report.inputAudit}: {})}]}),vision:brain.eyes,fusion:{fade:0,mode:'belief',visionTemperature:1},memory:null,worldMemory:memory.toJSON(),world:null,worldTraining:{version:1,task:settings.cue==='visual'?'explore':'forage',searchWin:'reach',crashWeight:settings.crashWeight,maxTicks:Math.max(300,Math.min(3000,settings.maxTicks)),memoryEnabled:true,reverseCoach:false},worldSetup:{version:1,seed:(settings.seed-1)%999999+1,density:.6,style:0,driver:'vision',fade:0,goalPreset:'standard',mapPreset:'procedural',memoryCount:memory.count,sonarOn:settings.sonarOn,trailVisible:true},experiment:{version:1,multiLap:false,laps:3,impactPain:true,visual:brain.visual,resolution:'native',camera,sonar:null},robotLearning:{format:'robot-learning',version:1,memorySettings:brain.memory,visionSettings:brain.visual,sugarPolicy:new SugarPolicy(brain.memory.count).toJSON(),learn:settings.phase!=='frozen',memory:memory.toJSON()},notes:'Parking weights, world camera, swarm settings and visual memory are portable to Vision and the 3D habitat. Parking bay score/arrival/orientation judging and lane traffic are separate parking-world models. Export the 3D scene separately. 3D input advisory and visual rendering differ; physical transfer is unmeasured.'});
}
export function parkingLab(settings:ParkingSettings,scene:ParkingScene,brain:ParkingBrain,memory:RoomMemory,scan:SonarHistory,parent?:unknown,report?:ParkingTrainingReport|null){
  return{format:'flykart-parking-lab',version:1,settings,scene,brain:JSON.parse(parkingBrainText(brain,memory,settings,parent,report)),scan:scan.toJSON()};
}
export function parseParkingLab(raw:unknown){
  const r=raw as ReturnType<typeof parkingLab>;if(!r||r.format!=='flykart-parking-lab'||r.version!==1)throw Error('Expected a parking lab state.');
  const settings=validateParkingSettings(r.settings),scene=validateParkingScene(r.scene),parsed=importFile(JSON.stringify(r.brain));
  if(scene.seed!==settings.seed||scene.lesson!==settings.lesson||!parsed.controller||parsed.controller.domain!=='world'||!parsed.vision)throw Error('Parking state needs matching lesson and world camera/controller.');
  const memory=parsed.worldMemory?RoomMemory.fromJSON(parsed.worldMemory):new RoomMemory(),visual=validateVisionSettings(parsed.experiment?.visual??{normalize:false,smooth:false,temporal:1,layout:'single',radius:.08});
  const brain:ParkingBrain={controller:widenBrain(parsed.controller.snapshot),eyes:parsed.vision,memory:validateMemorySettings(memory.settings),visual,metadata:{name:parsed.name,provenance:r.brain.controller.provenance??[],generation:parsed.controller.meta.generation??0,fitness:parsed.controller.meta.fitness??0,track:parsed.controller.meta.track??'all',trainingRecipe:parsed.trainingRecipe}};
  const scan=SonarHistory.fromJSON(r.scan);return{settings,scene,brain,memory,scan,parent:r.brain};
}
export function parkingRobotScene(scene:ParkingScene){
  const b=scene.target;return{format:'flykart-robot-scene',version:1,objects:scene.actors.map(actorObject),floorColour:'#56636e',startPose:scene.start,currentPose:scene.start,mission:{settings:{...DEFAULT_OBJECTIVE,mode:'sugar',sugar:10},goals:[{id:'parking-target',x:b.x,z:b.z,yaw:b.heading,radius:.22,amount:10}],trail:[]},parkingNote:'Traffic is frozen at exported positions. 3D sugar arrival does not enforce parking orientation or full-chassis containment. Retain this parking lab for exact parking tests.'};
}
