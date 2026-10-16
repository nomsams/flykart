// The brains a run starts from: one or several saved brains (the repository's, files from the machine) become the
// founders of the first generation. Each is scored as it is; the best leads, the others stay in the breeding pool as
// mates, so a run can begin from everything that has been trained so far instead of from one brain.
import { SpikingNetwork, type BrainSnapshot } from "../core";
import { importFile } from "../vision/format";
import { widenBrain } from "../vision/inputs";
import { growBrain } from "./brain-size";

export type Founder = {
  /** File name or label, for the list on the page and the log. */
  name: string;
  brain: BrainSnapshot;
  /** Anything the person should know, e.g. that a 17-input brain was widened or that it was trained for the race track. */
  note: string;
};

/** The first population is mostly mutants of the founders; more founders than this would leave no room for them. */
export const MAX_FOUNDERS = 12;
/** Sizes Evolve can breed (the core accepts 8 to 512 hidden neurons). */
const MIN_HIDDEN = 8, MAX_HIDDEN = 512;

type Raw = { network?: BrainSnapshot; controller?: { network?: BrainSnapshot } } & Partial<BrainSnapshot>;

/**
 * Read any FlyKart brain file: an Evolve download, an original or Vision brain file, a repository checkpoint, or a bare
 * network. A 17-input brain gets the two sonar inputs appended at zero weight (it behaves as before until evolution
 * finds a use for them). Throws a sentence the person can act on.
 */
export function readFounder(text: string, name: string): Founder {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${name}: that is not a JSON file.`); }
  const r = raw as Raw | null;
  if (!r || typeof r !== "object") throw new Error(`${name}: expected a brain file.`);
  let snapshot: BrainSnapshot | undefined;
  let note = "";
  if (Array.isArray(r.inputWeights) && typeof r.hiddenCount === "number") snapshot = r as BrainSnapshot;
  else if (r.network && Array.isArray(r.network.inputWeights)) snapshot = r.network;
  else if (r.controller?.network && Array.isArray(r.controller.network.inputWeights)) snapshot = r.controller.network;
  else {
    // Vision brain files, v1 checkpoints and the like: use the same reader as the Vision page.
    try {
      const imported = importFile(text);
      snapshot = imported.controller?.snapshot ?? imported.world?.controller.snapshot;
      if (imported.controller?.domain === "track" && !imported.world) note = "trained for the race track: its inputs mean different things in the open world, so expect it to unlearn first";
    } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!snapshot) throw new Error(`${name}: no controller network found in this file.`);
  try { SpikingNetwork.fromJSON(snapshot); } catch (error) { throw new Error(`${name}: the network is not valid (${error instanceof Error ? error.message : String(error)}).`); }
  if (snapshot.hiddenCount < MIN_HIDDEN || snapshot.hiddenCount > MAX_HIDDEN) throw new Error(`${name}: ${snapshot.hiddenCount} hidden neurons is outside ${MIN_HIDDEN}-${MAX_HIDDEN}.`);
  if (snapshot.inputCount === 17) { snapshot = widenBrain(snapshot); note = note ? `${note}; widened from 17 to 19 inputs` : "widened from 17 to 19 inputs (sonar inputs start unused)"; }
  if (snapshot.inputCount !== 19) throw new Error(`${name}: a ${snapshot.inputCount}-input brain cannot be bred here; FlyKart Evolve uses 19 inputs (camera + sonar).`);
  return { name, brain: snapshot, note };
}

/** A fingerprint of the weights, to drop the same brain given twice (the repository's brain and a copy of it). */
function fingerprint(b: BrainSnapshot): string {
  let h = 2166136261;
  for (const list of [b.inputWeights, b.recurrentWeights, b.outputWeights, b.bias]) {
    for (const v of list) { h ^= Math.round(v * 1e6) & 0xffffffff; h = Math.imul(h, 16777619); }
    h ^= 0x9e3779b9; h = Math.imul(h, 16777619);
  }
  return `${b.hiddenCount}:${h >>> 0}`;
}

export type FounderSet = {
  /** The first founder, which leads the run until the exams say otherwise. */
  seed: BrainSnapshot;
  /** The rest, all grown to the common size. */
  others: BrainSnapshot[];
  /** What was done for each input, in order; for the log. */
  report: string[];
};

/**
 * Make a set of founders one population: duplicates are dropped, extras beyond MAX_FOUNDERS are ignored, and smaller
 * brains get inert extra neurons so that every founder has the size of the biggest (growing a brain this way does not
 * change what it does, see brain-size.ts), because a breeding pool needs one size to cross over.
 */
export function prepareFounders(founders: Founder[]): FounderSet {
  if (!founders.length) throw new Error("Choose at least one brain to start from.");
  const report: string[] = [];
  const seen = new Set<string>(), unique: Founder[] = [];
  for (const f of founders) {
    const key = fingerprint(f.brain);
    if (seen.has(key)) { report.push(`${f.name}: identical to an earlier brain, kept once`); continue; }
    seen.add(key); unique.push(f);
  }
  if (unique.length > MAX_FOUNDERS) {
    report.push(`${unique.length - MAX_FOUNDERS} brain(s) beyond the first ${MAX_FOUNDERS} left out`);
    unique.length = MAX_FOUNDERS;
  }
  const target = Math.max(...unique.map((f) => f.brain.hiddenCount));
  const brains = unique.map((f, k) => {
    const grown = f.brain.hiddenCount < target;
    report.push(`${f.name}: ${f.brain.inputCount} → ${f.brain.hiddenCount}${grown ? ` (grown to ${target})` : ""} → 4${f.note ? ` · ${f.note}` : ""}`);
    return grown ? growBrain(f.brain, target - f.brain.hiddenCount, 7000 + k) : f.brain;
  });
  return { seed: brains[0], others: brains.slice(1), report };
}
