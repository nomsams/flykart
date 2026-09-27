# FlyKart

FlyKart is a small original racing environment for experimenting with fly-inspired controllers. It is intentionally not a claim that a biological fly can drive a car: the first controller is a compact recurrent leaky integrate-and-fire network with a simple sensor interface.

**Play in your browser:** [https://nomsams.github.io/flykart/](https://nomsams.github.io/flykart/)

The companion [machine-learning compendium](https://nomsams.github.io/flykart/machine-learning.html) covers biophysics, neural-network topologies, connectomes, linear algebra, LLMs, CUDA, YOLO, distillation, LoRA, neuroevolution, interactive labs, optimization, and real-world AI deployment.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Test and build

```bash
npm test
npm run build
```

The project uses relative Vite asset paths, so the built `dist` directory works on a GitHub Pages project URL as well as on a custom domain. The included GitHub Actions workflow runs the tests and build before deploying Pages.

## GitHub Pages troubleshooting

This repository is configured with **Pages → Build and deployment → Source → GitHub Actions**. If you fork it, select that same source. The workflow publishes `dist`; the repository-root `index.html` is source code and intentionally points at `src/main.ts`, which GitHub Pages cannot execute directly. The deployed app shows a startup screen while its bundle loads and reports a clear error if the page is stale or serving the source tree instead of the Vite artifact.

## Training modes

- **Train visually** runs one candidate at a time in the canvas. The cars are the actual candidates being evaluated, and the neural activity panel shows live spikes.
- **Headless train** runs the same deterministic evaluator without rendering each step. It yields periodically so the browser stays responsive and updates the generation/best-fitness counters.
- **Start race** deploys the best network found so far against heuristic bot racers.
- **Evolve 5+ brains** races the configured population simultaneously (32 is now the initial-learning default). Every genome starts from the same scoring origin, decisions are computed from one frozen pre-tick state, and population index cannot gift free progress. **Independent evolution** gives each candidate an isolated copy of the same seeded world.
- **Save brain / Download brain** remain available during every training mode. The current incumbent is auto-persisted after each generation, and checkpoints include generation, fitness, and validated network weights.
- **Track set** defaults to the original Grand loop. It also supports Switchback, Zigzag, the rounded Hairpin, Oval sprint, Sharp turn, **Deep hairpin · 200° turn**, **Chicane · S bends**, **Corkscrew · hooked line**, **Mountain pass · switch turns**, **Tight corners · technical**, or **Generalist · all tracks**.
- The selected track shows live route diagnostics—length, corner count, hard-turn count, sharpest local turn, cumulative turn sweep, and shortest segment—so a training run's geometry and difficulty are visible before starting. The sweep catches long smooth hairpins that local vertex angles under-report.
- **Adaptive time limit** can extend an improving candidate up to six times (configurable in the UI) using linear windows: 1,500 → 3,000 → 4,500 → 6,000 ticks by default. With the progress watchdog enabled, reward alone cannot buy extra time: a candidate must also meet the configured route-progress rate.
- **Ruthless progress watchdog** evaluates checkpoint-valid novel coverage in configurable windows and eliminates candidates after the chosen number of sub-threshold windows. Simultaneous evolution also uses successive halving to remove the clearly slower half when their pace is far behind the leader. Reversing and replaying the same section cannot satisfy the watchdog.
- **Staged presets** provide Initial learning (clean isolated track), Progressive (hazard curriculum and moderate physics variation), and Master fine-tune (all tracks, traffic, mixed hazards, and robust four-seed evaluation). Applying a preset deliberately leaves watchdog settings untouched.
- **Robust evaluation** keeps paired training seeds fixed for five-generation cohorts before rotating, supports 1–4 seeds per route, combines mean performance with the worst quartile, and randomizes grip/engine/steering response. A separate fixed-suite validation champion is checked every five generations and can never be replaced by a regression.
- **Heuristic warm start** distills the reliable built-in driver into the spiking network's action readout before evolution starts. Evolution still owns the deployed controller and can improve beyond the teacher.
- **Reward shaping** labels every weight as positive or negative, shows a live per-tick chip breakdown, and includes close-traffic proximity risk before contact. Checkpoint gate count is configurable from 2 to 64.
- **Random road objects** add deterministic stalled cars to the road so avoidance can be trained before introducing moving traffic.
- **Plateau exploration** now starts at 10% mutation with 0.16 amplitude, waits eight generations in the initial preset, and caps both controls at 35%. Plateau bursts restart only a 10% explorer tail; the breeding incumbent, validation champion, and runner-up can remain exact elites.
- **Selection order** prioritizes completion rate, ordered checkpoints, worst-case coverage, and safety before applying the configurable progress/reward tie-break. Progress can mean novel route coverage or progress per lap-time budget. Incomplete attempts are charged the whole lap budget, so crashing early cannot look artificially fast.
- **Progressive hazards** optionally ramps stalled road objects from a light first generation to the configured count, giving the controller a simple-to-hard curriculum.
- **Evolution trend plot** separates the non-regressing fixed-suite validation champion from the exploratory training winner. The upper panel uses a local reward scale; the lower panel uses a fixed 0–100% scale for coverage and mutation rate. Red shading marks plateau/exploration periods, and purple shows bounded mutation pressure.
- **Compact brain family tree** keeps named snapshots for recent generations. Each node shows its reward, route coverage, status, and parent names; green nodes are retained incumbents, amber nodes are evaluated candidates, and purple nodes are random plateau immigrants. Click a node to inspect it, use it for the next race without changing the evolution incumbent, or download that exact network with lineage metadata.
- **Track-specific incumbents** prevent a high score from one track blocking learning on another. Each track/generalist context gets its own in-session brain and fitness baseline, while a previous brain is still used as a warm start. The UI marks a context as **NEW ROUTE** until it has produced a local generation and shows which tracks have been trained. Racing a trained context deploys that context's brain instead of falling back to the demo controller.

The evolutionary trainer reevaluates its breeding incumbent as candidate 1 under the same paired seed cohort as every challenger. The next generation keeps that incumbent exactly, protects additional validation/runner-up elites when available, uses mostly local mutation with controlled crossover slots, and reserves random restarts for a small explorer tail. The deployed and saved controller is the separate validation champion, not whichever candidate happened to win the latest noisy training generation.

If lap progress stalls, mutation rate and mutation magnitude rise above their defaults; after the configurable plateau patience window, a search burst adds random immigrants and larger scout mutations. The version-2 spiking controller has 17 sensors: multiple curvature horizons, checkpoint direction, route-relative traffic direction and closing speed, prior controls, and hazard context. Older 9-input checkpoints are migrated by preserving their original input weights and initializing the new channels neutrally. Spike-rate readouts eliminate the old half-throttle/half-brake neutral state. Reward is potential-based for new coverage and also penalizes control jitter, conflicting pedals, and excessive spiking. Explicit high-energy/off-track crash states make the crash penalty functional. Finished race bots clear the racing lane into a finish area instead of remaining stacked on the line.

## Suggested milestones

1. Establish baseline race dynamics and controller telemetry.
2. Add randomized tracks, hazards, and robust evaluation seeds.
3. Export/import network weights and training logs.
4. Add a Python/Colab trainer with the browser as a visual replay client.
5. Compare heuristic, dense neural, spiking, and connectome-constrained controllers.

The race uses a fixed simulation timestep even when the display frame rate changes. Fitness is based on forward track progress, speed, off-track time, and collisions; it is not a cumulative rendering-frame counter.
