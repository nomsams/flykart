import {GuardSettings,validateGuard} from './collision-guard';
import { ObjectVisual } from './imported-assets';
import { DEFAULT_VIBRATION, VibrationSettings, validateVibration } from "./vibration";
import { clamp } from "../core";
import { HC_SR04, CM_PER_PIXEL } from "../vision/robot";
import { ping, SonarReading, SonarTarget } from "../vision/sonar";
import { mulberry32 } from "../vision/rng";
import { NoiseSource } from "./noise";
import { contactParts, polygonsOverlap, rectangle } from "./contacts";

export type ObjectKind = "wall" | "table" | "chair" | "rock" | "stone" | "bush" | "tree" | "water" | "block" | "cable" | "shoe" | "doormat" | "bed" | "ball" | "image" | "model" | "pod";
export const OBJECT_TYPES: { kind: ObjectKind; label: string }[] = [
  { kind: "ball", label: "Blue ball · visual target" },
  { kind: "pod", label: "Charging pod · virtual food" }, { kind: "image", label: "Image card · import target" }, { kind: "model", label: "3D model · import GLB" },
  { kind: "wall", label: "Wall" }, { kind: "table", label: "Table" }, { kind: "chair", label: "Chair" },
  { kind: "bed", label: "Bed" }, { kind: "block", label: "Simple block" }, { kind: "shoe", label: "Shoe" },
  { kind: "cable", label: "Loose cable · drive-over caution" }, { kind: "doormat", label: "Doormat" },
  { kind: "rock", label: "Rock" }, { kind: "stone", label: "Low stone" }, { kind: "bush", label: "Bush" }, { kind: "tree", label: "Tree" }, { kind: "water", label: "Water" },
];
export const ROOM_TYPES = [
  { id: "room", label: "Workshop room", floor: "#b7bea7" }, { id: "bedroom", label: "Bedroom", floor: "#a38a70" },
  { id: "living", label: "Living room", floor: "#bcb29c" }, { id: "office", label: "Office", floor: "#a9b6bd" },
  { id: "maze", label: "Wall maze", floor: "#929e99" }, { id: "clutter", label: "Clutter challenge", floor: "#b8a58e" },
  { id: "garden", label: "Garden", floor: "#b7bea7" }, { id: "empty", label: "Empty floor", floor: "#b7bea7" },
];
export type WorldObject = { id: string; kind: ObjectKind; x: number; z: number; yaw: number; width: number; depth: number; height: number; visual?:ObjectVisual };
export type Solid = { x: number; z: number; yaw: number; width: number; depth: number; bottom: number; top: number; soft?: boolean };
export type RobotConfig = {
  guard?:GuardSettings;
  vibration?: VibrationSettings;
  length: number; width: number; wheelbase: number; mountHeight: number; wheelDiameter: number; wheelWidth: number;
  rpm: number; voltage: number; bridgeDrop: number; turnGrip: number; deadband: number;
  cameraFov: number; cameraPitch: number; cameraHz: number; sonarBeam: number; sonarEnabled: boolean; cameraEnabled: boolean;
};
export const DEFAULT_ROBOT: RobotConfig = { length: .26, width: .17, wheelbase: .115, mountHeight: .065, wheelDiameter: .065, wheelWidth: .027,
  rpm: 180, voltage: 6, bridgeDrop: 1.8, turnGrip: .72, deadband: .14, cameraFov: 66, cameraPitch: 8, cameraHz: 10, sonarBeam: 15, sonarEnabled: true, cameraEnabled: true, vibration:{...DEFAULT_VIBRATION} };
export function validateRobotConfig(raw:unknown):RobotConfig {
  const c=raw as RobotConfig, bounds:Partial<Record<keyof RobotConfig,[number,number]>>={length:[.1,.6],width:[.08,.4],wheelbase:[.05,.4],mountHeight:[.03,.3],wheelDiameter:[.03,.15],wheelWidth:[.01,.06],rpm:[100,240],voltage:[3,9],bridgeDrop:[0,4],turnGrip:[.2,1],deadband:[0,.6],cameraFov:[30,120],cameraPitch:[-15,40],cameraHz:[1,15],sonarBeam:[8,30]};
  if(!c||typeof c.cameraEnabled!=='boolean'||typeof c.sonarEnabled!=='boolean')throw new Error('Invalid component settings.');
  const result={...DEFAULT_ROBOT,cameraEnabled:c.cameraEnabled,sonarEnabled:c.sonarEnabled};
  for(const [name,[min,max]]of Object.entries(bounds)){const v=c[name as keyof RobotConfig];if(typeof v!=='number'||!Number.isFinite(v)||v<min-1e-8||v>max+1e-8)throw new Error(`Invalid ${name}.`);Object.assign(result,{[name]:v});}
  if(result.wheelbase>result.length||result.wheelWidth*2>=result.width)throw new Error('Wheel spacing and width must fit the chassis.');return {...result,guard:validateGuard(c.guard),vibration:validateVibration(c.vibration)};
}
export type Wiring = { vibration?: number; board: "esp32-cam" | "uno"; in1: number; in2: number; in3: number; in4: number; ena: number; enb: number; trig: number; echo: number; commonGround: boolean; echoDivider: boolean; sdCard: boolean };
export const ESP_WIRING: Wiring = { board: "esp32-cam", in1: 12, in2: 13, in3: 14, in4: 15, ena: -1, enb: -1, trig: 2, echo: 4, vibration: -1, commonGround: true, echoDivider: true, sdCard: false };
export const UNO_WIRING: Wiring = { ...ESP_WIRING, board: "uno", in1: 7, in2: 8, in3: 9, in4: 10, ena: 5, enb: 6, trig: 2, echo: 3, echoDivider: false };
export function wiringIssues(w: Wiring): { errors: string[]; notes: string[] } {
  const errors: string[] = [], notes: string[] = [];
  const used = [w.in1, w.in2, w.in3, w.in4, w.ena, w.enb, w.trig, w.echo, w.vibration ?? -1].filter(p => p >= 0);
  if ([w.in1, w.in2, w.in3, w.in4, w.trig, w.echo].some(p => p < 0)) errors.push("Motor inputs, TRIG and ECHO must be connected.");
  if (used.some(p => !Number.isInteger(p))) errors.push("Pin numbers must be integers.");
  if (new Set(used).size !== used.length) errors.push("Two signals share a GPIO.");
  if (!w.commonGround) errors.push("Controller, sonar and motor driver need a common ground.");
  if (w.board === "esp32-cam") {
    const reserved = [0, 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39, 16, 17];
    if (used.some(p => reserved.includes(p))) errors.push("A selected GPIO is occupied by the AI-Thinker camera or PSRAM.");
    if ([w.in1,w.in2,w.in3,w.in4,w.ena,w.enb,w.trig,w.echo].some(p => p>=0 && ![1, 2, 3, 4, 12, 13, 14, 15].includes(p)) || ![-1,1,2,3,4,12,13,14,15,33].includes(w.vibration??-1)) errors.push("Use an exposed spare AI-Thinker GPIO: 1, 2, 3, 4, 12–15.");
    if (!w.echoDivider) errors.push("HC-SR04 ECHO is 5 V: add a divider or level shifter before the 3.3 V ESP32 input.");
    if (w.sdCard && used.some(p => [2, 4, 12, 13, 14, 15].includes(p))) errors.push("The SD interface conflicts with the selected GPIOs. Disable SD.");
    notes.push("GPIO12/2/15 are boot strap pins: verify power-up levels; GPIO12 must not be pulled high at boot.");
    if (used.includes(4)) notes.push("GPIO4 also drives the onboard flash LED. Isolate that load when using it for ECHO.");
    if (used.includes(1) || used.includes(3)) notes.push("GPIO1/3 share the programming UART; disconnect peripherals for flashing.");
    if(w.vibration===33) notes.push("SW-420 GPIO33 requires access to the status-LED solder pad and isolation of the LED load. It is not a spare header pin.");
    notes.push("ESP32-CAM has no wheel encoders here. Speed and the map use commanded-wheel dead reckoning and can drift.");
  } else if (used.some(p => p > 19)) errors.push("UNO pins must be 0–19 (14–19 are A0–A5).");
  if (w.ena < 0 || w.enb < 0) notes.push("An enable pin of −1 means the L298N enable jumper is installed; PWM is applied to the direction inputs.");
  notes.push("Left two motors share channel A; right two share B. Motor stall current and power supply must be measured.");
  return { errors, notes };
}

let sequence = 0;
export function makeObject(kind: ObjectKind, x = 0, z = 0): WorldObject {
  const dims: Record<ObjectKind, number[]> = { image:[.03,.2,.2], model:[.2,.2,.2], pod:[.12,.22,.18], ball: [.06,.06,.06], wall: [1.6, .09, .7], table: [1.05, .7, .72], chair: [.42, .42, .8], rock: [.4, .34, .28], stone: [.15, .12, .045], bush: [.5, .5, .4], tree: [.65, .65, 1.6], water: [.9, .7, .008], block: [.25, .25, .25], cable: [.7, .02, .01], shoe: [.28, .11, .1], doormat: [.75, .45, .008], bed: [1.9, .95, .5] };
  const [width, depth, height] = dims[kind];
  return { id: `object-${Date.now()}-${sequence++}`, kind, x, z, yaw: 0, width, depth, height };
}

/** Furniture is decomposed into real-height solids, shared by collision and sonar. */
export function solidsFor(o: WorldObject): Solid[] {
  const part = (x: number, z: number, width: number, depth: number, bottom: number, top: number): Solid => ({
    x: o.x + x * Math.cos(o.yaw) - z * Math.sin(o.yaw), z: o.z + x * Math.sin(o.yaw) + z * Math.cos(o.yaw), yaw: o.yaw, width, depth, bottom, top,
  });
  if (o.visual?.type==='glb'&&o.visual.boxes?.length)return o.visual.boxes.map(b=>part(b.x*o.width,b.z*o.depth,b.width*o.width,b.depth*o.depth,(b.y-b.height/2)*o.height,(b.y+b.height/2)*o.height));
  if (o.kind === "pod")return [part(0,0,o.width,o.depth,.03,o.height)];
  if (o.kind === "water") return [];
  if (o.kind === "table" || o.kind === "chair" || o.kind === "bed") {
    const seat = o.kind === "table" ? o.height : o.kind === "bed" ? o.height * .48 : o.height * .55;
    const underside = o.kind === "bed" ? o.height * .32 : Math.max(0, seat - .045);
    const parts = [part(0, 0, o.width, o.depth, underside, seat)];
    for (const x of [-1, 1]) for (const z of [-1, 1]) parts.push(part(x * (o.width / 2 - .04), z * (o.depth / 2 - .04), .045, .045, 0, underside));
    if (o.kind === "chair") parts.push(part(0, o.depth / 2 - .025, o.width, .04, seat, o.height));
    if (o.kind === "bed") { parts.push(part(0, 0, o.width * .96, o.depth * .95, seat, o.height * .72)); parts.push(part(-o.width / 2 + .025, 0, .05, o.depth, underside, o.height)); }
    return parts;
  }
  if (o.kind === "tree") return [part(0, 0, o.width * .18, o.depth * .18, 0, o.height)];
  return [{ ...part(0, 0, o.width, o.depth, 0, o.height), soft: o.kind === "bush" }];
}

/** SAT for two oriented rectangles; height filtering is done by the caller. */
export function overlaps(a: Solid, b: Solid): boolean {
  for (const angle of [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2]) {
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const radius = (s: Solid) => Math.abs(Math.cos(s.yaw) * dx + Math.sin(s.yaw) * dz) * s.width / 2 + Math.abs(-Math.sin(s.yaw) * dx + Math.cos(s.yaw) * dz) * s.depth / 2;
    if (Math.abs((a.x - b.x) * dx + (a.z - b.z) * dz) >= radius(a) + radius(b)) return false;
  }
  return true;
}
export type Pose = { x: number; z: number; heading: number };
/** Low mats/cables are a traction approximation, not a wheel-climbing solver. */
export function traversable(o: WorldObject, c: RobotConfig): boolean { return (o.kind === "cable" || o.kind === "doormat") && o.height <= Math.min(.012, c.wheelDiameter * .2); }
export function robotContactParts(o: WorldObject, c: RobotConfig) { return traversable(o, c) ? [] : contactParts(o, solidsFor(o), c.mountHeight + .04); }
export class RobotPhysics {
  pose: Pose = { x: -1.4, z: 1, heading: 0 };
  odometry: Pose = { ...this.pose };
  left = 0; right = 0; speed = 0; collisions = 0; blocked = false;
  contact: { objectId: string | null; part: string } | null = null;
  surface: { objectId: string; kind: "cable" | "doormat" } | null = null;
  constructor(public config: RobotConfig = { ...DEFAULT_ROBOT }) {}
  reset(): void { this.pose = { x: -1.4, z: 1, heading: 0 }; this.odometry = { ...this.pose }; this.left = this.right = this.speed = this.collisions = 0; this.blocked = false; this.contact = null; this.surface = null; }
  get maxSpeed(): number { return this.config.rpm / 60 * Math.PI * this.config.wheelDiameter * clamp((this.config.voltage - this.config.bridgeDrop) / 6, 0, 1.2); }
  step(leftPWM: number, rightPWM: number, objects: WorldObject[], dt: number): void {
    const c = this.config;
    const response = (p: number) => Math.abs(p) < c.deadband ? 0 : p * this.maxSpeed;
    this.left += (response(clamp(leftPWM, -1, 1)) - this.left) * (1 - Math.exp(-dt / .16));
    this.right += (response(clamp(rightPWM, -1, 1)) - this.right) * (1 - Math.exp(-dt / .16));
    const advance = (pose: Pose, grip: number, interval: number) => {
      const speed = (this.left + this.right) / 2;
      const omega = (this.left - this.right) / Math.max(.01, c.width - c.wheelWidth) * grip;
      return { x: pose.x + Math.cos(pose.heading + omega * interval / 2) * speed * interval, z: pose.z + Math.sin(pose.heading + omega * interval / 2) * speed * interval, heading: pose.heading + omega * interval };
    };
    // Wheel-command odometry deliberately cannot observe collisions or skid slip.
    this.odometry = advance(this.odometry, 1, dt);
    const steps = Math.max(1, Math.ceil(this.maxSpeed * dt / .008));
    const parts = objects.flatMap(o => robotContactParts(o, c));
    this.contact = null; this.surface = null;
    const surfaces = objects.filter(o => traversable(o, c));
    let traction = 1;
    let blocked = false;
    for (let i = 0; i < steps; i++) {
      const under = surfaces.filter(o => polygonsOverlap(rectangle({ ...this.pose, yaw: this.pose.heading, width: c.length, depth: c.width }), rectangle(o)));
      const surface = under.find(o => o.kind === "cable") ?? under[0];
      traction = surface ? surface.kind === "cable" ? .75 : .85 : 1;
      if (surface) this.surface = { objectId: surface.id, kind: surface.kind as "cable" | "doormat" };
      const next = advance(this.pose, c.turnGrip, dt / steps * traction);
      const body: Solid = { x: next.x, z: next.z, yaw: next.heading, width: c.length, depth: c.width, bottom: 0, top: c.mountHeight + .04 };
      const footprint = rectangle(body), hit = parts.find(part => polygonsOverlap(footprint, part.polygon));
      const edge = footprint.some(p => Math.abs(p.x) > 3.5 || Math.abs(p.z) > 3.5);
      if (hit || edge) { blocked = true; this.contact = hit ? { objectId: hit.objectId, part: hit.part } : { objectId: null, part: "floor boundary" }; break; }
      this.pose = next;
    }
    if (blocked && !this.blocked) this.collisions++;
    this.blocked = blocked; this.speed = blocked ? 0 : (this.left + this.right) / 2 * traction;
  }
}

const PX_PER_METRE = 100 / CM_PER_PIXEL;
export class RobotSonar {
  reading: SonarReading = { range: 400 / CM_PER_PIXEL, echo: false, strength: 0 };
  lastTime = -Infinity;
  count = 0;
  private random = mulberry32(2048);
  update(time: number, pose: Pose, objects: WorldObject[], c: RobotConfig, noise?: NoiseSource): boolean {
    if (time - this.lastTime < .066 - 1e-8) return false;
    this.lastTime = time; this.count++;
    if (!c.sonarEnabled) { this.reading = { range: 400 / CM_PER_PIXEL, echo: false, strength: 0 }; return true; }
    const ox = pose.x + Math.cos(pose.heading) * c.length * .48, oz = pose.z + Math.sin(pose.heading) * c.length * .48;
    // An overhead tabletop outside the useful vertical cone must not occlude
    // floor-height echoes. The original 2D sonar tracer otherwise picks that
    // tabletop as its nearest horizontal intersection and loses the wall behind.
    const reachable = objects.flatMap(o => solidsFor(o)).filter(s => {
      const far = Math.hypot(s.x - ox, s.z - oz) + Math.hypot(s.width, s.depth) / 2;
      const spread = Math.tan(c.sonarBeam * Math.PI / 360) * Math.min(4, far);
      return s.bottom <= c.mountHeight + spread && s.top >= c.mountHeight - spread;
    });
    const targets: SonarTarget[] = reachable.map(s => ({ kind: "box" as const, x: s.x * PX_PER_METRE, y: s.z * PX_PER_METRE, heading: s.yaw,
      halfLength: s.width * PX_PER_METRE / 2, halfWidth: s.depth * PX_PER_METRE / 2, z0: s.bottom * PX_PER_METRE, z1: s.top * PX_PER_METRE }));
    this.reading = ping({ ...HC_SR04, lobeSigmaDeg: c.sonarBeam * .8, mountHeight: c.mountHeight * PX_PER_METRE, mountForward: c.length * .48 * PX_PER_METRE },
      { x: pose.x * PX_PER_METRE, y: pose.z * PX_PER_METRE, heading: pose.heading }, targets, this.random);
    if (noise) { const measured = noise.sonar(this.metres, this.reading.echo); this.reading = { range: measured.metres * PX_PER_METRE, echo: measured.echo, strength: measured.echo ? this.reading.strength : 0 }; }
    return true;
  }
  get metres(): number { return this.reading.range / PX_PER_METRE; }
  get pulseMicroseconds(): number { return this.reading.echo ? this.metres * 100 * 58 : 0; }
  get closeness(): number { return this.reading.echo ? clamp(1 - this.metres / 2.2, 0, 1) : 0; }
}

export function preset(name: string): WorldObject[] {
  const items: WorldObject[] = [];
  const add = (kind: ObjectKind, x: number, z: number, config: Partial<WorldObject> = {}) => items.push({ ...makeObject(kind, x, z), ...config });
  if (name !== "empty") {
    add("wall", 0, -2.3, { width: 5, height: .6 }); add("wall", 2.5, 0, { width: 4.6, yaw: Math.PI / 2, height: .6 });
    add("wall", -2.5, 0, { width: 4.6, yaw: Math.PI / 2, height: .6 });
    add("wall", -1.6, 2.3, { width: 1.8, height: .6 }); add("wall", 1.6, 2.3, { width: 1.8, height: .6 });
  }
  if (name === "room") { add("table", .4, -.2); add("chair", 1.2, .45); add("chair", -.5, -.55, { yaw: Math.PI }); add("wall", .9, -1.7, { width: 1.2, yaw: Math.PI / 2 }); add("rock", -1.7, -1.2, { width: .18, depth: .18, height: .13 }); }
  if (name === "garden") { add("tree", .6, -.6); add("tree", -1.2, -1.6); add("bush", -.2, 1); add("rock", 1.2, 1.2); add("water", 1.4, -1.4); add("stone", -.7, -.5); add("stone", .1, -.9); }
  if (name === "bedroom") { add("bed", .6, -1.3); add("table", -1.7, -1.5, { width: .5, depth: .5 }); add("chair", -1.7, -.8); add("shoe", -.3, .1, { yaw: .4 }); add("shoe", .05, .2, { yaw: .7 }); add("doormat", 0, 1.8); add("cable", 1.5, .2, { yaw: 1.1 }); }
  if (name === "living") { add("table", .25, -.1, { width: 1.3, depth: .8, height: .45 }); add("chair", 1.3, .3); add("chair", -.8, -.7, { yaw: Math.PI }); add("doormat", .2, 1.65, { width: 1.3, depth: .7 }); add("block", 1.5, -1.4); add("shoe", -.4, 1.3); add("cable", -1, -.1, { yaw: .8, width: 1 }); }
  if (name === "office") { add("table", .2, -1.5, { width: 1.8, depth: .7 }); add("chair", .2, -.7, { yaw: Math.PI }); add("table", 1.65, .3, { width: .55, depth: .7 }); add("cable", .3, -.2, { width: 1.3, yaw: .4 }); add("block", -1.8, -1.5, { height: .55 }); add("block", 1.8, 1.5, { width: .4, depth: .4 }); add("doormat", 0, 1.9); }
  if (name === "maze") { add("wall", -.7, -.7, { width: 2.5, yaw: Math.PI / 2 }); add("wall", .65, .75, { width: 2.5, yaw: Math.PI / 2 }); add("wall", 1.3, -1.7, { width: 1.3 }); add("block", -1.65, -1.65); add("doormat", 1.5, 1.55); }
  if (name === "clutter") { add("table", .5, -.4); add("bed", -1.4, -1.6, { width: 1.7, depth: .8 }); add("chair", 1.3, .4); add("bush", 1.6, -1.6); add("block", -.45, .3); add("block", .65, 1.4, { width: .18, height: .15 }); add("shoe", -.6, 1.4, { yaw: .5 }); add("shoe", -.15, 1.6, { yaw: -.4 }); add("cable", -.8, -.2, { width: 1, yaw: 1.2 }); add("cable", 1.6, 1.1, { yaw: .3 }); add("doormat", .15, 1.9); }
  return items;
}
