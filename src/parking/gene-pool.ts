import {SpikingNetwork,type BrainSnapshot} from '../core';
import {brainIdentity} from '../evolution-checkpoint';
import {importFile} from '../vision/format';
import {widenBrain} from '../vision/inputs';
import {racerToRoom} from '../robot/task-brain';

export type ParkingDonor={id:string;name:string;sourceId:string;domain:'track'|'world';generation:number;controller:BrainSnapshot;original:BrainSnapshot};
export const MAX_PARKING_DONORS=8;
export function parkingDonor(text:string,fileName:string,adaptRacer=false):ParkingDonor{
  const parsed=importFile(text);
  if(!parsed.controller)throw Error('Add a complete controller brain, not an eyes-only network.');
  const {snapshot,domain,meta}=parsed.controller;
  if(domain==='track'&&!adaptRacer)throw Error('This is a racer brain. Enable “Adapt Racer v1 inputs” to create a parking donor; its original weights are preserved.');
  const original=SpikingNetwork.fromJSON(snapshot).toJSON(),controller=widenBrain(domain==='track'?racerToRoom(original):original);
  return {id:brainIdentity(controller),sourceId:brainIdentity(original),name:(fileName+(parsed.name?' · '+parsed.name:'')).slice(0,160),domain,generation:meta.generation??0,controller,original};
}
export function validateParkingPool(raw:unknown):ParkingDonor[]{
  if(!Array.isArray(raw)||raw.length>MAX_PARKING_DONORS)throw Error('The parking gene pool supports up to 8 donors.');
  const ids=new Set<string>();
  return raw.map(value=>{
    const d=value as ParkingDonor;
    if(!d||typeof d.name!=='string'||!d.name||d.name.length>160||!['track','world'].includes(d.domain)||!Number.isInteger(d.generation)||d.generation<0)throw Error('Invalid gene-pool donor metadata.');
    const original=SpikingNetwork.fromJSON(d.original).toJSON(),controller=SpikingNetwork.fromJSON(d.controller).toJSON();
    const expected=widenBrain(d.domain==='track'?racerToRoom(original):original),id=brainIdentity(controller);
    if(controller.inputCount!==19||id!==d.id||brainIdentity(expected)!==id||brainIdentity(original)!==d.sourceId||ids.has(id))throw Error('Invalid, incompatible or duplicate donor weights.');
    ids.add(id);return {...d,controller,original};
  });
}
export function poolText(donors:ParkingDonor[]):string{return JSON.stringify({format:'flykart-parking-gene-pool',version:1,donors});}
export function parsePool(text:string):ParkingDonor[]{const r=JSON.parse(text);if(r?.format!=='flykart-parking-gene-pool'||r.version!==1)throw Error('Expected a parking gene-pool file.');return validateParkingPool(r.donors);}
/** Preserve the incumbent and local mutations; half the descendants cross whole neuron units with donors. */
export function mixParkingDonors(candidates:SpikingNetwork[],champion:SpikingNetwork,donors:ParkingDonor[],seed:number,generation:number):Array<string|null>{
  const sources:Array<string|null>=candidates.map(()=>null);
  for(let i=1;donors.length&&i<candidates.length;i+=2){
    const donor=donors[(generation-1+Math.floor(i/2))%donors.length],mate=SpikingNetwork.fromJSON(donor.controller);
    if(mate.inputCount!==champion.inputCount)throw Error('Gene-pool input layout must match the current winner.');
    candidates[i]=champion.crossover(mate,seed+30000+i*19,.5).mutate(.18*.85,.25*.85,seed+i+1);sources[i]=donor.id;
  }
  return sources;
}
