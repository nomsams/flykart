// A small convolutional network with hand-written back-propagation and Adam.
// Plain typed-array TypeScript: it trains in a Node script, runs in the
// browser, and needs no WebGL, WASM or dependencies.
//
//   image planes -> conv3x3/2 -> conv3x3/2 -> conv3x3/2 -> flatten
//                                 └─> spatial soft-argmax of the second layer's maps: where is each feature, and how strongly (optional)
//   [flattened features, soft-argmax features, body feedback] -> dense (the "embedding") -> linear head
//
// The soft-argmax layer (Levine et al. 2016) turns "a blob-like feature fires somewhere" into coordinates the
// next layer can use directly. Small objects at varying positions would otherwise need a great deal of data.
//
// Every activation map is kept with a one-pixel zero border so the 3×3 taps
// need no bounds checks and can be unrolled; that is most of the speed.
import { InputMode, inputChannelCount } from "./retina";
import { gaussian, mulberry32 } from "./rng";

export type NetSpec = {
  width: number; height: number;
  /** Number of stacked RGB frames (2 lets the net see motion). */
  frames: number;
  /** "rgb" feeds the pictures as they are; "retina" adds colour-opponent and centre-surround planes first. */
  input?: InputMode;
  channels: [number, number, number];
  hidden: number;
  /** Extra scalar inputs appended after the convolutional features (body feedback). */
  extra: number;
  outputs: number;
  /** Add soft-argmax position features from the second convolution's maps. */
  spatial?: boolean;
};

/** Sharpness of the soft-argmax. */
const BETA = 3;

type ConvLayer = { inC: number; inH: number; inW: number; outC: number; outH: number; outW: number; weight: number; bias: number; weights: number };

const outSize = (n: number): number => Math.floor((n + 2 - 3) / 2) + 1;

export class VisionCnn {
  readonly params: Float32Array;
  readonly grads: Float32Array;
  private readonly m: Float32Array;
  private readonly v: Float32Array;
  private adamStep = 0;
  private readonly convs: ConvLayer[] = [];
  private readonly acts: Float32Array[] = [];
  private readonly deltas: Float32Array[] = [];
  private readonly padded: Float32Array;
  private readonly flatSize: number;
  private readonly spatialSize: number;
  private readonly spatialProb: Float32Array; private readonly spatialFeature: Float32Array; private readonly spatialGrad: Float32Array;
  private readonly denseIn: number;
  private readonly denseW: number; private readonly denseB: number; private readonly headW: number; private readonly headB: number;
  private readonly joined: Float32Array;
  readonly embedding: Float32Array; readonly output: Float32Array;
  private readonly dJoined: Float32Array; private readonly dEmbedding: Float32Array;

  constructor(readonly spec: NetSpec, seed = 1, initial?: Float32Array) {
    let offset = 0;
    let inC = inputChannelCount(spec), inH = spec.height, inW = spec.width;
    for (const outC of spec.channels) {
      const outH = outSize(inH), outW = outSize(inW);
      const weights = outC * inC * 9;
      this.convs.push({ inC, inH, inW, outC, outH, outW, weight: offset, bias: offset + weights, weights });
      offset += weights + outC;
      this.acts.push(new Float32Array(outC * (outH + 2) * (outW + 2))); this.deltas.push(new Float32Array(outC * (outH + 2) * (outW + 2)));
      inC = outC; inH = outH; inW = outW;
    }
    this.flatSize = inC * inH * inW;
    const second = this.convs[1];
    this.spatialSize = spec.spatial ? second.outC * 3 : 0;
    this.spatialProb = new Float32Array(spec.spatial ? second.outC * second.outH * second.outW : 0); this.spatialFeature = new Float32Array(this.spatialSize); this.spatialGrad = new Float32Array(this.spatialSize);
    this.denseIn = this.flatSize + this.spatialSize + spec.extra;
    this.denseW = offset; offset += this.denseIn * spec.hidden; this.denseB = offset; offset += spec.hidden;
    this.headW = offset; offset += spec.hidden * spec.outputs; this.headB = offset; offset += spec.outputs;
    this.params = new Float32Array(offset); this.grads = new Float32Array(offset); this.m = new Float32Array(offset); this.v = new Float32Array(offset);
    this.padded = new Float32Array(inputChannelCount(spec) * (spec.height + 2) * (spec.width + 2));
    this.joined = new Float32Array(this.denseIn); this.dJoined = new Float32Array(this.denseIn);
    this.embedding = new Float32Array(spec.hidden); this.dEmbedding = new Float32Array(spec.hidden);
    this.output = new Float32Array(spec.outputs);
    if (initial) this.params.set(initial); else this.initialise(seed);
  }

  private initialise(seed: number): void {
    const random = mulberry32(seed);
    const fill = (start: number, count: number, fanIn: number, gain: number): void => { const std = Math.sqrt(2 / fanIn) * gain; for (let i = 0; i < count; i += 1) this.params[start + i] = gaussian(random) * std; };
    for (const layer of this.convs) fill(layer.weight, layer.weights, layer.inC * 9, 1);
    fill(this.denseW, this.denseIn * this.spec.hidden, this.denseIn, 1);
    fill(this.headW, this.spec.hidden * this.spec.outputs, this.spec.hidden, 0.25);
  }

  get parameterCount(): number { return this.params.length; }
  get embeddingSize(): number { return this.spec.hidden; }

  /** Multiply-accumulates in one forward pass (for the write-up). */
  get macs(): number {
    return this.convs.reduce((sum, l) => sum + l.outC * l.outH * l.outW * l.inC * 9, 0) + this.denseIn * this.spec.hidden + this.spec.hidden * this.spec.outputs;
  }

  /** `image` holds the input planes (see `inputChannelCount`) already scaled to roughly [-0.5, 0.5]. Returns the raw head outputs. */
  forward(image: Float32Array, extra: ArrayLike<number>): Float32Array {
    const { width, height } = this.spec; const wp = width + 2, hp = height + 2;
    for (let c = 0; c < inputChannelCount(this.spec); c += 1) {
      for (let y = 0; y < height; y += 1) {
        const from = (c * height + y) * width, to = (c * hp + y + 1) * wp + 1;
        for (let x = 0; x < width; x += 1) this.padded[to + x] = image[from + x];
      }
    }
    let previous: Float32Array = this.padded;
    for (let l = 0; l < this.convs.length; l += 1) { convForward(previous, this.params, this.convs[l], this.acts[l]); previous = this.acts[l]; }
    const joined = this.joined;
    {
      const last = this.convs[this.convs.length - 1]; const lw = last.outW + 2; let at = 0;
      for (let c = 0; c < last.outC; c += 1) for (let y = 0; y < last.outH; y += 1) { const row = (c * (last.outH + 2) + y + 1) * lw + 1; for (let x = 0; x < last.outW; x += 1) joined[at++] = previous[row + x]; }
    }
    if (this.spatialSize > 0) { this.spatialForward(); joined.set(this.spatialFeature, this.flatSize); }
    for (let i = 0; i < this.spec.extra; i += 1) joined[this.flatSize + this.spatialSize + i] = extra[i];
    const hidden = this.spec.hidden, params = this.params;
    for (let h = 0; h < hidden; h += 1) {
      let sum = params[this.denseB + h]; const base = this.denseW + h * this.denseIn;
      for (let i = 0; i < this.denseIn; i += 1) sum += params[base + i] * joined[i];
      this.embedding[h] = sum > 0 ? sum : 0;
    }
    const outputs = this.spec.outputs;
    for (let o = 0; o < outputs; o += 1) {
      let sum = params[this.headB + o]; const base = this.headW + o * hidden;
      for (let h = 0; h < hidden; h += 1) sum += params[base + h] * this.embedding[h];
      this.output[o] = sum;
    }
    return this.output;
  }

  /** Back-propagate d(loss)/d(output) from the most recent forward pass, adding to the gradient buffers. */
  backward(dOutput: ArrayLike<number>): void {
    const hidden = this.spec.hidden, outputs = this.spec.outputs, params = this.params, grads = this.grads;
    this.dEmbedding.fill(0);
    for (let o = 0; o < outputs; o += 1) {
      const g = dOutput[o]; if (g === 0) continue;
      grads[this.headB + o] += g; const base = this.headW + o * hidden;
      for (let h = 0; h < hidden; h += 1) { grads[base + h] += g * this.embedding[h]; this.dEmbedding[h] += g * params[base + h]; }
    }
    this.dJoined.fill(0);
    for (let h = 0; h < hidden; h += 1) {
      if (this.embedding[h] <= 0) continue;
      const g = this.dEmbedding[h]; grads[this.denseB + h] += g; const base = this.denseW + h * this.denseIn;
      for (let i = 0; i < this.denseIn; i += 1) { grads[base + i] += g * this.joined[i]; this.dJoined[i] += g * params[base + i]; }
    }
    const last = this.convs.length - 1;
    {
      const layer = this.convs[last]; const lw = layer.outW + 2; let at = 0; this.deltas[last].fill(0);
      for (let c = 0; c < layer.outC; c += 1) for (let y = 0; y < layer.outH; y += 1) { const row = (c * (layer.outH + 2) + y + 1) * lw + 1; for (let x = 0; x < layer.outW; x += 1) this.deltas[last][row + x] = this.dJoined[at++]; }
    }
    if (this.spatialSize > 0) this.spatialGrad.set(this.dJoined.subarray(this.flatSize, this.flatSize + this.spatialSize));
    for (let l = last; l >= 0; l -= 1) {
      convBackward(l === 0 ? this.padded : this.acts[l - 1], this.params, this.grads, this.convs[l], this.acts[l], this.deltas[l], l === 0 ? null : this.deltas[l - 1]);
      if (l === 2 && this.spatialSize > 0) this.spatialBackward();
    }
  }

  /** For each channel of the second layer: softmax over its map, then the expected x, expected y and a smooth maximum. */
  private spatialForward(): void {
    const layer = this.convs[1]; const act = this.acts[1]; const wp = layer.outW + 2, plane = (layer.outH + 2) * wp;
    const { outC, outH, outW } = layer; const cells = outH * outW;
    for (let c = 0; c < outC; c += 1) {
      let peak = -Infinity;
      for (let y = 0; y < outH; y += 1) for (let x = 0; x < outW; x += 1) { const v = act[c * plane + (y + 1) * wp + x + 1]; if (v > peak) peak = v; }
      let total = 0;
      for (let y = 0; y < outH; y += 1) for (let x = 0; x < outW; x += 1) { const e = Math.exp(BETA * (act[c * plane + (y + 1) * wp + x + 1] - peak)); this.spatialProb[c * cells + y * outW + x] = e; total += e; }
      let mx = 0, my = 0;
      for (let y = 0; y < outH; y += 1) for (let x = 0; x < outW; x += 1) {
        const at = c * cells + y * outW + x; this.spatialProb[at] /= total;
        mx += this.spatialProb[at] * (((x + 0.5) / outW) * 2 - 1); my += this.spatialProb[at] * (((y + 0.5) / outH) * 2 - 1);
      }
      this.spatialFeature[c * 3] = mx; this.spatialFeature[c * 3 + 1] = my;
      // smooth maximum: (1/β) ln mean(exp(β a))
      this.spatialFeature[c * 3 + 2] = peak + Math.log(total / cells) / BETA;
    }
  }

  /** Add d(loss)/d(second-layer maps) coming through the soft-argmax features. */
  private spatialBackward(): void {
    const layer = this.convs[1]; const delta = this.deltas[1]; const wp = layer.outW + 2, plane = (layer.outH + 2) * wp;
    const { outC, outH, outW } = layer; const cells = outH * outW;
    for (let c = 0; c < outC; c += 1) {
      const gx = this.spatialGrad[c * 3], gy = this.spatialGrad[c * 3 + 1], gs = this.spatialGrad[c * 3 + 2];
      const mx = this.spatialFeature[c * 3], my = this.spatialFeature[c * 3 + 1];
      for (let y = 0; y < outH; y += 1) for (let x = 0; x < outW; x += 1) {
        const p = this.spatialProb[c * cells + y * outW + x];
        delta[c * plane + (y + 1) * wp + x + 1] += p * (BETA * (gx * ((((x + 0.5) / outW) * 2 - 1) - mx) + gy * ((((y + 0.5) / outH) * 2 - 1) - my)) + gs);
      }
    }
  }

  zeroGrad(): void { this.grads.fill(0); }

  /** One AdamW update using the accumulated gradients divided by `batch`. */
  update(learningRate: number, batch: number, weightDecay = 1e-5, clip = 5): void {
    this.adamStep += 1;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const c1 = 1 - Math.pow(b1, this.adamStep), c2 = 1 - Math.pow(b2, this.adamStep);
    let norm = 0; for (let i = 0; i < this.grads.length; i += 1) { const g = this.grads[i] / batch; norm += g * g; }
    const scale = Math.sqrt(norm) > clip ? clip / Math.sqrt(norm) : 1;
    for (let i = 0; i < this.params.length; i += 1) {
      const g = (this.grads[i] / batch) * scale;
      this.m[i] = b1 * this.m[i] + (1 - b1) * g; this.v[i] = b2 * this.v[i] + (1 - b2) * g * g;
      this.params[i] -= learningRate * ((this.m[i] / c1) / (Math.sqrt(this.v[i] / c2) + eps) + weightDecay * this.params[i]);
    }
    this.grads.fill(0);
  }
}

function convForward(input: Float32Array, params: Float32Array, layer: ConvLayer, output: Float32Array): void {
  const { inC, inH, inW, outC, outH, outW } = layer;
  const inWp = inW + 2, inPlane = (inH + 2) * inWp, outWp = outW + 2, outPlane = (outH + 2) * outWp;
  for (let oc = 0; oc < outC; oc += 1) {
    const outBase = oc * outPlane; const bias = params[layer.bias + oc];
    for (let oy = 0; oy < outH; oy += 1) { const row = outBase + (oy + 1) * outWp + 1; for (let ox = 0; ox < outW; ox += 1) output[row + ox] = bias; }
    for (let ic = 0; ic < inC; ic += 1) {
      const w = layer.weight + (oc * inC + ic) * 9;
      const w0 = params[w], w1 = params[w + 1], w2 = params[w + 2], w3 = params[w + 3], w4 = params[w + 4], w5 = params[w + 5], w6 = params[w + 6], w7 = params[w + 7], w8 = params[w + 8];
      const inBase = ic * inPlane;
      for (let oy = 0; oy < outH; oy += 1) {
        const r0 = inBase + oy * 2 * inWp, r1 = r0 + inWp, r2 = r1 + inWp; let o = outBase + (oy + 1) * outWp + 1;
        for (let ox = 0; ox < outW; ox += 1, o += 1) {
          const p = ox * 2;
          output[o] += w0 * input[r0 + p] + w1 * input[r0 + p + 1] + w2 * input[r0 + p + 2] + w3 * input[r1 + p] + w4 * input[r1 + p + 1] + w5 * input[r1 + p + 2] + w6 * input[r2 + p] + w7 * input[r2 + p + 1] + w8 * input[r2 + p + 2];
        }
      }
    }
    for (let oy = 0; oy < outH; oy += 1) { const row = outBase + (oy + 1) * outWp + 1; for (let ox = 0; ox < outW; ox += 1) if (output[row + ox] < 0) output[row + ox] = 0; }
  }
}

function convBackward(input: Float32Array, params: Float32Array, grads: Float32Array, layer: ConvLayer, output: Float32Array, dOutput: Float32Array, dInput: Float32Array | null): void {
  const { inC, inH, inW, outC, outH, outW } = layer;
  const inWp = inW + 2, inPlane = (inH + 2) * inWp, outWp = outW + 2, outPlane = (outH + 2) * outWp;
  if (dInput) dInput.fill(0);
  for (let oc = 0; oc < outC; oc += 1) {
    const outBase = oc * outPlane;
    // Gate the incoming gradient by the ReLU and total it for the bias.
    let biasGrad = 0, live = 0;
    for (let oy = 0; oy < outH; oy += 1) {
      const row = outBase + (oy + 1) * outWp + 1;
      for (let ox = 0; ox < outW; ox += 1) { if (output[row + ox] <= 0) dOutput[row + ox] = 0; else { biasGrad += dOutput[row + ox]; if (dOutput[row + ox] !== 0) live += 1; } }
    }
    grads[layer.bias + oc] += biasGrad;
    if (live === 0) continue;
    for (let ic = 0; ic < inC; ic += 1) {
      const w = layer.weight + (oc * inC + ic) * 9;
      const w0 = params[w], w1 = params[w + 1], w2 = params[w + 2], w3 = params[w + 3], w4 = params[w + 4], w5 = params[w + 5], w6 = params[w + 6], w7 = params[w + 7], w8 = params[w + 8];
      let g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0, g8 = 0;
      const inBase = ic * inPlane;
      for (let oy = 0; oy < outH; oy += 1) {
        const r0 = inBase + oy * 2 * inWp, r1 = r0 + inWp, r2 = r1 + inWp; let o = outBase + (oy + 1) * outWp + 1;
        for (let ox = 0; ox < outW; ox += 1, o += 1) {
          const g = dOutput[o]; if (g === 0) continue;
          const p = ox * 2;
          g0 += g * input[r0 + p]; g1 += g * input[r0 + p + 1]; g2 += g * input[r0 + p + 2];
          g3 += g * input[r1 + p]; g4 += g * input[r1 + p + 1]; g5 += g * input[r1 + p + 2];
          g6 += g * input[r2 + p]; g7 += g * input[r2 + p + 1]; g8 += g * input[r2 + p + 2];
          if (dInput) {
            dInput[r0 + p] += g * w0; dInput[r0 + p + 1] += g * w1; dInput[r0 + p + 2] += g * w2;
            dInput[r1 + p] += g * w3; dInput[r1 + p + 1] += g * w4; dInput[r1 + p + 2] += g * w5;
            dInput[r2 + p] += g * w6; dInput[r2 + p + 1] += g * w7; dInput[r2 + p + 2] += g * w8;
          }
        }
      }
      grads[w] += g0; grads[w + 1] += g1; grads[w + 2] += g2; grads[w + 3] += g3; grads[w + 4] += g4; grads[w + 5] += g5; grads[w + 6] += g6; grads[w + 7] += g7; grads[w + 8] += g8;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

export function encodeFloats(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let text = ""; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function decodeFloats(text: string): Float32Array {
  const raw = atob(text); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
