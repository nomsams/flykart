import {it,expect} from 'vitest';
import {DEFAULT_PARKING_DRIVE,validateParkingDrive,parkingDriveSpeeds,parkingRobotConfig} from './drive';
import {RobotPhysics} from '../robot/model';
import {ParkingEpisode} from './episode';
import {DEFAULT_PARKING,validateParkingSettings} from './model';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
it('limits forward and reverse speed from the real wheel and motor specs, including driver loss',()=>{
  expect(parkingDriveSpeeds({rpm:100,voltage:6,bridgeDrop:0,reverseScale:1}).forward).toBeCloseTo(.3403392);
  expect(parkingDriveSpeeds({rpm:240,voltage:6,bridgeDrop:0,reverseScale:1}).forward).toBeCloseTo(.8168141);
  const speed=parkingDriveSpeeds();expect(speed.forward).toBeCloseTo(.4288274);expect(speed.reverse).toBe(speed.forward);
  expect(speed.commandForward).toBeCloseTo(.3363352);expect(speed.commandReverse).toBe(speed.commandForward);
  expect(parkingDriveSpeeds({...DEFAULT_PARKING_DRIVE,reverseScale:.6}).reverse).toBeCloseTo(speed.forward*.6);
});
it('applies the parking adapter PWM limit and reverse fraction to actual episode motion',()=>{
  const drive={...DEFAULT_PARKING_DRIVE,reverseScale:.6},e=new ParkingEpisode({...DEFAULT_PARKING,drive},ROBOT_WORLD_CAMERA),limits=parkingDriveSpeeds(drive);
  e.scene.actors.length=0;e.physics.pose={x:0,z:1,heading:0};
  for(let i=0;i<40;i++)e.step({steer:0,throttle:1,brake:0,reverse:0});
  expect(e.physics.speed).toBeCloseTo(limits.commandForward,3);
  for(let i=0;i<40;i++)e.step({steer:0,throttle:0,brake:0,reverse:1});
  expect(e.physics.speed).toBeCloseTo(-limits.commandReverse,3);
});
it('keeps legacy parking physics by default and persists validated motor parameters',()=>{
  expect(validateParkingSettings(DEFAULT_PARKING).drive).toEqual(DEFAULT_PARKING_DRIVE);
  const drive={rpm:120,voltage:6,bridgeDrop:2,reverseScale:.7},settings=validateParkingSettings({...DEFAULT_PARKING,drive});
  const episode=new ParkingEpisode(settings,ROBOT_WORLD_CAMERA);expect(episode.physics.maxSpeed).toBeCloseTo(parkingDriveSpeeds(drive).forward);
  expect(validateParkingSettings(JSON.parse(JSON.stringify(settings))).drive).toEqual(drive);
  for(const invalid of [{...drive,rpm:241},{...drive,voltage:9,bridgeDrop:0},{...drive,reverseScale:NaN},{...drive,bridgeDrop:6}])expect(()=>validateParkingDrive(invalid)).toThrow();
});
it('ramps motor speed and decelerates through zero before reversing',()=>{
  const physics=new RobotPhysics(parkingRobotConfig());physics.pose={x:0,z:0,heading:0};
  physics.step(1,1,[],1/30);expect(physics.speed).toBeGreaterThan(0);expect(physics.speed).toBeLessThan(physics.maxSpeed/2);
  for(let i=0;i<40;i++)physics.step(1,1,[],1/30);
  const speed=physics.speed;physics.step(-1,-1,[],1/30);expect(physics.speed).toBeGreaterThan(0);expect(physics.speed).toBeLessThan(speed);
  for(let i=0;i<40;i++)physics.step(-1,-1,[],1/30);
  expect(physics.speed).toBeCloseTo(-physics.maxSpeed,3);
});
