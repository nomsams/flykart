// A hard-wired front end for the camera network, in the spirit of the fly's
// lamina and medulla: before anything is learned, the image is split into
// colour-opponent and centre-surround signals, so small bright objects and
// edges stand out from large flat areas of road, grass and sky.
//
//   planes: R, G, B  (the picture as it is)
//           red − green, blue − yellow  (colour opponency: a cone or kart is not grey, grass is not red)
//           centre − surround of brightness  (a small blob against its neighbourhood, and edges)
//           brightness of the previous frame  (so motion is a difference the network can learn)
export type InputMode = "rgb" | "retina";

export const RETINA_CURRENT_PLANES = 6;

export function inputChannelCount(spec: { frames: number; input?: InputMode }): number {
  return spec.input === "retina" ? RETINA_CURRENT_PLANES + (spec.frames > 1 ? 1 : 0) : spec.frames * 3;
}

/**
 * Fill `out` with the input planes. `current` and `previous` hold three
 * centred colour planes (values around -0.5..0.5); `previous` may be null.
 */
export function retinaPlanes(current: ArrayLike<number>, previous: ArrayLike<number> | null, width: number, height: number, out: Float32Array): void {
  const plane = width * height;
  for (let i = 0; i < plane; i += 1) {
    const r = current[i], g = current[plane + i], b = current[2 * plane + i];
    out[i] = r; out[plane + i] = g; out[2 * plane + i] = b;
    out[3 * plane + i] = (r - g) * 1.5;
    out[4 * plane + i] = ((r + g) / 2 - b) * 1.5;
  }
  // Centre-surround: brightness minus the mean brightness of the 3x3 neighbourhood.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          const at = yy * width + xx; sum += 0.3 * current[at] + 0.59 * current[plane + at] + 0.11 * current[2 * plane + at]; count += 1;
        }
      }
      const at = y * width + x;
      out[5 * plane + at] = (0.3 * current[at] + 0.59 * current[plane + at] + 0.11 * current[2 * plane + at] - sum / count) * 4;
    }
  }
  if (previous) for (let i = 0; i < plane; i += 1) out[RETINA_CURRENT_PLANES * plane + i] = 0.3 * previous[i] + 0.59 * previous[plane + i] + 0.11 * previous[2 * plane + i];
}
