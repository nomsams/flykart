import { describe, expect, it } from "vitest";
import { NetSpec, VisionCnn, decodeFloats, encodeFloats } from "./cnn";
import { inputChannelCount } from "./retina";
import { mulberry32 } from "./rng";

const base = { width: 16, height: 8, frames: 2, channels: [3, 4, 4] as [number, number, number], hidden: 6, extra: 3, outputs: 5 };
const variants: NetSpec[] = [{ ...base }, { ...base, input: "retina", spatial: true }];
let spec = variants[0];

function setup() {
  const net = new VisionCnn(spec, 3);
  const random = mulberry32(5);
  const image = Float32Array.from({ length: inputChannelCount(spec) * spec.width * spec.height }, () => random() - 0.5);
  const extra = [0.3, -0.2, 0.5];
  const target = Float32Array.from({ length: spec.outputs }, () => random() - 0.5);
  const loss = () => { const out = net.forward(image, extra); let total = 0; for (let i = 0; i < out.length; i += 1) total += 0.5 * (out[i] - target[i]) ** 2; return total; };
  return { net, image, extra, target, loss };
}

describe.each(variants.map((variant) => [variant.spatial ? "retina input with soft-argmax" : "plain input", variant] as const))("VisionCnn (%s)", (_name, variant) => {
  spec = variant;
  it("back-propagates the same gradient as finite differences", () => {
    const { net, image, extra, target, loss } = setup();
    const out = net.forward(image, extra);
    net.zeroGrad(); net.backward(Float32Array.from(out, (value, i) => value - target[i]));
    const analytic = Float32Array.from(net.grads);
    let checked = 0, worst = 0;
    const random = mulberry32(11);
    for (let n = 0; n < 160; n += 1) {
      const index = Math.floor(random() * net.params.length);
      const keep = net.params[index]; const h = 1e-3;
      net.params[index] = keep + h; const up = loss(); net.params[index] = keep - h; const down = loss(); net.params[index] = keep;
      const numeric = (up - down) / (2 * h);
      if (Math.abs(numeric) < 2e-4 && Math.abs(analytic[index]) < 2e-4) continue;
      checked += 1; worst = Math.max(worst, Math.abs(numeric - analytic[index]) / Math.max(1e-3, Math.abs(numeric) + Math.abs(analytic[index])));
    }
    expect(checked).toBeGreaterThan(30);
    expect(worst).toBeLessThan(0.05);
  });

  it("learns a simple regression", () => {
    const { net, image, extra, target } = setup();
    const first = (() => { const o = net.forward(image, extra); return o.reduce((s, v, i) => s + (v - target[i]) ** 2, 0); })();
    for (let step = 0; step < 150; step += 1) {
      const out = net.forward(image, extra);
      net.backward(Float32Array.from(out, (value, i) => value - target[i]));
      net.update(0.01, 1);
    }
    const last = net.forward(image, extra).reduce((s, v, i) => s + (v - target[i]) ** 2, 0);
    expect(last).toBeLessThan(first * 0.05);
  });

  it("survives a round trip through base64", () => {
    const { net } = setup();
    const copy = decodeFloats(encodeFloats(net.params));
    expect(Array.from(copy)).toEqual(Array.from(net.params));
  });

  it("is deterministic for a given seed", () => {
    expect(Array.from(new VisionCnn(spec, 9).params)).toEqual(Array.from(new VisionCnn(spec, 9).params));
    expect(Array.from(new VisionCnn(spec, 9).params)).not.toEqual(Array.from(new VisionCnn(spec, 10).params));
  });
});
