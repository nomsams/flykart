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

In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The workflow publishes `dist`; the repository-root `index.html` is source code and intentionally points at `src/main.ts`, which GitHub Pages cannot execute directly. The deployed app shows a startup screen while its bundle loads and reports a clear error if the page is stale or serving the source tree instead of the Vite artifact.

## Training modes

- **Train visually** runs one candidate at a time in the canvas. The cars are the actual candidates being evaluated, and the neural activity panel shows live spikes.
- **Headless train** runs the same deterministic evaluator without rendering each step. It yields periodically so the browser stays responsive and updates the generation/best-fitness counters.
- **Start race** deploys the best network found so far against heuristic bot racers.
- **Save brain / Load brain** stores a validated model checkpoint in browser local storage, including generation and fitness metadata.

The current evolutionary trainer uses elite selection plus mutation. It is a deliberately small baseline so we can compare it later against CEM, PPO, and a connectome-derived controller. Colab becomes useful when we add larger populations, many randomized tracks, pixel observations, or PyTorch/JAX experiments.

## Suggested milestones

1. Establish baseline race dynamics and controller telemetry.
2. Add randomized tracks, hazards, and robust evaluation seeds.
3. Export/import network weights and training logs.
4. Add a Python/Colab trainer with the browser as a visual replay client.
5. Compare heuristic, dense neural, spiking, and connectome-constrained controllers.

The race uses a fixed simulation timestep even when the display frame rate changes. Fitness is based on forward track progress, speed, off-track time, and collisions; it is not a cumulative rendering-frame counter.
