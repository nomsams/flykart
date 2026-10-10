# Parking simulator

Open `/parking.html` with `npm run dev`. Parking is stage 4 of the same project: Racer → Vision → Explore world → Parking → 3D habitat → calibration against measured hardware. All stages remain on the same Git branch. Racer, Vision, the 3D habitat and Claude's trained robot assets remain available.

## A practical teaching sequence

| Lesson | Starting situation | Successful finish |
| --- | --- | --- |
| Find a bay | Two robot-sized blocks beside a vacant space | Centre within 27 cm of the yellow area, any heading; stop for one second |
| Leave a parked bay | Nose-in among parked blocks | Reverse out, reach the aisle marker and stop |
| Switch bays | Start parked in one of two vacant spaces | Leave it and stop at the other space |
| Park with direction | A random vacant bay and requested heading | Entire chassis inside, heading error below 15°, stopped for one second |
| Parallel parking | Five occupied blocks and a random gap | Fit the gap, match the neighbouring blocks' direction and stop |
| Share the parking lot | Switching bays around traffic and walkers | Precise parking without pedestrian contact |

The lot opens in a real Three.js perspective view with solid blocks, roofs, side faces and shadows. Drag to orbit, scroll/pinch to zoom, use **Close view** for the bays or **Fit lot** for the whole lot. **Top plan · low CPU** retains the original overhead view. These are diagnostic viewpoints; the fly still gets its low-resolution forward camera.

First practise manually with **Drive → Manual** and WASD/arrows, or hold the touch buttons below the lot. **Teach from your own driving** records only sensor inputs and requested actions. Enable **Seed one child** to fit that child's action readout from your examples before evolution. The original parent remains a candidate; recorded driving is not automatically considered successful or safe.

Start with **Guided** sugar and short, simple lots. Then choose **Sparse** sugar, which pays only for completing parking. Finally test **Frozen**, which stops visual-memory learning and dispenses no sugar. The crash penalty and diagnostic score still work. Collision/contact-free time and an actual one-second stop are required; seeing the flag alone never wins.

**Delayed sugar · require controls released** optionally withholds all sugar, including guided approach shaping. First meet the parking criteria and stop for one second, then stay there for the configured extra delay (default 2 seconds). Throttle, reverse, steering and brake must all be released within a 3% numerical deadband. Moving out of the valid area, contact, or any active control resets the hold. Pending signed shaping and the completion bonus are paid once at success; a timeout or pedestrian contact discards pending sugar. Frozen trials apply the same arrival/delay criteria and never pay sugar. The checkbox and delay persist in replay files, brain provenance and evolution reports; every ghost uses the same rule.

Guided sugar is the signed change of a distance/parking-quality potential. Returning to the same pose cancels that shaping reward. Loose lessons ignore orientation in their reward too. Better centring/alignment gives a larger completion bonus. Trials also pay a small time cost; **Crash priority** controls the additional impact/visual-stall penalty. Pedestrian contact ends the episode and carries a large penalty. Animations are stylized overlays; they cannot provide neural cues or change the score.

## Approach, reverse and route coach

The **Reward coach** panel shows the score components live; completion logs and training reports include the same breakdown. Controls persist in replay states, preferences, brain provenance and generation checkpoints. Every ghost and held-out comparison uses the selected rules.

**Reward approaching the parking space** is on by default. Three observer-only rings show the selected radius (default 3 m). Moving inward earns the signed change in a bounded radial potential; moving outward subtracts it, and no approach sugar is earned outside the radius. A round trip cancels it. Alignment/centring shaping remains a separate component. The rings never appear in the inference camera.

**Penalize no useful progress** is on by default. After three seconds without a new 2 cm best distance improvement, useful final orientation improvement, or valid stopped parking hold, the evaluation score loses 1 point/s. The rate doubles every three seconds to a cap of 10 point/s. Driving in circles, repeating the same approach and motor commands without movement do not reset the timer. Valid stopped parking, including delayed gratification, is exempt. This cost is separate from impact/visual-stall pain and still applies in sparse/frozen evaluation.

**Extra sugar for useful reverse** is optional. Actual backward displacement must improve the best distance reached, or advance a nearby planned route. It pays 12 sugar/m of new useful reversing, capped at 5 per episode. Holding reverse against a wall, driving away, or repeating a previously credited approach cannot farm this bonus.

**Path coach** is optional and off by default. A bounded A* search plans forward/reverse translations and in-place turns on a 6 cm / 45° lattice. It minimizes translation plus estimated turn wheel-travel cost, checks the full oriented chassis with a clearance margin along each primitive, and seeks a centred destination plus required heading in precise lessons. Cyan marks forward segments; violet marks reverse. This is a shortest route in the sampled static model, not a guarantee of continuous physical optimality. Parked blocks are planned around; moving traffic is excluded and still requires avoidance. A blocked start or exhausted search budget is reported and produces no route sugar.

Following the route earns a signed progress potential attenuated by cross-track error; leaving the route reduces it. Returning to the same pose cancels route sugar. With the coach active, new progress along the nearby route also resets the no-progress timer, allowing a useful detour away from the goal. The route is external training supervision: it never supplies motor commands, hidden bearings, map coordinates, or extra neural inputs. Turn it off when evaluating independent visual discovery.

Approach, reverse, alignment and route shaping apply only in **Guided** mode; **Sparse** pays completed parking only, and **Frozen** pays no sugar. Delayed gratification withholds all bonuses until valid completion. **Show radius rings & coach route** affects only diagnostic views and can be toggled during a run without resetting it.

Sonar geometry checks cover all four lot walls, rotated parked-car faces, blind-zone occlusion and acquisition-pose mapping. Distances originate at the front transducer, not the car centre. The live sonar status shows reading age: at 30 Hz the last reading is held between two-tick pings. Below 2 cm, or at weak/specular surfaces, no echo means unknown; the map does not invent clear floor from a timeout. These are simulation checks, not measurements of physical hardware.

## Continuing ghost evolution

The top **Ghost evolution** bar appears in Visual racer, Open world and Parking. It names the selected parent, shows its weight ID and cumulative generation, and provides **Evolve ghosts**, **Cancel** and **Export saved winner**. The driving brain is identified separately. Completed generations autosave their selected winner before the next generation starts, including before held-out validation. Cancelling later work preserves the last completed generation.

**Evolve again** starts from that winner with the current eye and exercise settings. Reloading this site restores the stage's latest autosaved winner. Loading a new brain selects **Active loaded brain**; the previous winner remains available in **Next parent**. Track, world and parking checkpoints are separate, and are separate from manual browser brain saves. A storage failure is reported explicitly: the winner remains available in the current tab and can be exported, but is not promised to survive reload.

**Driving brain & training history** records each generation's parent/winner IDs, task or maps, seed/scenario information, score, rewards, sensor settings and final held-out results. Intermediate generations are not independently held-out tested. Winner exports carry the eye model, setup and full history to Vision/Parking/3D; trial-specific memories and neural spike state are not saved. Automatic training continuation does not adopt the winner for live driving. Review held-out results and use the existing offspring button; Parking and reverse-retention adoption gates still apply.

## What the controller can know

**Explore · camera only target** uses an explicit pink-pixel detector for bearing and apparent size. Requested direction comes from cyan nose and orange tail patches painted on the floor, projected into the actual RGB camera image. Both patches must be resolved before that direction advisory is available. Occlusion, distance and the low resolution can hide them. These detectors are fixed image-processing rules, not a newly trained target CNN.

**Explicit goal compass** deliberately supplies relative bearing, distance and heading from simulated localization. Its exports disclose this choice. Use visual-only trials when investigating what the camera can learn independently.

The controller also receives camera-network clearance estimates, HC-SR04 closeness/echo strength, last motor requests and a motor-model speed estimate. The speed estimate continues at a wall when the wheels are commanded to turn; it does not silently reveal actual stalled-body speed. Visual-stall evidence compares camera frames and requests, with sonar support. Pose, actual collision labels, rewards, parking quality and the sonar ground map are external diagnostics and training labels. Visual mode never calls the goal compass or privileged clearance function.

Input count remains 19. Input 15's existing open-heading advisory incorporates the observed parking direction when both colour patches are resolved. This extends its interpretation; it must be checked again when transferring to another page.

## Physics, traffic and sensors

The body uses the 3D robot's 26 × 17 cm dimensions, wheel/motor response, differential steering and oriented contact geometry. Blocks default to the same footprint. Turning **car skins** on changes their appearance, not their collision box. Optional size variation is seeded at ±4%.

The colour camera renders a perspective ground plane and upright sprites at the imported eye network's input resolution, normally 48 × 24, preserving that eye's trained lens geometry by default. The inference camera ray-intersects actual oriented box volumes, including near-camera surfaces, shaded roof/end/side faces and occlusion. Car bodies add a raised cabin within the same footprint/height. Browser inference, Node tests and headless training use the same deterministic software geometry; the diagnostic Three.js view uses matching dimensions. Other Racer/Vision sprite shapes retain their original renderer. Selecting the physical robot mount for a model trained at another height changes its visual domain; its camera weights are preserved and are not automatically retrained on parking scenes.

The HC-SR04 reuses Claude's model: noisy echoes, minimum range, weak/specular returns, ghost echoes and a two-tick cycle (about 15 Hz at 30 simulation ticks/s). A timeout means unknown. The scan map accumulates actual pings at the physical body's simulated pose, so it stays still at contact. It is a diagnostic with known simulator localization, not an extra lidar input or a claim of localization on hardware.

Traffic follows a single clockwise loop, bounded turning rate and acceleration, following headway, pedestrian priority and yielding around parking/exiting manoeuvres. Walkers travel between a store-side location and parked blocks; visiting a block releases that car after a wait. They are cylindrical visuals/sonar targets with conservative rectangular contact bounds. This is an illustrative right-of-way model, not a comprehensive implementation of road traffic law. Smoke, explosions and red impact particles depend on contact severity; they are diagnostic effects in both lot views.

## Parent transfer and sonar

**Sonar on** is checked by default next to Drive. Turning it off gives the CNN and controller zero sonar channels, disables sonar-based stall evidence, hides the live beam and pauses scan recording. Existing history is retained when restoring a replay. Live values display the actual inputs 17/18 received by the brain. Saved replay files, brain exports and ghost runs preserve the selection. Changing the sensor setup restarts the lot and clears the old coaching/adoption setup.

**Transfer grass · open-world eyes** is the default floor. It uses the original open-world ground texture in both camera inference and the 3D lot, retaining solid vehicles and parking paint. In a six-second clear-lot diagnostic, the bundled visual parent interpreted asphalt as near obstacles across most sectors and circled; changing only the ground appearance reduced turning substantially. **Asphalt · parking adaptation** remains available, but the frozen grass-trained CNN has not learned that material. Controller evolution alone does not train new visual clearance recognition. The live input status shows front blockage estimates to help identify this failure. This is a transfer aid, not proof of parking competence.

**Keep imported eye camera** preserves the trained eye height, forward offset, pitch and field of view. Previously parking forced every parent onto the lower robot mount, which changed its retinal input without adapting the frozen CNN. Choose **Robot sensor head · 6.5 cm** explicitly when practising hardware transfer. Sonar remains at 6.5 cm in either camera mode. The effective camera calibration and sonar selection also travel in Vision exports.

The default controller inputs match open world. **Bay-direction advisory** is opt-in and applies only to precise orientation lessons; it changes input 15 from navigation to a blend with observed paint direction. It never redirects loose arrival/exit/switch lessons. Reverse steering now turns the nose in the same direction as the open-world car, and the last-gas/brake feedback retains the trained input meaning. Parking still uses slower physical robot wheel dynamics and unfamiliar solid car imagery: equal sensor observations produce equal neural actions, but a successful open-world parent is not automatically a successful precision parking controller. Visual mode has no target information while the flag is unseen; the input status makes that clear.

## Swarm, memory and evaluation

The default memory has **4,096 Kenyon visual cells**; select up to 40,000. This grows the sparse visual recall layer, not the 48-neuron spiking motor network. The 1/3/5/9-eye and zoom options run actual crops through separate camera readers. They share one physical camera and are correlated views, not independently positioned flies or rear-facing cameras. The preview displays the inputs actually processed.

**Keep visual world memory** retains visual prototypes between live replays. It does not give the controller a pose-indexed map. Capacity changes create a fresh memory. Forgetting memory preserves the controller and geometry.

Evolution trains on the active lesson plus a rotating selected earlier lesson. Every generation receives fresh common seeds; each ghost has its own world, actors, network state and visual memory. Held-out seeds are reserved before training. Parent and offspring are then compared on every selected lesson with fresh frozen memory. Adoption is enabled only if the child retains each successful parent test and avoids a substantial aggregate score regression. A retention pass with zero completed parks does **not** demonstrate parking competence; the UI and report show success counts. Changing the brain, eyes, swarm, memory capacity or goal-cue inputs clears the previous adoption gate and manual examples, so an old test cannot authorize a child under a different observation setup. Export a completed report before changing that setup.

The inherited world CNN remains frozen. Evolution mutates the motor controller. The manual coach fits one child's motor readout. Neither process pretends to train new parking visual recognition automatically. Maximum speed uses bounded work batches and yields to the UI. Low-CPU preview reduces drawing; headless preview skips automatic display rendering while preserving camera capture and inference required by the controller.

## Imports, exports and reproducibility

- **Import / paste brain** always stays visible. File, any-file and pasted JSON use the same validated importer. Load the bundled racer or visual checkpoint from the browser brain shelf.
- A world controller preserves its weights, camera network, visual settings, memory and checkpoint metadata. A racer is staged unchanged until **Adapt racer parent to parking** explicitly remaps its input meanings and creates a room-input child. The source parent remains in exported provenance.
- **Save browser brain** writes a separate Parking checkpoint. Choose **Parking simulator** as the source on Vision or 3D. Other stage saves remain intact. Browser saves require the same browser/site address; JSON works across devices.
- **Export fly + eyes** produces the standard Vision brain format with world-domain weights, camera network, swarm settings, memory and scoring provenance. Parking-specific advisory and visual-renderer differences still require testing in Vision/3D.
- **Save replay lot + brain + memory** saves the exact initial lot, goal, starting pose, selected settings, current visual memory and diagnostic scan. Import validates everything before replacement. It starts a new episode at the saved start; elapsed physics, traffic positions, transient spikes and held keys are not serialized.
- **Export 3D scene** produces a file accepted by the habitat's scene importer. Actors become static block proxies with a sugar target. The habitat's basic sugar judge does not enforce full-body parking or heading. Keep the parking replay file for exact parking evaluation.
- **Export run report** records seeds, selected lessons, per-ghost results, the selected weights, held-out results and the input/memory audit. Logs can be copied with one button or saved as JSON.

No physical robot, collision switch or serial flash was used to validate parking.

## Useful next improvements

1. Add recorded real camera/sonar/motor measurements as replay fixtures, then compare them against this simulation before changing the trained assets.
2. Add parking-labelled camera datasets and a separate offspring eye model. Measure clearance and marker performance on unseen lots; keep the current parent eyes available for comparison.
3. Add rear/side sensing explicitly. Current forward-camera crops cannot see behind the chassis, which makes safe reversing and parallel parking harder. Evaluate a bumper switch and a rear ranger as distinct sensor contracts rather than hidden simulator knowledge.
4. Expand held-out tests to occluded markers, moving-car crossings, unfamiliar paint colours, different bay sizes and sensor dropout. Keep pedestrian contacts as a separate safety metric rather than trading them away for faster parking.
5. Add an optional navigation memory built from estimated visual motion/odometry, with uncertainty and relocalization. The existing visual recall and diagnostic map are not yet a parking-space localization system.

## Checking hidden goals

The live target-cue line beside the world view shows **CAMERA ONLY** or **COMPASS ON**, the actual neural target inputs, and the age of the processed camera frame. Visual target bearing and apparent size come from a fixed pink-colour detector; obstacle estimates come from the inherited CNN. This is assisted visual perception, not end-to-end learned target recognition. Forward-camera swarm crops do not provide a rear camera.

In Open world, **Place flag behind current robot** preserves Explore & find and its arrival rule. It previously selected the compass-powered reverse exercise even when exploration was selected. The reverse exercise is now explicitly labelled **goal compass**. Loading an older room file without an exercise also preserves the selected task, arrival rule and repeat-search setting.

Regression tests run the actual bundled visual checkpoint against two different fully hidden rear targets, using real camera rendering, sonar, nine eye crops, temporal filtering and visual recall. Before either target is visible, neural inputs, motor actions and trajectories must match; compass mode is a positive control that must distinguish them. This checks that particular hidden-target scenario, not every possible scene. A learned reverse/search habit or a previously observed target can still explain purposeful-looking reversing; immediate reversing alone is not proof of a goal-position leak.
