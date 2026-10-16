// Writes the brains of a saved Evolve run as ordinary brain files: the champion and the winner of every stage. They load
// anywhere a brain loads (Evolve's "Start from", Vision, the 3D habitat) and can be browsed on GitHub from the Evolve page
// when they sit in the repository's brains/ folder.
//
//   npx vite-node scripts/evolve-export-run.ts <run.json> <outdir> <prefix>
//   npx vite-node scripts/evolve-export-run.ts "C:/Users/me/Downloads/run.json" brains night1
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EngineState } from "../src/evolve/engine";
import { brainFile } from "../src/evolve/persist";

const [input, outDir = "brains", prefix = "run"] = process.argv.slice(2);
if (!input) { console.error("Usage: vite-node scripts/evolve-export-run.ts <run.json> <outdir> <prefix>"); process.exit(1); }
const state = JSON.parse(readFileSync(input, "utf8")) as EngineState;
if (state?.version !== 1 || !Array.isArray(state.archive) || !state.config) { console.error("That is not a saved Evolve run (the whole-run download, not the progress file)."); process.exit(1); }
mkdirSync(outDir, { recursive: true });
const written: string[] = [];
const write = (name: string, brain: EngineState["archive"][number]["brain"], fitness: number, label: string): void => {
  writeFileSync(resolve(outDir, name), brainFile(brain, { fitness, generation: state.generation, label, run: prefix }));
  written.push(`${name} (${brain.hiddenCount} neurons)`);
};
if (state.champion) write(`${prefix}-champion.json`, state.champion.brain, state.champion.score, `${state.champion.id}: ${state.champion.note}`);
for (const result of [...state.stageResults].sort((a, b) => a.stage - b.stage)) {
  const max = state.archive.find((m) => m.id === result.winner);
  if (!max) { console.log(`Stage ${result.stage + 1}: winner ${result.winner} is no longer in the archive; skipped.`); continue; }
  write(`${prefix}-stage${result.stage + 1}-${max.id}.json`, max.brain, result.score, `stage ${result.stage + 1} winner ${max.id}: ${(result.reach * 100).toFixed(0)}% of flags on fresh trials${result.mastered ? " (mastered)" : ""}`);
}
console.log(`Wrote ${written.length} brain files to ${outDir}:\n  ${written.join("\n  ")}`);
