import {describe,it,expect} from 'vitest';
import {SpikingNetwork,createMutationPopulation} from '../core';
import {controllerCheckpoint} from '../vision/format';
import {widenBrain} from '../vision/inputs';
import {VisionCnn} from '../vision/cnn';
import {defaultSpec,serialiseModel} from '../vision/perception';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import {DEFAULT_MEMORY} from '../robot/memory';
import {DEFAULT_VISION} from '../robot/vision-workbench';
import {DEFAULT_PARKING} from './model';
import {trainParking} from './training';
import {parkingDonor,mixParkingDonors,poolText,parsePool,validateParkingPool} from './gene-pool';

const file=(seed:number,domain:'world'|'track'='world')=>JSON.stringify(controllerCheckpoint(new SpikingNetwork(seed).toJSON(),{domain,generation:7,fitness:1,track:'all'}));
describe('parking gene pool',()=>{
  it('validates donors and preserves racer originals through explicit adaptation and export',()=>{
    const world=parkingDonor(file(12),'world.json');expect(world.controller.inputCount).toBe(19);expect(world.original.inputCount).toBe(17);
    expect(()=>parkingDonor(file(15,'track'),'racer.json')).toThrow('Enable');
    const racer=parkingDonor(file(15,'track'),'racer.json',true);
    expect(racer.original).toEqual(new SpikingNetwork(15).toJSON());expect(racer.controller).not.toEqual(widenBrain(racer.original));
    expect(parsePool(poolText([world,racer]))).toEqual([world,racer]);
    expect(()=>validateParkingPool([world,world])).toThrow('duplicate');
    expect(()=>validateParkingPool([{...world,controller:racer.controller}])).toThrow();
    expect(()=>validateParkingPool(new Array(9).fill(world))).toThrow('8');
    expect(()=>parkingDonor('{}','bad.json')).toThrow();
  });
  it('mixes deterministic whole neuron units, protects the winner and leaves imported weights untouched',()=>{
    const champion=new SpikingNetwork(44,19),donor=parkingDonor(file(71),'donor.json'),before=champion.toJSON(),original=structuredClone(donor);
    const make=()=>{const c=createMutationPopulation(6,champion,900);const sources=mixParkingDonors(c,champion,[donor],900,1);return {snapshots:c.map(n=>n.toJSON()),sources};};
    const a=make();expect(make()).toEqual(a);expect(a.snapshots[0]).toEqual(before);expect(champion.toJSON()).toEqual(before);expect(donor).toEqual(original);
    expect(a.sources).toEqual([null,donor.id,null,donor.id,null,donor.id]);
    const local=createMutationPopulation(6,champion,900).map(n=>n.toJSON());expect(a.snapshots[2]).toEqual(local[2]);expect(a.snapshots[1]).not.toEqual(local[1]);
    // A two-ghost run still includes an incumbent/donor child, rather than silently ignoring the pool.
    const two=createMutationPopulation(2,champion,900);expect(mixParkingDonors(two,champion,[donor],900,1)).toEqual([null,donor.id]);
  });
  it('admits mid-run imports only at the next generation and exports donor lineage with fair common trials',async()=>{
    const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8},eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'fixture',undefined,undefined,'world');
    const brain={controller:widenBrain(new SpikingNetwork(44).toJSON()),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512}},donor=parkingDonor(file(71),'donor.json');
    let pool:ReturnType<typeof parkingDonor>[]=[];const records:any[]=[];let admitted=false;
    const result=await trainParking(brain,{...DEFAULT_PARKING,maxTicks:60},{generations:2,population:2,lessons:['arrival'],seed:88,speed:0,preview:()=>false,getGenePool:()=>pool,cancel:()=>false,log:()=>{},progress:(_s,g)=>{if(g===1&&!admitted){admitted=true;pool=[donor];}},onGeneration:c=>{records.push(c);}});
    expect(result!.trials[0].genePool).toEqual([]);expect(result!.trials[0].donorParents).toEqual([null,null]);expect(result!.trials[1].genePool?.[0].id).toBe(donor.id);expect(result!.trials[1].donorParents).toEqual([null,donor.id]);
    expect(result!.trials.every(t=>t.results.every(rows=>rows.every((r,i)=>r.seed===t.scenarios[i].seed)))).toBe(true);
    expect(records.at(-1).training.genePool[0].sourceId).toBe(donor.sourceId);expect(brain.controller).toEqual(widenBrain(new SpikingNetwork(44).toJSON()));
    expect(result!.validation.parent).toHaveLength(1);expect(result!.validation.offspring).toHaveLength(1);
  },30000);
});
