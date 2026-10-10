import {describe,expect,it} from 'vitest';
import visualParent from '../../assets/flykart-visual.json?raw';
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
import {ParkingEpisode,ParkingCue,PX,parkingMotorRequests} from './episode';
import {ParkingBrain,ParkingSession,parkingDomain,alignedParkingDomain} from './session';
import {worldDomain,WORLD_CAMERA} from '../vision/world/worldDomain';
import {VisionDriver} from '../vision/pipeline';
import {Perceiver} from '../vision/perception';
import {parkingBrainText,parkingLab,parseParkingLab,parkingRobotScene} from './files';
import {coachChild,trainParking} from './training';
import {renderFrame,DEFAULT_STYLE,CameraConfig,Scene,Sprite} from '../vision/camera';
import {validateParkingSettings} from './model';

const idle:Action={steer:0,throttle:0,brake:0,reverse:0};
const spec={...defaultSpec(2,10,'rgb',false,5),channels:[2,2,2] as [number,number,number],hidden:8};
const eyes=serialiseModel(new VisionCnn(spec,7),ROBOT_WORLD_CAMERA,new Array(10).fill(1),'parking unit fixture',undefined,undefined,'world');
const brain=():ParkingBrain=>({controller:widenBrain(new SpikingNetwork(13).toJSON()),eyes,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512},metadata:{generation:7,fitness:22,track:'all'}});
const episode=(lesson:typeof DEFAULT_PARKING.lesson,seed=1701)=>new ParkingEpisode({...DEFAULT_PARKING,lesson,seed},ROBOT_WORLD_CAMERA);
const hold=(e:ParkingEpisode)=>{for(let i=0;i<35&&!e.done;i++)e.step(idle);};

describe('parking lots and parking judge',()=>{
  it('migrates old saved settings and validates delayed reward configuration',()=>{
    const old={...DEFAULT_PARKING} as Partial<typeof DEFAULT_PARKING>;delete old.delayReward;delete old.rewardDelaySeconds;delete old.sonarOn;delete old.cameraMount;delete old.bayAlignment;delete old.floor;
    expect(validateParkingSettings(old)).toEqual(DEFAULT_PARKING);
    expect(()=>validateParkingSettings({...DEFAULT_PARKING,rewardDelaySeconds:-1})).toThrow('reward delay');
    expect(()=>validateParkingSettings({...DEFAULT_PARKING,delayReward:'yes'})).toThrow();
    expect(()=>validateParkingSettings({...DEFAULT_PARKING,sonarOn:'yes'})).toThrow('sensor');
    expect(()=>validateParkingSettings({...DEFAULT_PARKING,cameraMount:'wrong'})).toThrow('sensor');
    expect(()=>validateParkingSettings({...DEFAULT_PARKING,floor:'wrong'})).toThrow('sensor');
  });
  it('withholds all sugar until parked, controls released and the full delay elapsed',()=>{
    const e=new ParkingEpisode({...DEFAULT_PARKING,delayReward:true,rewardDelaySeconds:.5},ROBOT_WORLD_CAMERA);
    e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:0};
    for(let i=0;i<44;i++)e.step(idle);
    expect(e.status.success).toBe(false);expect(e.status.reward).toBe(0);expect(e.status.pendingReward).toBeGreaterThan(0);
    e.step(idle);expect(e.status.success).toBe(true);expect(e.status.reward).toBeGreaterThan(140);expect(e.status.pendingReward).toBe(0);
    const paid=e.status.reward;e.step(idle);expect(e.status.reward).toBe(paid);
  });
  it('brake or steering requests cannot earn delayed sugar by standing still; moving away resets the timer',()=>{
    const e=new ParkingEpisode({...DEFAULT_PARKING,delayReward:true,rewardDelaySeconds:.5},ROBOT_WORLD_CAMERA);
    e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:0};
    for(let i=0;i<60;i++)e.step({...idle,brake:1});expect(e.status.hold).toBe(0);expect(e.status.reward).toBe(0);expect(e.controlsReleased).toBe(false);
    for(let i=0;i<40;i++)e.step(idle);expect(e.status.hold).toBe(40);
    e.step({...idle,steer:.1});expect(e.status.hold).toBe(0);
    e.step(idle);e.physics.pose.z+=1;e.step(idle);expect(e.status.hold).toBe(0);
    e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:0};for(let i=0;i<45;i++)e.step(idle);expect(e.status.success).toBe(true);
  });
  it('timeouts lose pending sugar and frozen delayed tests still give no reward',()=>{
    for(const phase of ['shaped','sparse','frozen'] as const){
      const e=new ParkingEpisode({...DEFAULT_PARKING,phase,delayReward:true,rewardDelaySeconds:2,maxTicks:60},ROBOT_WORLD_CAMERA);
      e.physics.pose={x:e.scene.target.x,z:e.scene.target.z,heading:0};for(let i=0;i<60;i++)e.step(idle);
      expect(e.done).toBe(true);expect(e.status.success).toBe(false);expect(e.status.reward).toBe(0);expect(e.status.pendingReward).toBe(0);
    }
    const frozen=new ParkingEpisode({...DEFAULT_PARKING,phase:'frozen',delayReward:true,rewardDelaySeconds:.25},ROBOT_WORLD_CAMERA);frozen.physics.pose={x:frozen.scene.target.x,z:frozen.scene.target.z,heading:0};for(let i=0;i<38;i++)frozen.step(idle);expect(frozen.status.success).toBe(true);expect(frozen.status.reward).toBe(0);
  });
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
  it('the real visual parent has identical observations and actions for distinct fully hidden rear bays',()=>{
    const parent=importFile(visualParent),b:ParkingBrain={controller:widenBrain(parent.controller!.snapshot),eyes:parent.vision!,visual:{...DEFAULT_VISION,layout:'circle9',smooth:true},memory:{...DEFAULT_MEMORY,count:512}};
    const make=(z:number,cue:'visual'|'compass'='visual')=>{
      const scene=generateParking(DEFAULT_PARKING);scene.actors=[];scene.start={x:0,z:0,heading:0};scene.target={...scene.target,x:-2,z,heading:Math.PI/2};scene.bays=[{...scene.target}];
      return new ParkingSession({...DEFAULT_PARKING,cue,phase:'frozen'},b,{scene});
    };
    const a=make(-.8),c=make(.8);
    for(const s of [a,c]){s.episode.mission=()=>{throw Error('Hidden compass leak');};s.episode.truth=()=>{throw Error('Hidden geometry leak');};}
    for(let tick=0;tick<24;tick++){
      expect(a.episode.render()).toEqual(c.episode.render());a.step();c.step();
      expect(a.cue.tracker.current.visible).toBe(false);expect(c.cue.tracker.current.visible).toBe(false);
      expect(a.driver.sensors.slice(0,2)).toEqual([0,0]);expect(a.driver.sensors).toEqual(c.driver.sensors);
      expect(a.lastAction).toEqual(c.lastAction);expect(a.episode.physics.pose).toEqual(c.episode.physics.pose);
    }
    expect(make(-.8,'compass').driver.sensors[0]).toBeLessThan(0);expect(make(.8,'compass').driver.sensors[0]).toBeGreaterThan(0);
  },20000);
  it('renders box roofs and distinct shaded faces from actual volume, with near-camera and goal occlusion',()=>{
    const camera:CameraConfig={width:80,height:40,hfov:Math.PI/2,mountHeight:6.5,mountForward:0,pitch:.2};
    const box:Sprite={x:40,y:0,heading:Math.PI/4,length:26,width:17,z0:0,z1:11,color:[.2,.4,.8],shape:'oriented-box'};
    const scene:Scene={style:{...DEFAULT_STYLE,skyTop:[.1,.1,.1],skyHorizon:[.1,.1,.1],fogDistance:100000,noise:0},sprites:[box],prepare(){},ground(_x,_y,out){out[0]=out[1]=out[2]=.1;}};
    const capture=()=>renderFrame(scene,{x:0,y:0,heading:0},camera,new Float32Array(80*40*3)),count=(f:Float32Array)=>Array.from(f.slice(6400)).filter(v=>v>.45).length;
    const tall=capture();box.z1=2;const flat=capture();expect(count(tall)).toBeGreaterThan(count(flat)*2);box.z1=11;
    const blues=Array.from(tall.slice(6400)).filter(v=>v>.45);expect(Math.max(...blues)).toBeGreaterThan(.7);expect(Math.min(...blues)).toBeLessThan(.62);camera.mountHeight=18;const roof=capture();expect(Math.max(...roof.slice(6400))).toBeGreaterThan(.82);camera.mountHeight=6.5;
    box.heading=0;scene.sprites.push({...box,x:70,width:7,length:7,color:[1,.2,.62],shape:'flag'});const occluded=capture();expect(Array.from(occluded.slice(0,3200)).filter((r,i)=>r>.6&&occluded[3200+i]<.3)).toHaveLength(0);
    box.x=4;const near=capture();expect(count(near)).toBeGreaterThan(count(tall));
  });
  it('visual driving never queries privileged geometry or a goal compass',()=>{
    const s=new ParkingSession({...DEFAULT_PARKING,maxTicks:60},brain());s.episode.truth=()=>{throw Error('privileged');};s.episode.mission=()=>{throw Error('compass');};
    const actor=s.episode.scene.actors[0];s.episode.physics.pose={x:actor.pose.x,z:-.4,heading:-Math.PI/2};for(let i=0;i<8;i++)s.step();expect(s.driver.sensors).toHaveLength(19);expect(s.driver.sensors.every(Number.isFinite)).toBe(true);expect(s.scan.samples.length).toBeGreaterThan(3);expect(s.scan.cells.size).toBeGreaterThan(0);
  });
  it('reward and collision labels cannot alter neural sensor inputs',()=>{
    const b=brain(),a=new ParkingSession({...DEFAULT_PARKING,phase:'frozen'},b),c=new ParkingSession({...DEFAULT_PARKING,phase:'frozen',pathReward:true,reverseReward:true,approachRadius:6},b);c.episode.status.reward=999;c.episode.status.pain=1000;c.episode.status.contacts=500;a.step();c.step();expect(a.driver.sensors).toEqual(c.driver.sensors);
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
    const estimates=new Array(10).fill(.1),body={speed:0,lastSteer:0,lastDrive:0};expect(alignedParkingDomain.sensors(estimates,[0,.4,1,0],body)).toEqual(parkingDomain.sensors(estimates,[0,.4,0,0],body));expect(alignedParkingDomain.sensors(estimates,[0,.4,1,1],body)[15]).toBeGreaterThan(.5);
    expect(parkingDomain.sensors(estimates,[0,.4,1,1],body)).toEqual(worldDomain.sensors(estimates,[0,.4],body));
  });
  it('preserves the imported camera geometry unless the physical mount is explicitly selected',()=>{
    const b=brain();b.eyes={...b.eyes,camera:{...WORLD_CAMERA}};
    const s=new ParkingSession(DEFAULT_PARKING,b);expect(s.episode.camera).toEqual(WORLD_CAMERA);
    const physical=new ParkingSession({...DEFAULT_PARKING,cameraMount:'robot'},b);expect(physical.episode.camera.mountHeight/PX*100).toBeCloseTo(6.5);expect(physical.episode.camera.hfov).toBe(WORLD_CAMERA.hfov);
    expect(b.eyes.camera).toEqual(WORLD_CAMERA);
  });
  it('the bundled visual parent sees a clear transfer floor and its flag instead of hallucinating a wall',()=>{
    const f=importFile(visualParent),b:ParkingBrain={controller:widenBrain(f.controller!.snapshot),eyes:f.vision!,visual:{...DEFAULT_VISION},memory:{...DEFAULT_MEMORY,count:512}},before=structuredClone(b.controller);
    const scene=generateParking(DEFAULT_PARKING);scene.actors=[];scene.start={x:-1.2,z:.25,heading:0};scene.target={...scene.target,x:0,z:0,heading:Math.PI/2};scene.bays=scene.bays.map(b=>b.id===scene.target.id?{...scene.target}:b);
    const transfer=new ParkingSession({...DEFAULT_PARKING,phase:'frozen'},b,{scene}),asphalt=new ParkingSession({...DEFAULT_PARKING,phase:'frozen',floor:'asphalt'},b,{scene});
    expect(transfer.cue.tracker.current.visible).toBe(true);
    for(let i=0;i<12;i++){transfer.step();asphalt.step();}
    expect(Math.max(...transfer.driver.sensors.slice(5,8))).toBeLessThan(.3);
    expect(Math.max(...asphalt.driver.sensors.slice(5,8))).toBeGreaterThan(.85);
    expect(b.controller).toEqual(before);
  });
  it('steers the nose in opposite directions forward/backward, retaining the world last-gas/brake input',()=>{
    for(const direction of [-1,1]){
      const e=episode('arrival');e.scene.actors=[];e.physics.pose={x:0,z:0,heading:0};const a={...idle,steer:.6,throttle:direction>0?.6:0,reverse:direction<0?.6:0};
      const pwm=parkingMotorRequests(a);expect(Math.sign(pwm.left-pwm.right)).toBe(direction);
      for(let i=0;i<30;i++)e.step(a);expect(Math.sign(e.physics.pose.heading)).toBe(direction);expect(e.proprioception().lastDrive).toBe(a.throttle-a.brake);
    }
  });
  it('sonar is on by default; disabling zeros the brain and camera feedback and pauses scan recording',()=>{
    for(const sonarOn of [true,false]){
      const s=new ParkingSession({...DEFAULT_PARKING,sonarOn},brain());s.episode.physics.pose={x:2.65,z:0,heading:0};
      let cameraBody:{sonarCloseness?:number;sonarStrength?:number}|undefined;
      const reader=s.driver.options.perceiver!,read=reader.see.bind(reader);reader.see=(pixels,body)=>{cameraBody=body;return read(pixels,body);};
      for(let i=0;i<8;i++)s.step(idle);
      const r=s.episode.sonar();expect(r.echo).toBe(true);expect(s.driver.options.sonarOff).toBe(!sonarOn);
      expect(s.driver.sensors[17]>0).toBe(sonarOn);expect(s.driver.sensors[18]>0).toBe(sonarOn);expect(s.scan.samples.length>0).toBe(sonarOn);
      expect(cameraBody!.sonarCloseness!>0).toBe(sonarOn);expect(cameraBody!.sonarStrength!>0).toBe(sonarOn);
      const restored=parseParkingLab(parkingLab(s.settings,s.episode.scene,s.brain,s.memory,s.scan));expect(restored.settings.sonarOn).toBe(sonarOn);
    }
  });
  it('matches an open-world visual controller exactly for the same sensor observations',()=>{
    const b=brain(),s=new ParkingSession({...DEFAULT_PARKING,phase:'frozen'},b),pixels=s.episode.frame.slice();
    const reference=new VisionDriver({controller:SpikingNetwork.fromJSON(b.controller),perceiver:new Perceiver(b.eyes),domain:worldDomain,sensorOnly:true,visual:b.visual,resolution:'native',fusion:{fade:0},pixelMission:{reset(){},observe(){},cue(){return [.2,.4];}}});
    s.cue.observe=()=>{};s.cue.cue=()=>[.2,.4,.9,1];s.episode.render=()=>pixels;s.driver.reset();reference.reset();
    for(let i=0;i<8;i++){s.episode.status.ticks=i;const a=s.driver.act(s.episode),r=reference.act(s.episode);expect(a.sensors).toEqual(r.sensors);expect(a.action).toEqual(r.action);}
  });
  it('prepares the preview without taking a second neural step at tick zero',()=>{
    const s=new ParkingSession(DEFAULT_PARKING,brain()),activity=s.network.activity();
    const before=s.network.toJSON(),inputs=[...s.driver.sensors];s.step(idle);
    expect(s.network.toJSON()).toEqual(before);expect(s.driver.sensors).toEqual(inputs);expect(s.network.activity()).toEqual(activity);
  });
  it('bay direction is opt-in and cannot replace navigation in loose arrival lessons',()=>{
    expect(new ParkingSession({...DEFAULT_PARKING,bayAlignment:true},brain()).driver.domain).toBe(parkingDomain);
    expect(new ParkingSession({...DEFAULT_PARKING,lesson:'oriented'},brain()).driver.domain).toBe(parkingDomain);
    expect(new ParkingSession({...DEFAULT_PARKING,lesson:'oriented',bayAlignment:true},brain()).driver.domain).toBe(alignedParkingDomain);
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
  it('exports the actual camera mount and sonar choice for the next Vision stage',()=>{
    const b=brain();b.eyes={...b.eyes,camera:{...WORLD_CAMERA}};
    for(const cameraMount of ['trained','robot'] as const){
      const settings={...DEFAULT_PARKING,cameraMount,sonarOn:false},s=new ParkingSession(settings,b),f=importFile(parkingBrainText(b,s.memory,settings));
      expect(f.experiment!.camera!.heightCm).toBeCloseTo(s.episode.camera.mountHeight*1.1);expect(f.experiment!.camera!.hfov).toBeCloseTo(s.episode.camera.hfov*180/Math.PI);expect(f.worldSetup!.sonarOn).toBe(false);
    }
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
    const b=brain(),before=structuredClone(b.controller),seen=new Set<ParkingSession>(),settings={...DEFAULT_PARKING,maxTicks:60,sonarOn:false};
    const checkpoints:{generation:number;brain:ReturnType<SpikingNetwork['toJSON']>;training:Record<string,unknown>}[]=[];
    const run=()=>trainParking(b,settings,{generations:2,population:2,lessons:['arrival','exit'],seed:72,speed:0,cancel:()=>false,log:()=>{},progress:s=>s.forEach(a=>seen.add(a)),onGeneration:async c=>{checkpoints.push(structuredClone(c));}});
    const a=(await run())!,c=(await run())!;expect(checkpoints.map(v=>v.generation)).toEqual([1,2,1,2]);expect(checkpoints[1].brain).toEqual(a.brain);expect(checkpoints[0].training.scenarios).toEqual(a.trials[0].scenarios);expect(a.brain).toEqual(c.brain);expect(a.trials).toEqual(c.trials);expect(a.validation).toEqual(c.validation);expect(b.controller).toEqual(before);
    expect(a.settings.sonarOn).toBe(false);expect([...seen].every(s=>s.driver.sensors.slice(17,19).every(v=>v===0)&&s.scan.samples.length===0)).toBe(true);
    const seeds=[...a.trials.flatMap(g=>g.scenarios.map(s=>s.seed)),...a.validation.scenarios.map(s=>s.seed)];expect(new Set(seeds).size).toBe(seeds.length);expect(a.trials[1].scenarios[1].lesson).toBe('exit');expect(new Set([...seen].map(s=>s.memory)).size).toBe(seen.size);expect(a.memoryProtocol).toContain('frozen');
  },60000);
  it('rejects frozen evolution and cancels without changing the parent',async()=>{
    const b=brain(),before=structuredClone(b.controller),options={generations:1,population:2,lessons:['arrival'] as const,seed:7,speed:0,cancel:()=>true,log:()=>{},progress:()=>{}};
    await expect(trainParking(b,{...DEFAULT_PARKING,phase:'frozen'},{...options,lessons:[...options.lessons]})).rejects.toThrow('Frozen');expect(await trainParking(b,DEFAULT_PARKING,{...options,lessons:[...options.lessons]})).toBeNull();expect(b.controller).toEqual(before);
  });
});
