// Three places the real robot is meant to drive: a lawn, a pavement beside a road, and a flat.
//
// Each generator returns an ordinary `WorldDef` of the open world (so the Vision page, the camera, the sonar and
// the training code all accept it) filled with `prop` obstacles from `props.ts`, plus floor zones: grass, paving
// slabs, tarmac, light-brown parquet and dark-grey tile. The area is 7 m x 7 m (632 px), the same footprint as
// the Three.js habitat's floor, so a scene made here can be shown there unchanged.
import { mulberry32, type Random } from "../vision/rng";
import type { Obstacle, WorldDef, Zone, Patch } from "../vision/world/world";
import type { PropPart } from "../vision/world/objects";
import { COLORS, PROP_MAKERS, placeProp, type PropName } from "./props";
import { CM_PER_PIXEL } from "../vision/robot";

export const HABITAT_HALF = 316;
export type HabitatKind = "lawn" | "street" | "apartment";
export const HABITATS: { kind: HabitatKind; title: string; floors: string }[] = [
  { kind: "lawn", title: "Lawn and garden", floors: "grass, mud, sand, a paved path, a pond" },
  { kind: "street", title: "Pavement beside a road", floors: "paving slabs, tarmac, a grass verge, tree grates" },
  { kind: "apartment", title: "Apartment", floors: "light-brown parquet, dark-grey tile, a rug" },
];

const px = (cm: number): number => cm / CM_PER_PIXEL;
const between = (r: Random, lo: number, hi: number): number => lo + (hi - lo) * r();
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Local axis-aligned extent of a prop's near-floor parts. */
function extent(o: Obstacle): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const parts = o.parts!.filter((p) => p.z0 < px(14));
  for (const p of parts.length ? parts : o.parts!) {
    const c = Math.cos(p.heading ?? 0), s = Math.sin(p.heading ?? 0);
    const ex = p.shape === "cyl" ? p.halfLength : Math.abs(p.halfLength * c) + Math.abs(p.halfWidth * s);
    const ey = p.shape === "cyl" ? p.halfLength : Math.abs(p.halfLength * s) + Math.abs(p.halfWidth * c);
    x0 = Math.min(x0, p.x - ex); x1 = Math.max(x1, p.x + ex); y0 = Math.min(y0, p.y - ey); y1 = Math.max(y1, p.y + ey);
  }
  return { x0, x1, y0, y1 };
}

export function moveProp(o: Obstacle, dx: number, dy: number): Obstacle {
  o.x += dx; o.y += dy;
  for (const p of o.parts!) { p.x += dx; p.y += dy; }
  return o;
}

type Room = { x0: number; y0: number; x1: number; y1: number };

class Layout {
  readonly obstacles: Obstacle[] = [];
  readonly keepOut: { x: number; y: number; r: number }[] = [];
  constructor(readonly half: number, readonly random: Random) {}

  /** Does any near-floor part of `o` collide with a keep-out disc, the edge or something already placed? */
  private fits(o: Obstacle, margin: number): boolean {
    const low = o.parts!.filter((p) => p.z0 < px(14));
    for (const p of low) {
      const r = p.shape === "cyl" ? p.halfLength : Math.hypot(p.halfLength, p.halfWidth);
      if (Math.abs(p.x) + r > this.half - 4 || Math.abs(p.y) + r > this.half - 4) return false;
      for (const k of this.keepOut) if (Math.hypot(p.x - k.x, p.y - k.y) < k.r + r) return false;
    }
    for (const other of this.obstacles) {
      if (other.kind !== "prop") { if (Math.hypot(other.x - o.x, other.y - o.y) < other.radius + o.radius + margin) { for (const p of low) { const r = p.shape === "cyl" ? p.halfLength : Math.hypot(p.halfLength, p.halfWidth); if (Math.hypot(p.x - other.x, p.y - other.y) < r + other.radius + margin) return false; } } continue; }
      if (Math.hypot(other.x - o.x, other.y - o.y) > other.radius + o.radius + margin + 4) continue;
      for (const q of other.parts!) {
        if (q.z0 >= px(14)) continue;
        const rq = q.shape === "cyl" ? q.halfLength : Math.hypot(q.halfLength, q.halfWidth);
        for (const p of low) {
          const r = p.shape === "cyl" ? p.halfLength : Math.hypot(p.halfLength, p.halfWidth);
          if (Math.hypot(p.x - q.x, p.y - q.y) < r + rq + margin) return false;
        }
      }
    }
    return true;
  }

  add(o: Obstacle, margin = 6): boolean {
    if (!this.fits(o, margin)) return false;
    this.obstacles.push(o); return true;
  }

  /** Place at (x, y), or fall back to a few nearby jitters. */
  place(name: PropName, x: number, y: number, yaw: number, margin = 6, label?: string): Obstacle | null {
    const o = placeProp(name, this.random, x, y, yaw, label ?? name);
    return this.add(o, margin) ? o : null;
  }

  scatter(name: PropName, count: number, area: Room, margin = 10, yaw?: () => number): number {
    let placed = 0;
    for (let i = 0, tries = 0; i < count && tries < count * 40; tries += 1) {
      const x = between(this.random, area.x0, area.x1), y = between(this.random, area.y0, area.y1);
      if (this.place(name, x, y, yaw ? yaw() : this.random() * Math.PI * 2, margin)) { i += 1; placed += 1; }
    }
    return placed;
  }

  /** Put a prop against the inside of a wall of `room`: side is the wall it backs onto. */
  against(room: Room, side: "n" | "s" | "e" | "w", name: PropName, along: number, gap = 2): Obstacle | null {
    // Props are authored with their back at -y and their front at +y: yaw 0 faces +y (a "south-facing" prop sits against the north wall).
    const yaw = side === "n" ? 0 : side === "s" ? Math.PI : side === "w" ? -Math.PI / 2 : Math.PI / 2;
    const o = placeProp(name, this.random, 0, 0, yaw, name), e = extent(o);
    const w = room.x1 - room.x0, h = room.y1 - room.y0;
    let dx = 0, dy = 0;
    if (side === "n") { dx = room.x0 + w * along - (e.x0 + e.x1) / 2; dy = room.y0 + gap - e.y0; }
    else if (side === "s") { dx = room.x0 + w * along - (e.x0 + e.x1) / 2; dy = room.y1 - gap - e.y1; }
    else if (side === "w") { dy = room.y0 + h * along - (e.y0 + e.y1) / 2; dx = room.x0 + gap - e.x0; }
    else { dy = room.y0 + h * along - (e.y0 + e.y1) / 2; dx = room.x1 - gap - e.x1; }
    moveProp(o, dx, dy);
    return this.add(o, 3) ? o : null;
  }

  legacy(kind: "shoe" | "cable" | "mat", x: number, y: number, tone: number): boolean {
    const radius = kind === "shoe" ? 10 : kind === "cable" ? 18 : 22, height = kind === "shoe" ? 7 : kind === "cable" ? 1 : 0.5;
    if (Math.abs(x) > this.half - radius - 6 || Math.abs(y) > this.half - radius - 6) return false;
    for (const k of this.keepOut) if (Math.hypot(x - k.x, y - k.y) < k.r + radius) return false;
    for (const o of this.obstacles) if (Math.hypot(o.x - x, o.y - y) < o.radius + radius + 6) return false;
    this.obstacles.push({ kind, x, y, radius, height, tone }); return true;
  }
}

/** A straight wall segment between two points, as a prop with one box part. */
function wallSegment(x0: number, y0: number, x1: number, y1: number, thick = px(10), height = px(130)): Obstacle {
  const length = Math.hypot(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const part: PropPart = { shape: "box", x: cx, y: cy, heading: Math.atan2(y1 - y0, x1 - x0), halfLength: length / 2, halfWidth: thick / 2, z0: 0, z1: height, color: COLORS.wall, sonarSurface: "smooth", name: "partition wall" };
  return { kind: "prop", x: cx, y: cy, radius: length / 2 + thick, height, tone: 0.5, parts: [part], label: "wall" };
}

function startKeepOut(layout: Layout, random: Random): void {
  // The kart may start anywhere clear; keep the centre free so the original (0, 0) start is valid too.
  layout.keepOut.push({ x: 0, y: 0, r: 36 });
  // And the 3D habitat's own start pose (-1.4 m, 1.0 m), so a scene opens clear there too.
  layout.keepOut.push({ x: -1.4 / (CM_PER_PIXEL / 100), y: 1.0 / (CM_PER_PIXEL / 100), r: 34 });
  void random;
}

export function generateLawn(seed: number, difficulty = 0.5): WorldDef {
  const random = mulberry32(seed * 7331 + 17), d = clamp01(difficulty), half = HABITAT_HALF, L = new Layout(half, random);
  startKeepOut(L, random);
  const whole: Room = { x0: -half + 20, y0: -half + 20, x1: half - 20, y1: half - 20 };
  const zones: Zone[] = [], patches: Patch[] = [];
  // A paved garden path across the lawn, sometimes.
  if (random() < 0.65) { const yc = between(random, -150, 150), w = between(random, 26, 40); zones.push({ x0: -half, x1: half, y0: yc - w, y1: yc + w, kind: "pavement" }); }
  const circle = (kind: Patch["kind"], r0: number, r1: number): void => {
    for (let t = 0; t < 40; t += 1) {
      const radius = between(random, r0, r1), x = between(random, -half + radius, half - radius), y = between(random, -half + radius, half - radius);
      if (Math.hypot(x, y) < radius + 56) continue;
      if (patches.some((p) => Math.hypot(p.x - x, p.y - y) < p.radius + radius + 14)) continue;
      patches.push({ x, y, radius, kind }); return;
    }
  };
  for (let k = 0; k < Math.round(1 + d * 3); k += 1) circle("mud", 22, 44);
  for (let k = 0; k < Math.round(1 + d * 2); k += 1) circle("sand", 26, 50);
  if (random() < 0.4 + d * 0.4) circle("water", 26, 42);
  // Things that stand: counts grow with difficulty.
  L.scatter("tree", Math.round(3 + d * 8), whole, 14);
  L.scatter("bush", Math.round(3 + d * 9), whole, 10);
  L.scatter("rock", Math.round(3 + d * 9), whole, 8);
  L.scatter("stump", Math.round(d * 4), whole, 8);
  L.scatter("fallenBranch", Math.round(3 + d * 10), whole, 6);
  L.scatter("log", Math.round(d * 3), whole, 8);
  L.scatter("edging", Math.round(1 + d * 3), whole, 8);
  L.scatter("bench", random() < 0.5 ? 1 : 0, whole, 10);
  if (random() < 0.5) {
    const y = random() < 0.5 ? -half + 18 : half - 18;
    L.place("fence", between(random, -60, 60), y, 0, 2, "fence");
  }
  return { seed, half, obstacles: L.obstacles, patches, zones, base: "grass", boundary: "fence", name: "Lawn and garden" };
}

export function generateStreet(seed: number, difficulty = 0.5): WorldDef {
  const random = mulberry32(seed * 4793 + 5), d = clamp01(difficulty), half = HABITAT_HALF, L = new Layout(half, random);
  startKeepOut(L, random);
  const roadWidth = Math.round(between(random, 90, 130)), roadEdge = -half + roadWidth, verge = half - between(random, 55, 85);
  const zones: Zone[] = [
    { x0: -half, x1: half, y0: -half, y1: roadEdge, kind: "asphalt" },
    { x0: -half, x1: half, y0: verge, y1: half, kind: "grass" },
  ];
  // Kerb along the pavement edge with one or two dropped-kerb gaps where a small robot can cross.
  const gaps = [between(random, -180, -60), between(random, 60, 180)].slice(0, random() < 0.5 ? 1 : 2);
  let x = -half + 4;
  const kerbCm = 140;
  while (x < half - 4) {
    const len = Math.min(px(kerbCm), half - 4 - x), mid = x + len / 2;
    if (!gaps.some((g) => Math.abs(g - mid) < px(50) + len / 2)) {
      const o = placeProp("kerb", random, mid, roadEdge + px(7.5), 0, "kerb");
      // Fit this kerb stone to the slot exactly.
      o.parts![0].halfLength = len / 2; o.radius = len / 2 + 8; L.obstacles.push(o);
    }
    x += len;
  }
  const pave: Room = { x0: -half + 20, x1: half - 20, y0: roadEdge + px(26), y1: verge - 8 };
  // Street furniture roughly along the building line and kerb.
  L.scatter("lampPost", 1 + Math.round(d * 2), { x0: pave.x0, x1: pave.x1, y0: roadEdge + 30, y1: roadEdge + 46 }, 30);
  L.scatter("bollard", 2 + Math.round(d * 6), pave, 20);
  L.scatter("bin", 1 + Math.round(d * 3), pave, 16);
  L.scatter("bench", Math.round(d * 2), pave, 16, () => (random() < 0.5 ? 0 : Math.PI));
  L.scatter("bikeRack", Math.round(d * 3), pave, 14);
  L.scatter("planter", Math.round(d * 3), pave, 14);
  L.scatter("steps", Math.round(d * 2), pave, 14);
  L.scatter("pallet", Math.round(d * 2), pave, 10);
  for (let k = 0, trees = Math.round(1 + d * 3); k < trees; k += 1) {
    const tx = between(random, pave.x0 + 30, pave.x1 - 30), ty = between(random, pave.y0 + 30, pave.y1 - 30);
    const t = L.place("tree", tx, ty, 0, 14);
    if (t) zones.push({ x0: tx - 24, x1: tx + 24, y0: ty - 24, y1: ty + 24, kind: "tile" });
  }
  L.scatter("fallenBranch", Math.round(1 + d * 5), pave, 6);
  L.scatter("rock", Math.round(d * 2), { x0: pave.x0, x1: pave.x1, y0: verge, y1: half - 20 }, 8);
  L.scatter("bush", Math.round(1 + d * 3), { x0: pave.x0, x1: pave.x1, y0: verge, y1: half - 18 }, 8);
  return { seed, half, obstacles: L.obstacles, patches: [], zones, base: "pavement", boundary: "kerb", name: "Pavement beside a road" };
}

export function generateApartment(seed: number, difficulty = 0.5): WorldDef {
  const random = mulberry32(seed * 9173 + 41), d = clamp01(difficulty), half = HABITAT_HALF, L = new Layout(half, random);
  startKeepOut(L, random);
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
  const wall = px(10);
  // Two partitions with door gaps carve the flat into a living room, a kitchen and a bedroom/hall.
  const vx = Math.round(between(random, -50, 70)), doorY = between(random, -150, 150), hy = Math.round(between(random, -70, 70)), doorX = between(random, vx + 90, half - 90);
  const gap = px(48 + random() * 12);
  const parts: Obstacle[] = [
    wallSegment(vx, -half, vx, doorY - gap, wall), wallSegment(vx, doorY + gap, vx, half, wall),
    wallSegment(vx, hy, doorX - gap, hy, wall), wallSegment(doorX + gap, hy, half, hy, wall),
  ];
  for (const w of parts) L.obstacles.push(w);
  const living: Room = { x0: -half + wall / 2, x1: vx - wall / 2, y0: -half + wall / 2, y1: half - wall / 2 };
  const kitchen: Room = { x0: vx + wall / 2, x1: half - wall / 2, y0: -half + wall / 2, y1: hy - wall / 2 };
  const bedroom: Room = { x0: vx + wall / 2, x1: half - wall / 2, y0: hy + wall / 2, y1: half - wall / 2 };
  const floorOf = { living: pick<"parquet" | "tile">(["parquet", "parquet", "tile"]), kitchen: "tile" as "parquet" | "tile", bedroom: pick<"parquet" | "tile">(["parquet", "parquet", "tile"]) };
  if (random() < 0.5) floorOf.kitchen = "parquet";
  // Always show both floors somewhere.
  if (![floorOf.living, floorOf.kitchen, floorOf.bedroom].includes("tile")) floorOf.kitchen = "tile";
  if (![floorOf.living, floorOf.kitchen, floorOf.bedroom].includes("parquet")) floorOf.living = "parquet";
  const zones: Zone[] = [
    { ...living, kind: floorOf.living }, { ...kitchen, kind: floorOf.kitchen }, { ...bedroom, kind: floorOf.bedroom },
    // The strip under the doors takes the hall's floor: dark tile, as in a real entry.
  ];
  // Keep every doorway free.
  L.keepOut.push({ x: vx, y: doorY, r: gap + 8 }, { x: doorX, y: hy, r: gap + 8 });
  const sides = ["n", "s", "w"] as const;
  // Living room: a sofa on one wall with a coffee table and a rug in front, a TV unit opposite, shelves and plants.
  const sofaSide = pick([...sides]);
  L.against(living, sofaSide, "sofa", between(random, 0.25, 0.75), 2);
  const rugAt = { x: sofaSide === "w" ? living.x0 + px(190) : (living.x0 + living.x1) / 2 + between(random, -30, 30), y: sofaSide === "n" ? living.y0 + px(190) : sofaSide === "s" ? living.y1 - px(190) : (living.y0 + living.y1) / 2 };
  zones.push({ x0: rugAt.x - px(100), x1: rugAt.x + px(100), y0: rugAt.y - px(70), y1: rugAt.y + px(70), kind: "carpet" });
  L.place("coffeeTable", rugAt.x, rugAt.y, random() < 0.5 ? 0 : Math.PI / 2, 6);
  const opposite = { n: "s", s: "n", w: "e" }[sofaSide] as "n" | "s" | "e";
  L.against(living, opposite, "tvUnit", between(random, 0.3, 0.7), 2);
  L.against(living, pick([...sides]), "bookshelf", between(random, 0.1, 0.9), 2);
  L.against(living, pick([...sides]), "plant", random(), 4);
  if (random() < 0.5 + d * 0.3) L.against(living, "w", "floorLamp", between(random, 0.1, 0.9), 6);
  if (random() < 0.6) L.scatter("armchair", 1, living, 14);
  // Kitchen: a counter along the wall, a dining table and chairs.
  L.against(kitchen, "n", "counter", between(random, 0.3, 0.6), 2);
  const tx = (kitchen.x0 + kitchen.x1) / 2 + between(random, -18, 18), ty = (kitchen.y0 + kitchen.y1) / 2 + px(30);
  const round = random() < 0.4, tableYaw = random() < 0.5 ? 0 : Math.PI / 2;
  const table = L.place(round ? "roundTable" : "table", tx, ty, tableYaw, 6);
  if (table) {
    const seats = round ? 4 : 4 + Math.floor(random() * 2) * 0;
    for (let k = 0; k < seats; k += 1) {
      const a = (k / seats) * Math.PI * 2 + (round ? 0.4 : 0), reach = round ? px(70) : k % 2 ? px(60) : px(88);
      const cx = tx + (round ? Math.cos(a) * reach : (k % 2 ? 0 : (k < 2 ? -1 : 1) * reach)), cy = ty + (round ? Math.sin(a) * reach : (k % 2 ? (k < 2 ? -1 : 1) * reach : 0));
      // Chairs pushed in under the table keep their legs near it; scattered ones stand further out.
      const out = random() < d ? 1.25 : 1;
      L.place("chair", tx + (cx - tx) * out, ty + (cy - ty) * out, Math.atan2(ty - cy, tx - cx) + (random() - 0.5) * 0.4 * (1 + d), 2);
    }
  }
  L.scatter("bin", 1, kitchen, 8);
  if (random() < 0.5) L.scatter("stool", 1 + Math.round(d * 2), kitchen, 10);
  // Bedroom / hall: a bed, a wardrobe, a nightstand, a laundry basket.
  L.against(bedroom, pick(["s", "e"] as const), "bed", between(random, 0.35, 0.65), 2);
  L.against(bedroom, pick(["s", "e"] as const), "wardrobe", between(random, 0.2, 0.8), 2);
  L.against(bedroom, pick(["s", "e"] as const), "nightstand", between(random, 0.1, 0.9), 2);
  L.scatter("laundryBasket", 1, bedroom, 10);
  if (random() < 0.4) L.scatter("ironingBoard", 1, bedroom, 10);
  L.against(bedroom, "n", "shoeRack", between(random, 0.1, 0.9), 2);
  // Clutter that grows with difficulty: boxes, tripod lamps, loose cables and shoes.
  const rooms = [living, kitchen, bedroom];
  for (const room of rooms) {
    L.scatter("boxStack", Math.round(d * 2.5 * random()), room, 10);
    if (random() < d * 0.6) L.scatter("tripodLamp", 1, room, 10);
    for (let k = 0; k < Math.round(1 + d * 4); k += 1) L.legacy("shoe", between(random, room.x0 + 14, room.x1 - 14), between(random, room.y0 + 14, room.y1 - 14), random());
    for (let k = 0; k < Math.round(d * 3); k += 1) L.legacy("cable", between(random, room.x0 + 20, room.x1 - 20), between(random, room.y0 + 20, room.y1 - 20), random());
  }
  return { seed, half, obstacles: L.obstacles, patches: [], zones, base: "parquet", boundary: "wall", name: "Apartment" };
}

export function generateHabitat(kind: HabitatKind, seed: number, difficulty = 0.5): WorldDef {
  return kind === "lawn" ? generateLawn(seed, difficulty) : kind === "street" ? generateStreet(seed, difficulty) : generateApartment(seed, difficulty);
}

export const propNames = Object.keys(PROP_MAKERS) as PropName[];
