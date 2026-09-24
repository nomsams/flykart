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
- **Evolve 5+ brains** races the configured population simultaneously (10 is now the default). Every genome starts from the same scoring origin, decisions are computed from one frozen pre-tick state, and population index cannot gift free progress. **Ghost evolution** gives each candidate an isolated copy of the same seeded world.
- **Save brain / Download brain** remain available during every training mode. The current incumbent is auto-persisted after each generation, and checkpoints include generation, fitness, and validated network weights.
- **Track set** defaults to the original Grand loop. It also supports Switchback, Zigzag, the rounded Hairpin, Oval sprint, Sharp turn, **Deep hairpin · 200° turn**, **Chicane · S bends**, **Corkscrew · hooked line**, **Mountain pass · switch turns**, **Tight corners · technical**, or **Generalist · all tracks**.
- The selected track shows live route diagnostics—length, corner count, hard-turn count, sharpest local turn, cumulative turn sweep, and shortest segment—so a training run's geometry and difficulty are visible before starting. The sweep catches long smooth hairpins that local vertex angles under-report.
- **Adaptive time limit** can extend an improving candidate up to six times (configurable in the UI) using linear windows: 1,500 → 3,000 → 4,500 → 6,000 ticks by default. With the progress watchdog enabled, reward alone cannot buy extra time: a candidate must also meet the configured route-progress rate.
- **Ruthless progress watchdog** evaluates checkpoint-valid novel coverage in configurable windows and eliminates candidates after the chosen number of sub-threshold windows. Simultaneous evolution also uses successive halving to remove the clearly slower half when their pace is far behind the leader. Reversing and replaying the same section cannot satisfy the watchdog.
- **Robust evaluation** rotates shared seeds every generation, supports 1–4 seeds per route, combines mean performance with the worst quartile, randomizes grip/engine/steering response, and reports a fixed held-out validation result after training.
- **Heuristic warm start** distills the reliable built-in driver into the spiking network's action readout before evolution starts. Evolution still owns the deployed controller and can improve beyond the teacher.
- **Reward shaping** labels every weight as positive or negative, shows a live per-tick chip breakdown, and includes close-traffic proximity risk before contact. Checkpoint gate count is configurable from 2 to 64.
- **Random road objects** add deterministic stalled cars to the road so avoidance can be trained before introducing moving traffic.
- **Plateau exploration** keeps the selected objective winner exactly in slot 1, increases mutation strength when progress stalls, and after the patience window injects deterministic random immigrants plus higher-variance scout mutations. The plateau streak and current strategy are shown in the metrics panel; replacement always follows the configured progress/reward objective.
- **Breeding priority** is a draggable progress-versus-reward slider with 10-point ratios (100/0, 90/10, 80/20, and so on). Its progress side can rank either novel route coverage (“who got furthest”) or progress per second (“who advanced fastest”). The selected objective now controls both mating and incumbent replacement, so the slider cannot disagree with the protected champion.
- **Progressive hazards** optionally ramps stalled road objects from a light first generation to the configured count, giving the controller a simple-to-hard curriculum.
- **Evolution trend plot** shows incumbent reward, candidate reward, forward progress, and mutation rate over generations. The upper panel uses a local reward scale; the lower panel uses a fixed 0–100% scale for coverage and mutation rate. Red shading marks plateau/exploration periods, and purple mutation pressure makes it visible when search is escalating. A plateau is detected not only when a candidate is rejected, but also when reward inches up by less than 1% while route coverage is effectively unchanged; forward-progress gain below 2% is also treated as stalled. Generation points expose exact reward, progress, plateau reason, and mutation values on hover.
- **Compact brain family tree** keeps named snapshots for recent generations. Each node shows its reward, route coverage, status, and parent names; green nodes are retained incumbents, amber nodes are evaluated candidates, and purple nodes are random plateau immigrants. Click a node to inspect it, use it for the next race without changing the evolution incumbent, or download that exact network with lineage metadata.
- **Track-specific incumbents** prevent a high score from one track blocking learning on another. Each track/generalist context gets its own in-session brain and fitness baseline, while a previous brain is still used as a warm start. The UI marks a context as **NEW ROUTE** until it has produced a local generation and shows which tracks have been trained. Racing a trained context deploys that context's brain instead of falling back to the demo controller.

The evolutionary trainer reevaluates the incumbent as candidate 1 under the same current-generation seeds as every challenger. Completed laps remain above incomplete attempts, while the chosen progress/reward ratio consistently selects the generation champion. The next generation keeps that champion exactly, crosses it with the blended winner and runner-up, then applies layer-specific bounded mutations. Mutation strength is self-adaptive per genome, and crossover copies whole hidden-neuron units instead of arbitrary flat weight fragments.

If lap progress stalls, mutation rate and mutation magnitude rise above their defaults; after the configurable plateau patience window, a search burst adds random immigrants and larger scout mutations. The version-2 spiking controller has 17 sensors: multiple curvature horizons, checkpoint direction, route-relative traffic direction and closing speed, prior controls, and hazard context. Older 9-input checkpoints are migrated by preserving their original input weights and initializing the new channels neutrally. Spike-rate readouts eliminate the old half-throttle/half-brake neutral state. Reward is potential-based for new coverage and also penalizes control jitter, conflicting pedals, and excessive spiking. Explicit high-energy/off-track crash states make the crash penalty functional. Finished race bots clear the racing lane into a finish area instead of remaining stacked on the line.

## Suggested milestones

1. Establish baseline race dynamics and controller telemetry.
2. Add randomized tracks, hazards, and robust evaluation seeds.
3. Export/import network weights and training logs.
4. Add a Python/Colab trainer with the browser as a visual replay client.
5. Compare heuristic, dense neural, spiking, and connectome-constrained controllers.

The race uses a fixed simulation timestep even when the display frame rate changes. Fitness is based on forward track progress, speed, off-track time, and collisions; it is not a cumulative rendering-frame counter.
