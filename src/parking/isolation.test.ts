import {describe,it,expect,vi} from 'vitest';
import {SpikingNetwork} from '../core';
import {VisionCnn} from '../vision/cnn';
import {defaultSpec,serialiseModel} from '../vision/perception';
import {ROBOT_WORLD_CAMERA,ROBOT_PROFILE} from '../vision/robot';
import {DEFAULT_MEMORY,RoomMemory} from '../robot/memory';
import {DEFAULT_VISION} from '../robot/vision-workbench';
import {WorldSession} from '../vision/ui/sessions';
import {DEFAULT_PARKING,generateParking} from './model';
import {ParkingSession,type ParkingBrain} from './session';
import {capturePreview,TrainingPreviews} from '../training-preview';
const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8};
const eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'isolation fixture',undefined,undefined,'world');
const brain:ParkingBrain={controller:new SpikingNetwork(13,19).toJSON(),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512}};
describe('independent evolution worlds',()=>{
  it('other parking ghosts never become camera/sonar/contact obstacles, even with moving traffic',()=>{
    const settings={...DEFAULT_PARKING,lesson:'traffic' as const,maxTicks:120},scene=generateParking(settings),a=new ParkingSession(settings,brain,{scene}),b=new ParkingSession(settings,brain,{scene}),control=new ParkingSession(settings,brain,{scene});
    expect(a.episode.scene).not.toBe(b.episode.scene);a.episode.physics.pose={...b.episode.physics.pose};a.episode.scene.actors[0].pose.x+=.2;
    for(let tick=0;tick<45;tick++){a.step({steer:1,throttle:.5,reverse:0,brake:0});b.step();control.step();expect(b.driver.sensors).toEqual(control.driver.sensors);expect(b.lastAction).toEqual(control.lastAction);}
    expect(b.episode.frame).toEqual(control.episode.frame);expect(b.episode.sonar()).toEqual(control.episode.sonar());expect(b.episode.result()).toEqual(control.episode.result());expect(b.memory.toJSON()).toEqual(control.memory.toJSON());expect(scene).toEqual(generateParking(settings));
  });
  it('imported open-world clutter is cloned for every ghost',()=>{
    const world={seed:1,half:460,obstacles:[{x:90,y:0,radius:20,height:30,tone:.5,kind:'rock' as const}],patches:[]},settings={seed:77,density:0,style:0,kind:'vision' as const,fade:0,controller:brain.controller,vision:eyes,task:'explore' as const,maxTicks:120,memorySettings:brain.memory,profile:ROBOT_PROFILE,world,start:{x:0,y:0,heading:0}};
    const a=new WorldSession(settings),b=new WorldSession(settings),control=new WorldSession(settings);a.episode.sim.world.obstacles[0].x=20;a.episode.sim.kart.x=30;
    for(let i=0;i<30;i++){a.step();b.step();control.step();expect(b.driver!.sensors).toEqual(control.driver!.sensors);expect(b.lastAction).toEqual(control.lastAction);}
    expect(b.episode.frame).toEqual(control.episode.frame);expect(b.episode.sonar()).toEqual(control.episode.sonar());expect(world.obstacles[0].x).toBe(90);
  });
  it('headless observer creation performs no duplicate camera inference or memory learning',()=>{
    const s=new ParkingSession(DEFAULT_PARKING,brain,{diagnostics:()=>false}),rows=[structuredClone(capturePreview(s,1,false))];
    const inference=vi.spyOn(VisionCnn.prototype,'forward'),learning=vi.spyOn(RoomMemory.prototype,'observe');try{
      const views=new TrainingPreviews({kind:'parking',brain,settings:s.settings}),v=views.update(rows)[0] as ParkingSession;
      expect(inference).not.toHaveBeenCalled();expect(learning).not.toHaveBeenCalled();expect(v.episode.tick).toBe(s.episode.tick);expect(v.scan.samples).toHaveLength(0);
      const shown=views.update([structuredClone(capturePreview(s,1,true))])[0] as ParkingSession;expect(shown).toBe(v);expect(shown.episode.frame).toEqual(s.episode.frame);expect(shown.episode.result()).toEqual(s.episode.result());expect(()=>shown.step()).toThrow('previews cannot');
      expect(inference).not.toHaveBeenCalled();expect(learning).not.toHaveBeenCalled();expect(rows[0].state).not.toHaveProperty('cue');expect(rows[0].state.driver).not.toHaveProperty('perception');
    }finally{inference.mockRestore();learning.mockRestore();}
  });
});
