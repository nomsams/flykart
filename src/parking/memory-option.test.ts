import {it,expect} from 'vitest';
import {SpikingNetwork} from '../core';
import {VisionCnn} from '../vision/cnn';
import {defaultSpec,serialiseModel} from '../vision/perception';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import {DEFAULT_MEMORY,RoomMemory} from '../robot/memory';
import {DEFAULT_VISION} from '../robot/vision-workbench';
import {widenBrain} from '../vision/inputs';
import {importFile} from '../vision/format';
import {DEFAULT_PARKING,generateParking,validateParkingSettings} from './model';
import {ParkingSession} from './session';
import {parkingLab,parseParkingLab,parkingBrainText} from './files';

it('migrates old parking settings to enabled memory and rejects invalid memory switches',()=>{
  const {memoryOn:_,...old}=DEFAULT_PARKING;expect(validateParkingSettings(old).memoryOn).toBe(true);expect(()=>validateParkingSettings({...old,memoryOn:1})).toThrow();
});
it('memory off skips recall and learning, preserves saved memory, retains sensors and round-trips the choice',()=>{
  const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8},eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'fixture',undefined,undefined,'world');
  const brain={controller:widenBrain(new SpikingNetwork(13).toJSON()),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512}},memory=new RoomMemory(brain.memory);
  for(let i=0;i<4;i++)memory.observe(new Float32Array(24).fill(.4),new Float32Array(10).fill(.7));
  const before=memory.toJSON();memory.observe=()=>{throw Error('Disabled memory must not be queried.');};
  const settings={...DEFAULT_PARKING,memoryOn:false,maxTicks:60},scene=generateParking(settings),session=new ParkingSession(settings,brain,{scene,memory});
  expect(session.driver.options.roomMemory).toBeUndefined();for(let i=0;i<20;i++)session.step({steer:0,throttle:0,brake:0,reverse:0});
  expect(memory.toJSON()).toEqual(before);expect(session.scan.samples.length).toBeGreaterThan(1);expect(session.driver.perception).not.toBeNull();
  const parsed=parseParkingLab(parkingLab(settings,scene,brain,memory,session.scan));expect(parsed.settings.memoryOn).toBe(false);expect(parsed.memory.toJSON()).toEqual(before);
  const text=parkingBrainText(brain,memory,settings);expect(importFile(text).worldTraining?.memoryEnabled).toBe(false);expect(JSON.parse(text).robotLearning.learn).toBe(false);
  const enabled=new ParkingSession({...settings,memoryOn:true},brain,{scene});expect(enabled.driver.options.roomMemory).toBe(enabled.memory);expect(enabled.memory.taught).toBeGreaterThan(0);
});
