// The "How it works" tab.
export const HOW_IT_WORKS = `
<h2>From numbers to pixels</h2>
<p>In the original FlyKart the controller (48 leaky spiking neurons, 3,360 weights) is handed 17 numbers each tick by the simulator: where the road bends, how far off-centre it is, how close the nearest kart is. Those numbers are not something a real vehicle gets for free. FlyKart Vision keeps the controller and the 17-number contract <em>exactly</em> as they were and replaces the source of the numbers: a small camera network reads a 48×24 colour image and <em>estimates</em> them.</p>
<div class="callout">That contract is what makes the two versions compatible. A brain evolved in FlyKart v1 can be imported here and driven through the camera. A brain evolved or adapted here can be exported with <b>Export for FlyKart v1</b> and loaded into the original app.</div>

<figure>
<svg viewBox="0 0 760 330" role="img" aria-label="The pipeline from camera to wheels" width="100%">
  <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10z" fill="#7f8ca0"/></marker></defs>
  <g font-size="12" fill="#cdd7e6" text-anchor="middle">
    <rect x="10" y="20" width="130" height="58" rx="8" fill="#16283b" stroke="#72b8ff"/><text x="75" y="44">Camera</text><text x="75" y="62" fill="#7f8ca0">48×24 colour, 15 Hz</text>
    <rect x="185" y="20" width="170" height="58" rx="8" fill="#16283b" stroke="#72b8ff"/><text x="270" y="44">Small convolutional net</text><text x="270" y="62" fill="#7f8ca0">13 estimates, each ± σ</text>
    <rect x="185" y="120" width="170" height="50" rx="8" fill="#2a2412" stroke="#f3c96b"/><text x="270" y="142">“Feeling” channels</text><text x="270" y="158" fill="#7f8ca0">exact numbers, × fade</text>
    <rect x="185" y="200" width="170" height="50" rx="8" fill="#241a38" stroke="#c4a2ff"/><text x="270" y="222">Kenyon cells</text><text x="270" y="238" fill="#7f8ca0">the bend ahead, from last lap</text>
    <rect x="420" y="110" width="115" height="80" rx="8" fill="#12301f" stroke="#7cf0b6"/><text x="477" y="138">Cue fusion</text><text x="477" y="156" fill="#7f8ca0">1/variance</text><text x="477" y="172" fill="#7f8ca0">weighting</text>
    <rect x="580" y="110" width="170" height="80" rx="8" fill="#1d2330" stroke="#8fa4be"/><text x="665" y="136">Spiking controller</text><text x="665" y="154" fill="#7f8ca0">17 → 48 → 4</text><text x="665" y="170" fill="#7f8ca0">unchanged from v1</text>
    <rect x="420" y="262" width="330" height="44" rx="8" fill="#1d2330" stroke="#8fa4be"/><text x="585" y="281">Body: speed, last steer, last gas/brake</text><text x="585" y="296" fill="#7f8ca0">proprioception, like a fly’s legs and halteres</text>
  </g>
  <g stroke="#7f8ca0" stroke-width="1.5" fill="none" marker-end="url(#arr)">
    <path d="M140 49H183"/><path d="M355 49H385Q477 49 477 108"/><path d="M355 145H418"/><path d="M355 225H385Q477 225 477 192"/><path d="M535 150H578"/><path d="M665 260V192"/>
  </g>
  <text x="665" y="100" font-size="11" fill="#7f8ca0" text-anchor="middle">→ steer · gas · brake · reverse</text>
</svg>
<figcaption>Every number the controller reads is a fusion of up to three cues. Turn the “feeling” weight to zero and the kart is steered by the camera and the lap memory alone.</figcaption>
</figure>

<h2>How it was trained</h2>
<h3>1 · A controller that expects imperfect eyes</h3>
<p>The controller is evolved (mutation, whole-neuron crossover, plateau exploration: the same machinery as FlyKart v1) while its 13 camera-style inputs are delayed up to 10 ticks, biased, and corrupted with slowly varying noise. A candidate may only replace the champion if it does not lap fewer tracks on clean inputs, so robustness is never bought with the original skill. Start: the v1 demo brain.</p>
<h3>2 · Free labels</h3>
<p>The simulator knows the true value of every number the camera should estimate. Each rendered frame is stored with its truth, the kart’s body feedback, and what the exact-number controller would do. The camera network is trained on these labels (Huber loss for the estimates, a Gaussian likelihood for its own uncertainty, plus an auxiliary “guess the feeling brain’s action” head).</p>
<h3>3 · DAgger</h3>
<p>Round 0 imitates the exact-number driver. Later rounds let the camera pipeline drive while the exact-number brain keeps labelling every frame, so the network learns from the situations <em>it</em> gets itself into, not only the ones its teacher would. Evaluation always uses tracks and worlds it never trained on, including randomly generated ones.</p>
<h3>4 · Fusing beliefs, not actions</h3>
<p>The camera network reports each estimate with a variance; the exact channels have a small fixed variance scaled by the slider; the lap memory has a variance it keeps calibrated against what actually happened. The cues are combined with weights of 1/variance (the way animals combine sight and touch). Fading the feeling channels is then just turning one weight to zero.</p>
<div class="callout warn"><b>Why not average two brains’ actions?</b> If one brain would pass an obstacle on the left and the other on the right, the average steers straight into it. The <em>Combine by</em> menu keeps that option so you can watch it happen.</div>
<h3>5 · Kenyon cells</h3>
<p>On the first lap the kart does not know the road. But its body knows where it is (wheel odometry and a gyro, counted from the start line) and which way it faces. 4,000 Kenyon cells, each with a random place field along the stretch between two gates, give every place a sparse code (only the strongest 5% fire, like the fly’s inhibitory APL neuron), and four output synapses per cell learn, as running averages, <em>where the kart was and which way it faced here</em>. That is a map of the path built from nothing but the kart’s own movement.</p>
<p>On the next lap the kart can look ahead in memory: recall the places 30 to 150 px further on and turn them, from its current pose, into the same road-geometry estimates the camera makes. They become a third cue for fusion, with an error bar that was measured against the true road. Cells taught seconds ago do not count as a memory: the cue appears only for cells taught on an earlier lap.</p>
<div class="callout"><b>What to expect.</b> A remembered path is a rougher guide than a good camera, so in good light the memory changes little. It earns its place when the camera gets worse (dusk, a smudged lens): the camera’s own error bars grow, the memory’s do not, and the fusion leans on it. The Evidence tab measures both.</div>
<h3>6 · An open world</h3>
<p>The same recipe in a world with no road: trees, rocks, ponds, sand and mud. The camera estimates how blocked each 11° slice of the view is and what the ground ahead is; a compass supplies the goal’s direction; the same 17 → 48 → 4 controller drives. Replace the simulator with CARLA, MetaDrive or a game engine and the camera network, fusion and controller carry over; only the renderer and the labels change.</p>
<h3>7 · A real robot’s body: a low camera and a sonar</h3>
<p>The <em>Sensor head</em> menu at the top switches from the original simulated kart to a robot-scale one. The robot is 26 × 17 cm with its wheels 11.5 cm apart, and its camera and an HC-SR04 ultrasonic ranger sit on the body 6.5 cm above the floor. In the simulator one pixel is taken to be 1.1 cm, so the 24 × 14 px kart is 26 × 15 cm and its top speed of 90 px/s is about 1 m/s. The kart’s handling is still the original FlyKart’s: nothing here claims the real robot drives the same way.</p>
<p><b>The low camera.</b> At 6.5 cm the road is seen almost edge-on: far bends squash into a few rows of pixels, the ground just in front of the bumper is hidden, and gates are seen from underneath. The camera network is therefore retrained at that height, not reused.</p>
<p><b>The sonar, as cheap as it really is.</b> A beam about 15° wide returns the <em>nearest</em> echo in the cone, from 2 cm to 4 m, about fifteen times a second. It is noisy (a few millimetres at close range, growing with distance, plus a temperature-dependent error in the speed of sound). A thin post or a surface at a slant bounces the sound away and can vanish; a rare ghost echo appears. It hears only things taller than a couple of centimetres that cross the beam at 6.5 cm: cones, barriers, other karts, trees, rocks, walls. Paint, kerbs, oil and ponds are flat, so it is deaf to them, and the gantries over the gates are raised so the beam passes under. It knows <em>how far</em>, not <em>which way</em>.</p>
<p><b>How the controller uses it.</b> Two more inputs: how close the echo is, and how strong it was. The 19-input controller starts as the robust one with those two weights at zero, so evolution alone decides what the echo is for. It is evolved first through synthetic noise, including episodes where the camera misses every vehicle (as at night or when an object is hidden) so that the sonar is sometimes the only warning, and then by driving whole episodes through the real robot camera network with the sonar in the loop, by day and by night. The camera network hears the sonar as well: the echo is an extra input beside the speed and last commands, so the network learns to combine what it sees with what it hears. A hand-wired braking reflex was tried first and made things worse: a robot that stops in front of a cone keeps touching it. A 17-input brain can be widened to 19 inputs with zero weights and drives exactly as before until evolution gives the new inputs a job; <b>Export for FlyKart v1</b> drops them again, so the original app can still read the file, though the brain will then drive without hearing.</p>
<p>The fly has no sonar. Its nearest equivalents are the mechanosensory antennae and the looming-sensitive neurons that trigger an escape, and the three <em>ocelli</em>, simple eyes that report overall brightness and the horizon; the ocelli are not modelled here.</p>

<h2>The fly behind the design</h2>
<div class="table-scroll"><table>
<tr><th>FlyKart Vision</th><th>Fly</th><th>How far the analogy goes</th></tr>
<tr><td>Convolutional camera network</td><td>Optic lobe: layers of local feature detectors (edges, colour, motion)</td><td>Same idea, learned by gradient descent rather than evolved</td></tr>
<tr><td>Speed and last commands</td><td>Haltere and leg proprioception</td><td>Same role: the body knows what it is doing</td></tr>
<tr><td>Spiking controller</td><td>Central complex and descending neurons</td><td>Leaky spiking units with opponent readouts</td></tr>
<tr><td>Kenyon cells and lap memory</td><td>Mushroom body: sparse random expansion, dopamine-gated output synapses</td><td>Close in structure; the “dopamine” here is a prediction error</td></tr>
<tr><td>Sonar inputs and the looming reflex</td><td>Antennal mechanosensation and looming-detector escape neurons</td><td>Only the reflex idea; flies do not echolocate, and the ocelli are not modelled</td></tr>
<tr><td>Evolution, then within-lifetime learning</td><td>Innate wiring plus experience</td><td>Evolution sets the wiring; the lap memory learns inside a life</td></tr>
</table></div>

<h2>Tried and dropped</h2>
<p>Two additions that sounded right did nothing at this scale: a hard-wired colour-opponent / centre-surround <em>retina</em> in front of the network, and a spatial soft-argmax layer that turns “a feature fires somewhere” into coordinates. Same data, same budget, they matched but did not beat the plain network (see Evidence). What did matter was <em>many different objects</em>: training on long episodes taught the network nothing about traffic (R² ≈ 0); adding thousands of three-frame scenes with fresh arrangements of karts and obstacles raised it to about 0.6.</p>

<h2>What this is not</h2>
<p>The camera is a software renderer: a perspective view of a flat world with upright objects, 48×24 pixels. It is real pixels in colour with real occlusion and scale, which is why the network has to learn to see, but it is not a game engine. Textures, shadows, slopes and weather would make the problem harder. The Evidence tab reports where the camera brain is as good as exact numbers, and where it is not.</p>
`;
