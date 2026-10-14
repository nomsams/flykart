// The evolved habitats (lawn, pavement beside a road, flat) as objects of the 3D robot habitat.
//
// FlyKart Evolve builds scenes from parts at real heights, in world pixels. The habitat is metres and Three.js.
// This file converts one into the other so a place the brain was bred in can be driven in 3D, through the same
// camera the ESP32-CAM would have, with the same legs, feet, branches and floors.
import { CM_PER_PIXEL } from "../vision/robot";
import type { WorldDef } from "../vision/world/world";
import type { PropPart } from "../vision/world/objects";
import { generateHabitat, type HabitatKind } from "../evolve/habitats";
import { makeObject, type ObjectPart, type WorldObject } from "./model";

const M = CM_PER_PIXEL / 100;
const hex = (c: [number, number, number] | undefined, fallback = 0x9a9a9a): number => (c ? (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255) : fallback);
const FLOOR_HEX: Record<string, number> = { grass: 0x4f9a4a, sand: 0xd8c48a, mud: 0x7b5b38, water: 0x2f78b8, asphalt: 0x44474c, pavement: 0xb4b3ad, parquet: 0xc99a63, tile: 0x4a4d52, carpet: 0x9c5f58 };
export const HABITAT_FLOOR: Record<HabitatKind, string> = { lawn: "#4f9a4a", street: "#b4b3ad", apartment: "#c99a63" };

function convert(p: PropPart, ox: number, oy: number): ObjectPart {
  const round = p.shape === "cyl";
  return {
    shape: p.shape, x: (p.x - ox) * M, z: (p.y - oy) * M, yaw: p.heading ?? 0,
    width: p.halfLength * 2 * M, depth: (round ? p.halfLength * 2 : p.halfWidth * 2) * M,
    bottom: p.z0 * M, top: p.z1 * M, colour: hex(p.color), ...(p.sonarSurface ? { surface: p.sonarSurface } : {}), ...(p.name ? { name: p.name } : {}),
  };
}

let counter = 0;
const nextId = (): string => `habitat-${Date.now().toString(36)}-${counter++}`;

/** All the objects of a generated world, positioned in metres (the floor is 7 m square, centred on the origin). */
export function habitatObjects(world: WorldDef): WorldObject[] {
  const out: WorldObject[] = [];
  const add = (o: WorldObject): void => { out.push(o); };
  // Floor zones and patches first, as flat patches.
  for (const z of world.zones ?? []) {
    const w = (z.x1 - z.x0) * M, d = (z.y1 - z.y0) * M, cx = ((z.x0 + z.x1) / 2) * M, cz = ((z.y0 + z.y1) / 2) * M;
    add({ id: nextId(), kind: "floor", x: cx, z: cz, yaw: 0, width: Math.min(8, w), depth: Math.min(8, d), height: 0.002, parts: [{ shape: "box", x: 0, z: 0, yaw: 0, width: w, depth: d, bottom: 0, top: 0.002, colour: FLOOR_HEX[z.kind], name: `${z.kind} floor` }] });
  }
  for (const p of world.patches) {
    if (p.kind === "water") { const o = makeObject("water", p.x * M, p.y * M); add({ ...o, id: nextId(), width: p.radius * 2 * M, depth: p.radius * 2 * M }); continue; }
    add({ id: nextId(), kind: "floor", x: p.x * M, z: p.y * M, yaw: 0, width: p.radius * 2 * M, depth: p.radius * 2 * M, height: 0.002, parts: [{ shape: "cyl", x: 0, z: 0, yaw: 0, width: p.radius * 2 * M, depth: p.radius * 2 * M, bottom: 0, top: 0.002, colour: FLOOR_HEX[p.kind], name: `${p.kind} patch` }] });
  }
  for (const o of world.obstacles) {
    if (o.parts) {
      const parts = o.parts.map((p) => convert(p, o.x, o.y));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
      for (const q of parts) { const r = Math.hypot(q.width, q.depth) / 2; x0 = Math.min(x0, q.x - r); x1 = Math.max(x1, q.x + r); z0 = Math.min(z0, q.z - r); z1 = Math.max(z1, q.z + r); top = Math.max(top, q.top); }
      add({ id: nextId(), kind: "prop", x: o.x * M, z: o.y * M, yaw: 0, width: Math.min(8, Math.max(0.05, x1 - x0)), depth: Math.min(8, Math.max(0.05, z1 - z0)), height: Math.min(4, Math.max(0.01, top)), parts });
      continue;
    }
    const x = o.x * M, z = o.y * M;
    if (o.kind === "tree") add({ ...makeObject("tree", x, z), id: nextId() });
    else if (o.kind === "rock") add({ ...makeObject("rock", x, z), id: nextId(), width: o.radius * 2 * M, depth: o.radius * 2 * M, height: o.height * M });
    else if (o.kind === "shoe") add({ ...makeObject("shoe", x, z), id: nextId(), yaw: o.tone * 3 });
    else if (o.kind === "cable") add({ ...makeObject("cable", x, z), id: nextId(), yaw: o.tone * 3 });
    else if (o.kind === "mat") add({ ...makeObject("doormat", x, z), id: nextId() });
    else add({ ...makeObject("block", x, z), id: nextId(), width: o.radius * 2 * M, depth: o.radius * 2 * M, height: Math.max(0.05, o.height * M) });
  }
  // The boundary: a wall for a flat, a kerb for a street, a low fence for a garden.
  const h = world.half * M, style = world.boundary ?? "fence", top = style === "wall" ? 0.9 : style === "kerb" ? 0.12 : 0.11, t = 0.09;
  const colour = style === "wall" ? 0xece9df : style === "kerb" ? 0xc2c2bc : 0xe6e6dc;
  const side = (x: number, z: number, w: number, d: number): ObjectPart => ({ shape: "box", x, z, yaw: 0, width: w, depth: d, bottom: 0, top, colour, name: `${style} boundary` });
  add({ id: nextId(), kind: "prop", x: 0, z: 0, yaw: 0, width: 7, depth: 7, height: top, parts: [side(0, -h - t / 2, 2 * h + 2 * t, t), side(0, h + t / 2, 2 * h + 2 * t, t), side(-h - t / 2, 0, t, 2 * h), side(h + t / 2, 0, t, 2 * h)] });
  return out;
}

export function habitatPreset(kind: HabitatKind, seed = 1, difficulty = 0.5): WorldObject[] {
  return habitatObjects(generateHabitat(kind, seed, difficulty));
}
