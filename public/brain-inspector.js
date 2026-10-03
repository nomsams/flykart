// Chapter 9 · Open a trained brain.
// All numbers come from FlyKartCore (flykart-core.js), which bundles the
// simulator's real controller, physics and reward function; this file only
// loads files and draws. Relies on crispCanvas() from the page's inline script.
(() => {
    'use strict';

    const root = document.getElementById('guided-inspect');
    if (!root) return;
    const $ = id => document.getElementById(id);
    const Core = window.FlyKartCore;

    const BG = '#101a16', TEXT = '#b8c8be', DIM = '#6f8a7c', GRID = '#2e4a3d', THREAD = '#ef6f61';
    const GROUP_COLOR = { road: '#67e8f9', position: '#d8e985', motion: '#fbbf24', traffic: '#ef6f61', self: '#c4b5fd' };
    const ROLE_ORDER = ['steer-right', 'steer-left', 'gas', 'brake', 'reverse', 'relay', 'silent'];
    const N = 48, I = 17;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const sgn = (v, d = 2) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);
    const num = (v, d = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
    const esc = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

    const setStatus = (id, text, tone) => { const el = $(id); if (!el) return; el.textContent = text; el.className = 'ap-status' + (tone ? ' ' + tone : ''); };

    if (!Core) {
        $('brainMessage').textContent = 'The lab engine (flykart-core.js) did not load, so the inspector is unavailable. Run npm run build:lab, or open the deployed site.';
        $('brainMessage').className = 'brain-message error';
        setStatus('brainStatusTag', 'Engine missing', 'firing');
        return;
    }

    const SENSORS = Core.SENSOR_INFO, ROLE = Core.ROLE_INFO, REWARDS = Core.REWARD_INFO;
    const NON_NEGATIVE = new Set([5, 16]);
    const SLIDER_RANGE = i => (i === 5 || i === 16 ? [0, 1] : i === 3 ? [-0.5, 1] : [-1, 1]);

    /* -------------------------------------------------------------- */
    /* Shared state                                                    */
    /* -------------------------------------------------------------- */

    const CRUISE = [0, 0, 0, 0.6, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0.3, 0];
    const situation = (label, hint, patch) => { const values = [...CRUISE]; Object.entries(patch).forEach(([i, v]) => { values[Number(i)] = v; }); return { label, hint, values }; };
    const PRESETS = [
        situation('Cruising, centred', 'Nothing to react to', {}),
        situation('Right bend ahead', 'Far curvature reads right', { 12: 0.3, 11: 0.1, 1: 0.18, 0: 0.1, 13: 0.1 }),
        situation('Left bend ahead', 'Far curvature reads left', { 12: -0.3, 11: -0.1, 1: -0.18, 0: -0.1, 13: -0.1 }),
        situation('Drifting to the right edge', 'Lateral +0.8', { 2: 0.8, 4: 0.2, 7: 0.2, 8: 0.97, 0: -0.06 }),
        situation('Drifting to the left edge', 'Lateral −0.8', { 2: -0.8, 4: 0.2, 7: 0.2, 8: 0.97, 0: 0.06 }),
        situation('Off the road (right)', 'Past the asphalt', { 2: 1, 4: 0, 7: -0.1 }),
        situation('Kart just ahead', 'Same lane, closing', { 5: 0.7, 9: 1, 10: -0.2 }),
        situation('Kart ahead on the left', 'Side −0.7', { 5: 0.6, 6: -0.7, 9: 0.9, 10: -0.2 }),
        situation('Kart ahead on the right', 'Side +0.7', { 5: 0.6, 6: 0.7, 9: 0.9, 10: -0.2 }),
        situation('Stalled car ahead', 'Obstacle flag on', { 5: 0.6, 9: 1, 10: -0.5, 16: 1 }),
        situation('Facing backwards', 'Alignment −1', { 0: 0.9, 8: -1, 3: 0.05, 1: 0.5, 13: 0.9 }),
        situation('Stopped at the start', 'Speed 0', { 3: 0, 15: 0 }),
    ];

    const S = {
        file: null, name: '', analysis: null, order: [], pos: [], selected: 0, silenced: new Set(),
        sensors: [...CRUISE], presetIndex: 0, lens: null, rates: new Float32Array(N),
        fpBaseline: null, fpPrevious: null, previousName: '', curves: null, curveOutput: 'steer', curveMs: 0, groupByRole: true,
    };
    const hooks = [];
    const emit = reason => hooks.forEach(fn => fn(reason));
    const inUseSnapshot = () => (S.silenced.size ? Core.silenceNeurons(S.file.snapshot, [...S.silenced]) : S.file.snapshot);
    const roleOf = j => S.analysis.neurons[j].role;
    const roleLabel = j => ROLE[roleOf(j)].label;
    const roleColor = j => ROLE[roleOf(j)].color;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function computeOrder() {
        const neurons = S.analysis.neurons;
        const list = neurons.map((_, j) => j);
        if (S.groupByRole) list.sort((a, b) => ROLE_ORDER.indexOf(neurons[a].role) - ROLE_ORDER.indexOf(neurons[b].role) || neurons[b].roleStrength - neurons[a].roleStrength || a - b);
        S.order = list;
        S.pos = new Array(N);
        list.forEach((neuron, position) => { S.pos[neuron] = position; });
    }
    const strongestNeuron = () => S.analysis.neurons.reduce((best, n) => (n.roleStrength > best.roleStrength ? n : best), S.analysis.neurons[0]).index;

    /* -------------------------------------------------------------- */
    /* Canvas helpers                                                  */
    /* -------------------------------------------------------------- */

    function prep(canvas, w, h) { const ctx = crispCanvas(canvas); return { canvas, ctx, w, h }; }
    function paint(view) { view.ctx.clearRect(0, 0, view.w, view.h); view.ctx.fillStyle = BG; view.ctx.fillRect(0, 0, view.w, view.h); }
    function text(ctx, value, x, y, color = TEXT, font = '11px system-ui', align = 'left') { ctx.fillStyle = color; ctx.font = font; ctx.textAlign = align; ctx.fillText(value, x, y); ctx.textAlign = 'left'; }
    function line(ctx, x0, y0, x1, y1, color, width = 1, dash) { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]); }
    const POS = [251, 191, 36], NEG = [167, 139, 250], BASE = [27, 42, 35];
    const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    function weightColor(w, max) { const t = Math.pow(Math.min(1, Math.abs(w) / (max || 1)), 0.6); const c = mixRgb(BASE, w >= 0 ? POS : NEG, t); return `rgb(${c[0]},${c[1]},${c[2]})`; }
    const pointer = (event, canvas) => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * (canvas.logicalWidth || canvas.width), y: (event.clientY - rect.top) / rect.height * (canvas.logicalHeight || canvas.height) }; };

    function whenNear(el, callback, margin = '1200px') {
        if (!('IntersectionObserver' in window)) { callback(); return; }
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); callback(); } }, { rootMargin: margin });
        observer.observe(el);
    }
    function trackVisibility(el, onChange) {
        const state = { visible: false };
        if (!('IntersectionObserver' in window)) { state.visible = true; return state; }
        new IntersectionObserver(entries => { state.visible = entries.some(entry => entry.isIntersecting); if (onChange) onChange(state.visible); }, { threshold: 0.05 }).observe(el);
        return state;
    }

    /* -------------------------------------------------------------- */
    /* 9.1 Loading a brain                                             */
    /* -------------------------------------------------------------- */

    const message = (textValue, tone) => { const el = $('brainMessage'); el.textContent = textValue; el.className = 'brain-message' + (tone ? ' ' + tone : ''); };

    function setBrain(file, name) {
        if (S.file) { S.fpPrevious = S.fpBaseline; S.previousName = S.name; }
        S.file = file; S.name = name; S.analysis = Core.analyseBrain(file.snapshot); S.silenced.clear();
        computeOrder(); S.selected = strongestNeuron(); S.rates.fill(0);
        S.fpBaseline = null;
        emit('brain');
    }

    function loadText(textValue, name) {
        try {
            const file = Core.parseBrainFile(textValue);
            setBrain(file, name);
            message(`Loaded “${name}”. Every lab below now shows this brain.` + (file.meta.upgradedFromLegacy ? ' It was an older nine-sensor file and was upgraded, as the simulator does.' : ''), 'ok');
        } catch (error) {
            message(error instanceof Error ? error.message : 'Could not read that file.', 'error');
        }
    }

    async function loadSample() {
        message('Loading the sample brain…');
        try {
            const response = await fetch('./sample-brain.json', { cache: 'no-cache' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            loadText(await response.text(), 'Bundled sample brain');
        } catch (error) {
            message('The sample brain could not be fetched (' + (error instanceof Error ? error.message : 'unknown error') + '). If you opened this page as a local file, serve it over http, or drop your own brain file above.', 'error');
        }
    }

    function loadHandWired() {
        if (typeof window.FlyKartHandWired !== 'function') { message('The hand-wired brain from Lab 8.1 is not available.', 'error'); return; }
        loadText(JSON.stringify({ format: 'flykart-brain', version: 2, provenance: [{ source: 'Wired by hand into four readable groups in Lab 8.1' }], network: window.FlyKartHandWired() }), 'Hand-wired brain (Lab 8.1)');
    }

    function readFile(file) {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { message('That file is over 5 MB, far larger than any FlyKart brain (about 70 KB).', 'error'); return; }
        const reader = new FileReader();
        reader.onload = () => loadText(String(reader.result), file.name);
        reader.onerror = () => message('The file could not be read.', 'error');
        reader.readAsText(file);
    }

    const drop = $('brainDrop');
    $('brainFileInput').addEventListener('change', event => { readFile(event.target.files[0]); event.target.value = ''; });
    ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', event => readFile(event.dataTransfer.files[0]));
    $('loadSampleBrainBtn').addEventListener('click', loadSample);
    $('loadHandWiredBtn').addEventListener('click', loadHandWired);
    $('brainPasteApply').addEventListener('click', () => loadText($('brainPaste').value, 'Pasted JSON'));

    function renderGlance() {
        const a = S.analysis, f = S.file;
        const stat = (label, value, note) => `<div class="glance-stat"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
        const withRole = N - a.roleCounts.silent - a.roleCounts.relay;
        const roleBar = ROLE_ORDER.filter(role => a.roleCounts[role] > 0).map(role => `<i style="flex:${a.roleCounts[role]};background:${ROLE[role].color}" title="${ROLE[role].label}: ${a.roleCounts[role]}"></i>`).join('');
        const roleLegend = ROLE_ORDER.filter(role => a.roleCounts[role] > 0).map(role => `<span><i style="background:${ROLE[role].color}"></i>${ROLE[role].label} ${a.roleCounts[role]}</span>`).join('');
        $('brainGlance').innerHTML =
            `<div class="glance-grid">${stat('Parameters', a.parameterCount.toLocaleString('en-US'), `${a.kilobytes.toFixed(1)} KB as 32-bit floats`)}${stat('Loops that excite', Math.round(a.excitatoryShare * 100) + '%', `of ${(a.layers.recurrent.positive + a.layers.recurrent.negative).toLocaleString('en-US')} non-trivial loop weights`)}${stat('Typical input weight', a.layers.input.meanAbs.toFixed(2), `strongest ${a.layers.input.maxAbs.toFixed(1)} · ${Math.round(a.layers.input.nearZero / a.layers.input.count * 100)}% near zero`)}${stat('Neurons with a clear job', withRole + ' / 48', `${a.roleCounts.relay} relays, ${a.roleCounts.silent} weak`)}</div>` +
            `<div class="role-bar" role="img" aria-label="Neurons by role">${roleBar}</div><div class="role-legend">${roleLegend}</div>`;
        const m = f.meta;
        const rows = [];
        rows.push(['Loaded', esc(S.name)]);
        rows.push(['Format', esc(m.format) + ' · version ' + m.version + (m.upgradedFromLegacy ? ' (upgraded)' : '')]);
        if (m.generation !== null) rows.push(['Generation', m.generation]);
        if (m.fitness !== null) rows.push(['Best fitness', m.fitness.toLocaleString('en-US', { maximumFractionDigits: 1 })]);
        if (m.track) rows.push(['Trained for', esc(m.track)]);
        if (m.savedAt) rows.push(['Saved', esc(new Date(m.savedAt).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }))]);
        m.sources.forEach(source => rows.push(['Origin', esc(source)]));
        if (m.lineage) rows.push(['Lineage', `${esc(m.lineage.name)} (gen ${m.lineage.generation})${m.lineage.parents.length ? ', from ' + esc(m.lineage.parents.join(' × ')) : ''}`]);
        $('brainMeta').innerHTML = '<dl>' + rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('') + '</dl>';
        setStatus('brainStatusTag', S.name + ' · ' + a.parameterCount.toLocaleString('en-US') + ' parameters', 'recovering');
    }

    /* -------------------------------------------------------------- */
    /* 9.2 The four blocks diagram                                     */
    /* -------------------------------------------------------------- */

    function renderBlocksDiagram() {
        const box = $('blocksDiagram');
        const a = S.analysis;
        const stat = block => (a ? `mean |w| ${a.layers[block].meanAbs.toFixed(2)}` : '');
        let sensors = '', neurons = '';
        for (let i = 0; i < I; i++) { const y = 26 + i * 12.6; sensors += `<circle cx="70" cy="${y.toFixed(1)}" r="4.2" fill="${GROUP_COLOR[SENSORS[i].group]}"/>`; }
        for (let j = 0; j < N; j++) { const cx = 372 + (j % 8) * 19, cy = 74 + Math.floor(j / 8) * 19; neurons += `<circle cx="${cx}" cy="${cy}" r="6.4" fill="#e3def5" stroke="#8f80d6" stroke-width="1"/>`; }
        const readouts = ['steer', 'gas', 'brake', 'reverse'].map((label, k) => `<circle cx="795" cy="${62 + k * 42}" r="10" fill="#214f3b"/><text x="812" y="${66 + k * 42}" font-size="12" fill="#3b4a3f" font-weight="700">${label}</text>`).join('');
        box.innerHTML = `<svg viewBox="0 0 900 270" role="img" aria-label="Sensors feed neurons through input weights; neurons feed each other through recurrent weights; neurons feed four readouts through output weights">
            <defs><marker id="blkArrow" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path d="M0 0L10 5L0 10z" fill="#b5483e"/></marker></defs>
            <text x="70" y="14" font-size="12" font-weight="800" fill="#3b4a3f" text-anchor="middle">17 sensors</text>${sensors}
            <path d="M78 26 L340 66 L340 190 L78 232 Z" fill="rgba(217,154,26,.10)" stroke="rgba(217,154,26,.45)" stroke-width="1"/>
            <text x="205" y="128" font-size="13" font-weight="800" fill="#7a5410" text-anchor="middle">Input weights</text>
            <text x="205" y="146" font-size="11" fill="#7a5410" text-anchor="middle">816 numbers · 17 × 48</text>
            <text x="205" y="162" font-size="11" fill="#7a5410" text-anchor="middle">${stat('input')}</text>
            <rect x="356" y="58" width="168" height="130" rx="14" fill="rgba(100,87,181,.08)" stroke="#a79bd7"/>
            <text x="440" y="46" font-size="12" font-weight="800" fill="#3b4a3f" text-anchor="middle">48 LIF neurons</text>${neurons}
            <path d="M380 58 C 358 14, 522 14, 500 58" fill="none" stroke="#b5483e" stroke-width="2" marker-end="url(#blkArrow)"/>
            <text x="440" y="11" font-size="11" font-weight="800" fill="#b5483e" text-anchor="middle">Recurrent weights · 2,304 numbers · 48 × 48</text>
            <text x="440" y="212" font-size="11" fill="#6d4a45" text-anchor="middle">${stat('recurrent')}</text>
            <path d="M440 200 L440 228" stroke="#6457b5" stroke-width="2" marker-end="url(#blkArrow)"/>
            <text x="440" y="246" font-size="12" font-weight="800" fill="#51478f" text-anchor="middle">Bias · 48 numbers</text>
            <text x="440" y="262" font-size="11" fill="#51478f" text-anchor="middle">${stat('bias')}</text>
            <path d="M532 66 L772 52 L772 210 L532 182 Z" fill="rgba(33,79,59,.09)" stroke="rgba(33,79,59,.4)" stroke-width="1"/>
            <text x="650" y="120" font-size="13" font-weight="800" fill="#214f3b" text-anchor="middle">Output weights</text>
            <text x="650" y="138" font-size="11" fill="#214f3b" text-anchor="middle">192 numbers · 4 × 48</text>
            <text x="650" y="154" font-size="11" fill="#214f3b" text-anchor="middle">${stat('output')}</text>
            <text x="800" y="36" font-size="12" font-weight="800" fill="#3b4a3f" text-anchor="middle">4 readouts</text>${readouts}
        </svg>`;
    }

    /* -------------------------------------------------------------- */
    /* 9.2 Weight atlas                                                */
    /* -------------------------------------------------------------- */

    const atlas = prep($('atlasCanvas'), 900, 470);
    const atlasState = { block: 'input', hover: null };
    const OUTPUT_ROWS = ['Steer readout', 'Gas readout', 'Brake readout', 'Reverse readout'];

    function atlasLayout() {
        if (atlasState.block === 'recurrent') return { x0: 210, y0: 46, cw: 8.8, ch: 8.8, rows: N, cols: N };
        if (atlasState.block === 'output') return { x0: 160, y0: 46, cw: (900 - 160 - 14) / N, ch: 70, rows: 4, cols: N };
        if (atlasState.block === 'bias') return { x0: 60, y0: 46, cw: (900 - 60 - 14) / N, ch: 0, rows: 1, cols: N };
        return { x0: 160, y0: 46, cw: (900 - 160 - 14) / N, ch: 22, rows: I, cols: N };
    }
    function atlasValue(row, col) {
        const a = S.file.snapshot, neuron = S.order[col];
        switch (atlasState.block) {
            case 'input': return a.inputWeights[neuron * I + row];
            case 'recurrent': return a.recurrentWeights[S.order[row] * N + neuron];
            case 'output': return a.outputWeights[row * N + neuron];
            default: return a.bias[neuron];
        }
    }
    const atlasMax = () => { const layers = S.analysis.layers; return Math.max(1e-6, { input: layers.input.maxAbs, recurrent: layers.recurrent.maxAbs, output: layers.output.maxAbs, bias: layers.bias.maxAbs }[atlasState.block]); };

    function drawAtlas() {
        paint(atlas);
        const ctx = atlas.ctx;
        if (!S.file) { text(ctx, 'Load a brain in Lab 9.1 to see its weights.', 450, 235, DIM, '14px system-ui', 'center'); return; }
        const L = atlasLayout(), max = atlasMax();
        const lensSensors = $('atlasRewardToggle').checked && S.lens ? REWARDS.find(r => r.key === S.lens).sensors : [];
        for (let c = 0; c < L.cols; c++) {
            const neuron = S.order[c], x = L.x0 + c * L.cw;
            ctx.fillStyle = roleColor(neuron); ctx.fillRect(x, L.y0 - 11, L.cw - 1, 5);
            if (S.silenced.has(neuron)) text(ctx, '×', x + L.cw / 2, L.y0 - 15, '#ef6f61', '800 11px system-ui', 'center');
            else if (c % 4 === 0 || atlasState.block === 'recurrent' && c % 6 === 0) text(ctx, String(neuron + 1), x + L.cw / 2, L.y0 - 15, DIM, '9px system-ui', 'center');
        }
        if (atlasState.block === 'bias') {
            const mid = 250, half = 170;
            line(ctx, L.x0, mid, L.x0 + L.cols * L.cw, mid, GRID, 1);
            const thresholdBias = 0.42 * (1 - 0.86) / 0.22;
            [thresholdBias, -thresholdBias].forEach(t => { line(ctx, L.x0, mid - t / max * half, L.x0 + L.cols * L.cw, mid - t / max * half, '#5b4a2a', 1, [5, 4]); });
            text(ctx, 'fires alone above +' + thresholdBias.toFixed(2), L.x0 + L.cols * L.cw, mid - thresholdBias / max * half - 5, '#c9a45a', '10px system-ui', 'right');
            for (let c = 0; c < L.cols; c++) {
                const value = atlasValue(0, c), x = L.x0 + c * L.cw, h = value / max * half;
                ctx.fillStyle = weightColor(value, max); ctx.fillRect(x, h >= 0 ? mid - h : mid, L.cw - 2, Math.abs(h));
            }
            text(ctx, 'bias +' + max.toFixed(2), L.x0 - 6, mid - half + 4, DIM, '10px system-ui', 'right');
            text(ctx, 'bias −' + max.toFixed(2), L.x0 - 6, mid + half + 4, DIM, '10px system-ui', 'right');
        } else {
            for (let r = 0; r < L.rows; r++) {
                for (let c = 0; c < L.cols; c++) { ctx.fillStyle = weightColor(atlasValue(r, c), max); ctx.fillRect(L.x0 + c * L.cw, L.y0 + r * L.ch, L.cw - (L.cw > 10 ? 1 : 0.6), L.ch - (L.ch > 10 ? 1 : 0.6)); }
                if (atlasState.block === 'input') text(ctx, SENSORS[r].label, L.x0 - 8, L.y0 + r * L.ch + 15, GROUP_COLOR[SENSORS[r].group], '10px system-ui', 'right');
                else if (atlasState.block === 'output') text(ctx, OUTPUT_ROWS[r], L.x0 - 8, L.y0 + r * L.ch + L.ch / 2 + 4, TEXT, '11px system-ui', 'right');
                else { ctx.fillStyle = roleColor(S.order[r]); ctx.fillRect(L.x0 - 9, L.y0 + r * L.ch, 5, L.ch - 0.6); if (r % 6 === 0) text(ctx, String(S.order[r] + 1), L.x0 - 13, L.y0 + r * L.ch + 8, DIM, '9px system-ui', 'right'); }
            }
            if (atlasState.block === 'input') lensSensors.forEach(i => { ctx.strokeStyle = THREAD; ctx.lineWidth = 1.6; ctx.strokeRect(L.x0 - 3, L.y0 + i * L.ch - 1, L.cols * L.cw + 5, L.ch + 1); });
            if (atlasState.block === 'recurrent') {
                text(ctx, 'listener ↓  ·  speaker →', L.x0, L.y0 + N * L.ch + 22, DIM, '11px system-ui');
                text(ctx, 'Row: the neuron that listens.', L.x0 + N * L.cw + 26, 80, TEXT, '11px system-ui');
                text(ctx, 'Column: the neuron that spoke on the last tick.', L.x0 + N * L.cw + 26, 98, TEXT, '11px system-ui');
                text(ctx, 'Diagonal: a neuron hearing itself.', L.x0 + N * L.cw + 26, 116, TEXT, '11px system-ui');
                text(ctx, 'Bright blocks = groups that recruit or', L.x0 + N * L.cw + 26, 146, DIM, '11px system-ui');
                text(ctx, 'suppress each other.', L.x0 + N * L.cw + 26, 162, DIM, '11px system-ui');
            }
        }
        // selection and hover
        const sel = S.pos[S.selected];
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
        if (atlasState.block === 'recurrent') {
            ctx.strokeRect(L.x0 + sel * L.cw - 0.5, L.y0 - 0.5, L.cw + 0.5, N * L.ch + 1);
            ctx.strokeRect(L.x0 - 0.5, L.y0 + sel * L.ch - 0.5, N * L.cw + 1, L.ch + 0.5);
        } else {
            const height = atlasState.block === 'bias' ? 340 : L.rows * L.ch;
            const top = atlasState.block === 'bias' ? 80 : L.y0;
            ctx.strokeRect(L.x0 + sel * L.cw - 0.5, top - 0.5, L.cw + 0.5, height + 1);
        }
        const h = atlasState.hover;
        if (h && atlasState.block !== 'bias') {
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
            ctx.strokeRect(L.x0 + h.col * L.cw - 0.5, L.y0 + h.row * L.ch - 0.5, L.cw + 0.5, L.ch + 0.5);
        }
    }

    function describeCell(row, col) {
        const neuron = S.order[col], value = atlasValue(row, col), sign = value >= 0 ? 'excitatory' : 'inhibitory';
        const who = j => `neuron #${j + 1} (${roleLabel(j).toLowerCase()})`;
        switch (atlasState.block) {
            case 'input': {
                const s = SENSORS[row];
                return `<b>${esc(s.label)}</b> → ${who(neuron)}: weight <b>${sgn(value)}</b> (${sign}). ${value >= 0 ? `It is pushed to fire when this sensor reads “${esc(s.high)}”` : `It is pushed to fire when this sensor reads “${esc(s.low)}”`}${NON_NEGATIVE.has(row) ? '' : `, and held back at the opposite reading`}. Each unit of sensor moves its voltage by ${sgn(value * 0.22, 2)} per tick against a threshold of 0.42.`;
            }
            case 'recurrent': {
                const listener = S.order[row], pct = Math.round(Math.abs(value) * 0.22 / 0.42 * 100);
                if (listener === neuron) return `${who(neuron)} hearing itself: weight <b>${sgn(value)}</b> — ${value >= 0 ? 'a spike makes the next spike more likely (it sustains itself)' : 'a spike makes the next one less likely (it self-limits)'}.`;
                return `When ${who(neuron)} spikes, ${who(listener)} hears it with weight <b>${sgn(value)}</b> (${sign}): its voltage moves by ${sgn(value * 0.22, 2)}, about ${pct}% of the way to threshold in one tick.`;
            }
            case 'output': {
                const name = ['steering (positive = right)', 'the gas readout', 'the brake readout', 'the reverse readout'][row];
                return `Each spike from ${who(neuron)} adds <b>${sgn(value)}</b> to ${name} before the tanh squash and 0.28 smoothing. ${row === 1 ? 'Positive raises gas.' : row === 2 ? 'Positive raises braking, because the controls use gas minus brake.' : row === 0 ? (value >= 0 ? 'It nudges the kart right.' : 'It nudges the kart left.') : 'Reverse only engages above 0.25.'}`;
            }
            default: {
                const settles = 0.22 * value / (1 - 0.86);
                return `${who(neuron)} has bias <b>${sgn(value)}</b>. With no other input its voltage would settle at ${sgn(settles)}; threshold is 0.42, so it ${settles > 0.42 ? '<b>fires on its own</b>' : 'needs help from inputs or loops to fire'}.`;
            }
        }
    }

    function atlasHit(event) {
        const p = pointer(event, atlas.canvas), L = atlasLayout();
        const col = Math.floor((p.x - L.x0) / L.cw);
        if (col < 0 || col >= L.cols) return null;
        if (atlasState.block === 'bias') return { row: 0, col };
        const row = Math.floor((p.y - L.y0) / L.ch);
        if (row < 0 || row >= L.rows) return null;
        return { row, col };
    }
    atlas.canvas.addEventListener('mousemove', event => {
        if (!S.file) return;
        const hit = atlasHit(event);
        atlasState.hover = hit;
        $('atlasHover').innerHTML = hit ? describeCell(hit.row, hit.col) : 'Hover a cell to read what the weight means.';
        drawAtlas();
    });
    atlas.canvas.addEventListener('mouseleave', () => { atlasState.hover = null; if (S.file) drawAtlas(); });
    atlas.canvas.addEventListener('click', event => {
        if (!S.file) return;
        const hit = atlasHit(event);
        if (!hit) return;
        S.selected = S.order[hit.col];
        emit('select');
    });
    (function bindAtlasControls() {
        const buttons = Array.from($('atlasBlock').querySelectorAll('button'));
        buttons.forEach(button => button.addEventListener('click', () => {
            atlasState.block = button.dataset.block;
            buttons.forEach(b => { b.classList.toggle('active', b === button); });
            atlasState.hover = null;
            if (S.file) { renderBlockFacts(); drawAtlas(); }
        }));
        $('atlasGroupToggle').addEventListener('change', event => { S.groupByRole = event.target.checked; if (S.file) { computeOrder(); emit('order'); } });
        $('atlasRewardToggle').addEventListener('change', () => { if (S.file) drawAtlas(); });
    })();

    function renderBlockFacts() {
        const a = S.analysis, l = a.layers[atlasState.block];
        const strongest = (() => {
            const snap = S.file.snapshot;
            const arr = { input: snap.inputWeights, recurrent: snap.recurrentWeights, output: snap.outputWeights, bias: snap.bias }[atlasState.block];
            let best = 0; arr.forEach((v, i) => { if (Math.abs(v) > Math.abs(arr[best])) best = i; });
            let where = '';
            if (atlasState.block === 'input') where = `${SENSORS[best % I].label} → neuron #${Math.floor(best / I) + 1}`;
            else if (atlasState.block === 'recurrent') where = `neuron #${best % N + 1} → neuron #${Math.floor(best / N) + 1}`;
            else if (atlasState.block === 'output') where = `neuron #${best % N + 1} → ${OUTPUT_ROWS[Math.floor(best / N)].toLowerCase()}`;
            else where = `neuron #${best + 1}`;
            return { value: arr[best], where };
        })();
        const meaning = {
            input: 'Each column is one neuron; each row is one sensor. A bright column means that neuron listens to many things; a bright row means many neurons use that sensor.',
            recurrent: 'Each cell is one spike-to-neuron link. With role grouping on, bright off-diagonal blocks show groups recruiting or suppressing each other.',
            output: 'Each column shows how one neuron\'s spikes move the four readouts. Most columns have one dominant row.',
            bias: 'Bars above the line make a neuron eager, bars below make it reluctant. The dashed lines mark the bias at which a neuron would fire with no input.',
        }[atlasState.block];
        $('blockFacts').innerHTML = `<p>${meaning}</p><dl>
            <div><dt>Weights</dt><dd>${l.count.toLocaleString('en-US')}</dd></div>
            <div><dt>Excitatory / inhibitory</dt><dd>${l.positive} / ${l.negative}</dd></div>
            <div><dt>Near zero (&lt; 0.02)</dt><dd>${Math.round(l.nearZero / l.count * 100)}%</dd></div>
            <div><dt>Typical size</dt><dd>${l.meanAbs.toFixed(2)}</dd></div>
            <div><dt>Strongest</dt><dd>${sgn(strongest.value)}<small>${esc(strongest.where)}</small></dd></div></dl>`;
        setStatus('atlasStatusTag', atlasState.block === 'input' ? '17 × 48 input weights' : atlasState.block === 'recurrent' ? '48 × 48 loop weights' : atlasState.block === 'output' ? '4 × 48 output weights' : '48 biases', 'recovering');
    }

    /* -------------------------------------------------------------- */
    /* Neuron card                                                     */
    /* -------------------------------------------------------------- */

    function renderNeuronCard() {
        const el = $('neuronCard');
        if (!S.file) { el.innerHTML = ''; return; }
        const n = S.analysis.neurons[S.selected], role = ROLE[n.role];
        const maxIn = Math.max(1e-6, ...n.inputTop.map(e => Math.abs(e.weight)));
        const strongest = Math.max(1e-6, ...S.analysis.neurons.map(x => Math.max(Math.abs(x.effect.steer), Math.abs(x.effect.drive), Math.abs(x.effect.reverse))));
        const bar = (value, scale) => `<span class="nbar"><i style="left:${value >= 0 ? 50 : 50 - Math.min(50, Math.abs(value) / scale * 50)}%;width:${Math.min(50, Math.abs(value) / scale * 50)}%;background:${value >= 0 ? '#fbbf24' : '#a78bfa'}"></i></span>`;
        const listeners = n.inputTop.map(e => `<li><span>${esc(SENSORS[e.sensor].label)}</span>${bar(e.weight, maxIn)}<b>${sgn(e.weight)}</b></li>`).join('');
        const chips = list => list.slice(0, 3).map(e => `<button type="button" class="chip" data-neuron="${e.neuron}" title="${esc(roleLabel(e.neuron))}"><i style="background:${roleColor(e.neuron)}"></i>#${e.neuron + 1} <b>${sgn(e.weight, 1)}</b></button>`).join('');
        const settles = 0.22 * n.bias / 0.14;
        const top = n.inputTop[0], second = n.inputTop[1];
        const clause = e => { const s = SENSORS[e.sensor]; return e.weight >= 0 ? `“${esc(s.label)}” is high (<em>${esc(s.high)}</em>)` : `“${esc(s.label)}” is low (<em>${esc(s.low)}</em>)`; };
        const effectWords = (() => {
            const e = n.effect, entries = [['steering ' + (e.steer >= 0 ? 'right' : 'left'), Math.abs(e.steer)], [e.drive >= 0 ? 'gas' : 'braking', Math.abs(e.drive)], ['reverse', Math.abs(e.reverse)]].sort((x, y) => y[1] - x[1]);
            return entries[0][1] < strongest * 0.08 ? 'barely moves the controls directly' : `mostly pushes ${entries[0][0]}`;
        })();
        const rate = S.rates[S.selected];
        el.innerHTML = `
            <div class="nc-head"><span class="role-chip" style="--c:${role.color}">${role.label}</span><strong>Neuron #${n.index + 1}</strong>
                <span class="nc-blurb">${role.blurb}</span>
                <button type="button" class="nc-action" data-action="silence">${S.silenced.has(n.index) ? 'Restore this neuron' : 'Silence this neuron'}</button></div>
            <p class="nc-sentence">In plain words: it fires most when ${top ? clause(top) : 'nothing in particular'}${second ? ` and when ${clause(second)}` : ''}. When it fires it ${effectWords}.</p>
            <div class="nc-grid">
                <div><h5>Listens most to</h5><ul class="nc-list">${listeners}</ul></div>
                <div><h5>Hears from</h5><div class="chips">${chips(n.inTop)}</div><h5>Talks to</h5><div class="chips">${chips(n.outTop)}</div>
                    <p class="nc-small">Loops: hears ${n.recurrentIn.toFixed(1)}, sends ${n.recurrentOut.toFixed(1)} (total |weight|). Self-link ${sgn(n.self)}.</p></div>
                <div><h5>Changes the controls</h5>
                    <ul class="nc-list"><li><span>Steer</span>${bar(n.effect.steer, strongest)}<b>${sgn(n.effect.steer)}</b></li><li><span>Gas − brake</span>${bar(n.effect.drive, strongest)}<b>${sgn(n.effect.drive)}</b></li><li><span>Reverse</span>${bar(n.effect.reverse, strongest)}<b>${sgn(n.effect.reverse)}</b></li></ul>
                    <p class="nc-small">Bias ${sgn(n.bias)}: alone it would settle at ${sgn(settles)} vs a threshold of 0.42 (${settles > 0.42 ? 'fires unprompted' : 'quiet without input'}).</p>
                    <p class="nc-small">Recent activity: fires on <b>${Math.round(rate * 100)}%</b> of ticks in the running labs.</p></div>
            </div>`;
        el.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => { S.selected = Number(chip.dataset.neuron); emit('select'); }));
        el.querySelector('[data-action="silence"]').addEventListener('click', () => { toggleSilence([n.index]); });
    }

    /* -------------------------------------------------------------- */
    /* 9.3 Roles and pathways                                          */
    /* -------------------------------------------------------------- */

    const roles = prep($('rolesCanvas'), 900, 430);
    const roleDots = [];

    function drawRoles() {
        paint(roles);
        const ctx = roles.ctx;
        if (!S.file) { text(ctx, 'Load a brain in Lab 9.1 to see its roles.', 450, 215, DIM, '14px system-ui', 'center'); return; }
        const a = S.analysis, neurons = a.neurons;
        const maxStrength = Math.max(1e-6, ...neurons.map(n => n.roleStrength));
        roleDots.length = 0;
        text(ctx, 'NEURONS BY ROLE', 16, 20, TEXT, '800 11px system-ui');
        let y = 34;
        ROLE_ORDER.forEach(role => {
            const members = neurons.filter(n => n.role === role).sort((p, q) => q.roleStrength - p.roleStrength);
            const bandH = 52;
            ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(10, y, 480, bandH - 4);
            text(ctx, ROLE[role].label, 18, y + 18, ROLE[role].color, '800 11px system-ui');
            text(ctx, members.length + (members.length === 1 ? ' neuron' : ' neurons'), 18, y + 33, DIM, '10px system-ui');
            const twoRows = members.length > 13;
            const perRow = twoRows ? Math.ceil(members.length / 2) : Math.max(1, members.length);
            const spacing = clamp(322 / Math.max(perRow, 1), 12, 25);
            members.forEach((n, k) => {
                const rowIndex = twoRows ? Math.floor(k / perRow) : 0;
                const col = twoRows ? k % perRow : k;
                const cx = 158 + col * spacing + spacing / 2, cy = y + (twoRows ? 13 + rowIndex * 22 : 22);
                const r = clamp(3.5 + 7 * (n.roleStrength / maxStrength), 3.5, spacing / 2 + 2);
                ctx.fillStyle = ROLE[role].color; ctx.globalAlpha = S.silenced.has(n.index) ? 0.25 : 1;
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
                if (S.silenced.has(n.index)) text(ctx, '×', cx, cy + 4, '#ffffff', '800 11px system-ui', 'center');
                if (n.index === S.selected) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.stroke(); }
                roleDots.push({ x: cx, y: cy, r: r + 3, index: n.index });
            });
            y += bandH;
        });
        // pathway matrix
        const px0 = 690, py0 = 56, cw = 64, ch = 20;
        text(ctx, 'FIRST-ORDER PATHWAY', 520, 20, TEXT, '800 11px system-ui');
        text(ctx, 'weights only: Σ input × output', 520, 34, DIM, '10px system-ui');
        const cols = [['steer', 'Steer', 'L ← → R'], ['drive', 'Gas − brake', 'brake ← → gas'], ['reverse', 'Reverse', 'off ← → on']];
        const maxP = Math.max(1e-6, ...cols.flatMap(([key]) => a.pathway[key].map(Math.abs)));
        const lensSensors = S.lens ? REWARDS.find(r => r.key === S.lens).sensors : [];
        cols.forEach(([key, label, hint], c) => {
            text(ctx, label, px0 + c * cw + cw / 2, py0 - 12, '#eef6f0', '800 10px system-ui', 'center');
            text(ctx, hint, px0 + c * cw + cw / 2, py0 - 1, DIM, '9px system-ui', 'center');
            for (let i = 0; i < I; i++) {
                const value = a.pathway[key][i];
                ctx.fillStyle = weightColor(value, maxP); ctx.fillRect(px0 + c * cw, py0 + 6 + i * ch, cw - 1, ch - 1);
                if (Math.abs(value) > maxP * 0.18) text(ctx, sgn(value, 1), px0 + c * cw + cw / 2, py0 + 6 + i * ch + 14, '#101a16', '800 10px system-ui', 'center');
            }
        });
        for (let i = 0; i < I; i++) text(ctx, SENSORS[i].label, px0 - 8, py0 + 6 + i * ch + 14, lensSensors.includes(i) ? THREAD : GROUP_COLOR[SENSORS[i].group], '10px system-ui', 'right');
        text(ctx, 'gold = pushes the control up, violet = down', 520, 412, DIM, '10px system-ui');
        setStatus('rolesStatusTag', `${a.roleCounts['steer-right'] + a.roleCounts['steer-left']} steering · ${a.roleCounts.gas + a.roleCounts.brake} speed · ${a.roleCounts.relay} relays`, 'recovering');
    }
    roles.canvas.addEventListener('click', event => {
        const p = pointer(event, roles.canvas);
        const hit = roleDots.find(d => Math.hypot(d.x - p.x, d.y - p.y) <= d.r);
        if (hit) { S.selected = hit.index; emit('select'); }
    });
    roles.canvas.addEventListener('mousemove', event => {
        const p = pointer(event, roles.canvas);
        roles.canvas.style.cursor = roleDots.some(d => Math.hypot(d.x - p.x, d.y - p.y) <= d.r) ? 'pointer' : 'default';
    });

    function renderLegends() {
        const html = ROLE_ORDER.map(role => `<span><i style="--legend:${ROLE[role].color}"></i>${ROLE[role].label}</span>`).join('');
        $('rolesLegend').innerHTML = html; $('probeLegend').innerHTML = html;
    }

    /* -------------------------------------------------------------- */
    /* 9.4 Probe                                                       */
    /* -------------------------------------------------------------- */

    const probeView = prep($('probeCanvas'), 900, 430);
    const probe = { sim: null, spikes: [], potentials: [], readouts: [0, 0, 0, 0], steer: 0, drive: 0, reverse: 0, acc: 0, last: 0, running: false, history: 90 };
    const probeVisible = trackVisibility($('probe-lab'), visible => { if (visible) startProbeLoop(); });

    function buildSliders() {
        const box = $('probeSliders');
        const groups = ['road', 'position', 'motion', 'traffic', 'self'];
        box.innerHTML = groups.map(group => `<div class="probe-group"><h5 style="--c:${GROUP_COLOR[group]}">${Core.SENSOR_GROUPS[group]}</h5>${SENSORS.filter(s => s.group === group).map(s => {
            const [lo, hi] = SLIDER_RANGE(s.index);
            return `<div class="probe-row" title="${esc(s.description)}"><label for="probeS${s.index}"><span>${esc(s.label)}</span><output id="probeV${s.index}">0.00</output></label><input id="probeS${s.index}" type="range" min="${lo}" max="${hi}" step="0.01" value="0"><i class="probe-push" id="probeP${s.index}"></i></div>`;
        }).join('')}</div>`).join('');
        SENSORS.forEach(s => {
            const input = $('probeS' + s.index);
            input.addEventListener('input', () => { S.sensors[s.index] = Number(input.value); S.presetIndex = -1; syncSliders(); });
            input.addEventListener('change', () => scheduleCurves(120));
        });
        $('probePresets').innerHTML = PRESETS.map((p, i) => `<button type="button" data-preset="${i}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join('');
        $('probePresets').querySelectorAll('button').forEach(button => button.addEventListener('click', () => applyPreset(Number(button.dataset.preset))));
    }
    function syncSliders() {
        SENSORS.forEach(s => { $('probeS' + s.index).value = S.sensors[s.index]; $('probeV' + s.index).textContent = num(S.sensors[s.index]); });
        $('probePresets').querySelectorAll('button').forEach(button => button.classList.toggle('active', Number(button.dataset.preset) === S.presetIndex));
        document.querySelectorAll('#fingerprintTable tbody tr[data-preset]').forEach(row => row.classList.toggle('active', Number(row.dataset.preset) === S.presetIndex));
        if (S.analysis) {
            const key = S.curveOutput === 'spikeFraction' ? 'steer' : S.curveOutput;
            const push = S.analysis.pathway[key], max = Math.max(1e-6, ...push.map(Math.abs));
            SENSORS.forEach(s => { const v = push[s.index] / max; $('probeP' + s.index).style.cssText = `--l:${v >= 0 ? 50 : 50 + v * 50}%;--w:${Math.abs(v) * 50}%;--c:${v >= 0 ? '#fbbf24' : '#a78bfa'}`; });
        }
    }
    function applyPreset(index) {
        S.presetIndex = index; S.sensors = [...PRESETS[index].values];
        syncSliders(); if (probe.sim) { probe.sim.reset(); probe.spikes = []; probe.potentials = []; }
        scheduleCurves(60);
    }

    function rebuildProbe() {
        probe.sim = new Core.Probe(inUseSnapshot());
        probe.spikes = []; probe.potentials = [];
        if (probeVisible.visible) startProbeLoop();
    }
    function probeTick() {
        if ($('probeFeedbackToggle').checked) {
            S.sensors[14] = clamp(probe.steer, -1, 1); S.sensors[15] = clamp(probe.drive, -1, 1);
            $('probeS14').value = S.sensors[14]; $('probeS15').value = S.sensors[15]; $('probeV14').textContent = num(S.sensors[14]); $('probeV15').textContent = num(S.sensors[15]);
        }
        const frame = probe.sim.step(S.sensors);
        probe.spikes.push(frame.spikes); probe.potentials.push(frame.potentials);
        if (probe.spikes.length > probe.history) { probe.spikes.shift(); probe.potentials.shift(); }
        probe.readouts = frame.readouts; probe.steer = frame.steer; probe.drive = frame.drive; probe.reverse = frame.reverse;
    }
    function startProbeLoop() {
        if (probe.running) return;
        probe.running = true; probe.last = 0;
        requestAnimationFrame(probeFrame);
    }
    function probeFrame(stamp) {
        if (!probeVisible.visible || !probe.sim) { probe.running = false; return; }
        if (!probe.last) probe.last = stamp;
        probe.acc += Math.min(0.25, (stamp - probe.last) / 1000); probe.last = stamp;
        if (!$('probePauseToggle').checked) { while (probe.acc >= 1 / 30) { probeTick(); probe.acc -= 1 / 30; } } else probe.acc = 0;
        drawProbe();
        requestAnimationFrame(probeFrame);
    }

    function drawProbe() {
        paint(probeView);
        const ctx = probeView.ctx;
        if (!S.file) { text(ctx, 'Load a brain in Lab 9.1 to probe it.', 450, 215, DIM, '14px system-ui', 'center'); return; }
        const rx0 = 64, rx1 = 560, ry0 = 30, rowH = 6, col = (rx1 - rx0) / probe.history;
        text(ctx, 'SPIKES · last 3 s (each column is one 33 ms tick)', rx0, 18, TEXT, '800 11px system-ui');
        const offset = probe.history - probe.spikes.length;
        for (let p = 0; p < N; p++) { const neuron = S.order[p]; ctx.fillStyle = roleColor(neuron); ctx.globalAlpha = S.silenced.has(neuron) ? 0.25 : 1; ctx.fillRect(rx0 - 9, ry0 + p * rowH, 4, rowH - 1); ctx.globalAlpha = 1; }
        probe.spikes.forEach((spikes, t) => {
            for (let p = 0; p < N; p++) {
                const neuron = S.order[p];
                if (!spikes[neuron]) continue;
                ctx.fillStyle = roleColor(neuron); ctx.globalAlpha = S.silenced.has(neuron) ? 0.28 : 1;
                ctx.fillRect(rx0 + (offset + t) * col, ry0 + p * rowH, Math.max(1.5, col - 0.6), rowH - 1);
                ctx.globalAlpha = 1;
            }
        });
        const selPos = S.pos[S.selected];
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.strokeRect(rx0 - 0.5, ry0 + selPos * rowH - 0.5, rx1 - rx0 + 1, rowH + 1);
        text(ctx, '◀ #' + (S.selected + 1), rx1 + 6, ry0 + selPos * rowH + 6, '#ffffff', '10px system-ui');
        // Rates for the neuron card and controls
        S.rates.fill(0);
        const recent = probe.spikes.slice(-30);
        recent.forEach(spikes => { for (let j = 0; j < N; j++) S.rates[j] += spikes[j] / recent.length; });
        const spikingNow = probe.spikes.length ? probe.spikes[probe.spikes.length - 1].reduce((s, v) => s + v, 0) : 0;

        // Controls
        const ox = 640;
        text(ctx, 'CONTROLS', ox, 18, TEXT, '800 11px system-ui');
        const cx = ox + 120, cy = 104, r = 62;
        ctx.strokeStyle = '#2e4a3d'; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
        const angle = -Math.PI / 2 + clamp(probe.steer, -1, 1) * (Math.PI * 0.42);
        line(ctx, cx, cy, cx + Math.cos(angle) * (r + 4), cy + Math.sin(angle) * (r + 4), '#eef6f0', 3);
        ctx.fillStyle = '#eef6f0'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
        text(ctx, 'L', cx - r - 14, cy - 8, '#67e8f9', '800 11px system-ui', 'center'); text(ctx, 'R', cx + r + 14, cy - 8, '#ef6f61', '800 11px system-ui', 'center');
        text(ctx, 'steer ' + sgn(probe.steer), cx, cy + 26, '#eef6f0', '800 12px ui-monospace, monospace', 'center');
        const bar = (y, label, value, lo, hi, colorPos, colorNeg) => {
            text(ctx, label, ox, y + 9, '#9fb0a5', '10px system-ui');
            const x0 = ox + 78, w = 160, mid = lo < 0 ? x0 + w * (-lo) / (hi - lo) : x0;
            ctx.fillStyle = '#1b2a23'; ctx.fillRect(x0, y, w, 11);
            const px = x0 + w * (value - lo) / (hi - lo);
            ctx.fillStyle = value >= 0 ? colorPos : colorNeg; ctx.fillRect(Math.min(mid, px), y, Math.abs(px - mid), 11);
            if (lo < 0) line(ctx, mid, y - 2, mid, y + 13, '#456054');
        };
        bar(190, 'gas − brake', clamp(probe.drive, -1, 1), -1, 1, '#d8e985', '#ef6f61');
        bar(212, 'reverse', clamp(probe.reverse, -0.2, 1), -0.2, 1, '#c4b5fd', '#456054');
        line(ctx, ox + 78 + 160 * (0.25 + 0.2) / 1.2, 208, ox + 78 + 160 * (0.25 + 0.2) / 1.2, 226, '#c4b5fd', 1, [2, 2]);
        text(ctx, 'gate 0.25', ox + 78 + 160 * 0.45 / 1.2 + 3, 236, DIM, '9px system-ui');
        bar(246, 'neurons firing', spikingNow / N, 0, 1, '#67e8f9', '#67e8f9');
        text(ctx, 'raw readouts  ' + probe.readouts.map(v => num(v, 2)).join('  '), ox, 280, DIM, '10px ui-monospace, monospace');
        const action = { throttle: clamp(probe.drive, 0, 1), brake: clamp(-probe.drive, 0, 1) };
        text(ctx, `→ throttle ${action.throttle.toFixed(2)} · brake ${action.brake.toFixed(2)}`, ox, 298, '#eef6f0', '11px ui-monospace, monospace');
        // Voltage trace
        const vy0 = 340, vy1 = 416;
        text(ctx, `NEURON #${S.selected + 1} · ${roleLabel(S.selected).toUpperCase()} · membrane voltage`, rx0, vy0 - 8, TEXT, '800 11px system-ui');
        ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.strokeRect(rx0, vy0, rx1 - rx0, vy1 - vy0);
        const volts = probe.potentials.map(p => p[S.selected]);
        let lo = -0.3, hi = 0.6; volts.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
        const mapV = v => vy1 - (v - lo) / (hi - lo) * (vy1 - vy0);
        line(ctx, rx0, mapV(0.42), rx1, mapV(0.42), '#ef6f61', 1, [5, 4]); text(ctx, 'threshold 0.42', rx1 - 4, mapV(0.42) - 4, '#efb3aa', '10px system-ui', 'right');
        line(ctx, rx0, mapV(0), rx1, mapV(0), '#456054', 1, [3, 4]);
        if (volts.length > 1) {
            ctx.strokeStyle = roleColor(S.selected); ctx.lineWidth = 1.8; ctx.beginPath();
            volts.forEach((v, t) => { const x = rx0 + (offset + t + 0.5) * col, y = mapV(v); if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
            ctx.stroke();
            probe.spikes.forEach((spikes, t) => { if (spikes[S.selected]) { const x = rx0 + (offset + t + 0.5) * col; line(ctx, x, mapV(0.42), x, vy0 + 2, '#ffffff', 1.5); } });
        }
        $('probeSteerReadout').textContent = sgn(probe.steer);
        $('probeDriveReadout').textContent = sgn(probe.drive);
        $('probeSpikeReadout').textContent = spikingNow + ' / 48';
        const lesionNote = S.silenced.size ? ` · ${S.silenced.size} silenced` : '';
        setStatus('probeStatusTag', (S.presetIndex >= 0 ? PRESETS[S.presetIndex].label : 'Custom situation') + lesionNote, S.silenced.size ? 'firing' : '');
    }

    /* -------------------------------------------------------------- */
    /* 9.5 Response curves                                             */
    /* -------------------------------------------------------------- */

    const curvesView = prep($('curvesCanvas'), 900, 560);
    const COLS = 6, CELL_W = 150, CELL_H = 178;
    let curveTimer = 0, curveDrag = null;
    const curveCells = [];
    const CURVE_TITLES = { steer: 'Steer (−1 left … +1 right)', drive: 'Gas − brake (−1 brake … +1 gas)', reverse: 'Reverse readout', spikeFraction: 'Share of neurons spiking' };

    function scheduleCurves(delay = 200) { clearTimeout(curveTimer); curveTimer = setTimeout(computeCurves, delay); }
    function computeCurves() {
        if (!S.file) return;
        const t0 = performance.now();
        S.curves = Core.responseCurves(inUseSnapshot(), [...S.sensors], 21);
        S.curveMs = performance.now() - t0;
        drawCurves();
    }
    function curveLayout() {
        const key = S.curveOutput, c = S.curves;
        const order = SENSORS.map((_, i) => i);
        const swing = key === 'spikeFraction' ? c.spikeFraction.map(row => Math.max(...row) - Math.min(...row)) : c.swing[key];
        order.sort((a, b) => swing[b] - swing[a]);
        return { order, swing };
    }
    function drawCurves() {
        paint(curvesView);
        const ctx = curvesView.ctx;
        curveCells.length = 0;
        if (!S.file || !S.curves) { text(ctx, S.file ? 'Computing…' : 'Load a brain in Lab 9.1 to see its response curves.', 450, 280, DIM, '14px system-ui', 'center'); return; }
        const key = S.curveOutput, { order, swing } = curveLayout(), data = S.curves[key];
        const yLo = key === 'spikeFraction' ? 0 : -1, yHi = 1;
        const maxSwing = Math.max(1e-6, ...swing);
        order.forEach((sensor, rank) => {
            const cellX = (rank % COLS) * CELL_W, cellY = 8 + Math.floor(rank / COLS) * CELL_H;
            const px0 = cellX + 14, px1 = cellX + CELL_W - 10, py0 = cellY + 34, py1 = cellY + 128;
            const info = SENSORS[sensor];
            ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(cellX + 4, cellY, CELL_W - 8, CELL_H - 8);
            ctx.fillStyle = GROUP_COLOR[info.group]; ctx.fillRect(cellX + 8, cellY + 8, 4, 12);
            text(ctx, `${rank + 1}. ${info.label}`, cellX + 16, cellY + 18, '#eef6f0', '700 10px system-ui');
            ctx.strokeStyle = GRID; ctx.strokeRect(px0, py0, px1 - px0, py1 - py0);
            const mapX = x => px0 + (x + 1) / 2 * (px1 - px0), mapY = y => py1 - (clamp(y, yLo, yHi) - yLo) / (yHi - yLo) * (py1 - py0);
            if (yLo < 0) line(ctx, px0, mapY(0), px1, mapY(0), '#3a5548', 1, [3, 3]);
            line(ctx, mapX(0), py0, mapX(0), py1, '#274035', 1);
            const emphasis = swing[sensor] / maxSwing;
            ctx.strokeStyle = emphasis > 0.25 ? '#67e8f9' : '#5a7d8a'; ctx.lineWidth = 1.4 + emphasis * 1.4; ctx.beginPath();
            S.curves.xs.forEach((x, k) => { const px = mapX(x), py = mapY(data[sensor][k]); if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
            ctx.stroke();
            const [rlo, rhi] = SLIDER_RANGE(sensor), cur = S.sensors[sensor];
            const t = (cur + 1) / 2 * 20, k0 = clamp(Math.floor(t), 0, 19), frac = t - k0;
            const yHere = data[sensor][k0] * (1 - frac) + data[sensor][k0 + 1] * frac;
            line(ctx, mapX(cur), py0, mapX(cur), py1, THREAD, 1, [3, 3]);
            ctx.fillStyle = THREAD; ctx.beginPath(); ctx.arc(mapX(cur), mapY(yHere), 3.4, 0, Math.PI * 2); ctx.fill();
            if (rlo > -1) { ctx.fillStyle = 'rgba(16,26,22,.6)'; ctx.fillRect(px0, py0, mapX(rlo) - px0, py1 - py0); }
            text(ctx, 'swing ' + swing[sensor].toFixed(2), px0, py1 + 14, emphasis > 0.25 ? '#9fe6f2' : DIM, '700 10px system-ui');
            if (key !== 'spikeFraction') {
                const w = S.analysis.pathway[key][sensor];
                text(ctx, 'weights: ' + sgn(w, 1), px1, py1 + 14, '#8a9a91', '10px system-ui', 'right');
            }
            text(ctx, '−1', px0, py1 + 27, DIM, '9px system-ui'); text(ctx, '+1', px1, py1 + 27, DIM, '9px system-ui', 'right');
            curveCells[rank] = { sensor, px0, px1, py0, py1, cellX, cellY };
        });
        setStatus('curvesStatusTag', `${CURVE_TITLES[key]} · ${Math.round(S.curveMs)} ms`, 'recovering');
    }
    function curveHit(event) {
        const p = pointer(event, curvesView.canvas);
        const hit = curveCells.find(h => h && p.x >= h.cellX && p.x <= h.cellX + CELL_W && p.y >= h.cellY && p.y <= h.cellY + CELL_H);
        return hit ? { hit, p } : null;
    }
    function setSensorFromCurve(hit, p) {
        const value = clamp(-1 + (p.x - hit.px0) / (hit.px1 - hit.px0) * 2, ...SLIDER_RANGE(hit.sensor));
        S.sensors[hit.sensor] = Math.round(value * 100) / 100; S.presetIndex = -1; syncSliders(); drawCurves();
    }
    curvesView.canvas.addEventListener('pointerdown', event => { const r = curveHit(event); if (!r) return; curveDrag = r.hit; curvesView.canvas.setPointerCapture(event.pointerId); setSensorFromCurve(r.hit, r.p); });
    curvesView.canvas.addEventListener('pointermove', event => { if (!curveDrag) return; setSensorFromCurve(curveDrag, pointer(event, curvesView.canvas)); });
    const endCurveDrag = () => { if (curveDrag) { curveDrag = null; scheduleCurves(80); } };
    curvesView.canvas.addEventListener('pointerup', endCurveDrag);
    curvesView.canvas.addEventListener('pointercancel', endCurveDrag);
    (function bindCurveControls() {
        const buttons = Array.from($('curveOutput').querySelectorAll('button'));
        buttons.forEach(button => button.addEventListener('click', () => {
            S.curveOutput = button.dataset.output; buttons.forEach(b => b.classList.toggle('active', b === button));
            syncSliders(); if (S.curves) drawCurves();
        }));
        $('curvesRecomputeBtn').addEventListener('click', () => computeCurves());
    })();

    /* -------------------------------------------------------------- */
    /* 9.6 Fingerprint                                                 */
    /* -------------------------------------------------------------- */

    function fingerprintOf(snapshot) { const p = new Core.Probe(snapshot); return PRESETS.map(preset => p.settle(preset.values)); }
    function renderFingerprint() {
        const rows = fingerprintOf(inUseSnapshot());
        if (!S.fpBaseline) S.fpBaseline = S.silenced.size ? fingerprintOf(S.file.snapshot) : rows;
        const ghost = S.silenced.size ? S.fpBaseline : S.fpPrevious;
        const ghostLabel = S.silenced.size ? 'before the lesion' : `previous: ${S.previousName}`;
        const cell = (value, before, lo, hi, fmtFn) => {
            const v = clamp((value - lo) / (hi - lo), 0, 1), mid = clamp((0 - lo) / (hi - lo), 0, 1);
            const left = Math.min(v, mid) * 100, width = Math.abs(v - mid) * 100;
            return `<td><div class="fp-cell"><span class="fp-track"><i style="left:${left}%;width:${width}%;background:${value >= 0 || lo >= 0 ? '#fbbf24' : '#a78bfa'}"></i></span><b>${fmtFn(value)}</b>${before !== undefined ? `<small>${fmtFn(before)}</small>` : ''}</div></td>`;
        };
        const table = $('fingerprintTable');
        table.querySelector('tbody').innerHTML = PRESETS.map((preset, i) => {
            const r = rows[i], g = ghost ? ghost[i] : undefined;
            return `<tr class="${i === S.presetIndex ? 'active' : ''}" data-preset="${i}"><td>${esc(preset.label)}</td>${cell(r.steer, g && g.steer, -1, 1, v => sgn(v))}${cell(r.drive, g && g.drive, -1, 1, v => sgn(v))}${cell(r.reverse, g && g.reverse, -0.2, 1, v => sgn(v))}${cell(r.spikeFraction, g && g.spikeFraction, 0, 0.5, v => Math.round(v * 100) + '%')}</tr>`;
        }).join('');
        table.querySelectorAll('tbody tr').forEach(row => row.addEventListener('click', () => applyPreset(Number(row.dataset.preset))));
        $('fingerprintCaption').textContent = ghost ? `Small grey numbers show ${ghostLabel}.` : 'Load a second brain (or silence some neurons) and this table will show the earlier reaction in grey for comparison.';
    }

    /* -------------------------------------------------------------- */
    /* 9.7 Reward map                                                  */
    /* -------------------------------------------------------------- */

    function renderRewardMap() {
        const cfg = Core.DEFAULT_REWARD_CONFIG;
        $('rewardMapTable').querySelector('tbody').innerHTML = REWARDS.map(r => {
            const value = cfg[r.config];
            return `<tr data-key="${r.key}" class="${S.lens === r.key ? 'active' : ''}"><td><span class="tag ${r.kind}">${r.kind === 'gain' ? '+' : '−'}</span> ${esc(r.label)}</td><td><b>${value}</b> <small>${r.unit}</small></td><td>${esc(r.what)}</td><td>${r.sensors.length ? r.sensors.map(i => `<span class="sensor-chip" style="--c:${GROUP_COLOR[SENSORS[i].group]}">${esc(SENSORS[i].label)}</span>`).join('') : '<em>every neuron</em>'}</td></tr>`;
        }).join('');
        $('rewardMapTable').querySelectorAll('tbody tr').forEach(row => row.addEventListener('click', () => setLens(row.dataset.key)));
    }
    function setLens(key) {
        S.lens = S.lens === key ? null : key;
        renderRewardMap(); renderLens(); if (S.file) { drawAtlas(); drawRoles(); }
        drawDriveAll();
    }
    function renderLens() {
        const el = $('rewardLensInfo');
        if (!S.lens) { el.innerHTML = 'Click a reward bar (or a row in the table in 9.7) to see what it measures and which sensors carry that information.'; return; }
        const r = REWARDS.find(x => x.key === S.lens), cfg = Core.DEFAULT_REWARD_CONFIG[r.config];
        el.innerHTML = `<b>${esc(r.label)}</b> <span class="tag ${r.kind}">${r.kind === 'gain' ? 'pays' : 'costs'} ${cfg} ${r.unit}</span> ${esc(r.what)} <span class="lens-sensors">Sensors: ${r.sensors.length ? r.sensors.map(i => `<span class="sensor-chip" style="--c:${GROUP_COLOR[SENSORS[i].group]}">${esc(SENSORS[i].label)}</span>`).join('') : 'every neuron contributes'}</span>`;
    }

    /* -------------------------------------------------------------- */
    /* 9.6 Drive lab                                                   */
    /* -------------------------------------------------------------- */

    const trackCanvas = prep($('driveCanvas'), 900, 420);
    const brainStrip = prep($('driveBrainCanvas'), 900, 250);
    const rewardView = prep($('rewardCanvas'), 900, 380);
    const driveVisible = trackVisibility($('drive-lab'), visible => { if (!visible) pauseDrive(); });
    const TRACKS = Core.trackList();
    let driveToken = 0;
    const D = { session: null, frame: null, running: false, last: 0, acc: 0, raster: [], trail: [], rewardWindow: [], series: [], events: [], fit: null, endTimer: 0, gates: [], banner: '' };
    const GAIN_KEYS = ['progress', 'direction', 'movement', 'centerline'];
    const PEN_KEYS = ['standingStill', 'wrongDirection', 'reverseProgress', 'offTrack', 'edge', 'proximity', 'hazard', 'controlChange', 'controlConflict', 'spikeEnergy'];

    $('driveTrack').innerHTML = TRACKS.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $('driveTrack').value = 'grand-loop';

    function fitTrack(track) {
        const xs = track.points.map(p => p.x), ys = track.points.map(p => p.y), pad = track.width / 2 + 12;
        const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
        const scale = Math.min(880 / (maxX - minX), 400 / (maxY - minY));
        const ox = (900 - (maxX - minX) * scale) / 2 - minX * scale, oy = (420 - (maxY - minY) * scale) / 2 - minY * scale;
        return { scale, x: v => v * scale + ox, y: v => v * scale + oy };
    }

    function makeSession() {
        if (!S.file) return;
        const objects = Number($('driveObjects').value);
        D.session = new Core.DriveSession(inUseSnapshot(), { trackId: $('driveTrack').value, rivals: Number($('driveRivals').value), roadObjects: objects, objectKind: objects >= 4 ? 'mixed' : 'stalled-car', seed: 1, walls: $('driveWalls').checked });
        D.track = TRACKS.find(t => t.id === $('driveTrack').value);
        D.fit = fitTrack(D.track);
        D.gates = Core.checkpointGates(D.track.id, 8);
        D.raster = []; D.trail = []; D.rewardWindow = []; D.series = []; D.events = []; D.banner = ''; clearTimeout(D.endTimer); D.endTimer = 0;
        D.frame = D.session.step();
        drawDriveAll(); updateDriveReadouts();
    }
    function pauseDrive() { D.running = false; driveToken++; D.last = 0; D.acc = 0; $('drivePlayBtn').textContent = 'Play'; }
    function playDrive() {
        if (!D.session) makeSession();
        if (!D.session) return;
        driveVisible.visible = true; // pressing Play means the lab is on screen; the observer corrects it later
        D.running = true; D.last = 0; D.acc = 0; $('drivePlayBtn').textContent = 'Pause';
        const token = ++driveToken;
        requestAnimationFrame(stamp => driveLoop(stamp, token));
    }
    function driveLoop(stamp, token) {
        if (token !== driveToken || !D.running) return;
        if (!driveVisible.visible) { pauseDrive(); return; }
        if (!D.last) D.last = stamp;
        D.acc += Math.min(0.25, (stamp - D.last) / 1000) * Number($('driveSpeed').value); D.last = stamp;
        const ended = () => D.frame.car.finished || D.frame.car.crashed;
        let guard = 0;
        while (!ended() && D.acc >= 1 / 30 && guard < 12) { driveTick(); D.acc -= 1 / 30; guard++; }
        if (ended()) D.acc = 0;
        drawDriveAll(); updateDriveReadouts();
        requestAnimationFrame(next => driveLoop(next, token));
    }
    function driveTick() {
        const f = D.session.step();
        D.frame = f;
        D.raster.push(f.spikes); if (D.raster.length > 120) D.raster.shift();
        if (f.tick % 4 === 0) { D.trail.push({ x: f.car.x, y: f.car.y }); if (D.trail.length > 60) D.trail.shift(); }
        D.rewardWindow.push(f.reward); if (D.rewardWindow.length > 30) D.rewardWindow.shift();
        const gain = GAIN_KEYS.reduce((s, k) => s + f.reward[k], 0) / (1 / 30), pen = PEN_KEYS.reduce((s, k) => s + f.reward[k], 0) / (1 / 30);
        D.series.push({ gain, pen, tick: f.tick, checkpoint: f.reward.checkpoint > 0 || f.reward.finish > 0, contact: f.reward.collision > 0 });
        if (D.series.length > 600) D.series.shift();
        f.events.forEach(e => { D.events.push({ text: e, seconds: f.seconds }); if (D.events.length > 4) D.events.shift(); });
        for (let j = 0; j < N; j++) S.rates[j] = S.rates[j] * 0.94 + f.spikes[j] * 0.06;
        if ((f.car.finished || f.car.crashed) && !D.endTimer) {
            D.banner = f.car.finished ? `Lap complete in ${f.seconds.toFixed(1)} s` : `Crashed: ${f.car.crashReason}`;
            if ($('driveLoop').checked) D.endTimer = setTimeout(() => { D.endTimer = 0; makeSession(); }, 1800);
            else pauseDrive();
        }
    }

    function drawObject(ctx, o, fit) {
        const x = fit.x(o.x), y = fit.y(o.y), s = fit.scale;
        ctx.save(); ctx.translate(x, y); ctx.rotate(o.heading);
        if (o.kind === 'oil') { ctx.fillStyle = 'rgba(130,117,200,.55)'; ctx.beginPath(); ctx.ellipse(0, 0, 28 * s, 22 * s, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#a79bd7'; ctx.lineWidth = 1; ctx.stroke(); }
        else if (o.kind === 'cone') { ctx.fillStyle = '#f08b47'; ctx.beginPath(); ctx.moveTo(8 * s, 0); ctx.lineTo(-7 * s, -7 * s); ctx.lineTo(-7 * s, 7 * s); ctx.closePath(); ctx.fill(); }
        else if (o.kind === 'barrier') { ctx.fillStyle = '#e0a15b'; ctx.fillRect(-5 * s, -17 * s, 10 * s, 34 * s); ctx.fillStyle = '#101a16'; for (let k = -2; k <= 2; k += 2) ctx.fillRect(-5 * s, k * 6 * s - 2 * s, 10 * s, 4 * s); }
        else { ctx.fillStyle = o.isObstacle ? '#d07c72' : '#f19a69'; ctx.fillRect(-12 * s, -7 * s, 24 * s, 14 * s); ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.strokeRect(-12 * s, -7 * s, 24 * s, 14 * s); if (o.isObstacle) { line(ctx, -8 * s, -4 * s, 8 * s, 4 * s, 'rgba(0,0,0,.5)', 1.5); line(ctx, -8 * s, 4 * s, 8 * s, -4 * s, 'rgba(0,0,0,.5)', 1.5); } }
        ctx.restore();
    }

    function drawTrackView() {
        paint(trackCanvas);
        const ctx = trackCanvas.ctx;
        if (!D.session || !D.frame) { text(ctx, S.file ? 'Press Play to drive.' : 'Load a brain in Lab 9.1 to drive it.', 450, 210, DIM, '14px system-ui', 'center'); return; }
        const fit = D.fit, f = D.frame, track = D.track;
        const path = () => { ctx.beginPath(); track.points.forEach((p, i) => { const x = fit.x(p.x), y = fit.y(p.y); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.closePath(); };
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = '#45604f'; ctx.lineWidth = (track.width + 5) * fit.scale; path(); ctx.stroke();
        ctx.strokeStyle = '#1f2f27'; ctx.lineWidth = track.width * fit.scale; path(); ctx.stroke();
        ctx.strokeStyle = 'rgba(200,220,208,.28)'; ctx.lineWidth = 1; ctx.setLineDash([7, 9]); path(); ctx.stroke(); ctx.setLineDash([]);
        // edge-risk glow
        const risk = clamp((Math.abs(f.car.lateral) - 0.55) / 0.45, 0, 1);
        if (risk > 0) {
            const g = f.guides, nx = -g.tangent.y * Math.sign(f.car.lateral), ny = g.tangent.x * Math.sign(f.car.lateral);
            const ex = fit.x(g.center.x + nx * track.width / 2), ey = fit.y(g.center.y + ny * track.width / 2);
            const grad = ctx.createRadialGradient(ex, ey, 2, ex, ey, 70 * fit.scale * 2);
            grad.addColorStop(0, `rgba(239,111,97,${0.65 * risk})`); grad.addColorStop(1, 'rgba(239,111,97,0)');
            ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(ex, ey, 70 * fit.scale * 2, 0, Math.PI * 2); ctx.fill();
        }
        // gates
        D.gates.forEach((gate, i) => {
            const nx = -gate.tangent.y, ny = gate.tangent.x, half = track.width / 2;
            const next = f.car.nextCheckpoint % 8 === i;
            line(ctx, fit.x(gate.point.x - nx * half), fit.y(gate.point.y - ny * half), fit.x(gate.point.x + nx * half), fit.y(gate.point.y + ny * half), next ? '#d8e985' : 'rgba(200,220,208,.22)', next ? 2.2 : 1, next ? [] : [3, 4]);
            if (i === 0) text(ctx, 'START', fit.x(gate.point.x + nx * half) + 6, fit.y(gate.point.y + ny * half) + 4, '#9fb0a5', '800 9px system-ui');
        });
        // trail
        if (D.trail.length > 1) { ctx.strokeStyle = 'rgba(255,209,102,.35)'; ctx.lineWidth = 2; ctx.beginPath(); D.trail.forEach((p, i) => { const x = fit.x(p.x), y = fit.y(p.y); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); }
        f.others.forEach(o => drawObject(ctx, o, fit));
        // proximity line
        let near = null, nearD = Infinity;
        f.others.forEach(o => { if (o.kind === 'oil') return; const d = Math.hypot(o.x - f.car.x, o.y - f.car.y); if (d < nearD) { nearD = d; near = o; } });
        if (near && nearD < 180) {
            const closeness = 1 - nearD / 180;
            line(ctx, fit.x(f.car.x), fit.y(f.car.y), fit.x(near.x), fit.y(near.y), `rgba(239,111,97,${0.25 + 0.6 * closeness})`, 1 + 2 * closeness, [4, 3]);
            text(ctx, Math.round(nearD) + ' px', (fit.x(f.car.x) + fit.x(near.x)) / 2 + 6, (fit.y(f.car.y) + fit.y(near.y)) / 2 - 4, '#ffb4a8', '700 10px system-ui');
        }
        // sensor guides
        const kx = fit.x(f.car.x), ky = fit.y(f.car.y);
        [['near', '#67e8f9', '+30'], ['look', '#fbbf24', 'look-ahead'], ['far', '#c4b5fd', '+150']].forEach(([key, color, label]) => {
            const gx = fit.x(f.guides[key].x), gy = fit.y(f.guides[key].y);
            line(ctx, kx, ky, gx, gy, color + '55', 1, [2, 4]);
            ctx.fillStyle = color; ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fill();
            text(ctx, label, gx + 7, gy + 3, color, '9px system-ui');
        });
        // kart
        ctx.save(); ctx.translate(kx, ky); ctx.rotate(f.car.heading);
        const s = fit.scale * 1.2;
        ctx.fillStyle = '#ffd166'; ctx.fillRect(-12 * s, -7 * s, 24 * s, 14 * s); ctx.strokeStyle = '#101a16'; ctx.lineWidth = 1.2; ctx.strokeRect(-12 * s, -7 * s, 24 * s, 14 * s);
        ctx.fillStyle = '#101a16'; ctx.fillRect(2 * s, -5 * s, 6 * s, 10 * s);
        line(ctx, 12 * s, 0, (12 + 16 * Math.cos(f.car.steering * 0.7)) * s, 16 * Math.sin(f.car.steering * 0.7) * s, '#ef6f61', 2.2);
        ctx.restore();
        // HUD
        ctx.fillStyle = 'rgba(16,26,22,.72)'; ctx.fillRect(10, 10, 220, 62);
        text(ctx, `${D.track.name} · ${f.seconds.toFixed(1)} s`, 20, 28, '#eef6f0', '800 12px system-ui');
        text(ctx, `speed ${Math.abs(f.car.speed).toFixed(0)} px/s · checkpoint ${f.car.checkpoints}/8`, 20, 46, TEXT, '11px system-ui');
        text(ctx, `lateral ${sgn(f.car.lateral)} · ${f.car.offTrack ? 'OFF THE ROAD' : 'on the road'}`, 20, 63, f.car.offTrack ? '#ffb4a8' : TEXT, '11px system-ui');
        ctx.fillStyle = 'rgba(16,26,22,.72)'; ctx.fillRect(670, 10, 220, 22 + D.events.length * 16);
        text(ctx, 'EVENTS', 680, 26, DIM, '800 9px system-ui');
        D.events.slice().reverse().forEach((e, i) => text(ctx, `${e.seconds.toFixed(1)} s  ${e.text}`, 680, 42 + i * 16, e.text.startsWith('crash') || e.text === 'contact' || e.text === 'left the asphalt' ? '#ffb4a8' : '#d8e985', '11px system-ui'));
        if (D.banner) { ctx.fillStyle = 'rgba(16,26,22,.85)'; ctx.fillRect(300, 170, 300, 60); text(ctx, D.banner, 450, 207, '#eef6f0', '800 15px system-ui', 'center'); }
        setStatus('driveStatusTag', D.running ? (f.car.offTrack ? 'Driving · off the road' : `Driving · ${(f.car.progress * 100).toFixed(0)}% of the lap`) : `Paused · ${(f.car.progress * 100).toFixed(0)}% of the lap` + (S.silenced.size ? ` · ${S.silenced.size} silenced` : ''), D.running ? (f.car.offTrack ? 'firing' : 'recovering') : '');
    }

    function drawBrainStrip() {
        paint(brainStrip);
        const ctx = brainStrip.ctx;
        if (!D.frame) return;
        const f = D.frame, lens = S.lens ? REWARDS.find(r => r.key === S.lens).sensors : [];
        text(ctx, 'SENSORS', 12, 16, TEXT, '800 11px system-ui');
        SENSORS.forEach((s, i) => {
            const y = 24 + i * 13.3, value = clamp(f.sensors[i], -1, 1);
            text(ctx, s.label, 132, y + 9, lens.includes(i) ? THREAD : '#9fb0a5', (lens.includes(i) ? '800 ' : '') + '10px system-ui', 'right');
            ctx.fillStyle = '#1b2a23'; ctx.fillRect(140, y + 1, 110, 10);
            ctx.fillStyle = GROUP_COLOR[s.group]; ctx.fillRect(value >= 0 ? 195 : 195 + value * 55, y + 1, Math.abs(value) * 55, 10);
            line(ctx, 195, y, 195, y + 12, '#456054');
            if (lens.includes(i)) { ctx.strokeStyle = THREAD; ctx.lineWidth = 1.2; ctx.strokeRect(139, y, 112, 12); }
        });
        // raster
        const rx0 = 300, rx1 = 640, ry0 = 24, rowH = 4.4, col = (rx1 - rx0) / 120;
        text(ctx, '48 NEURONS · last 4 s, grouped by role', rx0, 16, TEXT, '800 11px system-ui');
        const offset = 120 - D.raster.length;
        for (let p = 0; p < N; p++) { const n = S.order[p]; ctx.fillStyle = roleColor(n); ctx.globalAlpha = S.silenced.has(n) ? 0.25 : 1; ctx.fillRect(rx0 - 8, ry0 + p * rowH, 4, rowH - 0.6); ctx.globalAlpha = 1; }
        D.raster.forEach((spikes, t) => {
            for (let p = 0; p < N; p++) {
                const n = S.order[p]; if (!spikes[n]) continue;
                ctx.fillStyle = roleColor(n); ctx.globalAlpha = S.silenced.has(n) ? 0.25 : 1;
                ctx.fillRect(rx0 + (offset + t) * col, ry0 + p * rowH, Math.max(1.4, col - 0.5), rowH - 0.6); ctx.globalAlpha = 1;
            }
        });
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.strokeRect(rx0 - 0.5, ry0 + S.pos[S.selected] * rowH - 0.5, rx1 - rx0 + 1, rowH + 0.6);
        // controls
        const ox = 690;
        text(ctx, 'CONTROLS', ox, 16, TEXT, '800 11px system-ui');
        const cx = ox + 100, cy = 92, r = 54;
        ctx.strokeStyle = '#2e4a3d'; ctx.lineWidth = 9; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
        const steer = f.action.steer, angle = -Math.PI / 2 + clamp(steer, -1, 1) * (Math.PI * 0.42);
        line(ctx, cx, cy, cx + Math.cos(angle) * (r + 3), cy + Math.sin(angle) * (r + 3), '#eef6f0', 3);
        ctx.fillStyle = '#eef6f0'; ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2); ctx.fill();
        text(ctx, 'steer ' + sgn(steer), cx, cy + 24, '#eef6f0', '800 11px ui-monospace, monospace', 'center');
        const bar = (y, label, value, color) => { text(ctx, label, ox, y + 9, '#9fb0a5', '10px system-ui'); ctx.fillStyle = '#1b2a23'; ctx.fillRect(ox + 56, y, 130, 10); ctx.fillStyle = color; ctx.fillRect(ox + 56, y, 130 * clamp(value, 0, 1), 10); };
        bar(160, 'gas', f.action.throttle, '#d8e985'); bar(178, 'brake', f.action.brake, '#ef6f61'); bar(196, 'reverse', f.action.reverse || 0, '#c4b5fd');
        const spiking = f.spikes.reduce((s, v) => s + v, 0);
        bar(214, 'firing', spiking / N, '#67e8f9');
        text(ctx, `${spiking} of 48 neurons spiking`, ox, 242, DIM, '10px system-ui');
        const selRate = Math.round(S.rates[S.selected] * 100);
        text(ctx, `#${S.selected + 1}: ${selRate}%`, ox + 190, 242, DIM, '10px system-ui', 'right');
    }

    function rateOf(key) { const w = D.rewardWindow; if (!w.length) return 0; return w.reduce((s, r) => s + r[key], 0) / (w.length / 30); }
    const rewardRows = () => [...REWARDS.filter(r => r.kind === 'gain'), ...REWARDS.filter(r => r.kind === 'penalty')];
    let rewardHit = [];
    function drawRewards() {
        paint(rewardView);
        const ctx = rewardView.ctx;
        if (!D.frame) { text(ctx, 'Reward terms appear here while the kart drives.', 450, 190, DIM, '14px system-ui', 'center'); return; }
        const rows = rewardRows(), ry0 = 34, rowH = 17.6, zero = 292;
        text(ctx, 'REWARD TERMS · points per second over the last second (total so far on the right)', 12, 18, TEXT, '800 11px system-ui');
        rewardHit = [];
        rows.forEach((r, i) => {
            const y = ry0 + i * rowH, rate = rateOf(r.key), total = D.frame.totals[r.key];
            const selected = S.lens === r.key;
            if (selected) { ctx.fillStyle = 'rgba(239,111,97,.14)'; ctx.fillRect(6, y - 1, 500, rowH); }
            const isPen = r.kind === 'penalty';
            text(ctx, r.label, 148, y + 12, selected ? '#ffb4a8' : (isPen ? '#e4b0a8' : '#c6dcae'), (selected ? '800 ' : '') + '11px system-ui', 'right');
            const len = Math.sqrt(Math.min(Math.abs(rate), 60) / 60) * 130;
            ctx.fillStyle = '#1b2a23'; ctx.fillRect(zero - 130, y + 3, 260, 10);
            ctx.fillStyle = isPen ? '#d8574a' : '#7fbf6a';
            if (isPen) ctx.fillRect(zero - len, y + 3, len, 10); else ctx.fillRect(zero, y + 3, len, 10);
            line(ctx, zero, y + 1, zero, y + 15, '#5c7a6a');
            if (Math.abs(rate) >= 60) text(ctx, isPen ? '◀' : '▶', isPen ? zero - 133 : zero + 133, y + 12, '#fff', '9px system-ui', isPen ? 'right' : 'left');
            text(ctx, (isPen ? '−' : '+') + Math.abs(rate).toFixed(1), zero + 174, y + 12, Math.abs(rate) < 0.05 ? DIM : '#eef6f0', '700 10px ui-monospace, monospace', 'right');
            text(ctx, total.toFixed(0), 505, y + 12, DIM, '10px ui-monospace, monospace', 'right');
            rewardHit.push({ key: r.key, y0: y - 1, y1: y + rowH - 1 });
        });
        text(ctx, '◀ penalties', zero - 130, ry0 + rows.length * rowH + 14, '#d8574a', '700 10px system-ui'); text(ctx, 'gains ▶', zero + 130, ry0 + rows.length * rowH + 14, '#7fbf6a', '700 10px system-ui', 'right');
        text(ctx, 'bar length is a square-root scale up to 60 points/s', 12, ry0 + rows.length * rowH + 14, DIM, '10px system-ui');
        // history
        const gx0 = 548, gx1 = 888, gy0 = 44, gy1 = 300, gmid = 172, unit = 128 / 24;
        text(ctx, 'STEADY GAINS AND PENALTIES · last 20 s', gx0, 18, TEXT, '800 11px system-ui');
        ctx.strokeStyle = GRID; ctx.strokeRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
        line(ctx, gx0, gmid, gx1, gmid, '#456054');
        [12, 24].forEach(v => { line(ctx, gx0, gmid - v * unit, gx1, gmid - v * unit, '#1d2f27'); line(ctx, gx0, gmid + v * unit, gx1, gmid + v * unit, '#1d2f27'); });
        [12, 24].forEach(v => { text(ctx, '+' + v, gx0 + 3, gmid - v * unit + 11, DIM, '9px system-ui'); text(ctx, '−' + v, gx0 + 3, gmid + v * unit - 3, DIM, '9px system-ui'); });
        const n = D.series.length, step = (gx1 - gx0) / 600, x0 = gx1 - n * step;
        const smooth = (arr, key, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 6); k <= i; k++) { s += arr[k][key]; c++; } return s / c; };
        [['gain', '#7fbf6a', 1], ['pen', '#d8574a', -1]].forEach(([key, color, dir]) => {
            ctx.fillStyle = color + 'aa'; ctx.beginPath(); ctx.moveTo(x0, gmid);
            D.series.forEach((p, i) => { ctx.lineTo(x0 + i * step, gmid - dir * clamp(smooth(D.series, key, i), 0, 24) * unit); });
            ctx.lineTo(x0 + (n - 1) * step, gmid); ctx.closePath(); ctx.fill();
        });
        D.series.forEach((p, i) => { if (p.checkpoint) line(ctx, x0 + i * step, gy0, x0 + i * step, gy1, '#d8e985', 1, [2, 3]); if (p.contact) line(ctx, x0 + i * step, gy0, x0 + i * step, gy1, '#ffb4a8', 1.5); });
        text(ctx, 'dotted gold = checkpoint · red line = contact', gx0, gy1 + 16, DIM, '10px system-ui');
        const tot = D.frame.totals;
        text(ctx, `SCORE ${tot.total.toFixed(0)}`, gx0, gy1 + 44, '#eef6f0', '800 16px system-ui');
        const bestGain = REWARDS.filter(r => r.kind === 'gain').sort((a, b) => tot[b.key] - tot[a.key])[0];
        const worstPen = REWARDS.filter(r => r.kind === 'penalty').sort((a, b) => tot[b.key] - tot[a.key])[0];
        text(ctx, `biggest gain: ${bestGain.label} (+${tot[bestGain.key].toFixed(0)})   ·   biggest cost: ${worstPen.label} (−${tot[worstPen.key].toFixed(0)})`, gx0, gy1 + 64, TEXT, '10px system-ui');
    }
    $('rewardCanvas').addEventListener('click', event => {
        const p = pointer(event, rewardView.canvas);
        if (p.x > 520) return;
        const hit = rewardHit.find(h => p.y >= h.y0 && p.y < h.y1);
        if (hit) setLens(hit.key);
    });

    function drawDriveAll() { drawTrackView(); drawBrainStrip(); drawRewards(); }
    function updateDriveReadouts() {
        if (!D.frame) return;
        const f = D.frame;
        $('driveProgressReadout').textContent = Math.round(f.car.progress * 100) + '%';
        $('driveScoreReadout').textContent = f.totals.total.toFixed(0);
        $('driveLateralReadout').textContent = sgn(f.car.lateral);
        const d = f.car.nearestOpponent;
        $('driveNearReadout').textContent = Number.isFinite(d) && d < 400 ? Math.round(d) + ' px' : 'none near';
    }

    ['driveTrack', 'driveRivals', 'driveObjects', 'driveWalls'].forEach(id => $(id).addEventListener('change', () => { const was = D.running; pauseDrive(); makeSession(); if (was) playDrive(); }));
    $('drivePlayBtn').addEventListener('click', () => { if (D.running) pauseDrive(); else playDrive(); });
    $('driveRestartBtn').addEventListener('click', () => { const was = D.running; pauseDrive(); makeSession(); if (was) playDrive(); });
    root.querySelectorAll('.drive-pokes [data-poke]').forEach(button => button.addEventListener('click', () => {
        if (!D.session) return;
        const s = D.session, kind = button.dataset.poke;
        if (kind === 'edge-left') s.placeAcrossRoad(-0.8); else if (kind === 'edge-right') s.placeAcrossRoad(0.8); else if (kind === 'centre') s.placeAcrossRoad(0);
        else if (kind === 'aim-left') s.aimRelativeToRoad(-30); else if (kind === 'aim-right') s.aimRelativeToRoad(30); else if (kind === 'backwards') s.aimRelativeToRoad(180);
        else if (kind === 'stop') s.setSpeed(0);
        else if (kind === 'cone') s.dropObject('cone', 150, 0); else if (kind === 'car') s.dropObject('stalled-car', 150, 0); else if (kind === 'oil') s.dropObject('oil', 130, 0); else if (kind === 'clear') s.clearObjects();
        D.events.push({ text: 'poke: ' + button.textContent.toLowerCase(), seconds: D.frame ? D.frame.seconds : 0 }); if (D.events.length > 4) D.events.shift();
        if (!D.running) { D.frame = D.session.step(); }
        drawDriveAll(); updateDriveReadouts();
    }));

    /* -------------------------------------------------------------- */
    /* 9.8 Lesions                                                     */
    /* -------------------------------------------------------------- */

    function toggleSilence(ids) {
        const allOn = ids.every(id => S.silenced.has(id));
        ids.forEach(id => { if (allOn) S.silenced.delete(id); else S.silenced.add(id); });
        emit('lesion');
    }
    function renderLesionPanel() {
        const a = S.analysis, box = $('lesionRoles');
        if (!a) { box.innerHTML = ''; return; }
        box.innerHTML = ROLE_ORDER.filter(role => a.roleCounts[role] > 0).map(role => {
            const ids = a.neurons.filter(n => n.role === role).map(n => n.index), on = ids.every(id => S.silenced.has(id));
            return `<button type="button" class="${on ? 'active' : ''}" data-role="${role}" style="--c:${ROLE[role].color}"><i></i>${ROLE[role].label} <b>${ids.length}</b></button>`;
        }).join('');
        box.querySelectorAll('button').forEach(button => button.addEventListener('click', () => toggleSilence(a.neurons.filter(n => n.role === button.dataset.role).map(n => n.index))));
        const roleCount = ROLE_ORDER.filter(role => a.neurons.filter(n => n.role === role).some(n => S.silenced.has(n.index))).map(role => ROLE[role].label.toLowerCase());
        $('lesionStatus').textContent = S.silenced.size ? `${S.silenced.size} silenced (${roleCount.join(', ')})` : 'No neurons silenced';
    }
    $('lesionSelectedBtn').addEventListener('click', () => { if (S.file) toggleSilence([S.selected]); });
    $('lesionRandomBtn').addEventListener('click', () => {
        if (!S.file) return;
        const pool = [...Array(N).keys()].filter(j => !S.silenced.has(j));
        for (let k = 0; k < 8 && pool.length; k++) S.silenced.add(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        emit('lesion');
    });
    $('lesionRestoreBtn').addEventListener('click', () => { S.silenced.clear(); emit('lesion'); });

    /* -------------------------------------------------------------- */
    /* Wiring                                                          */
    /* -------------------------------------------------------------- */

    hooks.push(reason => {
        if (reason === 'brain') {
            renderGlance(); renderBlocksDiagram(); renderBlockFacts(); renderLegends();
            rebuildProbe(); applyPresetSilently(); makeSession(); renderRewardMap(); renderLens();
        }
        if (reason === 'brain' || reason === 'lesion') {
            if (reason === 'lesion') { rebuildProbe(); if (D.session) D.session.setSnapshot(inUseSnapshot()); }
            renderFingerprint(); scheduleCurves(0); renderLesionPanel();
        }
        if (reason === 'order') { rebuildProbe(); }
        drawAtlas(); renderNeuronCard(); drawRoles(); drawProbe();
        if (D.frame) drawDriveAll();
        syncSliders();
    });
    function applyPresetSilently() { S.presetIndex = 0; S.sensors = [...PRESETS[0].values]; syncSliders(); }

    buildSliders(); syncSliders(); renderRewardMap(); renderLens(); renderBlocksDiagram(); renderLegends();
    drawAtlas(); drawRoles(); drawProbe(); drawCurves(); drawDriveAll();
    if (reduceMotion) $('probePauseToggle').checked = true;
    let sampleRequested = false;
    const loadSampleOnce = () => { if (sampleRequested || S.file) return; sampleRequested = true; loadSample(); };
    whenNear(root, loadSampleOnce);
    setTimeout(loadSampleOnce, 3000);
})();
