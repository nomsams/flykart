import {SpikingNetwork,type BrainSnapshot} from '../../core';
import {brainIdentity} from '../../evolution-checkpoint';
import {narrowBrain} from '../inputs';
import type {ParkingDonor} from '../../parking/gene-pool';
import type {GoalResult} from './training';
import type {WorldSettings} from '../ui/sessions';
export type WorldBreeding={autoRecover:boolean;plateauAfter:number;minGain:number;mutationRate:number;mutationSize:number};
export const DEFAULT_WORLD_BREEDING:WorldBreeding={autoRecover:true,plateauAfter:6,minGain:.5,mutationRate:.18,mutationSize:.28};
export function validateWorldBreeding(raw:unknown):WorldBreeding{
  if(raw===undefined)return {...DEFAULT_WORLD_BREEDING};const s=raw as WorldBreeding;
  if(!s||typeof s.autoRecover!=='boolean'||!Number.isInteger(s.plateauAfter)||s.plateauAfter<2||s.plateauAfter>50||!Number.isFinite(s.minGain)||s.minGain<0||s.minGain>100||!Number.isFinite(s.mutationRate)||s.mutationRate<.01||s.mutationRate>.8||!Number.isFinite(s.mutationSize)||s.mutationSize<.01||s.mutationSize>2)throw Error('Invalid world breeding / plateau settings.');return {...s};
}
export function worldBreedingContext(settings:WorldSettings,breeding:WorldBreeding,scoring?:{crashWeight:number;coach:boolean;retain:boolean}):string{return JSON.stringify({sonarFeedback:settings.sonarFeedback??"amplitude",speedFeedback:settings.speedFeedback??"measured",task:settings.task,win:settings.searchWin,preset:settings.goalPreset,count:settings.goalCount,radius:settings.goalRadius,density:settings.density,world:settings.world,start:settings.start,profile:settings.profile,visual:settings.visual,eyes:settings.vision?brainIdentity(settings.vision):null,memory:settings.memorySettings,resolution:settings.resolution,noise:settings.cameraNoise,brightness:settings.cameraBrightness,stall:settings.stall,judge:settings.searchJudge,breeding,scoring,ticks:settings.maxTicks});}
export type WorldAncestor={id:string;brain:BrainSnapshot};
export type WorldRecovery={generation:number;from:string;to:string;branch:number;mutationScale:number;stale:number};
export type WorldPopulation={generation:number;brains:BrainSnapshot[];parent:string;donorParents:Array<string|null>;mutationSeed:number;recovery:WorldRecovery|null;donors?:ParkingDonor[]};
export type WorldRecoveryState={best:number;wins:number;stale:number;branch:number;pending?:WorldRecovery|null};
export type WorldGeneration={generation:number;winner:number;scores:number[];trials:GoalResult[][];parent:string;donorParents:Array<string|null>;node:string;brain:BrainSnapshot|null;plateau:number;milestone:boolean;recovery:WorldRecovery|null;state:WorldRecoveryState;context:string};
export function validateRecoveryState(raw:unknown):WorldRecoveryState|undefined{if(raw===undefined)return undefined;const s=raw as WorldRecoveryState;if(!s||!Number.isFinite(s.best)||!Number.isInteger(s.wins)||s.wins< -1||s.wins>1000||!Number.isInteger(s.stale)||s.stale<0||s.stale>1000||!Number.isInteger(s.branch)||s.branch<0||s.branch>10000)throw Error('Invalid plateau state');if(s.pending&&(!Number.isInteger(s.pending.generation)||s.pending.generation<1||typeof s.pending.from!=='string'||typeof s.pending.to!=='string'||!Number.isInteger(s.pending.branch)||s.pending.branch<1||!Number.isFinite(s.pending.mutationScale)||s.pending.mutationScale<1||s.pending.mutationScale>4||!Number.isInteger(s.pending.stale)))throw Error('Invalid pending rollback');return {...s};}
/** A noisy training trend monitor, not a biological inbreeding test. Held-out
 * targets never drive rollback, donor choice or mutation sizes. */
export class RecoveryLedger{
  private best=-Infinity;private wins=-1;private milestones:WorldAncestor[];stale=0;branch=0;
  pending:WorldRecovery|null=null;
  constructor(readonly config:WorldBreeding,root:WorldAncestor,ancestors:WorldAncestor[]=[],state?:WorldRecoveryState){this.milestones=[...ancestors.slice(-8),root];const s=validateRecoveryState(state);if(s){this.best=s.best;this.wins=s.wins;this.stale=s.stale;this.branch=s.branch;this.pending=this.config.autoRecover?s.pending??null:null;}}
  snapshot():WorldRecoveryState{return {best:Number.isFinite(this.best)?this.best:-1000000,wins:this.wins,stale:this.stale,branch:this.branch,pending:this.pending?{...this.pending}:null};}
  complete(generation:number,node:WorldAncestor|null,score:number,wins:number,current:string):boolean{
    const improved=Boolean(node&&(wins>this.wins||score>this.best+this.config.minGain));
    if(improved){this.best=Math.max(this.best,score);this.wins=Math.max(this.wins,wins);this.stale=0;this.milestones.push(node!);if(this.milestones.length>32)this.milestones.shift();}else this.stale++;
    if(this.config.autoRecover&&this.stale>=this.config.plateauAfter){
      this.branch++;const ancestor=this.milestones[Math.max(0,this.milestones.length-1-(this.branch-1)%Math.min(4,this.milestones.length))];
      this.pending={generation:generation+1,from:current,to:ancestor.id,branch:this.branch,mutationScale:Math.min(4,1.5+this.branch*.5),stale:this.stale};this.stale=0;
    }return improved;
  }
  take():{recovery:WorldRecovery;ancestor:WorldAncestor}|null{
    if(!this.pending)return null;const recovery=this.pending;this.pending=null;const ancestor=this.milestones.find(a=>a.id===recovery.to)??this.milestones[0];return {recovery:{...recovery,to:ancestor.id},ancestor};
  }
}
export function worldScout(seed:number,inputCount:number):SpikingNetwork{
  const raw=new SpikingNetwork(seed,inputCount).toJSON(),h=raw.hiddenCount;
  // Recovery scouts use a forward-search prior rather than a random reverse
  // habit. Generic weights are already centered. These are ordinary evolvable
  // weights, not forced motor commands or a change to imported controllers.
  for(let i=0;i<h;i++){raw.outputWeights[i]*=.8;raw.outputWeights[h+i]=Math.abs(raw.outputWeights[h+i])*.2;raw.outputWeights[2*h+i]=-Math.abs(raw.outputWeights[2*h+i])*.2;raw.outputWeights[3*h+i]=-Math.abs(raw.outputWeights[3*h+i])*.2;}
  return SpikingNetwork.fromJSON(raw);
}
export function worldPopulation(parent:SpikingNetwork,count:number,donors:ParkingDonor[],seed:number,generation:number,config:WorldBreeding,scale=1):{brains:SpikingNetwork[];donorParents:Array<string|null>}{
  const rate=Math.min(.8,config.mutationRate*scale),amount=Math.min(2,config.mutationSize*scale),donorParents:Array<string|null>=Array(count).fill(null);
  const brains=Array.from({length:count},(_,i)=>i===0?parent.clone():parent.mutate(rate,amount,seed+i*19));
  for(let i=1;donors.length&&i<count;i+=2){const donor=donors[(generation-1+Math.floor(i/2))%donors.length],mate=SpikingNetwork.fromJSON(parent.inputCount===17?narrowBrain(donor.controller):donor.controller);brains[i]=parent.crossover(mate,seed+i*37).mutate(rate,amount,seed+i*53);donorParents[i]=donor.id;}
  // A new unrelated scout is admitted only in a recovery branch. It must win
  // the same trials as everybody else and cannot replace the exact incumbent.
  if(scale>1&&count>=3){brains[count-1]=worldScout(seed+90001,parent.inputCount);donorParents[count-1]='scout-'+brainIdentity(brains[count-1].toJSON());}
  return {brains,donorParents};
}
