import {it,expect} from 'vitest';
import {drawSolids} from './solid-camera';
import {DEFAULT_STYLE,type Sprite,type Scene} from './camera';
import {mulberry32} from './rng';

it('screen culling exactly matches exhaustive rays at wide FOVs, inside boxes and across the near plane',()=>{
  const random=mulberry32(314),sprites:Sprite[]=Array.from({length:9},(_,i)=>({x:(random()-.5)*160,y:(random()-.5)*160,heading:random()*Math.PI*2,width:8+random()*30,length:8+random()*50,z0:0,z1:8+random()*40,color:[.2,.5,.7],shape:i%2?'solid-car':'oriented-box'}));
  // Include a body around the lens and a thin wall straddling its plane.
  sprites.push({x:0,y:0,heading:0,width:20,length:20,z0:0,z1:30,color:[.4,.3,.2],shape:'oriented-box'});
  const scene:Scene={style:{...DEFAULT_STYLE},sprites,prepare(){},ground(){}};
  for(const hfov of [Math.PI/3,Math.PI*2/3])for(const pitch of [-.2,.16,.6])for(let i=0;i<8;i++){
    const camera={width:32,height:16,hfov,pitch,mountHeight:15,mountForward:0},pose={x:i===0?0:(random()-.5)*100,y:i===0?0:(random()-.5)*100,heading:random()*Math.PI*2};
    const projection={f:camera.width/2/Math.tan(hfov/2),cx:camera.width/2,cy:camera.height/2,sinP:Math.sin(pitch),cosP:Math.cos(pitch)},a=new Float32Array(camera.width*camera.height*3).fill(.3),b=a.slice();
    const depths=drawSolids(scene,pose,camera,projection,a),exhaustive=drawSolids(scene,pose,camera,projection,b,false);expect(a).toEqual(b);expect(depths).toEqual(exhaustive);
  }
});
