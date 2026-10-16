// A trial: a world, where the robot starts, and where the flags are. Flags are always reachable on the floor.
import { mulberry32 } from "../vision/rng";
import { KART_RADIUS, type WorldDef } from "../vision/world/world";
import { HABITAT_HALF, generateHabitat, type HabitatKind } from "./habitats";
import { SolidIndex } from "./solid-index";

export type ScenarioSpec = {
  habitat: HabitatKind | "mixed";
  seed: number;
  /** Clutter, 0 (a few things) to 1 (crowded). */
  difficulty: number;
  /** Flags to find, one after another. */
  goals: number;
  /** Walking distance along reachable floor from the start to the first flag, in px (1 px = 1.1 cm). */
  minPath: number; maxPath: number;
  maxTicks: number;
  /** An empty arena of the habitat's floor: stage 0. */
  empty?: boolean;
  /** Start inside a three-walled pocket that faces away from the way out: the robot has to reverse or turn out of it. */
  pocket?: boolean;
};

export type Scenario = {
  spec: ScenarioSpec; kind: HabitatKind; world: WorldDef;
  start: { x: number; y: number; heading: number };
  goals: { x: number; y: number }[];
  /** Reachable floor, as a fraction of the area. */
  reachable: number;
};

const STEP = 8;
const kinds: HabitatKind[] = ["lawn", "street", "apartment"];

/** Breadth-first walking distance (px) from a start over cells the kart's body fits through. */
const fitGrids = new WeakMap<SolidIndex, Uint8Array>();
/** Which cells the kart's body fits in. Depends only on the world, so each index computes it once. */
function fitGrid(index: SolidIndex, half: number): Uint8Array {
  let free = fitGrids.get(index);
  if (!free) {
    const n = Math.floor((half * 2) / STEP) + 1;
    free = new Uint8Array(n * n);
    for (let cy = 0; cy < n; cy += 1) for (let cx = 0; cx < n; cx += 1) free[cy * n + cx] = index.free(-half + cx * STEP, -half + cy * STEP, KART_RADIUS + 1.5) ? 1 : 0;
    fitGrids.set(index, free);
  }
  return free;
}

function walkingDistance(index: SolidIndex, half: number, sx: number, sy: number): { n: number; dist: Float32Array; free: Uint8Array } {
  const n = Math.floor((half * 2) / STEP) + 1, dist = new Float32Array(n * n).fill(-1), free = fitGrid(index, half);
  const startX = Math.round((sx + half) / STEP), startY = Math.round((sy + half) / STEP);
  const queue = new Int32Array(n * n); let head = 0, tail = 0;
  if (free[startY * n + startX]) { dist[startY * n + startX] = 0; queue[tail++] = startY * n + startX; }
  while (head < tail) {
    const cell = queue[head++], cx = cell % n, cy = Math.floor(cell / n);
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const next = ny * n + nx;
      if (!free[next] || dist[next] >= 0) continue;
      // Do not cut corners between two blocked cells.
      if (dx && dy && (!free[cy * n + nx] || !free[ny * n + cx])) continue;
      dist[next] = dist[cell] + (dx && dy ? STEP * Math.SQRT2 : STEP); queue[tail++] = next;
    }
  }
  return { n, dist, free };
}

const cache = new Map<string, Scenario>();

export function buildScenario(spec: ScenarioSpec): Scenario {
  const key = JSON.stringify(spec), cached = cache.get(key);
  if (cached) return cached;
  const random = mulberry32(spec.seed * 2654435761 + 97);
  const kind: HabitatKind = spec.habitat === "mixed" ? kinds[Math.floor(random() * kinds.length)] : spec.habitat;
  let world = generateHabitat(kind, spec.seed, spec.difficulty);
  if (spec.empty) world = { ...world, obstacles: [], patches: world.patches.filter((p) => p.kind !== "water") };
  const half = world.half ?? HABITAT_HALF;
  const index = new SolidIndex(world, mulberry32(1));
  // Choose a start in the biggest connected area, so a walled-off corner cannot trap or strand the robot.
  let best: { start: { x: number; y: number }; field: ReturnType<typeof walkingDistance>; size: number } | null = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const x = (random() * 2 - 1) * (half - 40), y = (random() * 2 - 1) * (half - 40);
    if (!index.free(x, y, 18)) continue;
    const field = walkingDistance(index, half, x, y);
    let size = 0; for (let i = 0; i < field.dist.length; i += 1) if (field.dist[i] >= 0) size += 1;
    if (!best || size > best.size) best = { start: { x, y }, field, size };
    if (size > field.free.reduce((s, v) => s + v, 0) * 0.85) break;
  }
  if (!best) { // Extremely cluttered: fall back to the centre of the floor, which every habitat keeps open.
    const field = walkingDistance(index, half, 0, 0);
    best = { start: { x: 0, y: 0 }, field, size: 1 };
  }
  // A dead end: walls on three sides of the start, open behind it. Only if the patch is clear, so nothing is cut through.
  let activeIndex = index, activeField = best.field, pocketHeading: number | null = null;
  if (spec.pocket) {
    const heading = mulberry32(spec.seed * 13 + 5)() * 2 * Math.PI - Math.PI, f = [Math.cos(heading), Math.sin(heading)], l = [-f[1], f[0]];
    const at = (a: number, b: number): [number, number] => [best!.start.x + f[0] * a + l[0] * b, best!.start.y + f[1] * a + l[1] * b];
    let clear = true;
    for (let a = -30; a <= 70 && clear; a += 10) for (let b = -50; b <= 50 && clear; b += 10) { const [px, py] = at(a, b); clear = index.free(px, py, 7); }
    if (clear) {
      const part = (cx: number, cy: number, hl: number, hw: number, h: number) => ({ shape: "box" as const, x: cx, y: cy, heading: h, halfLength: hl, halfWidth: hw, z0: 0, z1: 30, color: [0.82, 0.8, 0.76] as [number, number, number], sonarSurface: "smooth" as const, name: "pocket wall" });
      const [bx, by] = at(56, 0), [lx, ly] = at(12, 42), [rx, ry] = at(12, -42);
      const prop = { kind: "prop" as const, x: best.start.x, y: best.start.y, radius: 90, height: 30, tone: 0.5, label: "pocket", parts: [part(bx, by, 42, 4, heading + Math.PI / 2), part(lx, ly, 46, 4, heading), part(rx, ry, 46, 4, heading)] };
      const pocketWorld = { ...world, obstacles: [...world.obstacles, prop] };
      const pocketIndex = new SolidIndex(pocketWorld, mulberry32(1));
      if (pocketIndex.free(best.start.x, best.start.y, 10)) { world = pocketWorld; activeIndex = pocketIndex; activeField = walkingDistance(pocketIndex, half, best.start.x, best.start.y); pocketHeading = heading; }
    }
  }
  const { n, dist } = activeField;
  const goals: { x: number; y: number }[] = [];
  let lo = spec.minPath, hi = spec.maxPath;
  for (let g = 0; g < spec.goals; g += 1) {
    let chosen: { x: number; y: number } | null = null;
    for (let relax = 0; relax < 4 && !chosen; relax += 1) {
      const candidates: { x: number; y: number }[] = [];
      for (let cy = 0; cy < n; cy += 1) for (let cx = 0; cx < n; cx += 1) {
        const d = dist[cy * n + cx];
        if (d < lo * (1 - relax * 0.25) || d > hi * (1 + relax * 0.5)) continue;
        const x = -half + cx * STEP, y = -half + cy * STEP;
        if (!activeIndex.free(x, y, 28)) continue;
        if (goals.some((o) => Math.hypot(o.x - x, o.y - y) < 90)) continue;
        candidates.push({ x, y });
      }
      if (candidates.length) chosen = candidates[Math.floor(random() * candidates.length)];
    }
    if (!chosen) break;
    goals.push(chosen);
    // Later flags are farther along: they are found after the first, anywhere reachable.
    lo = spec.minPath; hi = Math.max(spec.maxPath, half * 2.2);
  }
  if (!goals.length) goals.push({ x: Math.max(-half + 40, Math.min(half - 40, best.start.x + 120)), y: best.start.y });
  const reachable = best.size / Math.max(1, n * n);
  const scenario: Scenario = { spec, kind, world, start: { x: best.start.x, y: best.start.y, heading: pocketHeading ?? (random() * 2 - 1) * Math.PI }, goals, reachable };
  if (cache.size > 400) cache.clear();
  cache.set(key, scenario);
  return scenario;
}
