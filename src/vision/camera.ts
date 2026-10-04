// A small software camera: a perspective view of a flat world with upright
// objects. It has no GPU, canvas or DOM dependency, so the exact same pixels
// are produced in the browser, in Node training scripts and in tests.
//
//   ground  -> every pixel below the horizon is intersected with the ground plane
//   sprites -> upright boxes, cones, posts and trees projected with the same pinhole model
//   style   -> palette, lighting and sensor noise (the "domain randomisation" knobs)
//
// Pixels are returned as planar floats (R plane, G plane, B plane) in [0, 1],
// which is what the vision network consumes.
import { Random, gaussian } from "./rng";

export type Rgb = [number, number, number];

export type CameraConfig = {
  width: number; height: number;
  /** Horizontal field of view in radians. */
  hfov: number;
  /** Lens height above the ground, in world pixels (the kart is 24 px long). */
  mountHeight: number;
  /** Downward tilt in radians. */
  pitch: number;
  /** How far in front of the kart's centre the lens sits. */
  mountForward: number;
};

export const DEFAULT_CAMERA: CameraConfig = { width: 48, height: 24, hfov: (96 * Math.PI) / 180, mountHeight: 15, pitch: 0.16, mountForward: 8 };

export type Pose = { x: number; y: number; heading: number };

export type SpriteShape = "box" | "kart" | "cone" | "post" | "banner" | "tree" | "rock" | "flag" | "wall";
export type Sprite = {
  x: number; y: number;
  /** Direction the object faces; only matters for oriented shapes (karts). */
  heading: number;
  /** Footprint across and along `heading`, in world pixels. */
  width: number; length: number;
  /** Vertical extent above the ground. */
  z0: number; z1: number;
  color: Rgb; shape: SpriteShape;
};

export type Style = {
  skyTop: Rgb; skyHorizon: Rgb; fog: Rgb; fogDistance: number;
  grassA: Rgb; grassB: Rgb; asphalt: Rgb; asphaltWorn: Rgb; kerbA: Rgb; kerbB: Rgb; line: Rgb; gate: Rgb; oil: Rgb;
  sand: Rgb; dirt: Rgb; water: Rgb;
  brightness: number; contrast: number; gain: Rgb; noise: number;
};

const rgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
export { rgb as hexToRgb };

export const DEFAULT_STYLE: Style = {
  skyTop: rgb("#5b9be6"), skyHorizon: rgb("#cfe6f7"), fog: rgb("#c4d9e6"), fogDistance: 620,
  grassA: rgb("#3f9a45"), grassB: rgb("#368a3d"), asphalt: rgb("#4b4f57"), asphaltWorn: rgb("#565a63"), kerbA: rgb("#d9362c"), kerbB: rgb("#f2f2ee"), line: rgb("#ecebe3"), gate: rgb("#ffd23f"), oil: rgb("#2a1f45"),
  sand: rgb("#d8c48a"), dirt: rgb("#8a6a43"), water: rgb("#2f78b8"),
  brightness: 1, contrast: 1, gain: [1, 1, 1], noise: 0,
};

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Randomise the look of the world. `strength` 0 keeps the canonical palette;
 * 1 shifts hues, lighting and noise far enough that a network cannot rely on a
 * single exact colour, only on the shapes and the relationships between colours
 * (road is darker than verge, kerbs alternate, gates are bright bands).
 */
export function randomStyle(random: Random, strength = 1): Style {
  if (strength <= 0) return { ...DEFAULT_STYLE };
  const jitter = (base: Rgb, amount: number): Rgb => {
    const shift = (random() * 2 - 1) * amount * strength;
    return [clamp01(base[0] + shift + (random() * 2 - 1) * amount * 0.5 * strength), clamp01(base[1] + shift + (random() * 2 - 1) * amount * 0.5 * strength), clamp01(base[2] + shift + (random() * 2 - 1) * amount * 0.5 * strength)];
  };
  const grass = jitter(DEFAULT_STYLE.grassA, 0.1);
  const asphalt = jitter(DEFAULT_STYLE.asphalt, 0.07);
  const sky = jitter(DEFAULT_STYLE.skyHorizon, 0.1);
  const dusk = random() < 0.25 * strength;
  return {
    ...DEFAULT_STYLE,
    skyTop: dusk ? mixRgb(jitter(DEFAULT_STYLE.skyTop, 0.1), rgb("#3a2f5c"), 0.6) : jitter(DEFAULT_STYLE.skyTop, 0.12),
    skyHorizon: dusk ? mixRgb(sky, rgb("#f0a070"), 0.55) : sky, fog: mixRgb(sky, DEFAULT_STYLE.fog, 0.5),
    fogDistance: 450 + random() * 450,
    grassA: grass, grassB: mixRgb(grass, [0, 0, 0], 0.07 + random() * 0.05),
    asphalt, asphaltWorn: mixRgb(asphalt, [1, 1, 1], 0.05 + random() * 0.05),
    kerbA: jitter(DEFAULT_STYLE.kerbA, 0.06), kerbB: jitter(DEFAULT_STYLE.kerbB, 0.05), line: jitter(DEFAULT_STYLE.line, 0.05), gate: jitter(DEFAULT_STYLE.gate, 0.08),
    sand: jitter(DEFAULT_STYLE.sand, 0.07), dirt: jitter(DEFAULT_STYLE.dirt, 0.07), water: jitter(DEFAULT_STYLE.water, 0.1),
    brightness: 1 + (random() * 2 - 1) * 0.28 * strength - (dusk ? 0.12 : 0), contrast: 1 + (random() * 2 - 1) * 0.18 * strength,
    gain: [1 + (random() * 2 - 1) * 0.1 * strength, 1 + (random() * 2 - 1) * 0.1 * strength, 1 + (random() * 2 - 1) * 0.1 * strength],
    noise: random() * 0.03 * strength,
  };
}

/** A scene supplies the colour of the ground at any world point, plus upright sprites. */
export interface Scene {
  style: Style;
  sprites: Sprite[];
  /** Fill `out` with the ground colour at (x, y). */
  ground(x: number, y: number, out: Rgb): void;
  /** Called once per frame so the scene can cache what is near the lens. */
  prepare(pose: Pose): void;
}

type Projection = {
  f: number; cx: number; cy: number; sinP: number; cosP: number;
  /** For each supersampled row: ground forward distance and range multiplier, or -1 above the horizon. */
  rowForward: Float32Array; rowT: Float32Array; rowElevation: Float32Array;
  columnRight: Float32Array;
};

const projectionCache = new Map<string, Projection>();
const SUB_ROWS = 2;

function projectionFor(config: CameraConfig): Projection {
  const key = `${config.width}x${config.height}:${config.hfov}:${config.mountHeight}:${config.pitch}`;
  const cached = projectionCache.get(key);
  if (cached) return cached;
  const f = (config.width / 2) / Math.tan(config.hfov / 2);
  const cx = config.width / 2, cy = config.height / 2;
  const sinP = Math.sin(config.pitch), cosP = Math.cos(config.pitch);
  const rows = config.height * SUB_ROWS;
  const rowForward = new Float32Array(rows), rowT = new Float32Array(rows), rowElevation = new Float32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const b = ((row + 0.5) / SUB_ROWS - cy) / f;
    const down = sinP + b * cosP;
    rowElevation[row] = -down;
    if (down > 1e-4) { const t = config.mountHeight / down; rowT[row] = t; rowForward[row] = t * (cosP - b * sinP); }
    else { rowT[row] = -1; rowForward[row] = -1; }
  }
  const columnRight = new Float32Array(config.width);
  for (let column = 0; column < config.width; column += 1) columnRight[column] = (column + 0.5 - cx) / f;
  const projection = { f, cx, cy, sinP, cosP, rowForward, rowT, rowElevation, columnRight };
  projectionCache.set(key, projection);
  return projection;
}

/** Distance along the ground that a pixel row looks at (for debugging and tests). */
export function groundDistanceAtRow(config: CameraConfig, row: number): number {
  const projection = projectionFor(config);
  return projection.rowForward[Math.min(config.height * SUB_ROWS - 1, Math.max(0, Math.round((row + 0.5) * SUB_ROWS - 0.5)))];
}

export function frameLength(config: CameraConfig): number { return 3 * config.width * config.height; }

const scratch: Rgb = [0, 0, 0];

/**
 * Render a frame into `out` (planar RGB floats, length 3·width·height).
 * The lens sits `mountForward` ahead of the pose, looking along its heading.
 */
export function renderFrame(scene: Scene, pose: Pose, config: CameraConfig, out: Float32Array, random?: Random): Float32Array {
  const projection = projectionFor(config);
  const { width, height } = config; const plane = width * height;
  const style = scene.style;
  const fx = Math.cos(pose.heading), fy = Math.sin(pose.heading);
  const sx = -fy, sy = fx; // the kart's right-hand side (screen y points down)
  const ox = pose.x + fx * config.mountForward, oy = pose.y + fy * config.mountForward;
  scene.prepare({ x: ox, y: oy, heading: pose.heading });
  const color = scratch;
  const top = style.skyTop, horizon = style.skyHorizon, fog = style.fog;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let r = 0, g = 0, b = 0;
      for (let sub = 0; sub < SUB_ROWS; sub += 1) {
        const index = row * SUB_ROWS + sub;
        const t = projection.rowT[index];
        if (t < 0) {
          const k = clamp01(projection.rowElevation[index] * 3.2);
          r += horizon[0] + (top[0] - horizon[0]) * k; g += horizon[1] + (top[1] - horizon[1]) * k; b += horizon[2] + (top[2] - horizon[2]) * k;
          continue;
        }
        const forward = projection.rowForward[index], lateral = t * projection.columnRight[column];
        scene.ground(ox + fx * forward + sx * lateral, oy + fy * forward + sy * lateral, color);
        const range = Math.hypot(forward, lateral);
        const haze = 1 - Math.exp(-range / style.fogDistance);
        r += color[0] + (fog[0] - color[0]) * haze; g += color[1] + (fog[1] - color[1]) * haze; b += color[2] + (fog[2] - color[2]) * haze;
      }
      const at = row * width + column;
      out[at] = r / SUB_ROWS; out[plane + at] = g / SUB_ROWS; out[2 * plane + at] = b / SUB_ROWS;
    }
  }
  drawSprites(scene, { x: ox, y: oy, heading: pose.heading }, config, projection, out);
  applyStyle(out, plane, style, random);
  return out;
}

function drawSprites(scene: Scene, pose: Pose, config: CameraConfig, projection: Projection, out: Float32Array): void {
  const { width, height } = config; const plane = width * height;
  const { f, cx, cy, sinP, cosP } = projection;
  const fx = Math.cos(pose.heading), fy = Math.sin(pose.heading);
  const sx = -fy, sy = fx;
  const h = config.mountHeight;
  const fog = scene.style.fog;
  const queue: { sprite: Sprite; depth: number; forward: number; right: number }[] = [];
  for (const sprite of scene.sprites) {
    const dx = sprite.x - pose.x, dy = sprite.y - pose.y;
    const forward = dx * fx + dy * fy, right = dx * sx + dy * sy;
    const depth = forward * cosP + (h - sprite.z0) * sinP;
    if (depth < 3 || forward < 2) continue;
    queue.push({ sprite, depth, forward, right });
  }
  queue.sort((a, b) => b.depth - a.depth);
  for (const { sprite, forward, right } of queue) {
    const baseDepth = forward * cosP + (h - sprite.z0) * sinP;
    const topDepth = forward * cosP + (h - sprite.z1) * sinP;
    if (topDepth < 2) continue;
    const bottomV = cy + f * ((h - sprite.z0) * cosP - forward * sinP) / baseDepth;
    const topV = cy + f * ((h - sprite.z1) * cosP - forward * sinP) / topDepth;
    const view = Math.atan2(right, forward); // bearing of the object from the lens, camera frame
    const worldView = pose.heading + view;
    const relative = sprite.heading - worldView;
    const oriented = sprite.shape === "kart" || sprite.shape === "wall" || sprite.shape === "banner";
    const apparent = oriented ? Math.abs(sprite.width * Math.cos(relative)) + Math.abs(sprite.length * Math.sin(relative)) : sprite.width;
    const centerU = cx + f * right / baseDepth;
    const halfPx = (f * apparent / 2) / baseDepth;
    let left = centerU - halfPx, rightEdge = centerU + halfPx, topEdge = topV, bottomEdge = bottomV;
    if (rightEdge < 0 || left > width || bottomEdge < 0 || topEdge > height) continue;
    // A sprite thinner than a pixel still has to register; keep its energy.
    let alpha = 1;
    const spriteWidth = rightEdge - left, spriteHeight = bottomEdge - topEdge;
    if (spriteWidth < 1) { alpha *= Math.max(0.15, spriteWidth); const mid = (left + rightEdge) / 2; left = mid - 0.5; rightEdge = mid + 0.5; }
    if (spriteHeight < 1) { alpha *= Math.max(0.15, spriteHeight); const mid = (topEdge + bottomEdge) / 2; topEdge = mid - 0.5; bottomEdge = mid + 0.5; }
    const haze = 1 - Math.exp(-Math.hypot(forward, right) / scene.style.fogDistance);
    const u0 = Math.max(0, Math.floor(left)), u1 = Math.min(width - 1, Math.ceil(rightEdge) - 1);
    const v0 = Math.max(0, Math.floor(topEdge)), v1 = Math.min(height - 1, Math.ceil(bottomEdge) - 1);
    const spanU = Math.max(1e-6, rightEdge - left), spanV = Math.max(1e-6, bottomEdge - topEdge);
    for (let v = v0; v <= v1; v += 1) {
      for (let u = u0; u <= u1; u += 1) {
        let cr = 0, cg = 0, cb = 0, covered = 0;
        for (let su = 0; su < 2; su += 1) for (let sv = 0; sv < 2; sv += 1) {
          const uu = u + (su + 0.5) / 2, vv = v + (sv + 0.5) / 2;
          if (uu < left || uu > rightEdge || vv < topEdge || vv > bottomEdge) continue;
          const nx = ((uu - left) / spanU) * 2 - 1, ny = (bottomEdge - vv) / spanV;
          const shaded = shadeSprite(sprite, nx, ny, relative);
          if (!shaded) continue;
          cr += shaded[0]; cg += shaded[1]; cb += shaded[2]; covered += 1;
        }
        if (covered === 0) continue;
        const coverage = (covered / 4) * alpha;
        const at = v * width + u;
        out[at] += (cr / covered + (fog[0] - cr / covered) * haze - out[at]) * coverage;
        out[plane + at] += (cg / covered + (fog[1] - cg / covered) * haze - out[plane + at]) * coverage;
        out[2 * plane + at] += (cb / covered + (fog[2] - cb / covered) * haze - out[2 * plane + at]) * coverage;
      }
    }
  }
}

const SHADE: Rgb = [0, 0, 0];
const darker = (c: Rgb, k: number): Rgb => { SHADE[0] = c[0] * k; SHADE[1] = c[1] * k; SHADE[2] = c[2] * k; return SHADE; };
const GLASS: Rgb = [0.16, 0.2, 0.28];

/** Colour of a sprite at normalised (nx in -1..1 across, ny 0..1 bottom to top), or null where it is transparent. */
function shadeSprite(sprite: Sprite, nx: number, ny: number, relative: number): Rgb | null {
  const c = sprite.color;
  switch (sprite.shape) {
    case "kart": {
      if (ny < 0.16 && (Math.abs(nx) > 0.78 || Math.abs(nx) < 0.1)) return darker(c, 0.2);   // tyres and underbody gap
      if (ny > 0.58) { if (Math.abs(nx) > 0.62) return null; return ny > 0.9 ? darker(c, 0.7) : GLASS; } // narrower cabin with glass
      return ny < 0.3 ? darker(c, 0.78) : c;
    }
    case "cone": { const half = 1 - ny; if (Math.abs(nx) > half) return null; return ny < 0.18 ? darker(c, 0.6) : (Math.floor(ny * 5) % 2 === 0 ? c : [0.96, 0.96, 0.94]); }
    case "post": return ny < 0.04 ? darker(c, 0.5) : c;
    case "banner": return (Math.floor((nx + 1) * 6) % 2 === 0) ? c : darker(c, 0.35);
    case "wall": return (Math.floor((nx + 1) * 5 + Math.abs(Math.cos(relative)) * 3) % 2 === 0) ? c : [0.96, 0.96, 0.94];
    case "tree": { if (ny < 0.3) return Math.abs(nx) < 0.14 ? [0.34, 0.22, 0.12] : null; const half = (1 - ny) * 1.15 + 0.1; if (Math.abs(nx) > half) return null; return darker(c, 0.75 + 0.35 * ny); }
    case "rock": { const ex = nx, ey = (ny - 0.5) * 2; if (ex * ex * 0.9 + ey * ey > 1) return null; return darker(c, 0.65 + 0.4 * ny); }
    case "flag": return nx > 0.0 && ny > 0.62 ? c : (Math.abs(nx) < 0.1 ? [0.92, 0.92, 0.92] : null);
    default: return ny < 0.08 ? darker(c, 0.7) : c;
  }
}

function applyStyle(out: Float32Array, plane: number, style: Style, random?: Random): void {
  const { brightness, contrast, gain, noise } = style;
  const length = plane * 3;
  for (let i = 0; i < length; i += 1) {
    const channel = i < plane ? 0 : i < 2 * plane ? 1 : 2;
    let value = ((out[i] - 0.5) * contrast + 0.5) * brightness * gain[channel];
    if (noise > 0 && random) value += gaussian(random) * noise;
    out[i] = clamp01(value);
  }
}

/** Planar float frame -> interleaved RGBA bytes, for canvases and PNG files. */
export function frameToRgba(frame: Float32Array, config: CameraConfig, target?: Uint8ClampedArray): Uint8ClampedArray {
  const plane = config.width * config.height;
  const rgba = target ?? new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i += 1) {
    rgba[i * 4] = frame[i] * 255; rgba[i * 4 + 1] = frame[plane + i] * 255; rgba[i * 4 + 2] = frame[2 * plane + i] * 255; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
