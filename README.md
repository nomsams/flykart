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
- **Evolve 5+ brains** races the configured population simultaneously by default (5 is the starting population; larger values such as 10 are supported). **Ghost evolution** is an optional isolated mode when candidates should not see or collide with one another.
- **Save brain / Download brain** remain available during every training mode. The current incumbent is auto-persisted after each generation, and checkpoints include generation, fitness, and validated network weights.
- **Track set** defaults to the original Grand loop. It also supports Switchback, Zigzag, Hairpin, Oval sprint, or **Generalist · all tracks**.
- **Adaptive time limit** can extend an improving candidate up to six times (configurable in the UI). The first extension needs a non-negative recent reward rate; later extensions require improvement over the previous reward window.
- **Reward shaping** labels every weight as positive or negative, shows a live per-tick chip breakdown, and includes close-traffic proximity risk before contact. Checkpoint gate count is configurable from 2 to 64.
- **Random road objects** add deterministic stalled cars to the road so avoidance can be trained before introducing moving traffic.
- **Plateau exploration** keeps the exact incumbent in slot 1, increases mutation strength when progress stalls, and after the patience window injects deterministic random immigrants plus higher-variance scout mutations. The plateau streak and current strategy are shown in the metrics panel; lower fitness is never accepted.
- **Progressive hazards** optionally ramps stalled road objects from a light first generation to the configured count, giving the controller a simple-to-hard curriculum.
- **Evolution trend plot** shows best reward/fitness and forward progress over generations. Red shading marks plateau/exploration periods, while the summary reports reward delta, progress delta, plateau streak, and mutation values. A plateau means no new incumbent for the configured patience; forward-progress gain below 2% is also treated as stalled.
- **Track-specific incumbents** prevent a high score from one track blocking learning on another. Each track/generalist context gets its own in-session brain and fitness baseline, while a previous brain is still used as a warm start. Racing a trained context deploys that context's brain instead of falling back to the demo controller.

The evolutionary trainer keeps the best incumbent as candidate 1 and rejects lower-scoring generations. New populations also cross the winner with the runner-up and a late-ranked candidate before mutation, so useful partial solutions can recombine without sacrificing the incumbent. If lap progress stalls, mutation rate and mutation magnitude rise above their defaults; after the configurable plateau patience window, a search burst adds random immigrants and larger scout mutations. Headless candidates share the same deterministic world seed within a run, so candidates are compared fairly instead of receiving different obstacle layouts. Checkpoint gates use directed line-segment intersections, which avoids missed high-speed crossings on irregular tracks. Outside-track time contributes a per-second penalty in the same physics path used by racing and training. Each car receives reward from local track progress, heading alignment, centerline position, ordered checkpoint gates, traffic proximity, and collision dynamics. A forward crossing of the actual start/finish boundary completes a lap only after the ordered gates and nearly the full route have been covered. Reaching the tick limit is reported as a time limit, not a crash.

## Suggested milestones

1. Establish baseline race dynamics and controller telemetry.
2. Add randomized tracks, hazards, and robust evaluation seeds.
3. Export/import network weights and training logs.
4. Add a Python/Colab trainer with the browser as a visual replay client.
5. Compare heuristic, dense neural, spiking, and connectome-constrained controllers.

The race uses a fixed simulation timestep even when the display frame rate changes. Fitness is based on forward track progress, speed, off-track time, and collisions; it is not a cumulative rendering-frame counter.
