// A catalogue of things a small robot meets, built from boxes and cylinders at real heights.
//
// The original open world knew circles and axis-aligned slabs. A real room or garden is full of thin legs,
// feet that lift a sofa 10 cm off the floor, tilted splayed legs, forked branches lying at odd angles and
// foliage that the camera sees but the ultrasonic beam barely hears. Each prop here is a list of parts with a
// true footprint and true height, so the same description drives the collision model, the HC-SR04 echo model,
// the software camera and (via `toRobotObject`) the Three.js habitat.
//
// Dimensions are written in centimetres, in the prop's own frame (x along its heading, y across), and
// converted to world pixels (1 px = 1.1 cm) when placed.
import type { PropPart } from "../vision/world/objects";
import type { Obstacle } from "../vision/world/world";
import { CM_PER_PIXEL } from "../vision/robot";
import type { Random } from "../vision/rng";
import type { SonarSurface } from "../vision/sonar-surfaces";

export type Rgb = [number, number, number];
/** One part in centimetres, in the prop's local frame. For a cylinder `l` is the radius. */
export type PartCm = { shape: "box" | "cyl"; x: number; y: number; l: number; w: number; z0: number; z1: number; h?: number; c: Rgb; s?: SonarSurface; n?: string };

export const COLORS = {
  oak: [0.78, 0.62, 0.42] as Rgb, walnut: [0.38, 0.25, 0.16] as Rgb, pine: [0.84, 0.7, 0.45] as Rgb, white: [0.9, 0.9, 0.87] as Rgb,
  grey: [0.5, 0.52, 0.55] as Rgb, charcoal: [0.2, 0.21, 0.24] as Rgb, teal: [0.2, 0.43, 0.46] as Rgb, mustard: [0.8, 0.62, 0.2] as Rgb, rust: [0.62, 0.3, 0.18] as Rgb,
  metal: [0.72, 0.74, 0.76] as Rgb, black: [0.1, 0.1, 0.11] as Rgb, bark: [0.33, 0.24, 0.16] as Rgb, leaf: [0.18, 0.5, 0.2] as Rgb, leafDark: [0.12, 0.38, 0.17] as Rgb,
  stone: [0.58, 0.57, 0.54] as Rgb, concrete: [0.7, 0.7, 0.68] as Rgb, brick: [0.62, 0.34, 0.26] as Rgb, cardboard: [0.7, 0.55, 0.36] as Rgb, terracotta: [0.76, 0.4, 0.26] as Rgb,
  wall: [0.93, 0.92, 0.88] as Rgb, kerb: [0.76, 0.76, 0.74] as Rgb, paint: [0.9, 0.78, 0.2] as Rgb,
};

const box = (x: number, y: number, l: number, w: number, z0: number, z1: number, c: Rgb, h = 0, n?: string, s?: SonarSurface): PartCm => ({ shape: "box", x, y, l, w, z0, z1, h, c, n, s });
const cyl = (x: number, y: number, r: number, z0: number, z1: number, c: Rgb, n?: string, s?: SonarSurface): PartCm => ({ shape: "cyl", x, y, l: r, w: r, z0, z1, c, n, s });

/**
 * A leg or branch that goes from (x0, y0, z0) to (x1, y1, z1): a stack of short prisms that follows the slope, so a
 * splayed table leg or a branch rising from a trunk leans in plan view and in height like the real thing.
 */
export function slanted(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, thick: number, c: Rgb, n?: string): PartCm[] {
  const run = Math.hypot(x1 - x0, y1 - y0), rise = Math.abs(z1 - z0);
  const steps = Math.max(1, Math.min(14, Math.ceil(Math.max(rise / 5, run / 28))));
  const heading = Math.atan2(y1 - y0, x1 - x0), parts: PartCm[] = [];
  for (let i = 0; i < steps; i += 1) {
    const a = i / steps, b = (i + 1) / steps;
    const ax = x0 + (x1 - x0) * a, ay = y0 + (y1 - y0) * a, bx = x0 + (x1 - x0) * b, by = y0 + (y1 - y0) * b;
    const za = z0 + (z1 - z0) * a, zb = z0 + (z1 - z0) * b;
    const length = Math.max(thick, Math.hypot(bx - ax, by - ay) + thick * 0.4);
    parts.push({ shape: "box", x: (ax + bx) / 2, y: (ay + by) / 2, l: length, w: thick, z0: Math.max(0, Math.min(za, zb) - thick / 2), z1: Math.max(za, zb) + thick / 2, h: heading, c, n });
  }
  return parts;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const between = (r: Random, lo: number, hi: number): number => lo + (hi - lo) * r();

export type PropName =
  | "sofa" | "armchair" | "table" | "roundTable" | "coffeeTable" | "chair" | "stool" | "bed" | "bookshelf" | "tvUnit" | "wardrobe" | "nightstand"
  | "plant" | "floorLamp" | "tripodLamp" | "ironingBoard" | "boxStack" | "laundryBasket" | "counter" | "bin" | "radiator" | "shoeRack"
  | "tree" | "bush" | "rock" | "fallenBranch" | "log" | "stump" | "fence" | "edging" | "bench" | "bollard" | "lampPost" | "bikeRack" | "kerb" | "steps" | "planter" | "wall" | "pallet";

export const PROP_MAKERS: Record<PropName, (r: Random) => PartCm[]> = {
  sofa: (r) => {
    const fabric = r() < 0.5 ? COLORS.teal : r() < 0.5 ? COLORS.grey : COLORS.mustard, light = mix(fabric, [1, 1, 1], 0.14);
    const parts = [
      box(0, 0, 200, 90, 11, 26, fabric, 0, "sofa base", "soft"), box(0, 7, 164, 70, 26, 43, light, 0, "seat cushions", "soft"),
      box(0, -37, 198, 17, 26, 86, fabric, 0, "sofa back", "soft"), box(-90, 0, 20, 90, 26, 63, fabric, 0, "armrest", "soft"), box(90, 0, 20, 90, 26, 63, fabric, 0, "armrest", "soft"),
    ];
    // Short splayed wooden feet that lift the sofa 11 cm: a small robot can drive under it, a tall one cannot.
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(...slanted(sx * 84, sy * 33, 0, sx * 90, sy * 38, 11, 4.5, COLORS.walnut, "sofa foot"));
    return parts;
  },
  armchair: (r) => {
    const fabric = r() < 0.5 ? COLORS.rust : COLORS.grey;
    const parts = [box(0, 0, 80, 78, 12, 27, fabric, 0, "armchair base", "soft"), box(2, 6, 56, 60, 27, 42, mix(fabric, [1, 1, 1], 0.12), 0, "cushion", "soft"), box(0, -34, 80, 14, 27, 82, fabric, 0, "back", "soft"),
      box(-36, 0, 12, 78, 27, 58, fabric, 0, "arm", "soft"), box(36, 0, 12, 78, 27, 58, fabric, 0, "arm", "soft")];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(cyl(sx * 33, sy * 33, 3, 0, 12, COLORS.walnut, "foot"));
    return parts;
  },
  table: (r) => {
    const w = between(r, 110, 160), d = between(r, 70, 90), top = COLORS[r() < 0.5 ? "oak" : "walnut"];
    const parts = [box(0, 0, w, d, 71, 74, top, 0, "tabletop")];
    for (const sy of [-1, 1]) parts.push(box(0, sy * (d / 2 - 6), w - 14, 2.5, 63, 71, top, 0, "apron"));
    for (const sx of [-1, 1]) parts.push(box(sx * (w / 2 - 6), 0, 2.5, d - 14, 63, 71, top, 0, "apron"));
    // Slightly splayed legs, thicker at the top.
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(...slanted(sx * (w / 2 - 8), sy * (d / 2 - 8), 71, sx * (w / 2 - 3), sy * (d / 2 - 3), 0, 5, top, "table leg"));
    return parts;
  },
  roundTable: (r) => {
    const R = between(r, 40, 55), top = COLORS[r() < 0.5 ? "pine" : "walnut"];
    // A pedestal and a cross-shaped foot: from above it is a plus sign, not a circle.
    return [cyl(0, 0, R, 71, 74, top, "round top"), cyl(0, 0, 5.5, 4, 71, top, "pedestal"), box(0, 0, R * 1.3, 7, 0, 4, COLORS.charcoal, 0, "foot"), box(0, 0, R * 1.3, 7, 0, 4, COLORS.charcoal, Math.PI / 2, "foot")];
  },
  coffeeTable: (r) => {
    const w = between(r, 85, 115), d = between(r, 45, 60), c = COLORS[r() < 0.5 ? "oak" : "white"];
    const parts = [box(0, 0, w, d, 39, 42, c, 0, "top"), box(0, 0, w - 12, d - 10, 8, 10, c, 0, "lower shelf")];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(box(sx * (w / 2 - 4), sy * (d / 2 - 4), 3.5, 3.5, 0, 39, COLORS.charcoal, 0, "leg"));
    return parts;
  },
  chair: (r) => {
    const c = COLORS[r() < 0.5 ? "oak" : "walnut"], pad = r() < 0.5 ? COLORS.grey : COLORS.mustard;
    const parts = [box(0, 0, 42, 42, 43, 46, pad, 0, "seat"), box(-19.5, 0, 3.5, 40, 46, 90, c, 0, "backrest")];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(box(sx * 19, sy * 19, 3.5, 3.5, 0, 43, c, 0, "chair leg"));
    for (const sy of [-1, 1]) parts.push(box(0, sy * 19, 36, 2, 14, 17, c, 0, "stretcher"));
    return parts;
  },
  stool: () => {
    const parts = [cyl(0, 0, 17, 43, 47, COLORS.pine, "stool seat")];
    for (let k = 0; k < 3; k += 1) { const a = (k / 3) * Math.PI * 2 + 0.3; parts.push(...slanted(Math.cos(a) * 9, Math.sin(a) * 9, 43, Math.cos(a) * 20, Math.sin(a) * 20, 0, 3.2, COLORS.walnut, "splayed leg")); }
    return parts;
  },
  bed: (r) => {
    const sheet = r() < 0.5 ? [0.55, 0.62, 0.78] as Rgb : [0.82, 0.78, 0.7] as Rgb;
    const parts = [box(0, 0, 200, 150, 18, 30, COLORS.walnut, 0, "bed frame"), box(0, 0, 192, 142, 30, 52, sheet, 0, "mattress", "soft"), box(-98, 0, 6, 156, 30, 95, COLORS.walnut, 0, "headboard"),
      box(-78, -34, 34, 52, 52, 60, COLORS.white, 0, "pillow", "soft"), box(-78, 34, 34, 52, 52, 60, COLORS.white, 0, "pillow", "soft")];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(box(sx * 92, sy * 68, 8, 8, 0, 18, COLORS.walnut, 0, "bed foot"));
    return parts;
  },
  bookshelf: (r) => [box(0, 0, between(r, 70, 100), 30, 0, between(r, 150, 190), COLORS.oak, 0, "bookshelf")],
  tvUnit: () => [box(0, 0, 150, 40, 16, 50, COLORS.white, 0, "tv unit"), ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => box(sx * 68, sy * 15, 4, 4, 0, 16, COLORS.walnut, 0, "leg"))), box(0, 0, 100, 6, 50, 95, COLORS.black, 0, "television")],
  wardrobe: () => [box(0, 0, 120, 55, 0, 200, COLORS.white, 0, "wardrobe")],
  nightstand: () => [box(0, 0, 40, 36, 28, 52, COLORS.oak, 0, "nightstand"), ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => box(sx * 16, sy * 14, 3, 3, 0, 28, COLORS.walnut, 0, "leg")))],
  plant: (r) => [cyl(0, 0, 16, 0, 34, COLORS.terracotta, "pot"), cyl(0, 0, between(r, 24, 34), 34, between(r, 80, 120), COLORS.leaf, "foliage", "foliage")],
  floorLamp: () => [cyl(0, 0, 14, 0, 1.6, COLORS.charcoal, "lamp base"), cyl(0, 0, 1.4, 1.6, 150, COLORS.metal, "lamp pole"), cyl(0, 0, 17, 138, 166, [0.95, 0.92, 0.78], "lamp shade")],
  tripodLamp: () => {
    const parts = [cyl(0, 0, 1.6, 20, 150, COLORS.metal, "pole"), cyl(0, 0, 17, 140, 165, [0.95, 0.92, 0.78], "shade")];
    for (let k = 0; k < 3; k += 1) { const a = (k / 3) * Math.PI * 2 + 0.5; parts.push(...slanted(Math.cos(a) * 3, Math.sin(a) * 3, 25, Math.cos(a) * 30, Math.sin(a) * 30, 0, 2.6, COLORS.walnut, "tripod leg")); }
    return parts;
  },
  ironingBoard: () => {
    // A folding stand: legs cross in an X in plan view and lean in height.
    const parts = [box(0, 0, 120, 32, 78, 81, COLORS.grey, 0, "board")];
    for (const sx of [-1, 1]) {
      parts.push(...slanted(sx * 38, -15, 0, sx * 14, 12, 78, 2.6, COLORS.metal, "leg"));
      parts.push(...slanted(sx * 38, 15, 0, sx * 14, -12, 78, 2.6, COLORS.metal, "leg"));
    }
    return parts;
  },
  boxStack: (r) => {
    const parts = [box(0, 0, between(r, 35, 50), between(r, 28, 40), 0, between(r, 25, 38), COLORS.cardboard, r() * 0.4 - 0.2, "box")];
    if (r() < 0.6) parts.push(box(2, 1, 28, 24, parts[0].z1, parts[0].z1 + between(r, 14, 24), mix(COLORS.cardboard, [1, 1, 1], 0.1), r() * 0.8 - 0.4, "box"));
    return parts;
  },
  laundryBasket: () => [cyl(0, 0, 22, 0, 52, [0.86, 0.84, 0.78], "basket", "soft")],
  counter: (r) => [box(0, 0, between(r, 160, 240), 60, 9, 90, COLORS.white, 0, "kitchen counter"), box(0, 2, between(r, 150, 230), 52, 0, 9, COLORS.charcoal, 0, "plinth")],
  bin: () => [cyl(0, 0, 18, 0, 62, COLORS.charcoal, "kitchen bin")],
  radiator: () => [box(0, 0, 90, 8, 12, 62, COLORS.white, 0, "radiator")],
  shoeRack: () => [box(0, 0, 70, 28, 0, 28, COLORS.walnut, 0, "shoe rack")],

  tree: (r) => {
    const trunkR = between(r, 5, 9), parts: PartCm[] = [cyl(0, 0, trunkR, 0, 320, COLORS.bark, "trunk")];
    const low = 2 + Math.floor(r() * 3);
    for (let k = 0; k < low; k += 1) {
      // A branch leaves the trunk 15-70 cm up, rises, and forks once. These sit exactly at sonar height.
      const a = r() * Math.PI * 2, z = between(r, 14, 70), reach = between(r, 40, 85), lift = between(r, 6, 35);
      const x1 = Math.cos(a) * reach, y1 = Math.sin(a) * reach;
      parts.push(...slanted(Math.cos(a) * trunkR, Math.sin(a) * trunkR, z, x1, y1, z + lift, between(r, 2.2, 3.6), COLORS.bark, "branch"));
      const fa = a + (r() < 0.5 ? -1 : 1) * between(r, 0.5, 0.9), fx = x1 + Math.cos(fa) * between(r, 18, 35), fy = y1 + Math.sin(fa) * between(r, 18, 35);
      parts.push(...slanted(x1, y1, z + lift, fx, fy, z + lift + between(r, 4, 14), between(r, 1.2, 2), COLORS.bark, "twig"));
    }
    parts.push(cyl(0, 0, between(r, 55, 95), 170, 320, COLORS.leaf, "canopy", "foliage"));
    return parts;
  },
  bush: (r) => {
    const parts: PartCm[] = [], n = 2 + Math.floor(r() * 3), h = between(r, 35, 70);
    for (let k = 0; k < n; k += 1) parts.push(cyl(between(r, -16, 16), between(r, -16, 16), between(r, 15, 26), 0, h * between(r, 0.7, 1), r() < 0.5 ? COLORS.leaf : COLORS.leafDark, "bush", "foliage"));
    return parts;
  },
  rock: (r) => {
    // Overlapping slabs at different angles read as an angular boulder, not a disc.
    const c = mix(COLORS.stone, [0.35, 0.34, 0.32], r() * 0.5), parts: PartCm[] = [];
    const n = 2 + Math.floor(r() * 3), h = between(r, 8, 24);
    for (let k = 0; k < n; k += 1) parts.push(box(between(r, -8, 8), between(r, -8, 8), between(r, 18, 36), between(r, 12, 24), 0, h * between(r, 0.55, 1), mix(c, [1, 1, 1], r() * 0.12), r() * Math.PI, "rock", "rough"));
    return parts;
  },
  fallenBranch: (r) => {
    // A main limb 2-4 cm thick on the ground plus twigs thin enough for the wheels to ride over.
    const length = between(r, 70, 150), t = between(r, 1.6, 4), a = between(r, -0.35, 0.35), parts: PartCm[] = [];
    parts.push(...slanted(-length / 2, 0, t / 2, length / 2, Math.sin(a) * length * 0.3, t / 2, t, COLORS.bark, "fallen branch"));
    for (let k = 0; k < 2 + Math.floor(r() * 3); k += 1) {
      const at = between(r, -0.3, 0.4) * length, side = r() < 0.5 ? -1 : 1, len = between(r, 18, 45), sa = side * between(r, 0.4, 0.9);
      parts.push(box(at + Math.cos(sa) * len / 2, side * 2 + Math.sin(sa) * len / 2, len, between(r, 0.6, 1.1), 0, between(r, 0.9, 1.2), COLORS.bark, sa, "twig"));
    }
    return parts;
  },
  log: (r) => [box(0, 0, between(r, 70, 110), between(r, 14, 22), 0, between(r, 14, 22), COLORS.bark, 0, "log")],
  stump: (r) => [cyl(0, 0, between(r, 10, 18), 0, between(r, 14, 32), COLORS.bark, "stump")],
  fence: (r) => {
    const parts: PartCm[] = [], n = 3;
    for (let k = 0; k <= n; k += 1) parts.push(box(-180 + k * 120, 0, 8, 8, 0, 112, COLORS.pine, 0, "fence post"));
    for (const z of [32, 82]) parts.push(box(0, 0, 360, 3.5, z, z + 5, COLORS.pine, 0, "fence rail"));
    if (r() < 0.6) for (let k = 0; k < 28; k += 1) parts.push(box(-175 + k * 13, 4, 7, 1.6, 0, 92, mix(COLORS.pine, [1, 1, 1], 0.08), 0, "picket"));
    return parts;
  },
  edging: (r) => [box(0, 0, between(r, 140, 220), 6, 0, 9, COLORS.brick, 0, "edging")],
  bench: () => [
    box(0, 0, 130, 40, 42, 46, COLORS.oak, 0, "bench seat"), box(0, -18, 130, 4, 46, 86, COLORS.oak, 0, "bench back"),
    box(-56, 0, 5, 40, 0, 42, COLORS.charcoal, 0, "bench leg"), box(56, 0, 5, 40, 0, 42, COLORS.charcoal, 0, "bench leg"), box(-60, 0, 5, 34, 46, 62, COLORS.charcoal, 0, "armrest"), box(60, 0, 5, 34, 46, 62, COLORS.charcoal, 0, "armrest"),
  ],
  bollard: () => [cyl(0, 0, 6.5, 0, 85, COLORS.charcoal, "bollard")],
  lampPost: () => [cyl(0, 0, 6, 0, 450, COLORS.charcoal, "lamp post"), cyl(0, 0, 10, 0, 6, COLORS.charcoal, "lamp post base")],
  bikeRack: () => [box(-40, 0, 4, 4, 0, 80, COLORS.metal, 0, "post"), box(40, 0, 4, 4, 0, 80, COLORS.metal, 0, "post"), box(0, 0, 84, 4, 74, 80, COLORS.metal, 0, "rail"), box(0, 0, 84, 3, 36, 40, COLORS.metal, 0, "rail")],
  kerb: (r) => [box(0, 0, between(r, 180, 300), 15, 0, 12, COLORS.kerb, 0, "kerb")],
  steps: (r) => {
    // Three steps up and back down: a pyramid of slabs, a small mountain for a 6.5 cm wheel.
    const w = between(r, 70, 110), parts: PartCm[] = [];
    for (let k = 0; k < 3; k += 1) parts.push(box(0, 0, w - k * 16, 70 - k * 20, 0, 4.5 * (k + 1), COLORS.concrete, 0, "step"));
    return parts;
  },
  planter: () => [box(0, 0, 100, 40, 0, 45, COLORS.brick, 0, "planter"), cyl(0, 0, 32, 45, 90, COLORS.leaf, "planting", "foliage")],
  wall: (r) => [box(0, 0, between(r, 150, 260), 9, 0, 130, COLORS.wall, 0, "partition wall")],
  pallet: () => [...[-1, 0, 1].map((k) => box(0, k * 38, 120, 10, 6, 14, COLORS.pine, 0, "pallet slat")), ...[-1, 0, 1].map((k) => box(k * 52, 0, 12, 100, 0, 6, COLORS.pine, 0, "pallet runner"))],
};

/** Smallest circle (about the prop's origin) that holds all its parts, in px. */
export function boundingRadiusPx(parts: readonly PropPart[], ox: number, oy: number): number {
  let r = 1;
  for (const p of parts) r = Math.max(r, Math.hypot(p.x - ox, p.y - oy) + (p.shape === "cyl" ? p.halfLength : Math.hypot(p.halfLength, p.halfWidth)));
  return r;
}

/** Put a prop in the world at pixel position (x, y) rotated by `yaw`. */
export function placeProp(name: PropName, random: Random, x: number, y: number, yaw: number, label: string = name): Obstacle {
  const local = PROP_MAKERS[name](random), cos = Math.cos(yaw), sin = Math.sin(yaw), k = 1 / CM_PER_PIXEL;
  const parts: PropPart[] = local.map((p) => {
    const lx = p.x * k, ly = p.y * k;
    return {
      shape: p.shape, x: x + lx * cos - ly * sin, y: y + lx * sin + ly * cos, heading: (p.h ?? 0) + yaw,
      halfLength: (p.shape === "cyl" ? p.l : p.l / 2) * k, halfWidth: (p.shape === "cyl" ? p.l : p.w / 2) * k,
      z0: p.z0 * k, z1: p.z1 * k, color: p.c, sonarSurface: p.s, name: p.n,
    };
  });
  const height = Math.max(...parts.map((p) => p.z1));
  // The footprint that matters for placement is what is near the floor; a canopy overhead does not block a path.
  const low = parts.filter((p) => p.z0 < 14);
  return { kind: "prop", x, y, radius: boundingRadiusPx(low.length ? low : parts, x, y), height, tone: random(), parts, label };
}
