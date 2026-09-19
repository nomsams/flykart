# FlyKart

FlyKart is a small original racing environment for experimenting with fly-inspired controllers. It is intentionally not a claim that a biological fly can drive a car: the first controller is a compact recurrent leaky integrate-and-fire network with a simple sensor interface.

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
- **Evolve 5+ brains** races the configured population simultaneously by default (5 is the starting population; larger values such as 10 are supported). **Ghost evolution** is an isolated simultaneous mode: candidate brains do not sense, collide with, or influence one another, and each candidate gets its own road-object world. The **Elite parents / generation** setting controls how many of the strongest current candidates are used for crossover.
- **Save brain / Download brain** remain available during every training mode. The current incumbent is auto-persisted after each generation, and checkpoints include generation, fitness, and validated network weights.
- **Track set** defaults to the original Grand loop. It also supports Switchback, Zigzag, the rounded Hairpin, Oval sprint, Sharp turn, **Deep hairpin · 200° turn**, **Chicane · S bends**, **Corkscrew · hooked line**, **Mountain pass · switch turns**, **Tight corners · technical**, or **Generalist · all tracks**.
- The selected track shows live route diagnostics—length, corner count, hard-turn count, sharpest local turn, cumulative turn sweep, and shortest segment—so a training run's geometry and difficulty are visible before starting. The sweep catches long smooth hairpins that local vertex angles under-report.
- **Adaptive time limit** can extend an improving candidate up to six times (configurable in the UI). The first extension needs a non-negative recent reward rate; later extensions require improvement over the previous reward window.
- **Reward shaping** labels every weight as positive or negative, shows a live per-tick chip breakdown, and includes close-traffic proximity risk before contact. Checkpoint gate count is configurable from 2 to 64.
- **Random road objects** add deterministic stalled cars to the road so avoidance can be trained before introducing moving traffic.
- **Plateau exploration** keeps the exact incumbent in slot 1, increases mutation strength when progress stalls, and after the patience window injects deterministic random immigrants plus higher-variance scout mutations. The plateau streak and current strategy are shown in the metrics panel; lower fitness is never accepted.
- **Progressive hazards** optionally ramps stalled road objects from a light first generation to the configured count, giving the controller a simple-to-hard curriculum.
- **Evolution trend plot** shows incumbent reward, candidate reward, forward progress, and mutation rate over generations. The upper panel uses a local reward scale; the lower panel uses a fixed 0–100% scale for coverage and mutation rate. Red shading marks plateau/exploration periods, and purple mutation pressure makes it visible when search is escalating. A plateau is detected not only when a candidate is rejected, but also when reward inches up by less than 1% while route coverage is effectively unchanged; forward-progress gain below 2% is also treated as stalled. Generation points expose exact reward, progress, plateau reason, and mutation values on hover.
- **Compact brain family tree** keeps named snapshots for recent generations. Each node shows its reward, route coverage, status, and parent names; green nodes are retained incumbents, amber nodes are evaluated candidates, and purple nodes are random plateau immigrants. Click a node to inspect it, use it for the next race without changing the evolution incumbent, or download that exact network with lineage metadata.
- **Track-specific incumbents** prevent a high score from one track blocking learning on another. Each track/generalist context gets its own in-session brain and fitness baseline, while a previous brain is still used as a warm start. The UI marks a context as **NEW ROUTE** until it has produced a local generation and shows which tracks have been trained. Racing a trained context deploys that context's brain instead of falling back to the demo controller.

The evolutionary trainer keeps the incumbent brain unchanged as candidate 1. It does **not** replace that brain with a lower-quality candidate just to fill a generation. Candidates are ranked by route mastery first: a completed lap wins, then greater route coverage, then raw reward as a tie-breaker. This lets a warm-start brain with a historically large reward be replaced when a new-track candidate actually completes more of the route, even if the new raw reward is temporarily lower. Once a candidate is accepted, the next generation crosses the configured elite parent set and mutates the descendants; the incumbent is still retained exactly in slot 1. Lower-ranked candidates can contribute genetic material only through the configured parent pool—they cannot overwrite the incumbent by themselves.

If lap progress stalls, mutation rate and mutation magnitude rise above their defaults; after the configurable plateau patience window, a search burst adds random immigrants and larger scout mutations. Headless candidates share the same deterministic world seed within a run, so candidates are compared fairly instead of receiving different obstacle layouts; ghost candidates instead receive isolated copies of the world. Checkpoint and finish gates span the full road width, use a locally blended tangent at sharp polygon corners, and use directed line-segment intersections so a gate only rewards a forward crossing in the correct order. Outside-track time contributes a per-second penalty in the same physics path used by racing and training, and speed is reduced to about half immediately outside the road with stronger drag farther away. Each car receives reward from local track progress, heading alignment, centerline position, ordered checkpoint gates, traffic proximity, hazard contact, and collision dynamics. A forward crossing of the actual start/finish boundary completes a lap only after the ordered gates and nearly the full route have been covered. Reaching the tick limit is reported as a time limit, not a crash.

## Suggested milestones

1. Establish baseline race dynamics and controller telemetry.
2. Add randomized tracks, hazards, and robust evaluation seeds.
3. Export/import network weights and training logs.
4. Add a Python/Colab trainer with the browser as a visual replay client.
5. Compare heuristic, dense neural, spiking, and connectome-constrained controllers.

The race uses a fixed simulation timestep even when the display frame rate changes. Fitness is based on forward track progress, speed, off-track time, and collisions; it is not a cumulative rendering-frame counter.
