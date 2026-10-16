# Trained brains

Brains bred by FlyKart Evolve, kept here so they can be loaded later. The Evolve page can list this folder from GitHub
("Browse this repository's brains") and add any of them to the brains a new run starts from.

## night1: the first browser run (1 h 44 min, 1,080 generations, one worker)

Bred with the earlier engine, which moved on after five climbs per stage whether or not the stage was mastered, so only
stage 1 was truly learned. Treat the later stages as a starting point, not a result.

| File | What it is | Flags found on fresh trials |
|---|---|---|
| `night1-stage1-L4.json` | Stage 1 winner (empty lawn), 48 neurons | 88 % (goal 85 %, mastered) |
| `night1-stage2-L7.json` | Stage 2 winner (light clutter), 48 neurons | 29 % (goal 75 %) |
| `night1-stage3-L12.json` | Stage 3 winner (branches, kerbs), 56 neurons | 15 % (goal 65 %) |
| `night1-stage4-L17.json` | Stage 4 winner (a flat), 64 neurons | 44 % (goal 60 %) |
| `night1-stage5-L20.json` | Stage 5 winner (the robot's flaws), 72 neurons | 35 % (goal 55 %) |
| `night1-stage6-L27.json` | Stage 6 winner (a bad day), 80 neurons | 11 % (goal 45 %) |
| `night1-champion.json` | The run's last champion (the stage 6 winner) | 11 % |
| `night1-run.json` | The whole run: every generation, 29 local maxima, the population, the settings | |

The first seven are ordinary brain files (19 inputs: camera and sonar, no compass). They load in Evolve's "Start from",
Vision and the 3D habitat. Brains with more than 48 neurons are not accepted by the Racer page.

`night1-run.json` is the full saved run (about 8 MB). To carry on from it, open Evolve and use **Open a run file…**: the
older maxima are tidied to the best three of each stage, and each stage can be climbed again with **Rerun this stage**.

## Making these files from another run

```bash
npx vite-node scripts/evolve-export-run.ts <whole-run-download.json> brains <name>
```

writes `<name>-champion.json` and a `<name>-stageN-<id>.json` for every stage winner.
