// A random open world: no road, no centre line, no checkpoints. Just terrain,
// trees, rocks, ponds, a fence around the edge and a sequence of goals to
// reach. The kart keeps the original FlyKart steering, throttle, brake and
// reverse dynamics; only the surroundings change.
import { Action, STEP, clamp, wrapAngle } from "../../core";
import { mulberry32, Random } from "../rng";

export const WORLD_HALF = 460;
export const KART_RADIUS = 8;
export const GOAL_RADIUS = 24;
export const SECTORS = 9;
/** The camera and the clearance sectors look this far to each side of the heading. */
export const SECTOR_SPAN = (50 * Math.PI) / 180;
export const SECTOR_RANGE = 220;

export type Surface = "grass" | "sand" | "mud" | "water";
export type Obstacle = { x: number; y: number; radius: number; kind: "tree" | "rock"; height: number; tone: number };
export type Patch = { x: number; y: number; radius: number; kind: Exclude<Surface, "grass"> };
export type WorldDef = { seed: number; half: number; obstacles: Obstacle[]; patches: Patch[] };

/** How cluttered the world is, from 0 (a few trees) to 1 (a thicket with ponds). */
export function generateWorld(seed: number, density = 0.6): WorldDef {
  const random = mulberry32(seed * 6151 + 29);
  const half = WORLD_HALF;
  const obstacles: Obstacle[] = []; const patches: Patch[] = [];
  const free = (x: number, y: number, radius: number): boolean => Math.hypot(x, y) > 70 + radius && obstacles.every((o) => Math.hypot(o.x - x, o.y - y) > o.radius + radius + 14) && patches.every((p) => Math.hypot(p.x - x, p.y - y) > p.radius * 0.6 + radius);
  const place = (count: number, radiusRange: [number, number], make: (x: number, y: number, r: number) => void): void => {
    for (let i = 0, tries = 0; i < count && tries < count * 30; tries += 1) {
      const r = radiusRange[0] + random() * (radiusRange[1] - radiusRange[0]);
      const x = (random() * 2 - 1) * (half - 40), y = (random() * 2 - 1) * (half - 40);
      if (free(x, y, r)) { make(x, y, r); i += 1; }
    }
  };
  const scale = 0.35 + density * 0.9;
  place(Math.round((3 + random() * 3) * (0.5 + density)), [28, 60], (x, y, radius) => patches.push({ x, y, radius, kind: "water" }));
  place(Math.round((4 + random() * 4) * scale), [30, 70], (x, y, radius) => patches.push({ x, y, radius, kind: "sand" }));
  place(Math.round((3 + random() * 3) * scale), [24, 55], (x, y, radius) => patches.push({ x, y, radius, kind: "mud" }));
  place(Math.round((38 + random() * 26) * scale), [5, 7.5], (x, y, radius) => obstacles.push({ x, y, radius, kind: "tree", height: 20 + random() * 16, tone: random() }));
  place(Math.round((14 + random() * 12) * scale), [8, 15], (x, y, radius) => obstacles.push({ x, y, radius, kind: "rock", height: 8 + radius * 0.6, tone: random() }));
  return { seed, half, obstacles, patches };
}

export function surfaceAt(world: WorldDef, x: number, y: number): Surface {
  let result: Surface = "grass";
  for (const patch of world.patches) {
    const d = Math.hypot(x - patch.x, y - patch.y);
    if (d < patch.radius) { if (patch.kind === "water") return "water"; result = patch.kind; }
  }
  return result;
}

/** The surface under a point as one number the camera can be asked for. */
export const SURFACE_VALUE: Record<Surface, number> = { grass: 0.5, sand: -0.2, mud: -0.7, water: -1 };

/**
 * Distance from (x, y) along `angle` to the first thing that would stop a kart:
 * an obstacle (grown by the kart's radius), the edge of a pond, or the fence.
 */
export function castRay(world: WorldDef, x: number, y: number, angle: number, maxRange: number): number {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let best = maxRange;
  const circle = (cx: number, cy: number, radius: number): void => {
    const fx = cx - x, fy = cy - y; const along = fx * dx + fy * dy;
    if (along < -radius) return;
    const d2 = fx * fx + fy * fy - along * along; const r2 = radius * radius;
    if (d2 > r2) return;
    const reach = along - Math.sqrt(r2 - d2);
    if (reach > 0 && reach < best) best = reach; else if (reach <= 0 && along > 0 && fx * fx + fy * fy < r2) best = 0;
  };
  for (const o of world.obstacles) circle(o.x, o.y, o.radius + KART_RADIUS);
  for (const p of world.patches) if (p.kind === "water") circle(p.x, p.y, p.radius + 2);
  const limit = world.half - KART_RADIUS;
  if (dx > 1e-9) best = Math.min(best, Math.max(0, (limit - x) / dx)); else if (dx < -1e-9) best = Math.min(best, Math.max(0, (-limit - x) / dx));
  if (dy > 1e-9) best = Math.min(best, Math.max(0, (limit - y) / dy)); else if (dy < -1e-9) best = Math.min(best, Math.max(0, (-limit - y) / dy));
  return best;
}

/** Centres of the clearance sectors, relative to the heading (left negative). */
export const SECTOR_ANGLES: number[] = Array.from({ length: SECTORS }, (_, k) => -SECTOR_SPAN + ((k + 0.5) / SECTORS) * 2 * SECTOR_SPAN);

/** How blocked each sector is, 0 (nothing within range) to 1 (touching). */
export function clearanceScan(world: WorldDef, x: number, y: number, heading: number, out: number[] = new Array(SECTORS).fill(0)): number[] {
  const width = (2 * SECTOR_SPAN) / SECTORS;
  for (let k = 0; k < SECTORS; k += 1) {
    let nearest = SECTOR_RANGE;
    for (const offset of [-0.32, 0, 0.32]) nearest = Math.min(nearest, castRay(world, x, y, heading + SECTOR_ANGLES[k] + offset * width, SECTOR_RANGE));
    out[k] = 1 - nearest / SECTOR_RANGE;
  }
  return out;
}

export type WorldKart = {
  x: number; y: number; heading: number; speed: number; steering: number;
  action: Action; yaw: number;
};

export type WorldStatus = { goals: number; collisions: number; crashed: boolean; crashReason?: string; ticks: number; score: number; distanceToGoal: number; goalX: number; goalY: number; timedOut: boolean };

/** One run in an open world. Pure simulation: no camera, no network. */
export class WorldSim {
  readonly world: WorldDef;
  readonly kart: WorldKart = { x: 0, y: 0, heading: 0, speed: 0, steering: 0, action: { steer: 0, throttle: 0, brake: 0, reverse: 0 }, yaw: 0 };
  readonly status: WorldStatus;
  private readonly random: Random;
  private cooldown = 0;
  readonly maxTicks: number;
  readonly goalLimit: number;
  surface: Surface = "grass";

  constructor(seed: number, options: { density?: number; maxTicks?: number; world?:WorldDef; start?:{x:number;y:number;heading:number}; goal?:{x:number;y:number}; goalLimit?:number } = {}) {
    this.world = options.world ? structuredClone(options.world) : generateWorld(seed, options.density ?? 0.6);
    this.goalLimit=options.goalLimit??Infinity;
    this.random = mulberry32(seed * 977 + 5);
    this.maxTicks = options.maxTicks ?? 2400;
    this.kart.heading = (this.random() * 2 - 1) * Math.PI;
    this.status = { goals: 0, collisions: 0, crashed: false, ticks: 0, score: 0, distanceToGoal: 0, goalX: 0, goalY: 0, timedOut: false };
    if(options.start)Object.assign(this.kart,options.start);
    if(options.goal){this.status.goalX=options.goal.x;this.status.goalY=options.goal.y;this.status.distanceToGoal=Math.hypot(options.goal.x-this.kart.x,options.goal.y-this.kart.y);}else this.nextGoal();
  }

  get done(): boolean { return this.status.crashed || this.status.timedOut || this.status.goals>=this.goalLimit; }

  private nextGoal(): void {
    const { world, kart } = this;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const angle = this.random() * Math.PI * 2, distance = 170 + this.random() * 220;
      const x = kart.x + Math.cos(angle) * distance, y = kart.y + Math.sin(angle) * distance;
      if (Math.abs(x) > world.half - 50 || Math.abs(y) > world.half - 50) continue;
      if (world.obstacles.some((o) => Math.hypot(o.x - x, o.y - y) < o.radius + 26)) continue;
      if (world.patches.some((p) => Math.hypot(p.x - x, p.y - y) < p.radius + 18 && p.kind === "water")) continue;
      this.status.goalX = x; this.status.goalY = y; this.status.distanceToGoal = Math.hypot(x - kart.x, y - kart.y); return;
    }
    this.status.goalX = -kart.x * 0.5; this.status.goalY = -kart.y * 0.5; this.status.distanceToGoal = Math.hypot(this.status.goalX - kart.x, this.status.goalY - kart.y);
  }

  /** Bearing and closeness of the goal as the controller receives them. */
  mission(out: number[] = [0, 0]): number[] {
    const { kart, status } = this;
    out[0] = wrapAngle(Math.atan2(status.goalY - kart.y, status.goalX - kart.x) - kart.heading) / Math.PI;
    out[1] = 1 - Math.min(400, Math.hypot(status.goalX - kart.x, status.goalY - kart.y)) / 400;
    return out;
  }

  step(action: Action): void {
    if (this.done) return;
    const { kart, status, world } = this;
    const surface = surfaceAt(world, kart.x, kart.y); this.surface = surface;
    const grip = surface === "mud" ? 0.6 : surface === "sand" ? 0.78 : 1;
    const requested = clamp(action.steer, -1, 1);
    kart.steering += (requested - kart.steering) * 0.24; if (Math.abs(kart.steering) < 1e-4) kart.steering = 0;
    const lowSpeed = clamp(Math.abs(kart.speed) / 18, 0.18, 1);
    const turn = kart.steering * (0.65 + Math.abs(kart.speed) / 150) * grip * (kart.speed < -0.5 ? -1 : 1) * lowSpeed * STEP;
    kart.heading += turn; kart.yaw = turn / STEP;
    const throttle = clamp(action.throttle, 0, 1), reverse = clamp(action.reverse ?? 0, 0, 1), brake = clamp(action.brake, 0, 1);
    let acceleration = throttle * 55 - reverse * 45 - kart.speed * 0.23;
    if (kart.speed > 0) acceleration -= brake * 75; else if (kart.speed < 0) acceleration += brake * 75;
    kart.speed = clamp(kart.speed + acceleration * STEP, -48, 90);
    if (surface === "mud") kart.speed *= 0.955; else if (surface === "sand") kart.speed *= 0.988;
    const before = status.distanceToGoal;
    kart.x += Math.cos(kart.heading) * kart.speed * STEP; kart.y += Math.sin(kart.heading) * kart.speed * STEP;
    status.ticks += 1; this.cooldown = Math.max(0, this.cooldown - 1);
    let hit = false;
    for (const o of world.obstacles) {
      const dx = kart.x - o.x, dy = kart.y - o.y; const d = Math.hypot(dx, dy), reach = o.radius + KART_RADIUS;
      if (d < reach) { const nx=d>1e-6?dx/d:Math.cos(kart.heading+Math.PI),ny=d>1e-6?dy/d:Math.sin(kart.heading+Math.PI); kart.x += nx*(reach-d+.5); kart.y += ny*(reach-d+.5); hit = true; }
    }
    const limit = world.half - KART_RADIUS;
    if (Math.abs(kart.x) > limit) { kart.x = Math.sign(kart.x) * limit; hit = true; }
    if (Math.abs(kart.y) > limit) { kart.y = Math.sign(kart.y) * limit; hit = true; }
    if (hit) {
      kart.speed *= 0.3;
      if (this.cooldown === 0) { status.collisions += 1; status.score -= 12; this.cooldown = 8; }
      if (status.collisions >= 8) { status.crashed = true; status.crashReason = "too many collisions"; }
    }
    if (surfaceAt(world, kart.x, kart.y) === "water") { status.crashed = true; status.crashReason = "drove into a pond"; status.score -= 60; kart.speed = 0; }
    const distance = Math.hypot(status.goalX - kart.x, status.goalY - kart.y);
    status.distanceToGoal = distance; status.score += (before - distance) * 0.05 - 0.002;
    if (distance < GOAL_RADIUS) { status.goals += 1; status.score += 100; if(status.goals<this.goalLimit)this.nextGoal(); }
    kart.action = { steer: action.steer, throttle: action.throttle, brake: action.brake, reverse: action.reverse ?? 0 };
    if (status.ticks >= this.maxTicks) status.timedOut = true;
  }
}
