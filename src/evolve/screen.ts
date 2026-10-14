// Genetic screening: three tiny, cheap tests of known failure modes, run on a candidate before it may breed.
//
// Selection on the main trials is noisy and rewards whatever worked on those six draws. These screens look
// for specific, repeatable defects that the averages hide and that the earlier runs showed:
//   wall    drives into the fence it is facing from 66 px away (no braking reflex, no turn)
//   circle  searches an empty field for 20 s by turning in place or looping in one small patch
//   stuck   is placed in a dead-end pocket and never gets out
// A failed screen does not delete a brain; it is kept out of the breeding pool while a clean one is available.
import { SpikingNetwork, type BrainSnapshot } from "../core";
import { mulberry32 } from "../vision/rng";
import type { WorldDef } from "../vision/world/world";
import { runEpisode } from "./drive";
import { sampleReality } from "./reality";
import type { Scenario } from "./scenario";

export type ScreenKind = "wall" | "circle" | "stuck";
export const SCREENS: ScreenKind[] = ["wall", "circle", "stuck"];
/** Only these keep a brain out of the breeding pool. Getting out of a dead end is reported but not demanded: no brain bred so far does it. */
export const GATING: ScreenKind[] = ["wall", "circle"];
export const SCREEN_LABEL: Record<ScreenKind, string> = {
  wall: "drives into a wall it is facing", circle: "circles or spins in one patch", stuck: "cannot leave a dead end",
};

const HALF = 316;
const open = (): WorldDef => ({ seed: 1, half: HALF, obstacles: [], patches: [], base: "pavement", boundary: "fence", name: "screen" });
const wallBox = (x: number, y: number, hl: number, hw: number, heading = 0) => ({ kind: "prop" as const, x, y, radius: Math.hypot(hl, hw), height: 40, tone: 0.5, parts: [{ shape: "box" as const, x, y, heading, halfLength: hl, halfWidth: hw, z0: 0, z1: 40, color: [0.8, 0.8, 0.78] as [number, number, number] }], label: "screen wall" });

function scenario(kind: ScreenKind): Scenario {
  const base = { spec: { habitat: "lawn" as const, seed: 1, difficulty: 0, goals: 1, minPath: 0, maxPath: 1, maxTicks: 600, empty: true }, kind: "lawn" as const, reachable: 1 };
  if (kind === "wall") return { ...base, spec: { ...base.spec, maxTicks: 270 }, world: open(), start: { x: HALF - 80, y: 0, heading: 0 }, goals: [{ x: -200, y: 0 }] };
  if (kind === "circle") return { ...base, spec: { ...base.spec, maxTicks: 600 }, world: open(), start: { x: -200, y: -150, heading: 0.6 }, goals: [{ x: 260, y: 260 }] };
  // A U-shaped pocket 70 px wide, open behind the kart, with the flag far outside.
  const world = open();
  world.obstacles.push(wallBox(60, -45, 70, 5), wallBox(60, 45, 70, 5), wallBox(130, 0, 5, 45));
  return { ...base, spec: { ...base.spec, maxTicks: 450 }, world, start: { x: 70, y: 0, heading: 0 }, goals: [{ x: -240, y: 180 }] };
}

export type ScreenResult = { kind: ScreenKind; failed: boolean; note: string };

export function runScreen(snapshot: BrainSnapshot, kind: ScreenKind, seed = 11): ScreenResult {
  const brain = SpikingNetwork.fromJSON(snapshot);
  const sc = scenario(kind);
  const reality = sampleReality(mulberry32(seed), 0.6, "command");
  const r = runEpisode(brain, sc, reality, { seed, stallCutoffSeconds: 0 });
  if (kind === "wall") {
    // Facing a fence 66 px ahead at up to 90 px/s: a working brain slows or turns; contact means it did not.
    const failed = r.collisions > 0 || r.crashed;
    return { kind, failed, note: failed ? `${r.collisions} contacts in ${(r.ticks / 30).toFixed(1)} s` : "stopped or turned in time" };
  }
  if (kind === "circle") {
    const revolutions = r.turn / (2 * Math.PI), patch = r.net;
    const failed = r.cells < 6 || (revolutions > 3 && patch < 90) || r.loopSeconds > 6;
    return { kind, failed, note: `${r.cells} new cells, ${revolutions.toFixed(1)} turns, ${patch.toFixed(0)} px net` };
  }
  const escaped = Math.hypot(r.net, 0) > 110 || r.goals > 0;
  return { kind, failed: !escaped, note: escaped ? "left the pocket" : `only ${r.net.toFixed(0)} px from the start after ${(r.ticks / 30).toFixed(0)} s` };
}

export function screenAll(snapshot: BrainSnapshot): ScreenResult[] { return SCREENS.map((k) => runScreen(snapshot, k)); }
