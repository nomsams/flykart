// A small Three.js viewer for one evolved-habitat scene, with the robot and its path.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { WorldDef } from "../vision/world/world";
import { PX, buildWorldGroup, robotMesh } from "./part-mesh";

export class Habitat3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60);
  private readonly controls: OrbitControls;
  private world = new THREE.Group();
  private readonly robot = robotMesh();
  private trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffa94d }));
  private flags = new THREE.Group();
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.shadowMap.enabled = true; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0xc9d6df); this.scene.fog = new THREE.Fog(0xc9d6df, 9, 26);
    this.scene.add(new THREE.HemisphereLight(0xfdf7e7, 0x6a7e65, 2.1));
    const sun = new THREE.DirectionalLight(0xfff3d8, 2.6); sun.position.set(-3, 6, 4); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 20 });
    this.scene.add(sun);
    this.scene.add(this.world, this.robot, this.trail, this.flags);
    this.camera.position.set(0, 5.2, 5.6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.2, 0); this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect(), w = Math.max(200, Math.round(rect.width || 600)), h = Math.max(160, Math.round(rect.height || 380));
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  setWorld(world: WorldDef, goals: { x: number; y: number }[] = []): void {
    this.scene.remove(this.world);
    this.world.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); } });
    this.world = buildWorldGroup(world); this.scene.add(this.world);
    this.flags.clear();
    for (const g of goals) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.5, 8), new THREE.MeshStandardMaterial({ color: 0xeeeeee }));
      pole.position.set(g.x * PX, 0.25, g.y * PX);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.19), new THREE.MeshBasicMaterial({ color: 0xff3399, side: THREE.DoubleSide }));
      flag.position.set(g.x * PX + 0.06, 0.4, g.y * PX);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.27, 40), new THREE.MeshBasicMaterial({ color: 0xffd633, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(g.x * PX, 0.004, g.y * PX);
      this.flags.add(pole, flag, ring);
    }
    const h = world.half * PX;
    this.controls.target.set(0, 0.2, 0);
    this.camera.position.set(0, h * 1.5, h * 1.55);
  }

  setRobot(pose: { x: number; y: number; heading: number } | null): void {
    this.robot.visible = pose !== null;
    if (pose) { this.robot.position.set(pose.x * PX, 0, pose.y * PX); this.robot.rotation.y = -pose.heading; }
  }

  setTrail(trace: number[] | undefined, upto = Infinity): void {
    const points: THREE.Vector3[] = [];
    if (trace) for (let i = 0; i + 2 < trace.length && i / 3 < upto; i += 3) points.push(new THREE.Vector3(trace[i] * PX, 0.012, trace[i + 1] * PX));
    this.trail.geometry.dispose(); this.trail.geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  /** Put the camera low behind the robot, like looking over its shoulder. */
  follow(pose: { x: number; y: number; heading: number }): void {
    const back = 1.0, up = 1.0;
    this.camera.position.set((pose.x - Math.cos(pose.heading) * back / PX * PX) * 1, up, (pose.y - Math.sin(pose.heading) * back / PX * PX) * 1);
    this.camera.position.set(pose.x * PX - Math.cos(pose.heading) * back, up, pose.y * PX - Math.sin(pose.heading) * back);
    this.controls.target.set(pose.x * PX + Math.cos(pose.heading) * 0.5, 0.06, pose.y * PX + Math.sin(pose.heading) * 0.5);
  }

  render(): void { this.controls.update(); this.renderer.render(this.scene, this.camera); }
  start(): void { const tick = (): void => { this.render(); this.frame = requestAnimationFrame(tick); }; if (!this.frame) tick(); }
  stop(): void { cancelAnimationFrame(this.frame); this.frame = 0; }
  dispose(): void { this.stop(); this.controls.dispose(); this.renderer.dispose(); }
}
