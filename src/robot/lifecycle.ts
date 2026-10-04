import {HungerSettings,validateHunger} from './homeostasis';
import {validateVisual} from './imported-assets';
import { TaskChallenge, TaskProfile, TaskVariant, validateChallenge } from './task-validation';
import { BrainSnapshot, SpikingNetwork, clamp } from '../core';
import { mulberry32 } from '../vision/rng';
import { Pose, makeObject, preset, WorldObject, DEFAULT_ROBOT, RobotConfig, ROOM_TYPES, solidsFor } from './model';
import { contactParts, polygonsOverlap } from './contacts';
import { placementError } from './placement';
import { BLUE_TARGET, ColourTarget, DEFAULT_MODULES, SensorModules, TaskBrain, TaskSnapshot, validateModules, validateTarget } from './task-brain';
import { taskContract, TASK_LEGACY, TASK_APPEARANCE, TASK_HUNGER } from './sensor-contract';
export type TaskSettings={mode:'off'|'approach'|'follow'|'forage';specimen?:WorldObject;hunger?:HungerSettings;modules:SensorModules;target:ColourTarget;inheritance:number;sugar:number;pain:number;shaping:number;fade:number;hold:number;speed:number};
export const DEFAULT_TASK:TaskSettings={mode:'off',modules:{...DEFAULT_MODULES},target:{...BLUE_TARGET},inheritance:.15,sugar:10,pain:1,shaping:1,fade:.8,hold:5,speed:.06};
export type TaskEvidence={seed:number;heldOut:boolean;success:boolean;seconds:number;contacts:number;score:number;source:'neural'|'coach';shaping:number;room?:string;settings?:TaskSettings;scenario?:TaskProfile;variant?:TaskVariant;context?:string};
export type LifecycleSnapshot={format:'robot-lifecycle';version:1;contract?:ReturnType<typeof taskContract>;settings:TaskSettings;brain:TaskSnapshot;lineage:{event:string;time:string;generation:number}[];evidence:TaskEvidence[];parent?:{domain:'track'|'world';brain:BrainSnapshot}};
export function validateTaskSettings(raw:unknown):TaskSettings {const s=raw as TaskSettings;if(!s||!['off','approach','follow','forage'].includes(s.mode)||![s.inheritance,s.sugar,s.pain,s.shaping,s.fade,s.hold,s.speed].every(Number.isFinite)||s.inheritance<0||s.inheritance>1||s.sugar<0||s.sugar>100||s.pain<0||s.pain>10||s.shaping<0||s.shaping>5||s.fade<0||s.fade>1||s.hold<1||s.hold>20||s.speed<0||s.speed>.2)throw new Error('Invalid task training settings.');if(s.mode==='forage'&&(!s.hunger?.enabled||s.modules?.light))throw new Error('Prepare the hungry foraging head; its energy channels replace light.');if(s.specimen){const o=s.specimen;if(!['image','model','pod','ball','block'].includes(o.kind)||![o.width,o.depth,o.height].every(v=>Number.isFinite(v)&&v>=.02&&v<=1))throw new Error('Target dimensions must be 2–100 cm.');if(!Number.isFinite(o.yaw)||Math.abs(o.yaw)>Math.PI*100)throw new Error('Invalid target orientation.');if(o.visual){validateVisual(o.visual);if((o.kind==='image'&&o.visual.type!=='image')||(o.kind==='model'&&o.visual.type!=='glb')||!['image','model'].includes(o.kind))throw new Error('Target visual does not match its type.');}}
  return {...s,...(s.specimen?{specimen:{id:'target-prototype',kind:s.specimen.kind,x:0,z:0,yaw:s.specimen.yaw,width:s.specimen.width,depth:s.specimen.depth,height:s.specimen.height,...(s.specimen.visual?{visual:validateVisual(s.specimen.visual)}:{})}}:{}),...(s.hunger?{hunger:validateHunger(s.hunger)}:{}),modules:validateModules(s.modules),target:validateTarget(s.target)};}
export function validateLifecycle(raw:unknown):LifecycleSnapshot {const s=raw as LifecycleSnapshot;if(!s||s.format!=='robot-lifecycle'||s.version!==1||!Array.isArray(s.lineage)||s.lineage.length>100||s.lineage.some(l=>typeof l.event!=='string'||l.event.length>300||typeof l.time!=='string'||l.time.length>100||!Number.isInteger(l.generation)||l.generation<0)||!Array.isArray(s.evidence)||s.evidence.length>100||s.evidence.some(e=>!Number.isInteger(e.seed)||e.seed<0||typeof e.heldOut!=='boolean'||typeof e.success!=='boolean'||!['neural','coach'].includes(e.source)||![e.seconds,e.contacts,e.score,e.shaping].every(Number.isFinite)||e.seconds<0||e.contacts<0||e.shaping<0))throw new Error('Invalid training lifecycle.');for(const e of s.evidence){if(e.scenario!==undefined||e.variant!==undefined)validateChallenge({profile:e.scenario??'baseline',variant:e.variant??'current'});if(e.context!==undefined&&(typeof e.context!=='string'||!/^([a-f0-9]{8})$/.test(e.context)))throw new Error('Invalid evidence context checksum.');if(e.room!==undefined&&!ROOM_TYPES.some(r=>r.id===e.room))throw new Error('Invalid evidence room.');if(e.settings!==undefined){const settings=validateTaskSettings(e.settings);if(settings.shaping!==e.shaping||settings.mode==='off')throw new Error('Invalid evidence task settings.');}}if(s.parent&&!['track','world'].includes(s.parent.domain))throw new Error('Invalid parent domain.');if(s.settings.target?.appearance&&![TASK_APPEARANCE,TASK_HUNGER].includes(s.brain.observation??''))throw new Error('Learned appearance requires its matching versioned task head.');if(s.settings.mode==='forage'&&s.brain.observation!==TASK_HUNGER)throw new Error('Foraging requires the energy observation head.');const contract=taskContract(s.brain.observation??TASK_LEGACY,validateTaskSettings(s.settings).modules,validateTaskSettings(s.settings).target);if(s.contract&&JSON.stringify(s.contract)!==JSON.stringify(contract))throw new Error('Sensor contract differs from the saved task network/settings.');const parent=s.parent?{domain:s.parent.domain,brain:SpikingNetwork.fromJSON(s.parent.brain).toJSON()}:undefined;return {format:'robot-lifecycle',version:1,...(s.contract?{contract}:{}),settings:validateTaskSettings(s.settings),brain:TaskBrain.fromJSON(s.brain).toJSON(),lineage:structuredClone(s.lineage),evidence:structuredClone(s.evidence),...(parent?{parent}:{})};}
export type TaskCase={objects:WorldObject[];pose:Pose;ball:WorldObject;seed:number;heldOut:boolean};
export function taskCase(seed:number,heldOut:boolean,settings:TaskSettings,room='empty',config:RobotConfig=DEFAULT_ROBOT,challenge:TaskChallenge={profile:'baseline',variant:'current'}):TaskCase {
  if(!Number.isInteger(seed)||seed<0||seed>2000000||!ROOM_TYPES.some(r=>r.id===room))throw new Error('Invalid task seed or room.');
  validateChallenge(challenge);settings=validateTaskSettings(settings);const target=settings.target,r=mulberry32(seed),pose={x:-1.3,z:0,heading:(r()-.5)*.2},ball={...(settings.specimen??makeObject(settings.mode==='forage'?'pod':'ball')),id:'task-blue-ball',...(!settings.specimen&&settings.mode!=='forage'?{width:target.diameter,depth:target.diameter,height:target.diameter}:{})},objects=preset(room).map((o,i)=>({...o,id:'task-room-'+seed+'-'+i}));
  if(challenge.profile!=='baseline'){
    pose.x+=(r()-.5)*.16;pose.z=(r()-.5)*.4;pose.heading=(r()-.5)*.7;
    for(const o of objects)if(o.kind!=='wall'){const previous={...o};o.x+=(r()-.5)*.2;o.z+=(r()-.5)*.2;o.yaw+=(r()-.5)*.3;if(placementError(pose,config,[o]))Object.assign(o,previous);}
    for(let i=0;i<(challenge.profile==='stress'?3:1);i++){const shoe={...makeObject('shoe',.65+r()*.7,(r()-.5)*1.6),id:'task-distractor-'+i,yaw:r()*Math.PI};if(!placementError(pose,config,[shoe])&&!objects.flatMap(o=>contactParts(o,solidsFor(o),shoe.height)).some(p=>polygonsOverlap(contactParts(shoe,solidsFor(shoe),shoe.height)[0].polygon,p.polygon)))objects.push(shoe);}
  }
  const spawnError=placementError(pose,config,objects);if(spawnError)throw new Error(spawnError);
  const solids=objects.flatMap(o=>contactParts(o,solidsFor(o),ball.height));
  // Reject intersecting geometry, while allowing targets beneath clear tabletops.
  for(let attempt=0;attempt<100;attempt++){
    ball.x=-.4+r()*.45;ball.z=(r()-.5)*(heldOut?1.2:.7);
    const footprints=contactParts(ball,solidsFor(ball),ball.height).map(p=>p.polygon);
    if(!solids.some(p=>footprints.some(footprint=>polygonsOverlap(footprint,p.polygon)))&&!placementError(pose,config,[ball]))return {objects:[...objects,ball],pose,ball,seed,heldOut};
  }
  throw new Error('Could not place the target in free space for this room.');
}
export function movingTarget(origin:WorldObject,seconds:number,speed:number):{x:number;z:number} {return {x:origin.x+Math.sin(seconds*speed*1.5)*.25,z:origin.z+Math.sin(seconds*speed*3)*.35};}
/** External training/evaluation judge. It has no reference to a controller or its observations. */
export class TaskJudge {
  success=false;total=0;hold=0;private distance:number|null=null;private blocked=false;private paid=false;
  constructor(readonly settings:TaskSettings,readonly shaping=settings.shaping){}
  update(pose:Pose,ball:WorldObject|null,blocked:boolean,dt:number,robotLength=.26):{amount:number;messages:string[]} {
    if(!ball||this.settings.mode==='off')return {amount:0,messages:[]};let amount=0;const messages:string[]=[],d=Math.hypot(pose.x-ball.x,pose.z-ball.z),limit=robotLength/2+ball.width/2+.045;
    if(this.distance!==null&&!this.paid&&this.shaping>0&&this.settings.mode!=='forage'){const progress=clamp(this.distance,0,3)-clamp(d,0,3);amount+=progress*this.shaping;}
    this.distance=d;
    if(this.settings.mode==='approach')this.success ||=d<=limit&&!blocked;
    else if(this.settings.mode==='follow'){this.hold=d>=limit+.02&&d<=limit+.32&&!blocked?this.hold+dt:0;this.success ||=this.hold>=this.settings.hold;}
    if(this.success&&!this.paid){if(this.settings.mode!=='forage')amount+=this.settings.sugar;this.paid=true;messages.push(this.settings.mode==='forage'?'Satiated through charging · deficit-reduction reward':this.settings.mode==='follow'?'Following held · sugar reward':'Visual target reached · sugar reward');}
    if(blocked&&!this.blocked&&this.settings.pain){amount-=this.settings.pain;messages.push('Simulated aversive teaching signal');}
    this.blocked=blocked;this.total+=amount;return {amount,messages};
  }
}
