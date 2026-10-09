import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import type {ParkingScene,Actor} from './model';
import type {ParkingSession} from './session';

const COLORS=[0xffdf83,0x86d8ff,0xb9a4ff,0x8fe3b6,0xfb8fbd,0xffba83];
function dispose(group:THREE.Group){const materials=new Set<THREE.Material>();group.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.Line||o instanceof THREE.LineSegments){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);}});materials.forEach(m=>m.dispose());group.clear();}
export class ParkingView3D{
  readonly scene=new THREE.Scene();readonly camera=new THREE.PerspectiveCamera(45,5/3,.005,40);
  readonly renderer:THREE.WebGLRenderer;readonly controls:OrbitControls;
  private staticGroup=new THREE.Group();private actors=new THREE.Group();private agents=new THREE.Group();private trails=new THREE.Group();private effects=new THREE.Group();
  private lot:ParkingScene|null=null;private cars=false;private bodyMap=new Map<string,THREE.Group>();private effectTimes=new WeakMap<object,number>();
  private lastFrame='';
  private agentBodies:THREE.Group[]=[];private traceLines:THREE.Line[]=[];
  constructor(readonly canvas:HTMLCanvasElement,onPick:(x:number,z:number)=>void){
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.scene.background=new THREE.Color(0x14232d);
    this.scene.add(new THREE.HemisphereLight(0xdcefff,0x334854,2));const sun=new THREE.DirectionalLight(0xffebca,3);sun.position.set(-3,6,4);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-4,right:4,top:4,bottom:-4,near:.1,far:15});sun.shadow.bias=-.0002;this.scene.add(sun);
    this.scene.add(this.staticGroup,this.actors,this.agents,this.trails,this.effects);this.controls=new OrbitControls(this.camera,canvas);this.controls.maxPolarAngle=Math.PI/2-.05;this.controls.minDistance=.4;this.controls.maxDistance=12;this.controls.addEventListener('change',()=>this.paint());this.focus();
    new ResizeObserver(()=>this.paint()).observe(canvas);
    let press={x:0,y:0};canvas.addEventListener('pointerdown',e=>{press={x:e.clientX,y:e.clientY};});canvas.addEventListener('pointerup',e=>{if(Math.hypot(e.clientX-press.x,e.clientY-press.y)>4)return;const rect=canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),this.camera);const hit=new THREE.Vector3();if(ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit))onPick(hit.x,hit.z);});
  }
  focus(overview=false){this.controls.target.set(0,0,-.45);this.camera.position.set(...(overview?[3.5,5.5,4.8]:[1.65,2.15,1.75]) as [number,number,number]);this.controls.update();this.paint();}
  private paint(){if(this.canvas.hidden||!this.canvas.clientWidth)return;const w=this.canvas.clientWidth,h=w*3/5;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.render(this.scene,this.camera);}
  private box(parent:THREE.Group,x:number,y:number,z:number,l:number,h:number,w:number,color:number){const mesh=new THREE.Mesh(new THREE.BoxGeometry(l,h,w),new THREE.MeshStandardMaterial({color,roughness:.72}));mesh.position.set(x,y,z);mesh.castShadow=mesh.receiveShadow=true;parent.add(mesh);return mesh;}
  private vehicle(a:Pick<Actor,'length'|'width'|'height'>,cars:boolean,color:number){const g=new THREE.Group(),h=a.height;if(cars){this.box(g,0,h*.31,0,a.length,h*.62,a.width,color);this.box(g,0,h*.81,0,a.length*.5,h*.38,a.width*.82,0x293d4f);}else{this.box(g,0,h/2,0,a.length,h,a.width,color);const edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(a.length,h,a.width)),new THREE.LineBasicMaterial({color:0xc1d8e4,transparent:true,opacity:.45}));edge.position.y=h/2;g.add(edge);}return g;}
  private rebuild(lot:ParkingScene,cars:boolean){
    [this.staticGroup,this.actors].forEach(dispose);this.bodyMap.clear();this.lot=lot;this.cars=cars;
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(6,6),new THREE.MeshStandardMaterial({color:0x303b46,roughness:1}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;this.staticGroup.add(ground);const grid=new THREE.GridHelper(6,24,0x617c8a,0x425565);grid.position.y=.001;this.staticGroup.add(grid);
    for(const sign of [-1,1]){this.box(this.staticGroup,0,.1,sign*3,6,.2,.025,0x9da7a8);this.box(this.staticGroup,sign*3,.1,0,.025,.2,6,0x9da7a8);}
    for(const bay of lot.bays){const p=new THREE.Group();p.position.set(bay.x,.002,bay.z);p.rotation.y=-bay.heading;for(const s of [-1,1]){this.box(p,0,0,s*bay.width/2,bay.length,.002,.009,0xcad6dd);this.box(p,s*bay.length/2,0,0,.009,.002,bay.width,0xcad6dd);}this.staticGroup.add(p);}
    const b=lot.target,g=new THREE.Group();g.position.set(b.x,.004,b.z);g.rotation.y=-b.heading;
    for(const s of [-1,1]){this.box(g,0,0,s*b.width/2,b.length,.003,.014,0xffda6c);this.box(g,s*b.length/2,0,0,.014,.003,b.width,0xffda6c);}
    this.box(g,.14,.001,0,.15,.002,.2,0x20e9ed);this.box(g,-.14,.001,0,.15,.002,.2,0xff883b);const ring=new THREE.Mesh(new THREE.RingGeometry(.205,.23,48),new THREE.MeshBasicMaterial({color:0xffd15d,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;g.add(ring);this.box(g,0,.17,0,.004,.34,.004,0xe1e8ec);const flag=new THREE.Mesh(new THREE.PlaneGeometry(.07,.07),new THREE.MeshBasicMaterial({color:0xff73b0,side:THREE.DoubleSide}));flag.position.set(.035,.3,0);g.add(flag);this.staticGroup.add(g);
    for(const a of lot.actors){let body:THREE.Group;if(a.kind==='pedestrian'){body=new THREE.Group();const mesh=new THREE.Mesh(new THREE.CylinderGeometry(a.width/2,a.width/2,a.height,12),new THREE.MeshStandardMaterial({color:0xb88c4d}));mesh.position.y=a.height/2;mesh.castShadow=true;body.add(mesh);}else body=this.vehicle(a,cars,0x597899);body.name='actor-'+a.id;body.userData.height=a.height;body.userData.footprint={length:a.length,width:a.width};this.actors.add(body);this.bodyMap.set(a.id,body);}
  }
  draw(sessions:ParkingSession[],cars:boolean,showTrail:boolean){
    const e=sessions[0].episode,changed=this.lot!==e.scene||this.cars!==cars,frame=sessions.map(s=>s.episode.tick).join(',')+':'+showTrail;
    const animating=e.effects.some(effect=>performance.now()-(this.effectTimes.get(effect)??performance.now())<1200);
    if(!changed&&frame===this.lastFrame&&!animating)return;
    this.lastFrame=frame;if(changed)this.rebuild(e.scene,cars);
    for(const a of e.scene.actors){const body=this.bodyMap.get(a.id)!;body.position.set(a.pose.x,0,a.pose.z);body.rotation.y=-a.pose.heading;}
    if(this.agentBodies.length!==sessions.length){
      [this.agents,this.trails].forEach(dispose);this.agentBodies=[];this.traceLines=[];
      sessions.forEach((_,i)=>{const color=COLORS[i%COLORS.length],g=this.vehicle({length:.26,width:.17,height:.065},true,color);this.box(g,.11,.07,0,.025,.03,.08,0x111c27);this.agents.add(g);this.agentBodies.push(g);const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(1800*3),3).setUsage(THREE.DynamicDrawUsage));const line=new THREE.Line(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.65}));line.frustumCulled=false;this.trails.add(line);this.traceLines.push(line);});
    }
    dispose(this.effects);
    sessions.forEach((s,i)=>{const p=s.episode.physics.pose,g=this.agentBodies[i];g.position.set(p.x,0,p.z);g.rotation.y=-p.heading;
      const line=this.traceLines[i],trail=s.episode.trail;line.visible=showTrail&&trail.length>1;if(line.visible){const positions=line.geometry.getAttribute('position') as THREE.BufferAttribute;trail.forEach((p,j)=>positions.setXYZ(j,p.x,.007,p.z));positions.needsUpdate=true;line.geometry.setDrawRange(0,trail.length);}
    });
    for(const effect of e.effects){const now=performance.now();if(!this.effectTimes.has(effect))this.effectTimes.set(effect,now);const age=(now-this.effectTimes.get(effect)!)/1200;if(age>=1)continue;for(let i=0;i<8;i++){const material=new THREE.MeshBasicMaterial({color:effect.kind==='blood'?0xcb334c:effect.kind==='explosion'?0xffa547:0x9aa5ad,transparent:true,opacity:1-age});const particle=new THREE.Mesh(new THREE.SphereGeometry(.02+age*.025,5,4),material),angle=i/8*Math.PI*2;particle.position.set(effect.x+Math.cos(angle)*age*.2,.03+age*.1,effect.z+Math.sin(angle)*age*.2);this.effects.add(particle);}}
    this.paint();
  }
}
