// Chapter 10 · Give the brain a body: robot scale, a low camera, an HC-SR04 sonar, sensor fusion and the measured results.
// Relies on crispCanvas() from the page's inline script.
(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const BG = '#101a16', TEXT = '#b8c8be', DIM = '#6f8a7c', GRID = '#2e4a3d';
    const C = { cyan: '#67e8f9', amber: '#fbbf24', green: '#86efac', red: '#f87171', violet: '#a78bfa', white: '#eef6f0' };
    const CM_PER_PX = 1.1;

    function visible(element, frame) {
        // run a lab's drawing only while it is on screen; draw once immediately
        frame();
        if (!('IntersectionObserver' in window)) return;
        new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) frame(); }, { threshold: 0.02 }).observe(element);
    }
    function setup(id, onInput, controls) {
        const canvas = $(id); if (!canvas) return null;
        const ctx = crispCanvas(canvas);
        const draw = () => onInput(ctx, canvas);
        controls.forEach(c => { const el = $(c); if (el) el.addEventListener('input', draw); if (el && el.type === 'checkbox') el.addEventListener('change', draw); });
        visible(canvas, draw);
        return { ctx, canvas, draw };
    }
    const out = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const val = id => Number($(id).value);
    const bg = (ctx, w, h) => { ctx.clearRect(0, 0, w, h); ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h); };
    const label = (ctx, t, x, y, color = TEXT, font = '11px system-ui', align = 'left') => { ctx.fillStyle = color; ctx.font = font; ctx.textAlign = align; ctx.fillText(t, x, y); ctx.textAlign = 'left'; };

    /* ----- the simulator's camera model (src/vision/camera.ts): pinhole, tilted down by `pitch`, over a flat ground ----- */
    function makeCamera(hPx, pitch, hfovDeg, width = 48, height = 24) {
        const f = (width / 2) / Math.tan(hfovDeg * Math.PI / 360);
        return { h: hPx, pitch, f, width, height, cx: width / 2, cy: height / 2, sinP: Math.sin(pitch), cosP: Math.cos(pitch) };
    }
    function groundAt(cam, col, row) {
        const b = (row + 0.5 - cam.cy) / cam.f; const down = cam.sinP + b * cam.cosP;
        if (down <= 1e-4) return null;
        const t = cam.h / down; return { fwd: t * (cam.cosP - b * cam.sinP), right: t * (col + 0.5 - cam.cx) / cam.f };
    }
    /** Screen position of a point `height` above the ground, `fwd` ahead of and `right` of the camera. */
    function project(cam, fwd, right, height) {
        const down = cam.h - height;
        const z = fwd * cam.cosP + down * cam.sinP, y = -fwd * cam.sinP + down * cam.cosP;
        return { x: cam.cx + cam.f * right / z, y: cam.cy + cam.f * y / z, z };
    }

    /* ------------------------------------------------------------------
       Lab 10.1 · The robot to scale
       ------------------------------------------------------------------ */
    (function scaleLab() {
        setup('scaleCanvas', (ctx, canvas) => {
            const W = 900, H = 400; bg(ctx, W, H);
            const cmpx = val('scalePx'), mount = val('scaleMount'), tilt = val('scaleTilt');
            out('scalePxValue', cmpx.toFixed(2) + ' cm/px'); out('scaleMountValue', mount.toFixed(1) + ' cm'); out('scaleTiltValue', tilt.toFixed(0) + '° down');
            // ---- top view ----
            label(ctx, 'TOP VIEW · 10 px = 1 cm', 18, 22, TEXT, '700 11px system-ui');
            const S = 9, cx = 300, cy = 205;       // pixels per cm in the drawing
            const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(cx + x * S - (w * S) / 2, cy + y * S - (h * S) / 2, w * S, h * S, r); };
            // ruler
            ctx.strokeStyle = GRID; ctx.lineWidth = 1; for (let m = -20; m <= 60; m += 10) { ctx.beginPath(); ctx.moveTo(cx + m * S, 330); ctx.lineTo(cx + m * S, 338); ctx.stroke(); label(ctx, m + ' cm', cx + m * S, 352, DIM, '10px system-ui', 'center'); }
            ctx.beginPath(); ctx.moveTo(cx - 20 * S, 330); ctx.lineTo(cx + 60 * S, 330); ctx.stroke();
            // sonar beam (±7.5°) and camera field of view (100°)
            const sx = cx + 12 * S, sy = cy;
            const g = ctx.createRadialGradient(sx, sy, 5, sx, sy, 60 * S); g.addColorStop(0, 'rgba(251,191,36,.45)'); g.addColorStop(1, 'rgba(251,191,36,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, 60 * S, -7.5 * Math.PI / 180, 7.5 * Math.PI / 180); ctx.closePath(); ctx.fill();
            const gc = ctx.createRadialGradient(sx, sy, 5, sx, sy, 38 * S); gc.addColorStop(0, 'rgba(103,232,249,.22)'); gc.addColorStop(1, 'rgba(103,232,249,0)');
            ctx.fillStyle = gc; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, 38 * S, -50 * Math.PI / 180, 50 * Math.PI / 180); ctx.closePath(); ctx.fill();
            // wheels, body
            ctx.fillStyle = '#0a0f0d'; for (const ax of [-5.75, 5.75]) for (const side of [-1, 1]) { rr(ax, side * 7.9, 6.5, 2.6, 3); ctx.fill(); }
            rr(0, 0, 26, 17, 6); ctx.fillStyle = '#24473a'; ctx.fill(); ctx.strokeStyle = '#6ee7b7'; ctx.lineWidth = 2; ctx.stroke();
            // simulated kart overlay
            const kl = 24 * cmpx, kw = 14 * cmpx;
            rr(0, 0, kl, kw, 5); ctx.setLineDash([6, 4]); ctx.strokeStyle = C.amber; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
            // sensor mount
            ctx.fillStyle = C.cyan; ctx.beginPath(); ctx.roundRect(sx - 3, sy - 10, 6, 20, 2); ctx.fill();
            label(ctx, 'camera + HC-SR04', sx + 10, sy - 14, C.cyan, '700 10px system-ui');
            // dimension lines
            const dim = (x1, y1, x2, y2, t, tx, ty) => { ctx.strokeStyle = TEXT; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); label(ctx, t, tx, ty, TEXT, '700 11px system-ui', 'center'); };
            dim(cx - 13 * S, cy + 11.5 * S, cx + 13 * S, cy + 11.5 * S, '26 cm', cx, cy + 11.5 * S + 14);
            dim(cx - 16.5 * S, cy - 8.5 * S, cx - 16.5 * S, cy + 8.5 * S, '17 cm', cx - 16.5 * S - 18, cy);
            dim(cx - 5.75 * S, cy - 11.2 * S, cx + 5.75 * S, cy - 11.2 * S, 'wheel centres 11.5 cm', cx, cy - 11.2 * S - 6);
            label(ctx, 'simulated kart ' + (24 * cmpx).toFixed(1) + ' × ' + (14 * cmpx).toFixed(1) + ' cm', 18, 46, C.amber, '700 11px system-ui');
            label(ctx, 'real robot 26 × 17 cm', 18, 62, '#6ee7b7', '700 11px system-ui');
            // ---- side view ----
            const sxv = 600, floor = 320, k = 3.4;           // 3.4 px per cm
            label(ctx, 'SIDE VIEW · mount height ' + mount.toFixed(1) + ' cm', sxv - 20, 22, TEXT, '700 11px system-ui');
            ctx.strokeStyle = '#6f8a7c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sxv - 40, floor); ctx.lineTo(W - 12, floor); ctx.stroke();
            ctx.fillStyle = '#24473a'; ctx.fillRect(sxv - 40, floor - mount * k, 26 * k, mount * k); ctx.strokeStyle = '#6ee7b7'; ctx.lineWidth = 1.5; ctx.strokeRect(sxv - 40, floor - mount * k, 26 * k, mount * k);
            ctx.fillStyle = '#0a0f0d'; ctx.beginPath(); ctx.arc(sxv - 40 + 7 * k, floor - 3.2 * k, 3.2 * k, 0, 7); ctx.arc(sxv - 40 + 19 * k, floor - 3.2 * k, 3.2 * k, 0, 7); ctx.fill();
            const px = sxv - 40 + 24 * k, py = floor - mount * k;       // sensors near the front edge
            ctx.fillStyle = C.cyan; ctx.fillRect(px - 2, py - 10, 5, 10);
            const pitch = tilt * Math.PI / 180, half = Math.atan(12 / ((48 / 2) / Math.tan(50 * Math.PI / 180)));
            const ray = (ang, color, len = 300) => { ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(px, py - 5); ctx.lineTo(px + Math.cos(ang) * len, py - 5 + Math.sin(ang) * len); ctx.stroke(); };
            // camera frustum (angles measured downward from horizontal)
            const lo = pitch - half, hi = pitch + half;       // top ray, bottom ray
            const hitFloor = a => (a > 0.001 ? (mount) / Math.tan(a) : Infinity);
            const nearCm = hitFloor(hi);                       // where the bottom ray lands
            ctx.fillStyle = 'rgba(103,232,249,.13)'; ctx.beginPath(); ctx.moveTo(px, py - 5);
            const endLen = a => Math.min(1000, a > 0.001 ? mount / Math.sin(a) * k : 330);
            ctx.lineTo(px + Math.cos(hi) * endLen(hi), py - 5 + Math.sin(hi) * endLen(hi)); ctx.lineTo(px + Math.cos(lo) * endLen(lo), py - 5 + Math.sin(lo) * endLen(lo)); ctx.closePath(); ctx.fill();
            ray(hi, C.cyan, Math.min(endLen(hi), 330)); ray(lo, C.cyan, Math.min(endLen(lo), 330));
            // sonar cone: horizontal ±7.5°
            const sonarHalf = 7.5 * Math.PI / 180;
            ctx.strokeStyle = C.amber; ctx.lineWidth = 1.6; ctx.setLineDash([5, 3]);
            for (const a of [-sonarHalf, sonarHalf]) { ctx.beginPath(); ctx.moveTo(px, py - 12 + 7); ctx.lineTo(px + Math.cos(a) * 300, py - 5 + Math.sin(a) * 300); ctx.stroke(); }
            ctx.setLineDash([]);
            const floorHit = mount / Math.tan(sonarHalf);
            ctx.fillStyle = 'rgba(251,191,36,.16)'; ctx.beginPath(); ctx.moveTo(px, py - 5); ctx.lineTo(px + 300, py - 5 - Math.tan(sonarHalf) * 300); ctx.lineTo(px + 300, py - 5 + Math.tan(sonarHalf) * 300); ctx.closePath(); ctx.fill();
            // floor markers
            const mark = (cm, text, color, drop) => { const x = px + cm * k; if (x > W - 16) return; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, floor - 8); ctx.lineTo(x, floor + 8 + drop); ctx.stroke(); label(ctx, text, Math.min(x, W - 130), floor + 24 + drop, color, '700 10px system-ui', 'center'); };
            if (isFinite(nearCm)) mark(nearCm, 'nearest floor seen ' + nearCm.toFixed(0) + ' cm', C.cyan, 0);
            mark(floorHit, 'sonar lower edge meets floor ' + floorHit.toFixed(0) + ' cm', C.amber, 22);
            if (lo < 0) label(ctx, 'top ray looks above the horizon', sxv + 40, 60, C.cyan, '10px system-ui');
            // readouts
            out('scaleKart', (24 * cmpx).toFixed(1) + ' × ' + (14 * cmpx).toFixed(1) + ' cm');
            out('scaleMatch', '+' + ((24 * cmpx / 26 - 1) * 100).toFixed(0) + '% / ' + ((14 * cmpx / 17 - 1) * 100).toFixed(0) + '%');
            out('scaleSpeed', (90 * cmpx / 100).toFixed(2) + ' m/s');
            out('scaleNear', isFinite(nearCm) ? Math.max(0, nearCm - 1).toFixed(0) + ' cm' : 'none');
            out('scaleFloor', floorHit.toFixed(0) + ' cm');
        }, ['scalePx', 'scaleMount', 'scaleTilt']);
    })();

    /* ------------------------------------------------------------------
       Lab 10.2 · Two cameras on the same road
       ------------------------------------------------------------------ */
    (function heightLab() {
        const small = document.createElement('canvas'); small.width = 48; small.height = 24;
        function render(cam, curv, coneAt, coneOn, mountForward) {
            const sctx = small.getContext('2d'); const img = sctx.createImageData(48, 24); const d = img.data;
            for (let row = 0; row < 24; row += 1) for (let col = 0; col < 48; col += 1) {
                const g = groundAt(cam, col, row); let r, gg, b;
                if (!g) { const k = row / 12; r = 120 + 70 * k; gg = 170 + 50 * k; b = 235 + 10 * k; }      // sky
                else {
                    const lat = 0.5 * curv * g.fwd * g.fwd; const off = g.right - lat; const a = Math.abs(off);
                    const stripe = Math.floor((g.fwd + mountForward) / 35) % 2;
                    if (a < 27) { r = 76; gg = 80; b = 88; if (a < 1.4 && stripe === 0) { r = 232; gg = 232; b = 220; } }
                    else if (a < 32) { const kerb = Math.floor((g.fwd + mountForward) / 18) % 2 === 0; r = kerb ? 217 : 242; gg = kerb ? 54 : 242; b = kerb ? 44 : 238; }
                    else { const sh = stripe ? 0 : 10; r = 54 - sh; gg = 150 - sh; b = 62 - sh; }
                    // fog toward the horizon
                    const fog = clamp(g.fwd / 700, 0, 0.6); r = r * (1 - fog) + 196 * fog; gg = gg * (1 - fog) + 217 * fog; b = b * (1 - fog) + 230 * fog;
                }
                const i = (row * 48 + col) * 4; d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
            }
            sctx.putImageData(img, 0, 0);
            if (coneOn) {
                const F = coneAt - mountForward; const base = project(cam, F, 0, 0), top = project(cam, F, 0, 8);
                if (base.z > 1) { const w = Math.max(0.6, 3.5 * cam.f / base.z); sctx.fillStyle = '#f08b47'; sctx.beginPath(); sctx.moveTo(base.x - w, base.y); sctx.lineTo(base.x + w, base.y); sctx.lineTo(top.x, top.y); sctx.closePath(); sctx.fill(); sctx.fillStyle = '#fff'; sctx.fillRect(top.x - w * 0.5, (base.y + top.y) / 2, w, 0.7); }
            }
            return small;
        }
        function stats(cam, mountForward) {
            let near = Infinity, far = 0, between = 0, last = 0;
            for (let row = 0; row < 24; row += 1) { const g = groundAt(cam, 24, row); if (!g) continue; near = Math.min(near, g.fwd); far = Math.max(far, g.fwd); if (g.fwd + mountForward >= 90 && g.fwd + mountForward <= 270) between += 1; last = g.fwd; }
            void last; return { near, far, between };
        }
        const orig = makeCamera(15, 0.16, 96);
        setup('heightCanvas', (ctx, canvas) => {
            const W = 900, H = 330; bg(ctx, W, H);
            const hcm = val('heightCm'), curv = val('heightCurve') / 10000, cone = val('heightCone'), coneOn = $('heightConeOn').checked;
            const cam = makeCamera(hcm / CM_PER_PX, 0.12, 100);
            out('heightCmValue', hcm.toFixed(1) + ' cm'); out('heightCurveValue', (curv * 10000).toFixed(0)); out('heightConeValue', Math.round(cone * CM_PER_PX) + ' cm');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(render(orig, curv, cone, coneOn, 8), 16, 30, 420, 210);
            ctx.drawImage(render(cam, curv, cone, coneOn, 11), 464, 30, 420, 210);
            label(ctx, 'ORIGINAL KART CAMERA · 16.5 cm up', 16, 20, TEXT, '700 11px system-ui');
            label(ctx, 'ROBOT CAMERA · ' + hcm.toFixed(1) + ' cm up', 464, 20, C.cyan, '700 11px system-ui');
            const sa = stats(orig, 8), sb = stats(cam, 11);
            // row ruler: which distance each image row reaches (every 4th row)
            const ruler = (x0, c, mf) => { for (let row = 23; row >= 8; row -= 3) { const g = groundAt(c, 24, row); if (!g) continue; const y = 30 + (row + 0.5) * 210 / 24; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.moveTo(x0 + 420, y); ctx.lineTo(x0 + 428, y); ctx.stroke(); label(ctx, Math.round((g.fwd + mf) * CM_PER_PX) + ' cm', x0 + 2, y + 3, '#fff', '9px system-ui'); } };
            ruler(16, orig, 8); ruler(464, cam, 11);
            label(ctx, 'each tick: how far ahead of the kart’s centre that image row looks', 16, 258, DIM, '10px system-ui');
            const row = (x, s, title, color) => {
                label(ctx, title, x, 282, color, '700 11px system-ui');
                label(ctx, 'nearest ground seen ahead of the bumper: ' + (isFinite(s.near) ? Math.max(0, Math.round((s.near - 1) * CM_PER_PX)) + ' cm' : 'none'), x, 300, TEXT);
                label(ctx, 'image rows that cover 1 m – 3 m ahead: ' + s.between + ' of 24', x, 316, TEXT);
            };
            row(16, sa, 'original', TEXT); row(464, sb, 'robot', C.cyan);
            out('heightNear', isFinite(sb.near) ? Math.max(0, Math.round((sb.near - 1) * CM_PER_PX)) + ' cm' : 'none');
            out('heightRows', sb.between + ' of 24 (was ' + sa.between + ')');
            out('heightFar', Math.round((sb.far + 11) * CM_PER_PX) + ' cm');
        }, ['heightCm', 'heightCurve', 'heightCone', 'heightConeOn']);
    })();

    /* ------------------------------------------------------------------
       Lab 10.3 · Will this ping come back? (with the waveform)
       ------------------------------------------------------------------ */
    (function sonarLab() {
        setup('sonarWaveCanvas', (ctx, canvas) => {
            const W = 900, H = 380; bg(ctx, W, H);
            const d = val('sonD'), a = val('sonA'), w = val('sonW'), s = val('sonS'), h = val('sonH'), T = val('sonT');
            out('sonDValue', d + ' cm'); out('sonAValue', a + '°'); out('sonWValue', w + ' cm'); out('sonSValue', s + '°'); out('sonHValue', h + ' cm'); out('sonTValue', T + ' °C');
            const c = 331.3 + 0.606 * T, assumed = 343;
            const lobe = Math.exp(-0.5 * Math.pow(a / 12, 2)), tilt = Math.pow(Math.cos(s * Math.PI / 180), 4);
            const strength = (w / 10) * lobe * tilt / Math.pow(d / 50, 2);
            const tof = 2 * (d / 100) / c * 1000;
            let verdict = 'ECHO', why = '';
            if (d < 2) { verdict = 'no echo'; why = 'inside the 2 cm blind zone'; }
            else if (d > 400) { verdict = 'no echo'; why = 'beyond 4 m'; }
            else if (h < 1.6) { verdict = 'no echo'; why = 'too low: the sound skims over it'; }
            else if (strength < 0.05) { verdict = 'no echo'; why = lobe < 0.2 ? 'off to the side of the beam' : tilt < 0.3 ? 'sound reflected away by the tilt' : 'target too small or too far'; }
            const echo = verdict === 'ECHO';
            // ---- top: scene ----
            const ox = 28, oy = 100, sc = (W * 0.62 - ox) / 450;
            label(ctx, 'TOP VIEW', 16, 18, TEXT, '700 11px system-ui');
            ctx.strokeStyle = '#1e2f27'; for (let cm = 100; cm <= 400; cm += 100) { ctx.beginPath(); ctx.moveTo(ox + cm * sc, 30); ctx.lineTo(ox + cm * sc, 170); ctx.stroke(); label(ctx, cm + ' cm', ox + cm * sc - 14, 180, DIM, '10px system-ui'); }
            const half = 7.5 * Math.PI / 180, reach = 400 * sc;
            const g = ctx.createRadialGradient(ox, oy, 2, ox, oy, reach); g.addColorStop(0, 'rgba(251,191,36,.5)'); g.addColorStop(1, 'rgba(251,191,36,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.arc(ox, oy, reach, -half, half); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = 'rgba(251,191,36,.3)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(ox, oy); ctx.arc(ox, oy, reach, -2 * half, 2 * half); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
            const ang = a * Math.PI / 180, tx = ox + Math.cos(ang) * d * sc, ty = oy + Math.sin(ang) * d * sc;
            ctx.save(); ctx.translate(tx, ty); ctx.rotate(Math.PI + s * Math.PI / 180 * (a >= 0 ? 1 : -1) + ang); ctx.fillStyle = echo ? C.green : C.red; ctx.fillRect(-2, -Math.max(2, w * sc) / 2, 4, Math.max(2, w * sc)); ctx.restore();
            ctx.fillStyle = C.amber; ctx.fillRect(ox - 12, oy - 8, 12, 16);
            if (echo) { ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ox, oy, d * sc, ang - 0.12, ang + 0.12); ctx.stroke(); ctx.lineWidth = 1; }
            // ---- right: lobe polar plot ----
            const px = W * 0.82, py = 100, pr = 70;
            label(ctx, 'BEAM GAIN', px - pr, 18, TEXT, '700 11px system-ui');
            ctx.strokeStyle = GRID; for (const r of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(px - pr, py, pr * r, -Math.PI / 2, Math.PI / 2); ctx.stroke(); }
            ctx.strokeStyle = C.amber; ctx.lineWidth = 2; ctx.beginPath();
            for (let deg = -90; deg <= 90; deg += 3) { const gain = Math.exp(-0.5 * Math.pow(deg / 12, 2)); const r = pr * gain; const x = px - pr + Math.cos(deg * Math.PI / 180) * r, y = py + Math.sin(deg * Math.PI / 180) * r; if (deg === -90) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
            ctx.stroke(); ctx.lineWidth = 1;
            ctx.fillStyle = echo ? C.green : C.red; ctx.beginPath(); ctx.arc(px - pr + Math.cos(ang) * pr * lobe, py + Math.sin(ang) * pr * lobe, 5, 0, 7); ctx.fill();
            label(ctx, 'target gain ' + lobe.toFixed(2), px - pr, 190, TEXT, '10px system-ui');
            // ---- bottom: waveform ----
            const wx0 = 60, wx1 = W - 24, wy = 255, wh = 70, tMax = 26;
            const X = t => wx0 + t / tMax * (wx1 - wx0);
            ctx.strokeStyle = GRID; ctx.strokeRect(wx0, wy - wh / 2 - 12, wx1 - wx0, wh + 24);
            label(ctx, 'RECEIVER (ms after the 40 kHz burst)', wx0, wy - wh / 2 - 18, TEXT, '700 11px system-ui');
            ctx.strokeStyle = C.amber; ctx.lineWidth = 1.2; ctx.beginPath(); for (let i = 0; i <= 80; i += 1) { const t = i / 80 * 0.2; const x = X(t * 1); const y = wy + Math.sin(i * 1.6) * 24 * (i < 70 ? 1 : 0.2); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
            label(ctx, 'burst', X(0.2) + 4, wy - 28, C.amber, '10px system-ui');
            ctx.fillStyle = 'rgba(248,113,113,.12)'; ctx.fillRect(X(0), wy - wh / 2 - 12, X(0.117 * 1) - X(0), wh + 24);
            const thr = 0.05; const thrY = wy - clamp(thr * 40, 0, wh / 2); ctx.strokeStyle = C.red; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(wx0, thrY); ctx.lineTo(wx1, thrY); ctx.stroke(); ctx.setLineDash([]);
            label(ctx, 'detection threshold', wx1 - 120, thrY - 4, C.red, '10px system-ui');
            if (tof < tMax) {
                const amp = clamp(strength * 40, 0, wh / 2);
                ctx.strokeStyle = echo ? C.green : '#9aa8a0'; ctx.lineWidth = 1.5; ctx.beginPath();
                for (let i = 0; i <= 120; i += 1) { const t = tof + i / 120 * 0.5; const x = X(t); const env = Math.exp(-Math.pow((t - tof - 0.12) / 0.14, 2)); const y = wy + Math.sin(i * 1.6) * amp * env; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
                ctx.stroke(); ctx.lineWidth = 1;
                ctx.setLineDash([2, 3]); ctx.strokeStyle = '#9aa8a0'; ctx.beginPath(); ctx.moveTo(X(tof), wy - wh / 2 - 12); ctx.lineTo(X(tof), wy + wh / 2 + 12); ctx.stroke(); ctx.setLineDash([]);
                label(ctx, tof.toFixed(2) + ' ms', X(tof) + 4, wy + wh / 2 + 8, TEXT, '10px system-ui');
            }
            label(ctx, '2 cm blind zone', X(0.02), wy + wh / 2 + 8, C.red, '10px system-ui');
            [0, 5, 10, 15, 20, 25].forEach(t => label(ctx, t + '', X(t), wy + wh / 2 + 24, DIM, '10px system-ui', 'center'));
            const reported = assumed * (tof / 1000) / 2 * 100;
            label(ctx, echo ? 'ECHO → module reports ' + reported.toFixed(1) + ' cm (true ' + d + ' cm, ' + ((reported / d - 1) * 100).toFixed(1) + '%)' : 'NO ECHO · ' + why, 16, 366, echo ? C.green : C.red, '700 12px system-ui');
            out('sonTof', tof.toFixed(2) + ' ms'); out('sonStrength', strength.toFixed(2)); out('sonC', c.toFixed(1) + ' m/s');
            out('sonVerdict', echo ? 'echo, ' + reported.toFixed(1) + ' cm' : 'no echo');
            const tag = $('sonTag'); if (tag) { tag.textContent = echo ? 'Echo · ' + reported.toFixed(0) + ' cm' : 'No echo'; tag.className = 'ap-status' + (echo ? ' firing' : ' recovering'); }
        }, ['sonD', 'sonA', 'sonW', 'sonS', 'sonH', 'sonT']);
        const preset = (id, v) => { const b = $(id); if (!b) return; b.addEventListener('click', () => { b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); for (const [k, x] of Object.entries(v)) { const el = $(k); el.value = x; } $('sonD').dispatchEvent(new Event('input')); }); };
        preset('sonPresetCone', { sonD: 60, sonA: 0, sonW: 12, sonS: 0, sonH: 9, sonT: 20 });
        preset('sonPresetPost', { sonD: 150, sonA: 0, sonW: 2, sonS: 0, sonH: 20, sonT: 20 });
        preset('sonPresetWall', { sonD: 100, sonA: 0, sonW: 40, sonS: 60, sonH: 20, sonT: 20 });
        preset('sonPresetOil', { sonD: 60, sonA: 0, sonW: 30, sonS: 0, sonH: 0.5, sonT: 20 });
        preset('sonPresetHot', { sonD: 100, sonA: 0, sonW: 20, sonS: 0, sonH: 12, sonT: 40 });
    })();

    /* ------------------------------------------------------------------
       Lab 10.4 · Fusing a camera and a sonar
       ------------------------------------------------------------------ */
    (function fusionLab() {
        const state = { sonarHeard: true };
        const lab = setup('fuseCanvas', (ctx, canvas) => {
            const W = 900, H = 340; bg(ctx, W, H);
            const mc = val('fuCamM'), sc = val('fuCamS'), ms = val('fuSonM'), ss = val('fuSonS');
            const gate = $('fuGate').checked; state.sonarHeard = $('fuHeard').checked;
            out('fuCamMValue', mc + ' cm'); out('fuCamSValue', '±' + sc + ' cm'); out('fuSonMValue', ms + ' cm'); out('fuSonSValue', '±' + ss.toFixed(1) + ' cm');
            const disagreement = Math.abs(mc - ms) / Math.sqrt(sc * sc + ss * ss);
            const gated = gate && state.sonarHeard && disagreement > 3;
            const useSonar = state.sonarHeard && !gated;
            const wc = 1 / (sc * sc), ws = useSonar ? 1 / (ss * ss) : 0;
            const fusedMean = (mc * wc + ms * ws) / (wc + ws), fusedSigma = Math.sqrt(1 / (wc + ws));
            const shareC = wc / (wc + ws), shareS = ws / (wc + ws);
            const x0 = 40, x1 = W - 20, plotTop = 20, plotBottom = 250; const D = 260;
            const X = d => x0 + d / D * (x1 - x0);
            ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x0, plotBottom); ctx.lineTo(x1, plotBottom); ctx.stroke();
            for (let d = 0; d <= D; d += 40) { label(ctx, d + '', X(d), plotBottom + 14, DIM, '10px system-ui', 'center'); ctx.beginPath(); ctx.moveTo(X(d), plotBottom); ctx.lineTo(X(d), plotBottom + 4); ctx.stroke(); }
            label(ctx, 'distance to the obstacle ahead (cm)', x1 - 190, plotBottom + 28, DIM, '10px system-ui');
            const curve = (mean, sigma, color, fill, scale = 1) => {
                const pk = scale * 1 / (sigma * Math.sqrt(2 * Math.PI)); void pk;
                ctx.beginPath(); ctx.moveTo(X(0), plotBottom);
                const own = scale; void own;
                for (let d = 0; d <= D; d += 1) { const p = Math.exp(-0.5 * Math.pow((d - mean) / sigma, 2)); const y = plotBottom - p * (plotBottom - plotTop - 30) * scale; ctx.lineTo(X(d), y); }
                ctx.lineTo(X(D), plotBottom); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
            };
            curve(mc, sc, C.cyan, 'rgba(103,232,249,.12)', 0.62);
            if (state.sonarHeard) { ctx.setLineDash(gated ? [5, 4] : []); curve(ms, ss, C.amber, gated ? null : 'rgba(251,191,36,.14)', 0.8); ctx.setLineDash([]); }
            curve(fusedMean, fusedSigma, C.green, 'rgba(134,239,172,.22)', 1);
            label(ctx, 'each curve is drawn to its own height: width = uncertainty', x1 - 330, 22, DIM, '10px system-ui');
            // legend + stats
            label(ctx, '● camera', x0 + 6, 40, C.cyan, '700 11px system-ui'); label(ctx, state.sonarHeard ? (gated ? '● sonar (rejected as an outlier)' : '● sonar') : '● sonar heard nothing', x0 + 76, 40, state.sonarHeard ? C.amber : DIM, '700 11px system-ui'); label(ctx, '● fused', x0 + (state.sonarHeard ? 260 : 220), 40, C.green, '700 11px system-ui');
            // trust bars
            const by = 292; const bw = x1 - x0;
            ctx.fillStyle = '#183026'; ctx.fillRect(x0, by, bw, 18);
            ctx.fillStyle = C.cyan; ctx.fillRect(x0, by, bw * shareC, 18); ctx.fillStyle = C.amber; ctx.fillRect(x0 + bw * shareC, by, bw * shareS, 18);
            label(ctx, 'who the fused estimate listens to: camera ' + (shareC * 100).toFixed(0) + '%  ·  sonar ' + (shareS * 100).toFixed(0) + '%', x0, by - 6, TEXT, '700 11px system-ui');
            out('fuMean', fusedMean.toFixed(1) + ' cm'); out('fuSigma', '±' + fusedSigma.toFixed(1) + ' cm'); out('fuDis', state.sonarHeard ? disagreement.toFixed(1) + ' σ' : '—');
            const tag = $('fuTag'); if (tag) { tag.textContent = !state.sonarHeard ? 'Camera alone' : gated ? 'Sonar rejected' : disagreement > 3 ? 'Sources disagree — fused is wrong' : 'Agree'; tag.className = 'ap-status' + (!state.sonarHeard ? '' : gated ? ' recovering' : disagreement > 3 ? ' firing' : ''); }
        }, ['fuCamM', 'fuCamS', 'fuSonM', 'fuSonS', 'fuGate', 'fuHeard']);
        const preset = (id, v) => { const b = $(id); if (!b) return; b.addEventListener('click', () => { b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); for (const [k, x] of Object.entries(v)) { const el = $(k); if (el.type === 'checkbox') el.checked = !!x; else el.value = x; } $('fuCamM').dispatchEvent(new Event('input')); }); };
        preset('fuDay', { fuCamM: 90, fuCamS: 20, fuSonM: 84, fuSonS: 1.5, fuHeard: 1 });
        preset('fuNight', { fuCamM: 150, fuCamS: 70, fuSonM: 84, fuSonS: 1.5, fuHeard: 1 });
        preset('fuGhost', { fuCamM: 90, fuCamS: 20, fuSonM: 30, fuSonS: 1.5, fuHeard: 1, fuGate: 0 });
        preset('fuMiss', { fuCamM: 90, fuCamS: 20, fuSonM: 84, fuSonS: 1.5, fuHeard: 0 });
        void lab;
    })();

    /* ------------------------------------------------------------------
       Lab 10.5 · The measured results, with their error bars
       ------------------------------------------------------------------ */
    (function resultsLab() {
        const canvas = $('resultsCanvas'); if (!canvas) return;
        const ctx = crispCanvas(canvas);
        let data = null;
        const scenarioSelect = $('resScenario'), metricSelect = $('resMetric');
        const palette = ['#94a3b8', '#a78bfa', '#67e8f9', '#fbbf24', '#86efac', '#fb923c'];
        function fill() {
            scenarioSelect.innerHTML = '';
            for (const s of data.track.scenarios) scenarioSelect.add(new Option(s.label, 'track:' + s.id));
            if (data.world) scenarioSelect.add(new Option('Open world (trees, rocks, ponds)', 'world'));
            draw();
        }
        function bars(rows, metric) {
            return rows.map(r => {
                if (metric === 'laps') { const p = r.laps / r.episodes, se = Math.sqrt(p * (1 - p) / r.episodes) * r.episodes; return { label: r.label, value: r.laps, se, max: r.episodes, text: r.laps + ' / ' + r.episodes, color: null }; }
                if (metric === 'lap') return { label: r.label, value: r.meanLapSeconds || 0, se: 0, max: 60, text: r.meanLapSeconds ? r.meanLapSeconds.toFixed(1) + ' s' : 'no laps', color: null };
                if (metric === 'coll') return { label: r.label, value: r.collisions, se: Math.sqrt(r.collisions), max: Math.max(100, ...rows.map(x => x.collisions)) * 1.1, text: String(r.collisions), color: null };
                return { label: r.label, value: r.progress * 100, se: 0, max: 100, text: (r.progress * 100).toFixed(0) + '%', color: null };
            });
        }
        function draw() {
            if (!data) return;
            const W = 900, H = 400; bg(ctx, W, H);
            const key = scenarioSelect.value, metric = metricSelect.value;
            let list, title, note;
            if (key === 'world') {
                const wm = { laps: 'goals', lap: 'goals', coll: 'coll', prog: 'goals' }[metric];
                list = data.world.rows.map(r => ({ label: r.label, value: wm === 'coll' ? r.collisions : r.goals, se: 0, max: wm === 'coll' ? 6 : 6, text: wm === 'coll' ? r.collisions.toFixed(2) + ' per run' : r.goals.toFixed(2) + ' goals / run  ·  ' + r.crashes + '/' + r.worlds + ' crashed', color: null }));
                title = 'Open world · ' + (wm === 'coll' ? 'collisions per run (lower is better)' : 'goals per run (higher is better)'); note = '16 worlds, each 30–60 s. Ponds and mud are invisible to the sonar.';
            } else {
                const sc = data.track.scenarios.find(s => 'track:' + s.id === key);
                list = bars(sc.rows, metric); title = sc.label + ' · ' + { laps: 'laps finished (of 16)', lap: 'mean lap time (s)', coll: 'collisions (16 episodes; lower is better)', prog: 'mean progress (%)' }[metric]; note = sc.note;
            }
            label(ctx, title, 20, 26, C.white, '700 13px system-ui'); label(ctx, note, 20, 44, DIM, '11px system-ui');
            const x0 = 330, x1 = W - 150, top = 66, rowH = Math.min(52, (H - top - 30) / list.length);
            const max = Math.max(...list.map(b => b.max));
            list.forEach((b, i) => {
                const y = top + i * rowH; const sonarOn = /sonar on|\+ sonar/i.test(b.label) && !/off/i.test(b.label);
                const color = /kart controller/i.test(b.label) ? '#94a3b8' : /exact/i.test(b.label) ? (sonarOn ? '#fbbf24' : '#a78bfa') : (sonarOn ? '#fbbf24' : '#67e8f9');
                label(ctx, b.label, 16, y + rowH / 2 + 2, sonarOn ? '#fde68a' : TEXT, (sonarOn ? '700 ' : '') + '11px system-ui');
                ctx.fillStyle = '#183026'; ctx.fillRect(x0, y + 6, x1 - x0, rowH - 14);
                const w = clamp(b.value / max, 0, 1) * (x1 - x0);
                ctx.fillStyle = color; ctx.fillRect(x0, y + 6, w, rowH - 14);
                if (b.se > 0) { const a = clamp((b.value - b.se) / max, 0, 1) * (x1 - x0), c = clamp((b.value + b.se) / max, 0, 1) * (x1 - x0); ctx.strokeStyle = C.white; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0 + a, y + rowH / 2 - 1); ctx.lineTo(x0 + c, y + rowH / 2 - 1); ctx.moveTo(x0 + a, y + rowH / 2 - 6); ctx.lineTo(x0 + a, y + rowH / 2 + 4); ctx.moveTo(x0 + c, y + rowH / 2 - 6); ctx.lineTo(x0 + c, y + rowH / 2 + 4); ctx.stroke(); }
                label(ctx, b.text, x1 + 10, y + rowH / 2 + 3, C.white, '700 11px system-ui');
            });
            void palette;
            label(ctx, 'white whiskers: ±1 standard error (binomial for laps, √count for collisions). Bars whose whiskers overlap are not distinguishable.', 20, H - 10, DIM, '10px system-ui');
        }
        fetch('./vision/robot/results.json').then(r => (r.ok ? r.json() : Promise.reject(new Error('missing')))).then(json => { data = json; fill(); })
            .catch(() => { bg(ctx, 900, 400); label(ctx, 'The robot results file (vision/robot/results.json) was not found next to this page.', 20, 40, TEXT, '13px system-ui'); });
        [scenarioSelect, metricSelect].forEach(el => el.addEventListener('input', draw));
        if ('IntersectionObserver' in window) new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) draw(); }, { threshold: 0.02 }).observe(canvas);
    })();
})();
