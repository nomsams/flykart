// Canvas charts for FlyKart Evolve: the racer-style progress plot and the 3D map of generations and local maxima.
import type { Progress } from "./persist";

const STAGE_COLORS = ["#6bd0a0", "#72b8ff", "#f3c96b", "#c4a2ff", "#ff9d7a", "#ff6f91", "#9ad7ff"];
export const stageColor = (stage: number): string => STAGE_COLORS[stage % STAGE_COLORS.length];

type Ctx = CanvasRenderingContext2D;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function setup(canvas: HTMLCanvasElement): { ctx: Ctx; w: number; h: number } {
  const ratio = Math.min(2, window.devicePixelRatio || 1), rect = canvas.getBoundingClientRect();
  const w = Math.max(320, Math.round(rect.width || canvas.width)), h = Math.max(200, Math.round(rect.height || canvas.height));
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#0c131b"; ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

export type ProgressHover = { gen: number } | null;

/** The two-panel progress chart: fitness (and exam score with its error) above, share of flags found below. */
export function drawProgress(canvas: HTMLCanvasElement, progress: Progress | null, hover: ProgressHover = null): { gens: number[]; xAt: (g: number) => number } {
  const { ctx, w, h } = setup(canvas);
  const left = 58, right = 16, top = 26, bottom = 28, gap = 26, plotW = w - left - right, panelH = (h - top - bottom - gap) / 2, lowTop = top + panelH + gap;
  ctx.font = "10px system-ui"; ctx.lineWidth = 1;
  const history = progress?.history ?? [];
  const label = (text: string, x: number, y: number, color = "#8c9bb0"): void => { ctx.fillStyle = color; ctx.fillText(text, x, y); };
  const frame = (y0: number): void => { ctx.strokeStyle = "rgba(113,145,181,.45)"; ctx.strokeRect(left, y0, plotW, panelH); };
  if (!history.length) {
    frame(top); frame(lowTop);
    label("Press Start. Every generation of the run is plotted here as it happens.", left + 12, top + panelH / 2 + 4, "#7f8ca0");
    label("SCORE PER TRIAL", 8, top - 10); label("FLAGS FOUND ON THE EXAM", 8, lowTop - 10);
    return { gens: [], xAt: () => left };
  }
  const first = history[0].gen, last = history[history.length - 1].gen, span = Math.max(1, last - first);
  const xAt = (g: number): number => left + ((g - first) / span) * plotW;
  const values = history.flatMap((r) => [r.best, r.mean, r.champion, ...(r.exam ? [r.exam.score + r.exam.se, r.exam.score - r.exam.se] : [])]).filter(Number.isFinite);
  let lo = Math.min(...values), hi = Math.max(...values); lo = Math.min(lo, 0); hi = Math.max(hi, lo + 10);
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const yFit = (v: number): number => top + (1 - (v - lo) / (hi - lo)) * panelH, yPct = (v: number): number => lowTop + (1 - clamp(v, 0, 1)) * panelH;
  // Stage bands.
  let bandStart = 0;
  history.forEach((r, i) => {
    if (i === history.length - 1 || history[i + 1].stage !== r.stage) {
      const x0 = xAt(history[bandStart].gen), x1 = xAt(r.gen);
      ctx.fillStyle = r.stage % 2 ? "rgba(114,184,255,.06)" : "rgba(124,240,182,.05)";
      ctx.fillRect(x0, top, Math.max(1, x1 - x0), panelH); ctx.fillRect(x0, lowTop, Math.max(1, x1 - x0), panelH);
      ctx.fillStyle = stageColor(r.stage); ctx.fillText(`stage ${r.stage + 1}`, x0 + 4, top + 10);
      const mastery = progress!.stages[r.stage]?.mastery;
      if (mastery !== undefined) { ctx.strokeStyle = stageColor(r.stage); ctx.globalAlpha = 0.5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x0, yPct(mastery)); ctx.lineTo(x1, yPct(mastery)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
      bandStart = i + 1;
    }
  });
  // Grid and axes.
  ctx.strokeStyle = "rgba(113,145,181,.18)"; ctx.setLineDash([3, 5]);
  for (let k = 0; k <= 4; k += 1) {
    const y1 = top + (k / 4) * panelH, y2 = lowTop + (k / 4) * panelH;
    ctx.beginPath(); ctx.moveTo(left, y1); ctx.lineTo(left + plotW, y1); ctx.moveTo(left, y2); ctx.lineTo(left + plotW, y2); ctx.stroke();
    label((hi - (k / 4) * (hi - lo)).toFixed(0), 8, y1 + 3); label(`${100 - k * 25}%`, 8, y2 + 3);
  }
  ctx.setLineDash([]); frame(top); frame(lowTop);
  label("SCORE PER TRIAL · best ● · mean ─ · leader ─ · exam ◆", 8, top - 10); label("FLAGS FOUND ON THE EXAM · dashed: stage goal · diversity ┈", 8, lowTop - 10);
  // Climb boundaries.
  ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.setLineDash([2, 4]);
  history.forEach((r, i) => { if (i > 0 && (r.branch !== history[i - 1].branch || r.stage !== history[i - 1].stage)) { const x = xAt(r.gen); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, lowTop + panelH); ctx.stroke(); } });
  ctx.setLineDash([]);
  const line = (value: (r: typeof history[number]) => number | undefined, y: (v: number) => number, color: string, width = 1.6, dash: number[] = []): void => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); let pen = false;
    for (const r of history) { const v = value(r); if (v === undefined || !Number.isFinite(v)) continue; const x = xAt(r.gen), yy = y(v); if (pen) ctx.lineTo(x, yy); else ctx.moveTo(x, yy); pen = true; }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  };
  line((r) => r.mean, yFit, "rgba(160,176,196,.7)", 1.2);
  ctx.fillStyle = "rgba(243,201,107,.8)"; for (const r of history) { ctx.beginPath(); ctx.arc(xAt(r.gen), yFit(r.best), 1.6, 0, 6.283); ctx.fill(); }
  line((r) => r.champion, yFit, "#7cf0b6", 2);
  const exams = history.filter((r) => r.exam);
  ctx.strokeStyle = "#72b8ff"; ctx.fillStyle = "#72b8ff";
  for (const r of exams) { const x = xAt(r.gen), e = r.exam!; ctx.beginPath(); ctx.moveTo(x, yFit(e.score - e.se)); ctx.lineTo(x, yFit(e.score + e.se)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, yFit(e.score) - 3.5); ctx.lineTo(x + 3.5, yFit(e.score)); ctx.lineTo(x, yFit(e.score) + 3.5); ctx.lineTo(x - 3.5, yFit(e.score)); ctx.closePath(); ctx.fill(); }
  line((r) => r.exam?.reach, yPct, "#72b8ff", 1.8);
  const maxDiv = Math.max(0.001, ...history.map((r) => r.diversity));
  line((r) => r.diversity / maxDiv, yPct, "rgba(196,162,255,.65)", 1.2, [2, 3]);
  // Local maxima.
  for (const m of progress!.maxima) {
    if (m.generation < first || m.generation > last) continue;
    const x = xAt(m.generation), y = yFit(m.exam.score);
    ctx.fillStyle = stageColor(m.stage); ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 5, y - 1); ctx.lineTo(x - 5, y - 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#e9edf5"; ctx.fillText(m.id, x - 5, y - 12);
  }
  // X labels.
  ctx.fillStyle = "#8c9bb0";
  for (let k = 0; k <= 6; k += 1) { const g = Math.round(first + (k / 6) * span); ctx.fillText(`G${g}`, clamp(xAt(g) - 8, left, w - 30), h - 8); }
  if (hover) {
    const x = xAt(hover.gen); ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, lowTop + panelH); ctx.stroke();
  }
  return { gens: history.map((r) => r.gen), xAt };
}

/* ------------------------------------------------------------------ */
/* The 3D map of generations                                           */
/* ------------------------------------------------------------------ */

export type LandscapeView = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_VIEW: LandscapeView = { yaw: -0.7, pitch: 0.75, zoom: 1 };

/** Principal axes of 8-D points (power iteration), returning mean and two unit vectors. */
export function principalAxes(points: number[][]): { mean: number[]; axes: number[][]; variance: number[] } {
  const d = points[0]?.length ?? 8, n = Math.max(1, points.length), mean = new Array(d).fill(0);
  for (const p of points) for (let k = 0; k < d; k += 1) mean[k] += p[k] / n;
  const cov = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const p of points) for (let a = 0; a < d; a += 1) for (let b = 0; b < d; b += 1) cov[a][b] += ((p[a] - mean[a]) * (p[b] - mean[b])) / n;
  const axes: number[][] = [], variance: number[] = [], work = cov.map((row) => [...row]);
  for (let c = 0; c < 3; c += 1) {
    let v = Array.from({ length: d }, (_, k) => 1 + ((k * 7 + c * 3) % 5) * 0.1);
    for (let it = 0; it < 60; it += 1) {
      const next = new Array(d).fill(0);
      for (let a = 0; a < d; a += 1) for (let b = 0; b < d; b += 1) next[a] += work[a][b] * v[b];
      const norm = Math.hypot(...next) || 1; v = next.map((x) => x / norm);
    }
    let lambda = 0; for (let a = 0; a < d; a += 1) { let s = 0; for (let b = 0; b < d; b += 1) s += work[a][b] * v[b]; lambda += v[a] * s; }
    axes.push(v); variance.push(lambda);
    for (let a = 0; a < d; a += 1) for (let b = 0; b < d; b += 1) work[a][b] -= lambda * v[a] * v[b];
  }
  return { mean, axes, variance };
}

export type LandscapePick = { id: string; x: number; y: number }[];

/**
 * Draws every generation's leader as a point (floor position: the brain's weights projected onto their two main
 * directions; height: score as a fraction of a perfect trial), the climb as a line, a surface fitted through the
 * points, and each local maximum as a flag. Returns the screen positions of the flags for picking.
 */
export function drawLandscape(canvas: HTMLCanvasElement, progress: Progress | null, view: LandscapeView, selected: string | null, championId: string | null, stage: number | null = null): LandscapePick {
  const { ctx, w, h } = setup(canvas);
  const picks: LandscapePick = [];
  ctx.font = "10px system-ui";
  const records = (progress?.history ?? []).filter((r) => r.proj?.length);
  const maxima = progress?.maxima ?? [];
  if (records.length < 2) {
    ctx.fillStyle = "#7f8ca0"; ctx.fillText("The map fills in as generations are evaluated.", 18, 28);
    return picks;
  }
  const all = [...records.map((r) => r.proj), ...maxima.map((m) => m.proj)];
  const { mean, axes } = principalAxes(all);
  const project = (p: number[]): [number, number] => [0, 1].map((a) => p.reduce((s, v, k) => s + (v - mean[k]) * axes[a][k], 0)) as [number, number];
  const planar = all.map(project);
  const xs = planar.map((p) => p[0]), ys = planar.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, scale = 1 / Math.max(1e-6, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2);
  const height = (score: number): number => clamp(score / 130, -0.3, 1.05);
  const norm = (p: number[]): [number, number] => { const q = project(p); return [(q[0] - cx) * scale * 0.9, (q[1] - cy) * scale * 0.9]; };
  // Camera.
  const cyaw = Math.cos(view.yaw), syaw = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const dist = 3.4 / view.zoom, focal = Math.min(w, h) * 0.9;
  const toScreen = (x: number, y: number, z: number): { sx: number; sy: number; depth: number } => {
    const rx = x * cyaw - y * syaw, ry = x * syaw + y * cyaw;
    const vy = ry * cp - (z - 0.25) * sp, vz = ry * sp + (z - 0.25) * cp;
    const d = dist + vy; const k = focal / Math.max(0.3, d);
    return { sx: w / 2 + rx * k, sy: h / 2 + 24 - vz * k * 1.0, depth: d };
  };
  // Surface: inverse-distance average of the leaders' heights, drawn as a wireframe.
  // One stage at a time, when asked: the axes above were fitted to the whole run, so the picture does not jump when the filter changes.
  const shown = stage === null ? records : records.filter((r) => r.stage === stage);
  const shownMaxima = stage === null ? maxima : maxima.filter((m) => m.stage === stage);
  if (shown.length < 2) { ctx.fillStyle = "#7f8ca0"; ctx.fillText(`No generations of stage ${(stage ?? 0) + 1} yet.`, 18, 28); return picks; }
  const pts = shown.map((r) => { const [x, y] = norm(r.proj); return { x, y, z: height(r.champion), gen: r.gen, stage: r.stage }; });
  const N = 22, grid: number[][] = [];
  for (let i = 0; i <= N; i += 1) { grid.push([]); for (let j = 0; j <= N; j += 1) {
    const gx = -1 + (2 * i) / N, gy = -1 + (2 * j) / N; let sw = 0, sz = 0;
    for (const p of pts) { const d2 = (p.x - gx) ** 2 + (p.y - gy) ** 2; const wgt = 1 / (d2 * d2 + 0.004); sw += wgt; sz += wgt * p.z; }
    grid[i].push(sz / sw);
  } }
  const quads: { poly: { sx: number; sy: number }[]; depth: number; z: number }[] = [];
  for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) {
    const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => toScreen(-1 + (2 * a) / N, -1 + (2 * b) / N, grid[a][b] * 0.9));
    quads.push({ poly: corners, depth: corners.reduce((s, c) => s + c.depth, 0) / 4, z: (grid[i][j] + grid[i + 1][j + 1]) / 2 });
  }
  quads.sort((a, b) => b.depth - a.depth);
  for (const q of quads) {
    const t = clamp(q.z, 0, 1);
    ctx.fillStyle = `rgba(${Math.round(30 + 60 * t)},${Math.round(60 + 150 * t)},${Math.round(110 + 40 * t)},.38)`;
    ctx.strokeStyle = "rgba(140,180,210,.22)";
    ctx.beginPath(); q.poly.forEach((c, k) => (k ? ctx.lineTo(c.sx, c.sy) : ctx.moveTo(c.sx, c.sy))); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  // Floor frame.
  ctx.strokeStyle = "rgba(200,220,240,.35)"; ctx.beginPath();
  [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].forEach(([x, y], k) => { const s = toScreen(x, y, 0); if (k) ctx.lineTo(s.sx, s.sy); else ctx.moveTo(s.sx, s.sy); }); ctx.stroke();
  // The leader's path through weight space, colour by stage.
  ctx.lineWidth = 1.6;
  for (let i = 1; i < pts.length; i += 1) {
    const a = toScreen(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z * 0.9), b = toScreen(pts[i].x, pts[i].y, pts[i].z * 0.9);
    ctx.strokeStyle = stageColor(pts[i].stage); ctx.globalAlpha = 0.35 + 0.65 * (i / pts.length);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;
  for (let i = 0; i < pts.length; i += 1) {
    const s = toScreen(pts[i].x, pts[i].y, pts[i].z * 0.9);
    ctx.fillStyle = stageColor(pts[i].stage); ctx.globalAlpha = 0.5 + 0.5 * (i / pts.length);
    ctx.beginPath(); ctx.arc(s.sx, s.sy, 1.8 + (i === pts.length - 1 ? 3 : 0), 0, 6.283); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Local maxima as flags on poles.
  const flags = shownMaxima.map((m) => { const [x, y] = norm(m.proj); return { m, x, y, z: height(m.exam.score) * 0.9 }; }).sort((a, b) => toScreen(b.x, b.y, 0).depth - toScreen(a.x, a.y, 0).depth);
  for (const f of flags) {
    const base = toScreen(f.x, f.y, 0), tip = toScreen(f.x, f.y, f.z + 0.08);
    const chosen = f.m.id === selected, isChampion = championId !== null && f.m.id === championId.replace(/^champion:/, "");
    ctx.strokeStyle = chosen ? "#fff" : stageColor(f.m.stage); ctx.lineWidth = chosen ? 2.2 : 1.4;
    ctx.beginPath(); ctx.moveTo(base.sx, base.sy); ctx.lineTo(tip.sx, tip.sy); ctx.stroke();
    ctx.fillStyle = isChampion ? "#ffd84a" : stageColor(f.m.stage);
    ctx.beginPath(); ctx.moveTo(tip.sx, tip.sy); ctx.lineTo(tip.sx + 13, tip.sy + 4); ctx.lineTo(tip.sx, tip.sy + 9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#e9edf5"; ctx.fillText(`${f.m.id} · ${f.m.exam.score.toFixed(0)}`, tip.sx + 16, tip.sy + 8);
    picks.push({ id: f.m.id, x: tip.sx + 4, y: tip.sy + 4 });
    ctx.lineWidth = 1;
  }
  ctx.fillStyle = "#8c9bb0";
  ctx.fillText("floor: the brain's weights, two main directions · height: score as a share of a perfect trial · flags: local maxima", 12, h - 10);
  return picks;
}
