import {DEFAULT_ROBOT,type RobotConfig} from '../robot/model';
import {DEFAULT_ADAPTER} from '../robot/controls';

/** Nominal wheel RPM at 6 V; driver loss is a simple voltage approximation. */
export type ParkingDrive={rpm:number;voltage:number;bridgeDrop:number;reverseScale:number};
export const DEFAULT_PARKING_DRIVE:ParkingDrive={rpm:180,voltage:6,bridgeDrop:1.8,reverseScale:1};
export function validateParkingDrive(raw:unknown):ParkingDrive{
  if(raw===undefined)return {...DEFAULT_PARKING_DRIVE};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid parking motor profile.');
  const d=raw as ParkingDrive;
  for(const [key,min,max] of [['rpm',100,240],['voltage',3,9],['bridgeDrop',0,4],['reverseScale',.3,1]] as const){
    const v=d[key];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(`Invalid parking motor ${key}.`);
  }
  if(d.voltage<=d.bridgeDrop||d.voltage-d.bridgeDrop>6)throw Error('Keep estimated motor voltage above zero and at or below 6 V.');
  return {rpm:d.rpm,voltage:d.voltage,bridgeDrop:d.bridgeDrop,reverseScale:d.reverseScale};
}
export function parkingRobotConfig(drive?:ParkingDrive):RobotConfig{
  const d=validateParkingDrive(drive);return {...DEFAULT_ROBOT,rpm:d.rpm,voltage:d.voltage,bridgeDrop:d.bridgeDrop};
}
export function parkingDriveSpeeds(drive?:ParkingDrive){
  const d=validateParkingDrive(drive),ideal=d.rpm/60*Math.PI*DEFAULT_ROBOT.wheelDiameter,
    forward=ideal*(d.voltage-d.bridgeDrop)/6;
  const commandScale=DEFAULT_ADAPTER.maxPWM/255;
  return {ideal,forward,reverse:forward*d.reverseScale,commandForward:forward*commandScale,commandReverse:forward*d.reverseScale*commandScale,maxPWM:DEFAULT_ADAPTER.maxPWM};
}
