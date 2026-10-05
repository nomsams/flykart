// Canvas drawing for FlyKart Vision. Everything here only reads state; nothing mutates a simulation.
import { Car, TrackDefinition, trackCheckpoint } from "../../core";
import { CameraConfig, frameToRgba } from "../camera";
import type { Domain } from "../domain";
import { SECTORS, SECTOR_ANGLES, WorldDef, WorldKart } from "../world/world";

export const COLORS = { truth: "#f2f6fc", camera: "#72b8ff", fused: "#7cf0b6", memory: "#c4a2ff", feeling: "#f3c96b", grid: "#243245", text: "#9fb0c6", dim: "#5d6b80", bad: "#ff8c8c" };

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.dataset.w ? Number(canvas.dataset.w) : canvas.width; const height = canvas.dataset.h ? Number(canvas.dataset.h) : canvas.height;
  if (!canvas.dataset.w) { canvas.dataset.w = String(width); canvas.dataset.h = String(height); }
  if (canvas.width !== width * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
  const context = canvas.getContext("2d")!; context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

/* ------------------------------ camera view ------------------------------ */

const eyeBuffers = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
export function drawEye(canvas: HTMLCanvasElement, frame: Float32Array, config: CameraConfig, overlay?: (context: CanvasRenderingContext2D, scale: number) => void): void {
  let small = eyeBuffers.get(canvas);
  if (!small) { small = document.createElement("canvas"); small.width = config.width; small.height = config.height; eyeBuffers.set(canvas, small); }
  const context = canvas.getContext("2d")!; const smallContext = small.getContext("2d")!;
  const image = new ImageData(frameToRgba(frame, config) as unknown as Uint8ClampedArray<ArrayBuffer>, config.width, config.height);
  smallContext.putImageData(image, 0, 0);
  context.imageSmoothingEnabled = false; context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(small, 0, 0, canvas.width, canvas.height);
  overlay?.(context, canvas.width / config.width);
}

/* ------------------------------ top views ------------------------------ */
export const GHOST_COLORS=['#ffd166','#83d5ff','#caa5ff','#7cf0b6','#ff87a7','#ffb36b'];
export type MapGhost={x:number;y:number;heading:number;trail?:{x:number;y:number}[];label:string;color:string};
function drawCrayon(c:CanvasRenderingContext2D,points:{x:number;y:number}[],color:string):void{
  if(points.length<2)return;c.save();c.lineCap='round';c.lineJoin='round';c.strokeStyle=color;c.globalAlpha=.25;c.lineWidth=6;c.beginPath();points.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.stroke();c.globalAlpha=.65;c.lineWidth=1.5;c.stroke();c.restore();
}
function drawGhosts(c:CanvasRenderingContext2D,ghosts:MapGhost[]):void{
  ghosts.forEach(g=>{if(g.trail)drawCrayon(c,g.trail,g.color);c.save();c.globalAlpha=.8;carShapes(c,g,24,14,g.color,'#ffffff');c.fillStyle=g.color;c.font='bold 13px system-ui';c.fillText(g.label,g.x+14,g.y-10);c.restore();});
}


/** What the top views need to show of the sonar: where it points, how far it heard, and whether it is switched on. */
export type SonarView = { x: number; y: number; heading: number; rangePx: number; echo: boolean; on: boolean; beamDeg?:number };

/** The HC-SR04's beam: a narrow amber wedge (about 15 degrees wide) with an arc where the echo came back. */
function drawSonarBeam(context: CanvasRenderingContext2D, sonar: SonarView, reach = 230): void {
  const half = ((sonar.beamDeg ?? 15) * Math.PI) / 360;
  const grad = context.createRadialGradient(sonar.x, sonar.y, 2, sonar.x, sonar.y, reach);
  grad.addColorStop(0, sonar.on ? "rgba(255,176,64,.42)" : "rgba(160,160,160,.16)"); grad.addColorStop(1, "rgba(255,176,64,0)");
  context.fillStyle = grad; context.beginPath(); context.moveTo(sonar.x, sonar.y); context.arc(sonar.x, sonar.y, reach, sonar.heading - half, sonar.heading + half); context.closePath(); context.fill();
  if (sonar.on && sonar.echo) {
    context.strokeStyle = "#ffb040"; context.lineWidth = 2.4; context.beginPath(); context.arc(sonar.x, sonar.y, Math.max(3, sonar.rangePx), sonar.heading - half, sonar.heading + half); context.stroke();
  }
}

const carShapes = (context: CanvasRenderingContext2D, car: { x: number; y: number; heading: number }, length: number, width: number, color: string, outline?: string): void => {
  context.save(); context.translate(car.x, car.y); context.rotate(car.heading);
  context.fillStyle = color; context.beginPath(); context.roundRect(-length / 2, -width / 2, length, width, 3); context.fill();
  context.fillStyle = "rgba(10,16,24,.55)"; context.fillRect(length * 0.05, -width / 2 + 1.5, length * 0.22, width - 3);
  if (outline) { context.strokeStyle = outline; context.lineWidth = 1.2; context.stroke(); }
  context.restore();
};

export function drawTrackMap(canvas: HTMLCanvasElement, route: TrackDefinition, car: Car, others: Car[], hfov: number, extras: { nextGate?: { x: number; y: number }; label?: string; sonar?: SonarView | null;checkpointCount?:number;ghosts?:MapGhost[] } = {}): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H); context.fillStyle = "#0b1117"; context.fillRect(0, 0, W, H);
  const scale = Math.min(W / 780, H / 500); context.save(); context.translate(W / 2, H / 2); context.scale(scale, scale);
  const path = () => { context.beginPath(); route.points.forEach((p, i) => (i === 0 ? context.moveTo(p.x, p.y) : context.lineTo(p.x, p.y))); context.closePath(); };
  context.lineJoin = "round"; context.lineCap = "round";
  path(); context.strokeStyle = "#5a6b82"; context.lineWidth = route.width + 5; context.stroke();
  path(); context.strokeStyle = "#313846"; context.lineWidth = route.width - 1; context.stroke();
  path(); context.strokeStyle = "rgba(235,238,245,.28)"; context.lineWidth = 1.5; context.setLineDash([9, 11]); context.stroke(); context.setLineDash([]);
  for (let i = 0; i < (extras.checkpointCount??8); i += 1) {
    const gate = trackCheckpoint(i, route, extras.checkpointCount??8); const half = route.width / 2;
    context.strokeStyle = i === 0 ? "#f2f6fc" : "rgba(243,201,107,.7)"; context.lineWidth = i === 0 ? 4 : 2.2; context.setLineDash(i === 0 ? [5, 5] : []);
    context.beginPath(); context.moveTo(gate.point.x - gate.normal.x * half, gate.point.y - gate.normal.y * half); context.lineTo(gate.point.x + gate.normal.x * half, gate.point.y + gate.normal.y * half); context.stroke(); context.setLineDash([]);
  }
  for (const other of others) {
    if (other === car) continue;
    if (other.isObstacle && other.obstacleKind === "oil") { context.fillStyle = "rgba(80,56,140,.75)"; context.beginPath(); context.ellipse(other.position.x, other.position.y, 28, 20, other.heading, 0, Math.PI * 2); context.fill(); continue; }
    if (other.isObstacle && other.obstacleKind === "cone") { context.fillStyle = "#f08b47"; context.beginPath(); context.arc(other.position.x, other.position.y, 5.5, 0, Math.PI * 2); context.fill(); context.strokeStyle = "#fff"; context.lineWidth = 1.4; context.stroke(); continue; }
    if (other.isObstacle && other.obstacleKind === 'bush') { context.fillStyle=other.color;context.beginPath();context.arc(other.position.x,other.position.y,12,0,Math.PI*2);context.fill();continue; }
    if (other.isObstacle && (other.obstacleKind === "barrier" || other.obstacleKind === 'wall')) { carShapes(context, { x: other.position.x, y: other.position.y, heading: other.heading + Math.PI / 2 }, 38, 8, other.color); continue; }
    carShapes(context, { x: other.position.x, y: other.position.y, heading: other.heading }, 24, 14, other.isObstacle ? "#d07c72" : other.color, "rgba(0,0,0,.4)");
  }
  // The camera's view cone.
  const cone = context.createRadialGradient(car.position.x, car.position.y, 4, car.position.x, car.position.y, 190);
  cone.addColorStop(0, "rgba(114,184,255,.30)"); cone.addColorStop(1, "rgba(114,184,255,0)");
  context.fillStyle = cone; context.beginPath(); context.moveTo(car.position.x, car.position.y); context.arc(car.position.x, car.position.y, 190, car.heading - hfov / 2, car.heading + hfov / 2); context.closePath(); context.fill();
  if (extras.sonar) drawSonarBeam(context, extras.sonar);
  if (extras.nextGate) { context.strokeStyle = "rgba(243,201,107,.55)"; context.setLineDash([3, 5]); context.lineWidth = 1.2; context.beginPath(); context.moveTo(car.position.x, car.position.y); context.lineTo(extras.nextGate.x, extras.nextGate.y); context.stroke(); context.setLineDash([]); }
  if (car.trail.length > 1) { context.strokeStyle = "rgba(255,209,102,.4)"; context.lineWidth = 2; context.beginPath(); car.trail.forEach((p, i) => (i === 0 ? context.moveTo(p.x, p.y) : context.lineTo(p.x, p.y))); context.stroke(); }
  carShapes(context, { x: car.position.x, y: car.position.y, heading: car.heading }, 24, 14, "#ffd166", "#fff6d6");
  drawGhosts(context,extras.ghosts??[]);
  context.restore();
  if (extras.label) { context.fillStyle = COLORS.text; context.font = "600 12px system-ui, sans-serif"; context.fillText(extras.label, 14, H - 14); }
}

export function drawWorldMap(canvas: HTMLCanvasElement, world: WorldDef, kart: WorldKart, goal: { x: number; y: number }, scan: { truth: ArrayLike<number>; seen: ArrayLike<number> | null; sigma: ArrayLike<number> | null }, label: string, sonar: SonarView | null = null,extras:{trail?:{x:number;y:number}[];ghosts?:MapGhost[]}={}): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H); context.fillStyle = "#0b1117"; context.fillRect(0, 0, W, H);
  const scale = Math.min(W, H) / (world.half * 2 + 36); context.save(); context.translate(W / 2, H / 2); context.scale(scale, scale);
  context.fillStyle = "#1d3a2a"; context.fillRect(-world.half, -world.half, world.half * 2, world.half * 2);
  for (const patch of world.patches) {
    context.fillStyle = patch.kind === "water" ? "#2f78b8" : patch.kind === "sand" ? "#8e7e55" : "#5b4430";
    context.beginPath(); context.arc(patch.x, patch.y, patch.radius, 0, Math.PI * 2); context.fill();
  }
  context.strokeStyle = "#e8eef8"; context.lineWidth = 3; context.strokeRect(-world.half, -world.half, world.half * 2, world.half * 2);
  for (const o of world.obstacles) { context.fillStyle = o.kind === "tree" ? "#2f8f4a" : "#8a8f98"; context.beginPath(); context.arc(o.x, o.y, o.radius, 0, Math.PI * 2); context.fill(); }
  context.strokeStyle = "#ffd23f"; context.lineWidth = 3; context.beginPath(); context.arc(goal.x, goal.y, 22, 0, Math.PI * 2); context.stroke();
  context.fillStyle = "#ff3f9f"; context.beginPath(); context.arc(goal.x, goal.y, 6, 0, Math.PI * 2); context.fill();
  // Clearance sectors: white = truth, blue = what the camera believes.
  const range = 220; const step = (SECTOR_ANGLES[1] - SECTOR_ANGLES[0]);
  for (let k = 0; k < SECTORS; k += 1) {
    const centre = kart.heading + SECTOR_ANGLES[k];
    const draw = (blocked: number, color: string, width: number): void => {
      const r = Math.max(4, range * (1 - Math.max(0, Math.min(1, blocked))));
      context.strokeStyle = color; context.lineWidth = width; context.beginPath(); context.arc(kart.x, kart.y, r, centre - step * 0.42, centre + step * 0.42); context.stroke();
    };
    draw(scan.truth[k], "rgba(242,246,252,.55)", 2);
    if (scan.seen) draw(scan.seen[k], COLORS.camera, 3);
  }
  if(extras.trail)drawCrayon(context,extras.trail,"#ffc475");
  if (sonar) drawSonarBeam(context, sonar);
  carShapes(context, { x: kart.x, y: kart.y, heading: kart.heading }, 24, 14, "#ffd166", "#fff6d6");
  drawGhosts(context,extras.ghosts??[]);
  context.restore();
  context.fillStyle = COLORS.text; context.font = "600 12px system-ui, sans-serif"; context.fillText(label, 14, H - 14);
}

/* ------------------------------ estimate bars ------------------------------ */

export type EstimateRow = {
  label: string; truth: number; mean: number | null; sigma: number | null; fused: number; memory?: number | null;
  /** Share of precision from [camera, feeling, memory]. */
  shares?: [number, number, number];
};

/** One row per estimate: where the truth is, where the camera thinks it is (±2σ), what the controller used, and who was trusted. */
export function drawEstimates(canvas: HTMLCanvasElement, rows: EstimateRow[], range: [number, number] = [-1, 1]): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H);
  const rowH = Math.min(26, (H - 8) / rows.length); const left = 150, right = W - 110, span = right - left;
  const x = (value: number) => left + ((Math.max(range[0], Math.min(range[1], value)) - range[0]) / (range[1] - range[0])) * span;
  context.font = "11px system-ui, sans-serif"; context.textBaseline = "middle";
  rows.forEach((row, i) => {
    const y = 4 + i * rowH + rowH / 2;
    if (i % 2 === 0) { context.fillStyle = "rgba(255,255,255,.025)"; context.fillRect(0, y - rowH / 2, W, rowH); }
    context.fillStyle = COLORS.text; context.textAlign = "left"; context.fillText(row.label, 10, y);
    context.strokeStyle = COLORS.grid; context.lineWidth = 1; context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
    context.beginPath(); context.moveTo(x(0), y - 5); context.lineTo(x(0), y + 5); context.stroke();
    if (row.mean !== null && row.sigma !== null) {
      const lo = x(row.mean - 2 * row.sigma), hi = x(row.mean + 2 * row.sigma);
      context.strokeStyle = COLORS.camera; context.globalAlpha = 0.55; context.lineWidth = 5; context.lineCap = "butt"; context.beginPath(); context.moveTo(lo, y); context.lineTo(Math.max(hi, lo + 1), y); context.stroke(); context.globalAlpha = 1;
      context.fillStyle = COLORS.camera; context.beginPath(); context.arc(x(row.mean), y, 3.2, 0, Math.PI * 2); context.fill();
    }
    if (row.memory !== undefined && row.memory !== null) { context.fillStyle = COLORS.memory; context.save(); context.translate(x(row.memory), y); context.rotate(Math.PI / 4); context.fillRect(-3, -3, 6, 6); context.restore(); }
    context.fillStyle = COLORS.fused; context.beginPath(); context.arc(x(row.fused), y, 2.4, 0, Math.PI * 2); context.fill();
    context.strokeStyle = COLORS.truth; context.lineWidth = 2; context.beginPath(); context.moveTo(x(row.truth), y - 7); context.lineTo(x(row.truth), y + 7); context.stroke();
    context.fillStyle = COLORS.dim; context.textAlign = "right"; context.fillText(row.truth.toFixed(2), right + 44, y);
    if (row.shares) {
      const bx = right + 52, bw = 50; let at = bx; const colors = [COLORS.camera, COLORS.feeling, COLORS.memory];
      context.fillStyle = "rgba(255,255,255,.06)"; context.fillRect(bx, y - 4, bw, 8);
      row.shares.forEach((share, k) => { context.fillStyle = colors[k]; context.fillRect(at, y - 4, share * bw, 8); at += share * bw; });
    }
  });
}

/* ------------------------------ controller activity ------------------------------ */

const flash = new Float32Array(48);
export function drawBrain(canvas: HTMLCanvasElement, spikes: ArrayLike<number> | null, readouts: ArrayLike<number> | null): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H);
  const cols = 8, cell = 20, ox = 8, oy = 12;
  for (let n = 0; n < 48; n += 1) {
    if (spikes && spikes[n]) flash[n] = 1; else flash[n] *= 0.82;
    const cx = ox + (n % cols) * cell + cell / 2, cy = oy + Math.floor(n / cols) * cell + cell / 2;
    context.fillStyle = `rgba(124,240,182,${0.1 + 0.9 * flash[n]})`; context.beginPath(); context.arc(cx, cy, 6.8, 0, Math.PI * 2); context.fill();
  }
  const labels = ["steer", "gas", "brake", "reverse"]; const bx = 218, bw = 56;
  context.font = "10px system-ui, sans-serif"; context.textBaseline = "middle";
  labels.forEach((label, k) => {
    const y = 20 + k * 30; const value = readouts ? readouts[k] : 0;
    context.fillStyle = COLORS.text; context.textAlign = "right"; context.fillText(label, bx - 6, y);
    context.fillStyle = "rgba(255,255,255,.07)"; context.fillRect(bx, y - 5, bw, 10);
    context.fillStyle = k === 0 ? COLORS.camera : k === 1 ? COLORS.fused : k === 2 ? COLORS.bad : COLORS.memory;
    if (k === 0) { context.fillRect(bx + bw / 2, y - 5, (value * bw) / 2, 10); context.fillStyle = COLORS.dim; context.fillRect(bx + bw / 2 - 0.5, y - 7, 1, 14); }
    else context.fillRect(bx, y - 5, Math.max(0, Math.min(1, value)) * bw, 10);
  });
  context.textAlign = "left"; context.fillStyle = COLORS.dim; context.fillText("48 spiking neurons · 4 leaky readouts", 10, H - 14);
}

/* ------------------------------ lap memory ------------------------------ */

export function drawKenyon(canvas: HTMLCanvasElement, cellsOnThisGate: number[], active: Set<number>, taught: (j: number) => boolean, position: (j: number) => number, enabled: boolean): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H);
  if (!enabled) { context.fillStyle = COLORS.dim; context.font = "12px system-ui, sans-serif"; context.fillText("Lap memory is off.", 12, 24); return; }
  const n = cellsOnThisGate.length; const cols = Math.ceil(Math.sqrt(n * (W / H))); const rows = Math.ceil(n / cols); const cw = (W - 16) / cols, ch = (H - 16) / rows;
  const ordered = [...cellsOnThisGate].sort((a, b) => position(a) - position(b));
  ordered.forEach((j, i) => {
    const x = 8 + (i % cols) * cw, y = 8 + Math.floor(i / cols) * ch;
    context.fillStyle = active.has(j) ? "#f2f6fc" : taught(j) ? "rgba(168,128,255,.7)" : "rgba(255,255,255,.07)";
    context.fillRect(x, y, Math.max(1, cw - 1), Math.max(1, ch - 1));
  });
}

export type TraceSample = { truth: number; camera: number | null; memory: number | null; used: number };
export function drawTrace(canvas: HTMLCanvasElement, samples: TraceSample[], title: string): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H);
  const pad = 22; context.strokeStyle = COLORS.grid; context.lineWidth = 1;
  context.beginPath(); context.moveTo(pad, H / 2); context.lineTo(W - 6, H / 2); context.stroke();
  context.fillStyle = COLORS.dim; context.font = "10px system-ui, sans-serif"; context.fillText(title, pad, 12); context.fillText("0", 8, H / 2 + 3);
  const line = (key: keyof TraceSample, color: string, width: number, alpha = 1) => {
    context.strokeStyle = color; context.lineWidth = width; context.globalAlpha = alpha; context.beginPath(); let started = false;
    samples.forEach((s, i) => { const v = s[key]; if (v === null) { started = false; return; } const x = pad + (i / Math.max(1, 239)) * (W - pad - 6), y = H / 2 - (v as number) * (H / 2 - 22); if (!started) { context.moveTo(x, y); started = true; } else context.lineTo(x, y); });
    context.stroke(); context.globalAlpha = 1;
  };
  line("camera", COLORS.camera, 1.4, 0.8); line("memory", COLORS.memory, 1.6, 0.9); line("used", COLORS.fused, 2); line("truth", COLORS.truth, 1.2, 0.8);
}

export function estimateRows(domain: Domain, truth: ArrayLike<number>, mean: ArrayLike<number> | null, variance: ArrayLike<number> | null, fused: ArrayLike<number>, weights: ArrayLike<number>[] | null, memory?: ArrayLike<number> | null, memoryOn?: boolean): EstimateRow[] {
  return domain.estimateLabels.map((label, c) => ({
    label, truth: truth[c], mean: mean ? mean[c] : null, sigma: variance ? Math.sqrt(variance[c]) : null, fused: fused[c],
    memory: memoryOn && memory && memory[c] !== 0 ? memory[c] : null,
    shares: weights ? [weights[0][c], weights[1][c], weights[2] ? weights[2][c] : 0] : undefined,
  }));
}

/* ------------------------------ sonar trace ------------------------------ */

export type SonarSample = { cm: number; echo: boolean; strength: number };

/**
 * The last few seconds of what the HC-SR04 reported. Each column is one ping: its height is the distance it measured
 * (nearer is lower), its brightness the strength of the echo. Pings that heard nothing show a grey mark; an empty plot is not a missing ping.
 */
export function drawSonarTrace(canvas: HTMLCanvasElement, samples: SonarSample[], on: boolean, maxCm = 400): void {
  const context = fit(canvas); const W = Number(canvas.dataset.w), H = Number(canvas.dataset.h);
  context.clearRect(0, 0, W, H); context.fillStyle = "#0b1117"; context.fillRect(0, 0, W, H);
  const left = 44, right = 8, top = 8, bottom = 22; const plotW = W - left - right, plotH = H - top - bottom;
  context.font = "11px system-ui, sans-serif"; context.fillStyle = COLORS.dim; context.strokeStyle = COLORS.grid; context.lineWidth = 1;
  for (const cm of [0, maxCm/4, maxCm/2, maxCm*3/4, maxCm]) {
    const y = top + plotH * (1 - cm / maxCm); context.beginPath(); context.moveTo(left, y); context.lineTo(W - right, y); context.stroke(); context.fillText(`${cm} cm`, 4, y + 4);
  }
  if (!on) { context.fillStyle = COLORS.dim; context.font = "600 13px system-ui, sans-serif"; context.fillText("sonar switched off", left + 12, top + plotH / 2); return; }
  const columns = 240; const barWidth = plotW / columns; const start = Math.max(0, samples.length - columns);
  for (let i = start; i < samples.length; i += 1) {
    const sample = samples[i]; if (!sample.echo) { context.fillStyle=COLORS.dim;context.fillRect(left+(i-start)*barWidth,top,Math.max(1,barWidth),3);continue; }
    const x = left + (i - start) * barWidth; const height = plotH * Math.min(1, sample.cm / maxCm); const level = Math.min(1, Math.log(Math.max(1, sample.strength)) / Math.log(40));
    context.fillStyle = `rgba(255,${Math.round(150 + 70 * level)},${Math.round(40 + 60 * level)},${0.35 + 0.65 * level})`; context.fillRect(x, top + plotH - height, Math.max(1, barWidth), Math.max(2, height));
  }
  context.fillStyle = COLORS.dim; context.fillText("older", left, H - 6); context.fillText("now", W - right - 24, H - 6);
}
