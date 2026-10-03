// Turning a domain's estimates, the body's feedback and (optionally) a sonar reading into the controller's input vector.
//
// The original controller reads 17 numbers. A controller that also listens to a sonar reads 19: the same 17, then
// the echo's closeness and its strength. A 19-input brain started from a 17-input one (see `widenBrain`) behaves
// identically until evolution gives the new inputs a job, because their weights start at zero.
import { BrainSnapshot } from "../core";
import type { Domain, VisionEpisode } from "./domain";
import type { Proprioception } from "./interface";
import { SONAR_INPUTS, SONAR_USEFUL_RANGE_PX } from "./robot";
import { SonarReading, sonarInputs } from "./sonar";

export const BASE_INPUTS = 17;
export const SONAR_INPUT_COUNT = BASE_INPUTS + SONAR_INPUTS;

export function assembleInputs(domain: Domain, estimates: ArrayLike<number>, mission: ArrayLike<number>, body: Proprioception, sonar: SonarReading | null, inputCount: number, out: number[] = new Array(inputCount).fill(0)): number[] {
  domain.sensors(estimates, mission, body, out);
  if (inputCount > BASE_INPUTS) {
    if (sonar) { const pair = sonarInputs(sonar, SONAR_USEFUL_RANGE_PX); out[BASE_INPUTS] = pair[0]; out[BASE_INPUTS + 1] = pair[1]; }
    else { out[BASE_INPUTS] = 0; out[BASE_INPUTS + 1] = 0; }
  }
  return out;
}

/** The inputs a teacher with exact numbers would see for the episode's current state. */
export function teacherInputs(domain: Domain, episode: VisionEpisode, truth: ArrayLike<number>, inputCount: number, out?: number[]): number[] {
  return assembleInputs(domain, truth, episode.mission(), episode.proprioception(), episode.sonar(), inputCount, out);
}

/** Give a 17-input brain two sonar inputs with zero weights: it drives exactly as before until they are used. */
export function widenBrain(snapshot: BrainSnapshot): BrainSnapshot {
  if (snapshot.inputCount === SONAR_INPUT_COUNT) return snapshot;
  if (snapshot.inputCount !== BASE_INPUTS) throw new Error("only a 17-input brain can be given sonar inputs");
  const hidden = snapshot.hiddenCount; const inputWeights: number[] = [];
  for (let neuron = 0; neuron < hidden; neuron += 1) {
    for (let input = 0; input < BASE_INPUTS; input += 1) inputWeights.push(snapshot.inputWeights[neuron * BASE_INPUTS + input]);
    for (let extra = 0; extra < SONAR_INPUTS; extra += 1) inputWeights.push(0);
  }
  return { ...snapshot, inputCount: SONAR_INPUT_COUNT, inputWeights };
}

/** The reverse, for handing a sonar brain to the original app: the sonar inputs are dropped, so it will drive differently. */
export function narrowBrain(snapshot: BrainSnapshot): BrainSnapshot {
  if (snapshot.inputCount === BASE_INPUTS) return snapshot;
  const hidden = snapshot.hiddenCount; const inputWeights: number[] = [];
  for (let neuron = 0; neuron < hidden; neuron += 1) for (let input = 0; input < BASE_INPUTS; input += 1) inputWeights.push(snapshot.inputWeights[neuron * snapshot.inputCount + input]);
  return { ...snapshot, inputCount: BASE_INPUTS, inputWeights };
}

/**
 * An innate "looming" reflex for the sonar, in the spirit of the fly's escape response: a close echo drives the
 * neurons that brake and silences the ones that accelerate. The sonar knows how far, not which way, so steering
 * around the obstacle is left to the camera. Evolution is free to rewire all of it.
 */
export function wireSonarReflex(snapshot: BrainSnapshot, strength = 0.9, count = 8): BrainSnapshot {
  const widened = widenBrain(snapshot); const hidden = widened.hiddenCount;
  const inputWeights = [...widened.inputWeights];
  const effect = Array.from({ length: hidden }, (_, j) => ({ j, drive: widened.outputWeights[hidden + j] - widened.outputWeights[2 * hidden + j] }));
  const brakers = [...effect].sort((a, b) => a.drive - b.drive).slice(0, count);
  const drivers = [...effect].sort((a, b) => b.drive - a.drive).slice(0, count);
  for (const { j } of brakers) inputWeights[j * SONAR_INPUT_COUNT + BASE_INPUTS] = strength;
  for (const { j } of drivers) inputWeights[j * SONAR_INPUT_COUNT + BASE_INPUTS] = -strength;
  return { ...widened, inputWeights };
}
