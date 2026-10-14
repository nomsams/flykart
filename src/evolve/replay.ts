// Drawing a habitat from above, and seeing it through the robot's own 48 x 24 camera.
import { DEFAULT_STYLE, frameToRgba, renderFrame } from "../vision/camera";
import { ROBOT_PROFILE } from "../vision/robot";
import type { WorldDef } from "../vision/world/world";
import { WorldScene } from "../vision/world/worldScene";

const FLOOR_COLOR: Record<string, string> = {
  grass: "#4d8f4a", sand: "#d9c58d", mud: "#7a5a37", water: "#3b7fc0", asphalt: "#4a4d52", pavement: "#b9b8b2", parquet: "#c79a62", tile: "#4b4e53", carpet: "#9c5f58",
};
const css = (c: [number, number, number] | undefined, alpha = 1): string => {
  const [r, g, b] = c ?? [0.6, 0.6, 0.6];
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
};

export type TopDownOptions = {
  trace?: number[]; upto?: number; goals?: { x: number; y: number }[]; pose?: { x: number; y: number; heading: number };
  /** Draw parts that are above the robot's body (canopies, tabletops) faded, as the robot can drive beneath them. */
  overhead?: boolean; reached?: number;
};

export function drawTopDown(canvas: HTMLCanvasElement, world: WorldDef, options: TopDownOptions = {}): void {
  const size = canvas.width, scale = size / (world.half * 2), ctx = canvas.getContext("2d")!;
  const sx = (x: number): number => (x + world.half) * scale, sy = (y: number): number => (y + world.half) * scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = FLOOR_COLOR[world.base ?? "grass"]; ctx.fillRect(0, 0, size, canvas.height);
  for (const z of world.zones ?? []) { ctx.fillStyle = FLOOR_COLOR[z.kind]; ctx.fillRect(sx(z.x0), sy(z.y0), (z.x1 - z.x0) * scale, (z.y1 - z.y0) * scale); }
  for (const p of world.patches) { ctx.fillStyle = FLOOR_COLOR[p.kind]; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), p.radius * scale, 0, 6.283); ctx.fill(); }
  // Parts, lowest first, so tall things sit on top of what is under them.
  type Item = { z: number; draw: () => void };
  const items: Item[] = [];
  for (const o of world.obstacles) {
    if (o.parts) {
      for (const p of o.parts) {
        const overhead = p.z0 >= 6, alpha = overhead ? (options.overhead === false ? 0 : 0.42) : 1;
        if (alpha === 0) continue;
        items.push({ z: p.z1, draw: () => {
          ctx.fillStyle = css(p.color, alpha); ctx.strokeStyle = "rgba(0,0,0,.35)";
          if (p.shape === "cyl") { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), Math.max(1, p.halfLength * scale), 0, 6.283); ctx.fill(); if (!overhead) ctx.stroke(); }
          else {
            ctx.save(); ctx.translate(sx(p.x), sy(p.y)); ctx.rotate(p.heading ?? 0);
            const w = p.halfLength * 2 * scale, h = p.halfWidth * 2 * scale;
            ctx.fillRect(-w / 2, -Math.max(1, h) / 2, Math.max(1, w), Math.max(1, h));
            if (!overhead && h > 1.5) ctx.strokeRect(-w / 2, -h / 2, w, h);
            ctx.restore();
          }
        } });
      }
      continue;
    }
    items.push({ z: o.height, draw: () => {
      ctx.fillStyle = o.kind === "tree" ? "#2f7a34" : o.kind === "rock" ? "#9a9a95" : o.kind === "shoe" ? "#c9582e" : o.kind === "cable" ? "#222" : o.kind === "mat" ? "#94594a" : "#9b7342";
      ctx.beginPath(); ctx.arc(sx(o.x), sy(o.y), Math.max(1.5, o.radius * scale), 0, 6.283); ctx.fill();
    } });
  }
  items.sort((a, b) => a.z - b.z).forEach((i) => i.draw());
  // Boundary.
  ctx.strokeStyle = world.boundary === "wall" ? "#f0eee6" : world.boundary === "kerb" ? "#c8c8c2" : "#e9e9e0"; ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.strokeRect(1, 1, size - 2, size - 2);
  if (options.trace && options.trace.length >= 6) {
    const n = Math.min(options.trace.length / 3, options.upto ?? Infinity);
    ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < n; i += 1) { const x = sx(options.trace[i * 3]), y = sy(options.trace[i * 3 + 1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
  }
  (options.goals ?? []).forEach((g, k) => {
    const done = (options.reached ?? 0) > k;
    ctx.strokeStyle = done ? "rgba(255,255,255,.5)" : "#ffd633"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(g.x), sy(g.y), 24 * scale, 0, 6.283); ctx.stroke();
    ctx.fillStyle = done ? "rgba(255,255,255,.6)" : "#ff3399"; ctx.beginPath(); ctx.arc(sx(g.x), sy(g.y), Math.max(3, 5 * scale), 0, 6.283); ctx.fill();
  });
  if (options.pose) {
    const { x, y, heading } = options.pose;
    ctx.save(); ctx.translate(sx(x), sy(y)); ctx.rotate(heading);
    // The camera's field of view and the sonar's lobe.
    ctx.fillStyle = "rgba(255,255,255,.10)"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 150 * scale, -0.907, 0.907); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,200,80,.16)"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 200 * scale, -0.26, 0.26); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#f6f1de"; ctx.strokeStyle = "#101820"; ctx.lineWidth = 1.5;
    ctx.fillRect(-12 * scale, -7 * scale, 24 * scale, 14 * scale); ctx.strokeRect(-12 * scale, -7 * scale, 24 * scale, 14 * scale);
    ctx.fillStyle = "#e0463c"; ctx.fillRect(4 * scale, -3 * scale, 8 * scale, 6 * scale);
    ctx.restore();
  }
}

/** What the robot's own camera sees at a pose, as the same 48 x 24 pixels the controller's eyes get. */
export class CameraView {
  private scene: WorldScene | null = null;
  private readonly frame = new Float32Array(3 * 48 * 24);
  setWorld(world: WorldDef, goals: { x: number; y: number }[]): void {
    this.scene = new WorldScene(world, { ...DEFAULT_STYLE });
    this.scene.setGoals(goals);
  }
  draw(canvas: HTMLCanvasElement, pose: { x: number; y: number; heading: number }): void {
    if (!this.scene) return;
    renderFrame(this.scene, pose, ROBOT_PROFILE.worldCamera, this.frame);
    const small = document.createElement("canvas"); small.width = 48; small.height = 24;
    const sctx = small.getContext("2d")!, image = sctx.createImageData(48, 24);
    frameToRgba(this.frame, ROBOT_PROFILE.worldCamera, image.data);
    sctx.putImageData(image, 0, 0);
    const ctx = canvas.getContext("2d")!; ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  }
}
