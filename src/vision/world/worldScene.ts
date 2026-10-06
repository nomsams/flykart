// The open world as something a camera can look at.
import { Pose, Rgb, Scene, Sprite, Style } from "../camera";
import { hash2 } from "../rng";
import { GOAL_RADIUS, WorldDef } from "./world";
import { furniture, clearance, legs, floorItem } from './objects';

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

export class WorldScene implements Scene {
  sprites: Sprite[] = [];
  goalRadius=GOAL_RADIUS;
  private readonly fixed: Sprite[] = [];
  private goal: { x: number; y: number } = { x: 0, y: 0 };
  private goals: {x:number;y:number}[] = [];
  private nearPatches: WorldDef["patches"] = [];
  private nearbyFloor:WorldDef["obstacles"]=[];

  constructor(readonly world: WorldDef, public style: Style) {
    const half = world.half;
    for (let side = 0; side < 4; side += 1) {
      for (let at = -half; at <= half; at += 30) {
        const along = at + 15; if (Math.abs(along) > half) continue;
        const x = side === 0 ? along : side === 1 ? half : side === 2 ? along : -half;
        const y = side === 0 ? -half : side === 1 ? along : side === 2 ? half : along;
        const heading = side % 2 === 0 ? 0 : Math.PI / 2;
        this.fixed.push({ x, y, heading, width: 3, length: 30, z0: 0, z1: 11, color: style.kerbB, shape: "wall" });
      }
    }
  }

  private objectSprites():Sprite[]{
    const result:Sprite[]=[],style=this.style;
    for (const o of this.world.obstacles) {
      if(floorItem(o))continue;
      if(furniture(o)){
        const color:Rgb=o.kind==='bed'?[.3,.45,.68]:[.52,.32,.17];
        result.push({x:o.x,y:o.y,heading:0,width:o.radius*1.3,length:o.radius*2,z0:clearance(o),z1:o.height,color,shape:'wall'});
        for(const leg of legs(o))result.push({x:leg.x,y:leg.y,heading:0,width:leg.radius*2,length:leg.radius*2,z0:0,z1:clearance(o),color:[.25,.18,.12],shape:'wall'});
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
    this.sprites = [...this.fixed,...this.objectSprites()].filter((sprite) => (sprite.x - pose.x) ** 2 + (sprite.y - pose.y) ** 2 < range2);
    for(const goal of this.goals.length?this.goals:[this.goal])this.sprites.push({ x: goal.x, y: goal.y, heading: 0, width: 14, length: 14, z0: 0, z1: 46, color: [1, 0.2, 0.62], shape: "flag" });
    this.nearbyFloor=this.world.obstacles.filter(o=>floorItem(o)&&Math.hypot(o.x-pose.x,o.y-pose.y)<o.radius+380);
    this.nearPatches = this.world.patches.filter((p) => Math.hypot(p.x - pose.x, p.y - pose.y) < p.radius + 380);
  }

  ground(x: number, y: number, out: Rgb): void {
    const style = this.style; const half = this.world.half;
    if (Math.abs(x) > half + 6 || Math.abs(y) > half + 6) { const c = scale(style.dirt, 0.55); out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
    let kind: "grass" | "sand" | "mud" | "water" = "grass";
    for (const patch of this.nearPatches) {
      if (Math.hypot(x - patch.x, y - patch.y) < patch.radius) { kind = patch.kind; if (kind === "water") break; }
    }
    let c: Rgb;
    if (kind === "water") { const ripple = 0.5 + 0.5 * Math.sin(x / 8 + y / 11); c = mix(style.water, [0.62, 0.8, 0.92], ripple * 0.25); }
    else if (kind === "sand") c = scale(style.sand, 0.94 + 0.12 * hash2(Math.floor(x / 6), Math.floor(y / 6)));
    else if (kind === "mud") c = scale(style.dirt, 0.62 + 0.14 * hash2(Math.floor(x / 7), Math.floor(y / 7)));
    else { const checker = (Math.floor(x / 26) + Math.floor(y / 26)) % 2 === 0; c = scale(checker ? style.grassA : style.grassB, 0.93 + 0.14 * hash2(Math.floor(x / 5), Math.floor(y / 5))); }
    for(const o of this.nearbyFloor)if(Math.hypot(x-o.x,y-o.y)<o.radius){if(o.kind==='mat')c=[.58,.32,.23];else if(Math.abs(y-o.y-Math.sin((x-o.x)/5)*2)<1.5)c=[.08,.08,.09];}
    // A bright ring on the ground marks the goal.
    if((this.goals.length?this.goals:[this.goal]).some(g=>{const d=Math.hypot(x-g.x,y-g.y);return d<this.goalRadius&&d>this.goalRadius-4.5;}))c = [1, 0.84, 0.2];
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  }
}
