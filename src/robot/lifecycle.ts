import { BrainSnapshot, SpikingNetwork, clamp } from '../core';
import { mulberry32 } from '../vision/rng';
import { Pose, makeObject, preset, WorldObject } from './model';
import { BLUE_TARGET, ColourTarget, DEFAULT_MODULES, SensorModules, TaskBrain, TaskSnapshot, validateModules, validateTarget } from './task-brain';
export type TaskSettings={mode:'off'|'approach'|'follow';modules:SensorModules;target:ColourTarget;inheritance:number;sugar:number;pain:number;shaping:number;fade:number;hold:number;speed:number};
export const DEFAULT_TASK:TaskSettings={mode:'off',modules:{...DEFAULT_MODULES},target:{...BLUE_TARGET},inheritance:.15,sugar:10,pain:1,shaping:1,fade:.8,hold:5,speed:.06};
export type TaskEvidence={seed:number;heldOut:boolean;success:boolean;seconds:number;contacts:number;score:number;source:'neural'|'coach';shaping:number};
export type LifecycleSnapshot={format:'robot-lifecycle';version:1;settings:TaskSettings;brain:TaskSnapshot;lineage:{event:string;time:string;generation:number}[];evidence:TaskEvidence[];parent?:{domain:'track'|'world';brain:BrainSnapshot}};
export function validateTaskSettings(raw:unknown):TaskSettings {const s=raw as TaskSettings;if(!s||!['off','approach','follow'].includes(s.mode)||![s.inheritance,s.sugar,s.pain,s.shaping,s.fade,s.hold,s.speed].every(Number.isFinite)||s.inheritance<0||s.inheritance>1||s.sugar<0||s.sugar>100||s.pain<0||s.pain>10||s.shaping<0||s.shaping>5||s.fade<0||s.fade>1||s.hold<1||s.hold>20||s.speed<0||s.speed>.2)throw new Error('Invalid task training settings.');return {...s,modules:validateModules(s.modules),target:validateTarget(s.target)};}
export function validateLifecycle(raw:unknown):LifecycleSnapshot {const s=raw as LifecycleSnapshot;if(!s||s.format!=='robot-lifecycle'||s.version!==1||!Array.isArray(s.lineage)||s.lineage.length>100||s.lineage.some(l=>typeof l.event!=='string'||l.event.length>300||typeof l.time!=='string'||l.time.length>100||!Number.isInteger(l.generation)||l.generation<0)||!Array.isArray(s.evidence)||s.evidence.length>100||s.evidence.some(e=>!Number.isInteger(e.seed)||e.seed<0||typeof e.heldOut!=='boolean'||typeof e.success!=='boolean'||!['neural','coach'].includes(e.source)||![e.seconds,e.contacts,e.score,e.shaping].every(Number.isFinite)||e.seconds<0||e.contacts<0||e.shaping<0))throw new Error('Invalid training lifecycle.');if(s.parent&&!['track','world'].includes(s.parent.domain))throw new Error('Invalid parent domain.');const parent=s.parent?{domain:s.parent.domain,brain:SpikingNetwork.fromJSON(s.parent.brain).toJSON()}:undefined;return {format:'robot-lifecycle',version:1,settings:validateTaskSettings(s.settings),brain:TaskBrain.fromJSON(s.brain).toJSON(),lineage:structuredClone(s.lineage),evidence:structuredClone(s.evidence),...(parent?{parent}:{})};}
export type TaskCase={objects:WorldObject[];pose:Pose;ball:WorldObject;seed:number;heldOut:boolean};
export function taskCase(seed:number,heldOut:boolean,settings:TaskSettings,room='empty'):TaskCase {const r=mulberry32(seed),pose={x:-1.3,z:0,heading:(r()-.5)*.2},ball={...makeObject('ball',-.4+r()*.45,(r()-.5)*(heldOut?1.2:.7)),id:'task-blue-ball',width:settings.target.diameter,depth:settings.target.diameter,height:settings.target.diameter},objects=preset(room);return {objects:[...objects,ball],pose,ball,seed,heldOut};}
export function movingTarget(origin:WorldObject,seconds:number,speed:number):{x:number;z:number} {return {x:origin.x+Math.sin(seconds*speed*1.5)*.25,z:origin.z+Math.sin(seconds*speed*3)*.35};}
/** External training/evaluation judge. It has no reference to a controller or its observations. */
export class TaskJudge {
  success=false;total=0;hold=0;private distance:number|null=null;private blocked=false;private paid=false;
  constructor(readonly settings:TaskSettings,readonly shaping=settings.shaping){}
  update(pose:Pose,ball:WorldObject|null,blocked:boolean,dt:number,robotLength=.26):{amount:number;messages:string[]} {
    if(!ball||this.settings.mode==='off')return {amount:0,messages:[]};let amount=0;const messages:string[]=[],d=Math.hypot(pose.x-ball.x,pose.z-ball.z),limit=robotLength/2+ball.width/2+.045;
    if(this.distance!==null&&!this.paid&&this.shaping>0){const progress=clamp(this.distance,0,3)-clamp(d,0,3);amount+=progress*this.shaping;}
    this.distance=d;
    if(this.settings.mode==='approach')this.success ||=d<=limit&&!blocked;
    else {this.hold=d>=limit+.02&&d<=limit+.32&&!blocked?this.hold+dt:0;this.success ||=this.hold>=this.settings.hold;}
    if(this.success&&!this.paid){amount+=this.settings.sugar;this.paid=true;messages.push(this.settings.mode==='follow'?'Following held · sugar reward':'Blue target reached · sugar reward');}
    if(blocked&&!this.blocked&&this.settings.pain){amount-=this.settings.pain;messages.push('Simulated aversive teaching signal');}
    this.blocked=blocked;this.total+=amount;return {amount,messages};
  }
}
