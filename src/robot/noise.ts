import { clamp } from "../core";
import { gaussian, mulberry32 } from "../vision/rng";

export type SensorNoise = { cameraSigma: number; cameraDropout: number; brightness: number; sonarSigmaCm: number; sonarDropout: number; seed: number };
export const DEFAULT_NOISE: SensorNoise = { cameraSigma: 0, cameraDropout: 0, brightness: 1, sonarSigmaCm: 0, sonarDropout: 0, seed: 2048 };
export const NOISE_PRESETS: Record<string, SensorNoise> = { clean: DEFAULT_NOISE, mild: { ...DEFAULT_NOISE, cameraSigma: 8, sonarSigmaCm: 1, sonarDropout: .02 }, harsh: { ...DEFAULT_NOISE, cameraSigma: 24, cameraDropout: .1, brightness: .55, sonarSigmaCm: 4, sonarDropout: .15 } };
export function validateNoise(raw: unknown): SensorNoise {
  const n = raw as SensorNoise;
  if (!n || ![n.cameraSigma, n.cameraDropout, n.brightness, n.sonarSigmaCm, n.sonarDropout, n.seed].every(Number.isFinite) || n.cameraSigma < 0 || n.cameraSigma > 60 || n.cameraDropout < 0 || n.cameraDropout > 1 || n.brightness < .1 || n.brightness > 2 || n.sonarSigmaCm < 0 || n.sonarSigmaCm > 30 || n.sonarDropout < 0 || n.sonarDropout > 1 || !Number.isInteger(n.seed) || n.seed < 0 || n.seed > 2147483647) throw new Error("Invalid sensor noise settings.");
  return { cameraSigma: n.cameraSigma, cameraDropout: n.cameraDropout, brightness: n.brightness, sonarSigmaCm: n.sonarSigmaCm, sonarDropout: n.sonarDropout, seed: n.seed };
}
export class NoiseSource {
  private cameraRandom: () => number;
  private sonarRandom: () => number;
  constructor(public config = { ...DEFAULT_NOISE }) { this.cameraRandom = mulberry32(config.seed); this.sonarRandom = mulberry32(config.seed ^ 87213); }
  camera(pixels: Uint8ClampedArray): boolean {
    const n = this.config, dropped = this.cameraRandom() < n.cameraDropout;
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) pixels[i + c] = dropped ? 0 : clamp(pixels[i + c] * n.brightness + (n.cameraSigma ? gaussian(this.cameraRandom) * n.cameraSigma : 0), 0, 255);
      pixels[i + 3] = 255;
    }
    return dropped;
  }
  sonar(metres: number, echo: boolean): { metres: number; echo: boolean } {
    const dropped = this.sonarRandom() < this.config.sonarDropout;
    return echo && !dropped ? { metres: clamp(metres + (this.config.sonarSigmaCm ? gaussian(this.sonarRandom) * this.config.sonarSigmaCm / 100 : 0), .02, 4), echo: true } : { metres: 4, echo: false };
  }
}
