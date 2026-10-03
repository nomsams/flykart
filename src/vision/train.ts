// Supervised training of the camera network from simulator labels.
//
// Every frame the simulator renders comes with exact ground truth for free:
// the domain's estimates, the body's feedback, and what the privileged
// controller would have done. The loss has three parts:
//   * the mean of each estimate  - Huber loss (robust, and not rescaled by the variance)
//   * its log-variance           - Gaussian negative log-likelihood with the mean held fixed,
//                                  which makes the variance an honest "how wrong am I likely to be"
//   * the teacher's action       - the "guess what the feeling brain would do" auxiliary task
import { VisionCnn } from "./cnn";
import type { Domain } from "./domain";
import { ACTION_GUESS_COUNT, BODY_INPUTS, VisionMetrics, outputCountFor } from "./perception";
import { InputMode, inputChannelCount, retinaPlanes } from "./retina";
import { mulberry32, shuffleInPlace } from "./rng";

export class VisionDataset {
  private readonly frames: Uint8Array;
  readonly previous: Int32Array;
  readonly body: Float32Array;
  readonly targets: Float32Array;
  readonly action: Float32Array;
  readonly episode: Int32Array;
  readonly group: Int32Array;
  readonly frameLength: number;
  size = 0;

  constructor(readonly capacity: number, readonly width: number, readonly height: number, readonly estimateCount: number) {
    this.frameLength = 3 * width * height;
    this.frames = new Uint8Array(capacity * this.frameLength);
    this.previous = new Int32Array(capacity); this.body = new Float32Array(capacity * BODY_INPUTS);
    this.targets = new Float32Array(capacity * estimateCount); this.action = new Float32Array(capacity * ACTION_GUESS_COUNT);
    this.episode = new Int32Array(capacity); this.group = new Int32Array(capacity);
  }

  get full(): boolean { return this.size >= this.capacity; }

  /** `previous` is the index of the sample one frame-lag earlier in the same episode, or -1. `group` labels the track or world, so evaluation can hold whole ones out. */
  add(frame: Float32Array, previous: number, body: ArrayLike<number>, targets: ArrayLike<number>, action: ArrayLike<number>, episode: number, group: number): number {
    if (this.full) throw new Error("dataset is full");
    const i = this.size++; const base = i * this.frameLength;
    for (let k = 0; k < this.frameLength; k += 1) this.frames[base + k] = Math.round(frame[k] * 255);
    this.previous[i] = previous < 0 ? i : previous;
    for (let k = 0; k < BODY_INPUTS; k += 1) this.body[i * BODY_INPUTS + k] = body[k];
    for (let k = 0; k < this.estimateCount; k += 1) this.targets[i * this.estimateCount + k] = targets[k];
    for (let k = 0; k < ACTION_GUESS_COUNT; k += 1) this.action[i * ACTION_GUESS_COUNT + k] = action[k];
    this.episode[i] = episode; this.group[i] = group;
    return i;
  }

  private currentBuffer: Float32Array | null = null; private olderBuffer: Float32Array | null = null;

  /** Write the network's input planes (centred, optionally mirrored) for sample `i` into `out`. */
  image(i: number, spec: { frames: number; input?: InputMode }, mirror: boolean, out: Float32Array): void {
    const { width, height } = this; const plane = width * height;
    if (spec.input === "retina") {
      this.currentBuffer ??= new Float32Array(3 * plane); this.olderBuffer ??= new Float32Array(3 * plane);
      this.rgb(i, mirror, this.currentBuffer); if (spec.frames > 1) this.rgb(this.previous[i], mirror, this.olderBuffer);
      retinaPlanes(this.currentBuffer, spec.frames > 1 ? this.olderBuffer : null, width, height, out);
      return;
    }
    for (let f = 0; f < spec.frames; f += 1) this.rgb(f === 0 ? i : this.previous[i], mirror, out, f * 3 * plane);
  }

  /** One frame as three centred planes, written at `offset` in `out`. */
  private rgb(source: number, mirror: boolean, out: Float32Array, offset = 0): void {
    const { width, height } = this; const plane = width * height;
    const base = source * this.frameLength;
    for (let channel = 0; channel < 3; channel += 1) {
      for (let y = 0; y < height; y += 1) {
        const row = base + channel * plane + y * width, outRow = offset + channel * plane + y * width;
        if (mirror) for (let x = 0; x < width; x += 1) out[outRow + x] = this.frames[row + width - 1 - x] / 255 - 0.5;
        else for (let x = 0; x < width; x += 1) out[outRow + x] = this.frames[row + x] / 255 - 0.5;
      }
    }
  }

  /** Raw bytes of one frame, for saving a few examples. */
  frameBytes(i: number): Uint8Array { return this.frames.subarray(i * this.frameLength, (i + 1) * this.frameLength); }
}

export function computeTargetScale(data: VisionDataset, floor = 0.08): number[] {
  const scale: number[] = []; const n = data.estimateCount;
  for (let c = 0; c < n; c += 1) {
    let sum = 0, sumSquares = 0;
    for (let i = 0; i < data.size; i += 1) { const v = data.targets[i * n + c]; sum += v; sumSquares += v * v; }
    const mean = sum / Math.max(1, data.size);
    scale.push(Math.max(floor, Math.sqrt(Math.max(0, sumSquares / Math.max(1, data.size) - mean * mean))));
  }
  return scale;
}

export type TrainOptions = {
  domain: Domain;
  epochs: number; batch: number; learningRate: number; seed: number;
  targetScale: number[];
  /** Randomly mirror frames left-right and flip the matching labels. */
  mirror?: boolean;
  indices?: ArrayLike<number>;
  /** Override the domain's per-estimate loss weights (for focused fine-tuning). */
  weights?: readonly number[];
  actionWeight?: number;
  huberDelta?: number;
  log?: (message: string) => void;
  /** Called after each epoch; return false to stop early. */
  onEpoch?: (epoch: number, trainLoss: number) => boolean | void;
};

const LOGVAR_MIN = -7, LOGVAR_MAX = 3;

export function trainVision(net: VisionCnn, data: VisionDataset, options: TrainOptions): number[] {
  const random = mulberry32(options.seed);
  const n = data.estimateCount; const domain = options.domain;
  if (net.spec.outputs !== outputCountFor(n)) throw new Error("network outputs do not match the dataset");
  const indices = options.indices ? Array.from(options.indices) : Array.from({ length: data.size }, (_, i) => i);
  const image = new Float32Array(inputChannelCount(net.spec) * data.width * data.height);
  const body = new Float32Array(BODY_INPUTS); const dOut = new Float32Array(net.spec.outputs);
  const targets = new Float32Array(n); const mirrored = new Float32Array(n);
  const weights = options.weights ?? domain.trainingWeights;
  const actionWeight = options.actionWeight ?? 0.5; const delta = options.huberDelta ?? 1;
  const totalSteps = Math.max(1, options.epochs * Math.ceil(indices.length / options.batch)); let step = 0;
  const history: number[] = [];
  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    shuffleInPlace(indices, random);
    let epochLoss = 0, counted = 0;
    for (let start = 0; start < indices.length; start += options.batch) {
      const end = Math.min(indices.length, start + options.batch);
      for (let k = start; k < end; k += 1) {
        const i = indices[k]; const mirror = Boolean(options.mirror) && random() < 0.5;
        data.image(i, net.spec, mirror, image);
        body[0] = data.body[i * BODY_INPUTS]; body[1] = data.body[i * BODY_INPUTS + 1] * (mirror ? -1 : 1); body[2] = data.body[i * BODY_INPUTS + 2];
        for (let c = 0; c < n; c += 1) targets[c] = data.targets[i * n + c];
        if (mirror) { domain.mirror(targets, mirrored); for (let c = 0; c < n; c += 1) targets[c] = mirrored[c]; }
        const out = net.forward(image, body);
        dOut.fill(0); let loss = 0;
        for (let c = 0; c < n; c += 1) {
          const y = targets[c] / options.targetScale[c];
          const error = out[c] - y; const abs = Math.abs(error);
          loss += weights[c] * (abs <= delta ? 0.5 * error * error : delta * (abs - 0.5 * delta));
          dOut[c] = weights[c] * Math.max(-delta, Math.min(delta, error));
          const s = Math.min(LOGVAR_MAX, Math.max(LOGVAR_MIN, out[n + c]));
          const gradient = 0.5 * (1 - Math.exp(-s) * error * error);
          const pushesOut = (out[n + c] >= LOGVAR_MAX && gradient < 0) || (out[n + c] <= LOGVAR_MIN && gradient > 0);
          dOut[n + c] = pushesOut ? 0 : gradient * 0.3;
        }
        for (let a = 0; a < ACTION_GUESS_COUNT; a += 1) {
          const y = data.action[i * ACTION_GUESS_COUNT + a] * (mirror && a === 0 ? -1 : 1);
          const error = out[2 * n + a] - y; loss += actionWeight * 0.5 * error * error; dOut[2 * n + a] = actionWeight * error;
        }
        net.backward(dOut); epochLoss += loss; counted += 1;
      }
      step += 1;
      const progress = step / totalSteps; const warm = Math.min(1, step / 60);
      const rate = options.learningRate * warm * (0.04 + 0.96 * 0.5 * (1 + Math.cos(Math.PI * progress)));
      net.update(rate, end - start);
    }
    const mean = epochLoss / Math.max(1, counted); history.push(mean);
    options.log?.(`epoch ${epoch + 1}/${options.epochs}  loss ${mean.toFixed(4)}`);
    if (options.onEpoch?.(epoch, mean) === false) break;
  }
  return history;
}

/** Per-estimate accuracy and calibration on a set of samples. */
export function evaluateVision(net: VisionCnn, data: VisionDataset, indices: ArrayLike<number>, targetScale: number[], heldOut: string): VisionMetrics {
  const n = data.estimateCount;
  const image = new Float32Array(inputChannelCount(net.spec) * data.width * data.height); const body = new Float32Array(BODY_INPUTS);
  const sumSq = new Array(n).fill(0), sum = new Array(n).fill(0), sumY2 = new Array(n).fill(0), z2 = new Array(n).fill(0), cover = new Array(n).fill(0);
  for (let k = 0; k < indices.length; k += 1) {
    const i = indices[k]; data.image(i, net.spec, false, image);
    for (let j = 0; j < BODY_INPUTS; j += 1) body[j] = data.body[i * BODY_INPUTS + j];
    const out = net.forward(image, body);
    for (let c = 0; c < n; c += 1) {
      const y = data.targets[i * n + c]; const mean = out[c] * targetScale[c]; const error = mean - y;
      const variance = Math.exp(Math.min(LOGVAR_MAX, Math.max(LOGVAR_MIN, out[n + c]))) * targetScale[c] ** 2;
      sumSq[c] += error * error; sum[c] += y; sumY2[c] += y * y; z2[c] += error * error / variance; if (Math.abs(error) < 2 * Math.sqrt(variance)) cover[c] += 1;
    }
  }
  const count = Math.max(1, indices.length);
  const rmse = sumSq.map((v) => Math.sqrt(v / count));
  const r2 = sumSq.map((v, c) => { const mean = sum[c] / count; const variance = sumY2[c] / count - mean * mean; return variance > 1e-9 ? 1 - (v / count) / variance : 0; });
  return { rmse, r2, calibration: z2.map((v) => v / count), coverage: cover.map((v) => v / count), samples: indices.length, heldOut };
}
