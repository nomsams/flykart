// The eyes: a trained camera network wrapped so the rest of the system sees
// estimates with uncertainty, not raw tensors.
import { CameraConfig } from "./camera";
import { VisionCnn, NetSpec, decodeFloats, encodeFloats } from "./cnn";
import { inputChannelCount, retinaPlanes } from "./retina";
import { ESTIMATE_COUNT, Proprioception } from "./interface";

export const ACTION_GUESS_COUNT = 3;
/** Network outputs for a domain with `estimates` estimates: mean and log-variance of each, then the action guess. */
export const outputCountFor = (estimates: number): number => estimates * 2 + ACTION_GUESS_COUNT;
export const OUTPUT_COUNT = outputCountFor(ESTIMATE_COUNT);
export const BODY_INPUTS = 3;
/** The network sees the current frame and the one this many vision steps earlier. */
export const FRAME_LAG = 2;
/** The camera network runs once every this many simulation ticks (15 Hz at 30 ticks/s). */
export const VISION_STRIDE = 2;

export type VisionMetrics = { rmse: number[]; r2: number[]; calibration: number[]; coverage: number[]; samples: number; heldOut: string };

export type VisionModel = {
  format: "flykart-vision-net"; version: 1;
  domain?: "track" | "world";
  spec: NetSpec; camera: CameraConfig;
  /** Targets were divided by these before training; estimates are multiplied back. */
  targetScale: number[];
  params: string;
  trainedOn: string;
  metrics?: VisionMetrics;
  /** Multiplies each predicted variance: fitted on tracks it never trained on so that its "±σ" is honest. */
  varianceScale?: number[];
  notes?: string;
  history?: unknown;
};

export function defaultSpec(frames = 2, estimates: number = ESTIMATE_COUNT, input: "rgb" | "retina" = "retina", spatial = true): NetSpec {
  return { width: 48, height: 24, frames, input, spatial, channels: [6, 12, 16], hidden: 48, extra: BODY_INPUTS, outputs: outputCountFor(estimates) };
}

export function serialiseModel(net: VisionCnn, camera: CameraConfig, targetScale: number[], trainedOn: string, metrics?: VisionMetrics, notes?: string, domain: "track" | "world" = "track"): VisionModel {
  return { format: "flykart-vision-net", version: 1, domain, spec: net.spec, camera, targetScale: [...targetScale], params: encodeFloats(net.params), trainedOn, metrics, notes };
}

export function netFromModel(model: VisionModel): VisionCnn {
  if (model.format !== "flykart-vision-net") throw new Error(`not a FlyKart vision net: ${String((model as { format?: unknown }).format)}`);
  const params = decodeFloats(model.params);
  const net = new VisionCnn(model.spec, 1, params);
  if (net.parameterCount !== params.length) throw new Error("vision net weights do not match its architecture");
  return net;
}

export type Perception = {
  /** Estimates in the units of the controller's inputs. */
  mean: Float32Array;
  /** Predicted variance of each estimate. */
  variance: Float32Array;
  /** The vision pathway's own guess at what the privileged controller would do: steer, gas minus brake, reverse. */
  action: Float32Array;
  /** The penultimate layer, used as a visual place code by the lap memory. */
  embedding: Float32Array;
};

const LOGVAR_MIN = -7, LOGVAR_MAX = 3;

export class Perceiver {
  readonly net: VisionCnn;
  readonly scale: number[];
  readonly estimateCount: number;
  private readonly image: Float32Array;
  private readonly current: Float32Array; private readonly older: Float32Array;
  private readonly history: Float32Array[] = [];
  readonly perception: Perception;
  private readonly body = new Float32Array(BODY_INPUTS);

  constructor(readonly model: VisionModel, net?: VisionCnn) {
    this.net = net ?? netFromModel(model);
    this.scale = model.targetScale;
    this.estimateCount = (model.spec.outputs - ACTION_GUESS_COUNT) / 2;
    this.image = new Float32Array(inputChannelCount(model.spec) * model.spec.height * model.spec.width);
    this.current = new Float32Array(3 * model.spec.height * model.spec.width); this.older = new Float32Array(3 * model.spec.height * model.spec.width);
    this.perception = { mean: new Float32Array(this.estimateCount), variance: new Float32Array(this.estimateCount), action: new Float32Array(ACTION_GUESS_COUNT), embedding: new Float32Array(this.net.embeddingSize) };
  }

  reset(): void { this.history.length = 0; }

  /** Run the network on a new camera frame (planar RGB floats in [0, 1]). */
  see(frame: Float32Array, body: Proprioception): Perception {
    const plane = frame.length;
    this.history.push(frame.slice());
    while (this.history.length > FRAME_LAG + 1) this.history.shift();
    const spec = this.model.spec; const frames = spec.frames;
    const latest = this.history[this.history.length - 1], earlier = this.history[Math.max(0, this.history.length - 1 - FRAME_LAG)];
    for (let i = 0; i < plane; i += 1) { this.current[i] = latest[i] - 0.5; this.older[i] = earlier[i] - 0.5; }
    if (spec.input === "retina") retinaPlanes(this.current, frames > 1 ? this.older : null, spec.width, spec.height, this.image);
    else { this.image.set(this.current, 0); if (frames > 1) this.image.set(this.older, plane); }
    this.body[0] = body.speed; this.body[1] = body.lastSteer; this.body[2] = body.lastDrive;
    const out = this.net.forward(this.image, this.body);
    const p = this.perception; const n = this.estimateCount;
    for (let c = 0; c < n; c += 1) {
      p.mean[c] = out[c] * this.scale[c];
      const logVar = Math.min(LOGVAR_MAX, Math.max(LOGVAR_MIN, out[n + c]));
      p.variance[c] = Math.exp(logVar) * this.scale[c] * this.scale[c] * (this.model.varianceScale?.[c] ?? 1);
    }
    for (let a = 0; a < ACTION_GUESS_COUNT; a += 1) p.action[a] = out[2 * n + a];
    p.embedding.set(this.net.embedding);
    return p;
  }
}
