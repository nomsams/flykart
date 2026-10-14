// A spatial index over everything solid in a world, for fast clearance rays and line-of-sight checks.
//
// `castRay` in the open world tests every solid for every ray. That is fine for 60 trees; a flat with 600 table
// legs, sofa feet and twigs needs the nearby ones only. The numbers it produces are the same (see the test).
import { OBJECT_KINDS, BODY_HEIGHT, STEP_OVER, clearance, furniture, floorItem, movable, partSolid } from "../vision/world/objects";
import type { WorldDef, Obstacle } from "../vision/world/world";
import { KART_RADIUS, SECTORS, SECTOR_ANGLES, SECTOR_RANGE, SECTOR_SPAN } from "../vision/world/world";
import type { Random } from "../vision/rng";

void OBJECT_KINDS;
const CELL = 48;
/** Smallest thing the camera can still make out: below this many radians a part fades from the picture. */
export const VISIBLE_LOW = 0.015, VISIBLE_FULL = 0.038;

export class SolidIndex {
  // Per solid, struct of arrays.
  private kind: number[] = []; private x: number[] = []; private y: number[] = []; private a: number[] = []; private b: number[] = [];
  private cs: number[] = []; private sn: number[] = []; private bound: number[] = []; private thick: number[] = [];
  private z0: number[] = []; private z1: number[] = []; private u: number[] = []; private flags: number[] = [];
  private readonly grid: number[][]; private readonly cells: number; private readonly origin: number;
  private readonly movables: { index: number; obstacle: Obstacle }[] = [];
  private stamp: Int32Array = new Int32Array(0); private tick = 0;
  private readonly hits: number[] = [];
  static readonly COLLIDES = 1; static readonly OPAQUE = 2; static readonly WATER = 4;

  constructor(readonly world: WorldDef, random: Random) {
    this.origin = -world.half - CELL; this.cells = Math.ceil((world.half * 2 + CELL * 2) / CELL) + 1;
    this.grid = Array.from({ length: this.cells * this.cells }, () => []);
    for (const o of world.obstacles) this.addObstacle(o, random);
    for (const p of world.patches) if (p.kind === "water") // The open world's ray test grows ponds by 2 px only (not by the kart's radius), so store the radius the rays will grow back.
      this.push(0, p.x, p.y, Math.max(0.5, p.radius + 2 - KART_RADIUS), 0, 0, SolidIndex.COLLIDES | SolidIndex.WATER, 0, 0.5, 2 * p.radius, random, false);
    this.stamp = new Int32Array(this.x.length);
  }

  get count(): number { return this.x.length; }

  private addObstacle(o: Obstacle, random: Random): void {
    if (o.parts) {
      for (const p of o.parts) {
        const solid = partSolid(p) !== null;
        const thick = p.shape === "cyl" ? p.halfLength * 2 : Math.min(p.halfLength, p.halfWidth) * 2;
        const flags = (solid ? SolidIndex.COLLIDES : 0) | (p.z1 > STEP_OVER * 2 ? SolidIndex.OPAQUE : 0);
        if (!flags) continue;
        if (p.shape === "cyl") this.push(0, p.x, p.y, p.halfLength, 0, 0, flags, p.z0, p.z1, thick, random, false);
        else this.push(1, p.x, p.y, p.halfLength, p.halfWidth, p.heading ?? 0, flags, p.z0, p.z1, thick, random, false);
      }
      return;
    }
    if (floorItem(o)) return;
    if (furniture(o)) {
      const lift = clearance(o);
      if (lift > BODY_HEIGHT) {
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) this.push(0, o.x + sx * (o.radius - 3), o.y + sy * (o.radius * 0.65 - 3), 2.5, 0, 0, SolidIndex.COLLIDES | SolidIndex.OPAQUE, 0, lift, 5, random, false);
        this.push(1, o.x, o.y, o.radius, o.radius * 0.65, 0, SolidIndex.OPAQUE, lift, o.height, o.radius * 1.3, random, false);
      } else this.push(1, o.x, o.y, o.radius, o.radius * 0.65, 0, SolidIndex.COLLIDES | SolidIndex.OPAQUE, 0, o.height, o.radius * 1.3, random, false);
      return;
    }
    const isMovable = movable(o);
    this.push(0, o.x, o.y, o.radius, 0, 0, SolidIndex.COLLIDES | SolidIndex.OPAQUE, 0, o.height, o.radius * 2, random, isMovable);
    if (isMovable) this.movables.push({ index: this.x.length - 1, obstacle: o });
  }

  private push(kind: number, x: number, y: number, a: number, b: number, heading: number, flags: number, z0: number, z1: number, thick: number, random: Random, dynamic: boolean): void {
    const index = this.x.length;
    this.kind.push(kind); this.x.push(x); this.y.push(y); this.a.push(a); this.b.push(b);
    this.cs.push(Math.cos(heading)); this.sn.push(Math.sin(heading));
    const bound = kind === 0 ? a : Math.hypot(a, b);
    this.bound.push(bound); this.thick.push(thick); this.z0.push(z0); this.z1.push(z1); this.u.push(random()); this.flags.push(flags);
    if (dynamic) return;
    const x0 = Math.floor((x - bound - this.origin) / CELL), x1 = Math.floor((x + bound - this.origin) / CELL);
    const y0 = Math.floor((y - bound - this.origin) / CELL), y1 = Math.floor((y + bound - this.origin) / CELL);
    for (let cy = Math.max(0, y0); cy <= Math.min(this.cells - 1, y1); cy += 1) for (let cx = Math.max(0, x0); cx <= Math.min(this.cells - 1, x1); cx += 1) this.grid[cy * this.cells + cx].push(index);
  }

  /** Candidate solids whose bounding circle comes within `range` of (x, y). The result array is reused. */
  collect(x: number, y: number, range: number, mask: number): number[] {
    const hits = this.hits; hits.length = 0; this.tick += 1;
    for (const m of this.movables) { m.obstacle.x !== this.x[m.index] && (this.x[m.index] = m.obstacle.x, this.y[m.index] = m.obstacle.y); }
    const x0 = Math.max(0, Math.floor((x - range - this.origin) / CELL)), x1 = Math.min(this.cells - 1, Math.floor((x + range - this.origin) / CELL));
    const y0 = Math.max(0, Math.floor((y - range - this.origin) / CELL)), y1 = Math.min(this.cells - 1, Math.floor((y + range - this.origin) / CELL));
    for (let cy = y0; cy <= y1; cy += 1) for (let cx = x0; cx <= x1; cx += 1) {
      for (const i of this.grid[cy * this.cells + cx]) {
        if (this.stamp[i] === this.tick || !(this.flags[i] & mask)) continue;
        this.stamp[i] = this.tick;
        if (Math.hypot(this.x[i] - x, this.y[i] - y) <= range + this.bound[i]) hits.push(i);
      }
    }
    for (const m of this.movables) if (this.flags[m.index] & mask && Math.hypot(this.x[m.index] - x, this.y[m.index] - y) <= range + this.bound[m.index]) hits.push(m.index);
    return hits;
  }

  private circleHit(cx: number, cy: number, r: number, x: number, y: number, dx: number, dy: number, best: number): number {
    const fx = cx - x, fy = cy - y, along = fx * dx + fy * dy;
    if (along < -r) return best;
    const d2 = fx * fx + fy * fy - along * along, r2 = r * r;
    if (d2 > r2) return best;
    const reach = along - Math.sqrt(r2 - d2);
    if (reach > 0 && reach < best) return reach;
    if (reach <= 0 && along > 0 && fx * fx + fy * fy < r2) return 0;
    return best;
  }

  /** Distance along a ray to this solid grown by the kart's radius (the same Minkowski sum as `castRay`). */
  private rayHit(i: number, x: number, y: number, dx: number, dy: number, best: number): number {
    if (this.kind[i] === 0) return this.circleHit(this.x[i], this.y[i], this.a[i] + KART_RADIUS, x, y, dx, dy, best);
    const c = this.cs[i], s = this.sn[i], hl = this.a[i], hw = this.b[i];
    const rx = x - this.x[i], ry = y - this.y[i];
    const ox = rx * c + ry * s, oy = -rx * s + ry * c, ldx = dx * c + dy * s, ldy = -dx * s + dy * c;
    for (let strip = 0; strip < 2; strip += 1) {
      const hx = hl + (strip === 0 ? KART_RADIUS : 0), hy = hw + (strip === 1 ? KART_RADIUS : 0);
      let lo = 0, hi = best, miss = false;
      for (let axis = 0; axis < 2; axis += 1) {
        const at = axis === 0 ? ox : oy, dir = axis === 0 ? ldx : ldy, size = axis === 0 ? hx : hy;
        if (Math.abs(dir) < 1e-9) { if (Math.abs(at) > size) { miss = true; break; } continue; }
        const t1 = (-size - at) / dir, t2 = (size - at) / dir;
        lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
      }
      if (!miss && lo <= hi) best = Math.min(best, lo);
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const lx = sx * hl, ly = sy * hw;
      best = this.circleHit(this.x[i] + lx * c - ly * s, this.y[i] + lx * s + ly * c, KART_RADIUS, x, y, dx, dy, best);
    }
    return best;
  }

  /** Is solid `i` seen by the camera at this range? Thin or far things fade; `u` is fixed per solid, so they do not flicker. */
  private seen(i: number, range: number): boolean {
    const angle = this.thick[i] / Math.max(1, range);
    if (angle >= VISIBLE_FULL) return true;
    return angle >= VISIBLE_LOW && (angle - VISIBLE_LOW) / (VISIBLE_FULL - VISIBLE_LOW) >= this.u[i];
  }

  /**
   * Distance to the first thing that would stop the kart along a ray. With `camera` set, only what a 48 x 24
   * camera could pick out counts (thin twigs and chair legs vanish with range), which is what the learned
   * clearance estimator also cannot see. The fence, ponds and everything wide are always visible.
   */
  castRay(x: number, y: number, angle: number, maxRange: number, candidates: number[], camera: boolean): number {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let best = maxRange;
    for (const i of candidates) {
      if (!(this.flags[i] & SolidIndex.COLLIDES)) continue;
      // Cheap reject: the ray must pass within (bound + kart radius) of the solid's centre, ahead of or at the origin.
      const reach = this.bound[i] + KART_RADIUS, fx = this.x[i] - x, fy = this.y[i] - y, along = fx * dx + fy * dy;
      if (along < -reach || along - reach > best) continue;
      if (fx * fx + fy * fy - along * along > reach * reach) continue;
      const hit = this.rayHit(i, x, y, dx, dy, best);
      if (hit < best && (!camera || hit <= 0 || this.seen(i, hit))) best = hit;
    }
    const limit = this.world.half - KART_RADIUS;
    if (dx > 1e-9) best = Math.min(best, Math.max(0, (limit - x) / dx)); else if (dx < -1e-9) best = Math.min(best, Math.max(0, (-limit - x) / dx));
    if (dy > 1e-9) best = Math.min(best, Math.max(0, (limit - y) / dy)); else if (dy < -1e-9) best = Math.min(best, Math.max(0, (-limit - y) / dy));
    return best;
  }

  /** The nine clearance sectors as the open world defines them, 0 (open) to 1 (touching). */
  clearance(x: number, y: number, heading: number, out: number[], camera: boolean): number[] {
    const candidates = this.collect(x, y, SECTOR_RANGE + KART_RADIUS, SolidIndex.COLLIDES);
    const width = (2 * SECTOR_SPAN) / SECTORS;
    for (let k = 0; k < SECTORS; k += 1) {
      let nearest = SECTOR_RANGE;
      for (const offset of [-0.32, 0, 0.32]) nearest = Math.min(nearest, this.castRay(x, y, heading + SECTOR_ANGLES[k] + offset * width, SECTOR_RANGE, candidates, camera));
      out[k] = 1 - nearest / SECTOR_RANGE;
    }
    return out;
  }

  /**
   * Can a camera at height `h0` see a point at height `h1` from (x0, y0) to (x1, y1)? Anything opaque whose height
   * interval contains the sight line where it crosses the footprint blocks the view.
   */
  lineOfSight(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number): boolean {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, length = Math.hypot(x1 - x0, y1 - y0);
    if (length < 1e-6) return true;
    const candidates = this.collect(mx, my, length / 2 + 2, SolidIndex.OPAQUE);
    const dx = (x1 - x0) / length, dy = (y1 - y0) / length;
    for (const i of candidates) {
      let enter = -1, leave = -1;
      if (this.kind[i] === 0) {
        const fx = this.x[i] - x0, fy = this.y[i] - y0, along = fx * dx + fy * dy, d2 = fx * fx + fy * fy - along * along, r2 = this.a[i] * this.a[i];
        if (d2 > r2) continue;
        const half = Math.sqrt(r2 - d2); enter = along - half; leave = along + half;
      } else {
        const c = this.cs[i], s = this.sn[i], rx = x0 - this.x[i], ry = y0 - this.y[i];
        const ox = rx * c + ry * s, oy = -rx * s + ry * c, ldx = dx * c + dy * s, ldy = -dx * s + dy * c;
        let lo = -Infinity, hi = Infinity, miss = false;
        for (let axis = 0; axis < 2; axis += 1) {
          const at = axis === 0 ? ox : oy, dir = axis === 0 ? ldx : ldy, size = axis === 0 ? this.a[i] : this.b[i];
          if (Math.abs(dir) < 1e-9) { if (Math.abs(at) > size) { miss = true; break; } continue; }
          const t1 = (-size - at) / dir, t2 = (size - at) / dir;
          lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
        }
        if (miss || lo > hi) continue;
        enter = lo; leave = hi;
      }
      if (leave < 0 || enter > length) continue;
      // Height of the sight line while it is inside the footprint.
      const tIn = Math.max(0, enter) / length, tOut = Math.min(length, leave) / length;
      const hIn = h0 + (h1 - h0) * tIn, hOut = h0 + (h1 - h0) * tOut;
      if (Math.max(hIn, hOut) >= this.z0[i] && Math.min(hIn, hOut) <= this.z1[i]) return false;
    }
    return true;
  }

  /** Is the floor point free for a kart of radius `padding`? (the spawn and reachability tests use this) */
  free(x: number, y: number, padding: number): boolean {
    if (Math.abs(x) > this.world.half - padding || Math.abs(y) > this.world.half - padding) return false;
    for (const i of this.collect(x, y, padding + 2, SolidIndex.COLLIDES)) {
      if (this.kind[i] === 0) { if (Math.hypot(x - this.x[i], y - this.y[i]) < this.a[i] + padding) return false; continue; }
      const c = this.cs[i], s = this.sn[i], rx = x - this.x[i], ry = y - this.y[i];
      const lx = rx * c + ry * s, ly = -rx * s + ry * c;
      const qx = Math.max(-this.a[i], Math.min(this.a[i], lx)), qy = Math.max(-this.b[i], Math.min(this.b[i], ly));
      if (Math.hypot(lx - qx, ly - qy) < padding) return false;
    }
    return true;
  }

  /** The solid's footprint circle list, for sonar targets and drawing. */
  describe(i: number): { kind: "circle" | "box"; x: number; y: number; a: number; b: number; heading: number; z0: number; z1: number } {
    return { kind: this.kind[i] === 0 ? "circle" : "box", x: this.x[i], y: this.y[i], a: this.a[i], b: this.b[i], heading: Math.atan2(this.sn[i], this.cs[i]), z0: this.z0[i], z1: this.z1[i] };
  }
}
