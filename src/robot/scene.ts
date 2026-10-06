import { DrivingTrail } from './driving-trail';
import {prepareVisual,visualMesh} from './imported-assets';
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RobotConfig, Pose, WorldObject, solidsFor, robotContactParts, traversable } from "./model";
import { NoiseSource } from "./noise";
import { naturalGeometry, naturalShapes } from "./natural-shapes";
import type { MissionSnapshot } from "./objectives";

const COLORS = { image:0xffffff,model:0x879ba3,pod:0x164de2,ball: 0x1459ee, wall: 0xcac5b8, table: 0xb58b60, chair: 0x859989, rock: 0x969c96, stone: 0xb3ada1, bush: 0x527e5b, tree: 0x557a56, water: 0x679faa, bed: 0x97775d, block: 0xcb805e, cable: 0x303b43, shoe: 0x63839e, doormat: 0xc49a62 };
export class HabitatScene {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(42, 1, .01, 80);
  readonly eye = new THREE.PerspectiveCamera(50, 4 / 3, .008, 20);
  readonly controls: OrbitControls;
  readonly drivingTrail=new DrivingTrail();
  private trailGeometry=new THREE.BufferGeometry();
  private trailMaterial=new THREE.LineBasicMaterial({color:0xd58c37,transparent:true,opacity:.65,depthWrite:false});
  private trailView=new THREE.LineSegments(this.trailGeometry,this.trailMaterial);
  private objects = new THREE.Group();
  private robot = new THREE.Group();
  private mission = new THREE.Group();
  private scentOverlay = new THREE.Group();
  private calibrationView = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private beam = new THREE.Group();
  private contactView = new THREE.Group();
  private envelope = new THREE.Group();
  private floorMaterial = new THREE.MeshStandardMaterial({ color: 0xb7bea7, roughness: 1 });
  private worldObjects: WorldObject[] = [];
  private robotConfig: RobotConfig | null = null;
  private selection = new THREE.Box3Helper(new THREE.Box3(), 0xe2a65b);
  private selectedId: string|null=null;
  private target = new THREE.WebGLRenderTarget(160, 120, { depthBuffer: true });
  private bytes = new Uint8Array(160 * 120 * 4);
  private eyeContext: CanvasRenderingContext2D;
  private flyContext: CanvasRenderingContext2D;
  private tinyCanvas = document.createElement("canvas");
  private tinyContext: CanvasRenderingContext2D;
  private resizeObserver: ResizeObserver;
  constructor(private canvas: HTMLCanvasElement, eyeCanvas: HTMLCanvasElement, flyCanvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.eyeContext = eyeCanvas.getContext("2d")!; this.flyContext = flyCanvas.getContext("2d")!;
    this.tinyContext = this.tinyCanvas.getContext("2d", { willReadFrequently: true })!;
    this.scene.background = new THREE.Color(0xd6ddd5); this.scene.fog = new THREE.Fog(0xd6ddd5, 12, 25);
    this.scene.add(new THREE.HemisphereLight(0xfdf7e7, 0x6a7e65, 2.4));
    const sun = new THREE.DirectionalLight(0xfff3d8, 3); sun.position.set(-3, 6, 4); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = sun.shadow.camera.bottom = -5; sun.shadow.camera.right = sun.shadow.camera.top = 5; sun.shadow.normalBias = .015;
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), this.floorMaterial); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);
    const grid = new THREE.GridHelper(7, 35, 0x83927c, 0x9caa92); grid.position.y = .001; const gm = grid.material as THREE.Material; gm.transparent = true; gm.opacity = .23; this.scene.add(grid);
    this.trailGeometry.setAttribute("position",new THREE.BufferAttribute(this.drivingTrail.positions,3).setUsage(THREE.DynamicDrawUsage));this.trailGeometry.setDrawRange(0,0);this.trailView.frustumCulled=false;this.scene.add(this.trailView);
    this.scene.add(this.objects, this.robot, this.mission, this.scentOverlay, this.calibrationView, this.beam, this.selection, this.contactView, this.envelope); this.robot.userData.id="@robot";this.selection.visible = this.contactView.visible = this.envelope.visible = false;
    this.camera.position.set(3.5, 4.8, 5.2);
    this.controls = new OrbitControls(this.camera, canvas); this.controls.target.set(0, .05, 0); this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI / 2 - .025; this.controls.minDistance = .25; this.controls.maxDistance = 14;
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(canvas.parentElement!); this.resize();
  }
  private resize(): void { const rect = this.canvas.parentElement!.getBoundingClientRect(); this.renderer.setSize(rect.width, rect.height, false); this.camera.aspect = rect.width / Math.max(1, rect.height); this.camera.updateProjectionMatrix(); }
  private mesh(geometry: THREE.BufferGeometry, color: number, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .8 })); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  private clear(group: THREE.Group): void { group.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) { o.geometry.dispose(); const materials = Array.isArray(o.material) ? o.material : [o.material]; materials.forEach(m => {for(const value of Object.values(m))if(value instanceof THREE.Texture&&value.userData.robotImported)value.dispose();m.dispose();}); } }); group.clear(); }
  rebuildObjects(objects: WorldObject[]): void {
    this.worldObjects = objects;
    this.clear(this.objects);
    for (const o of objects) {
      if(o.visual){const group=new THREE.Group();group.userData.id=o.id;group.position.set(o.x,0,o.z);group.rotation.y=-o.yaw;this.objects.add(group);const attach=()=>{if(!this.objects.children.includes(group))return;const mesh=visualMesh(o.visual!);if(mesh){mesh.scale.set(o.width,o.height,o.depth);group.add(mesh);return true;}return false;};if(!attach())void prepareVisual(o.visual).then(attach).catch(()=>{});continue;}

      const group = new THREE.Group(); group.userData.id = o.id; this.objects.add(group);
      const shapes = naturalShapes(o);
      if (!shapes.length) {
        for (const [i, s] of solidsFor(o).entries()) { const colour = o.kind === "bed" && i === 5 ? 0xded7c6 : COLORS[o.kind]; const m = this.mesh(new THREE.BoxGeometry(s.width, s.top - s.bottom, s.depth), colour, group, s.x, (s.top + s.bottom) / 2, s.z); m.rotation.y = -s.yaw; }
        if (o.kind === "bed") { const pillow = this.mesh(new THREE.BoxGeometry(o.width * .18, o.height * .08, o.depth * .7), 0xe9e3d3, group, o.x - Math.cos(o.yaw) * o.width * .32, o.height * .76, o.z - Math.sin(o.yaw) * o.width * .32); pillow.rotation.y = -o.yaw; }
        if (o.kind === "doormat") for (let i = -3; i <= 3; i++) { const stripe = this.mesh(new THREE.BoxGeometry(o.width * .9, .001, o.depth * .018), 0x9f7546, group, o.x - Math.sin(o.yaw) * i * o.depth / 9, o.height + .001, o.z + Math.cos(o.yaw) * i * o.depth / 9); stripe.rotation.y = -o.yaw; }
      } else {
        group.position.set(o.x, 0, o.z); group.rotation.y = -o.yaw;
        for (const shape of shapes) {
          const mesh = this.mesh(naturalGeometry(shape), shape.colour === "trunk" ? 0x826d50 : COLORS[o.kind], group, 0, shape.centreY, 0); mesh.scale.set(...shape.scale);
          if (o.kind === "water") { (mesh.material as THREE.MeshStandardMaterial).roughness = .18; (mesh.material as THREE.MeshStandardMaterial).metalness = .15; }
        }
      }
    }
    this.rebuildContacts();
  }
  setFloorColour(colour: string): void { this.floorMaterial.color.set(colour); }
  moveBall(ball:WorldObject):void {const group=this.objects.children.find(o=>o.userData.id===ball.id);if(group){group.position.set(ball.x,0,ball.z);if(this.contactView.visible)this.rebuildContacts();}}
  rebuildMission(mission: MissionSnapshot, collected: Set<string> = new Set()): void {
    this.clear(this.mission);this.clear(this.scentOverlay);
    for(const goal of mission.goals){if(collected.has(goal.id))continue;const group=new THREE.Group();group.userData.id=goal.id;this.mission.add(group);const cube=this.mesh(new THREE.BoxGeometry(.08,.08,.08),0xf768ce,group,goal.x,.04,goal.z);cube.rotation.y=-goal.yaw;
      const ring=new THREE.Mesh(new THREE.RingGeometry(goal.radius*.96,goal.radius,32),new THREE.MeshBasicMaterial({color:0xf8addf,side:THREE.DoubleSide,transparent:true,opacity:.55}));ring.rotation.x=-Math.PI/2;ring.position.set(goal.x,.003,goal.z);group.add(ring);}
    const trail=mission.trail;
    for(let i=1;i<trail.length;i++){const a=trail[i-1],b=trail[i],length=Math.hypot(b.x-a.x,b.z-a.z);if(length<.001)continue;const group=mission.settings.cue==="paint"?this.mission:this.scentOverlay;const mesh=this.mesh(new THREE.BoxGeometry(length,.002,mission.settings.width*.45),0x28c9db,group,(a.x+b.x)/2,.004,(a.z+b.z)/2);mesh.rotation.y=-Math.atan2(b.z-a.z,b.x-a.x);if(mission.settings.cue==="scent"){const material=mesh.material as THREE.MeshStandardMaterial;material.transparent=true;material.opacity=.3;}}
  }
  showFeedingTrail(trail:{x:number;z:number}[]):void {
    // Keep all scent overlays outside both the raw and fly cameras.
    for(const child of [...this.scentOverlay.children])if(child.userData.feeding){this.scentOverlay.remove(child);const m=child as THREE.Mesh;m.geometry.dispose();(m.material as THREE.Material).dispose();}
    for(let i=1;i<trail.length;i++){const a=trail[i-1],b=trail[i],length=Math.hypot(b.x-a.x,b.z-a.z);if(length<.001)continue;const mesh=this.mesh(new THREE.BoxGeometry(length,.003,.045),0xffb96b,this.scentOverlay,(a.x+b.x)/2,.006,(a.z+b.z)/2);mesh.userData.feeding=true;mesh.rotation.y=-Math.atan2(b.z-a.z,b.x-a.x);const material=mesh.material as THREE.MeshStandardMaterial;material.transparent=true;material.opacity=.45;}
  }
  showFlyInput(planar:Float32Array,width:number,height:number):void {
    this.tinyCanvas.width=width;this.tinyCanvas.height=height;const image=this.tinyContext.createImageData(width,height),n=width*height;
    for(let i=0;i<n;i++){for(let k=0;k<3;k++)image.data[i*4+k]=planar[k*n+i]*255;image.data[i*4+3]=255;}
    this.tinyContext.putImageData(image,0,0);this.flyContext.imageSmoothingEnabled=false;this.flyContext.drawImage(this.tinyCanvas,0,0,this.flyContext.canvas.width,this.flyContext.canvas.height);
  }
  showContacts(show: boolean): void { this.contactView.visible = this.envelope.visible = show; }
  calibrationMarks(origin:Pose|null,targets:Pose[]):void {this.clear(this.calibrationView);if(!origin)return;for(const [i,p]of [origin,...targets].entries()){const points=[new THREE.Vector3(p.x-.035,.008,p.z),new THREE.Vector3(p.x+.035,.008,p.z),new THREE.Vector3(p.x,.008,p.z),new THREE.Vector3(p.x,.008,p.z-.035),new THREE.Vector3(p.x,.008,p.z+.035)];this.calibrationView.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:i?0xe5b669:0x61d9bd})));}const points=[origin,...targets].map(p=>new THREE.Vector3(p.x,.008,p.z));this.calibrationView.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:0x94a6ab})));}
  private rebuildContacts(): void {
    this.clear(this.contactView); this.clear(this.envelope); const c = this.robotConfig; if (!c) return;
    for (const o of this.worldObjects) {
      const footprints = robotContactParts(o, c).map(p => p.polygon);
      if (traversable(o, c)) { const t = Math.cos(o.yaw), s = Math.sin(o.yaw); footprints.push([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z]) => ({ x: o.x + x*o.width/2*t-z*o.depth/2*s, z: o.z+x*o.width/2*s+z*o.depth/2*t }))); }
      for (const points of footprints) this.contactView.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p.x,.012,p.z))), new THREE.LineBasicMaterial({ color: traversable(o,c) ? 0x70b8df : 0xf0ad4e, depthTest: false })));
    }
    const geometry = new THREE.BoxGeometry(c.length, c.mountHeight + .04, c.width), edges = new THREE.EdgesGeometry(geometry); geometry.dispose();
    const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x61d5a0, depthTest: false })); outline.position.y = (c.mountHeight + .04) / 2; this.envelope.add(outline);
  }
  rebuildRobot(c: RobotConfig): void {
    this.robotConfig = c; this.rebuildContacts();
    this.clear(this.robot); this.clear(this.beam); this.wheels = [];
    const box = (size: number[], color: number, position: number[]) => this.mesh(new THREE.BoxGeometry(...size as [number, number, number]), color, this.robot, ...position as [number, number, number]);
    box([c.length, .006, c.width - c.wheelWidth * 2], 0xf0e7cc, [0, c.mountHeight - .003, 0]);
    box([.072, .025, .052], 0x253d40, [-.04, c.mountHeight + .016, 0]);
    box([.04, .018, .035], 0x272e32, [.065, c.mountHeight + .014, 0]);
    box([.022, .012, .022], 0x52797e, [.09, c.mountHeight + .019, 0]);
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      box([.07, .018, .022], 0xe9b634, [x * c.wheelbase / 2, .038, z * (c.width / 2 - c.wheelWidth - .012)]);
      const wheel = this.mesh(new THREE.CylinderGeometry(c.wheelDiameter / 2, c.wheelDiameter / 2, c.wheelWidth, 20), 0x303435, this.robot, x * c.wheelbase / 2, c.wheelDiameter / 2, z * (c.width / 2 - c.wheelWidth / 2)); wheel.rotation.x = Math.PI / 2; this.wheels.push(wheel);
      const hub = this.mesh(new THREE.CylinderGeometry(c.wheelDiameter * .25, c.wheelDiameter * .25, c.wheelWidth + .001, 16), 0xeab63d, wheel, 0, 0, 0); hub.castShadow = false;
    }
    box([.006, .02, .045], 0x568988, [c.length * .48, c.mountHeight + .01, 0]);
    for (const z of [-.012, .012]) { const sensor = this.mesh(new THREE.CylinderGeometry(.008, .008, .009, 16), 0xc2ced0, this.robot, c.length * .48 + .008, c.mountHeight, z); sensor.rotation.z = Math.PI / 2; }
    const lens = this.mesh(new THREE.CylinderGeometry(.007, .007, .009, 12), 0x101d24, this.robot, .104, c.mountHeight + .019, 0); lens.rotation.z = Math.PI / 2;
    if(c.vibration?.enabled){this.mesh(new THREE.BoxGeometry(.032,.004,.015),0x315fa2,this.robot,-.01,c.mountHeight+.004,.045);this.mesh(new THREE.CylinderGeometry(.003,.003,.012,12),0x2799cc,this.robot,-.014,c.mountHeight+.012,.045);}
    const fly = new THREE.Group(); fly.position.set(-.04, c.mountHeight + .05, 0); this.robot.add(fly);
    const body = this.mesh(new THREE.SphereGeometry(.008, 10, 6), 0x3a3232, fly, 0, 0, 0); body.scale.x = 1.7;
    for (const z of [-1, 1]) { const wing = this.mesh(new THREE.SphereGeometry(.012, 10, 5), 0xbfd5d3, fly, 0, .004, z * .009); wing.scale.set(1, .07, .55); }
    // This is a display-only fly mascot; it is not fed into its own camera.
    fly.userData.mascot = true;
    const range = 4, radius = Math.tan(c.sonarBeam * Math.PI / 360) * range;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, range, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0xe8b868, transparent: true, opacity: .07, depthWrite: false, side: THREE.DoubleSide })); cone.rotation.z = Math.PI / 2; cone.position.x = range / 2; this.beam.add(cone);
    for (const angle of [-c.sonarBeam / 2, 0, c.sonarBeam / 2]) {
      const a = angle * Math.PI / 180; const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(range * Math.cos(a), 0, range * Math.sin(a))]), new THREE.LineBasicMaterial({ color: 0xe5b669, transparent: true, opacity: .5 })); this.beam.add(line);
    }
  }
  updateRobot(pose: Pose, c: RobotConfig, showBeam: boolean, left: number, right: number, dt: number): void {
    this.robot.position.set(pose.x, 0, pose.z); this.robot.rotation.y = -pose.heading;
    if(this.selectedId==="@robot")this.selection.box.setFromObject(this.robot);
    this.envelope.position.copy(this.robot.position); this.envelope.rotation.copy(this.robot.rotation);
    this.wheels.forEach((w, i) => { w.rotation.y += (i % 2 === 0 ? left : right) * dt / (c.wheelDiameter / 2); });
    this.beam.position.set(pose.x + Math.cos(pose.heading) * c.length * .48, c.mountHeight, pose.z + Math.sin(pose.heading) * c.length * .48); this.beam.rotation.y = -pose.heading; this.beam.visible = showBeam && c.sonarEnabled;
    const aspect = 4 / 3, verticalFov = 2 * Math.atan(Math.tan(c.cameraFov * Math.PI / 360) / aspect) * 180 / Math.PI;
    this.eye.fov = verticalFov; this.eye.updateProjectionMatrix();
    this.eye.position.set(pose.x + Math.cos(pose.heading) * c.length * .48, c.mountHeight, pose.z + Math.sin(pose.heading) * c.length * .48);
    const pitch = c.cameraPitch * Math.PI / 180;
    this.eye.lookAt(this.eye.position.x + Math.cos(pose.heading) * Math.cos(pitch), this.eye.position.y - Math.sin(pitch), this.eye.position.z + Math.sin(pose.heading) * Math.cos(pitch));
  }
  capture(width: number, height: number, enabled: boolean, noise?: NoiseSource,deliver?:(pixels:Uint8ClampedArray,dropped:boolean)=>{pixels:Uint8ClampedArray;dropped:boolean}): { planar: Float32Array; features: Float32Array; rgb: number[]; dropped: boolean } {
    const image = this.eyeContext.createImageData(160, 120);
    if (enabled) {
      const beamVisible = this.beam.visible, selectedVisible = this.selection.visible, robotVisible = this.robot.visible, contactsVisible = this.contactView.visible, envelopeVisible = this.envelope.visible, scentVisible=this.scentOverlay.visible,calibrationVisible=this.calibrationView.visible,trailVisible=this.trailView.visible;
      this.beam.visible = this.selection.visible = this.robot.visible = this.contactView.visible = this.envelope.visible = this.scentOverlay.visible = this.calibrationView.visible = this.trailView.visible = false;
      try {this.renderer.setRenderTarget(this.target); this.renderer.render(this.scene, this.eye); this.renderer.readRenderTargetPixels(this.target, 0, 0, 160, 120, this.bytes);}
      finally {this.renderer.setRenderTarget(null);this.beam.visible = beamVisible; this.selection.visible = selectedVisible; this.robot.visible = robotVisible;this.contactView.visible = contactsVisible; this.envelope.visible = envelopeVisible;this.scentOverlay.visible=scentVisible;this.calibrationView.visible=calibrationVisible;this.trailView.visible=trailVisible;}
      for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
        const i = (y * 160 + x) * 4, source = ((119 - y) * 160 + x) * 4;
        image.data[i] = Math.round(this.bytes[source] / 255 * 31) / 31 * 255;
        image.data[i + 1] = Math.round(this.bytes[source + 1] / 255 * 63) / 63 * 255;
        image.data[i + 2] = Math.round(this.bytes[source + 2] / 255 * 31) / 31 * 255;
        image.data[i + 3] = 255;
      }
    } else for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
    let dropped = enabled ? noise?.camera(image.data) ?? false : true;
    if(deliver){const delayed=deliver(image.data,dropped);image.data.set(delayed.pixels);dropped=delayed.dropped;}
    const rgb = [0, 0, 0];
    for (let i = 0; i < image.data.length; i += 4) for (let k = 0; k < 3; k++) rgb[k] += image.data[i + k] / (160 * 120);
    this.eyeContext.putImageData(image, 0, 0);
    this.tinyCanvas.width = width; this.tinyCanvas.height = height;
    const targetAspect = width / height, sourceAspect = 4 / 3;
    const sw = targetAspect < sourceAspect ? 120 * targetAspect : 160, sh = targetAspect < sourceAspect ? 120 : 160 / targetAspect;
    this.tinyContext.drawImage(this.eyeContext.canvas, (160 - sw) / 2, (120 - sh) / 2, sw, sh, 0, 0, width, height);
    const pixels = this.tinyContext.getImageData(0, 0, width, height).data, n = width * height;
    const planar = new Float32Array(n * 3), features = new Float32Array(24), counts = new Float32Array(8);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, cell = Math.min(1, Math.floor(y / height * 2)) * 4 + Math.min(3, Math.floor(x / width * 4));
      for (let k = 0; k < 3; k++) { const v = pixels[i * 4 + k] / 255; planar[k * n + i] = v; features[cell * 3 + k] += v; }
      counts[cell]++;
    }
    for (let cell = 0; cell < 8; cell++) for (let k = 0; k < 3; k++) features[cell * 3 + k] /= Math.max(1, counts[cell]);
    this.flyContext.imageSmoothingEnabled = false; this.flyContext.drawImage(this.tinyCanvas, 0, 0, this.flyContext.canvas.width, this.flyContext.canvas.height);
    return { planar, features, rgb, dropped };
  }
  select(id: string | null): void {
    this.selectedId=id;
    const selected = id==="@robot"?this.robot:[...this.objects.children,...this.mission.children].find(o => o.userData.id === id);
    this.selection.visible = !!selected;
    if (selected) this.selection.box.setFromObject(selected);
  }
  pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect(); const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = ray.intersectObjects([...this.objects.children,this.robot,...this.mission.children.filter(o=>o.userData.id)], true)[0]; let object: THREE.Object3D | null = hit?.object ?? null;
    while (object && !object.userData.id) object = object.parent;
    return object?.userData.id ?? null;
  }
  floorPoint(clientX:number,clientY:number):{x:number;z:number}|null {
    const rect=this.canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1),this.camera);
    const p=ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),new THREE.Vector3());return p&&Math.abs(p.x)<=3.5&&Math.abs(p.z)<=3.5?{x:p.x,z:p.z}:null;
  }
  showDrivingTrail(show:boolean):void{this.trailView.visible=show;}
  clearDrivingTrail():void{this.drivingTrail.clear();this.trailGeometry.setDrawRange(0,0);}
  breakDrivingTrail():void{this.drivingTrail.break();}
  recordDrivingTrail(pose:Pose):void{if(this.drivingTrail.record(pose)){this.trailGeometry.attributes.position.needsUpdate=true;this.trailGeometry.setDrawRange(0,this.drivingTrail.count*2);}}
  focus(pose: Pose): void { this.controls.target.set(pose.x, .06, pose.z); this.camera.position.set(pose.x - .6, .8, pose.z + .9); }
  overview(): void { this.controls.target.set(0, .05, 0); this.camera.position.set(3.5, 4.8, 5.2); }
  render(): void { this.controls.update(); this.renderer.render(this.scene, this.camera); }
  dispose(): void { this.resizeObserver.disconnect(); this.controls.dispose(); this.clear(this.objects); this.clear(this.robot); this.clear(this.mission);this.clear(this.scentOverlay);this.clear(this.beam); this.trailGeometry.dispose();this.trailMaterial.dispose();this.target.dispose(); this.renderer.dispose(); }
}
