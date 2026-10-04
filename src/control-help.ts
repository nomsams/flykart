/** Consistent language across the original and camera racing labs. */
export function explainControls(root:HTMLElement):void {
  const help:Record<string,string>={
    'track-select':'Track layout. Named and generated layouts let you test transfer to unfamiliar bends.',
    'track-speed':'Playback speed only. It changes wall-clock pace, not sensor frequency in simulated time.',
    'profile':'Sensor head: camera-only kart or the low-mounted robot camera with an HC-SR04.',
    'sonar-on':'Allow the controller to read echo closeness and strength. Off is a deaf ablation; the chart still records sensor pings.',
    'track-rivals':'Moving heuristic-driven rival cars. They can occlude the camera and produce ultrasonic echoes.',
    'track-objects':'Stationary road objects including barriers, cones and low oil patches. The sonar cannot reliably detect floor-level hazards.',
    'track-style':'Appearance variation: lighting, colours and camera noise. Zero uses the canonical scene.',
    'track-walls':'Road-side walls guide cars back towards the road. Turn them off to test independent recovery.',
    'walls-toggle':'Road-side walls guide cars back towards the road. Turn them off to test independent recovery.',
    'track-controller':'Spiking controller: converts estimated surroundings and body feedback into steering, throttle, brake and reverse.',
    'track-eyes':'Camera network: predicts environmental features and uncertainty from low-resolution RGB images. None uses exact simulator numbers.',
    'fade':'Privileged feeling channels: exact simulator features mixed with camera estimates. Seeing only removes them; deployable camera training forces them off.',
    'track-mode':'Decision pathway: fuse estimates before choosing an action, average two controllers, or use the camera network’s action guess.',
    'memory-on':'Pose-indexed lap memory recalls road geometry from earlier laps. It uses simulator pose, so it is excluded from sensor-only controller training.',
    'world-driver':'Driver source: camera, camera plus exact features, exact features, a hand-written expert, or a blind baseline.',
    'world-seed':'Deterministic world layout seed. Change it to test on a different arrangement.',
    'world-density':'Number of obstacles and surfaces in the open world.',
    'world-style':'Variation in scene appearance and noise, separate from world geometry.',
    'world-fade':'Weight of exact simulator features. Zero leaves camera estimates only.',
    'world-speed':'Playback speed; simulation sensor timing stays the same.',
    'multi-lap':'Continuous ordered laps without a restart. Training must survive all requested laps to count as complete.',
    'lap-target':'Requested laps when multi-lap survival is enabled. Time budget scales with this count.',
    'impact-pain':'Collision teaching cost scales with relative speed along the contact normal. It does not add hidden sensory information.',
    'domain-randomization':'Episode-to-episode variation in tyre grip, engine strength and steering response.',
    'adaptive-time-toggle':'Extend the time limit only while measured progress and reward rates justify it.',
    'adaptive-extensions':'Maximum additional evidence-based time extensions.',
    'checkpoint-count':'Ordered gates per lap. Skipping gates or driving backwards cannot claim a completed lap.',
    'ghost-evolution-toggle':'Evaluate candidates independently without moving rivals interfering with each other.',
    'soft-contact-toggle':'Contact incurs a teaching cost without rigid separation or momentum transfer. Useful for crowded visual evolution, less realistic.',
    'ruthless-culling-toggle':'End candidates that repeatedly fail the minimum progress requirement.',
    'cull-window-seconds':'Length of a progress-monitoring window in simulated seconds.',
    'cull-min-progress':'Minimum newly covered route fraction in each progress window.',
    'cull-patience':'Number of poor progress windows tolerated before elimination.',
    'population':'Candidate controllers per generation. More candidates cost more evaluation time.',
    'generations':'Number of mutation-and-selection generations to run.',
    'breeding-progress-weight':'Balance route progress versus reward score when selecting offspring.',
    'breeding-progress-metric':'Rank by covered route or completion-adjusted pace. Early death does not earn a pace bonus.',
    'winner-mating-share':'Share of offspring descended from the highest-ranking parents.',
    'curriculum-toggle':'Increase the training challenge gradually rather than starting at full difficulty.',
    'plateau-exploration-toggle':'Increase mutation exploration when progress stalls.',
    'plateau-patience':'Generations without improvement before exploration increases.',
    'obstacle-toggle':'Include stationary road hazards during training and testing.',
    'obstacle-count':'Number of stationary hazards per episode.',
    'obstacle-kind':'Type of stationary hazard, or a mixture.',
  };
  for(const e of Array.from(root.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[id],select[id]'))){
    let text=help[e.id];
    if(!text&&e.id.startsWith('reward-'))text=`Teaching weight for ${e.id.replace('reward-','').replaceAll('-',' ')}. Used to score and select controllers; never fed directly into their neural inputs.`;
    if(!text)continue;
    e.title=text;e.setAttribute('aria-description',text);
    const label=e.closest('label');if(label&&!label.querySelector('small')){const small=document.createElement('small');small.className='control-help';small.textContent=text;label.append(small);}
    if(e instanceof HTMLSelectElement)for(const option of Array.from(e.options))option.title=`${option.textContent}. ${text}`;
  }
}
