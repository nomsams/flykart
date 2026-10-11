import {describe,it,expect} from 'vitest';
import {DEFAULT_PARKING,generateParking,validateParkingSettings} from './model';
import {ParkingEpisode,type ParkingResult} from './episode';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import {parkingTradeoff,parkingSelectionScore,parkingFitness} from './selection';
const original=new ParkingEpisode(DEFAULT_PARKING,ROBOT_WORLD_CAMERA).result(),scenario={seed:DEFAULT_PARKING.seed,lesson:DEFAULT_PARKING.lesson},scenarios=[scenario];
const result=(patch:Partial<ParkingResult>)=>({...original,ticks:60,...patch});
const metric=(r:ParkingResult)=>parkingTradeoff([r],scenarios,DEFAULT_PARKING);
describe('transparent breeding objectives',()=>{
  it('migrates older settings to original score breeding and validates custom weights',()=>{
    const old={...DEFAULT_PARKING} as Record<string,unknown>;for(const k of ['selection','scoreWeight','speedWeight','safetyWeight'])delete old[k];expect(validateParkingSettings(old)).toEqual(DEFAULT_PARKING);
    for(const patch of [{selection:'unknown'},{scoreWeight:-1},{speedWeight:NaN},{scoreWeight:0,speedWeight:0,safetyWeight:0}])expect(()=>validateParkingSettings({...old,...patch})).toThrow('breeding');
  });
  it('preserves the exact previous score fitness by default, including disqualified results',()=>{for(const disqualified of [false,true]){const rows=[result({score:4,disqualified}),result({success:true,score:123})],m=parkingTradeoff(rows,[scenario,scenario],DEFAULT_PARKING);expect(parkingSelectionScore(m,DEFAULT_PARKING)).toBe(rows.reduce((a,r)=>a+parkingFitness(r),0)/2);}});
  it('actually ranks faster progress higher and safer progress with fewer contacts higher',()=>{
    const fast=metric(result({success:true,score:100,contacts:4,pain:2,ticks:60})),safe=metric(result({success:true,score:90,contacts:0,pain:0,ticks:120}));
    expect(parkingSelectionScore(fast,{...DEFAULT_PARKING,selection:'speed'})).toBeGreaterThan(parkingSelectionScore(safe,{...DEFAULT_PARKING,selection:'speed'}));
    expect(parkingSelectionScore(safe,{...DEFAULT_PARKING,selection:'safety'})).toBeGreaterThan(parkingSelectionScore(fast,{...DEFAULT_PARKING,selection:'safety'}));
    expect(parkingSelectionScore(fast,{...DEFAULT_PARKING,selection:'balanced',scoreWeight:1,speedWeight:0,safetyWeight:0})).toBeGreaterThan(parkingSelectionScore(safe,{...DEFAULT_PARKING,selection:'balanced',scoreWeight:1,speedWeight:0,safetyWeight:0}));
  });
  it('does not reward standing still as safe and cannot prefer partial progress to completed parking',()=>{
    const lot=generateParking(DEFAULT_PARKING),distance=Math.hypot(lot.start.x-lot.target.x,lot.start.z-lot.target.z)*100,stopped=metric(result({offsetCm:distance,contacts:0,pain:0,ticks:300})),moving=metric(result({offsetCm:distance/2,contacts:1,pain:1,ticks:300}));
    expect(parkingSelectionScore(moving,{...DEFAULT_PARKING,selection:'safety'})).toBeGreaterThan(parkingSelectionScore(stopped,{...DEFAULT_PARKING,selection:'safety'}));
    for(const selection of ['speed','safety','balanced'] as const){const settings={...DEFAULT_PARKING,selection};expect(parkingSelectionScore(metric(result({success:true,score:-400,pain:3,ticks:900})),settings)).toBeGreaterThan(parkingSelectionScore(moving,settings));expect(parkingSelectionScore(metric(result({disqualified:true,success:true,score:10000})),settings)).toBe(-100000);}
  });
});
