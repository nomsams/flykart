# FlyKart

FlyKart is a small original racing environment for experimenting with fly-inspired controllers. It is intentionally not a claim that a biological fly can drive a car: the first controller is a compact recurrent leaky integrate-and-fire network with a simple sensor interface.

**Play in your browser:** [https://nomsams.github.io/flykart/](https://nomsams.github.io/flykart/)

The companion [machine-learning compendium](https://nomsams.github.io/flykart/machine-learning.html) covers biophysics, neural-network topologies, connectomes, linear algebra, LLMs, CUDA, YOLO, distillation, LoRA, neuroevolution, interactive labs, optimization, and real-world AI deployment.

## The compendium's guided route and brain inspector

[`public/machine-learning.html`](public/machine-learning.html) opens with a ten-chapter guided route that follows one question, *which parts of a neuron must the kart keep?*, from a living cell (Hodgkin–Huxley) through LIF, the artificial neuron, spiking networks, learning, and hardware, to the real 17 → 48 → 4 FlyKart controller. Each chapter is split into lettered parts, carries interactive labs, and ends with a "kept / dropped / price" ledger; a sticky bar shows the current chapter and part, and a route map at the top links every part and lab.

**Chapter 9 · Open a trained brain** loads a `flykart-brain` checkpoint (use **Download brain** in the simulator, or drop the bundled sample) and lets you:

- see its four weight blocks as heat maps, and open any neuron's card;
- feed it any sensor values and watch spikes and controls, or sweep one sensor at a time for response curves;
- drive it on the simulator's *own* physics, sensors and 18-term reward function, poke it (shove it to an edge, drop a cone, face it backwards) and watch every reward term react;
- silence groups of neurons and see what breaks.

**Moving ions.** Lab 1.2 shows Na⁺ and K⁺ drifting in both baths and streaming through a channel only while its gate is open. Lab 2.3 runs the Hodgkin–Huxley equations with the ions drawn: each channel is a pore with gate flaps (three m gates and an h ball for sodium, four n gates for potassium) that flip at the model's rate constants, the number of ions crossing follows the computed current, TTX and TEA plug the pores, raising K⁺ outside shifts E_K, and the Na⁺/K⁺ pump runs in the background (`public/ion-labs.js`). One drawn ion stands for about 5,000 real ones per µm².

**Chapter 10 · Give the brain a body** is the guided-route writeup of the robot-scale sonar work below: five labs (the robot to scale, two cameras at different heights using the simulator's own projection, an HC-SR04 echo with its waveform, inverse-variance sensor fusion with ghost echoes and outlier gating, and the measured results with error bars read from `public/vision/robot/results.json`), in `public/body-labs.js`.

The lab engine is the real `src/core.ts` bundled for the browser. `npm run dev` and `npm run build` generate `public/flykart-core.js` from `src/lab.ts` (it is git-ignored) with esbuild, which ships inside Vite. `public/sample-brain.json` is a demo brain produced by:

```bash
npx vite-node scripts/make-sample-brain.ts --gens=40                     # warm start + evolution alone
npx vite-node scripts/make-sample-brain.ts --gens=40 --traffic --from=public/sample-brain.json --out=public/sample-brain.json
npx vite-node scripts/check-brain.ts public/sample-brain.json            # progress on every track, alone and with rivals
```

## FlyKart Vision (version 2)

[`vision.html`](vision.html) is a second app that sits next to the original and shares its simulator. **FlyKart v1 is untouched**: `index.html`, `src/main.ts` and `src/core.ts` behave exactly as before, and a test (`backward compatibility with the original FlyKart`) checks that driving a lap through the new pipeline with the "feeling" channels reproduces the original simulator tick for tick.

What changes is where the controller's 17 inputs come from. In v1 the simulator hands them over. In Vision a small camera network reads a 48×24 colour image and *estimates* them, the kart's own body supplies speed and its last commands, and (optionally) a Kenyon-cell memory adds what it learned on the previous lap. The 17 → 48 → 4 spiking controller is the same class with the same file format, so:

- **import** any `flykart-brain` checkpoint from v1 (old 9-sensor brains too) and drive it through the camera;
- **export for FlyKart v1** hands the original app a controller trained here;
- **Export vision brain** saves controller + eyes + fusion settings + lap memory in one `flykart-vision-brain` file whose embedded controller is itself a complete v1 checkpoint.

### The pipeline, and how it was built

| Step | What it does | Where |
|---|---|---|
| 1 | Evolve the controller through a noisy, biased, delayed 13-estimate interface; a candidate may not lap fewer clean tracks than the champion | `scripts/robust-evolve.ts`, `src/vision/robust.ts` |
| 2 | Software camera (perspective ground plane + upright sprites, 48×24 colour, palette/lighting/noise randomisation) with free ground-truth labels, plus randomly generated tracks | `src/vision/camera.ts`, `trackScene.ts`, `proceduralTracks.ts` |
| 3 | Train the camera network by imitation, then DAgger (the camera pipeline drives, the exact-number brain labels), plus thousands of short traffic scenes | `scripts/vision-train.ts`, `src/vision/dagger.ts`, `cnn.ts`, `train.ts` |
| 4 | Fuse *beliefs*, not actions: cues weighted by 1/variance (camera, exact "feeling" channels scaled by a fade, lap memory); compare with naive action averaging | `src/vision/fusion.ts`, `pipeline.ts` |
| 5 | Kenyon cells: sparse random place fields, 1/n running-average output synapses, only cells taught on an *earlier lap* count as remembered | `src/vision/memory.ts` |
| 6 | The same recipe in a random open world (trees, rocks, ponds, sand, mud; no road) | `src/vision/world/` |

```bash
npm run dev                         # then open /vision.html
npm run vision:controller           # step 1  (about 30 min)
npm run vision:controller-check     #         v1 brain vs robust controller across noise levels
npm run vision:train                # steps 2-3 (about 1 h on a laptop CPU)
npm run vision:world-controller     # step 6
npm run vision:world-train
npm run vision:experiments          # everything the Evidence tab shows -> public/vision/results.json
npx vite-node scripts/dump-dataset.ts --out=datasets/track --frames=20000   # a labelled dataset for any other framework
```

### What was measured

Everything below is reproduced by `npm run vision:experiments` and shown, with the full tables, in the app's **Evidence** tab. All numbers are on tracks and worlds the networks never trained on, from a 4-core laptop CPU; each driver ran each track once, so differences of a lap or two are noise.

| Question | Result |
|---|---|
| **1 · Does a controller trained for imperfect eyes lose its skill?** | No. Clean: 6/7 laps on the tracks it trained on (the v1 demo brain: 6/7), 6/8 on unseen tracks (v1: 4/8). With 0.40 noise, drifting error and 333 ms delay: 7/7 and 5/8 (v1: 2/7 and 2/8). Laps are also faster. |
| **2 · Can the camera drive alone?** | Mostly. 5/8 laps (74% progress) on unseen tracks with walls, 6/8 without walls; exact numbers: 7/8 and 5/8; blind: 0/8. The camera network explains the road geometry well (R² on held-out tracks: heading to look-ahead 0.74, edge clearance 0.80, curvature 0.59, lateral 0.51) but not everything (road angle −0.07, bend 150 px ahead 0.40). |
| **3 · Can the feeling be faded out?** | Yes. Weight 1 → 0.1 → 0.01 → 0.001 → 0 moves smoothly from the exact-number result (7/8 laps) to the camera-only result (5/8); fading it from 1 to 0 *during* a lap gave 7/8 laps. Averaging the two brains' actions (6/8) did **not** do worse here: the case where it should fail, two good ways round one obstacle, is rare in these runs. |
| **4 · Does it see traffic?** | Yes, up to roughly 100 px (R² 0.61 closeness, 0.60 ahead/behind, 0.41 side). Without road-side walls, with rivals and road objects, the camera-only kart finished 5/8 laps against 1/8 for the exact-number kart, which crashes more here; I did not establish why. One run per track; treat as suggestive. |
| **5 · Does a lap teach the kart what to expect?** | Mixed, and smaller than hoped. In good light the memory changes little (estimate error −4% on average, lap 2 faster than lap 1 on 2 of 6 tracks). When the second lap is dim and noisy, the memory lowered the estimate error on 7/8 tracks at night and let 5 tracks finish against 4, but it made dusk slightly less reliable (5 vs 6 laps) and dim laps slower (41 s vs 24 s). On the tracks the kart can drive, a memory taught on a *different* track gives estimates 3-7× worse than the right one, so it is place-specific. |
| **6 · Does the same logic drive an open world?** | Yes, roughly. Camera-only: 2.65 goals per 60 s run and 6/20 crashes, against 2.20 and 5/20 for the same spiking controller on exact numbers (blind: 0.45 and 15/20). The hand-written expert reaches 3.35 with no crashes, so in this world the spiking controller, not the eyes, is the weaker part. |

### Things that did not work, and what that taught

- **Long drives teach a camera nothing about traffic** (R² ≈ 0 after 30,000 frames): a drive contains few distinct objects. Thousands of three-frame scenes with fresh arrangements raised it to ~0.6.
- **A hard-wired colour-opponent "retina" front end and a spatial soft-argmax layer** (both in `src/vision/retina.ts` / `cnn.ts`, off by default) matched but did not beat the plain network.
- **A memory that learns "what the camera should have said" from hindsight** was worse than the camera everywhere: hindsight measures the kart's own wobble, not the road. The memory that stores the kart's *path* (position and heading at each place) and recalls it from the current pose works better.
- **Online calibration of the memory against hindsight** made it overtrust itself; its uncertainty is now measured offline against the true road.
- **Push-pull motor outputs** (left/right/forward/back instead of steer/throttle/brake/reverse), taught by imitation from the same random hidden layer, were slightly worse (13/42 vs 15/42 laps on trained tracks, 22/66 vs 28/66 on unseen).
- **The 3D claim**: the "world" is a software-rendered perspective view of a flat plane with upright objects (48×24 pixels). It exercises the same camera → estimates → controller path as a game engine would, but it has no slopes, shadows, textures or weather.
- Not done: quality-diversity / novelty search for the evolutionary stage, learned gating or mixture-of-experts fusion, surrogate-gradient training of the spiking controller, training in the browser (training is Node-only; the browser runs, imports and exports).

## FlyKart Vision at robot scale: a low camera and an HC-SR04 sonar

The **Sensor head** menu in `vision.html` switches the kart to the scale of a real robot: 26 × 17 cm, wheels 11.5 cm apart, and the camera and an ultrasonic ranger both mounted 6.5 cm above the floor. One simulator pixel is taken to be 1.1 cm, so the 24 × 14 px kart is about 26 × 15 cm and its top speed (90 px/s) about 1 m/s. The kart's handling is still the original FlyKart's; nothing claims the real robot drives the same way. The original kart profile (camera 16 cm up, no sonar) is unchanged and its bundled files keep working.

**The sonar is a basic HC-SR04, not an idealised distance reading** (`src/vision/sonar.ts`, `robot.ts`): a roughly 15° beam that returns the *nearest* echo from 2 cm to 4 m, one ping about every 66 ms, range noise that grows with distance, quantisation, a per-run speed-of-sound error, rare ghost echoes, weak echoes from thin, small, far or slanted targets, and no echo at all from things lower than about 1.6 cm (paint, kerbs, oil, ponds). It hears cones, barriers, other karts, trees, rocks and walls. It knows how far, not which way. Gantries over the gates are raised on this profile so the beam passes underneath.

**How it is used**

- The controller reads two more inputs (how close the echo is, how strong it was): 17 → **19 inputs** → 48 → 4. `widenBrain` adds them with zero weights, so a v1 brain widened this way drives exactly as before until evolution gives them a job; **Export for FlyKart v1** drops them (`narrowBrain`), and the original app refuses a 19-input file with an explanation instead of misbehaving.
- The **camera network also takes the echo** as extra inputs beside the speed and last commands, so it learns to combine what it sees with what it hears.
- Training uses the sonar throughout: the controller is evolved first through synthetic noise (including episodes where the camera misses every vehicle, so the sonar is sometimes the only warning), then by driving whole episodes through the real robot camera network by day and by night; the camera networks are trained by DAgger at 6.5 cm with the sonar in the loop; the open-world pair is trained the same way.
- A hand-wired braking reflex was tried first and was worse: a robot that stops in front of a cone keeps touching it (67 collisions against 40 with the sonar off). Starting the sonar weights at zero and letting evolution decide worked better.
- Ocelli (the fly's three simple eyes) are not modelled.

```bash
npm run robot:controller             # sonar controller through synthetic noise (about 40 min)
npm run robot:train                  # camera network at 6.5 cm, sonar as an input
npm run robot:controller-camera      # evolve the controller driving through that camera network
npm run robot:world-controller; npm run robot:world-train; npm run robot:world-controller-camera
npm run robot:experiments            # -> public/vision/robot/results.json, shown in the Evidence tab
npm run robot:camera                 # a sheet of what the 6.5 cm camera sees
```

**What was measured** (held-out tracks and worlds, 16 episodes per row, so a lap or two or a few collisions is noise):

| Question | Result |
|---|---|
| Does the sonar get in the way on an empty road or hurt on flat hazards? | No: 12/16 laps with it, 12/16 without it (empty road); the same with oil slicks, which it cannot hear. |
| Does it reduce collisions in daylight traffic? | **No.** The same brain with its sonar silenced: 12/16 laps, 40.8 s mean lap, 61 collisions; with the sonar on: 11/16 laps, 31.1 s, 90 collisions. It drives through traffic faster, not more carefully. |
| At night? | Laps 8/16 with against 9/16 without, quicker (30.6 s against 36.8 s), collisions 61 against 66. Evolving through the real camera is what made the difference between 0–1 and 8–9 night laps. |
| Does the echo make the camera network more accurate? | **Not measurably.** Same teacher and data, with and without the echo as an input: traffic closeness R² 0.81 against 0.80, obstacle 0.41 against 0.43. Its value here is that the whole stack is trained with the sonar in the loop. From 6.5 cm the road geometry is harder to read than from 16 cm (curvature R² roughly 0 to 0.4 against 0.59) while traffic is easier (closeness 0.8). |
| Open world | Camera + sonar 3.44 goals per run and 6/16 crashes against 2.88 and 7/16 camera only. |

## Run locally

### Three.js robot habitat

Open [`robot.html`](robot.html) with `npm run dev` for a metre-scale 3D robot lab. It uses the supplied 26 × 17 cm four-wheel chassis, 11.5 cm axle spacing, 65 mm tyres and 6.5 cm sensor height. The default profile is ESP32-CAM → L298N, with the UNO/shield omitted.

- Import existing FlyKart or Vision brains; their real spiking weights drive the simulated motor pairs. Track/world input meanings remain distinct.
- View the 160 × 120 RGB565-style camera capture, the actual reduced image sent to the vision network, sonar cone and pulse duration, neuron spikes and motor PWM.
- Add and edit walls, rooms, tables, chairs, rocks, low stones, bushes, trees and water. Furniture has separate legs/tops and height-aware collision for driving underneath.
- Change chassis, motor, camera, sonar and pin connections in **Components & wiring**. Invalid camera/SD/pin/level-shift configurations inhibit motors.
- Edit and run a bounded Arduino-style sketch. Virtual GPIO writes actually change motion; download/import `.ino` files. This is a small numeric interpreter, not a full C++ compiler or ESP32 emulator.
- Sparse Kenyon-inspired visual associations recall previous observations. A separate sonar map uses commanded-wheel odometry and deliberately drifts under slip/contact. Export/import the full lab to preserve brains, eyes, geometry, wiring, sketch and memory.

The bundled eyes were trained in the older software renderer; 3D transfer is experimental and has no measured navigation guarantee. Downloaded sketches require physical camera/brain adapters before deployment. See [`public/docs/robot-habitat.html`](public/docs/robot-habitat.html) for the proposed GPIO profile, verified hardware references, assumptions and model limits. The default profile is not an inferred reconstruction of the attached photographs.

`npm run robot:ui-check` verifies camera pixels, code-driven movement, editing/undo, wiring inhibition, brain imports, full lab round-trips and mobile layout against the running dev server. It uses isolated headless Edge on Windows and Playwright Chromium elsewhere; screenshots go to `.cache/`.

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

The robot journey now offers component target tracking with legacy-head compatibility, paired seeded room challenges (layout, distractors, lighting, grip, delay and ablations), sensor-contract export, and measured motion traces with optional real encoder-adapter feedback. See `public/docs/robot-lifecycle.html` for units, limitations and the training sequence. Full fly inference runs on the USB host; the onboard 30-channel student is a separate distilled controller.

`node scripts/robot-browser-checks.mjs` starts its own Vite server on port 5185 and runs all robot browser checks sequentially. Set `ROBOT_CHECK_PORT` to choose another port or `ROBOT_BROWSER_CHECKS=robot-advanced-ui-check` for one check. CI runs serial unit tests, a build and these browser checks on pushes and pull requests; Pages deploys only from main/master.

Both racing labs have **Multi-lap survival**: 2, 3 or 5 ordered laps in one continuous episode. Controller state, traffic and elapsed time continue across the finish line; completion requires every requested lap. Evaluation budgets scale with lap count and route coverage is normalized for selection. Speed-sensitive collision pain uses relative closing speed before contact impulses, with a small cost for gentle bumps. Original single-lap and fixed-cost physics remain the defaults for legacy callers.

FlyKart Vision's **Training & sensor experiments** panel evolves controller offspring behind frozen camera weights. The sensor-only trainer excludes exact track geometry, mission coordinates and pose-indexed lap memory from neural inputs; rewards and impact costs select candidates externally. Two training seeds and two separate paired validation seeds compare the final offspring with its parent. Reports include the selected brain, eyes and full experiment context; the validation is a small simulation check, not evidence of real-world safety. Bundled Claude-trained assets are preserved.

The panel supports low-resolution RGB, explicit camera grain/brightness, spatial and temporal filters, and one/three/five virtual eye views. Virtual views share one camera image and are correlated; their disagreement increases uncertainty. Cropped track views change apparent geometry, so they need held-out testing rather than an assumed accuracy benefit. Camera board-width FOV estimation, sonar range fitting and manual mount/yaw/tilt/lobe settings are exported with the brain. The HC-SR04 chart records only fresh pings, including explicit no-echo marks, and shows sample age/paused status. The simulation remains about 15 Hz; accelerated playback changes wall-clock frequency. No echo is not zero range or a confirmed crash. The copyable console records each fresh ping and training decisions.

The habitat has scene undo/redo, including object/robot moves, rotation, floor colour and objectives. Racing labs have settings undo/redo. Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y work outside editable text, which keeps native editor undo. These histories do not rewind neural learning or real hardware motion.


The robot habitat places scene tools directly below the 3D viewport and the raw camera, fly input and room-memory instruments beside it. The optional SW-420 vibration module is disabled by default. Components & wiring exposes active polarity, virtual sensitivity, bounce lockout and event hold. A test shake, cable crossing, impact or mounting-dependent motor chatter can generate a digital event; DO is not impact force and does not prove collision. Use the new SW-420 visual head to train with vibration in the optional impact slots (recipe `robot-task35-sw420-v3`); older heads retain their original semantics. Logs and episode replays retain raw DO, held event, validity and count. The USB bridge captures edges by interrupt and reports `VIB deviceMilliseconds rawLevel eventCount heldEvent` before each camera frame, preserving short events between transmissions.

The direct USB build consumes the normal ESP32-CAM spare header pins. SW-420 DO defaults to disconnected: simulation is available, but hardware export requires a real assignment. GPIO33 is offered only as an explicitly acknowledged modified status-LED solder-pad connection with the LED isolated; it is not an exposed spare header. UART1/3, camera and PSRAM conflicts are rejected. Power the module at **3.3 V** on ESP32 with shared GND, and verify the polarity and physical potentiometer threshold on the actual module. Reference: [Seeed SW-420 documentation](https://wiki.seeedstudio.com/Grove-Vibration_Sensor_SW-420/) and [AI-Thinker ESP32-CAM schematic](https://docs.ai-thinker.com/_media/esp32/docs/esp32_cam_sch.pdf). The 30-input onboard compact student does not have a vibration channel; use the USB host for vibration-aware tasks. No physical collision/transfer result is claimed.
