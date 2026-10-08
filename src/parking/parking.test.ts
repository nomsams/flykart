import {describe,expect,it} from 'vitest';
import {SpikingNetwork,Action} from '../core';
import {VisionCnn} from '../vision/cnn';
import {defaultSpec,serialiseModel} from '../vision/perception';
import {ROBOT_WORLD_CAMERA,CM_PER_PIXEL} from '../vision/robot';
import {DEFAULT_MEMORY,RoomMemory} from '../robot/memory';
import {DEFAULT_VISION} from '../robot/vision-workbench';
import {DEFAULT_ROBOT,overlaps} from '../robot/model';
import {widenBrain,narrowBrain} from '../vision/inputs';
import {importFile} from '../vision/format';
import {DEFAULT_PARKING,LESSONS,generateParking,validateParkingScene,parkingQuality,bodySolid,actorSolid} from './model';
import {ParkingEpisode,ParkingCue,PX} from './episode';
import {ParkingBrain,ParkingSession,parkingDomain} from './session';
import {parkingBrainText,parkingLab,parseParkingLab,parkingRobotScene} from './files';
import {coachChild,trainParking} from './training';

const idle:Action={steer:0,throttle:0,brake:0,reverse:0};
const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8};
const eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'parking unit fixture',undefined,undefined,'world');
const brain=():ParkingBrain=>({controller:widenBrain(new SpikingNetwork(13).toJSON()),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512},metadata:{generation:7,fitness:22,track:'all'}});
const episode=(lesson:typeof DEFAULT_PARKING.lesson,seed=1701)=>new ParkingEpisode({...DEFAULT_PARKING,lesson,seed},ROBOT_WORLD_CAMERA);
const hold=(e:ParkingEpisode)=>{for(let i=0;i<35&&!e.done;i++)e.step(idle);};

describe('parking lots and parking judge',()=>{
  it('generates valid, repeatable lots with vacant goals and safe starts in all lessons',()=>{
    for(const {id:lesson} of LESSONS)for(let seed=1;seed<=40;seed++){
      const s={...DEFAULT_PARKING,lesson,seed,traffic:8,pedestrians:8,shapeJitter:true};
      const a=generateParking(s);expect(validateParkingScene(a)).toEqual(a);expect(generateParking(s)).toEqual(a);
      expect(a.target.occupied).toBe(false);expect(a.actors.some(o=>overlaps(bodySolid(a.start,DEFAULT_ROBOT.length,DEFAULT_ROBOT.width),actorSolid(o)))).toBe(false);
      for(let i=0;i<a.actors.length;i++)for(let j=i+1;j<a.actors.length;j++)expect(overlaps(actorSolid(a.actors[i]),actorSolid(a.actors[j]))).toBe(false);
    }
  });
  it('varies target bays, headings and start poses across seeds, including parallel gaps',()=>{
    for(const lesson of ['oriented','parallel'] as const){const lots=Array.from({length:30},(_,i)=>generateParking({...DEFAULT_PARKING,lesson,seed:i+1}));expect(new Set(lots.map(s=>s.target.id)).size).toBeGreaterThan(2);if(lesson==='oriented')expect(new Set(lots.map(s=>s.target.heading)).size).toBe(2);else expect(lots.every(s=>s.actors.length===5)).toBe(true);}
  });
  it('rejects duplicate bay IDs, occupied goals and starts inside actual block bodies',()=>{
    const a=generateParking({...DEFAULT_PARKING,lesson:'switch'});a.bays[1].id=a.bays[0].id;expect(()=>validateParkingScene(a)).toThrow('Duplicate');
    const b=generateParking(DEFAULT_PARKING);b.target.occupied=true;expect(()=>validateParkingScene(b)).toThrow();
    const c=generateParking(DEFAULT_PARKING);c.start={...c.actors[0].pose};expect(()=>validateParkingScene(c)).toThrow('inside');
  });
  it('distinguishes centre arrival, full rotated chassis fit and requested direction',()=>{
    const e=episode('oriented'),b=e.scene.target;
    expect(parkingQuality({x:b.x,z:b.z,heading:b.heading},b).inside).toBe(true);
    const outside={x:b.x+.15*Math.cos(b.heading),z:b.z+.15*Math.sin(b.heading),heading:b.heading};
    expect(parkingQuality(outside,b).distance).toBeLessThan(.27);expect(parkingQuality(outside,b).inside).toBe(false);
    expect(parkingQuality({x:b.x,z:b.z,heading:b.heading+Math.PI},b).error).toBeCloseTo(Math.PI);
  });
  it('never wins by observing a flag; arrival requires proximity and stopping',()=>{
    const e=episode('arrival'),cue=new ParkingCue(e.camera);cue.observe(e.render(),0);cue.observe(e.render(),2);hold(e);expect(e.status.success).toBe(false);
    e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:e.scene.target.heading+Math.PI};hold(e);expect(e.status.success).toBe(true);expect(e.status.hold).toBe(30);
  });
  it('ignores heading in loose lesson rewards but requires it in precise lessons',()=>{
    const a=episode('arrival'),b=episode('arrival');for(const e of [a,b])e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:e.scene.target.heading+(e===b?Math.PI:0)};hold(a);hold(b);expect(a.status.reward).toBeCloseTo(b.status.reward);
    const c=episode('oriented');c.physics.pose={x:c.scene.target.x,z:c.scene.target.z,heading:c.scene.target.heading+Math.PI};hold(c);expect(c.status.success).toBe(false);c.physics.pose.heading=c.scene.target.heading;hold(c);expect(c.status.success).toBe(true);
  });
  it('a manual reverse leaves a parked bay and actual contact stops motion',()=>{
    const e=episode('exit'),start={...e.physics.pose};for(let i=0;i<150;i++)e.step({...idle,reverse:.8});expect(e.physics.pose.z-start.z).toBeGreaterThan(.5);
    const a=episode('arrival');a.physics.pose={x:a.scene.actors[0].pose.x,z:-.5,heading:-Math.PI/2};for(let i=0;i<150;i++)a.step({...idle,throttle:1});expect(a.physics.blocked).toBe(true);expect(a.status.contacts).toBeGreaterThan(0);expect(a.physics.pose.z).toBeGreaterThan(-.7);expect(a.physics.speed).toBe(0);
  });
  it('sparse sugar is completion-only and frozen tests dispense no sugar',()=>{
    for(const phase of ['sparse','frozen'] as const){const e=new ParkingEpisode({...DEFAULT_PARKING,phase},ROBOT_WORLD_CAMERA);e.step({...idle,throttle:1});expect(e.status.reward).toBe(0);e.physics.speed=0;e.physics.left=e.physics.right=0;e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:0};hold(e);expect(e.status.success).toBe(true);expect(e.status.reward).toBe(phase==='frozen'?0:140);}
  });
  it('signed shaping cannot farm sugar by returning to the same pose',()=>{
    const e=episode('arrival'),start={...e.physics.pose};e.physics.pose.x+=.2;e.step(idle);e.physics.pose={...start};e.step(idle);expect(e.status.reward).toBeCloseTo(0,9);
  });
});

describe('camera and sensor-only parking',()=>{
  it('visual driving never queries privileged geometry or a goal compass',()=>{
    const s=new ParkingSession({...DEFAULT_PARKING,maxTicks:60},brain());s.episode.truth=()=>{throw Error('privileged');};s.episode.mission=()=>{throw Error('compass');};
    const actor=s.episode.scene.actors[0];s.episode.physics.pose={x:actor.pose.x,z:-.4,heading:-Math.PI/2};for(let i=0;i<8;i++)s.step();expect(s.driver.sensors).toHaveLength(19);expect(s.driver.sensors.every(Number.isFinite)).toBe(true);expect(s.scan.samples.length).toBeGreaterThan(3);expect(s.scan.cells.size).toBeGreaterThan(0);
  });
  it('reward and collision labels cannot alter neural sensor inputs',()=>{
    const b=brain(),a=new ParkingSession({...DEFAULT_PARKING,phase:'frozen'},b),c=new ParkingSession({...DEFAULT_PARKING,phase:'frozen'},b);c.episode.status.reward=999;c.episode.status.pain=1000;c.episode.status.contacts=500;a.step();c.step();expect(a.driver.sensors).toEqual(c.driver.sensors);
  });
  it('defaults to 4096 cells and distinct actual eye crops without changing raw pixels',()=>{
    const b=brain();b.memory={...DEFAULT_MEMORY};b.visual={...DEFAULT_VISION,layout:'circle9'};const s=new ParkingSession(DEFAULT_PARKING,b);expect(s.memory.count).toBe(4096);expect(s.driver.ensemble!.frames).toHaveLength(9);expect(s.driver.ensemble!.frames[0]).not.toEqual(s.driver.ensemble!.frames[1]);const raw=s.episode.frame.slice();s.driver.ensemble!.see(raw,s.episode.proprioception());expect(s.episode.frame).toEqual(raw);expect(s.episode.camera.mountHeight*CM_PER_PIXEL).toBeCloseTo(6.5);
  });
  it('extracts both marker orientations from RGB, without pose access',()=>{
    const e=episode('oriented');e.scene.actors=[];e.scene.target={...e.scene.target,x:0,z:0,heading:Math.PI/2};e.physics.pose={x:-.5,z:0,heading:0};e.cameraScene.style.noise=0;
    const cue=new ParkingCue(e.camera);cue.observe(e.render(),0);expect(cue.confidence).toBe(1);expect(cue.alignment).toBeCloseTo(.5,1);
    e.scene.target.heading=-Math.PI/2;cue.observe(e.render(),2);expect(cue.confidence).toBe(1);expect(cue.alignment).toBeCloseTo(-.5,1);
    const offscreen=new Float32Array(e.frame.length);cue.observe(offscreen,4);expect(cue.cue()).toEqual([0,0,0,0]);
  });
  it('alignment advisory is absent when no direction marker is observed',()=>{
    const estimates=new Array(10).fill(.1),body={speed:0,lastSteer:0,lastDrive:0};expect(parkingDomain.sensors(estimates,[0,.4,1,0],body)).toEqual(parkingDomain.sensors(estimates,[0,.4,0,0],body));expect(parkingDomain.sensors(estimates,[0,.4,1,1],body)[15]).toBeGreaterThan(.5);
  });
  it('scan pose stays fixed when commanded motion is physically blocked',()=>{
    const s=new ParkingSession(DEFAULT_PARKING,brain()),a=s.episode.scene.actors[0];s.episode.physics.pose={x:a.pose.x,z:-.5,heading:-Math.PI/2};for(let i=0;i<120;i++)s.step({...idle,throttle:1});expect(s.episode.physics.blocked).toBe(true);const p={...s.episode.physics.pose};for(let i=0;i<20;i++)s.step({...idle,throttle:1});expect(s.episode.physics.pose).toEqual(p);expect(s.episode.proprioception().speed).toBeGreaterThan(.1);const ping=s.scan.samples.at(-1)!;expect(ping.x).toBeCloseTo(p.x*PX);expect(ping.y).toBeCloseTo((p.z-.26*.48)*PX);
  });
  it('frozen runs leave both neural weights and visual memory unchanged',()=>{
    const b=brain(),m=new RoomMemory(b.memory),s=new ParkingSession({...DEFAULT_PARKING,phase:'frozen'},b,{memory:m});const before=m.toJSON(),network=s.network.toJSON();for(let i=0;i<8;i++)s.step();expect(m.toJSON()).toEqual(before);expect(s.network.toJSON()).toEqual(network);
  });
});

describe('traffic, transfer and evolution',()=>{
  it('traffic follows lanes with headway and yields to a nearby parking manoeuvre',()=>{
    const e=episode('traffic'),car=e.scene.actors.find(a=>a.id==='traffic-0')!;car.pose={x:e.physics.pose.x,z:-.1,heading:-Math.PI/2};car.route=[{x:e.physics.pose.x,z:-1.2}];car.waypoint=0;e.step(idle);expect(car.speed).toBe(0);expect(car.yielding).toContain('Parking');
    const a=episode('traffic');a.physics.pose={x:0,z:2.2,heading:0};for(let i=0;i<150;i++)a.step(idle);expect(a.scene.actors.find(v=>v.id==='traffic-0')!.pose.x).toBeLessThan(-2);expect(a.scene.actors.some(v=>v.kind==='pedestrian'&&v.pose.z>-1.6)).toBe(true);
  });
  it('pedestrian contact ends the trial with a penalty and stylized effect',()=>{
    const e=episode('traffic'),ped=e.scene.actors.find(a=>a.kind==='pedestrian')!;ped.route=[];ped.pose={x:0,z:0,heading:0};e.physics.pose={x:-.18,z:0,heading:0};e.physics.speed=.2;e.physics.left=e.physics.right=.2;for(let i=0;i<15&&!e.done;i++)e.step({...idle,throttle:1});expect(e.status.pedestrianHits).toBe(1);expect(e.done).toBe(true);expect(e.status.score).toBeLessThan(-1000);expect(e.effects[0].kind).toBe('blood');
  });
  it('standard exports preserve weights, memory, swarm and checkpoint metadata',()=>{
    const b=brain(),s=new ParkingSession(DEFAULT_PARKING,b),text=parkingBrainText(b,s.memory,DEFAULT_PARKING),parsed=importFile(text);expect(parsed.controller!.domain).toBe('world');expect(parsed.controller!.snapshot).toEqual(b.controller);expect(parsed.controller!.meta.generation).toBe(7);expect(parsed.controller!.meta.fitness).toBe(22);expect(parsed.experiment!.visual).toEqual(b.visual);expect(RoomMemory.fromJSON(parsed.worldMemory).toJSON()).toEqual(s.memory.toJSON());expect(JSON.parse(text).robotLearning.memorySettings.count).toBe(512);
    expect(narrowBrain(widenBrain(new SpikingNetwork(13).toJSON()))).toEqual(new SpikingNetwork(13).toJSON());
  });
  it('lab round trip preserves the exact replay lot, eyes, memory and scan',()=>{
    const b=brain(),s=new ParkingSession(DEFAULT_PARKING,b);s.step();const file=parkingLab(DEFAULT_PARKING,s.episode.scene,b,s.memory,s.scan),r=parseParkingLab(JSON.parse(JSON.stringify(file)));expect(r.scene).toEqual(s.episode.scene);expect(r.brain.controller).toEqual(b.controller);expect(r.memory.toJSON()).toEqual(s.memory.toJSON());expect(r.scan.toJSON()).toEqual(s.scan.toJSON());file.settings={...file.settings,seed:3};expect(()=>parseParkingLab(file)).toThrow('matching');
  });
  it('exports static 3D geometry and a goal without pretending traffic/orientation are portable',()=>{
    const a=generateParking({...DEFAULT_PARKING,lesson:'traffic'}),file=parkingRobotScene(a);expect(file.objects).toHaveLength(a.actors.length);expect(file.startPose).toEqual(a.start);expect(file.mission.goals[0].x).toBe(a.target.x);expect(file.parkingNote).toContain('does not enforce');expect(file.objects.every(o=>o.kind==='block')).toBe(true);
  });
  it('manual imitation seeds a child without changing the parent',()=>{
    const parent=SpikingNetwork.fromJSON(brain().controller),before=parent.toJSON(),examples=Array.from({length:40},()=>({inputs:new Array(19).fill(.4),target:{...idle,reverse:.8}})),child=coachChild(parent,examples);expect(parent.toJSON()).toEqual(before);expect(child.toJSON()).not.toEqual(before);expect(()=>coachChild(parent,[{inputs:[1],target:idle}])).toThrow();
  });
  it('evolves independent ghosts on fresh seeded lots, reserves held-out tests and keeps its parent',async()=>{
    const b=brain(),before=structuredClone(b.controller),seen=new Set<ParkingSession>(),settings={...DEFAULT_PARKING,maxTicks:60};
    const run=()=>trainParking(b,settings,{generations:2,population:2,lessons:['arrival','exit'],seed:72,speed:0,cancel:()=>false,log:()=>{},progress:s=>s.forEach(a=>seen.add(a))});
    const a=(await run())!,c=(await run())!;expect(a.brain).toEqual(c.brain);expect(a.trials).toEqual(c.trials);expect(a.validation).toEqual(c.validation);expect(b.controller).toEqual(before);
    const seeds=[...a.trials.flatMap(g=>g.scenarios.map(s=>s.seed)),...a.validation.scenarios.map(s=>s.seed)];expect(new Set(seeds).size).toBe(seeds.length);expect(a.trials[1].scenarios[1].lesson).toBe('exit');expect(new Set([...seen].map(s=>s.memory)).size).toBe(seen.size);expect(a.memoryProtocol).toContain('frozen');
  },30000);
  it('rejects frozen evolution and cancels without changing the parent',async()=>{
    const b=brain(),before=structuredClone(b.controller),options={generations:1,population:2,lessons:['arrival'] as const,seed:7,speed:0,cancel:()=>true,log:()=>{},progress:()=>{}};
    await expect(trainParking(b,{...DEFAULT_PARKING,phase:'frozen'},{...options,lessons:[...options.lessons]})).rejects.toThrow('Frozen');expect(await trainParking(b,DEFAULT_PARKING,{...options,lessons:[...options.lessons]})).toBeNull();expect(b.controller).toEqual(before);
  });
});
