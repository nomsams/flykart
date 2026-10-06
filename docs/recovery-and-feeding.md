# Practise backing without losing forward driving

Open world's **Keep forward driving when teaching reverse** is on by default. Reverse demonstrations rehearse both directions. Every generation compares the offspring's forward navigation against the current parent on the same two seeds. It rejects a lower arrival count or a score loss above 20 points per trial. Two additional unseen seeds compare against the original parent; failure disables adoption. These small checks limit forgetting, but do not establish general navigation competence. Export the original brain before training.

A brain already specialised in backing can use ordinary Reach flag practice with **Seed navigation demonstration offspring** enabled. This teaches a forward-navigation child while the original still competes. Inspect the held-out report before adopting. Camera driving now uses sensor-only belief inputs; the explicit compass remains part of compass exercises. **Explore & find** has neither a compass nor a pheromone trail.

# Back out of corners in 3D

In Tasks, enable **Mix forward approach with corner recovery demonstrations**, set up an approach task, and collect three coach episodes. The first practises normal approach; the second practises a corner; the third is reserved for imitation validation. Use frozen neural trials and the paired room suite afterwards. This small feed-forward head may fail on new corners; imitation accuracy is not a navigation success measure.

The visible recovery teacher reads fresh sonar, previous issued motor commands, change in textured camera frames and optionally the installed SW-420. It brakes, briefly reverses, pivots toward estimated visual clearance, and attempts forward travel. Retries alternate turn direction. It never reads the physics engine's blocked flag, collision labels or true speed. A new vibration pulse interrupts reverse travel. Short retreats still have no rear clearance measurement.

**Target studio → Hunger, charging and satiation → Live recovery & feeding cycle** also offers explicit back-and-turn assistance for live simulation. Apply it to keep all neural weights unchanged. The console marks assistance separately. Frozen neural evaluation and evolution exclude it. Custom motor code still controls GPIO and can override these requests; the Apply live support button selects the fly motor bridge.

# Low charge → scent → feeding → roam

Add a charging pod with Scene tools, enable the live feeding cycle, and Apply live support. It enables energy monitoring without replacing the neural brain. The return threshold defaults to 25%. **Simulate low charge** is an external test intervention to at most 12% (below your return threshold); it does not itself earn sugar. Press Run or use the Step controls.

The environment lays an orange scent overlay through conservative clear corridors to the pod's measured front contact. The local simulated nose samples a finite concentration field that increases toward food. The robot receives local bearing and strength, not a global target coordinate. Obstacles, camera recognition and sonar still matter. The overlay is excluded from raw camera pixels. If a clear route cannot be laid, the simulator stops with an explanation instead of driving through objects.

The robot stops at the pod and holds still. Charging starts only after the existing physical contact/dwell approximation is satisfied; being visually near the pod alone earns no charge. At the configured satiation threshold it briefly reverses away and returns to its roaming controller. A later drop below the return threshold starts another cycle. Reward is the actual reduction in squared energy deficit and tapers toward satiation.

This loop is a labelled simulation supervisor. It is not evidence that the fly learned autonomous feeding. Support settings travel in lab/brain journey exports, with action sources in structured logs. USB arming rejects the virtual feeding loop; physical transfer needs a real navigation cue, battery telemetry and a charging mechanism.
