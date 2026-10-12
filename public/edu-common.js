// Shared helpers for the compendium's chapter 11-14 labs (loss functions, graphs, inbreeding, quiz).
// Pure educational layer: nothing here touches the simulator or its training code.
(function (root) {
    'use strict';

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    function rng(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function gauss(r) {
        const u = Math.max(1e-12, r());
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    }
    const COL = { bg: '#101a16', text: '#b8c8be', dim: '#6f8a7c', grid: '#2e4a3d', white: '#eef6f0', cyan: '#67e8f9', amber: '#fbbf24', green: '#86efac', red: '#f87171', violet: '#a78bfa', orange: '#fb923c', pink: '#f472b6', blue: '#60a5fa' };

    const $ = id => (typeof document === 'undefined' ? null : document.getElementById(id));
    const num = id => { const el = $(id); return el ? Number(el.value) : NaN; };
    const checked = id => { const el = $(id); return !!(el && el.checked); };
    const out = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d).replace('-', '−') : '—');

    /** Look up a canvas, make it crisp and return helpers to map pointer events into its logical coordinates. */
    function canvas(id, interactive) {
        const el = $(id);
        if (!el) return null;
        const W = el.width, H = el.height;
        const ctx = typeof root.crispCanvas === 'function' ? root.crispCanvas(el) : el.getContext('2d');
        if (interactive) el.style.touchAction = 'none';
        return {
            el, ctx, W, H,
            pos(e) { const r = el.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; },
        };
    }
    function bg(c) { c.ctx.clearRect(0, 0, c.W, c.H); c.ctx.fillStyle = COL.bg; c.ctx.fillRect(0, 0, c.W, c.H); }
    function text(ctx, t, x, y, color, font, align) {
        ctx.fillStyle = color || COL.text; ctx.font = font || '11px system-ui'; ctx.textAlign = align || 'left';
        ctx.fillText(t, x, y); ctx.textAlign = 'left';
    }
    /** Axes with ticks; returns mapping functions from data to canvas coordinates. */
    function axes(ctx, b, o) {
        const X = v => b.x + (v - o.x0) / (o.x1 - o.x0) * b.w;
        const Y = v => b.y + b.h - (v - o.y0) / (o.y1 - o.y0) * b.h;
        ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.strokeRect(b.x, b.y, b.w, b.h);
        (o.xt || []).forEach(v => { text(ctx, o.xf ? o.xf(v) : String(v), X(v), b.y + b.h + 14, COL.dim, '10px system-ui', 'center'); ctx.beginPath(); ctx.moveTo(X(v), b.y + b.h); ctx.lineTo(X(v), b.y + b.h + 3); ctx.stroke(); });
        (o.yt || []).forEach(v => { text(ctx, o.yf ? o.yf(v) : String(v), b.x - 5, Y(v) + 3, COL.dim, '10px system-ui', 'right'); ctx.beginPath(); ctx.moveTo(b.x - 3, Y(v)); ctx.lineTo(b.x, Y(v)); ctx.stroke(); });
        if (o.title) text(ctx, o.title, b.x, b.y - 8, COL.text, '700 11px system-ui');
        return { X, Y };
    }
    function polyline(ctx, pts, color, width, dash) {
        if (!pts.length) return;
        ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.setLineDash(dash || []);
        ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); ctx.setLineDash([]);
    }
    /** Run `draw` once now, and again whenever the element scrolls into view (so labs are correct on first sight). */
    function whenVisible(el, draw) {
        draw();
        if (el && typeof IntersectionObserver !== 'undefined') new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) draw(); }, { threshold: 0.02 }).observe(el);
    }
    /** Animation loop that only runs while `el` is on screen. */
    function loop(el, step) {
        if (!el) return { running: () => false };
        let vis = typeof IntersectionObserver === 'undefined', on = false, last = 0;
        const tick = now => {
            if (!vis) { on = false; return; }
            const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
            step(dt);
            requestAnimationFrame(tick);
        };
        const start = () => { if (!on) { on = true; last = 0; requestAnimationFrame(tick); } };
        if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver(es => { vis = es.some(e => e.isIntersecting); if (vis) start(); }, { threshold: 0.02 }).observe(el); else start();
        return { running: () => on };
    }
    /** Preset buttons inside an `.ap-seg` group: highlights the clicked one and calls `fn(button)`. */
    function presets(groupId, fn) {
        const g = $(groupId); if (!g) return;
        g.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            g.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
            fn(b);
        }));
    }
    function on(ids, fn) { ids.forEach(id => { const el = $(id); if (el) { el.addEventListener('input', fn); el.addEventListener('change', fn); } }); }
    function setValue(id, v) { const el = $(id); if (el) el.value = v; }

    root.EduKit = { clamp, rng, gauss, COL, $, num, checked, out, fmt, canvas, bg, text, axes, polyline, whenVisible, loop, presets, on, setValue };
})(typeof window !== 'undefined' ? window : globalThis);
