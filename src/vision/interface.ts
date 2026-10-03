// The contract between "eyes" and "brain".
//
// The FlyKart controller reads 17 numbers (see SENSOR_INFO in lab.ts). In
// FlyKart Vision those numbers are no longer read off the simulator: a camera
// network *estimates* the ones a camera can see, and the kart's own body
// supplies the rest (speed and its last commands, like a fly's leg and
// haltere feedback). Keeping this contract fixed is what lets a brain trained
// before vision existed be dropped into the vision pipeline, and a brain
// trained inside it be exported back to the original simulator.
import { clamp } from "../core";
import { Random, gaussian } from "./rng";

/** The 13 quantities the camera is asked to estimate, in order. */
export const ESTIMATE_NAMES = ["headingError", "curvature", "lateral", "edgeClearance", "roadAngle", "curveNear", "curveFar", "checkpoint", "trafficClose", "trafficSide", "trafficAhead", "closingSpeed", "obstacle"] as const;
export const ESTIMATE_COUNT = ESTIMATE_NAMES.length;
export type EstimateName = (typeof ESTIMATE_NAMES)[number];

export const ESTIMATE_LABELS: Record<EstimateName, string> = {
  headingError: "Heading to look-ahead", curvature: "Curvature at look-ahead", lateral: "Lateral offset", edgeClearance: "Edge clearance", roadAngle: "Road angle here", curveNear: "Curvature +30 px", curveFar: "Curvature +150 px", checkpoint: "Checkpoint bearing",
  trafficClose: "Traffic closeness", trafficSide: "Traffic side", trafficAhead: "Traffic ahead", closingSpeed: "Closing speed", obstacle: "Static obstacle",
};

/** Which controller input each estimate feeds. `roadAngle` becomes alignment (a cosine) and `lateral` also feeds the centre-line input. */
export const ESTIMATE_TO_SENSOR = [0, 1, 2, 7, 8, 11, 12, 13, 5, 6, 9, 10, 16] as const;
/** Estimates that flip sign when the world is mirrored left-right (used for augmentation). */
export const MIRROR_SIGN = [-1, -1, -1, 1, -1, -1, -1, -1, 1, -1, 1, 1, 1] as const;
export const ROAD_ESTIMATES = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const TRAFFIC_ESTIMATES = [8, 9, 10, 11, 12] as const;

/** Controller inputs that the body provides itself. */
export const PROPRIOCEPTION_SENSORS = [3, 14, 15] as const;
export const PROPRIOCEPTION_COUNT = 3;
/** What the body knows without looking. `sonarCloseness` and `sonarStrength` are present only on a robot with a sonar. */
export type Proprioception = { speed: number; lastSteer: number; lastDrive: number; sonarCloseness?: number; sonarStrength?: number };

/** Build the controller's 17 inputs from camera estimates and the body's own feedback. */
export function sensorsFromEstimates(estimates: ArrayLike<number>, body: Proprioception, out: number[] = new Array(17).fill(0)): number[] {
  const lateral = clamp(estimates[2], -1.5, 1.5);
  out[0] = clamp(estimates[0], -1, 1);
  out[1] = clamp(estimates[1], -1, 1);
  out[2] = clamp(lateral, -1, 1);
  out[3] = clamp(body.speed, -1, 1);
  out[4] = clamp(1 - Math.abs(lateral), -1, 1);
  out[5] = clamp(estimates[8], 0, 1);
  out[6] = clamp(estimates[9], -1, 1);
  out[7] = clamp(estimates[3], -1, 1);
  out[8] = Math.cos(Math.PI * clamp(estimates[4], -1, 1));
  out[9] = clamp(estimates[10], -1, 1);
  out[10] = clamp(estimates[11], -1, 1);
  out[11] = clamp(estimates[5], -1, 1);
  out[12] = clamp(estimates[6], -1, 1);
  out[13] = clamp(estimates[7], -1, 1);
  out[14] = clamp(body.lastSteer, -1, 1);
  out[15] = clamp(body.lastDrive, -1, 1);
  out[16] = clamp(estimates[12], 0, 1);
  return out;
}

/** Read the estimates back out of a full simulator sensor vector (for traffic, `roadAngle` must be supplied separately). */
export function estimatesFromSensors(sensors: ArrayLike<number>, roadAngle: number, out: number[] = new Array(ESTIMATE_COUNT).fill(0)): number[] {
  for (let i = 0; i < ESTIMATE_COUNT; i += 1) out[i] = sensors[ESTIMATE_TO_SENSOR[i]];
  out[2] = (sensors[2] >= 0 ? 1 : -1) * (1 - sensors[4]);
  out[4] = roadAngle;
  return out;
}

export const bodyFromSensors = (sensors: ArrayLike<number>): Proprioception => ({ speed: sensors[3], lastSteer: sensors[14], lastDrive: sensors[15] });

/* ------------------------------------------------------------------ */
/* How wrong can the eyes be? A noise model for the interface          */
/* ------------------------------------------------------------------ */

export type NoiseSpec = {
  /** Independent per-tick error (standard deviation, in sensor units). */
  white: number;
  /** Slowly varying error: the kind a real camera makes when it misjudges a bend for a while. */
  correlated: number; correlationTicks: number;
  /** A constant offset drawn once per run. */
  bias: number;
  /** Camera-to-controller latency in simulation ticks (1 tick = 33 ms). */
  delayTicks: number;
};

export const NO_NOISE: NoiseSpec = { white: 0, correlated: 0, correlationTicks: 12, bias: 0, delayTicks: 0 };

/** Typical size of an error on each estimate, relative to `NoiseSpec` (some quantities are inherently harder to see). */
export const NOISE_SCALE = [1, 1, 0.8, 0.8, 0.5, 1, 1.4, 1.4, 1, 1, 1, 1.5, 0.3] as const;

/** A named ladder from clean to rough, shared by training curricula and by the evaluation tables. */
export const NOISE_LEVELS: { id: string; label: string; spec: NoiseSpec }[] = [
  { id: "clean", label: "clean", spec: NO_NOISE },
  { id: "mild", label: "mild", spec: { white: 0.05, correlated: 0.03, correlationTicks: 12, bias: 0.02, delayTicks: 2 } },
  { id: "rough", label: "rough", spec: { white: 0.12, correlated: 0.07, correlationTicks: 14, bias: 0.04, delayTicks: 4 } },
  { id: "harsh", label: "harsh", spec: { white: 0.25, correlated: 0.12, correlationTicks: 16, bias: 0.06, delayTicks: 7 } },
  { id: "brutal", label: "brutal", spec: { white: 0.4, correlated: 0.18, correlationTicks: 18, bias: 0.08, delayTicks: 10 } },
];

/** Degrades the 12 camera estimates the way an imperfect eye would; the controller then trains on the result. */
export class EstimateCorruptor {
  private readonly queue: number[][] = [];
  private readonly drift: number[];
  private readonly bias: number[];
  private readonly rho: number;
  /** `scale` is the per-estimate error size of the domain (the track by default). */
  constructor(private readonly spec: NoiseSpec, private readonly random: Random, private readonly scale: readonly number[] = NOISE_SCALE) {
    this.rho = Math.exp(-1 / Math.max(1, spec.correlationTicks));
    this.drift = new Array(scale.length).fill(0);
    this.bias = Array.from({ length: scale.length }, (_, i) => gaussian(random) * spec.bias * scale[i]);
  }
  reset(): void { this.queue.length = 0; this.drift.fill(0); }
  apply(estimates: ArrayLike<number>, out: number[] = new Array(this.scale.length).fill(0)): number[] {
    const spec = this.spec;
    this.queue.push(Array.from(estimates));
    while (this.queue.length > spec.delayTicks + 1) this.queue.shift();
    const delayed = this.queue[0];
    const innovation = Math.sqrt(1 - this.rho * this.rho);
    for (let i = 0; i < this.scale.length; i += 1) {
      this.drift[i] = this.rho * this.drift[i] + innovation * gaussian(this.random) * spec.correlated * this.scale[i];
      out[i] = delayed[i] + this.bias[i] + this.drift[i] + gaussian(this.random) * spec.white * this.scale[i];
    }
    return out;
  }
}

/** Interpolate between two noise levels (0 = a, 1 = b); used for curricula. */
export function blendNoise(a: NoiseSpec, b: NoiseSpec, t: number): NoiseSpec {
  const mix = (x: number, y: number): number => x + (y - x) * t;
  return { white: mix(a.white, b.white), correlated: mix(a.correlated, b.correlated), correlationTicks: mix(a.correlationTicks, b.correlationTicks), bias: mix(a.bias, b.bias), delayTicks: Math.round(mix(a.delayTicks, b.delayTicks)) };
}
