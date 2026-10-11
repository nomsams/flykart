import {describe,it,expect} from 'vitest';
import {DEFAULT_PARKING,PARKING_LAYOUTS,LESSONS,EASY_PARKING_LESSONS,generateParking,validateParkingScene,validateParkingSettings,actorSolid,bodySolid,inParkingArea,parkingQuality} from './model';
import {DEFAULT_ROBOT,overlaps} from '../robot/model';
import {ParkingEpisode} from './episode';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import {ParkingPresentation} from './presentation';
import {planParkingPath} from './path-coach';
const idle={steer:0,throttle:0,reverse:0,brake:0};
describe('parking challenges',()=>{
  it('defaults to easy rehearsals, leaving advanced and traffic lessons opt-in',()=>{expect(EASY_PARKING_LESSONS).toEqual(['arrival','exit','switch']);});
  it('parallel coach drives past then backs with countersteering, finishing inside the bay without pivots',()=>{
    for(const layout of ['standard','tight'] as const)for(let seed=1;seed<=8;seed++){
      const scene=generateParking({...DEFAULT_PARKING,lesson:'parallel',layout,seed,parkedOffset:true}),path=planParkingPath(scene);
      expect(path.reason).toBe('ready');expect(path.expanded).toBe(0);expect(path.poses.some(p=>p.reverse)).toBe(true);
      const end=parkingQuality(path.poses.at(-1)!,scene.target);expect(end.inside).toBe(true);expect(end.distance).toBeLessThan(.001);expect(end.error).toBeLessThan(.001);
      for(let i=1;i<path.poses.length;i++){const a=path.poses[i-1],b=path.poses[i],travel=Math.hypot(a.x-b.x,a.z-b.z);expect(travel).toBeGreaterThan(1e-6);expect(Math.abs(b.heading-a.heading)/travel).toBeLessThanOrEqual(1/.18+.001);for(const actor of scene.actors)expect(overlaps(bodySolid(b,DEFAULT_ROBOT.length+.008,DEFAULT_ROBOT.width+.008),actorSolid(actor))).toBe(false);}
    }
  },90000);
  it('migrates old settings, validates new fields and safely seeds every harder lesson',()=>{
    const old={...DEFAULT_PARKING} as Record<string,unknown>;for(const k of ['strictCrash','parkedOffset','layout'])delete old[k];expect(validateParkingSettings(old)).toEqual(DEFAULT_PARKING);
    expect(()=>validateParkingSettings({...old,layout:'unknown'})).toThrow();
    for(const layout of PARKING_LAYOUTS)for(const lesson of LESSONS)for(let seed=1;seed<=30;seed++){
      const settings={...DEFAULT_PARKING,layout,lesson:lesson.id,seed,parkedOffset:true,shapeJitter:true,traffic:8,pedestrians:8},scene=generateParking(settings);
      expect(validateParkingScene(scene)).toEqual(scene);expect(generateParking(settings)).toEqual(scene);
      const parked=scene.actors.filter(a=>a.parked);for(let i=0;i<parked.length;i++){
        expect(overlaps(actorSolid(parked[i]),bodySolid({...scene.target},.26,.17))).toBe(false);
        for(let j=i+1;j<parked.length;j++)expect(overlaps(actorSolid(parked[i]),actorSolid(parked[j]))).toBe(false);
      }
    }
  });
  it('offsets solid cars while retaining painted bays, start, and goal',()=>{
    const plain=generateParking(DEFAULT_PARKING),offset=generateParking({...DEFAULT_PARKING,parkedOffset:true});expect(offset.bays).toEqual(plain.bays);expect(offset.start).toEqual(plain.start);expect(offset.target).toEqual(plain.target);
    expect(offset.actors[0].pose).not.toEqual(plain.actors[0].pose);expect(Math.abs(offset.actors[0].pose.heading-plain.actors[0].pose.heading)).toBeLessThanOrEqual(Math.PI/18);
  });
  it('ends outside-target contact immediately but permits penalized contact inside its rectangle',()=>{
    for(const inside of [false,true]){const e=new ParkingEpisode({...DEFAULT_PARKING,strictCrash:true},ROBOT_WORLD_CAMERA);e.physics.pose=inside?{...e.scene.target}:{x:2.8,z:0,heading:0};e.physics.step=()=>{e.physics.blocked=true;};expect(inParkingArea(e.physics.pose,e.scene.target)).toBe(inside);e.step(idle);expect(e.status.disqualified).toBe(!inside);expect(e.done).toBe(!inside);expect(e.status.contacts).toBe(1);expect(e.status.success).toBe(false);const ticks=e.tick;e.step(idle);expect(e.tick).toBe(inside?ticks+1:ticks);}
  });
  it('manual headless overrides all scheduled previews until explicitly resumed',()=>{
    const p=new ParkingPresentation();p.every=1;p.hideAll();for(let g=0;g<=8;g++)expect(p.visible(g)).toBe(false);const saved=p.toJSON(),q=new ParkingPresentation();q.restore(saved);expect(q.visible(2)).toBe(false);q.clearSuppression();expect(q.visible(2)).toBe(true);
  });
  it('uses curved continuous headings and whole-body clearance in a turning manoeuvre',()=>{
    const scene=generateParking({...DEFAULT_PARKING,lesson:'oriented',seed:4}),path=planParkingPath(scene);expect(path.reason).toBe('ready');
    expect(path.poses.some((p,i)=>i>0&&Math.hypot(p.x-path.poses[i-1].x,p.z-path.poses[i-1].z)>.001&&Math.abs(p.heading-path.poses[i-1].heading)>.001)).toBe(true);
    for(const p of path.poses)for(const a of scene.actors.filter(a=>a.parked))expect(overlaps(bodySolid(p,DEFAULT_ROBOT.length+.008,DEFAULT_ROBOT.width+.008),actorSolid(a))).toBe(false);
    expect(path.poses[0].heading).toBe(scene.start.heading);
  },30000);
});
