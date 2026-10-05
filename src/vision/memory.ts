// A mushroom body for the kart: Kenyon cells and lap memory.
//
// In the fly, a few thousand Kenyon cells (KCs) re-code a small set of
// sensory inputs as a huge, sparse, random-looking pattern - a few percent of
// cells fire for any one situation, and different situations fire different
// sets. A handful of output neurons (MBONs) read that pattern through
// synapses that a dopamine signal can strengthen or weaken. That is a machine
// for "remember what happened *here*".
//
// What this module stores. On the first lap the kart does not know the road.
// But its own body tells it, at every moment, where it is (wheel odometry and
// gyro, dead reckoned from the start line) and which way it faces. The Kenyon
// cells give every place along the lap a sparse code - which gate it last
// passed and how far it has driven since - and four output synapses per cell
// learn, as running averages, "at this place I was at (x, y) facing (cos, sin)".
// That is a map of the path, built from nothing but the kart's own movement.
//
// On the next lap the kart is at the same place again, and it can *look ahead
// in memory*: ask the cells for the places 30, 56-112 and 150 px further on,
// compare the remembered heading and position there with its own pose now,
// and read off the same quantities the camera estimates (how far the heading
// will turn, and the bearing of the point ahead). Because the answer is
// computed from the current pose, it already allows for the kart being a bit
// off to one side or pointing a bit off-line today. The memory then becomes a
// third cue for fusion. Its stated uncertainty per cue was measured against the
// true road on tracks it was not tuned on (see `sigma`), so fusion trusts it about
// as much as it deserves: less than a camera in good light, more when the light
// fails and the camera's own error bars grow.
//
//   place code: which gate the kart last passed + how far it has driven since (wheel odometer)
//        -> Kenyon cells: each has a random place field (a centre and a width along the stretch between gates)
//        -> only the strongest few percent of that gate's cells fire (global inhibition, like the fly's APL neuron)
//        -> four output synapses per cell move towards (cos h, sin h, x, y) by 1/n of the gap (the prediction error)
import { STEP, wrapAngle } from "../core";
import { decodeFloats, encodeFloats } from "./cnn";
import { Cue } from "./fusion";
import { ESTIMATE_NAMES } from "./interface";
import { mulberry32 } from "./rng";

export type MemoryChannel = {
  /** Which estimate this cue provides. */
  name: "headingError" | "curvature" | "curveNear" | "curveFar";
  /**
   * "tangent": how far the heading will have turned by the time the kart has driven `distance` px.
   * "chord": the direction of the remembered point `distance` px on, as seen from here and which way the kart faces.
   */
  kind: "tangent" | "chord";
  distance: (speedPx: number) => number;
};

const lookahead = (speed: number): number => Math.min(112, Math.max(56, 56 + Math.abs(speed) * 0.42));
export const MEMORY_CHANNELS: MemoryChannel[] = [
  { name: "headingError", kind: "chord", distance: lookahead },
  { name: "curvature", kind: "tangent", distance: lookahead },
  { name: "curveNear", kind: "tangent", distance: () => 30 },
  { name: "curveFar", kind: "tangent", distance: () => 150 },
];
const CHANNELS = MEMORY_CHANNELS.length;
const CHANNEL_INDEX = MEMORY_CHANNELS.map((channel) => ESTIMATE_NAMES.indexOf(channel.name));
/** How long after a prediction's confirmation distance a late confirmation is still accepted. */
const WINDOW = 26;
/** Outputs per cell: cos(heading), sin(heading), x, y. */
const OUTPUTS = 4;
const POSITION_SCALE = 400;

export type MemoryConfig = {
  kenyonCells: number;
  /** Fraction of the cells that belong to the current gate that fire for any one place. */
  sparsity: number;
  gates: number;
  /** Length of the stretch between two gates that the place fields cover, in px. */
  span: number;
  /** Range of place-field widths, in px. */
  widthRange: [number, number];
  /** A synapse stops averaging and keeps a constant rate of 1 / (maxCount + 1) once it has been taught this many times. */
  maxCount: number;
  /** Root-mean-square error of each cue against the true road for a memory taught by a lap or two (measured offline on tracks the kart never saw). */
  sigma: [number, number, number, number];
  /** After a single lap the cue is this much worse still (the kart never drives exactly the same line twice). */
  singleLapPenalty: number;
  seed: number;
};

export const DEFAULT_MEMORY: MemoryConfig = {
  kenyonCells: 4000, sparsity: 0.05, gates: 8, span: 320, widthRange: [9, 24], maxCount: 24, sigma: [0.1, 0.11, 0.11, 0.11], singleLapPenalty: 0.5, seed: 7,
};

export type MemoryContext = {
  /** Gates passed so far (an event the kart notices as it drives under a gantry). */
  gate: number;
  /** Distance driven since that gate, from the wheel odometer, in px. */
  sinceGate: number;
  /** Heading from the gyro, dead reckoned from the start line. */
  heading: number;
  /** Position from wheel odometry and heading, dead reckoned from the start line. */
  x: number; y: number;
  /** Forward speed in px/s. */
  speed: number;
};

type Pending = {
  odometer: number; heading: number; x: number; y: number;
  predicted: Float32Array; available: Uint8Array;
  due: Float32Array; checked: Uint8Array;
  expires: number;
};

type Recalled = { heading: number; x: number; y: number; meanPasses: number };

export type MemorySnapshot = {
  format: "flykart-kenyon-memory"; version: 2; config: MemoryConfig; weights: string[]; count: string; passes: string; lastLap: string; firstLap: string;
  segment: number[]; lap: number; stats: MemoryStats;
};

export type MemoryStats = {
  /** Number of checks of a cue against what the kart then actually did. */
  updates: number;
  /** Running mean |what the kart then did − what the cue said| over all laps. */
  meanAbsError: number;
  /** The same, for the current lap only. */
  lapAbsError: number; lapUpdates: number;
};

export class MushroomBody {
  readonly config: MemoryConfig;
  private readonly gateOf: Int32Array;
  private readonly center: Float32Array; private readonly width: Float32Array;
  private readonly byGate: Int32Array[];
  private readonly weights: Float32Array[];
  /** Times each cell has been taught, and in how many different laps. */
  private readonly count: Float32Array; private readonly passes: Float32Array; private readonly lastLap: Float32Array;
  /** The lap in which each Kenyon cell was first taught (-1 = never). Only cells taught on an earlier lap count as remembered. */
  private readonly firstLap: Float32Array;
  /** Odometer distance between each gate and the next, as learned (0 = not yet known). */
  private readonly segment: Float32Array;
  private lapIndex = 0;
  private readonly winners: number;
  /** The cells firing for the kart's current place. */
  readonly active: Int32Array;
  private readonly scratch: Int32Array;
  private readonly drive: Float32Array;
  private readonly sortBuffer: Float32Array;
  private pending: Pending[] = [];
  private odometer = 0;
  private lastGate = 0; private lastAlong = 0;
  private readonly prediction = new Float32Array(CHANNELS);
  private readonly spread = new Float32Array(CHANNELS).fill(1e6);
  readonly stats: MemoryStats = { updates: 0, meanAbsError: 0, lapAbsError: 0, lapUpdates: 0 };

  constructor(config: Partial<MemoryConfig> = {}) {
    const c = this.config = { ...DEFAULT_MEMORY, ...config };
    const random = mulberry32(c.seed);
    const n = c.kenyonCells;
    this.gateOf = new Int32Array(n); this.center = new Float32Array(n); this.width = new Float32Array(n);
    const lists: number[][] = Array.from({ length: c.gates }, () => []);
    for (let j = 0; j < n; j += 1) {
      this.gateOf[j] = j % c.gates; lists[j % c.gates].push(j);
      this.center[j] = random() * c.span; this.width[j] = c.widthRange[0] + random() * (c.widthRange[1] - c.widthRange[0]);
    }
    this.byGate = lists.map((list) => Int32Array.from(list));
    this.weights = Array.from({ length: OUTPUTS }, () => new Float32Array(n));
    this.count = new Float32Array(n); this.passes = new Float32Array(n); this.lastLap = new Float32Array(n).fill(-1); this.firstLap = new Float32Array(n).fill(-1);
    this.segment = new Float32Array(c.gates);
    this.winners = Math.max(6, Math.round((n / c.gates) * c.sparsity));
    this.active = new Int32Array(this.winners).fill(-1); this.scratch = new Int32Array(this.winners);
    this.drive = new Float32Array(Math.ceil(n / c.gates)); this.sortBuffer = new Float32Array(this.drive.length);
  }

  /** Forget everything (a different track or world). */
  forget(): void {
    this.weights.forEach((w) => w.fill(0)); this.count.fill(0); this.passes.fill(0); this.lastLap.fill(-1); this.firstLap.fill(-1); this.segment.fill(0);
    this.lapIndex = 0; this.pending = []; this.odometer = 0; this.lastGate = 0; this.lastAlong = 0;
    this.prediction.fill(0); this.spread.fill(1e6); this.active.fill(-1);
    Object.assign(this.stats, { updates: 0, meanAbsError: 0, lapAbsError: 0, lapUpdates: 0 });
  }

  /** Start a new lap: keep what was learned, drop the in-flight checks, restart the per-lap tally. */
  beginLap(): void {
    this.lapIndex += 1; this.pending = []; this.odometer = 0; this.lastGate = 0; this.lastAlong = 0; this.spread.fill(1e6);
    Object.assign(this.stats, { lapAbsError: 0, lapUpdates: 0 });
  }

  get lap(): number { return this.lapIndex; }
  /** Kenyon cells that have been taught at least once. */
  get taughtCells(): number { let total = 0; for (let j = 0; j < this.count.length; j += 1) if (this.count[j] > 0) total += 1; return total; }
  isTaught(j: number): boolean { return this.count[j] > 0; }
  get kenyonCount(): number { return this.config.kenyonCells; }
  get winnerCount(): number { return this.winners; }
  cellGate(j: number): number { return this.gateOf[j]; }
  cellDistance(j: number): number { return this.center[j]; }
  /** Whether the cue is currently being offered to fusion. */
  get remembering(): boolean { return this.spread.some((v) => v < 1e5); }

  /** Advance the wheel odometer by one tick of travel. */
  advance(speed: number): void { this.odometer += Math.abs(speed) * STEP; }

  /** The cells that fire for a place: this gate, this far along it. Returns how many. */
  private select(gate: number, along: number, out: Int32Array): number {
    const c = this.config;
    const cells = this.byGate[((gate % c.gates) + c.gates) % c.gates];
    for (let i = 0; i < cells.length; i += 1) { const j = cells[i]; const z = (along - this.center[j]) / this.width[j]; const d = Math.exp(-0.5 * z * z); this.drive[i] = d; this.sortBuffer[i] = d; }
    const sorted = this.sortBuffer.subarray(0, cells.length).sort();
    const threshold = sorted[Math.max(0, cells.length - this.winners)];
    let n = 0;
    for (let i = 0; i < cells.length && n < this.winners; i += 1) if (this.drive[i] >= threshold && this.drive[i] > 0.05) out[n++] = cells[i];
    for (let k = n; k < out.length; k += 1) out[k] = -1;
    return n;
  }

  /** What the memory says the kart was doing `distance` px further on from (gate, along), if it remembers that place. */
  private recall(gate: number, along: number, distance: number): Recalled | null {
    const c = this.config;
    let g = gate, a = along + distance;
    const here = this.segment[((g % c.gates) + c.gates) % c.gates];
    if (here > 0) {
      if (a > here) { a -= here; g += 1; const next = this.segment[((g % c.gates) + c.gates) % c.gates]; if (next > 0 && a > next) return null; if (next === 0 && a > c.span) return null; }
    } else if (a > c.span) return null;
    const n = this.select(g, a, this.scratch);
    let cos = 0, sin = 0, x = 0, y = 0, used = 0, passes = 0;
    for (let k = 0; k < n; k += 1) {
      const j = this.scratch[k];
      if (this.count[j] <= 0 || !(this.firstLap[j] < this.lapIndex)) continue;
      cos += this.weights[0][j]; sin += this.weights[1][j]; x += this.weights[2][j]; y += this.weights[3][j]; passes += this.passes[j]; used += 1;
    }
    if (used === 0 || used < 0.5 * n) return null;
    return { heading: Math.atan2(sin / used, cos / used), x: (x / used) * POSITION_SCALE, y: (y / used) * POSITION_SCALE, meanPasses: passes / used };
  }

  /** Teach the cells at the kart's current place where it is and which way it faces. */
  private learn(ctx: MemoryContext, n: number): void {
    const c = this.config;
    const targets = [Math.cos(ctx.heading), Math.sin(ctx.heading), ctx.x / POSITION_SCALE, ctx.y / POSITION_SCALE];
    for (let k = 0; k < n; k += 1) {
      const j = this.active[k];
      const seen = this.count[j]; const rate = 1 / (Math.min(seen, c.maxCount) + 1);
      for (let m = 0; m < OUTPUTS; m += 1) this.weights[m][j] += (targets[m] - this.weights[m][j]) * rate;
      this.count[j] = seen + 1;
      if (this.lastLap[j] !== this.lapIndex) { this.passes[j] += 1; this.lastLap[j] = this.lapIndex; }
      if (this.firstLap[j] < 0) this.firstLap[j] = this.lapIndex;
    }
  }

  /**
   * Called once per camera frame. It checks earlier cues against what the kart
   * went on to do (for the dashboard), recalls the places ahead and turns them
   * into cues, then teaches the cells at the current place.
   */
  observe(ctx: MemoryContext, learn = true): void {
    const c = this.config;
    if (learn) this.check(ctx);
    // A gate crossing tells us how long the stretch just driven was.
    if (learn && ctx.gate !== this.lastGate && this.lastAlong > 20) {
      const g = ((this.lastGate % c.gates) + c.gates) % c.gates;
      this.segment[g] = this.segment[g] > 0 ? this.segment[g] * 0.7 + this.lastAlong * 0.3 : this.lastAlong;
    }
    this.lastGate = ctx.gate; this.lastAlong = ctx.sinceGate;
    const n = this.select(ctx.gate, ctx.sinceGate, this.active);
    // Recall before teaching, so the cue comes from earlier laps and not from this moment.
    const entry: Pending = {
      odometer: this.odometer, heading: ctx.heading, x: ctx.x, y: ctx.y,
      predicted: new Float32Array(CHANNELS), available: new Uint8Array(CHANNELS), due: new Float32Array(CHANNELS), checked: new Uint8Array(CHANNELS), expires: 0,
    };
    for (let m = 0; m < CHANNELS; m += 1) {
      const channel = MEMORY_CHANNELS[m]; const distance = channel.distance(ctx.speed);
      entry.due[m] = distance; entry.expires = Math.max(entry.expires, distance + WINDOW);
      const recalled = this.recall(ctx.gate, ctx.sinceGate, distance);
      if (!recalled) { this.spread[m] = 1e6; continue; }
      let value: number;
      if (channel.kind === "tangent") value = wrapAngle(recalled.heading - ctx.heading) / Math.PI;
      else {
        const dx = recalled.x - ctx.x, dy = recalled.y - ctx.y;
        if (Math.hypot(dx, dy) < 12) { this.spread[m] = 1e6; continue; }
        value = wrapAngle(Math.atan2(dy, dx) - ctx.heading) / Math.PI;
      }
      entry.predicted[m] = value; entry.available[m] = 1;
      this.prediction[m] = Math.max(-1, Math.min(1, value));
      this.spread[m] = c.sigma[m] ** 2 * (1 + c.singleLapPenalty / Math.max(1, recalled.meanPasses));
    }
    if (learn) { this.learn(ctx, n); this.pending.push(entry); }
  }

  /** Compare each earlier cue with what the kart actually did over the stretch it was about (a running tally for the dashboard). */
  private check(ctx: MemoryContext): void {
    const keep: Pending[] = [];
    for (const entry of this.pending) {
      const travelled = this.odometer - entry.odometer;
      for (let m = 0; m < CHANNELS; m += 1) {
        if (entry.checked[m] || travelled < entry.due[m]) continue;
        entry.checked[m] = 1;
        if (!entry.available[m] || travelled > entry.due[m] + WINDOW) continue;
        const channel = MEMORY_CHANNELS[m];
        const actual = (channel.kind === "tangent" ? wrapAngle(ctx.heading - entry.heading) : wrapAngle(Math.atan2(ctx.y - entry.y, ctx.x - entry.x) - entry.heading)) / Math.PI;
        const error = Math.abs(Math.max(-1, Math.min(1, actual)) - entry.predicted[m]);
        this.stats.updates += 1; this.stats.lapUpdates += 1;
        this.stats.meanAbsError += (error - this.stats.meanAbsError) / Math.min(this.stats.updates, 600);
        this.stats.lapAbsError += (error - this.stats.lapAbsError) / this.stats.lapUpdates;
      }
      if (!entry.checked.every((flag) => flag === 1) && travelled <= entry.expires) keep.push(entry);
    }
    this.pending = keep;
  }

  /** Everything that was learned, so a brain that has driven a lap can be saved and reloaded. */
  toJSON(): MemorySnapshot {
    return {
      format: "flykart-kenyon-memory", version: 2, config: this.config, weights: this.weights.map((w) => encodeFloats(w)), count: encodeFloats(this.count), passes: encodeFloats(this.passes), lastLap: encodeFloats(this.lastLap), firstLap: encodeFloats(this.firstLap),
      segment: Array.from(this.segment), lap: this.lapIndex, stats: { ...this.stats },
    };
  }

  static fromJSON(snapshot: MemorySnapshot): MushroomBody {
    if (!snapshot || snapshot.format !== "flykart-kenyon-memory" || snapshot.version !== 2) throw new Error("not a FlyKart memory snapshot");
    const c=snapshot.config, integer=(n:number,min:number,max:number)=>Number.isInteger(n)&&n>=min&&n<=max;
    if(!c||!integer(c.kenyonCells,64,64000)||!integer(c.gates,2,64)||!integer(c.maxCount,1,1000000)||!Number.isFinite(c.seed)||
       !Number.isFinite(c.sparsity)||c.sparsity<=0||c.sparsity>1||!Number.isFinite(c.span)||c.span<=0||
       !Array.isArray(c.widthRange)||c.widthRange.length!==2||c.widthRange.some(n=>!Number.isFinite(n)||n<=0)||c.widthRange[1]<c.widthRange[0]||
       !Array.isArray(c.sigma)||c.sigma.length!==4||c.sigma.some(n=>!Number.isFinite(n)||n<=0)||!Number.isFinite(c.singleLapPenalty)||c.singleLapPenalty<0||
       !integer(snapshot.lap,0,1000000000)||!Array.isArray(snapshot.weights)||snapshot.weights.length!==OUTPUTS||
       !Array.isArray(snapshot.segment)||snapshot.segment.length!==c.gates||snapshot.segment.some(n=>!Number.isFinite(n)||n<0))throw new Error('Invalid Kenyon memory configuration.');
    const read=(text:string)=>{if(typeof text!=='string'||text.length>Math.ceil(c.kenyonCells*4/3)*4+4)throw new Error('Invalid Kenyon memory weights.');const a=decodeFloats(text);if(a.length!==c.kenyonCells||!a.every(Number.isFinite))throw new Error('Invalid Kenyon memory weights.');return a;};
    const weights=snapshot.weights.map(read),count=read(snapshot.count),passes=read(snapshot.passes),lastLap=read(snapshot.lastLap),firstLap=read(snapshot.firstLap);
    if(count.some(n=>n<0)||passes.some(n=>n<0)||lastLap.some(n=>n < -1)||firstLap.some(n=>n < -1))throw new Error('Invalid Kenyon memory counters.');
    if(snapshot.stats&&['updates','meanAbsError','lapAbsError','lapUpdates'].some(key=>{const n=snapshot.stats[key as keyof typeof snapshot.stats];return !Number.isFinite(n)||n<0;}))throw new Error('Invalid Kenyon memory statistics.');
    const body = new MushroomBody(snapshot.config);
    weights.forEach((w,m)=>body.weights[m].set(w));
    body.count.set(count); body.passes.set(passes); body.lastLap.set(lastLap); body.firstLap.set(firstLap);
    body.segment.set(snapshot.segment); body.lapIndex = snapshot.lap;
    if(snapshot.stats)Object.assign(body.stats,snapshot.stats);
    return body;
  }

  /** The memory's opinion for fusion. Channels it cannot recall get an enormous variance (no weight). */
  cue(scratch: { mean: Float32Array; variance: Float32Array }): Cue | null {
    let any = false;
    scratch.mean.fill(0); scratch.variance.fill(1e6);
    for (let m = 0; m < CHANNELS; m += 1) {
      if (this.spread[m] >= 1e5) continue;
      any = true; scratch.mean[CHANNEL_INDEX[m]] = this.prediction[m]; scratch.variance[CHANNEL_INDEX[m]] = this.spread[m];
    }
    return any ? scratch : null;
  }
}
