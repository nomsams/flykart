// The open world as something a camera can look at.
import { Pose, Rgb, Scene, Sprite, Style } from "../camera";
import { hash2 } from "../rng";
import { GOAL_RADIUS, Surface, WorldDef } from "./world";
import { furniture, clearance, legs, floorItem } from './objects';

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

/** Floor colours are derived from the randomised palette so that domain randomisation reaches them too. */
export type FloorPalette = Record<"parquet" | "tile" | "pavement" | "asphalt" | "carpet", Rgb>;
export function floorPalette(style: Style): FloorPalette {
  return {
    parquet: mix(style.dirt, [0.86, 0.66, 0.43], 0.55),
    tile: scale(mix(style.asphalt, [0.3, 0.31, 0.33], 0.5), 0.8),
    pavement: mix(style.asphaltWorn, [0.84, 0.83, 0.8], 0.62),
    asphalt: scale(style.asphalt, 0.82),
    carpet: mix(style.dirt, [0.62, 0.36, 0.34], 0.45),
  };
}

/** Colour of a built floor at one point: planks with staggered seams, grouted tile, paving slabs, speckled tarmac. */
export function builtFloor(kind: Surface, palette: FloorPalette, x: number, y: number, out: Rgb): boolean {
  switch (kind) {
    case "parquet": {
      // Boards 9 px (10 cm) wide running along x, 90 px long, staggered per board.
      const board = Math.floor(y / 9), along = x + hash2(board, 7) * 90, seg = Math.floor(along / 90);
      const tone = 0.9 + 0.2 * hash2(seg, board);
      const edge = (((y % 9) + 9) % 9 < 0.7 || (((along % 90) + 90) % 90) < 0.8) ? 0.72 : 1;
      const c = scale(palette.parquet, tone * edge); out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return true;
    }
    case "tile": {
      const gx = ((x % 27) + 27) % 27, gy = ((y % 27) + 27) % 27;
      const grout = gx < 1 || gy < 1;
      const c = scale(palette.tile, grout ? 0.55 : 0.94 + 0.12 * hash2(Math.floor(x / 27), Math.floor(y / 27)));
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return true;
    }
    case "pavement": {
      const gx = ((x % 36) + 36) % 36, gy = ((y % 36) + 36) % 36;
      const c = scale(palette.pavement, gx < 1.2 || gy < 1.2 ? 0.72 : 0.94 + 0.1 * hash2(Math.floor(x / 36), Math.floor(y / 36)));
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return true;
    }
    case "asphalt": {
      const c = scale(palette.asphalt, 0.9 + 0.2 * hash2(Math.floor(x / 3), Math.floor(y / 3)));
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return true;
    }
    case "carpet": {
      const c = scale(palette.carpet, 0.92 + 0.16 * hash2(Math.floor(x / 2), Math.floor(y / 2)));
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return true;
    }
    default: return false;
  }
}

export class WorldScene implements Scene {
  sprites: Sprite[] = [];
  goalRadius=GOAL_RADIUS;
  private readonly fixed: Sprite[] = [];
  private readonly props: Sprite[] = [];
  private readonly palette: FloorPalette;
  private goal: { x: number; y: number } = { x: 0, y: 0 };
  private goals: {x:number;y:number}[] | null = null;
  private nearPatches: WorldDef["patches"] = [];
  private nearbyFloor:WorldDef["obstacles"]=[];

  constructor(readonly world: WorldDef, public style: Style) {
    const half = world.half;
    this.palette = floorPalette(style);
    const boundary = world.boundary ?? "fence";
    const thick = boundary === "fence" ? 3 : boundary === "wall" ? 4 : 6;
    for (let side = 0; side < 4; side += 1) {
      const horizontal = side % 2 === 0, span = horizontal ? 2 * half + thick : 2 * half - thick;
      const pieces = Math.max(1, Math.ceil(span / 30)), length = span / pieces;
      for (let k = 0; k < pieces; k += 1) {
        const along = -span / 2 + length * (k + 0.5);
        const x = side === 0 ? along : side === 1 ? half : side === 2 ? along : -half;
        const y = side === 0 ? -half : side === 1 ? along : side === 2 ? half : along;
        const heading = horizontal ? 0 : Math.PI / 2;
        if (boundary === "fence") this.fixed.push({ x, y, heading, width: thick, length, z0: 0, z1: 11, color: style.kerbB, shape: "wall" });
        else if (boundary === "wall") this.fixed.push({ x, y, heading, width: thick, length, z0: 0, z1: 120, color: mix([0.93, 0.92, 0.88], style.skyHorizon, 0.08), shape: "oriented-box" });
        else this.fixed.push({ x, y, heading, width: thick, length, z0: 0, z1: 11, color: mix(style.asphaltWorn, [0.78, 0.78, 0.76], 0.5), shape: "oriented-box" });
      }
    }
    // Compound props never move, so their boxes are built once.
    for (const o of world.obstacles) if (o.parts) this.props.push(...partSprites(o.parts));
  }

  private objectSprites():Sprite[]{
    const result:Sprite[]=[],style=this.style;
    for (const o of this.world.obstacles) {
      if(o.parts||floorItem(o))continue;
      if(furniture(o)){
        const wood=mix([.5,.31,.17],[.62,.44,.26],o.tone);
        const color:Rgb=o.kind==='bed'?[.3,.45,.68]:wood;
        const lift=clearance(o);
        // A real slab with thickness, resting on four legs; a bed's slab is its mattress on a frame.
        result.push({x:o.x,y:o.y,heading:0,width:o.radius*1.3,length:o.radius*2,z0:lift,z1:o.height,color,shape:'oriented-box'});
        for(const leg of legs(o))result.push({x:leg.x,y:leg.y,heading:0,width:leg.radius*2,length:leg.radius*2,z0:0,z1:lift,color:scale(wood,.7),shape:'oriented-box'});
        continue;
      }
      if (o.kind === "tree") {
        const leaf = mix(scale(style.grassA, 0.55), [0.1, 0.5, 0.18], 0.45); const tint = mix(leaf, [0.28, 0.55, 0.22], o.tone * 0.6);
        result.push({ x: o.x, y: o.y, heading: 0, width: o.radius * 3.1, length: o.radius * 3.1, z0: 0, z1: o.height, color: tint, shape: "tree" });
      } else {
        const stone = mix(style.asphaltWorn, [0.62, 0.6, 0.56], 0.35 + o.tone * 0.4);
        result.push({ x: o.x, y: o.y, heading: 0, width: o.radius * 2, length: o.radius * 2, z0: 0, z1: o.height, color: o.kind==='shoe'?[.62,.23,.12]:stone, shape: "rock" });
      }
    }
    return result;
  }

  setGoal(x: number, y: number): void { this.goal = { x, y }; }
  setGoals(goals:{x:number;y:number}[]):void { this.goals=goals; }

  prepare(pose: Pose): void {
    const range2 = 480 * 480;
    this.sprites = [...this.fixed,...this.props,...this.objectSprites()].filter((sprite) => (sprite.x - pose.x) ** 2 + (sprite.y - pose.y) ** 2 < range2);
    for(const goal of this.goals??[this.goal])this.sprites.push({ x: goal.x, y: goal.y, heading: 0, width: 14, length: 14, z0: 0, z1: 46, color: [1, 0.2, 0.62], shape: "flag" });
    this.nearbyFloor=this.world.obstacles.filter(o=>floorItem(o)&&Math.hypot(o.x-pose.x,o.y-pose.y)<o.radius+380);
    this.nearPatches = this.world.patches.filter((p) => Math.hypot(p.x - pose.x, p.y - pose.y) < p.radius + 380);
  }

  ground(x: number, y: number, out: Rgb): void {
    const style = this.style; const half = this.world.half;
    if (Math.abs(x) > half + 6 || Math.abs(y) > half + 6) { const c = scale(style.dirt, 0.55); out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
    let kind: Surface = this.world.base ?? "grass";
    if (this.world.zones) for (const z of this.world.zones) if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) kind = z.kind;
    for (const patch of this.nearPatches) {
      if (Math.hypot(x - patch.x, y - patch.y) < patch.radius) { kind = patch.kind; if (kind === "water") break; }
    }
    let c: Rgb;
    if (kind === "water") { const ripple = 0.5 + 0.5 * Math.sin(x / 8 + y / 11); c = mix(style.water, [0.62, 0.8, 0.92], ripple * 0.25); }
    else if (kind === "sand") c = scale(style.sand, 0.94 + 0.12 * hash2(Math.floor(x / 6), Math.floor(y / 6)));
    else if (kind === "mud") c = scale(style.dirt, 0.62 + 0.14 * hash2(Math.floor(x / 7), Math.floor(y / 7)));
    else if (kind === "grass") { const checker = (Math.floor(x / 26) + Math.floor(y / 26)) % 2 === 0; c = scale(checker ? style.grassA : style.grassB, 0.93 + 0.14 * hash2(Math.floor(x / 5), Math.floor(y / 5))); }
    else { c = [0, 0, 0]; builtFloor(kind, this.palette, x, y, c); }
    for(const o of this.nearbyFloor)if(Math.hypot(x-o.x,y-o.y)<o.radius){if(o.kind==='mat')c=[.58,.32,.23];else if(Math.abs(y-o.y-Math.sin((x-o.x)/5)*2)<1.5)c=[.08,.08,.09];}
    // A bright ring on the ground marks the goal.
    if((this.goals??[this.goal]).some(g=>{const d=Math.hypot(x-g.x,y-g.y);return d<this.goalRadius&&d>this.goalRadius-4.5;}))c = [1, 0.84, 0.2];
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  }
}

/** Parts as camera prisms. A cylinder is two squares at 45 degrees (an octagon), which is as round as 48 pixels can tell. */
export function partSprites(parts: readonly import("./objects").PropPart[]): Sprite[] {
  const sprites: Sprite[] = [];
  for (const p of parts) {
    const color: Rgb = p.color ?? [0.6, 0.6, 0.6];
    if (p.shape === "box") sprites.push({ x: p.x, y: p.y, heading: p.heading ?? 0, width: p.halfWidth * 2, length: p.halfLength * 2, z0: p.z0, z1: p.z1, color, shape: "oriented-box" });
    else {
      const d = p.halfLength * 2;
      sprites.push({ x: p.x, y: p.y, heading: 0, width: d, length: d, z0: p.z0, z1: p.z1, color, shape: "oriented-box" });
      if (p.halfLength >= 2.5) sprites.push({ x: p.x, y: p.y, heading: Math.PI / 4, width: d * 0.97, length: d * 0.97, z0: p.z0, z1: p.z1 + 0.01, color, shape: "oriented-box" });
    }
  }
  return sprites;
}
