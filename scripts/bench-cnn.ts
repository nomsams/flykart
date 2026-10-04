import { VisionCnn } from "../src/vision/cnn";
import { defaultSpec } from "../src/vision/perception";
for (const spec of [defaultSpec(2), { ...defaultSpec(2), channels: [8, 16, 24] as [number, number, number], hidden: 64 }]) {
  const net = new VisionCnn(spec, 1);
  const image = new Float32Array(spec.frames * 3 * spec.width * spec.height).map(() => Math.random() - 0.5);
  const body = new Float32Array(3); const d = new Float32Array(spec.outputs).fill(0.01);
  for (let i = 0; i < 100; i += 1) { net.forward(image, body); net.backward(d); }
  const t0 = performance.now(); const n = 1500;
  for (let i = 0; i < n; i += 1) { net.forward(image, body); net.backward(d); if (i % 32 === 31) net.update(1e-4, 32); }
  const ms = performance.now() - t0;
  const t1 = performance.now(); for (let i = 0; i < n; i += 1) net.forward(image, body); const fwd = performance.now() - t1;
  console.log(JSON.stringify(spec.channels), spec.hidden, "params", net.parameterCount, "MACs", net.macs, `train ${(ms / n).toFixed(2)} ms/sample, forward ${(fwd / n).toFixed(2)} ms`);
}
