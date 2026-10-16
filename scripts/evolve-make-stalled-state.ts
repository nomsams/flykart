// Writes a small saved run that stopped at its second stage, for the browser check: stage 1 was moved on from without
// being mastered, stage 2 then stopped on a goal that cannot be reached. Tiny climbs, so it takes a few seconds.
//
//   npx vite-node scripts/evolve-make-stalled-state.ts .cache/stalled-state.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SpikingNetwork } from "../src/core";
import { InlineBackend } from "../src/evolve/backend";
import { EvolutionEngine } from "../src/evolve/engine";

const out = process.argv[2] ?? ".cache/stalled-state.json";
const engine = EvolutionEngine.fresh(new SpikingNetwork(21, 19).toJSON(), {
  population: 6, parents: 3, elites: 1, battery: 2, examSize: 2, examEvery: 1, patience: 2, tournamentSize: 2,
  branchesPerStage: 1, maxGenerationsPerBranch: 3, lastStage: 2, runSeed: 5, keepPerStage: 2, maxClimbsPerStage: 3, stageStall: 99,
}, new InlineBackend());
engine.state.goals = { 0: 2, 1: 2 };
await engine.run(() => engine.state.stalled !== null && engine.state.stalled !== undefined || engine.state.generation > 120);
engine.moveOn();
await engine.run(() => (engine.state.stalled ?? null) !== null || engine.state.generation > 240);
if (!engine.state.stalled || engine.state.stage !== 1) throw new Error(`expected a stop at stage 2, got stage ${engine.state.stage + 1}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(engine.state));
console.log(`Wrote ${out}: stage ${engine.state.stage + 1} stopped, ${engine.state.archive.length} maxima kept, ${engine.state.counters.retired ?? 0} retired.`);
process.exit(0);
