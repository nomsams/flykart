// Chapter 14 · Check yourself: a small quiz engine and the question banks for chapters 10-13.
// Needs edu-common.js. Progress is kept in localStorage only (best score and attempts per quiz), and the page works without it.
(function (root) {
    'use strict';
    const K = root.EduKit;

    /* A question is { q, o: [options], a: index or [indexes], why }. Options are shuffled each time a quiz is built. */
    const BANK = {
        core: [
            { q: 'In the FlyKart neuron update v = 0.86·v + 0.22·I, what does the 0.86 do?', o: ['It is the firing threshold', 'Each tick the membrane keeps 86 % of its previous value: the leak gives the neuron a short memory of recent input', 'It scales the output spike', 'It is the learning rate'], a: 1, why: 'The leak factor sets the membrane time constant. A value close to 1 remembers longer; smaller forgets faster.' },
            { q: 'Why is a spiking FlyKart controller evolved instead of trained by plain backpropagation through its spikes?', o: ['A spike is an all-or-none threshold event with zero slope almost everywhere, so no gradient flows through it', 'Backpropagation is always slower than evolution', 'Spiking neurons have no weights', 'Evolution needs less data than any other method'], a: 0, why: 'The threshold step has a derivative of zero except at the threshold itself. Surrogate gradients exist, but evolution needs only a score for a whole run.' },
            { q: 'An HC-SR04 reports one number: the distance to the nearest echo. What can it not tell you?', o: ['How far the nearest echo is', 'Which side of the beam the object is on', 'Whether anything is in the beam', 'How long the echo took'], a: 1, why: 'A single fixed transducer returns range without bearing. A camera or a swept or paired sonar is needed for direction.' },
            { q: 'A camera says an obstacle is 90 cm away with σ = 20 cm; the sonar says 84 cm with σ = 2 cm. With 1/σ² weighting, how much more weight does the sonar get?', o: ['2 times', '10 times', '100 times', 'The same'], a: 2, why: 'Weights are 1/σ²: 1/4 against 1/400 gives 100 to 1. The fused estimate is almost exactly the sonar’s.' },
            { q: 'In the Chapter 10 measurements, what did switching the sonar on do for the robot in traffic?', o: ['It finished laps faster but did not hit fewer obstacles', 'It removed every collision', 'It made laps slower and safer', 'It made the camera unnecessary'], a: 0, why: 'On the held-out tracks the sonar rows had shorter lap times but collision counts that were not lower. A single range reading says how far, not which way to steer.' },
            { q: 'Why was the camera network retrained at the robot’s 6.5 cm height instead of reusing the 16 cm one?', o: ['The new camera is faster', 'The lower viewpoint changes where the road and objects fall in the image, so the old mapping is wrong', 'The sonar required it', 'The network got smaller'], a: 1, why: 'Projection depends on camera height: the same road occupies different rows. Using a network trained for another geometry gives systematically wrong estimates.' },
        ],
        loss: [
            { q: 'Residuals are 1, 1, 1 and 10 around one constant prediction. Which loss pulls the best constant furthest toward the 10?', o: ['Mean squared error (best constant is the mean, 3.25)', 'Mean absolute error (best constant is the median, 1)', 'Huber loss with δ = 1 (about 1.33)', 'They all choose the same constant'], a: 0, why: 'Squared error is minimised by the mean, absolute error by the median, and Huber lands near the median because the 10 is capped at a constant pull.' },
            { q: 'Which loss has a gradient whose size does not shrink as the error approaches zero, so it needs a decaying learning rate to settle?', o: ['Mean squared error', 'Mean absolute error', 'Huber loss inside its quadratic zone', 'Cross-entropy'], a: 1, why: 'The derivative of |r| is ±1 everywhere except zero. MSE and Huber (for small errors) shrink their gradient with the error.' },
            { q: 'A classifier gives the true class probability 0.1. What is the cross-entropy loss (natural log)?', o: ['0.10', '0.90', '2.30', '10'], a: 2, why: '−ln(0.1) = 2.303. The loss is the surprise at the true answer.' },
            { q: 'A model is 99 % sure of the wrong class (true-class probability 0.01). Which loss punishes it most?', o: ['0–1 loss (1)', 'Squared error on the probability (about 0.98)', 'Cross-entropy (about 4.6)', 'All equally'], a: 2, why: 'Cross-entropy is unbounded as the true-class probability goes to zero, so confident mistakes are the most expensive.' },
            { q: 'A dataset is 99 % negatives. A model that always answers “negative” scores 99 % accuracy. What is the lesson?', o: ['Accuracy is the right metric here', 'Accuracy can hide total failure on the rare class: use class weights, focal loss or precision–recall', 'The model is excellent', 'You need more negative examples'], a: 1, why: 'The metric must reflect what you care about. Weighting or focal loss makes the rare, hard examples count.' },
            { q: 'Focal loss multiplies cross-entropy by (1 − p)^γ. For an easy example with p = 0.9 and γ = 2, the loss shrinks by about…', o: ['10 times', '100 times', '1000 times', 'not at all'], a: 1, why: '(1 − 0.9)² = 0.01, so the easy example’s loss is cut 100-fold while a hard example with p = 0.2 keeps (0.8)² = 0.64 of its loss.' },
            { q: 'A sigmoid neuron trained with squared error is confidently wrong (p ≈ 0.02, target 1). Why does it learn much more slowly than with cross-entropy?', o: ['Squared error has no minimum', 'Its gradient carries the factor p(1 − p), nearly zero when the neuron is saturated; cross-entropy cancels that factor', 'Cross-entropy uses a larger learning rate', 'Sigmoids cannot be trained with squared error'], a: 1, why: 'dL/dz is proportional to (p − t)·p(1 − p) for squared error but just (p − t) for cross-entropy. The first vanishes exactly where you most need a push.' },
            { q: 'In the Gaussian negative log-likelihood ½ log σ² + (y − μ)² / 2σ², what stops the model from claiming a huge σ everywhere?', o: ['Nothing, that is allowed', 'The ½ log σ² term grows with σ, so claiming too much uncertainty is penalised', 'The learning rate', 'The squared term gets bigger as σ grows'], a: 1, why: 'The first term charges for uncertainty and the second charges for being wrong relative to the claimed uncertainty. The best σ is the true spread.' },
            { q: 'What does Huber loss’s δ control?', o: ['The learning rate', 'The error size at which the penalty switches from quadratic to linear, in the units of the error', 'How many outliers are allowed', 'The batch size'], a: 1, why: 'Below δ it behaves like MSE, above δ like MAE. Because δ has the units of the error, scale the targets before choosing it.' },
            { q: 'Select every proper scoring rule, one whose expected value is best when you report the true probability.', o: ['Log loss (cross-entropy)', 'Brier score (squared error on the probability)', 'Accuracy at a 0.5 threshold', 'Hinge loss on the raw score'], a: [0, 1], why: 'Log loss and the Brier score reward honest probabilities. Accuracy only looks at the side of a threshold and hinge loss ignores probabilities entirely.' },
            { q: 'Which task has no usable loss gradient, so evolution or reinforcement learning is the natural tool?', o: ['Fitting a line to noisy points', 'Scoring a spiking controller by how far it drives a whole lap in a simulator', 'Classifying handwritten digits', 'Predicting the next word'], a: 1, why: 'A lap score arrives only at the end of a long, non-differentiable simulation; it ranks candidates but offers no slope.' },
            { q: 'Your regression labels contain a few wildly wrong values that you cannot clean. What is the sensible first choice?', o: ['Mean squared error', 'Huber (or mean absolute error)', 'A loss such as |r|⁴', 'Cross-entropy'], a: 1, why: 'Robust losses cap how hard one bad point can pull. MSE and higher powers do the opposite.' },
            { q: 'FlyKart’s camera network is trained with a Huber loss on each estimate plus a Gaussian-NLL term for its variance. Why predict the variance?', o: ['It makes training faster', 'So the fusion step can weigh the camera by how reliable it says each estimate is', 'Huber loss requires it', 'It saves memory'], a: 1, why: 'Fusion weights each source by 1/variance, so a calibrated variance is what lets the controller trust the camera less in the dark.' },
        ],
        graph: [
            { q: 'How many edges can a simple undirected graph with 10 nodes have at most?', o: ['10', '45', '90', '100'], a: 1, why: 'Each of the 10 nodes can pair with 9 others, and each pair is counted once: 10·9/2 = 45.' },
            { q: 'FlyKart’s 48 × 48 recurrent matrix is not symmetric in general. What does that mean for its graph?', o: ['It is undirected', 'It is directed: the influence A→B can differ from B→A', 'It has no cycles', 'It has 48 edges'], a: 1, why: 'A symmetric matrix describes an undirected graph. A general weight matrix is a directed, signed, weighted graph.' },
            { q: 'In the code the recurrent weights are stored as R[receiver × 48 + sender]. For the entry R[i][j], which neuron sends its spike?', o: ['i', 'j', 'both', 'neither'], a: 1, why: 'The row is the receiving neuron i; it sums R[i][j] times neuron j’s previous spike. Reading it the other way round swaps in- and out-degree.' },
            { q: 'What turns a regular ring lattice into a “small world”?', o: ['Removing most edges', 'A few random long-range shortcuts', 'Adding self-loops', 'Making it directed'], a: 1, why: 'A small fraction of rewired edges cuts the typical path length sharply while most neighbourhoods stay clustered.' },
            { q: 'In a scale-free network with a few big hubs, which attack fragments it most?', o: ['Removing random nodes', 'Removing the highest-degree hubs', 'Removing leaf nodes', 'Removing nothing'], a: 1, why: 'Random failure mostly hits low-degree nodes, which do little. Targeted removal of hubs breaks many shortest paths at once.' },
            { q: 'After t rounds of message passing, which nodes can influence a node’s feature?', o: ['Only its direct neighbours', 'Nodes up to t hops away', 'Nodes up to 2t hops away', 'Every node, always'], a: 1, why: 'Each round moves information along one edge, so the receptive field grows by one hop per round.' },
            { q: 'What is over-smoothing in a deep graph network?', o: ['Too few layers', 'After many rounds node features become nearly identical, so nodes can no longer be told apart', 'The graph turns directed', 'Weights become zero'], a: 1, why: 'Repeated averaging washes out differences. Skip connections and normalisation slow it down.' },
            { q: 'In backpropagation on a computation graph, a value feeds two later nodes. How are the two gradient contributions combined?', o: ['Multiplied', 'Added', 'Averaged', 'Only the larger is kept'], a: 1, why: 'The multivariable chain rule sums over every path from the loss back to that node; along a single path the local slopes multiply.' },
            { q: 'Why does a recurrent network’s graph complicate plain backpropagation?', o: ['It has cycles, so it must be unrolled over time to become a directed acyclic graph', 'It has no edges', 'It is undirected', 'It needs a GPU'], a: 0, why: 'Backpropagation needs an order in which to visit nodes. Unrolling through time (BPTT) removes the cycles.' },
            { q: 'A node’s clustering coefficient equals 1. What does that say?', o: ['It has no neighbours', 'All of its neighbours are also connected to each other', 'It is a hub', 'It lies on every shortest path'], a: 1, why: 'The coefficient is the fraction of possible links among neighbours that exist. 1 means they form a clique with the node.' },
            { q: 'In a star graph with 9 leaves, how many hops separate two leaves?', o: ['1', '2', '3', '9'], a: 1, why: 'Every leaf connects only to the centre, so any two leaves are two hops apart: a very short diameter with extreme dependence on one hub.' },
        ],
        evo: [
            { q: 'The offspring of two full siblings has an inbreeding coefficient F of…', o: ['0', '1/16', '1/8', '1/4'], a: 3, why: 'Two common ancestors, each reached by one generation on each side: 2 × (½)³ = ¼.' },
            { q: 'Why do harmful recessive traits appear more often with inbreeding?', o: ['The mutation rate rises', 'Relatives share copies of the same alleles, so offspring are more likely to carry two copies, which is what a recessive needs to show', 'Inbreeding creates new genes', 'Dominant genes disappear'], a: 1, why: 'Inbreeding does not create harmful alleles. It raises the chance that both copies at a locus are identical by descent, exposing recessives that were hidden in heterozygotes.' },
            { q: 'A breeder uses one champion male for most matings. What happens to the population’s effective size?', o: ['It rises', 'It falls far below the head count, so inbreeding accumulates faster', 'It stays the same', 'Nothing changes genetically'], a: 1, why: 'Effective size is set by how evenly individuals contribute offspring. A single popular sire shrinks it dramatically.' },
            { q: 'One male and nine females, census 10. The effective size 4·Nm·Nf/(Nm + Nf) is about…', o: ['10', '5', '3.6', '1'], a: 2, why: '4·1·9/10 = 3.6: the population behaves genetically like fewer than four breeders.' },
            { q: 'With random mating in a population of N = 10, heterozygosity shrinks by (1 − 1/2N) = 0.95 per generation. After about how many generations is half of it gone?', o: ['5', '14', '50', '140'], a: 1, why: 'ln 0.5 / ln 0.95 ≈ 13.5. Drift is slow per generation but relentless in a small population.' },
            { q: 'In 1995 eight female Texas pumas were released into the Florida panther range. What did that genetic rescue mainly do?', o: ['Remove every harmful mutation', 'Restore heterozygosity, masking harmful recessives and reversing signs such as kinked tails and heart defects', 'Make the panthers larger', 'Stop them breeding'], a: 1, why: 'Studies found the benefit came from increased heterozygosity, not from deleting harmful variants: the load is still there, hidden, and could return.' },
            { q: 'The “Big Bird” finch lineage on Daphne Major (founded by an immigrant male in 1981) bred within itself for several generations and persisted. What is the careful lesson?', o: ['Inbreeding is harmless', 'Harm depends on the hidden genetic load and on selection, so a small isolated lineage can persist, but a few dozen birds is far from safe', 'Hybrids are always inferior', 'The founder had no beak variation'], a: 1, why: 'One case shows inbreeding need not be immediately fatal. It does not show it is safe: with about 30 birds the lineage is exposed to bad luck and a changing environment.' },
            { q: 'Breeder’s equation: selection differential S = 1.0 SD and heritability h² = 0.4. What response R do you expect in the next generation?', o: ['0.4 SD', '1.4 SD', '2.5 SD', '0'], a: 0, why: 'R = h² S. Only the heritable part of what selection chose is passed on.' },
            { q: 'A genetic algorithm has collapsed onto one mediocre peak. Which change most directly restores exploration?', o: ['Breed only from the top 5 %', 'Inject random immigrants or add fitness sharing', 'Set mutation to zero', 'Halve the population'], a: 1, why: 'Immigrants and niching bring or protect variation. More selection pressure and a smaller population do the opposite.' },
            { q: 'Fitness sharing (niching) works by…', o: ['Dividing an individual’s fitness by how crowded its neighbourhood is', 'Deleting the best individual each generation', 'Doubling mutation', 'Selecting only the oldest'], a: 0, why: 'A crowded niche splits its reward among its members, so lone explorers on other peaks stay competitive.' },
            { q: 'Training a model again and again on text produced by earlier versions of itself tends to lose rare, tail content. Which biological idea is that closest to?', o: ['Hybrid vigour', 'Inbreeding and loss of diversity', 'Photosynthesis', 'Reduced mutation load'], a: 1, why: 'Each generation samples from the last one’s distribution and loses the rare cases, like drift in a small population. Mixing in fresh real data plays the part of outcrossing.' },
            { q: 'Which are sensible ways to reduce inbreeding in a small managed population? Select all.', o: ['Introduce unrelated individuals (outcrossing)', 'Pair animals with low kinship', 'Use the same top sire again and again', 'Equalise how many offspring each parent contributes'], a: [0, 1, 3], why: 'Outcrossing, kinship-based pairing and equal family sizes all slow the loss of diversity. A single popular sire does the opposite.' },
            { q: 'Purging removes harmful recessives once they appear as homozygotes. When is it least reliable?', o: ['When the alleles are strongly lethal', 'When many alleles each have a small harmful effect, so selection barely sees them and drift can fix them', 'When the population is large', 'Never'], a: 1, why: 'Selection acts strongly on severe effects, which is why purging can work for them. Mild effects behave nearly neutrally in small populations and accumulate.' },
        ],
    };

    const STORE = 'flykart-quiz-v1';
    function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
    function save(all) { try { localStorage.setItem(STORE, JSON.stringify(all)); } catch (e) { /* storage may be unavailable */ } }

    function pick(rand, pool, n) {
        const a = pool.map((q, i) => ({ q, i })); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a.slice(0, n).map(x => x.q);
    }
    function prepare(q, rand) {
        const order = q.o.map((_, i) => i); for (let i = order.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        const correct = (Array.isArray(q.a) ? q.a : [q.a]).map(old => order.indexOf(old));
        return { q: q.q, o: order.map(i => q.o[i]), correct: correct.sort((x, y) => x - y), multi: Array.isArray(q.a), why: q.why, topic: q.topic };
    }
    function build(spec, rand) {
        const items = [];
        if (spec.mix) Object.entries(spec.mix).forEach(([topic, n]) => pick(rand, BANK[topic].map(q => ({ ...q, topic })), n).forEach(q => items.push(q)));
        else pick(rand, BANK[spec.topic].map(q => ({ ...q, topic: spec.topic })), spec.count).forEach(q => items.push(q));
        for (let i = items.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
        return items.map(q => prepare(q, rand));
    }

    const TOPIC_NAMES = { loss: 'Loss functions', graph: 'Graphs', evo: 'Inbreeding & diversity', core: 'Neurons & the body' };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    function mount(el) {
        const id = el.dataset.quiz;
        const spec = el.dataset.mix ? { mix: Object.fromEntries(el.dataset.mix.split(',').map(p => { const [t, n] = p.split(':'); return [t, Number(n)]; })) } : { topic: el.dataset.topic, count: Number(el.dataset.count || 6) };
        const title = el.dataset.title || 'Quiz';
        let items = [], index = 0, answers = [], seed = Date.now() % 100000, picked = new Set(), locked = false;

        function start(subset) { items = subset || build(spec, K.rng(seed)); index = 0; answers = []; picked = new Set(); locked = false; render(); }
        function best() { const all = load(); return all[id] || null; }

        function render() {
            if (index >= items.length) return summary();
            const it = items[index], b = best();
            el.innerHTML =
                '<div class="quiz-head"><strong>' + esc(title) + '</strong><span>Question ' + (index + 1) + ' of ' + items.length + (b ? ' · best ' + b.best + '/' + b.total : '') + '</span></div>' +
                '<div class="quiz-bar"><i style="width:' + (index / items.length * 100).toFixed(0) + '%"></i></div>' +
                '<p class="quiz-q">' + esc(it.q) + '</p>' +
                (it.multi ? '<p class="quiz-hint">Select every answer that applies, then check.</p>' : '') +
                '<div class="quiz-opts" role="group">' + it.o.map((o, i) => '<button type="button" data-i="' + i + '" aria-pressed="false">' + esc(o) + '</button>').join('') + '</div>' +
                '<div class="quiz-feedback" hidden></div><div class="quiz-actions"></div>';
            const opts = [...el.querySelectorAll('.quiz-opts button')], actions = el.querySelector('.quiz-actions');
            picked = new Set(); locked = false;
            if (it.multi) { const go = document.createElement('button'); go.type = 'button'; go.className = 'quiz-primary'; go.textContent = 'Check answer'; go.addEventListener('click', () => { if (picked.size) check(); }); actions.appendChild(go); }
            opts.forEach(btn => btn.addEventListener('click', () => {
                if (locked) return; const i = Number(btn.dataset.i);
                if (it.multi) { if (picked.has(i)) picked.delete(i); else picked.add(i); btn.setAttribute('aria-pressed', String(picked.has(i))); btn.classList.toggle('picked', picked.has(i)); }
                else { picked = new Set([i]); check(); }
            }));
        }
        function check() {
            const it = items[index]; locked = true;
            const right = it.correct.length === picked.size && it.correct.every(i => picked.has(i));
            answers.push({ item: it, right, picked: [...picked] });
            el.querySelectorAll('.quiz-opts button').forEach((btn, i) => {
                btn.disabled = true;
                if (it.correct.includes(i)) btn.classList.add('correct'); else if (picked.has(i)) btn.classList.add('wrong');
            });
            const fb = el.querySelector('.quiz-feedback'); fb.hidden = false; fb.className = 'quiz-feedback ' + (right ? 'ok' : 'no');
            fb.innerHTML = '<b>' + (right ? 'Correct.' : 'Not quite.') + '</b> ' + esc(it.why);
            const actions = el.querySelector('.quiz-actions'); actions.innerHTML = '';
            const next = document.createElement('button'); next.type = 'button'; next.className = 'quiz-primary'; next.textContent = index + 1 < items.length ? 'Next question' : 'See my result';
            next.addEventListener('click', () => { index += 1; render(); }); actions.appendChild(next); next.focus();
        }
        function summary() {
            const score = answers.filter(a => a.right).length, total = items.length;
            const all = load(); const prev = all[id] || { best: 0, total, attempts: 0 };
            all[id] = { best: Math.max(prev.best, score), total, attempts: prev.attempts + 1, last: score }; save(all);
            document.dispatchEvent(new CustomEvent('edu-quiz-updated'));
            const byTopic = {}; answers.forEach(a => { const t = a.item.topic; byTopic[t] = byTopic[t] || { r: 0, n: 0 }; byTopic[t].n += 1; if (a.right) byTopic[t].r += 1; });
            const missed = answers.filter(a => !a.right);
            const verdict = score === total ? 'Everything right.' : score >= total * 0.75 ? 'Solid grasp: review the misses below.' : score >= total * 0.5 ? 'Half way there: reread the sections the misses point to.' : 'Worth another pass through the chapter; the labs are the quickest route.';
            el.innerHTML =
                '<div class="quiz-head"><strong>' + esc(title) + '</strong><span>Result</span></div>' +
                '<div class="quiz-score"><b>' + score + '</b><span>/ ' + total + '</span><p>' + verdict + '</p></div>' +
                '<div class="quiz-topics">' + Object.entries(byTopic).map(([t, v]) => '<div><span>' + esc(TOPIC_NAMES[t] || t) + '</span><i style="--w:' + (v.r / v.n * 100).toFixed(0) + '%"></i><b>' + v.r + '/' + v.n + '</b></div>').join('') + '</div>' +
                (missed.length ? '<h5>Review</h5><ol class="quiz-review">' + missed.map(a => '<li><p>' + esc(a.item.q) + '</p><p><b>Answer:</b> ' + a.item.correct.map(i => esc(a.item.o[i])).join(' · ') + '</p><p class="why">' + esc(a.item.why) + '</p></li>').join('') + '</ol>' : '') +
                '<div class="quiz-actions"></div>';
            const actions = el.querySelector('.quiz-actions');
            const again = document.createElement('button'); again.type = 'button'; again.className = 'quiz-primary'; again.textContent = 'New set of questions'; again.addEventListener('click', () => { seed += 7919; start(); }); actions.appendChild(again);
            if (missed.length) { const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry only the ones I missed'; retry.addEventListener('click', () => { start(missed.map(a => prepare({ q: a.item.q, o: a.item.o, a: a.item.correct, why: a.item.why, topic: a.item.topic }, K.rng(seed + 3)))); }); actions.appendChild(retry); }
        }
        const idle = () => {
            const b = best();
            el.innerHTML = '<div class="quiz-head"><strong>' + esc(title) + '</strong><span>' + (spec.mix ? Object.values(spec.mix).reduce((a, n) => a + n, 0) : spec.count) + ' questions' + (b ? ' · best ' + b.best + '/' + b.total : '') + '</span></div><p class="quiz-q">' + esc(el.dataset.intro || 'Test yourself. Each question explains its answer, right or wrong.') + '</p><div class="quiz-actions"></div>';
            const go = document.createElement('button'); go.type = 'button'; go.className = 'quiz-primary'; go.textContent = b ? 'Take it again' : 'Start the quiz'; go.addEventListener('click', () => start());
            el.querySelector('.quiz-actions').appendChild(go);
        };
        idle();
    }

    function hub() {
        const el = K.$('quizHub'); if (!el) return;
        const draw = () => {
            const all = load();
            const rows = [...document.querySelectorAll('.quiz[data-quiz]')].map(q => ({ id: q.dataset.quiz, title: q.dataset.title || q.dataset.quiz }));
            el.innerHTML = rows.map(r => { const s = all[r.id]; return '<div class="hub-row"><span>' + esc(r.title) + '</span><i style="--w:' + (s ? (s.best / s.total * 100).toFixed(0) : 0) + '%"></i><b>' + (s ? s.best + '/' + s.total : 'not yet') + '</b><small>' + (s ? s.attempts + (s.attempts === 1 ? ' attempt' : ' attempts') : '') + '</small></div>'; }).join('');
        };
        draw(); document.addEventListener('edu-quiz-updated', draw);
        const reset = K.$('quizReset'); if (reset) reset.addEventListener('click', () => { save({}); document.dispatchEvent(new CustomEvent('edu-quiz-updated')); document.querySelectorAll('.quiz[data-quiz]').forEach(q => mount(q)); });
    }

    root.EduLabs = root.EduLabs || {};
    root.EduLabs.quiz = { BANK, build, prepare, pick };
    if (typeof document === 'undefined') return;
    const boot = () => { document.querySelectorAll('.quiz[data-quiz]').forEach(mount); hub(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
