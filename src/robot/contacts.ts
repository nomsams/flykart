import type { Solid, WorldObject } from "./model";
import { naturalGeometry, naturalShapes } from "./natural-shapes";

export type Point = { x: number; z: number };
type Vertex = Point & { y: number };
export type ContactPart = { objectId: string; kind: WorldObject["kind"]; part: string; polygon: Point[]; bottom: number; top: number };
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

/** Convex projection of the actual mesh clipped to the robot's vertical slab. */
export function convexHull(points: Point[]): Point[] {
  const unique = new Map<string, Point>();
  for (const p of points) unique.set(`${Math.round(p.x * 1e9)},${Math.round(p.z * 1e9)}`, p);
  const sorted = [...unique.values()].sort((a, b) => a.x - b.x || a.z - b.z);
  if (sorted.length < 3) return [];
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of sorted) { while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 1e-12) lower.pop(); lower.push(p); }
  for (const p of sorted.slice().reverse()) { while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 1e-12) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop(); return lower.concat(upper);
}

export function rectangle(s: Pick<Solid, "x" | "z" | "yaw" | "width" | "depth">): Point[] {
  const c = Math.cos(s.yaw), t = Math.sin(s.yaw);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => ({ x: s.x + x * s.width / 2 * c - z * s.depth / 2 * t, z: s.z + x * s.width / 2 * t + z * s.depth / 2 * c }));
}

/** SAT for convex footprints. Touching without penetration is not contact. */
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length], dx = -(q.z - p.z), dz = q.x - p.x;
    if (Math.hypot(dx, dz) < 1e-12) continue;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const v of a) { const d = v.x * dx + v.z * dz; amin = Math.min(amin, d); amax = Math.max(amax, d); }
    for (const v of b) { const d = v.x * dx + v.z * dz; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
    if (amax <= bmin + 1e-10 || bmax <= amin + 1e-10) return false;
  }
  return true;
}

function clippedProjection(vertices: Vertex[], triangles: number[], bottom: number, top: number): Point[] {
  const points: Point[] = vertices.filter(v => v.y >= bottom && v.y <= top).map(v => ({ x: v.x, z: v.z }));
  for (let i = 0; i < triangles.length; i += 3) for (let edge = 0; edge < 3; edge++) {
    const a = vertices[triangles[i + edge]], b = vertices[triangles[i + (edge + 1) % 3]];
    for (const height of [bottom, top]) if ((a.y < height && b.y > height) || (b.y < height && a.y > height)) {
      const t = (height - a.y) / (b.y - a.y); points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return convexHull(points);
}

// Bounded cache invalidates when an inspector edit changes any shape dimension.
const cache = new Map<string, { key: string; parts: ContactPart[] }>();
export function contactParts(o: WorldObject, solids: Solid[], robotTop: number): ContactPart[] {
  const key = `${o.kind}/${o.x}/${o.z}/${o.yaw}/${o.width}/${o.depth}/${o.height}/${robotTop}`;
  const existing = cache.get(o.id); if (existing?.key === key) return existing.parts;
  const shapes = naturalShapes(o), parts: ContactPart[] = [];
  if (shapes.length) {
    for (const shape of shapes) {
      if (!shape.collidable) continue;
      const geometry = naturalGeometry(shape), positions = geometry.getAttribute("position"), vertices: Vertex[] = [];
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i) * shape.scale[0], z = positions.getZ(i) * shape.scale[2];
        vertices.push({ x: o.x + x * c - z * s, z: o.z + x * s + z * c, y: shape.centreY + positions.getY(i) * shape.scale[1] });
      }
      const bottom = Math.min(...vertices.map(v => v.y)), top = Math.max(...vertices.map(v => v.y));
      if (bottom < robotTop && top > 0) {
        const indices = geometry.index ? Array.from(geometry.index.array) : vertices.map((_, i) => i);
        const polygon = clippedProjection(vertices, indices, 0, robotTop);
        if (polygon.length >= 3) parts.push({ objectId: o.id, kind: o.kind, part: shape.part, polygon, bottom: Math.max(0, bottom), top: Math.min(robotTop, top) });
      }
      geometry.dispose();
    }
  } else {
    for (const [i, solid] of solids.entries()) if (solid.bottom < robotTop && solid.top > 0) {
      const furniture = ["table", "chair", "bed"].includes(o.kind);
      const part = !furniture ? `${o.kind} body` : i === 0 ? o.kind === "table" ? "tabletop underside" : o.kind === "bed" ? "bed frame underside" : "chair seat" : i < 5 ? `${o.kind} leg ${i}` : o.kind === "bed" ? i === 5 ? "bed mattress" : "bed headboard" : "chair back";
      parts.push({ objectId: o.id, kind: o.kind, part, polygon: rectangle(solid), bottom: Math.max(0, solid.bottom), top: Math.min(robotTop, solid.top) });
    }
  }
  if (cache.size >= 256 && !cache.has(o.id)) cache.delete(cache.keys().next().value!);
  cache.set(o.id, { key, parts }); return parts;
}
