// Moving ions: a particle picture of a membrane patch, used by Lab 1.2 (spike scrubber) and Lab 2.3 (Hodgkin–Huxley with ions).
// Relies on crispCanvas() from the page's inline script.
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const COL = { Na: '#67e8f9', K: '#fbbf24', Cl: '#86efac', A: '#a9a3c8', text: '#b8c8be', dim: '#6f8a7c', grid: '#2e4a3d', bg: '#101a16', out: '#16262f', inn: '#1b2a22', mem: '#8ca397' };
    const IONS_PER_DOT = 5000;           // one drawn ion stands for this many real ions crossing 1 µm² of membrane
    const IONS_PER_UA_MS = 62.4;         // ions per (µA/cm² · ms) through 1 µm²: 1e-9 C/cm² · 1e-8 cm²/µm² / 1.602e-19 C
    const seeded = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

    /* ------------------------------------------------------------------
       The membrane patch: bath ions diffusing, gated channels, ions in transit, a pump, and the charge layers.
       ------------------------------------------------------------------ */
    class MembraneScene {
        constructor(rect, options) {
            this.r = rect;
            this.o = Object.assign({ nav: 4, kv: 4, gates: true, pump: true, chScale: 1, ionScale: 1, counts: { Na: 30, K: 30, Cl: 34, A: 30, NaIn: 3, KOut: 3 } }, options);
            this.random = seeded(options.seed || 7);
            this.yMem = rect.y + rect.h * 0.5;
            this.band = 13;
            this.channels = [];
            const n = this.o.nav + this.o.kv;   // equal numbers of each kind
            const spacing = (rect.w - (this.o.pump ? 90 : 20)) / n;
            for (let i = 0; i < n; i += 1) {
                const kind = i % 2 === 0 ? 'Na' : 'K';   // alternate so both kinds are always in view
                this.channels.push({ kind, x: rect.x + 30 + i * spacing + spacing / 2 - 10, open: false, gates: kind === 'Na' ? [1, 1, 1] : [1, 1, 1, 1], ball: false, u: this.random(), blocked: false, flash: 0 });
            }
            this.pump = this.o.pump ? { x: rect.x + rect.w - 48, phase: 0, on: true } : null;
            this.bath = []; this.transit = [];
            this.debt = { Na: 0, K: 0 };
            this.counted = { Na: 0, K: 0 };
            this.potential = -70;
            this.last = 0;
            this.fillBath();
        }

        side(y) { return y < this.yMem ? 'out' : 'in'; }
        region(side) { const r = this.r; return side === 'out' ? { y0: r.y + 20, y1: this.yMem - this.band - 15 } : { y0: this.yMem + this.band + 15, y1: r.y + r.h - 18 }; }
        place(kind, side, x) {
            const reg = this.region(side); const r = this.r;
            return { kind, side, x: x === undefined ? r.x + 8 + this.random() * (r.w - 16) : x, y: reg.y0 + this.random() * (reg.y1 - reg.y0), vx: (this.random() - 0.5) * 1.5, vy: (this.random() - 0.5) * 1.5 };
        }
        fillBath() {
            const c = this.o.counts; this.bath = [];
            const add = (kind, side, n) => { for (let i = 0; i < n; i += 1) this.bath.push(this.place(kind, side)); };
            add('Na', 'out', c.Na); add('Cl', 'out', c.Cl); add('K', 'out', c.KOut);
            add('K', 'in', c.K); add('A', 'in', c.A); add('Na', 'in', c.NaIn);
        }
        /** Change how many K⁺ ions sit outside (and keep the total, as the bath is large). */
        setOutsideK(count) {
            const current = this.bath.filter(p => p.kind === 'K' && p.side === 'out');
            while (current.length < count) { const p = this.place('K', 'out'); this.bath.push(p); current.push(p); }
            while (current.length > count) { const p = current.pop(); this.bath.splice(this.bath.indexOf(p), 1); }
        }
        reset() { this.transit = []; this.debt = { Na: 0, K: 0 }; this.counted = { Na: 0, K: 0 }; }

        /** Positive count = outward (cytosol → outside), negative = inward, in drawn ions. */
        addFlux(kind, dots) { this.debt[kind] = clamp(this.debt[kind] + dots, -8, 8); }

        mouth(channel, side) { return { x: channel.x, y: side === 'out' ? this.yMem - this.band - 2 : this.yMem + this.band + 2 }; }

        startTransit(kind, channel, inward, viaPump) {
            const fromSide = inward ? 'out' : 'in'; const toSide = inward ? 'in' : 'out';
            const m = this.mouth(channel, fromSide);
            let best = -1, bestD = 1e9;
            this.bath.forEach((p, i) => { if (p.kind !== kind || p.side !== fromSide) return; const d = Math.hypot(p.x - m.x, p.y - m.y); if (d < bestD) { bestD = d; best = i; } });
            let start;
            if (best >= 0) { start = { x: this.bath[best].x, y: this.bath[best].y }; this.bath.splice(best, 1); }
            else { const q = this.place(kind, fromSide, m.x + (this.random() - 0.5) * 30); start = { x: q.x, y: q.y }; }
            const exit = this.place(kind, toSide, channel.x + (this.random() - 0.5) * 40);
            this.transit.push({ kind, channel, inward, t: 0, start, m1: m, m2: this.mouth(channel, toSide), end: { x: exit.x, y: exit.y }, toSide, viaPump: !!viaPump });
        }

        arrive(tr) {
            const p = this.place(tr.kind, tr.toSide, tr.end.x); p.x = tr.end.x; p.y = tr.end.y; this.bath.push(p);
            // the baths are large: keep their density by returning one ion of that kind from the destination to the origin side
            const candidates = this.bath.filter(q => q !== p && q.kind === tr.kind && q.side === tr.toSide);
            if (candidates.length > 0) { const q = candidates[Math.floor(this.random() * candidates.length)]; const home = this.place(tr.kind, tr.inward ? 'out' : 'in'); q.x = home.x; q.y = home.y; q.side = home.side; }
        }

        update(dt, voltage) {
            this.potential = voltage;
            const step = clamp(dt * 60, 0.2, 3);
            const r = this.r;
            // diffusion
            for (const p of this.bath) {
                p.vx = (p.vx + (this.random() - 0.5) * 0.55 * step) * 0.94; p.vy = (p.vy + (this.random() - 0.5) * 0.55 * step) * 0.94;
                p.x += p.vx * step; p.y += p.vy * step;
                const reg = this.region(p.side);
                if (p.x < r.x + 6) { p.x = r.x + 6; p.vx = Math.abs(p.vx); } if (p.x > r.x + r.w - 6) { p.x = r.x + r.w - 6; p.vx = -Math.abs(p.vx); }
                if (p.y < reg.y0) { p.y = reg.y0; p.vy = Math.abs(p.vy); } if (p.y > reg.y1) { p.y = reg.y1; p.vy = -Math.abs(p.vy); }
            }
            // ions waiting to cross pass through channels that are open right now
            for (const kind of ['Na', 'K']) {
                while (Math.abs(this.debt[kind]) >= 1) {
                    const open = this.channels.filter(c => c.kind === kind && c.open && !c.blocked);
                    if (open.length === 0) break;
                    const inward = this.debt[kind] < 0;
                    const channel = open[Math.floor(this.random() * open.length)];
                    this.startTransit(kind, channel, inward);
                    this.debt[kind] += inward ? 1 : -1; this.counted[kind] += inward ? -1 : 1;
                }
            }
            // pump: three Na⁺ out and two K⁺ in per cycle
            if (this.pump && this.pump.on) {
                this.pump.phase += dt / 2.2;
                if (this.pump.phase >= 1) {
                    this.pump.phase -= 1;
                    for (let i = 0; i < 3; i += 1) this.startTransit('Na', this.pump, false, true);
                    for (let i = 0; i < 2; i += 1) this.startTransit('K', this.pump, true, true);
                }
            }
            for (let i = this.transit.length - 1; i >= 0; i -= 1) {
                const tr = this.transit[i]; tr.t += dt / (tr.viaPump ? 1.5 : 0.85);
                if (tr.t >= 1) { this.arrive(tr); this.transit.splice(i, 1); }
            }
            for (const c of this.channels) { if (c.flash > 0) c.flash = Math.max(0, c.flash - dt * 3); }
        }

        transitPosition(tr) {
            const a = tr.t; const lerp = (p, q, f) => ({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f });
            if (a < 0.38) return lerp(tr.start, tr.m1, a / 0.38);
            if (a < 0.62) return lerp(tr.m1, tr.m2, (a - 0.38) / 0.24);
            return lerp(tr.m2, tr.end, (a - 0.62) / 0.38);
        }

        drawIon(ctx, kind, x, y, scale = 1) {
            scale *= this.o.ionScale;
            const radius = (kind === 'A' ? 7 : 5.4) * scale;
            ctx.fillStyle = COL[kind]; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#0d1512'; ctx.font = `800 ${Math.round(9 * scale)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(kind === 'Cl' || kind === 'A' ? '−' : '+', x, y + 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        }

        draw(ctx, options = {}) {
            const r = this.r; const yM = this.yMem; const b = this.band;
            // compartments
            ctx.fillStyle = COL.out; ctx.fillRect(r.x, r.y, r.w, yM - b - r.y);
            ctx.fillStyle = COL.inn; ctx.fillRect(r.x, yM + b, r.w, r.y + r.h - yM - b);
            // charge layers: the voltage is just charge piled up on either face of the membrane
            const v = this.potential; const n = Math.round(clamp(Math.abs(v) / 75, 0.04, 1.3) * 22);
            const outsidePositive = v < 0;
            const span = r.w - 20;
            for (let i = 0; i < n; i += 1) {
                const x = r.x + 10 + (i + 0.5) * span / n;
                ctx.font = '800 11px system-ui'; ctx.textAlign = 'center';
                ctx.fillStyle = outsidePositive ? '#fca5a5' : '#93c5fd'; ctx.fillText(outsidePositive ? '+' : '−', x, yM - b - 1);
                ctx.fillStyle = outsidePositive ? '#93c5fd' : '#fca5a5'; ctx.fillText(outsidePositive ? '−' : '+', x, yM + b + 9);
            }
            ctx.textAlign = 'left';
            // membrane lipid band with channel gaps
            ctx.fillStyle = '#2d4a3e'; ctx.fillRect(r.x, yM - b, r.w, 2 * b);
            ctx.strokeStyle = COL.mem; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(r.x, yM - b + 1); ctx.lineTo(r.x + r.w, yM - b + 1); ctx.moveTo(r.x, yM + b - 1); ctx.lineTo(r.x + r.w, yM + b - 1); ctx.stroke();
            for (const c of this.channels) this.drawChannel(ctx, c, options);
            if (this.pump) this.drawPump(ctx);
            for (const p of this.bath) this.drawIon(ctx, p.kind, p.x, p.y);
            for (const tr of this.transit) { const pos = this.transitPosition(tr); ctx.shadowColor = COL[tr.kind]; ctx.shadowBlur = 10; this.drawIon(ctx, tr.kind, pos.x, pos.y, 1.15); ctx.shadowBlur = 0; }
            ctx.font = '700 11px system-ui'; ctx.fillStyle = COL.text; ctx.fillText('OUTSIDE', r.x + 8, r.y + 12); ctx.fillText('CYTOSOL', r.x + 8, r.y + r.h - 6);
        }

        drawChannel(ctx, c, options) {
            const yM = this.yMem; const b = this.band; const x = c.x;
            const body = c.kind === 'Na' ? '#2b6f86' : '#8a6a1c'; const edge = c.kind === 'Na' ? '#67e8f9' : '#fbbf24';
            const pore = 5 * this.o.chScale;
            ctx.fillStyle = body; ctx.strokeStyle = edge; ctx.lineWidth = 1.5;
            for (const side of [-1, 1]) {
                ctx.beginPath(); ctx.roundRect(side < 0 ? x - pore - 11 * this.o.chScale : x + pore, yM - b - 4, 11 * this.o.chScale, 2 * b + 8, 3); ctx.fill(); ctx.stroke();
            }
            if (c.blocked) { ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(x, yM - b - 7, 6.5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = '800 7px system-ui'; ctx.textAlign = 'center'; ctx.fillText(c.kind === 'Na' ? 'TTX' : 'TEA', x, yM - b - 5); ctx.textAlign = 'left'; return; }
            if (options.glow !== false && c.open) { ctx.fillStyle = c.kind === 'Na' ? 'rgba(103,232,249,.28)' : 'rgba(251,191,36,.28)'; ctx.fillRect(x - pore, yM - b - 2, 2 * pore, 2 * b + 4); }
            if (this.o.gates) {
                // activation gates (m³ or n⁴): bars across the outer mouth; an open gate slides to the wall
                const g = c.gates; const gap = (b - 2) / g.length;
                g.forEach((open, k) => {
                    const y = yM - b + 1 + k * gap; const w = open ? 1.8 : 2 * pore;
                    ctx.fillStyle = open ? '#6ee7b7' : '#f87171'; ctx.fillRect(x - pore, y, w, 2.4);
                });
                if (c.kind === 'Na') {
                    // inactivation ball: swings into the pore from the cytosolic side and plugs it
                    const bx = c.ball ? x : x + 14, by = yM + b + (c.ball ? -1 : 8);
                    ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x + 12, yM + b + 11); ctx.quadraticCurveTo(x + 15, yM + b + 2, bx, by); ctx.stroke();
                    ctx.fillStyle = c.ball ? '#f87171' : '#a78bfa'; ctx.beginPath(); ctx.arc(bx, by, 4.2, 0, Math.PI * 2); ctx.fill();
                }
            } else if (!c.open) {
                ctx.fillStyle = '#f87171'; ctx.fillRect(x - pore, yM - 2, 2 * pore, 4);
            }
        }

        drawPump(ctx) {
            const p = this.pump; const yM = this.yMem; const b = this.band; const x = p.x;
            const t = p.phase;
            ctx.fillStyle = p.on ? '#5b4a8f' : '#3b3a46'; ctx.strokeStyle = p.on ? '#c4b5fd' : '#6b7280'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.roundRect(x - 20, yM - b - 5, 40, 2 * b + 10, 8); ctx.fill(); ctx.stroke();
            ctx.fillStyle = p.on ? '#ede9fe' : '#9ca3af'; ctx.font = '800 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Na⁺/K⁺', x, yM - 1); ctx.fillText('pump', x, yM + 9);
            if (p.on) { ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + 29, yM, 6, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke(); }
            ctx.textAlign = 'left';
        }
    }

    /* ------------------------------------------------------------------
       Shared visual-visibility loop
       ------------------------------------------------------------------ */
    function whileVisible(element, frame) {
        let visible = !('IntersectionObserver' in window); let running = false; let last = 0;
        const tick = now => {
            if (!visible) { running = false; return; }
            const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now;
            frame(dt);
            requestAnimationFrame(tick);
        };
        const start = () => { if (!running) { running = true; last = 0; requestAnimationFrame(tick); } };
        if ('IntersectionObserver' in window) new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); if (visible) start(); }, { threshold: 0.02 }).observe(element);
        else start();
    }

    /* ------------------------------------------------------------------
       Lab 1.2 · moving ions in the spike scrubber's membrane panel
       ------------------------------------------------------------------ */
    (function lab12() {
        const canvas = $('ionTransportCanvas');
        if (!canvas) return;
        const rect = { x: 452, y: 8, w: 436, h: 206 };
        const scene = new MembraneScene(rect, { nav: 3, kv: 3, gates: false, pump: false, seed: 3, chScale: 1.5, ionScale: 1.25, counts: { Na: 22, K: 22, Cl: 24, A: 20, NaIn: 2, KOut: 2 } });
        const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
        let lastTime = 0;
        // called from the lab's own draw routine
        window.IonFlow = {
            draw(ctx, phase, naScale, kScale, voltage) {
                const now = performance.now(); const dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016; lastTime = now;
                const pNa = smooth(0.12, 0.22, phase) * (1 - smooth(0.34, 0.44, phase));
                const pK = smooth(0.35, 0.46, phase) * (1 - smooth(0.74, 0.88, phase));
                const openNa = clamp(pNa * (0.55 + 0.45 * naScale), 0, 0.97), openK = clamp(pK * (0.55 + 0.45 * kScale), 0, 0.97);
                for (const c of scene.channels) {
                    c.u = clamp(c.u + (scene.random() - 0.5) * 0.9 * Math.sqrt(dt * 6), 0, 1);
                    c.open = c.u < (c.kind === 'Na' ? openNa : openK);
                }
                scene.addFlux('Na', -(openNa * 9 * naScale) * dt);
                scene.addFlux('K', (openK * 8 * kScale) * dt);
                scene.update(dt, voltage);
                scene.draw(ctx);
                ctx.font = '700 11px system-ui'; ctx.fillStyle = COL.Na; ctx.fillText('● Na⁺', rect.x + rect.w - 140, rect.y + 12);
                ctx.fillStyle = COL.K; ctx.fillText('● K⁺', rect.x + rect.w - 82, rect.y + 12);
                ctx.fillStyle = COL.Cl; ctx.fillText('● Cl⁻', rect.x + rect.w - 46, rect.y + 12);
                ctx.fillStyle = COL.text; ctx.fillText(`open Na⁺ channels ${scene.channels.filter(c => c.kind === 'Na' && c.open).length}/${scene.channels.filter(c => c.kind === 'Na').length}  ·  K⁺ ${scene.channels.filter(c => c.kind === 'K' && c.open).length}/${scene.channels.filter(c => c.kind === 'K').length}`, rect.x + 86, rect.y + rect.h - 6);
            },
        };
        // keep the picture alive while the spike phase is parked on a point
        whileVisible(canvas, () => { if (typeof window.drawIonTransportFrame === 'function') window.drawIonTransportFrame(); });
    })();

    /* ------------------------------------------------------------------
       Lab 2.3 · Hodgkin–Huxley with the ions drawn
       ------------------------------------------------------------------ */
    (function lab23() {
        const sceneCanvas = $('ionChannelCanvas'); const traceCanvas = $('ionChannelTraces');
        if (!sceneCanvas || !traceCanvas) return;
        const sctx = crispCanvas(sceneCanvas); const tctx = crispCanvas(traceCanvas);
        const W = 900, SH = 360, TH = 300;
        const ampIn = $('icAmp'), koIn = $('icKo'), speedIn = $('icSpeed');
        const ttx = $('icTtx'), tea = $('icTea'), pumpToggle = $('icPump'), trainToggle = $('icTrain');
        const E_NA = 50, E_L = -54.387, G_NA = 120, G_K = 36, G_L = 0.3, KI = 140, KO0 = 6.6;
        const eK = ko => 58.2 * Math.log10(ko / KI);

        const scene = new MembraneScene({ x: 10, y: 12, w: 880, h: 336 }, { nav: 5, kv: 5, gates: true, pump: true, seed: 11, counts: { Na: 34, K: 34, Cl: 40, A: 34, NaIn: 4, KOut: 3 } });
        const state = { V: -65, m: 0.05, h: 0.6, n: 0.32, t: 0, pulseEnd: -1, nextTrain: 0, ions: { Na: 0, K: 0 }, spikeIons: { Na: 0, K: 0 }, lastINa: 0, lastIK: 0 };
        const history = { t: [], V: [], m: [], h: [], n: [], INa: [], IK: [] };
        const WINDOW = 32;                       // ms of trace shown
        let ko = KO0;

        const rates = V => ({
            am: Math.abs(V + 40) < 1e-7 ? 1 : 0.1 * (V + 40) / (1 - Math.exp(-(V + 40) / 10)), bm: 4 * Math.exp(-(V + 65) / 18),
            ah: 0.07 * Math.exp(-(V + 65) / 20), bh: 1 / (1 + Math.exp(-(V + 35) / 10)),
            an: Math.abs(V + 55) < 1e-7 ? 0.1 : 0.01 * (V + 55) / (1 - Math.exp(-(V + 55) / 10)), bn: 0.125 * Math.exp(-(V + 65) / 80),
        });
        function settle() {
            // relax to this potassium level's resting state without drawing it
            let { V, m, h, n } = state; const EK = eK(ko);
            for (let i = 0; i < 40000; i += 1) {
                const q = rates(V);
                m += 0.01 * (q.am * (1 - m) - q.bm * m); h += 0.01 * (q.ah * (1 - h) - q.bh * h); n += 0.01 * (q.an * (1 - n) - q.bn * n);
                const gNa = ttx.checked ? 0 : G_NA, gK = tea.checked ? 0 : G_K;
                V += 0.01 * (-(gNa * m ** 3 * h * (V - E_NA) + gK * n ** 4 * (V - EK) + G_L * (V - E_L)));
            }
            Object.assign(state, { V, m, h, n });
            initGates();
        }
        function initGates() {
            // start every gate in its steady-state odds, not all open
            for (const c of scene.channels) {
                if (c.kind === 'Na') { c.gates = c.gates.map(() => (Math.random() < state.m ? 1 : 0)); c.ball = Math.random() > state.h; }
                else c.gates = c.gates.map(() => (Math.random() < state.n ? 1 : 0));
            }
        }
        function clearHistory() { for (const k of Object.keys(history)) history[k].length = 0; state.t = 0; state.pulseEnd = -1; state.nextTrain = 6; state.ions = { Na: 0, K: 0 }; state.spikeIons = { Na: 0, K: 0 }; scene.reset(); }
        function integrate(simDt) {
            const steps = Math.min(600, Math.max(1, Math.round(simDt / 0.01))); const dt = simDt / steps; const EK = eK(ko);
            const amp = Number(ampIn.value);
            for (let i = 0; i < steps; i += 1) {
                if (trainToggle.checked && state.t >= state.nextTrain) { state.pulseEnd = state.t + 1; state.nextTrain += 14; }
                const I = state.t < state.pulseEnd ? amp : 0;
                const q = rates(state.V);
                state.m += dt * (q.am * (1 - state.m) - q.bm * state.m); state.h += dt * (q.ah * (1 - state.h) - q.bh * state.h); state.n += dt * (q.an * (1 - state.n) - q.bn * state.n);
                const gNa = ttx.checked ? 0 : G_NA, gK = tea.checked ? 0 : G_K;
                const INa = gNa * state.m ** 3 * state.h * (state.V - E_NA), IK = gK * state.n ** 4 * (state.V - EK), IL = G_L * (state.V - E_L);
                state.V += dt * (I - INa - IK - IL);
                state.t += dt; state.lastINa = INa; state.lastIK = IK;
                // current → ions: positive current carries positive charge outward
                const dNa = INa * dt * IONS_PER_UA_MS, dK = IK * dt * IONS_PER_UA_MS;
                state.ions.Na += -dNa; state.ions.K += dK; if (INa < 0) state.spikeIons.Na += -dNa; if (IK > 0) state.spikeIons.K += dK;
                scene.addFlux('Na', dNa / IONS_PER_DOT); scene.addFlux('K', dK / IONS_PER_DOT);
                if (Math.round(state.t / 0.05) !== Math.round((state.t - dt) / 0.05)) {
                    history.t.push(state.t); history.V.push(state.V); history.m.push(state.m); history.h.push(state.h); history.n.push(state.n); history.INa.push(INa); history.IK.push(IK);
                    if (history.t.length > WINDOW / 0.05 + 40) for (const k of Object.keys(history)) history[k].shift();
                }
            }
        }
        /* gates of each drawn channel flicker as independent two-state switches that follow the same rate equations */
        function flickerGates(simDt) {
            const q = rates(state.V);
            const flip = (open, alpha, beta) => { const rate = open ? beta : alpha; return Math.random() < 1 - Math.exp(-rate * simDt) ? !open : open; };
            for (const c of scene.channels) {
                c.blocked = c.kind === 'Na' ? ttx.checked : tea.checked;
                if (c.kind === 'Na') {
                    c.gates = c.gates.map(g => (flip(!!g, q.am, q.bm) ? 1 : 0)); c.ball = !flip(!c.ball, q.ah, q.bh);
                    c.open = !c.blocked && c.gates.every(Boolean) && !c.ball;
                } else {
                    c.gates = c.gates.map(g => (flip(!!g, q.an, q.bn) ? 1 : 0));
                    c.open = !c.blocked && c.gates.every(Boolean);
                }
            }
        }

        function drawTraces() {
            const ctx = tctx; ctx.clearRect(0, 0, W, TH); ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, TH);
            const x0 = 64, x1 = W - 16; const tEnd = Math.max(state.t, WINDOW); const tStart = tEnd - WINDOW;
            const X = t => x0 + (t - tStart) / WINDOW * (x1 - x0);
            const panels = [{ y: 22, h: 108, label: 'membrane voltage (mV)' }, { y: 150, h: 58, label: 'gates: m (Na⁺ activate) · h (Na⁺ unblock) · n (K⁺ activate)' }, { y: 228, h: 62, label: 'ion currents (µA/cm²): Na⁺ inward ▼ · K⁺ outward ▲' }];
            ctx.font = '11px system-ui';
            for (const p of panels) { ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.strokeRect(x0, p.y, x1 - x0, p.h); ctx.fillStyle = COL.text; ctx.fillText(p.label, x0, p.y - 6); }
            const line = (arr, y, h, lo, hi, color, width = 2) => {
                ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); let started = false;
                for (let i = 0; i < history.t.length; i += 1) { const x = X(history.t[i]); if (x < x0) continue; const yy = y + h - (clamp(arr[i], lo, hi) - lo) / (hi - lo) * h; if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy); }
                ctx.stroke();
            };
            const p0 = panels[0];
            const vy = v => p0.y + p0.h - (v + 90) / 150 * p0.h;
            ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
            ctx.strokeStyle = COL.Na; ctx.beginPath(); ctx.moveTo(x0, vy(E_NA)); ctx.lineTo(x1, vy(E_NA)); ctx.stroke(); ctx.fillStyle = COL.Na; ctx.fillText(`E_Na ${E_NA} mV`, x1 - 74, vy(E_NA) - 3);
            ctx.strokeStyle = COL.K; ctx.beginPath(); ctx.moveTo(x0, vy(eK(ko))); ctx.lineTo(x1, vy(eK(ko))); ctx.stroke(); ctx.fillStyle = COL.K; ctx.fillText(`E_K ${eK(ko).toFixed(0)} mV`, x1 - 74, vy(eK(ko)) + 12);
            ctx.setLineDash([]);
            for (const v of [-80, -40, 0, 40]) { ctx.fillStyle = COL.dim; ctx.fillText(String(v), 30, vy(v) + 4); }
            line(history.V, p0.y, p0.h, -90, 60, '#e6f4ea', 2.2);
            const p1 = panels[1]; line(history.m, p1.y, p1.h, 0, 1, COL.Na); line(history.h, p1.y, p1.h, 0, 1, '#c4b5fd'); line(history.n, p1.y, p1.h, 0, 1, COL.K);
            const p2 = panels[2]; const mid = p2.y + p2.h / 2;
            ctx.strokeStyle = COL.grid; ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x1, mid); ctx.stroke();
            line(history.INa, p2.y, p2.h, -1200, 1200, COL.Na); line(history.IK, p2.y, p2.h, -1200, 1200, COL.K);
            // stimulus marker
            ctx.fillStyle = 'rgba(248,113,113,.22)';
            if (state.pulseEnd > state.t - WINDOW) { const a = Math.max(x0, X(state.pulseEnd - 1)), b = Math.min(x1, X(state.pulseEnd)); if (b > a) ctx.fillRect(a, panels[0].y, b - a, panels[0].h); }
            ctx.fillStyle = COL.dim; ctx.fillText(`time → (${WINDOW} ms window)`, x1 - 130, TH - 3);
        }

        function readouts() {
            const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
            set('icV', `${state.V.toFixed(0).replace('-', '−')} mV`);
            set('icNa', `${state.lastINa.toFixed(0).replace('-', '−')} µA/cm²`);
            set('icK', `${state.lastIK.toFixed(0).replace('-', '−')} µA/cm²`);
            set('icNaCount', `${Math.round(state.ions.Na / 100) * 100 >= 0 ? (Math.round(state.ions.Na / 100) * 100).toLocaleString('en-US') : '0'}`);
            set('icKCount', `${(Math.round(state.ions.K / 100) * 100).toLocaleString('en-US')}`);
            set('icKoValue', `${ko.toFixed(1)} mM`); set('icSpeedValue', `${Number(speedIn.value).toFixed(1)} ms/s`); set('icAmpValue', `${Number(ampIn.value).toFixed(0)} µA/cm²`);
            const tag = $('icStatus');
            if (tag) {
                const spiking = state.V > -40;
                const msg = spiking ? `Spike · ${state.V.toFixed(0)} mV` : state.V > -57 ? `Near threshold · ${state.V.toFixed(0)} mV` : `Resting · ${state.V.toFixed(0)} mV`;
                tag.textContent = msg.replace('-', '−'); tag.className = 'ap-status' + (spiking ? ' firing' : '');
            }
        }

        function frame(dt) {
            const speed = Number(speedIn.value); const simDt = Math.min(0.5, dt * speed);
            integrate(simDt); flickerGates(simDt);
            scene.pump.on = pumpToggle.checked;
            scene.update(dt, state.V);
            drawScene(); drawTraces(); readouts();
        }
        function drawScene() {
            const ctx = sctx; ctx.clearRect(0, 0, W, SH); ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, SH);
            scene.draw(ctx);
            ctx.font = '700 11px system-ui';
            ctx.fillStyle = 'rgba(8,14,12,.82)'; ctx.beginPath(); ctx.roundRect(560, 20, 328, 56, 8); ctx.fill();
            ctx.fillStyle = COL.Na; ctx.fillText('● Na⁺   145 mM outside · 12 mM inside', 572, 36);
            ctx.fillStyle = COL.K; ctx.fillText(`● K⁺   ${ko.toFixed(1)} mM outside · 140 mM inside`, 572, 52);
            ctx.fillStyle = COL.Cl; ctx.fillText('● Cl⁻ outside', 572, 68); ctx.fillStyle = COL.A; ctx.fillText('● large anions inside', 700, 68);
            ctx.fillStyle = COL.dim; ctx.font = '10px system-ui'; ctx.fillText(`a glowing ion in transit ≈ ${IONS_PER_DOT.toLocaleString('en-US')} real ions per µm²`, 560, SH - 8);
            const open = k => scene.channels.filter(c => c.kind === k && c.open).length;
            ctx.fillStyle = COL.text; ctx.font = '700 11px system-ui';
            ctx.fillText(`open Na⁺ channels ${open('Na')}/${scene.o.nav}   ·   open K⁺ channels ${open('K')}/${scene.o.kv}`, 100, SH - 8);
        }

        function fire() { state.pulseEnd = state.t + 1; }
        $('icFire').addEventListener('click', fire);
        $('icReset').addEventListener('click', () => { ko = KO0; koIn.value = String(KO0); ttx.checked = false; tea.checked = false; trainToggle.checked = false; settle(); clearHistory(); scene.setOutsideK(3); });
        koIn.addEventListener('input', () => { ko = Number(koIn.value); scene.setOutsideK(Math.round(ko / KO0 * 3)); settle(); });
        [ttx, tea].forEach(el => el.addEventListener('change', () => { settle(); }));
        settle(); clearHistory();
        // a first spike so the picture is alive when the reader arrives
        state.nextTrain = 3; let firstDone = false;
        frame(0.016);                      // a first picture even before the lab scrolls into view
        whileVisible(sceneCanvas, dt => { if (!firstDone && state.t > 0.5) { firstDone = true; fire(); } frame(dt); });
    })();
})();
