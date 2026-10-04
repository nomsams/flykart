// Part I · guided route: progress thread and the neuron-model labs added in
// Chapters 2–8. Relies on crispCanvas() from the page's inline script.
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const BG = '#101a16';
    const TEXT = '#b8c8be';
    const DIM = '#6f8a7c';
    const GRID = '#2e4a3d';
    const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
    const signed = (value, digits = 2) => (value < 0 ? '−' : value > 0 ? '+' : '') + Math.abs(value).toFixed(digits);
    const mv = (value, digits = 0) => signed(value, digits) + ' mV';
    const thousands = value => Math.round(value).toLocaleString('en-US');

    function seededRandom(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function gaussian(random) {
        const u = Math.max(1e-9, random());
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    }

    // Segmented button group (presets, protocols, modes).
    function segmented(groupId, key, onChange) {
        const group = $(groupId);
        const buttons = Array.from(group.querySelectorAll('button'));
        let value = (buttons.find(button => button.classList.contains('active')) || buttons[0]).dataset[key];
        const sync = () => buttons.forEach(button => {
            const on = button.dataset[key] === value;
            button.classList.toggle('active', on);
            button.setAttribute('aria-pressed', String(on));
        });
        buttons.forEach(button => button.addEventListener('click', () => {
            value = button.dataset[key];
            sync();
            onChange(value);
        }));
        sync();
        return { get: () => value, set(next) { value = next; sync(); } };
    }

    function setStatus(el, text, tone) {
        el.textContent = text;
        el.className = 'ap-status' + (tone ? ' ' + tone : '');
    }

    function paint(ctx, width, height) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, width, height);
    }

    function text(ctx, value, x, y, color = TEXT, font = '11px system-ui', align = 'left') {
        ctx.fillStyle = color;
        ctx.font = font;
        ctx.textAlign = align;
        ctx.fillText(value, x, y);
        ctx.textAlign = 'left';
    }

    function hLine(ctx, x0, x1, y, color, dash) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(dash || []);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.setLineDash([]);
    }

    function trace(ctx, count, xAt, yAt, color, width, dash) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
            const x = xAt(i), y = yAt(i);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Pause a lab's animation when it scrolls out of view.
    function whenHidden(el, callback) {
        if (!('IntersectionObserver' in window)) return;
        new IntersectionObserver(entries => entries.forEach(entry => {
            if (!entry.isIntersecting) callback();
        }), { threshold: 0 }).observe(el);
    }

    /* ------------------------------------------------------------------
       The red thread: sticky chapter progress and the kart-brain chips
       ------------------------------------------------------------------ */
    (function threadBar() {
        const guide = $('model-ladder');
        if (!guide) return;
        const chapters = Array.from(guide.querySelectorAll(':scope > article.book-chapter'));
        const links = Array.from(guide.querySelectorAll('.tb-track a'));
        const numEl = guide.querySelector('[data-tb-num]');
        const titleEl = guide.querySelector('[data-tb-title]');
        const prev = guide.querySelector('[data-tb-prev]');
        const next = guide.querySelector('[data-tb-next]');
        let queued = false;

        function update() {
            queued = false;
            const marker = window.innerHeight * 0.35;
            let current = 0;
            chapters.forEach((chapter, index) => {
                const box = chapter.getBoundingClientRect();
                if (box.top <= marker) current = index;
                let fill = 0;
                if (box.bottom <= marker) fill = 1;
                else if (box.top <= marker) fill = (marker - box.top) / box.height;
                const link = links[index];
                if (!link) return;
                link.style.setProperty('--fill', (clamp(fill, 0, 1) * 100).toFixed(1) + '%');
                link.classList.toggle('done', fill >= 0.999);
            });
            links.forEach((link, index) => {
                link.classList.toggle('current', index === current);
                if (index === current) link.setAttribute('aria-current', 'step'); else link.removeAttribute('aria-current');
            });
            numEl.textContent = String(current + 1);
            titleEl.textContent = chapters[current].dataset.title || '';
            prev.href = current > 0 ? '#' + chapters[current - 1].id : '#model-ladder';
            next.href = current < chapters.length - 1 ? '#' + chapters[current + 1].id : '#biophysics';
        }
        const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        update();
    })();

    (function brainChips() {
        const pieces = ['Spike events', 'Leaky memory', 'Threshold + reset', 'Weighted inputs', 'Recurrent loops', 'Smoothed readout', 'Evolved weights', 'Compute budget'];
        document.querySelectorAll('.brain-build').forEach(el => {
            const upto = Number(el.dataset.upto);
            const newFrom = Number(el.dataset.newFrom || upto);
            el.setAttribute('role', 'list');
            el.setAttribute('aria-label', 'Kart brain: ' + upto + ' of 8 pieces in place');
            pieces.forEach((name, index) => {
                const chip = document.createElement('span');
                chip.setAttribute('role', 'listitem');
                chip.textContent = name;
                const n = index + 1;
                if (n <= upto) chip.className = n >= newFrom ? 'new' : 'on';
                el.appendChild(chip);
            });
        });
    })();

    /* ------------------------------------------------------------------
       Lab 2.2 · Hodgkin–Huxley (1952 squid-axon parameters, rest −65 mV)
       ------------------------------------------------------------------ */
    (function hodgkinHuxleyLab() {
        const canvas = $('bioNeuronCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 400;
        const ampInput = $('bioCurrentInput');
        const gapInput = $('bioGapInput');
        const ttx = $('hhTtxToggle');
        const tea = $('hhTeaToggle');
        const runBtn = $('fireBioBtn');
        const tag = $('bioStatusTag');
        const T = 50, DT = 0.01, EVERY = 5;
        const E_NA = 50, E_K = -77, E_L = -54.387, G_NA = 120, G_K = 36, G_L = 0.3;
        const FLOPS_PER_MS = 1200;
        const plot = { x0: 58, x1: 588 };
        const mapT = t => plot.x0 + t / T * (plot.x1 - plot.x0);
        let data = null;
        let cursor = T;
        let playing = false;
        let startStamp = 0;

        const protocol = segmented('hhProtocol', 'protocol', () => { stop(); recompute(); });

        function rates(V) {
            const am = Math.abs(V + 40) < 1e-7 ? 1 : 0.1 * (V + 40) / (1 - Math.exp(-(V + 40) / 10));
            const bm = 4 * Math.exp(-(V + 65) / 18);
            const ah = 0.07 * Math.exp(-(V + 65) / 20);
            const bh = 1 / (1 + Math.exp(-(V + 35) / 10));
            const an = Math.abs(V + 55) < 1e-7 ? 0.1 : 0.01 * (V + 55) / (1 - Math.exp(-(V + 55) / 10));
            const bn = 0.125 * Math.exp(-(V + 65) / 80);
            return { am, bm, ah, bh, an, bn };
        }

        function stimulus(t) {
            const amp = Number(ampInput.value);
            const gap = Number(gapInput.value);
            const mode = protocol.get();
            if (mode === 'step') return t >= 5 ? amp : 0;
            if (t >= 5 && t < 6) return amp;
            if (mode === 'pair' && t >= 5 + gap && t < 6 + gap) return amp;
            return 0;
        }

        function simulate() {
            const gNa = ttx.checked ? 0 : G_NA;
            const frozenK = tea.checked;
            let V = -65;
            let r = rates(V);
            let m = r.am / (r.am + r.bm), h = r.ah / (r.ah + r.bh), n = r.an / (r.an + r.bn);
            const nRest = n;
            const advance = I => {
                r = rates(V);
                const iNa = gNa * m * m * m * h * (E_NA - V);
                const iK = G_K * n ** 4 * (E_K - V);
                const iL = G_L * (E_L - V);
                V += DT * (iNa + iK + iL + I);
                m += DT * (r.am * (1 - m) - r.bm * m);
                h += DT * (r.ah * (1 - h) - r.bh * h);
                if (!frozenK) n += DT * (r.an * (1 - n) - r.bn * n); else n = nRest;
                return { iNa, iK };
            };
            // Let this channel configuration settle to its own resting state first.
            for (let t = 0; t < 30; t += DT) advance(0);
            const vRest = V, hRest = h, nRestNow = n;
            const gRest = gNa * m ** 3 * h + G_K * n ** 4 + G_L;
            let passive = vRest;
            const out = { t: [], V: [], P: [], m: [], h: [], n: [], iNa: [], iK: [], I: [], spikes: [], vRest, hRest, nRest: nRestNow };
            let above = false;
            const steps = Math.round(T / DT);
            for (let k = 0; k <= steps; k++) {
                const t = k * DT;
                const I = stimulus(t);
                const currents = advance(I);
                passive += DT * (-gRest * (passive - vRest) + I);
                if (V > 0 && !above) { out.spikes.push(t); above = true; }
                if (V < -30) above = false;
                if (k % EVERY === 0) {
                    out.t.push(t); out.V.push(V); out.P.push(passive);
                    out.m.push(m); out.h.push(h); out.n.push(n);
                    out.iNa.push(currents.iNa); out.iK.push(currents.iK); out.I.push(I);
                }
            }
            return out;
        }

        function phaseAt(i) {
            const V = data.V[i];
            const dV = data.V[Math.min(data.V.length - 1, i + 1)] - data.V[Math.max(0, i - 1)];
            if (V > -40 && dV > 0) return ['rising · Na⁺ rushes in', 'firing'];
            if (V > -40) return ['falling · K⁺ flows out', 'recovering'];
            if (V < data.vRest - 1.5) return ['undershoot · K⁺ still open', 'recovering'];
            if (data.h[i] < data.hRest * 0.75 || data.n[i] > data.nRest * 1.25) return ['refractory · gates resetting', 'recovering'];
            if (data.I[i] > 0) return ['charging the capacitor', ''];
            return ['resting', ''];
        }

        function draw() {
            paint(ctx, W, H);
            const last = Math.min(data.t.length - 1, Math.round(cursor / (DT * EVERY)));
            const count = last + 1;
            // Voltage panel
            const vy0 = 26, vy1 = 188, vMin = -90, vMax = 55;
            const mapV = v => vy0 + (vMax - clamp(v, vMin, vMax)) / (vMax - vMin) * (vy1 - vy0);
            text(ctx, 'MEMBRANE VOLTAGE', plot.x0, 16, TEXT, '800 11px system-ui');
            text(ctx, 'grey dashed: same membrane, gates frozen at rest (the RC circuit)', plot.x0 + 132, 16, DIM, '10px system-ui');
            hLine(ctx, plot.x0, plot.x1, mapV(0), GRID);
            hLine(ctx, plot.x0, plot.x1, mapV(data.vRest), '#456054', [4, 4]);
            text(ctx, '0', plot.x0 - 8, mapV(0) + 4, DIM, '10px system-ui', 'right');
            text(ctx, '+50', plot.x0 - 8, mapV(50) + 4, DIM, '10px system-ui', 'right');
            text(ctx, mv(data.vRest), plot.x0 - 8, mapV(data.vRest) + 4, DIM, '10px system-ui', 'right');
            trace(ctx, data.t.length, i => mapT(data.t[i]), i => mapV(data.P[i]), '#7b8790', 1.5, [5, 4]);
            trace(ctx, data.t.length, i => mapT(data.t[i]), i => mapV(data.V[i]), 'rgba(216,233,133,.18)', 2);
            trace(ctx, count, i => mapT(data.t[i]), i => mapV(data.V[i]), '#d8e985', 2.6);
            // Gate panel
            const gy0 = 212, gy1 = 290;
            const mapG = g => gy1 - g * (gy1 - gy0);
            ctx.strokeStyle = GRID; ctx.strokeRect(plot.x0, gy0, plot.x1 - plot.x0, gy1 - gy0);
            text(ctx, 'GATES', plot.x0, gy0 - 6, TEXT, '800 11px system-ui');
            text(ctx, 'm · Na⁺ activation', plot.x0 + 50, gy0 - 6, '#67e8f9', '700 10px system-ui');
            text(ctx, 'h · Na⁺ inactivation', plot.x0 + 170, gy0 - 6, '#c4b5fd', '700 10px system-ui');
            text(ctx, 'n · K⁺ activation', plot.x0 + 300, gy0 - 6, '#fbbf24', '700 10px system-ui');
            text(ctx, '1', plot.x0 - 8, gy0 + 8, DIM, '10px system-ui', 'right');
            text(ctx, '0', plot.x0 - 8, gy1, DIM, '10px system-ui', 'right');
            [['m', '#67e8f9'], ['h', '#c4b5fd'], ['n', '#fbbf24']].forEach(([key, color]) => {
                trace(ctx, count, i => mapT(data.t[i]), i => mapG(data[key][i]), color, 2);
            });
            // Stimulus strip
            const sy0 = 312, sy1 = 342;
            const ampMax = Math.max(1, ...data.I);
            text(ctx, 'STIMULUS', plot.x0, sy0 - 6, TEXT, '800 11px system-ui');
            hLine(ctx, plot.x0, plot.x1, sy1, GRID);
            trace(ctx, data.t.length, i => mapT(data.t[i]), i => sy1 - data.I[i] / ampMax * (sy1 - sy0), '#ef6f61', 2);
            for (let t = 0; t <= T; t += 10) text(ctx, t + (t === T ? ' ms' : ''), mapT(t), 362, DIM, '10px system-ui', 'center');
            // Cursor
            const cx = mapT(data.t[last]);
            ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(cx, vy0); ctx.lineTo(cx, sy1); ctx.stroke();
            ctx.fillStyle = '#ef6f61';
            ctx.beginPath(); ctx.arc(cx, mapV(data.V[last]), 4.5, 0, Math.PI * 2); ctx.fill();

            // Right panel: the doors at the cursor
            const px = 622, pw = 262;
            const m = data.m[last], h = data.h[last], n = data.n[last];
            const naOpen = ttx.checked ? 0 : m ** 3 * h;
            const kOpen = n ** 4;
            text(ctx, 'AT THE CURSOR · t = ' + data.t[last].toFixed(1) + ' ms', px, 16, TEXT, '800 11px system-ui');
            const bar = (y, label, value, full, color, note) => {
                text(ctx, label, px, y, '#eef6f0', '700 11px system-ui');
                text(ctx, note, px + pw, y, color, '700 11px system-ui', 'right');
                ctx.fillStyle = '#1f3229'; ctx.fillRect(px, y + 6, pw, 12);
                ctx.fillStyle = color; ctx.fillRect(px, y + 6, pw * clamp(value / full, 0, 1), 12);
            };
            bar(42, 'Na⁺ doors open (m³h)', naOpen, 0.5, '#67e8f9', (naOpen * 100).toFixed(1) + '%');
            bar(78, 'K⁺ doors open (n⁴)', kOpen, 0.5, '#fbbf24', (kOpen * 100).toFixed(1) + '%');
            const iNa = data.iNa[last], iK = data.iK[last];
            const mag = value => Math.sqrt(Math.abs(value)) / Math.sqrt(2200);
            bar(114, 'Na⁺ current, inward', mag(iNa), 1, '#67e8f9', thousands(Math.abs(iNa)) + ' µA/cm²');
            bar(150, 'K⁺ current, outward', mag(iK), 1, '#fbbf24', thousands(Math.abs(iK)) + ' µA/cm²');
            text(ctx, 'bars for currents use a square-root scale', px, 186, DIM, '10px system-ui');
            const phase = phaseAt(last);
            ctx.fillStyle = phase[1] === 'firing' ? 'rgba(239,111,97,.16)' : phase[1] === 'recovering' ? 'rgba(247,220,134,.12)' : 'rgba(255,255,255,.05)';
            ctx.fillRect(px, 200, pw, 40);
            text(ctx, phase[0], px + 10, 225, phase[1] === 'firing' ? '#ffb4a8' : phase[1] === 'recovering' ? '#f7dc86' : '#eef6f0', '800 13px system-ui');
            const spikesSoFar = data.spikes.filter(t => t <= data.t[last]).length;
            const flops = FLOPS_PER_MS * data.t[last];
            text(ctx, 'ARITHMETIC SO FAR', px, 268, TEXT, '800 11px system-ui');
            text(ctx, thousands(flops) + ' FLOPs', px, 292, '#f7dc86', '800 18px ui-monospace, monospace');
            text(ctx, 'LIF would need ≈ ' + thousands(5 * data.t[last]) + ' for the same time', px, 312, DIM, '10px system-ui');
            text(ctx, 'spikes so far: ' + spikesSoFar, px, 336, '#eef6f0', '700 11px system-ui');
            if (ttx.checked) text(ctx, 'TTX: sodium doors blocked', px, 356, '#67e8f9', '700 10px system-ui');
            if (tea.checked) text(ctx, 'TEA: K⁺ doors stuck at resting level', px, ttx.checked ? 372 : 356, '#fbbf24', '700 10px system-ui');

            let peak = -Infinity;
            for (let i = 0; i <= last; i++) peak = Math.max(peak, data.V[i]);
            $('bioVoltageReadout').textContent = mv(peak);
            $('bioPhaseReadout').textContent = String(spikesSoFar);
            $('bioDistanceReadout').textContent = thousands(flops) + ' FLOPs';
            setStatus(tag, playing ? phase[0] : (data.spikes.length ? data.spikes.length + (data.spikes.length === 1 ? ' spike' : ' spikes') + ' in 50 ms' : 'no spike · passive response'), playing ? phase[1] : (data.spikes.length ? 'firing' : ''));
        }

        function syncLabels() {
            $('bioCurrentValue').textContent = Number(ampInput.value).toFixed(1).replace('.0', '') + ' µA/cm²';
            $('bioGapValue').textContent = Number(gapInput.value).toFixed(1).replace('.0', '') + ' ms';
            const pair = protocol.get() === 'pair';
            gapInput.disabled = !pair;
            gapInput.closest('.ap-controls').querySelector('label[for="bioGapInput"]').style.opacity = pair ? 1 : .45;
        }

        function recompute() {
            syncLabels();
            data = simulate();
            if (!playing) cursor = T;
            draw();
        }

        function frame(stamp) {
            if (!playing) return;
            if (!startStamp) startStamp = stamp;
            cursor = Math.min(T, (stamp - startStamp) / 2600 * T);
            draw();
            if (cursor < T) requestAnimationFrame(frame);
            else { stop(); draw(); }
        }

        function stop() {
            playing = false;
            startStamp = 0;
            runBtn.textContent = 'Run 50 ms';
        }

        runBtn.addEventListener('click', () => {
            if (playing) { stop(); draw(); return; }
            playing = true;
            startStamp = 0;
            cursor = 0;
            runBtn.textContent = 'Pause';
            requestAnimationFrame(frame);
        });
        $('resetBioBtn').addEventListener('click', () => {
            stop();
            ampInput.value = '10';
            gapInput.value = '20';
            ttx.checked = false;
            tea.checked = false;
            protocol.set('pulse');
            recompute();
        });
        [ampInput, gapInput].forEach(input => input.addEventListener('input', () => { stop(); recompute(); }));
        [ttx, tea].forEach(input => input.addEventListener('change', () => { stop(); recompute(); }));
        whenHidden(canvas, () => { if (playing) { stop(); draw(); } });
        recompute();
    })();

    /* ------------------------------------------------------------------
       Lab 3.1 · One LIF neuron and its tuning curve
       ------------------------------------------------------------------ */
    (function lifLab() {
        const canvas = $('lifCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 400;
        const R = 10, V_REST = -70, DT = 0.1, T = 200;
        const currentInput = $('lifCurrentInput');
        const tauInput = $('lifTauInput');
        const thresholdInput = $('lifThresholdInput');
        const refInput = $('lifRefInput');
        const reluToggle = $('lifReluToggle');
        const runBtn = $('lifRunBtn');
        const sweepBtn = $('lifSweepBtn');
        const tag = $('lifStatusTag');
        const plot = { x0: 104, x1: 596 };
        const fi = { x0: 648, x1: 882, y0: 26, y1: 318 };
        const I_MAX = 4;
        const modeColors = { constant: '#fbbf24', noisy: '#67e8f9', pulses: '#c4b5fd' };
        let run = null;
        let cursor = T;
        let playing = false;
        let startStamp = 0;
        let sweeping = false;
        let points = [];

        const mode = segmented('lifMode', 'mode', () => { stop(); simulateCurrent(); });
        const params = () => ({ I: Number(currentInput.value), tau: Number(tauInput.value), theta: Number(thresholdInput.value), ref: Number(refInput.value) });

        function simulate(I, pattern) {
            const { tau, theta, ref } = params();
            const random = seededRandom(1234 + Math.round(I * 100));
            const steps = Math.round(T / DT);
            const V = new Float32Array(steps + 1);
            const input = new Float32Array(steps + 1);
            const spikes = [];
            let v = V_REST, holdUntil = -1, noise = 0;
            V[0] = v;
            for (let k = 0; k <= steps; k++) {
                const t = k * DT;
                let current = I;
                if (pattern === 'noisy') {
                    noise += -noise / 3 * DT + Math.sqrt(2 * DT / 3) * gaussian(random);
                    current = I + 0.7 * noise;
                } else if (pattern === 'pulses') {
                    current = (t % 12) < 4 ? 3 * I : 0;
                }
                input[k] = current;
                if (k === 0) continue;
                if (t < holdUntil) v = V_REST;
                else {
                    v += DT / tau * (-(v - V_REST) + R * input[k - 1]);
                    if (v >= theta) { spikes.push(t); v = V_REST; holdUntil = t + ref; }
                }
                V[k] = v;
            }
            return { I, pattern, V, input, spikes, rate: spikes.length / (T / 1000), tau, theta, ref };
        }

        function analyticRate(I) {
            const { tau, theta, ref } = params();
            const drive = R * I, gap = theta - V_REST;
            if (drive <= gap) return 0;
            return 1000 / (ref + tau * Math.log(drive / (drive - gap)));
        }

        function addPoint(result) {
            points = points.filter(p => !(p.pattern === result.pattern && Math.abs(p.I - result.I) < 1e-6));
            points.push({ I: result.I, rate: result.rate, pattern: result.pattern });
        }

        function draw() {
            paint(ctx, W, H);
            const { tau, theta, ref } = run;
            const steps = run.V.length - 1;
            const last = Math.min(steps, Math.round(cursor / DT));
            const mapT = t => plot.x0 + t / T * (plot.x1 - plot.x0);
            // Voltage
            const vy0 = 30, vy1 = 196, vMin = -76, vMax = -40;
            const mapV = v => vy0 + (vMax - clamp(v, vMin, vMax)) / (vMax - vMin) * (vy1 - vy0);
            text(ctx, 'MEMBRANE VOLTAGE', plot.x0, 18, TEXT, '800 11px system-ui');
            hLine(ctx, plot.x0, plot.x1, mapV(theta), '#ef6f61', [5, 4]);
            text(ctx, 'threshold ' + mv(theta), plot.x0 - 6, mapV(theta) + 4, '#efb3aa', '10px system-ui', 'right');
            hLine(ctx, plot.x0, plot.x1, mapV(V_REST), '#456054', [4, 4]);
            text(ctx, 'rest ' + mv(V_REST), plot.x0 - 6, mapV(V_REST) + 4, DIM, '10px system-ui', 'right');
            if (run.pattern === 'constant') {
                const ceiling = V_REST + R * run.I;
                if (ceiling < vMax && ceiling > vMin) {
                    hLine(ctx, plot.x0, plot.x1, mapV(ceiling), '#8f80d6', [2, 4]);
                    text(ctx, 'ceiling V∞ = ' + mv(ceiling), plot.x1 - 4, mapV(ceiling) - 5, '#c4b5fd', '10px system-ui', 'right');
                } else if (ceiling >= vMax) {
                    text(ctx, 'ceiling V∞ = ' + mv(ceiling) + ' (off the chart, above threshold)', plot.x1 - 4, vy0 + 10, '#c4b5fd', '10px system-ui', 'right');
                }
            }
            trace(ctx, last + 1, k => mapT(k * DT), k => mapV(run.V[k]), '#67e8f9', 2.2);
            run.spikes.filter(t => t <= last * DT).forEach(t => {
                ctx.strokeStyle = '#ef6f61'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(mapT(t), mapV(theta)); ctx.lineTo(mapT(t), vy0 - 6); ctx.stroke();
            });
            // Input strip
            const iy0 = 216, iy1 = 262;
            const iMax = Math.max(4.5, ...Array.from(run.input).slice(0, steps + 1));
            text(ctx, 'INPUT CURRENT', plot.x0, iy0 - 6, TEXT, '800 11px system-ui');
            hLine(ctx, plot.x0, plot.x1, iy1, GRID);
            trace(ctx, last + 1, k => mapT(k * DT), k => iy1 - clamp(run.input[k], 0, iMax) / iMax * (iy1 - iy0), '#fbbf24', 1.6);
            for (let t = 0; t <= T; t += 50) text(ctx, t + (t === T ? ' ms' : ''), mapT(t), 278, DIM, '10px system-ui', 'center');
            // Euler box at the cursor
            const k = Math.max(1, last);
            const vPrev = run.V[k - 1], iPrev = run.input[k - 1], tNow = k * DT;
            ctx.fillStyle = '#0b1310'; ctx.fillRect(plot.x0, 292, plot.x1 - plot.x0, 96);
            ctx.strokeStyle = '#263f33'; ctx.strokeRect(plot.x0, 292, plot.x1 - plot.x0, 96);
            text(ctx, 'EULER STEP · t = ' + tNow.toFixed(1) + ' ms · Δt/τ = ' + DT + '/' + tau + ' = ' + (DT / tau).toFixed(4), plot.x0 + 10, 310, '#d8e985', '800 11px system-ui');
            const firedHere = run.spikes.some(t => Math.abs(t - tNow) < DT / 2);
            const held = !firedHere && run.spikes.some(t => tNow > t && tNow < t + ref + 1e-9) && run.V[k] === V_REST;
            const mono = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
            if (held) {
                text(ctx, 'refractory: V is held at reset (' + mv(V_REST) + ') for ' + ref + ' ms after each spike', plot.x0 + 10, 334, '#f7dc86', mono);
                text(ctx, 'no integration happens while the neuron recovers', plot.x0 + 10, 356, DIM, mono);
            } else {
                const leak = -(vPrev - V_REST), drive = R * iPrev;
                const vNext = vPrev + DT / tau * (leak + drive);
                text(ctx, 'leak   −(V − V_rest) = ' + signed(leak) + ' mV', plot.x0 + 10, 332, '#eef6f0', mono);
                text(ctx, 'drive  R·I = 10 MΩ × ' + iPrev.toFixed(2) + ' nA = ' + signed(drive) + ' mV', plot.x0 + 10, 350, '#eef6f0', mono);
                text(ctx, 'V ← ' + vPrev.toFixed(2) + ' + ' + (DT / tau).toFixed(4) + ' × (' + signed(leak + drive) + ') = ' + vNext.toFixed(2) + ' mV', plot.x0 + 10, 368, '#67e8f9', mono);
                if (firedHere) text(ctx, '≥ threshold → spike, reset to ' + mv(V_REST), plot.x0 + 10, 384, '#ffb4a8', '700 ' + mono);
            }
            // Cursor
            if (last < steps) {
                ctx.strokeStyle = 'rgba(255,255,255,.5)';
                ctx.beginPath(); ctx.moveTo(mapT(last * DT), vy0); ctx.lineTo(mapT(last * DT), iy1); ctx.stroke();
            }

            // Tuning curve
            const rMax = Math.max(100, Math.ceil(Math.max(analyticRate(I_MAX), ...points.map(p => p.rate)) / 50) * 50);
            const mapI = I => fi.x0 + I / I_MAX * (fi.x1 - fi.x0);
            const mapR = r => fi.y1 - clamp(r, 0, rMax) / rMax * (fi.y1 - fi.y0);
            text(ctx, 'TUNING CURVE', fi.x0, 18, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.lineWidth = 1;
            ctx.strokeRect(fi.x0, fi.y0, fi.x1 - fi.x0, fi.y1 - fi.y0);
            for (let r = 50; r < rMax; r += 50) hLine(ctx, fi.x0, fi.x1, mapR(r), '#1d2f27');
            text(ctx, rMax + ' Hz', fi.x0 + 4, fi.y0 + 12, DIM, '10px system-ui');
            text(ctx, '0', fi.x0 - 4, fi.y1 + 4, DIM, '10px system-ui', 'right');
            for (let I = 0; I <= I_MAX; I++) text(ctx, String(I), mapI(I), fi.y1 + 14, DIM, '10px system-ui', 'center');
            text(ctx, 'input current I (nA) →', fi.x1, fi.y1 + 30, DIM, '10px system-ui', 'right');
            const rheobase = (theta - V_REST) / R;
            ctx.strokeStyle = '#8f80d6'; ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(mapI(rheobase), fi.y0); ctx.lineTo(mapI(rheobase), fi.y1); ctx.stroke(); ctx.setLineDash([]);
            text(ctx, 'rheobase', mapI(rheobase) + 4, fi.y1 - 6, '#c4b5fd', '10px system-ui');
            trace(ctx, 201, i => mapI(i / 200 * I_MAX), i => mapR(analyticRate(i / 200 * I_MAX)), '#91aa9c', 2);
            if (reluToggle.checked) {
                let num = 0, den = 0;
                for (let i = 0; i <= 80; i++) {
                    const I = rheobase + (I_MAX - rheobase) * i / 80;
                    num += (I - rheobase) * analyticRate(I); den += (I - rheobase) ** 2;
                }
                const slope = den > 0 ? num / den : 0;
                ctx.save();
                ctx.beginPath(); ctx.rect(fi.x0, fi.y0, fi.x1 - fi.x0, fi.y1 - fi.y0); ctx.clip();
                ctx.strokeStyle = '#ef6f61'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(mapI(0), mapR(0)); ctx.lineTo(mapI(rheobase), mapR(0)); ctx.lineTo(mapI(I_MAX), mapR(slope * (I_MAX - rheobase))); ctx.stroke();
                ctx.restore();
                text(ctx, 'ReLU: max(0, k·(I − I_th))', fi.x0 + 6, fi.y0 + 28, '#ffb4a8', '700 10px system-ui');
            }
            points.forEach(p => {
                ctx.fillStyle = modeColors[p.pattern];
                ctx.beginPath(); ctx.arc(mapI(p.I), mapR(p.rate), 4, 0, Math.PI * 2); ctx.fill();
            });
            ctx.strokeStyle = '#eef6f0'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(mapI(run.I), mapR(run.rate), 7, 0, Math.PI * 2); ctx.stroke();
            text(ctx, 'grey: exact LIF prediction', fi.x0, 356, '#91aa9c', '10px system-ui');
            text(ctx, 'dots: measured (colour = input pattern)', fi.x0, 372, '#fbbf24', '10px system-ui');
            text(ctx, 'ring: this run', fi.x0, 388, '#eef6f0', '10px system-ui');

            const spikesSoFar = run.spikes.filter(t => t <= last * DT).length;
            $('lifRateReadout').textContent = playing ? '…' : run.rate.toFixed(0) + ' Hz';
            $('lifRheobaseReadout').textContent = rheobase.toFixed(2) + ' nA';
            $('lifLabSpikeReadout').textContent = String(spikesSoFar);
            if (sweeping) setStatus(tag, 'Sweeping · I = ' + run.I.toFixed(1) + ' nA', 'recovering');
            else if (playing) setStatus(tag, 'Running · ' + (last * DT).toFixed(0) + ' ms', '');
            else if (run.spikes.length === 0) setStatus(tag, 'Silent · the leak wins', '');
            else setStatus(tag, 'Firing · ' + run.rate.toFixed(0) + ' Hz', 'firing');
        }

        function syncLabels() {
            const p = params();
            $('lifCurrentValue').textContent = p.I.toFixed(2) + ' nA';
            $('lifTauValue').textContent = p.tau + ' ms';
            $('lifThresholdValue').textContent = mv(p.theta);
            $('lifRefValue').textContent = p.ref.toFixed(1).replace('.0', '') + ' ms';
        }

        function simulateCurrent() {
            syncLabels();
            run = simulate(params().I, mode.get());
            if (!playing) cursor = T;
            draw();
        }

        function frame(stamp) {
            if (!playing) return;
            if (!startStamp) startStamp = stamp;
            cursor = Math.min(T, (stamp - startStamp) / 2200 * T);
            draw();
            if (cursor < T) requestAnimationFrame(frame);
            else { stop(); addPoint(run); draw(); }
        }

        function stop() {
            playing = false;
            startStamp = 0;
            runBtn.textContent = 'Run 200 ms';
        }

        runBtn.addEventListener('click', () => {
            if (sweeping) return;
            if (playing) { stop(); draw(); return; }
            simulateCurrent();
            playing = true;
            cursor = 0;
            runBtn.textContent = 'Pause';
            requestAnimationFrame(frame);
        });

        sweepBtn.addEventListener('click', () => {
            if (sweeping) return;
            stop();
            sweeping = true;
            const pattern = mode.get();
            const original = params().I;
            let I = 0;
            const tick = () => {
                run = simulate(I, pattern);
                cursor = T;
                addPoint(run);
                draw();
                I = Math.round((I + 0.2) * 100) / 100;
                if (I <= I_MAX + 1e-9) setTimeout(tick, 55);
                else {
                    sweeping = false;
                    run = simulate(original, pattern);
                    draw();
                }
            };
            tick();
        });

        $('lifResetBtn').addEventListener('click', () => {
            stop();
            sweeping = false;
            currentInput.value = '2';
            tauInput.value = '20';
            thresholdInput.value = '-55';
            refInput.value = '2';
            reluToggle.checked = false;
            mode.set('constant');
            points = [];
            simulateCurrent();
        });
        currentInput.addEventListener('input', () => { if (!sweeping) { stop(); simulateCurrent(); } });
        currentInput.addEventListener('change', () => { if (!sweeping) { addPoint(run); draw(); } });
        [tauInput, thresholdInput, refInput].forEach(input => input.addEventListener('input', () => {
            if (sweeping) return;
            stop();
            points = [];
            simulateCurrent();
        }));
        reluToggle.addEventListener('change', () => draw());
        whenHidden(canvas, () => { if (playing) { stop(); draw(); } });
        simulateCurrent();
    })();

    /* ------------------------------------------------------------------
       Lab 3.2 · Izhikevich personalities
       ------------------------------------------------------------------ */
    (function izhikevichLab() {
        const canvas = $('izhCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 380;
        const DT = 0.1, T = 300, ON = 20;
        const PRESETS = {
            rs: { name: 'Regular spiking', a: 0.02, b: 0.2, c: -65, d: 8 },
            ib: { name: 'Intrinsically bursting', a: 0.02, b: 0.2, c: -55, d: 4 },
            ch: { name: 'Chattering', a: 0.02, b: 0.2, c: -50, d: 2 },
            fs: { name: 'Fast spiking', a: 0.1, b: 0.2, c: -65, d: 2 },
            lts: { name: 'Low-threshold spiking', a: 0.02, b: 0.25, c: -65, d: 2 }
        };
        const currentInput = $('izhCurrentInput');
        const aInput = $('izhAInput'), dInput = $('izhDInput'), cInput = $('izhCInput');
        const runBtn = $('izhRunBtn');
        const tag = $('izhStatusTag');
        const plot = { x0: 56, x1: 596 };
        const mapT = t => plot.x0 + t / T * (plot.x1 - plot.x0);
        let b = 0.2;
        let custom = false;
        let data = null;
        let cursor = T;
        let playing = false;
        let startStamp = 0;

        const preset = segmented('izhPreset', 'preset', key => { applyPreset(key); stop(); recompute(); });

        function applyPreset(key) {
            const p = PRESETS[key];
            aInput.value = String(p.a);
            dInput.value = String(p.d);
            cInput.value = String(p.c);
            b = p.b;
            custom = false;
        }

        function simulate() {
            const a = Number(aInput.value), c = Number(cInput.value), d = Number(dInput.value), I = Number(currentInput.value);
            let v = -70, u = b * v;
            const steps = Math.round(T / DT);
            const out = { v: new Float32Array(steps + 1), u: new Float32Array(steps + 1), spikes: [], I, a, c, d };
            out.v[0] = v; out.u[0] = u;
            for (let k = 1; k <= steps; k++) {
                const t = k * DT;
                const input = t >= ON ? I : 0;
                v += DT * (0.04 * v * v + 5 * v + 140 - u + input);
                u += DT * a * (b * v - u);
                if (v >= 30) {
                    out.v[k] = 30;
                    out.u[k] = u;
                    out.spikes.push(t);
                    v = c;
                    u += d;
                    continue;
                }
                out.v[k] = v; out.u[k] = u;
            }
            return out;
        }

        function draw() {
            paint(ctx, W, H);
            const steps = data.v.length - 1;
            const last = Math.min(steps, Math.round(cursor / DT));
            // v panel
            const vy0 = 24, vy1 = 176, vMin = -90, vMax = 35;
            const mapV = v => vy0 + (vMax - clamp(v, vMin, vMax)) / (vMax - vMin) * (vy1 - vy0);
            text(ctx, 'VOLTAGE v', plot.x0, 16, TEXT, '800 11px system-ui');
            hLine(ctx, plot.x0, plot.x1, mapV(30), '#ef6f61', [4, 4]);
            text(ctx, 'peak 30', plot.x0 - 6, mapV(30) + 4, '#efb3aa', '10px system-ui', 'right');
            hLine(ctx, plot.x0, plot.x1, mapV(data.c), '#8f80d6', [2, 4]);
            text(ctx, 'reset c', plot.x0 - 6, mapV(data.c) + 4, '#c4b5fd', '10px system-ui', 'right');
            trace(ctx, last + 1, k => mapT(k * DT), k => mapV(data.v[k]), '#d8e985', 1.6);
            // u panel
            let uMin = Infinity, uMax = -Infinity;
            for (let k = 0; k <= steps; k++) { uMin = Math.min(uMin, data.u[k]); uMax = Math.max(uMax, data.u[k]); }
            const pad = Math.max(1, (uMax - uMin) * 0.15);
            uMin -= pad; uMax += pad;
            const uy0 = 198, uy1 = 282;
            const mapU = u => uy1 - (u - uMin) / (uMax - uMin) * (uy1 - uy0);
            text(ctx, 'RECOVERY u ("tiredness")', plot.x0, uy0 - 6, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(plot.x0, uy0, plot.x1 - plot.x0, uy1 - uy0);
            trace(ctx, last + 1, k => mapT(k * DT), k => mapU(data.u[k]), '#fbbf24', 1.8);
            // input strip
            const sy0 = 300, sy1 = 326;
            text(ctx, 'INPUT', plot.x0, sy0 - 6, TEXT, '800 11px system-ui');
            hLine(ctx, plot.x0, plot.x1, sy1, GRID);
            ctx.strokeStyle = '#ef6f61'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(mapT(0), sy1); ctx.lineTo(mapT(ON), sy1); ctx.lineTo(mapT(ON), data.I > 0 ? sy0 : sy1); ctx.lineTo(mapT(T), data.I > 0 ? sy0 : sy1); ctx.stroke();
            for (let t = 0; t <= T; t += 50) text(ctx, t + (t === T ? ' ms' : ''), mapT(t), 344, DIM, '10px system-ui', 'center');
            if (last < steps) {
                ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(mapT(last * DT), vy0); ctx.lineTo(mapT(last * DT), sy1); ctx.stroke();
            }
            // phase plane
            const pp = { x0: 640, x1: 884, y0: 24, y1: 326 };
            const pvMin = -85, pvMax = 35;
            const mapPV = v => pp.x0 + (clamp(v, pvMin, pvMax) - pvMin) / (pvMax - pvMin) * (pp.x1 - pp.x0);
            const mapPU = u => pp.y1 - (u - uMin) / (uMax - uMin) * (pp.y1 - pp.y0);
            text(ctx, 'PHASE PLANE (v, u)', pp.x0, 16, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(pp.x0, pp.y0, pp.x1 - pp.x0, pp.y1 - pp.y0);
            ctx.save();
            ctx.beginPath(); ctx.rect(pp.x0, pp.y0, pp.x1 - pp.x0, pp.y1 - pp.y0); ctx.clip();
            trace(ctx, 121, i => mapPV(pvMin + i), i => mapPU(0.04 * (pvMin + i) ** 2 + 5 * (pvMin + i) + 140 + data.I), 'rgba(103,232,249,.7)', 1.5, [5, 4]);
            trace(ctx, 121, i => mapPV(pvMin + i), i => mapPU(b * (pvMin + i)), 'rgba(251,191,36,.7)', 1.5, [5, 4]);
            const from = Math.round(ON / DT);
            if (last > from) {
                ctx.strokeStyle = 'rgba(216,233,133,.65)'; ctx.lineWidth = 1.2;
                ctx.beginPath();
                let started = false;
                for (let k = from; k <= last; k++) {
                    const x = mapPV(data.v[k]), y = mapPU(data.u[k]);
                    if (!started || (k > from && data.v[k - 1] >= 30)) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.fillStyle = '#ef6f61';
            ctx.beginPath(); ctx.arc(mapPV(data.v[last]), mapPU(data.u[last]), 5, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
            text(ctx, 'cyan: where v stops changing', pp.x0, 344, '#67e8f9', '10px system-ui');
            text(ctx, 'amber: where u stops changing', pp.x0, 358, '#fbbf24', '10px system-ui');
            text(ctx, 'v →', pp.x1, pp.y1 + 14, DIM, '10px system-ui', 'right');

            const spikes = data.spikes.filter(t => t <= last * DT);
            const isis = spikes.slice(1).map((t, i) => t - spikes[i]);
            $('izhSpikeReadout').textContent = String(spikes.length);
            $('izhAdaptReadout').textContent = isis.length >= 2 ? (isis[isis.length - 1] / isis[0]).toFixed(1) + '×' : '—';
            $('izhFlopReadout').textContent = thousands(13 * last * DT) + ' FLOPs';
            const name = custom ? 'Custom' : PRESETS[preset.get()].name;
            setStatus(tag, name + ' · b = ' + b.toFixed(2), spikes.length ? 'firing' : '');
        }

        function syncLabels() {
            $('izhCurrentValue').textContent = Number(currentInput.value).toFixed(1).replace('.0', '');
            $('izhAValue').textContent = Number(aInput.value).toFixed(3);
            $('izhDValue').textContent = Number(dInput.value).toFixed(1).replace('.0', '');
            $('izhCValue').textContent = mv(Number(cInput.value));
        }

        function recompute() {
            syncLabels();
            data = simulate();
            if (!playing) cursor = T;
            draw();
        }

        function frame(stamp) {
            if (!playing) return;
            if (!startStamp) startStamp = stamp;
            cursor = Math.min(T, (stamp - startStamp) / 3000 * T);
            draw();
            if (cursor < T) requestAnimationFrame(frame);
            else { stop(); draw(); }
        }

        function stop() {
            playing = false;
            startStamp = 0;
            runBtn.textContent = 'Run 300 ms';
        }

        runBtn.addEventListener('click', () => {
            if (playing) { stop(); draw(); return; }
            recompute();
            playing = true;
            cursor = 0;
            runBtn.textContent = 'Pause';
            requestAnimationFrame(frame);
        });
        $('izhResetBtn').addEventListener('click', () => {
            stop();
            currentInput.value = '10';
            preset.set('rs');
            applyPreset('rs');
            recompute();
        });
        currentInput.addEventListener('input', () => { stop(); recompute(); });
        [aInput, dInput, cInput].forEach(input => input.addEventListener('input', () => { custom = true; stop(); recompute(); }));
        whenHidden(canvas, () => { if (playing) { stop(); draw(); } });
        applyPreset('rs');
        recompute();
    })();

    /* ------------------------------------------------------------------
       Lab 4.1 · Counting a kart neuron's spikes turns it into a ReLU
       ------------------------------------------------------------------ */
    (function rateReluLab() {
        const canvas = $('rateReluCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 360;
        const BETA = 0.86, ALPHA = 0.22, THETA = 0.42, TICK_HZ = 30;
        const I_MAX = 2.2, R_MAX = 34;
        const RHEOBASE = THETA * (1 - BETA) / ALPHA;
        const windowInput = $('reluWindowInput');
        const noiseInput = $('reluNoiseInput');
        const overlay = $('reluOverlayToggle');
        const box = { x0: 74, x1: 872, y0: 26, y1: 296 };
        const mapI = I => box.x0 + I / I_MAX * (box.x1 - box.x0);
        const mapR = r => box.y1 - clamp(r, 0, R_MAX) / R_MAX * (box.y1 - box.y0);
        let seed = 7;
        let measured = [];

        // Exact long-run rate of the noiseless kart neuron: it fires every n ticks.
        function exactRate(I) {
            if (ALPHA * I / (1 - BETA) <= THETA) return 0;
            let v = 0;
            for (let n = 1; n < 600; n++) {
                v = BETA * v + ALPHA * I;
                if (v > THETA) return TICK_HZ / n;
            }
            return 0;
        }

        function measure() {
            const random = seededRandom(seed);
            const windowTicks = Number(windowInput.value);
            const sigma = Number(noiseInput.value);
            measured = [];
            for (let I = 0.05; I <= I_MAX + 1e-9; I += 0.05) {
                let v = random() * THETA, count = 0;
                for (let t = 0; t < windowTicks; t++) {
                    v = BETA * v + ALPHA * (I + sigma * gaussian(random));
                    if (v > THETA) { count++; v = 0; }
                }
                measured.push({ I, rate: count / windowTicks * TICK_HZ });
            }
        }

        function reluSlope() {
            let num = 0, den = 0;
            for (let I = RHEOBASE; I <= 1.85; I += 0.005) { num += (I - RHEOBASE) * exactRate(I); den += (I - RHEOBASE) ** 2; }
            return num / den;
        }

        function draw() {
            paint(ctx, W, H);
            const windowTicks = Number(windowInput.value);
            ctx.strokeStyle = GRID; ctx.lineWidth = 1;
            ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
            for (let r = 10; r <= 30; r += 10) {
                hLine(ctx, box.x0, box.x1, mapR(r), r === 30 ? '#5b4a2a' : '#1d2f27', r === 30 ? [5, 4] : null);
                text(ctx, String(r), box.x0 - 6, mapR(r) + 4, DIM, '10px system-ui', 'right');
            }
            text(ctx, '0', box.x0 - 6, box.y1 + 4, DIM, '10px system-ui', 'right');
            text(ctx, 'spikes / s', box.x0 - 6, box.y0 - 10, DIM, '10px system-ui', 'left');
            text(ctx, 'ceiling: one spike every tick (30 / s)', box.x1 - 6, mapR(30) - 6, '#f7dc86', '10px system-ui', 'right');
            for (let I = 0; I <= I_MAX + 1e-9; I += 0.5) text(ctx, I.toFixed(1), mapI(I), box.y1 + 16, DIM, '10px system-ui', 'center');
            text(ctx, 'input current I (kart units) →', box.x1, box.y1 + 34, DIM, '10px system-ui', 'right');
            ctx.strokeStyle = '#8f80d6'; ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(mapI(RHEOBASE), box.y0); ctx.lineTo(mapI(RHEOBASE), box.y1); ctx.stroke(); ctx.setLineDash([]);
            text(ctx, 'rheobase 0.27', mapI(RHEOBASE) + 5, box.y0 + 14, '#c4b5fd', '700 10px system-ui');
            text(ctx, 'silent', (box.x0 + mapI(RHEOBASE)) / 2, box.y1 - 24, DIM, '700 10px system-ui', 'center');
            text(ctx, '1.57·I < 0.42', (box.x0 + mapI(RHEOBASE)) / 2, box.y1 - 11, DIM, '10px system-ui', 'center');
            // exact staircase
            ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 2.4;
            ctx.beginPath();
            let prev = null;
            for (let i = 0; i <= 1100; i++) {
                const I = i / 1100 * I_MAX;
                const r = exactRate(I);
                const x = mapI(I), y = mapR(r);
                if (prev === null) ctx.moveTo(x, y);
                else if (r !== prev) { ctx.lineTo(x, mapR(prev)); ctx.lineTo(x, y); }
                prev = r;
            }
            ctx.lineTo(mapI(I_MAX), mapR(prev));
            ctx.stroke();
            if (overlay.checked) {
                const k = reluSlope();
                ctx.save();
                ctx.beginPath(); ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); ctx.clip();
                ctx.strokeStyle = '#ef6f61'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(mapI(0), mapR(0)); ctx.lineTo(mapI(RHEOBASE), mapR(0)); ctx.lineTo(mapI(I_MAX), mapR(k * (I_MAX - RHEOBASE))); ctx.stroke();
                ctx.restore();
                text(ctx, 'ReLU  r = max(0, ' + k.toFixed(1) + '·(I − 0.27))', box.x1 - 10, box.y1 - 12, '#ffb4a8', '700 11px system-ui', 'right');
            }
            measured.forEach(p => {
                ctx.fillStyle = 'rgba(251,191,36,.95)';
                ctx.beginPath(); ctx.arc(mapI(p.I), mapR(p.rate), 3.6, 0, Math.PI * 2); ctx.fill();
            });
            text(ctx, 'violet: long-run rate · amber dots: counted over ' + windowTicks + ' ticks (' + (windowTicks / TICK_HZ).toFixed(1) + ' s)', box.x0, 350, TEXT, '10px system-ui');

            const error = measured.reduce((sum, p) => sum + Math.abs(p.rate - exactRate(p.I)), 0) / measured.length;
            $('reluWindowValue').textContent = windowTicks + ' ticks';
            $('reluNoiseValue').textContent = Number(noiseInput.value).toFixed(2);
            $('reluWaitReadout').textContent = (windowTicks / TICK_HZ).toFixed(1) + ' s';
            $('reluRheoReadout').textContent = RHEOBASE.toFixed(2);
            $('reluErrorReadout').textContent = '± ' + error.toFixed(1) + ' /s';
            setStatus($('reluStatusTag'), 'Window ' + (windowTicks / TICK_HZ).toFixed(1) + ' s', windowTicks < 15 ? 'recovering' : '');
        }

        const refresh = () => { measure(); draw(); };
        [windowInput, noiseInput].forEach(input => input.addEventListener('input', refresh));
        overlay.addEventListener('change', draw);
        $('reluResampleBtn').addEventListener('click', () => { seed += 1; refresh(); });
        $('reluResetBtn').addEventListener('click', () => {
            windowInput.value = '30';
            noiseInput.value = '0.08';
            overlay.checked = true;
            seed = 7;
            refresh();
        });
        refresh();
    })();

    /* ------------------------------------------------------------------
       Lab 5.2 · Encode a sensor into spikes, then decode it again
       ------------------------------------------------------------------ */
    (function spikeCodingLab() {
        const canvas = $('spikeCodingCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 400;
        const TICKS = 180, TICK_S = 1 / 30, FRAME = 6;
        const GAINS = [0.7, 0.9, 1.1, 1.3];
        const gainInput = $('codingGainInput');
        const smoothInput = $('codingSmoothInput');
        const playBtn = $('codingPlayBtn');
        const box = { x0: 72, x1: 880 };
        const mapTick = k => box.x0 + (k + 0.5) / TICKS * (box.x1 - box.x0);
        const SCHEME_NAMES = { rate: 'Rate code', latency: 'Latency code', current: 'Direct current' };
        const SCHEME_NOTES = {
            rate: 'Rate: each tick, a neuron spikes with probability ∝ its input. Honest but noisy.',
            latency: 'Latency: once per 6-tick frame (0.2 s), one spike per neuron; earlier = bigger. Frames shown as faint lines.',
            current: 'Direct current: each row is a FlyKart LIF cell, v = 0.86·v + 0.22·I, spike when v > 0.42.'
        };
        let data = null;
        let cursor = TICKS;
        let playing = false;
        let startStamp = 0;

        const signal = segmented('codingSignal', 'signal', () => { stop(); recompute(); });
        const scheme = segmented('codingScheme', 'scheme', () => { stop(); recompute(); });

        function signalAt(t) {
            switch (signal.get()) {
                case 'slalom': return 0.7 * Math.sin(2 * Math.PI * 0.45 * t);
                case 'obstacle': return t >= 2.5 && t < 4.2 ? 0.85 : 0;
                default: return 0.8 * Math.exp(-(((t - 2) / 0.55) ** 2)) - 0.55 * Math.exp(-(((t - 4.3) / 0.45) ** 2));
            }
        }

        function simulate() {
            const random = seededRandom(97);
            const gain = Number(gainInput.value);
            const beta = Number(smoothInput.value);
            const code = scheme.get();
            const s = Array.from({ length: TICKS }, (_, k) => signalAt(k * TICK_S));
            const spikes = Array.from({ length: 8 }, () => new Uint8Array(TICKS));
            const v = new Float64Array(8);
            const held = new Float64Array(8);
            const raw = new Float64Array(TICKS);
            let total = 0;
            const drive = (neuron, value) => (neuron < 4 ? 1 : -1) * value * GAINS[neuron % 4] * gain;
            for (let k = 0; k < TICKS; k++) {
                if (code === 'latency' && k % FRAME === 0) held.fill(0);
                let sum = 0;
                for (let n = 0; n < 8; n++) {
                    let fired = 0;
                    if (code === 'rate') {
                        fired = random() < clamp(drive(n, s[k]), 0, 1) ? 1 : 0;
                        sum += (n < 4 ? 1 : -1) * fired;
                    } else if (code === 'current') {
                        v[n] = v[n] * 0.86 + 0.22 * (1.6 * drive(n, s[k]) + 0.02);
                        if (v[n] > 0.42) { fired = 1; v[n] = 0; }
                        sum += (n < 4 ? 1 : -1) * fired;
                    } else {
                        const frameStart = k - (k % FRAME);
                        const x = clamp(drive(n, s[frameStart]), 0, 1);
                        const offset = Math.round((1 - x) * (FRAME - 1));
                        if (x > 0.08 && k - frameStart === offset) { fired = 1; held[n] = 1 - offset / (FRAME - 1); }
                        sum += (n < 4 ? 1 : -1) * held[n];
                    }
                    spikes[n][k] = fired;
                    total += fired;
                }
                raw[k] = sum;
            }
            const y = new Float64Array(TICKS);
            let state = 0;
            for (let k = 0; k < TICKS; k++) { state = beta * state + (1 - beta) * raw[k]; y[k] = state; }
            // Fit one readout weight so every code is judged at its best scale.
            let num = 0, den = 0;
            for (let k = 0; k < TICKS; k++) { num += y[k] * s[k]; den += y[k] * y[k]; }
            const scale = den > 1e-9 ? num / den : 0;
            const decoded = Array.from(y, value => value * scale);
            let err = 0, peak = 0;
            for (let k = 0; k < TICKS; k++) { err += (decoded[k] - s[k]) ** 2; peak = Math.max(peak, Math.abs(s[k])); }
            const rmse = Math.sqrt(err / TICKS);
            let bestLag = 0, best = -Infinity;
            for (let lag = 0; lag <= 24; lag++) {
                let c = 0;
                for (let k = 0; k + lag < TICKS; k++) c += s[k] * decoded[k + lag];
                c /= (TICKS - lag);
                if (c > best) { best = c; bestLag = lag; }
            }
            return { s, spikes, decoded, total, rmse, peak, lag: bestLag, code, beta };
        }

        function draw() {
            paint(ctx, W, H);
            const last = Math.min(TICKS - 1, Math.round(cursor) - 1);
            // Signal plot
            const y0 = 26, y1 = 162;
            const mapY = value => (y0 + y1) / 2 - clamp(value, -1.1, 1.1) / 1.1 * (y1 - y0) / 2;
            text(ctx, 'SENSOR (gold) AND DECODED STEERING (cyan)', box.x0, 16, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(box.x0, y0, box.x1 - box.x0, y1 - y0);
            hLine(ctx, box.x0, box.x1, mapY(0), '#1d2f27');
            text(ctx, '+1', box.x0 - 6, mapY(1) + 4, DIM, '10px system-ui', 'right');
            text(ctx, '0', box.x0 - 6, mapY(0) + 4, DIM, '10px system-ui', 'right');
            text(ctx, '−1', box.x0 - 6, mapY(-1) + 4, DIM, '10px system-ui', 'right');
            trace(ctx, TICKS, k => mapTick(k), k => mapY(data.s[k]), '#fbbf24', 2.4);
            if (last >= 0) trace(ctx, last + 1, k => mapTick(k), k => mapY(data.decoded[k]), '#67e8f9', 2.4);
            // Raster
            const ry0 = 190, row = 18;
            text(ctx, 'SPIKES · one column per 33 ms tick', box.x0, ry0 - 8, TEXT, '800 11px system-ui');
            if (data.code === 'latency') {
                for (let k = 0; k <= TICKS; k += FRAME) {
                    ctx.strokeStyle = 'rgba(255,255,255,.06)';
                    ctx.beginPath(); ctx.moveTo(box.x0 + k / TICKS * (box.x1 - box.x0), ry0); ctx.lineTo(box.x0 + k / TICKS * (box.x1 - box.x0), ry0 + row * 8); ctx.stroke();
                }
            }
            const cell = (box.x1 - box.x0) / TICKS;
            for (let n = 0; n < 8; n++) {
                const y = ry0 + n * row;
                ctx.fillStyle = n % 2 ? '#132019' : '#16241d';
                ctx.fillRect(box.x0, y, box.x1 - box.x0, row);
                text(ctx, (n < 4 ? 'ON ' : 'OFF ') + (n % 4 + 1), box.x0 - 6, y + 13, n < 4 ? '#efb3aa' : '#c4b5fd', '700 10px system-ui', 'right');
                ctx.fillStyle = n < 4 ? '#ef6f61' : '#c4b5fd';
                for (let k = 0; k <= last; k++) if (data.spikes[n][k]) ctx.fillRect(box.x0 + k * cell + 0.5, y + 3, Math.max(1.5, cell - 1), row - 6);
            }
            if (last < TICKS - 1) {
                const cx = mapTick(last);
                ctx.strokeStyle = 'rgba(255,255,255,.55)';
                ctx.beginPath(); ctx.moveTo(cx, y0); ctx.lineTo(cx, ry0 + row * 8); ctx.stroke();
            }
            for (let t = 0; t <= 6; t++) text(ctx, t + (t === 6 ? ' s' : ''), box.x0 + t / 6 * (box.x1 - box.x0), ry0 + row * 8 + 16, DIM, '10px system-ui', 'center');
            text(ctx, SCHEME_NOTES[data.code], box.x0, 390, '#d8e985', '10px system-ui');

            $('codingGainValue').textContent = Number(gainInput.value).toFixed(2) + '×';
            $('codingSmoothValue').textContent = data.beta.toFixed(2);
            $('codingSpikeReadout').textContent = (data.total / 6).toFixed(0);
            $('codingErrorReadout').textContent = Math.round(data.rmse / Math.max(0.01, data.peak) * 100) + '%';
            $('codingLagReadout').textContent = Math.round(data.lag * 1000 / 30) + ' ms';
            setStatus($('codingStatusTag'), SCHEME_NAMES[data.code] + ' · β ' + data.beta.toFixed(2), playing ? 'firing' : '');
        }

        function recompute() {
            data = simulate();
            if (!playing) cursor = TICKS;
            draw();
        }

        function frame(stamp) {
            if (!playing) return;
            if (!startStamp) startStamp = stamp;
            cursor = Math.min(TICKS, (stamp - startStamp) / 3000 * TICKS);
            draw();
            if (cursor < TICKS) requestAnimationFrame(frame);
            else { stop(); draw(); }
        }

        function stop() {
            playing = false;
            startStamp = 0;
            playBtn.textContent = 'Play 6 s';
        }

        playBtn.addEventListener('click', () => {
            if (playing) { stop(); draw(); return; }
            playing = true;
            cursor = 0;
            playBtn.textContent = 'Pause';
            requestAnimationFrame(frame);
        });
        $('codingResetBtn').addEventListener('click', () => {
            stop();
            gainInput.value = '1';
            smoothInput.value = '0.72';
            signal.set('bend');
            scheme.set('current');
            recompute();
        });
        [gainInput, smoothInput].forEach(input => input.addEventListener('input', () => { stop(); recompute(); }));
        whenHidden(canvas, () => { if (playing) { stop(); draw(); } });
        recompute();
    })();

    /* ------------------------------------------------------------------
       Lab 8.1 · The assembled FlyKart brain in a tiny closed-loop world
       The update equations match SpikingNetwork.step() in src/core.ts.
       ------------------------------------------------------------------ */
    (function kartBrainLab() {
        const canvas = $('kartBrainCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 470;
        const N_IN = 17, N_H = 48, N_OUT = 4, HISTORY = 120, DT = 1 / 30, LOOP_S = 10;
        const SENSOR_LABELS = ['heading err', 'curvature', 'lateral', 'speed', 'centre', 'kart close', 'kart side', 'edge clear', 'aligned', 'kart ahead', 'kart Δspeed', 'curve near', 'curve far', 'checkpoint', 'last steer', 'last gas', 'obstacle'];
        const GROUPS = [
            { name: 'steer-right', short: 'RIGHT', color: '#ef6f61', tint: 'rgba(239,111,97,.06)' },
            { name: 'steer-left', short: 'LEFT', color: '#67e8f9', tint: 'rgba(103,232,249,.05)' },
            { name: 'go', short: 'GO', color: '#d8e985', tint: 'rgba(216,233,133,.05)' },
            { name: 'caution', short: 'CAUTION', color: '#fbbf24', tint: 'rgba(251,191,36,.06)' }
        ];
        const groupOf = j => (j < 12 ? 0 : j < 24 ? 1 : j < 36 ? 2 : 3);
        const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
        const SCENARIOS = {
            straight: { kappa: () => 0, lat0: 0.35 },
            right: { kappa: s => (s > 260 && s < 560 ? (Math.PI / 2) / 300 : 0), lat0: 0 },
            left: { kappa: s => (s > 260 && s < 560 ? -(Math.PI / 2) / 300 : 0), lat0: 0 },
            chicane: { kappa: s => (s > 200 && s < 350 ? 1.05 / 150 : s > 380 && s < 530 ? -1.05 / 150 : 0), lat0: 0 },
            traffic: { kappa: () => 0, lat0: 0, opponent: true }
        };

        function wiredWeights() {
            const win = new Float64Array(N_H * N_IN), rec = new Float64Array(N_H * N_H), wout = new Float64Array(N_OUT * N_H), bias = new Float64Array(N_H);
            for (let j = 0; j < N_H; j++) {
                const group = groupOf(j);
                const rank = group === 3 ? ((j - 36) % 6) / 5 : (j % 12) / 11;
                const gain = 0.7 + 0.6 * rank;
                const set = (i, w) => { win[j * N_IN + i] = w * gain; };
                bias[j] = (group === 3 ? (((j - 36) % 6) * 5 % 6) / 5 - 0.5 : ((j % 12) * 7 % 12) / 11 - 0.5) * 0.08;
                if (group < 2) {
                    const sign = group === 0 ? 1 : -1;
                    set(0, sign * 2.4); set(1, sign * 1.0); set(11, sign * 0.8); set(2, -sign * 1.6);
                    set(13, sign * 0.4); set(6, -sign * 0.9); set(14, -sign * 0.3);
                } else if (group === 2) {
                    bias[j] += 0.25; set(8, 0.3); set(3, -0.35); set(5, -0.9); set(7, 0.1);
                } else {
                    const sign = (j - 36) < 6 ? 1 : -1;
                    bias[j] += -0.42; set(12, sign * 1.5); set(1, sign * 0.6); set(3, 0.45); set(5, 2.0); set(16, 0.3);
                }
            }
            for (let j = 0; j < N_H; j++) for (let k = 0; k < N_H; k++) {
                if (j === k) continue;
                const a = groupOf(j), b = groupOf(k);
                let w = 0;
                if (a === b) w = 0.06;
                else if ((a === 0 && b === 1) || (a === 1 && b === 0)) w = -0.25;
                else if (a === 2 && b === 3) w = -0.3;
                else if (a === 3 && b === 2) w = -0.15;
                rec[j * N_H + k] = w;
            }
            for (let j = 0; j < N_H; j++) {
                const group = groupOf(j);
                wout[j] = group === 0 ? 0.22 : group === 1 ? -0.22 : 0;
                wout[N_H + j] = group === 2 ? 0.25 : group === 3 ? -0.08 : 0;
                wout[2 * N_H + j] = group === 3 ? 0.2 : group === 2 ? -0.08 : 0;
            }
            return { win, rec, wout, bias };
        }

        // Lab 9.1 can load this exact brain into the trained-brain inspector.
        window.FlyKartHandWired = () => {
            const w = wiredWeights();
            return { version: 2, inputCount: N_IN, hiddenCount: N_H, outputCount: N_OUT, mutationSigma: 1, inputWeights: Array.from(w.win), recurrentWeights: Array.from(w.rec), outputWeights: Array.from(w.wout), bias: Array.from(w.bias) };
        };

        // Same initial distribution as a new SpikingNetwork in the simulator.
        function randomWeights() {
            const random = seededRandom(11);
            const u = scale => (random() * 2 - 1) * scale;
            return {
                win: Float64Array.from({ length: N_H * N_IN }, () => u(0.8)),
                rec: Float64Array.from({ length: N_H * N_H }, () => u(0.16)),
                wout: Float64Array.from({ length: N_OUT * N_H }, () => u(0.5)),
                bias: Float64Array.from({ length: N_H }, () => u(0.06))
            };
        }

        const neuronInput = $('kartNeuronInput');
        const speedInput = $('kartSpeedInput');
        const playBtn = $('kartPlayBtn');
        let net, world, history, probe, playing = false, lastStamp = 0, carry = 0;
        const scenario = segmented('kartScenario', 'scenario', () => reset());
        const weightSet = segmented('kartWeights', 'weights', () => reset());

        function buildHeadingTable(kappa) {
            const table = new Float64Array(2401);
            for (let s = 1; s < table.length; s++) table[s] = table[s - 1] + kappa(s - 0.5);
            return table;
        }
        const roadHeading = s => {
            const x = clamp(s, 0, world.table.length - 2);
            const i = Math.floor(x);
            return world.table[i] + (world.table[i + 1] - world.table[i]) * (x - i);
        };

        function reset() {
            const sc = SCENARIOS[scenario.get()];
            net = { w: weightSet.get() === 'wired' ? wiredWeights() : randomWeights(), v: new Float64Array(N_H), s: new Float64Array(N_H), next: new Float64Array(N_H), y: new Float64Array(N_OUT) };
            world = { sc, table: buildHeadingTable(sc.kappa), s: 0, head: 0, lat: sc.lat0, v: 45, t: 0, opp: sc.opponent ? 170 : null, lastSteer: 0, lastDrive: 0, action: { steer: 0, throttle: 0, brake: 0, drive: 0 } };
            history = [];
            probe = [];
            world.sensors = sensors();
            draw();
        }

        function sensors() {
            const rel = d => clamp(wrap(roadHeading(world.s + d) - world.head) / Math.PI, -1, 1);
            const look = clamp(56 + world.v * 0.42, 56, 112);
            const headingError = clamp(wrap((roadHeading(world.s) + roadHeading(world.s + look)) / 2 - world.head) / Math.PI - 0.32 * world.lat, -1, 1);
            let close = 0, side = 0, ahead = 0, dSpeed = 0;
            if (world.opp !== null) {
                const d = world.opp - world.s;
                if (Math.abs(d) < 180) {
                    close = clamp(1 - Math.abs(d) / 180, 0, 1);
                    side = clamp(0.45 - world.lat, -1, 1);
                    ahead = d > 0 ? 1 : -1;
                    dSpeed = clamp((32 - world.v) / 90, -1, 1);
                }
            }
            const align = Math.cos(wrap(roadHeading(world.s) - world.head));
            return [headingError, rel(look), clamp(world.lat, -1, 1), clamp(world.v / 90, -1, 1), clamp(1 - Math.abs(world.lat), -1, 1),
                close, side, clamp(1 - Math.abs(world.lat) * 1.1, -1, 1), align, ahead, dSpeed,
                rel(30), rel(150), clamp(headingError * 0.9, -1, 1), world.lastSteer, world.lastDrive, 0];
        }

        // One tick of SpikingNetwork.step(): current → leaky voltage → spike/reset → leaky readout.
        function brainStep(x) {
            const { win, rec, wout, bias } = net.w;
            const probeIndex = Number(neuronInput.value) - 1;
            let probeRaw = 0;
            for (let j = 0; j < N_H; j++) {
                let current = bias[j];
                for (let i = 0; i < N_IN; i++) current += win[j * N_IN + i] * x[i];
                for (let k = 0; k < N_H; k++) current += rec[j * N_H + k] * net.s[k];
                const voltage = net.v[j] * 0.86 + current * 0.22;
                if (j === probeIndex) probeRaw = voltage;
                net.next[j] = voltage > 0.42 ? 1 : 0;
                net.v[j] = net.next[j] === 1 ? 0 : voltage;
            }
            const swap = net.s; net.s = net.next; net.next = swap;
            for (let o = 0; o < N_OUT; o++) {
                let sum = 0;
                for (let j = 0; j < N_H; j++) sum += wout[o * N_H + j] * net.s[j];
                net.y[o] = net.y[o] * 0.72 + Math.tanh(sum) * 0.28;
            }
            const drive = net.y[1] - net.y[2];
            const reverse = clamp((net.y[3] - 0.25) / 0.75, 0, 1);
            probe.push(probeRaw);
            if (probe.length > HISTORY) probe.shift();
            return { steer: clamp(net.y[0], -1, 1), throttle: reverse > 0 ? 0 : clamp(drive, 0, 1), brake: clamp(-drive, 0, 1), reverse, drive };
        }

        function worldStep(action) {
            world.head += action.steer * 1.9 * Math.min(1, world.v / 35) * DT;
            const rel = wrap(world.head - roadHeading(world.s));
            world.lat += Math.sin(rel) * world.v * DT / 56;
            world.s += Math.cos(rel) * world.v * DT;
            world.v = Math.max(0, world.v + (70 * action.throttle - 140 * action.brake - 0.45 * world.v) * DT);
            if (world.opp !== null) world.opp += 32 * DT;
            world.lastSteer = action.steer;
            world.lastDrive = action.drive;
            world.t += DT;
        }

        function tick() {
            const x = sensors();
            world.sensors = x;
            world.action = brainStep(x);
            history.push(Uint8Array.from(net.s));
            if (history.length > HISTORY) history.shift();
            worldStep(world.action);
            if (world.t >= LOOP_S || Math.abs(world.lat) > 2.5) {
                // Loop the scenario but keep the raster and probe history continuous.
                const keep = { history, probe };
                reset();
                history = keep.history;
                probe = keep.probe;
            }
        }

        function drawRoad(x0, y0, w, h) {
            ctx.fillStyle = '#0b1310'; ctx.fillRect(x0, y0, w, h);
            ctx.save();
            ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
            const scale = 0.42;
            const carX = x0 + w / 2, carY = y0 + h - 16;
            const pts = [];
            let px = -world.lat * 56, py = 0;
            for (let d = 0; d <= 260; d += 6) {
                const phi = roadHeading(world.s + d) - world.head;
                pts.push([px, py, phi]);
                px += Math.sin(phi) * 6;
                py += Math.cos(phi) * 6;
            }
            const toScreen = (lx, ly) => [carX + lx * scale, carY - ly * scale];
            [[56, '#2a3b33', 112 * scale], [0, 'rgba(255,255,255,.25)', 1]].forEach(([, color, width]) => {
                ctx.strokeStyle = color; ctx.lineWidth = width;
                ctx.setLineDash(width === 1 ? [4, 5] : []);
                ctx.beginPath();
                pts.forEach(([lx, ly], i) => { const [sx, sy] = toScreen(lx, ly); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
                ctx.stroke();
                ctx.setLineDash([]);
            });
            if (world.opp !== null) {
                const d = world.opp - world.s;
                if (d > -20 && d < 260) {
                    const idx = clamp(Math.round(d / 6), 0, pts.length - 1);
                    const [lx, ly, phi] = pts[idx];
                    const [sx, sy] = toScreen(lx + Math.cos(phi) * 0.45 * 56, ly - Math.sin(phi) * 0.45 * 56);
                    ctx.fillStyle = '#ef6f61';
                    ctx.fillRect(sx - 4, sy - 6, 8, 12);
                }
            }
            ctx.fillStyle = '#fbbf24';
            ctx.beginPath(); ctx.moveTo(carX, carY - 9); ctx.lineTo(carX - 5, carY + 5); ctx.lineTo(carX + 5, carY + 5); ctx.closePath(); ctx.fill();
            ctx.restore();
            text(ctx, 'ROAD AHEAD', x0 + 6, y0 + 13, DIM, '800 9px system-ui');
        }

        function draw() {
            paint(ctx, W, H);
            const x = world.sensors;
            const random = weightSet.get() === 'random';
            // Sensors
            text(ctx, '17 SENSORS', 14, 20, TEXT, '800 11px system-ui');
            for (let i = 0; i < N_IN; i++) {
                const y = 32 + i * 17.3;
                text(ctx, SENSOR_LABELS[i], 106, y + 10, '#9fb0a5', '10px system-ui', 'right');
                ctx.fillStyle = '#1b2a23'; ctx.fillRect(114, y + 2, 112, 11);
                const value = clamp(x[i], -1, 1);
                ctx.fillStyle = value >= 0 ? '#fbbf24' : '#67e8f9';
                ctx.fillRect(value >= 0 ? 170 : 170 + value * 56, y + 2, Math.abs(value) * 56, 11);
                ctx.fillStyle = '#456054'; ctx.fillRect(169.5, y + 1, 1, 13);
            }
            drawRoad(14, 336, 212, 124);
            // Raster
            const rx0 = 256, rx1 = 640, ry0 = 32, rowH = 6;
            text(ctx, '48 LIF NEURONS · last 4 s', rx0, 20, TEXT, '800 11px system-ui');
            for (let g = 0; g < 4; g++) {
                ctx.fillStyle = GROUPS[g].tint;
                ctx.fillRect(rx0, ry0 + g * 12 * rowH, rx1 - rx0, 12 * rowH);
                text(ctx, random ? '—' : GROUPS[g].short, rx1 + 6, ry0 + g * 12 * rowH + 38, random ? DIM : GROUPS[g].color, '800 9px system-ui');
            }
            const col = (rx1 - rx0) / HISTORY;
            const offset = HISTORY - history.length;
            history.forEach((spikes, t) => {
                for (let j = 0; j < N_H; j++) {
                    if (!spikes[j]) continue;
                    ctx.fillStyle = GROUPS[groupOf(j)].color;
                    ctx.fillRect(rx0 + (offset + t) * col, ry0 + j * rowH + 0.5, Math.max(1.5, col - 0.6), rowH - 1);
                }
            });
            const probeIndex = Number(neuronInput.value) - 1;
            ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1;
            ctx.strokeRect(rx0 - 0.5, ry0 + probeIndex * rowH - 0.5, rx1 - rx0 + 1, rowH + 1);
            text(ctx, 'now →', rx1 - 2, ry0 + 48 * rowH + 13, DIM, '10px system-ui', 'right');
            // Readouts
            const ox = 690;
            const a = world.action;
            text(ctx, 'READOUTS', ox, 20, TEXT, '800 11px system-ui');
            const cx = 788, cy = 110, r = 58;
            ctx.strokeStyle = '#2e4a3d'; ctx.lineWidth = 10;
            ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
            const angle = -Math.PI / 2 + a.steer * (Math.PI * 0.42);
            ctx.strokeStyle = '#eef6f0'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(angle) * (r + 4), cy + Math.sin(angle) * (r + 4)); ctx.stroke();
            ctx.fillStyle = '#eef6f0'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
            text(ctx, 'L', cx - r - 12, cy - 6, '#67e8f9', '800 11px system-ui', 'center');
            text(ctx, 'R', cx + r + 12, cy - 6, '#ef6f61', '800 11px system-ui', 'center');
            text(ctx, 'steer ' + signed(a.steer), cx, cy + 24, '#eef6f0', '800 12px ui-monospace, monospace', 'center');
            const bar = (y, label, value, color) => {
                text(ctx, label, ox, y + 9, '#9fb0a5', '10px system-ui');
                ctx.fillStyle = '#1b2a23'; ctx.fillRect(ox + 56, y, 138, 11);
                ctx.fillStyle = color; ctx.fillRect(ox + 56, y, 138 * clamp(value, 0, 1), 11);
            };
            bar(158, 'gas', a.throttle, '#d8e985');
            bar(176, 'brake', a.brake, '#ef6f61');
            bar(194, 'reverse', a.reverse, '#c4b5fd');
            text(ctx, 'speed ' + world.v.toFixed(0) + ' px/s', ox, 232, '#eef6f0', '700 11px system-ui');
            text(ctx, 'heading error ' + signed(x[0]), ox, 250, Math.abs(x[0]) > 0.2 ? '#ffb4a8' : '#eef6f0', '700 11px system-ui');
            text(ctx, 'off-centre ' + signed(world.lat), ox, 268, Math.abs(world.lat) > 1 ? '#ffb4a8' : '#eef6f0', '700 11px system-ui');
            text(ctx, 'time ' + world.t.toFixed(1) + ' s of ' + LOOP_S, ox, 286, DIM, '10px system-ui');
            text(ctx, '3,312 multiply-adds', ox, 312, '#f7dc86', '700 11px system-ui');
            text(ctx, 'per tick, per kart', ox, 326, DIM, '10px system-ui');
            // Probe voltage
            const px0 = 256, px1 = 886, py0 = 360, py1 = 456;
            const group = GROUPS[groupOf(probeIndex)];
            text(ctx, 'NEURON #' + (probeIndex + 1) + (random ? ' · random weights' : ' · ' + group.name + ' group') + ' · voltage v before reset', px0, 350, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(px0, py0, px1 - px0, py1 - py0);
            let lo = -0.4, hi = 0.8;
            probe.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
            const mapPV = v => py1 - (v - lo) / (hi - lo) * (py1 - py0);
            hLine(ctx, px0, px1, mapPV(0.42), '#ef6f61', [5, 4]);
            text(ctx, 'threshold 0.42', px1 - 4, mapPV(0.42) - 4, '#efb3aa', '10px system-ui', 'right');
            hLine(ctx, px0, px1, mapPV(0), '#456054', [3, 4]);
            text(ctx, 'reset 0', px1 - 4, mapPV(0) + 12, DIM, '10px system-ui', 'right');
            const pcol = (px1 - px0) / HISTORY;
            const pOffset = HISTORY - probe.length;
            if (probe.length > 1) trace(ctx, probe.length, i => px0 + (pOffset + i + 0.5) * pcol, i => mapPV(probe[i]), random ? '#b8c8be' : group.color, 1.8);
            probe.forEach((v, i) => {
                if (v <= 0.42) return;
                ctx.fillStyle = '#ffffff';
                ctx.beginPath(); ctx.arc(px0 + (pOffset + i + 0.5) * pcol, mapPV(v), 2.6, 0, Math.PI * 2); ctx.fill();
            });

            const spiking = net.s.reduce((sum, s) => sum + s, 0);
            $('kartSteerReadout').textContent = signed(a.steer);
            $('kartDriveReadout').textContent = signed(a.drive);
            $('kartSpikeReadout').textContent = spiking + ' / 48';
            $('kartErrorReadout').textContent = signed(x[0]);
            $('kartNeuronValue').textContent = '#' + (probeIndex + 1) + ' · ' + (random ? 'random' : group.name.replace('steer-', ''));
            $('kartSpeedValue').textContent = Number(speedInput.value) + '×';
            const tag = $('kartBrainStatus');
            if (Math.abs(world.lat) > 1) setStatus(tag, 'Off the road', 'firing');
            else setStatus(tag, playing ? 'Driving · ' + world.t.toFixed(1) + ' s' : 'Paused', playing ? 'recovering' : '');
        }

        function frame(stamp) {
            if (!playing) return;
            if (!lastStamp) lastStamp = stamp;
            carry += Math.min(0.25, (stamp - lastStamp) / 1000) * Number(speedInput.value);
            lastStamp = stamp;
            let steps = 0;
            while (carry >= DT && steps < 12) { tick(); carry -= DT; steps++; }
            draw();
            requestAnimationFrame(frame);
        }

        function pause() {
            playing = false;
            lastStamp = 0;
            carry = 0;
            playBtn.textContent = 'Play';
            draw();
        }

        playBtn.addEventListener('click', () => {
            if (playing) { pause(); return; }
            playing = true;
            playBtn.textContent = 'Pause';
            requestAnimationFrame(frame);
        });
        $('kartResetBtn').addEventListener('click', () => { pause(); reset(); });
        neuronInput.addEventListener('input', () => { probe = []; draw(); });
        speedInput.addEventListener('input', draw);
        whenHidden(canvas, () => { if (playing) pause(); });
        reset();
        // Pre-roll a little so the raster is not empty before the first play.
        for (let i = 0; i < 45; i++) tick();
        draw();
    })();

    /* ------------------------------------------------------------------
       Shared: run a lab's clock only while it is on screen and not paused
       ------------------------------------------------------------------ */
    function labClock(el, hz, onTick, onDraw) {
        const state = { running: true, visible: false, acc: 0, last: 0, loop: false };
        function frame(stamp) {
            if (!state.visible) { state.loop = false; state.last = 0; return; }
            if (!state.last) state.last = stamp;
            state.acc += Math.min(0.25, (stamp - state.last) / 1000); state.last = stamp;
            if (state.running) { let guard = 0; while (state.acc >= 1 / hz && guard < 8) { onTick(); state.acc -= 1 / hz; guard++; } } else state.acc = 0;
            onDraw();
            requestAnimationFrame(frame);
        }
        const start = () => { if (state.loop) return; state.loop = true; state.last = 0; requestAnimationFrame(frame); };
        if ('IntersectionObserver' in window) new IntersectionObserver(entries => { state.visible = entries.some(entry => entry.isIntersecting); if (state.visible) start(); }, { threshold: 0.05 }).observe(el);
        else { state.visible = true; start(); }
        return state;
    }

    /* ------------------------------------------------------------------
       The progress bar names the current part, and the route map is built
       from the chapters, parts and labs actually on the page.
       ------------------------------------------------------------------ */
    (function partsAndRouteMap() {
        const guide = $('model-ladder');
        if (!guide) return;
        const chapters = Array.from(guide.querySelectorAll(':scope > article.book-chapter'));
        const partEl = guide.querySelector('[data-tb-part]');
        const partOf = head => {
            const letter = ((head.querySelector('span') || {}).textContent || '').match(/Part\s+(\w+)/);
            return (letter ? 'Part ' + letter[1] + ' · ' : '') + (head.querySelector('h4') || {}).textContent;
        };
        let queued = false;
        function update() {
            queued = false;
            if (!partEl) return;
            const marker = window.innerHeight * 0.35;
            let label = '';
            chapters.forEach(chapter => {
                const box = chapter.getBoundingClientRect();
                if (box.top > marker || box.bottom < marker) return;
                chapter.querySelectorAll('.chapter-subhead').forEach(head => { if (head.getBoundingClientRect().top <= marker) label = partOf(head); });
            });
            partEl.textContent = label;
        }
        const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        update();

        const list = $('routeMap');
        if (!list) return;
        let parts = 0, labs = 0;
        chapters.forEach((chapter, index) => {
            const title = (chapter.dataset.title || '').replace(/^./, c => c.toUpperCase());
            const question = ((chapter.querySelector('.chapter-question') || {}).textContent || '').replace(/^Question:\s*/, '');
            const heads = Array.from(chapter.querySelectorAll('.chapter-subhead'));
            const labList = Array.from(chapter.querySelectorAll('.ap-lab'));
            parts += heads.length; labs += labList.length;
            const item = document.createElement('li');
            item.innerHTML = '<span class="rm-dot">' + (index + 1) + '</span><div class="rm-card"><h5><a href="#' + chapter.id + '">' + title + '</a></h5><p>' + question + '</p>' +
                (heads.length ? '<div class="rm-parts">' + heads.map(head => '<a href="#' + head.id + '">' + partOf(head) + '</a>').join('') + '</div>' : '') +
                (labList.length ? '<div class="rm-labs">' + labList.map(lab => { const tag = ((lab.querySelector('.chapter-number') || {}).textContent || '').split('·'); return '<a href="#' + lab.id + '">' + (tag[0] || 'Lab').trim() + ' · ' + ((lab.querySelector('h4') || {}).textContent || '').split(/\s+/).slice(0, 5).join(' ') + '…</a>'; }).join('') + '</div>' : '') + '</div>';
            list.appendChild(item);
        });
        const summary = $('routeSummary');
        if (summary) summary.textContent = 'See the whole route: ' + chapters.length + ' chapters, ' + parts + ' parts, ' + labs + ' labs';
    })();

    /* ------------------------------------------------------------------
       Lab 3.1 · Synaptic pushes add up, fade, and fire
       ------------------------------------------------------------------ */
    (function summationLab() {
        const canvas = $('summationCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 400, REST = -70, T = 200, DT = 0.1;
        const tauIn = $('sumTauInput'), weightIn = $('sumWeightInput'), inhibIn = $('sumInhibInput'), thresholdIn = $('sumThresholdInput');
        const lanes = [['A', 'A · excitatory', '#fbbf24'], ['B', 'B · excitatory', '#fb923c'], ['I', 'C · inhibitory', '#a78bfa']];
        const x0 = 96, x1 = 884, laneTop = 26, laneH = 30, py0 = 150, py1 = 350, vMin = -76, vMax = -40;
        const mapT = t => x0 + t / T * (x1 - x0);
        const mapV = v => py1 - (clamp(v, vMin, vMax) - vMin) / (vMax - vMin) * (py1 - py0);
        let events = { A: [], B: [], I: [] };
        const presets = {
            far: { A: [30, 120], B: [], I: [], weight: 10 },
            close: { A: [60, 68], B: [], I: [], weight: 10 },
            both: { A: [80], B: [80], I: [], weight: 10 },
            veto: { A: [60], B: [64], I: [62], weight: 10 },
            drip: { A: [20, 26, 32, 38, 44, 50, 56, 62, 68, 74, 80, 86, 92, 98, 104, 110, 116, 122, 128, 134, 140, 146, 152, 158, 164, 170, 176], B: [], I: [], weight: 5 },
        };
        const preset = segmented('sumPreset', 'preset', key => loadPreset(key));

        function loadPreset(key) {
            const p = presets[key];
            events = { A: [...p.A], B: [...p.B], I: [...p.I] };
            weightIn.value = String(p.weight);
            draw();
        }

        function simulate() {
            const tau = Number(tauIn.value), wE = Number(weightIn.value), wI = -Number(inhibIn.value), th = Number(thresholdIn.value);
            const list = [];
            events.A.forEach(t => list.push({ t, w: wE, lane: 0 })); events.B.forEach(t => list.push({ t, w: wE, lane: 1 })); events.I.forEach(t => list.push({ t, w: wI, lane: 2 }));
            list.sort((a, b) => a.t - b.t);
            const n = Math.round(T / DT), V = new Float32Array(n + 1), ghost = new Float32Array(n + 1), spikes = [];
            let v = REST, g = REST, k = 0, peak = REST;
            for (let s = 0; s <= n; s++) {
                const t = s * DT;
                while (k < list.length && list[k].t <= t + 1e-9) { v += list[k].w; g += list[k].w; k++; }
                peak = Math.max(peak, v);
                V[s] = v; ghost[s] = g;
                if (v >= th) { spikes.push(t); v = REST; }
                v += DT * (-(v - REST) / tau); g += DT * (-(g - REST) / tau);
            }
            return { list, V, ghost, spikes, tau, wE, wI, th, peak };
        }

        function draw() {
            const r = simulate();
            ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
            lanes.forEach(([key, label, color], i) => {
                const y = laneTop + i * (laneH + 4);
                ctx.fillStyle = '#16241d'; ctx.fillRect(x0, y, x1 - x0, laneH);
                text(ctx, label, x0 - 8, y + 19, color, '700 10px system-ui', 'right');
                events[key].forEach(t => {
                    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(mapT(t), y + 3); ctx.lineTo(mapT(t), y + laneH - 3); ctx.stroke();
                    ctx.strokeStyle = color + '33'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mapT(t), y + laneH); ctx.lineTo(mapT(t), py1); ctx.stroke();
                });
            });
            text(ctx, 'click a lane to add or remove a push', x1, laneTop + 3 * (laneH + 4) + 12, DIM, '10px system-ui', 'right');
            // axes
            ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.strokeRect(x0, py0, x1 - x0, py1 - py0);
            hLine(ctx, x0, x1, mapV(REST), '#456054', [4, 4]); text(ctx, 'rest ' + mv(REST), x0 - 8, mapV(REST) + 4, DIM, '10px system-ui', 'right');
            hLine(ctx, x0, x1, mapV(r.th), '#ef6f61', [5, 4]); text(ctx, 'threshold ' + mv(r.th), x0 - 8, mapV(r.th) + 4, '#efb3aa', '10px system-ui', 'right');
            ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(x0, mapV(REST)); ctx.lineTo(x0, mapV(r.th)); ctx.stroke();
            const gapX = x0 + 6; ctx.strokeStyle = '#8f80d6'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(gapX, mapV(REST)); ctx.lineTo(gapX, mapV(r.th)); ctx.stroke();
            text(ctx, (r.th - REST) + ' mV to go', gapX + 6, (mapV(REST) + mapV(r.th)) / 2 + 4, '#c4b5fd', '700 10px system-ui');
            for (let t = 0; t <= T; t += 20) text(ctx, t + (t === T ? ' ms' : ''), mapT(t), py1 + 16, DIM, '10px system-ui', 'center');
            // individual pushes (thin), sum without reset (dashed), real voltage (bold)
            if (r.list.length <= 30) r.list.forEach(e => {
                const color = lanes[e.lane][2];
                ctx.strokeStyle = color + '99'; ctx.lineWidth = 1; ctx.beginPath();
                for (let t = e.t; t <= T; t += 1) { const x = mapT(t), y = mapV(REST + e.w * Math.exp(-(t - e.t) / r.tau)); if (t === e.t) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
                ctx.stroke();
            });
            ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]); ctx.beginPath();
            for (let s = 0; s < r.ghost.length; s += 5) { const x = mapT(s * DT), y = mapV(r.ghost[s]); if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
            ctx.stroke(); ctx.setLineDash([]);
            ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 2.6; ctx.beginPath();
            for (let s = 0; s < r.V.length; s += 2) { const x = mapT(s * DT), y = mapV(r.V[s]); if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
            ctx.stroke();
            r.spikes.forEach(t => { ctx.strokeStyle = '#ef6f61'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(mapT(t), mapV(r.th)); ctx.lineTo(mapT(t), py0 - 2); ctx.stroke(); ctx.fillStyle = '#ef6f61'; ctx.beginPath(); ctx.arc(mapT(t), py0 - 2, 3.5, 0, Math.PI * 2); ctx.fill(); });
            text(ctx, 'bold: real voltage · dashed: sum if it never fired · thin: each push alone', x0, py1 + 34, DIM, '10px system-ui');
            $('sumTauValue').textContent = r.tau + ' ms';
            $('sumWeightValue').textContent = '+' + r.wE.toFixed(1).replace('.0', '') + ' mV';
            $('sumInhibValue').textContent = '−' + (-r.wI).toFixed(1).replace('.0', '') + ' mV';
            $('sumThresholdValue').textContent = mv(r.th);
            $('sumPeakReadout').textContent = mv(Math.min(r.peak, 30));
            $('sumSpikeReadout').textContent = String(r.spikes.length);
            $('sumCountReadout').textContent = String(r.list.length);
            setStatus($('summationStatusTag'), r.spikes.length ? 'Fires ' + r.spikes.length + (r.spikes.length === 1 ? ' time' : ' times') : (r.list.length ? 'Below threshold' : 'No inputs yet'), r.spikes.length ? 'firing' : '');
        }

        canvas.addEventListener('click', event => {
            const rect = canvas.getBoundingClientRect();
            const px = (event.clientX - rect.left) / rect.width * W, py = (event.clientY - rect.top) / rect.height * H;
            const lane = Math.floor((py - laneTop) / (laneH + 4));
            if (lane < 0 || lane > 2 || px < x0 || px > x1) return;
            const key = lanes[lane][0], t = Math.round((px - x0) / (x1 - x0) * T);
            const near = events[key].findIndex(e => Math.abs(e - t) <= 2);
            if (near >= 0) events[key].splice(near, 1); else events[key].push(t);
            draw();
        });
        [tauIn, weightIn, inhibIn, thresholdIn].forEach(input => input.addEventListener('input', draw));
        $('sumClearBtn').addEventListener('click', () => { events = { A: [], B: [], I: [] }; draw(); });
        $('sumRandomBtn').addEventListener('click', () => {
            const random = seededRandom(Math.floor(Math.random() * 1e9));
            events = { A: [], B: [], I: [] };
            for (let i = 0; i < 9; i++) events[['A', 'B', 'I'][Math.floor(random() * 3.4) % 3]].push(Math.round(10 + random() * 180));
            draw();
        });
        loadPreset('close');
    })();

    /* ------------------------------------------------------------------
       Lab 4.2 · The weighted vote (one ANN neuron)
       ------------------------------------------------------------------ */
    (function voteLab() {
        const canvas = $('voteCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 380;
        const ITEMS = ['Heading error', 'Lateral offset', 'Curvature at +150 px', 'Speed'];
        const PRESETS = {
            steer: { x: [0.35, -0.2, 0.1, 0.6], w: [2.4, -1.6, 1.0, 0], b: 0, act: 'tanh', name: 'Steering rule', out: 'steering command' },
            gas: { x: [0.1, 0, 0, 0.6], w: [0, 0, 0, -3], b: 2.1, act: 'sigmoid', name: 'Speed governor', out: 'gas command' },
            flat: { x: [0, 0, 0, 0], w: [0, 0, 0, 0], b: 0, act: 'tanh', name: 'All zero', out: 'output' },
        };
        let current = 'steer';
        const rows = $('voteRows');
        rows.innerHTML = ITEMS.map((label, i) => '<div class="vote-row"><strong>' + label + '</strong><label>x<input id="voteX' + i + '" type="range" min="-1" max="1" step="0.01" value="0"><output id="voteXo' + i + '">0</output></label><label>w<input id="voteW' + i + '" type="range" min="-3" max="3" step="0.05" value="0"><output id="voteWo' + i + '">0</output></label></div>').join('');
        const biasIn = $('voteBias');
        const preset = segmented('votePreset', 'preset', key => { current = key; load(key); });
        const act = segmented('voteAct', 'act', () => draw());
        const activation = (z, kind) => kind === 'relu' ? Math.max(0, z) : kind === 'sigmoid' ? 1 / (1 + Math.exp(-z)) : Math.tanh(z);

        function load(key) {
            const p = PRESETS[key];
            ITEMS.forEach((_, i) => { $('voteX' + i).value = String(p.x[i]); $('voteW' + i).value = String(p.w[i]); });
            biasIn.value = String(p.b); act.set(p.act);
            draw();
        }
        function draw() {
            const kind = act.get(), xs = ITEMS.map((_, i) => Number($('voteX' + i).value)), ws = ITEMS.map((_, i) => Number($('voteW' + i).value)), b = Number(biasIn.value);
            const terms = xs.map((x, i) => x * ws[i]);
            const z = terms.reduce((s, t) => s + t, b), y = activation(z, kind);
            ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
            const zx0 = 250, zx1 = 560, zMax = 4, mapZ = v => zx0 + (clamp(v, -zMax, zMax) + zMax) / (2 * zMax) * (zx1 - zx0);
            text(ctx, 'THE VOTE · each row adds its own push to the running total', 16, 20, TEXT, '800 11px system-ui');
            for (let v = -4; v <= 4; v += 1) { ctx.strokeStyle = v === 0 ? '#5c7a6a' : '#1d2f27'; ctx.beginPath(); ctx.moveTo(mapZ(v), 34); ctx.lineTo(mapZ(v), 34 + 6 * 46 + 6); ctx.stroke(); text(ctx, String(v), mapZ(v), 34 + 6 * 46 + 22, DIM, '10px system-ui', 'center'); }
            let cum = 0;
            const lines = [{ label: 'bias b', detail: signed(b), delta: b }, ...ITEMS.map((label, i) => ({ label, detail: xs[i].toFixed(2) + ' × ' + ws[i].toFixed(2), delta: terms[i] }))];
            lines.forEach((row, i) => {
                const y0 = 40 + i * 46, from = cum, to = cum + row.delta;
                text(ctx, row.label, 16, y0 + 16, '#eef6f0', '700 11px system-ui');
                text(ctx, row.detail + ' = ' + signed(row.delta), 16, y0 + 31, DIM, '10px ui-monospace, monospace');
                ctx.fillStyle = row.delta >= 0 ? '#fbbf24' : '#a78bfa';
                ctx.fillRect(Math.min(mapZ(from), mapZ(to)), y0 + 8, Math.max(1.5, Math.abs(mapZ(to) - mapZ(from))), 22);
                ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(mapZ(to), y0 + 30); ctx.lineTo(mapZ(to), y0 + 54); ctx.stroke(); ctx.setLineDash([]);
                cum = to;
            });
            const yT = 40 + lines.length * 46;
            text(ctx, 'z = ' + signed(z), 16, yT + 22, '#d8e985', '800 14px ui-monospace, monospace');
            ctx.fillStyle = '#ef6f61'; ctx.beginPath(); ctx.moveTo(mapZ(z), yT + 4); ctx.lineTo(mapZ(z) - 7, yT + 18); ctx.lineTo(mapZ(z) + 7, yT + 18); ctx.closePath(); ctx.fill();
            text(ctx, 'z', mapZ(z), yT + 32, '#ef6f61', '800 11px system-ui', 'center');
            // activation plot
            const ax0 = 610, ax1 = 880, ay0 = 60, ay1 = 250;
            const yLo = kind === 'tanh' ? -1.2 : -0.1, yHi = kind === 'relu' ? 6 : kind === 'sigmoid' ? 1.1 : 1.2;
            const mapAX = v => ax0 + (clamp(v, -zMax, zMax) + zMax) / (2 * zMax) * (ax1 - ax0), mapAY = v => ay1 - (clamp(v, yLo, yHi) - yLo) / (yHi - yLo) * (ay1 - ay0);
            text(ctx, 'THEN SQUASH · ' + (kind === 'relu' ? 'ReLU' : kind), ax0, 40, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
            hLine(ctx, ax0, ax1, mapAY(0), '#3a5548', [3, 3]); ctx.strokeStyle = '#3a5548'; ctx.beginPath(); ctx.moveTo(mapAX(0), ay0); ctx.lineTo(mapAX(0), ay1); ctx.stroke();
            trace(ctx, 121, i => mapAX(-zMax + i * (2 * zMax / 120)), i => mapAY(activation(-zMax + i * (2 * zMax / 120), kind)), '#67e8f9', 2.6);
            hLine(ctx, ax0, mapAX(z), mapAY(y), 'rgba(239,111,97,.6)', [3, 3]); ctx.strokeStyle = 'rgba(239,111,97,.6)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(mapAX(z), ay1); ctx.lineTo(mapAX(z), mapAY(y)); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = '#ef6f61'; ctx.beginPath(); ctx.arc(mapAX(z), mapAY(y), 6, 0, Math.PI * 2); ctx.fill();
            text(ctx, 'z →', ax1, ay1 + 16, DIM, '10px system-ui', 'right');
            text(ctx, PRESETS[current] ? PRESETS[current].out.toUpperCase() : 'OUTPUT', ax0, 282, TEXT, '800 11px system-ui');
            text(ctx, y.toFixed(3), ax0, 314, '#eef6f0', '800 28px Georgia, serif');
            const meaning = current === 'steer' ? (y > 0.05 ? 'steer right ' + Math.round(Math.abs(y) * 100) + '%' : y < -0.05 ? 'steer left ' + Math.round(Math.abs(y) * 100) + '%' : 'go straight') : current === 'gas' ? 'gas ' + Math.round(clamp(y, 0, 1) * 100) + '%' : '';
            if (meaning) text(ctx, meaning, ax0, 338, '#d8e985', '700 12px system-ui');
            let top = 0; terms.forEach((t, i) => { if (Math.abs(t) > Math.abs(terms[top])) top = i; });
            ITEMS.forEach((_, i) => { $('voteXo' + i).textContent = num2(xs[i]); $('voteWo' + i).textContent = num2(ws[i]); });
            $('voteBiasValue').textContent = num2(b);
            $('voteZReadout').textContent = signed(z);
            $('voteYReadout').textContent = y.toFixed(3);
            $('voteTopReadout').textContent = Math.abs(terms[top]) < 0.005 ? '—' : ITEMS[top].split(' ')[0];
            setStatus($('voteStatusTag'), (PRESETS[current] ? PRESETS[current].name : 'Custom') + ' · z = ' + signed(z, 1), '');
        }
        const num2 = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
        ITEMS.forEach((_, i) => { $('voteX' + i).addEventListener('input', () => { current = 'custom'; draw(); }); $('voteW' + i).addEventListener('input', () => { current = 'custom'; draw(); }); });
        biasIn.addEventListener('input', () => { current = 'custom'; draw(); });
        load('steer');
    })();

    /* ------------------------------------------------------------------
       Lab 5.2 · Two groups of LIF neurons compete
       ------------------------------------------------------------------ */
    (function competeLab() {
        const canvas = $('competeCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 400, GROUP = 10, HISTORY = 120;
        const evR = $('competeEvR'), evL = $('competeEvL'), inhib = $('competeInhib'), selfEx = $('competeSelf'), noiseIn = $('competeNoise');
        const gains = Array.from({ length: GROUP }, (_, i) => 0.85 + 0.3 * i / (GROUP - 1));
        let random, v, prev, steer, raster, steerHist, rates;
        function reset() {
            random = seededRandom(5); v = [new Float64Array(GROUP), new Float64Array(GROUP)]; prev = [0, 0]; steer = 0; raster = []; steerHist = []; rates = [0, 0];
        }
        function tick() {
            const e = [Number(evR.value), Number(evL.value)], g = Number(inhib.value), s = Number(selfEx.value), sigma = Number(noiseIn.value);
            const fr = [prev[0] / GROUP, prev[1] / GROUP], now = [0, 0], spikes = new Uint8Array(2 * GROUP);
            for (let side = 0; side < 2; side++) for (let i = 0; i < GROUP; i++) {
                const current = gains[i] * e[side] + s * fr[side] * 2 - g * fr[1 - side] * 4 + sigma * gaussian(random);
                v[side][i] = v[side][i] * 0.86 + 0.22 * current;
                if (v[side][i] > 0.42) { now[side]++; v[side][i] = 0; spikes[side * GROUP + i] = 1; }
            }
            prev = now;
            steer = steer * 0.72 + Math.tanh(4 * (now[0] - now[1]) / GROUP) * 0.28;
            raster.push(spikes); steerHist.push(steer);
            if (raster.length > HISTORY) { raster.shift(); steerHist.shift(); }
            rates[0] = rates[0] * 0.95 + now[0] / GROUP * 30 * 0.05; rates[1] = rates[1] * 0.95 + now[1] / GROUP * 30 * 0.05;
        }
        function draw() {
            ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
            const rx0 = 90, rx1 = 610, col = (rx1 - rx0) / HISTORY, rowH = 11;
            text(ctx, 'STEER-RIGHT GROUP', rx0, 18, '#ef6f61', '800 11px system-ui'); text(ctx, 'STEER-LEFT GROUP', rx0, 162, '#67e8f9', '800 11px system-ui');
            const top = [26, 170];
            for (let side = 0; side < 2; side++) {
                ctx.fillStyle = side ? 'rgba(103,232,249,.05)' : 'rgba(239,111,97,.06)'; ctx.fillRect(rx0, top[side], rx1 - rx0, GROUP * rowH);
                for (let i = 0; i < GROUP; i++) text(ctx, String(i + 1), rx0 - 8, top[side] + i * rowH + 9, DIM, '9px system-ui', 'right');
            }
            const offset = HISTORY - raster.length;
            raster.forEach((spikes, t) => { for (let side = 0; side < 2; side++) for (let i = 0; i < GROUP; i++) if (spikes[side * GROUP + i]) { ctx.fillStyle = side ? '#67e8f9' : '#ef6f61'; ctx.fillRect(rx0 + (offset + t) * col, top[side] + i * rowH + 1, Math.max(1.6, col - 0.5), rowH - 2); } });
            text(ctx, 'last 4 s →', rx1, 150, DIM, '10px system-ui', 'right');
            // steering trace
            const sy0 = 312, sy1 = 392, mid = (sy0 + sy1) / 2;
            text(ctx, 'STEERING OUTPUT', rx0, sy0 - 8, TEXT, '800 11px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(rx0, sy0, rx1 - rx0, sy1 - sy0); hLine(ctx, rx0, rx1, mid, '#456054', [3, 4]);
            text(ctx, 'R', rx0 - 8, sy0 + 10, '#ef6f61', '800 10px system-ui', 'right'); text(ctx, 'L', rx0 - 8, sy1 - 2, '#67e8f9', '800 10px system-ui', 'right');
            if (steerHist.length > 1) trace(ctx, steerHist.length, i => rx0 + (offset + i + 0.5) * col, i => mid - steerHist[i] * (sy1 - sy0) / 2 * 0.95, '#eef6f0', 2);
            // right panel
            const ox = 650;
            text(ctx, 'FIRING RATE (spikes / s per neuron)', ox, 18, TEXT, '800 11px system-ui');
            [[0, 'right', '#ef6f61'], [1, 'left', '#67e8f9']].forEach(([side, label, color], k) => {
                const y = 34 + k * 30; text(ctx, label, ox, y + 12, color, '700 11px system-ui');
                ctx.fillStyle = '#1b2a23'; ctx.fillRect(ox + 44, y, 170, 16); ctx.fillStyle = color; ctx.fillRect(ox + 44, y, 170 * clamp(rates[side] / 15, 0, 1), 16);
                text(ctx, rates[side].toFixed(1), ox + 222, y + 12, '#eef6f0', '700 11px ui-monospace, monospace');
            });
            const cx = ox + 120, cy = 190, r = 70;
            ctx.strokeStyle = '#2e4a3d'; ctx.lineWidth = 11; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
            const angle = -Math.PI / 2 + clamp(steer, -1, 1) * (Math.PI * 0.42);
            ctx.strokeStyle = '#eef6f0'; ctx.lineWidth = 3.4; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(angle) * (r + 5), cy + Math.sin(angle) * (r + 5)); ctx.stroke();
            ctx.fillStyle = '#eef6f0'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
            text(ctx, 'L', cx - r - 14, cy - 8, '#67e8f9', '800 12px system-ui', 'center'); text(ctx, 'R', cx + r + 14, cy - 8, '#ef6f61', '800 12px system-ui', 'center');
            text(ctx, 'steer ' + signed(steer), cx, cy + 32, '#eef6f0', '800 14px ui-monospace, monospace', 'center');
            const hi = Math.max(rates[0], rates[1]), lo = Math.min(rates[0], rates[1]);
            const decided = hi > 2 && lo / hi < 0.2;
            text(ctx, decided ? 'Decided: one side has taken over.' : 'Blended: both sides are still voting.', ox, 290, decided ? '#d8e985' : '#f7dc86', '700 12px system-ui');
            text(ctx, 'inhibition ' + Number(inhib.value).toFixed(2) + ' · noise ' + Number(noiseIn.value).toFixed(2), ox, 310, DIM, '11px system-ui');
            $('competeEvRValue').textContent = Number(evR.value).toFixed(2); $('competeEvLValue').textContent = Number(evL.value).toFixed(2);
            $('competeInhibValue').textContent = Number(inhib.value).toFixed(2); $('competeSelfValue').textContent = Number(selfEx.value).toFixed(2); $('competeNoiseValue').textContent = Number(noiseIn.value).toFixed(2);
            $('competeRRate').textContent = rates[0].toFixed(1); $('competeLRate').textContent = rates[1].toFixed(1); $('competeSteer').textContent = signed(steer);
            setStatus($('competeStatusTag'), (clock.running ? 'Running · ' : 'Paused · ') + (decided ? 'decided' : 'blended'), decided ? 'firing' : '');
        }
        const clock = labClock(canvas, 30, tick, draw);
        reset(); for (let i = 0; i < 90; i++) tick();
        $('competePlayBtn').addEventListener('click', () => { clock.running = !clock.running; $('competePlayBtn').textContent = clock.running ? 'Pause' : 'Play'; draw(); });
        $('competeSwapBtn').addEventListener('click', () => { const a = evR.value; evR.value = evL.value; evL.value = a; });
        $('competeResetBtn').addEventListener('click', () => { evR.value = '0.62'; evL.value = '0.5'; inhib.value = '0.12'; selfEx.value = '0.1'; noiseIn.value = '0.1'; reset(); for (let i = 0; i < 30; i++) tick(); clock.running = true; $('competePlayBtn').textContent = 'Pause'; draw(); });
        draw();
    })();

    /* ------------------------------------------------------------------
       Lab 6.1 · The staircase: spike count as a function of one weight
       ------------------------------------------------------------------ */
    (function stairsLab() {
        const canvas = $('stairsCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 360, TICKS = 60, W_MAX = 3, STEP = 0.005, N = Math.round(W_MAX / STEP) + 1;
        const weightIn = $('stairsWeight'), smoothIn = $('stairsSmooth');
        const counts = new Float64Array(N);
        for (let i = 0; i < N; i++) { let v = 0, c = 0; const drive = i * STEP; for (let t = 0; t < TICKS; t++) { v = 0.86 * v + 0.22 * drive; if (v > 0.42) { c++; v = 0; } } counts[i] = c; }
        let flat = 0; for (let i = 0; i < N - 1; i++) if (counts[i] === counts[i + 1]) flat++;
        const flatShare = flat / (N - 1);
        let smooth = new Float64Array(N);
        function computeSmooth() {
            const sigma = Number(smoothIn.value), span = Math.ceil(3 * sigma / STEP);
            for (let i = 0; i < N; i++) { let num = 0, den = 0; for (let k = Math.max(0, i - span); k <= Math.min(N - 1, i + span); k++) { const d = (k - i) * STEP / sigma, w = Math.exp(-0.5 * d * d); num += counts[k] * w; den += w; } smooth[i] = num / den; }
        }
        const box = { x0: 66, x1: 880, y0: 24, y1: 320 };
        const mapX = w => box.x0 + w / W_MAX * (box.x1 - box.x0), mapY = c => box.y1 - c / 60 * (box.y1 - box.y0);
        function draw() {
            computeSmooth();
            const w = Number(weightIn.value), i = clamp(Math.round(w / STEP), 1, N - 2);
            const trueSlope = (counts[i + 1] - counts[i - 1]) / (2 * STEP), smoothSlope = (smooth[i + 1] - smooth[i - 1]) / (2 * STEP);
            ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
            ctx.strokeStyle = GRID; ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
            [15, 30, 45, 60].forEach(c => { hLine(ctx, box.x0, box.x1, mapY(c), '#1d2f27'); text(ctx, String(c), box.x0 - 6, mapY(c) + 4, DIM, '10px system-ui', 'right'); });
            text(ctx, '0', box.x0 - 6, box.y1 + 4, DIM, '10px system-ui', 'right');
            for (let a = 0; a <= 3; a += 0.5) text(ctx, a.toFixed(1), mapX(a), box.y1 + 16, DIM, '10px system-ui', 'center');
            text(ctx, 'weight w (input current = w) →', box.x1, box.y1 + 34, DIM, '10px system-ui', 'right');
            text(ctx, 'spikes in 2 s', box.x0, box.y0 - 8, TEXT, '800 11px system-ui');
            ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 2.4; ctx.beginPath();
            for (let k = 0; k < N; k++) { const x = mapX(k * STEP), y = mapY(counts[k]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
            ctx.stroke();
            ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2.6; ctx.beginPath();
            for (let k = 0; k < N; k++) { const x = mapX(k * STEP), y = mapY(smooth[k]); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
            ctx.stroke();
            text(ctx, 'true staircase', mapX(2.2), mapY(counts[Math.round(2.2 / STEP)]) + 22, '#67e8f9', '700 11px system-ui');
            text(ctx, 'smoothed (σ = ' + Number(smoothIn.value).toFixed(2) + ')', mapX(0.55), mapY(smooth[Math.round(0.55 / STEP)]) - 12, '#fbbf24', '700 11px system-ui');
            ctx.strokeStyle = '#ef6f61'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(mapX(w), box.y0); ctx.lineTo(mapX(w), box.y1); ctx.stroke(); ctx.setLineDash([]);
            const seg = (slope, color, y) => { const dx = 0.25; ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(mapX(w - dx), mapY(y - slope * dx)); ctx.lineTo(mapX(w + dx), mapY(y + slope * dx)); ctx.stroke(); };
            seg(smoothSlope, '#fbbf24', smooth[i]); seg(trueSlope, '#ef6f61', counts[i]);
            ctx.fillStyle = '#ef6f61'; ctx.beginPath(); ctx.arc(mapX(w), mapY(counts[i]), 5, 0, Math.PI * 2); ctx.fill();
            text(ctx, 'red tangent: what backprop sees', box.x0 + 8, box.y0 + 16, '#ef6f61', '700 11px system-ui'); text(ctx, 'gold tangent: slope of the smoothed curve', box.x0 + 8, box.y0 + 32, '#fbbf24', '700 11px system-ui');
            $('stairsWeightValue').textContent = w.toFixed(2); $('stairsSmoothValue').textContent = Number(smoothIn.value).toFixed(2);
            $('stairsCountReadout').textContent = String(counts[i]);
            $('stairsTrueReadout').textContent = Math.abs(trueSlope) < 1e-9 ? '0' : trueSlope.toFixed(0);
            $('stairsSmoothReadout').textContent = (smoothSlope >= 0 ? '+' : '−') + Math.abs(smoothSlope).toFixed(1);
            $('stairsFact').innerHTML = '<b>' + Math.round(flatShare * 100) + '%</b> of the weight axis is perfectly flat: nudge the weight and the spike count does not change at all. The remaining ' + Math.round((1 - flatShare) * 100) + '% are jumps of one spike, where the slope is effectively infinite.';
            setStatus($('stairsStatusTag'), Math.abs(trueSlope) < 1e-9 ? 'Flat here · true slope 0' : 'On a step edge', Math.abs(trueSlope) < 1e-9 ? '' : 'firing');
        }
        [weightIn, smoothIn].forEach(input => input.addEventListener('input', draw));
        draw();
    })();

    /* ------------------------------------------------------------------
       Lab 7.1 · Where the joules go
       ------------------------------------------------------------------ */
    (function energyLab() {
        const canvas = $('energyCanvas');
        if (!canvas) return;
        const ctx = crispCanvas(canvas);
        const W = 900, H = 360;
        const neuronsIn = $('energyNeurons'), activityIn = $('energyActivity');
        const E_MAC = 4.6e-12, E_ADD = 0.9e-12, E_SRAM = 5e-12, E_DRAM = 640e-12, E_XBAR = 0.5e-12, I = 17, OUT = 4;
        const neurons = () => Math.round(48 * Math.pow(100000 / 48, Number(neuronsIn.value) / 100));
        const fmtJ = e => e >= 1 ? e.toFixed(2) + ' J' : e >= 1e-3 ? (e * 1e3).toFixed(2) + ' mJ' : e >= 1e-6 ? (e * 1e6).toFixed(2) + ' µJ' : e >= 1e-9 ? (e * 1e9).toFixed(2) + ' nJ' : (e * 1e12).toFixed(1) + ' pJ';
        const fmtW = p => p >= 1 ? p.toFixed(1) + ' W' : p >= 1e-3 ? (p * 1e3).toFixed(1) + ' mW' : p >= 1e-6 ? (p * 1e6).toFixed(1) + ' µW' : (p * 1e9).toFixed(1) + ' nW';
        const big = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' G' : n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(Math.round(n));
        function draw() {
            const N = neurons(), f = Number(activityIn.value) / 100;
            const dense = N * N + I * N + OUT * N, event = f * N * N + I * N + f * N * OUT;
            const options = [
                ['Dense, weights in DRAM', dense * (E_MAC + E_DRAM), '#d8574a', 'every weight fetched off-chip every tick'],
                ['Dense, weights on-chip (SRAM)', dense * (E_MAC + E_SRAM), '#d99a1a', 'same arithmetic, near memory'],
                ['Event-driven, on-chip SRAM', event * (E_ADD + E_SRAM), '#7fbf6a', 'only spiking neurons are processed'],
                ['Event-driven, in-memory crossbar', event * E_XBAR, '#67e8f9', 'weights never move (0.5 pJ / event assumed)'],
            ];
            ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
            const bx0 = 230, bx1 = 700, decades = 11, minLog = -10;
            const mapX = e => bx0 + clamp((Math.log10(e) - minLog) / decades, 0, 1) * (bx1 - bx0);
            text(ctx, 'ENERGY PER BRAIN TICK · log scale', 16, 20, TEXT, '800 11px system-ui');
            for (let d = 0; d <= decades; d += 1) { const x = bx0 + d / decades * (bx1 - bx0); ctx.strokeStyle = d % 3 === 0 ? '#2e4a3d' : '#1d2f27'; ctx.beginPath(); ctx.moveTo(x, 34); ctx.lineTo(x, 34 + 4 * 66 - 4); ctx.stroke(); }
            [[-9, '1 nJ'], [-6, '1 µJ'], [-3, '1 mJ'], [0, '1 J']].forEach(([lg, label]) => text(ctx, label, bx0 + (lg - minLog) / decades * (bx1 - bx0), 34 + 4 * 66 + 10, DIM, '10px system-ui', 'center'));
            const best = Math.min(...options.map(o => o[1]));
            options.forEach(([label, e, color, note], i) => {
                const y = 40 + i * 66;
                text(ctx, label, 16, y + 16, '#eef6f0', '700 12px system-ui'); text(ctx, note, 16, y + 33, DIM, '10px system-ui');
                ctx.fillStyle = color; ctx.fillRect(bx0, y + 6, Math.max(2, mapX(e) - bx0), 30);
                text(ctx, fmtJ(e), bx1 + 14, y + 20, '#eef6f0', '800 13px ui-monospace, monospace');
                text(ctx, fmtW(e * 30) + ' at 30 Hz', bx1 + 14, y + 36, DIM, '10px system-ui');
                text(ctx, e / best < 1.5 ? 'cheapest' : '×' + (e / best >= 100 ? Math.round(e / best).toLocaleString('en-US') : (e / best).toFixed(1)), bx1 - 6, y + 25, '#9fb0a5', '700 11px system-ui', 'right');
            });
            text(ctx, 'per-operation energies: 32-bit float multiply 3.7 pJ, add 0.9 pJ, on-chip SRAM read 5 pJ, off-chip DRAM read 640 pJ (45 nm, Horowitz 2014)', 16, 348, DIM, '10px system-ui');
            $('energyNeuronsValue').textContent = N.toLocaleString('en-US'); $('energyActivityValue').textContent = Number(activityIn.value).toFixed(1).replace('.0', '') + '%';
            $('energyWeightsReadout').textContent = big(N * N + I * N + OUT * N); $('energyDenseReadout').textContent = big(dense); $('energyEventReadout').textContent = big(event);
            const ratio = options[0][1] / options[3][1];
            $('energyNote').innerHTML = N <= 60 ? 'At the kart\'s own size the worst case is ' + fmtW(options[0][1] * 30) + ' per kart. Nothing here is an energy problem in a browser; it is a lesson in what <em>would</em> matter at scale.' : 'Dense off-chip needs <b>' + fmtW(options[0][1] * 30) + '</b> for this layer; event-driven in-memory needs <b>' + fmtW(options[3][1] * 30) + '</b>: about <b>' + Math.round(ratio).toLocaleString('en-US') + '×</b> less, but only while just ' + Number(activityIn.value).toFixed(1).replace('.0', '') + '% of neurons spike per tick.';
            setStatus($('energyStatusTag'), N.toLocaleString('en-US') + ' neurons · ' + Number(activityIn.value).toFixed(1).replace('.0', '') + '% active', '');
        }
        [neuronsIn, activityIn].forEach(input => input.addEventListener('input', draw));
        draw();
    })();
})();
