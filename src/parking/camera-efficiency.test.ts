import {it,expect} from 'vitest';
import {ParkingCameraScene,PX,ParkingCue} from './episode';
import {DEFAULT_PARKING,generateParking} from './model';
import {parkingFloorColour} from './floor';
import {mulberry32} from '../vision/rng';
import {ROBOT_WORLD_CAMERA} from '../vision/robot';
import type {Rgb} from '../vision/camera';
it('conservative bay-paint bounds and reusable ground colour preserve exact pixels',()=>{
  const random=mulberry32(812);
  for(const layout of ['standard','angled','double-row','tight'] as const)for(const paint of [false,true]){
    const scene=generateParking({...DEFAULT_PARKING,layout,lesson:'oriented'}),camera=new ParkingCameraScene(scene,false,'transfer',paint);camera.prepare();
    const reference=(x:number,z:number)=>{
      let colour=parkingFloorColour('transfer',x*PX,z*PX);
      for(const b of scene.bays){const dx=x-b.x,dz=z-b.z,c=Math.cos(b.heading),s=Math.sin(b.heading),along=dx*c+dz*s,across=-dx*s+dz*c;
        if(Math.abs(along)<b.length/2+.012&&Math.abs(across)<b.width/2+.012&&(Math.abs(Math.abs(along)-b.length/2)<.012||Math.abs(Math.abs(across)-b.width/2)<.012))colour=[.8,.83,.82];}
      const b=scene.target,dx=x-b.x,dz=z-b.z,c=Math.cos(b.heading),s=Math.sin(b.heading),along=dx*c+dz*s,across=-dx*s+dz*c,distance=Math.hypot(dx,dz);
      if(distance<.23&&distance>.205)colour=[1,.84,.2];
      if(Math.abs(along)<b.length/2+.016&&Math.abs(across)<b.width/2+.016&&(Math.abs(Math.abs(along)-b.length/2)<.016||Math.abs(Math.abs(across)-b.width/2)<.016))colour=[1,.84,.2];
      if(paint&&Math.abs(across)<.1&&Math.abs(along-.14)<.075)colour=[.05,.95,1];if(paint&&Math.abs(across)<.1&&Math.abs(along+.14)<.075)colour=[1,.38,.04];return colour;
    };
    for(let i=0;i<700;i++){const x=(random()-.5)*9,z=(random()-.5)*9,out:Rgb=[-1,-1,-1];camera.ground(x*PX,z*PX,out);expect(out).toEqual(reference(x,z));}
  }
  const out:Rgb=[0,0,0];expect(parkingFloorColour('asphalt',0,0,out)).toBe(out);expect(out).toEqual([.19,.23,.27]);
});
it('basic lessons skip direction analysis while retaining identical pixel-only flag observations',()=>{
  const pixels=new Float32Array(ROBOT_WORLD_CAMERA.width*ROBOT_WORLD_CAMERA.height*3),regular=new ParkingCue(ROBOT_WORLD_CAMERA),basic=new ParkingCue(ROBOT_WORLD_CAMERA,false);
  for(let tick=0;tick<6;tick+=2){regular.observe(pixels,tick);basic.observe(pixels,tick);expect(basic.cue().slice(0,2)).toEqual(regular.cue().slice(0,2));expect(basic.alignment).toBe(0);expect(basic.confidence).toBe(0);}
});
