// A "domain" is a world a kart can be dropped into: the race track, or the
// open world. Everything else in FlyKart Vision (camera network, fusion,
// DAgger, the driver) is written against these two small interfaces, which is
// what lets the same logic carry from a lap of asphalt to a field of trees.
import type { Action } from "../core";
import type { Proprioception } from "./interface";
import type { SonarReading } from "./sonar";

export interface VisionEpisode {
  readonly done: boolean;
  readonly tick: number;
  readonly frame: Float32Array;
  render(): Float32Array;
  /** Speed and the last commands: what the body knows without looking. */
  proprioception(): Proprioception;
  /** Ground truth for the domain's estimates (what a perfect eye would report). */
  truth(out?: number[]): number[];
  /** Values that come from a planner or compass rather than the camera, such as the bearing of the next goal. */
  mission(): number[];
  step(action: Action): void;
  /** The sonar's latest reading (held between pings), or null when the robot has none. */
  sonar(): SonarReading | null;
  /** Bookkeeping for the lap memory; null where laps do not exist. */
  lapContext(): { gate: number; heading: number; x: number; y: number; speed: number } | null;
  /** How the episode is going: laps cover a fraction of the track, worlds count goals reached. */
  summary(): { progress: number; finished: boolean; crashed: boolean };
}

export interface Domain {
  readonly id: "track" | "world";
  readonly title: string;
  readonly estimateNames: readonly string[];
  readonly estimateLabels: readonly string[];
  readonly estimateCount: number;
  /** Assemble the controller's 17 inputs from estimates, mission values and body feedback. */
  sensors(estimates: ArrayLike<number>, mission: ArrayLike<number>, body: Proprioception, out?: number[]): number[];
  /** Write the estimates as they would look in a left-right mirrored world. */
  mirror(estimates: ArrayLike<number>, out: Float32Array | number[]): void;
  /** How hard each estimate is to see, for simulating imperfect eyes (1 = typical). */
  readonly noiseScale: readonly number[];
  /** Which estimates the weights should emphasise during training. */
  readonly trainingWeights: readonly number[];
}
