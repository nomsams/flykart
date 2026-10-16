import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, type Sprite } from "../vision/camera";
import { WorldScene } from "../vision/world/worldScene";
import type { WorldDef } from "../vision/world/world";
import { solidsFor, type Solid } from "../robot/model";
import { preset } from "../robot/model";
import { boundaryParts } from "./part-mesh";
import { generateApartment, generateHabitat, type HabitatKind } from "./habitats";

const empty = (half: number, boundary: "fence" | "wall" | "kerb"): WorldDef => ({ seed: 1, half, obstacles: [], patches: [], boundary });

/** Is the point inside this oriented rectangle (centre, heading, length along it, width across)? */
const inside = (px: number, py: number, x: number, y: number, heading: number, length: number, width: number): boolean => {
  const dx = px - x, dy = py - y;
  return Math.abs(dx * Math.cos(heading) + dy * Math.sin(heading)) <= length / 2 + 1e-9 && Math.abs(-dx * Math.sin(heading) + dy * Math.cos(heading)) <= width / 2 + 1e-9;
};

describe("walls meet flush at the corners", () => {
  for (const boundary of ["fence", "wall", "kerb"] as const) {
    for (const half of [316, 300, 250]) {
      it(`closes the open-world ${boundary} all the way round (half ${half})`, () => {
        const scene = new WorldScene(empty(half, boundary), { ...DEFAULT_STYLE }) as unknown as { fixed: Sprite[] };
        const pieces = scene.fixed;
        const thick = pieces[0].width, covered = (x: number, y: number): boolean => pieces.some((s) => inside(x, y, s.x, s.y, s.heading, s.length, s.width));
        const e = 0.05, outer = half + thick / 2 - e;
        // The four outer corners, and every point along the centre line and both faces of every side.
        for (const [cx, cy] of [[-outer, -outer], [outer, -outer], [-outer, outer], [outer, outer]]) expect(covered(cx, cy), `corner ${cx},${cy}`).toBe(true);
        for (let t = -half; t <= half; t += 0.5) for (const off of [-thick / 2 + e, 0, thick / 2 - e]) {
          expect(covered(t, -half + off), `north at ${t}`).toBe(true); expect(covered(t, half + off), `south at ${t}`).toBe(true);
          expect(covered(-half + off, t), `west at ${t}`).toBe(true); expect(covered(half + off, t), `east at ${t}`).toBe(true);
        }
      });
    }
  }

  it("closes the corners of the robot's room, where the walls are .09 m thick", () => {
    const solids: Solid[] = preset("arena").flatMap((o) => (o.kind === "wall" ? solidsFor(o) : []));
    const covered = (x: number, z: number): boolean => solids.some((s) => inside(x, z, s.x, s.z, s.yaw, s.width, s.depth));
    const e = 0.004;
    for (const [x, z] of [[-2.545 + e, -2.345 + e], [2.545 - e, -2.345 + e], [-2.545 + e, 2.345 - e], [2.545 - e, 2.345 - e]]) expect(covered(x, z), `corner ${x},${z}`).toBe(true);
    // The doorway in the south wall is still open.
    expect(covered(0, 2.3)).toBe(false);
  });

  it("closes the corners of the Evolve 3D view", () => {
    for (const style of ["lawn", "street", "apartment"] as HabitatKind[]) {
      const world = generateHabitat(style, 3, 0.5), parts = boundaryParts(world), h = world.half, t = 1.5, e = 0.01;
      expect(parts.length).toBe(4);
      const covered = (x: number, y: number): boolean => parts.some((p) => Math.abs(x - p.x) <= p.halfLength && Math.abs(y - p.y) <= p.halfWidth);
      for (const x of [-(h + t) + e, h + t - e]) for (const y of [-(h + t) + e, h + t - e]) expect(covered(x, y), `${style} corner ${x},${y}`).toBe(true);
      for (let s = -h; s <= h; s += 0.5) for (const off of [-t + e, 0, t - e]) for (const [x, y] of [[s, -h + off], [s, h + off], [-h + off, s], [h + off, s]]) expect(covered(x, y)).toBe(true);
    }
  });
});

describe("apartment partitions", () => {
  it("never start in a doorway: the second partition begins on solid wall", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const world = generateApartment(seed, 0.5);
      const walls = world.obstacles.filter((o) => o.label === "wall" && o.parts?.length).map((o) => ({ ...o.parts![0], cx: o.x, cy: o.y }));
      const vertical = walls.filter((w) => Math.abs(Math.cos(w.heading ?? 0)) < 0.01), horizontal = walls.filter((w) => Math.abs(Math.sin(w.heading ?? 0)) < 0.01);
      expect(vertical.length).toBe(2); expect(horizontal.length).toBe(2);
      const hy = horizontal[0].cy, thick = horizontal[0].halfWidth * 2;
      // The horizontal partition's start is on the vertical one's centre line; some vertical piece must be there to hold it.
      const held = vertical.some((v) => hy >= v.cy - v.halfLength + thick / 2 && hy <= v.cy + v.halfLength - thick / 2);
      expect(held, `seed ${seed}: partition at y=${hy} would hang in the doorway`).toBe(true);
    }
  });
});
