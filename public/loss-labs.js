// Chapter 11 · Loss functions: robust fitting, classification losses, predicted uncertainty and a chooser.
// Needs edu-common.js. Pure functions are exposed on EduLabs.loss so they can be tested without a page.
(function (root) {
    'use strict';
    const K = root.EduKit;
    const { clamp, COL } = K;

    /* ------------------------------ pure maths ------------------------------ */

    /** Weighted least-squares line y = m x + c. */
    function wls(pts, w) {
        let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        pts.forEach((p, i) => { const k = w ? w[i] : 1; sw += k; sx += k * p.x; sy += k * p.y; sxx += k * p.x * p.x; sxy += k * p.x * p.y; });
        const d = sw * sxx - sx * sx;
        if (Math.abs(d) < 1e-12) return { m: 0, c: sy / Math.max(sw, 1e-12) };
        const m = (sw * sxy - sx * sy) / d;
        return { m, c: (sy - m * sx) / sw };
    }
    /** Iteratively reweighted least squares for an M-estimator given its weight function w(r). */
    function irls(pts, weight, iters) {
        let f = wls(pts);
        for (let k = 0; k < (iters || 80); k += 1) f = wls(pts, pts.map(p => weight(p.y - (f.m * p.x + f.c))));
        return f;
    }
    const huberWeight = d => r => (Math.abs(r) <= d ? 1 : d / Math.abs(r));
    const l1Weight = r => 1 / Math.max(Math.abs(r), 1e-3);
    const fits = (pts, delta) => ({ l2: wls(pts), l1: irls(pts, l1Weight, 120), huber: irls(pts, huberWeight(delta), 80) });

    const sigmoid = z => 1 / (1 + Math.exp(-z));
    /** Losses as a function of the margin m = y * score for a true label y = +1. */
    const marginLoss = {
        zeroOne: m => (m > 0 ? 0 : 1),
        hinge: m => Math.max(0, 1 - m),
        logistic: m => Math.log1p(Math.exp(-m)),
        squared: m => (1 - m) * (1 - m),
        focal: (m, g) => { const p = sigmoid(m); return Math.pow(1 - p, g) * -Math.log(Math.max(p, 1e-12)); },
    };
    /** Share of the total loss carried by the "easy" examples, for cross-entropy (gamma = 0) or focal loss. */
    function easyShare(easyFraction, pEasy, pHard, gamma) {
        const lossOf = p => Math.pow(1 - p, gamma) * -Math.log(p);
        const easy = easyFraction * lossOf(pEasy), hard = (1 - easyFraction) * lossOf(pHard);
        return easy / (easy + hard);
    }

    /** Heteroscedastic regression: a line for the mean and a log-variance that is linear in x. */
    function fitHetero(pts) {
        let f = wls(pts), a = 0, b = 0;
        for (let it = 0; it < 25; it += 1) {
            const w = pts.map(p => 1 / Math.exp(a + b * p.x));
            f = wls(pts, w);
            const z = pts.map(p => ({ x: p.x, y: Math.log(Math.max((p.y - (f.m * p.x + f.c)) ** 2, 1e-6)) + 1.2704 }));
            const g = wls(z); a = g.c; b = g.m;
        }
        return { mean: f, a, b, sigma: x => Math.sqrt(Math.exp(clamp(a + b * x, -9, 9))) };
    }
    const nll = (r, s) => 0.5 * (Math.log(2 * Math.PI * s * s) + (r * r) / (s * s));

    /** The recommendation table behind the "which loss?" chooser. */
    function recommend(task, data, care) {
        const R = (loss, formula, why, watch, where) => ({ loss, formula, why, watch, where });
        if (task === 'policy') return R('No loss at all: a score (fitness or return)', 'F(θ) = total reward of a whole episode',
            'When the controller is spiking, the world is a simulator, or the score only exists at the end of a run, there is nothing to differentiate. Evolution or a policy-gradient method needs only a number to rank candidates.',
            'The score is the specification. A reward that can be gamed will be gamed; FlyKart’s 18 reward terms exist because each loophole needed one. Compare candidates on the same episodes.', '#guided-training');
        if (task === 'rank') return R('Contrastive / triplet loss (InfoNCE)', 'L = −log( e^{s⁺/τ} / Σ e^{s/τ} )',
            'You care about order or similarity, not absolute values. Pull a positive pair together and push negatives away, relative to each other.',
            'Quality depends on the negatives you sample, and on the temperature τ. Easy negatives teach nothing.', '#fusion-lab');
        if (task === 'density') return R('Gaussian negative log-likelihood (or pinball loss for quantiles)', 'L = ½ log σ² + (y − μ)² / (2σ²)',
            'The model predicts a mean and its own uncertainty. Wrong and confident costs far more than wrong and unsure, so σ becomes honest.',
            'Start with the mean alone or σ can swallow the error. Check coverage on held-out data: a ±2σ band should hold about 95 %.', '#loss-uncertainty-lab');
        if (task === 'reg') {
            if (data === 'outliers' || data === 'noisy') return R('Huber loss (or MAE if you want the median)', 'ρ(r) = ½r² if |r| ≤ δ, else δ(|r| − ½δ)',
                'Small errors are treated as honest noise (quadratic, smooth); large ones are capped at a constant pull, so a few bad labels cannot drag the fit.',
                'δ is in the units of the error: scale the targets first, then set δ near 1–1.5× the typical clean residual.', '#loss-fit-lab');
            if (care === 'calibrated') return R('Gaussian negative log-likelihood', 'L = ½ log σ² + (y − μ)² / (2σ²)',
                'You need error bars, not just a number. Training the variance together with the mean makes the bars meaningful.', 'Check calibration: coverage of ±2σ should be near 95 %.', '#loss-uncertainty-lab');
            if (care === 'worst') return R('A high-order norm (p = 4 and up), or a hinge on the tolerance', 'L = mean |r|^p',
                'You are judged by the worst case, so errors should be punished harder than quadratically.',
                'Higher p makes the fit chase the single worst point: the opposite of robust. Do not combine with outliers.', '#loss-fit-lab');
            if (data === 'imbalance') return R('Weighted MSE, or quantile (pinball) loss', 'L = Σ w_i (y_i − ŷ_i)²',
                'The rare large values carry the cost. Weight them in, or train several quantiles to see the tails.', 'Weights act like duplicated data: tune on validation, not on the training loss.', '#loss-fit-lab');
            return R('Mean squared error (MSE)', 'L = (1/n) Σ (y − ŷ)²',
                'Clean data and "on average right" is the goal: MSE is smooth, convex and its minimiser is the mean.',
                'It is not robust. One wild label contributes error² and can dominate. Report RMSE for units that make sense.', '#loss-fit-lab');
        }
        // classification
        if (data === 'imbalance') return R('Class-weighted cross-entropy, or focal loss', 'FL = −(1 − p)^γ log p',
            'Easy majority examples are many and each is nearly right; together they can still dominate the sum. Down-weighting them lets the rare, hard examples teach.',
            'Probabilities from a weighted or focal model are no longer calibrated: recalibrate (temperature scaling) before using them as probabilities.', '#loss-class-lab');
        if (data === 'noisy') return R('Cross-entropy with label smoothing (or a symmetric / bootstrapped loss)', 'target = (1 − ε)·onehot + ε / K',
            'Plain cross-entropy keeps pushing toward certainty on labels that may be wrong. Smoothing caps how confident it is allowed to be.',
            'Smoothing slightly hurts calibration in the other direction; measure it.', '#loss-class-lab');
        if (care === 'calibrated') return R('Cross-entropy (log loss), then temperature scaling', 'L = −log p_true',
            'It is a proper scoring rule: its minimum is reached by reporting the true probability, so it rewards honest confidence.',
            'Large networks still overshoot confidence: fit one temperature on held-out data.', '#loss-class-lab');
        return R('Cross-entropy (log loss)', 'L = −log p_true',
            'The default for a reason: smooth, convex in the logits, a proper scoring rule, and its gradient (p − y) does not vanish when the model is confidently wrong.',
            'A hinge or squared loss on probabilities is a worse partner for a sigmoid or softmax output.', '#loss-class-lab');
    }

    root.EduLabs = root.EduLabs || {};
    root.EduLabs.loss = { wls, irls, fits, huberWeight, l1Weight, sigmoid, marginLoss, easyShare, fitHetero, nll, recommend };
    if (typeof document === 'undefined') return;

    /* ------------------------------ Lab 11.1 ------------------------------ */
    (function fitLab() {
        const c = K.canvas('lossFitCanvas', true);
        if (!c) return;
        const NOISE = [0.7, -1.1, 0.4, 1.3, -0.5, 0.2, -0.9, 0.8, -0.3, 0.6];
        const defaults = [{ x: 8.6, y: 0.4 }, { x: 1.6, y: 9.3 }, { x: 9.6, y: 10 }];
        let outliers = defaults.map(p => ({ ...p })), drag = -1;

        function data() {
            const noise = K.num('lfNoise'); const pts = [];
            for (let i = 0; i < 10; i += 1) { const x = 0.5 + i; pts.push({ x, y: 1 + 0.8 * x + noise * NOISE[i] }); }
            const n = K.num('lfOutliers');
            return { clean: pts, bad: outliers.slice(0, n) };
        }
        function draw() {
            const { ctx } = c; K.bg(c);
            const d = data(); const all = d.clean.concat(d.bad); const delta = K.num('lfDelta');
            const f = fits(all, delta);
            const box = { x: 46, y: 30, w: 540, h: 330 };
            const A = K.axes(ctx, box, { x0: 0, x1: 10, y0: -1, y1: 11, xt: [0, 2, 4, 6, 8, 10], yt: [0, 2, 4, 6, 8, 10], title: 'data and the line each loss would choose' });
            const line = (m, cc, color, w, dash) => K.polyline(ctx, [[A.X(0), A.Y(cc)], [A.X(10), A.Y(m * 10 + cc)]], color, w, dash);
            line(0.8, 1, COL.dim, 1.5, [5, 5]);
            line(f.l2.m, f.l2.c, COL.red, 2.4); line(f.l1.m, f.l1.c, COL.cyan, 2.4); line(f.huber.m, f.huber.c, COL.amber, 2.4);
            d.clean.forEach(p => { ctx.fillStyle = COL.white; ctx.beginPath(); ctx.arc(A.X(p.x), A.Y(p.y), 4.5, 0, 7); ctx.fill(); });
            d.bad.forEach(p => { ctx.fillStyle = COL.violet; ctx.strokeStyle = COL.white; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(A.X(p.x), A.Y(p.y), 7, 0, 7); ctx.fill(); ctx.stroke(); });
            K.text(ctx, 'drag the purple points', box.x + 8, box.y + 16, COL.violet, '700 11px system-ui');
            // legend
            [['truth (dashed)', COL.dim], ['MSE · L2', COL.red], ['MAE · L1', COL.cyan], ['Huber', COL.amber]].forEach((e, i) => { K.text(ctx, '● ' + e[0], box.x + 8 + i * 118, box.y + box.h + 34, e[1], '700 11px system-ui'); });
            // loss shapes
            const b1 = { x: 640, y: 30, w: 240, h: 140 }; const R = 4;
            const rho = { l2: r => 0.5 * r * r, l1: r => Math.abs(r), h: r => (Math.abs(r) <= delta ? 0.5 * r * r : delta * (Math.abs(r) - 0.5 * delta)) };
            const B1 = K.axes(ctx, b1, { x0: -R, x1: R, y0: 0, y1: 8, xt: [-4, -2, 0, 2, 4], yt: [0, 4, 8], title: 'penalty ρ(r) for a residual r' });
            [['l2', COL.red], ['l1', COL.cyan], ['h', COL.amber]].forEach(([k, col]) => { const pts = []; for (let r = -R; r <= R + 1e-9; r += 0.1) pts.push([B1.X(r), B1.Y(Math.min(8, rho[k](r)))]); K.polyline(ctx, pts, col, 2); });
            const b2 = { x: 640, y: 225, w: 240, h: 120 };
            const B2 = K.axes(ctx, b2, { x0: -R, x1: R, y0: -4, y1: 4, xt: [-4, -2, 0, 2, 4], yt: [-4, 0, 4], title: 'pull on the fit ρ′(r): how hard a point tugs' });
            const psi = { l2: r => r, l1: r => Math.sign(r), h: r => clamp(r, -delta, delta) };
            [['l2', COL.red], ['l1', COL.cyan], ['h', COL.amber]].forEach(([k, col]) => { const pts = []; for (let r = -R; r <= R + 1e-9; r += 0.1) pts.push([B2.X(r), B2.Y(psi[k](r))]); K.polyline(ctx, pts, col, 2); });
            // readouts
            const dev = fit => { let s = 0; for (let x = 0; x <= 10; x += 0.5) s += Math.abs(fit.m * x + fit.c - (0.8 * x + 1)); return s / 21; };
            K.out('lfSlopeL2', 'slope ' + K.fmt(f.l2.m)); K.out('lfSlopeL1', 'slope ' + K.fmt(f.l1.m)); K.out('lfSlopeHub', 'slope ' + K.fmt(f.huber.m));
            K.out('lfErrL2', K.fmt(dev(f.l2))); K.out('lfErrL1', K.fmt(dev(f.l1))); K.out('lfErrHub', K.fmt(dev(f.huber)));
            K.out('lfDeltaValue', delta.toFixed(1)); K.out('lfNoiseValue', K.num('lfNoise').toFixed(2)); K.out('lfOutValue', String(K.num('lfOutliers')));
            c.map = A;
        }
        const hit = e => { const p = c.pos(e), n = K.num('lfOutliers'); let best = -1, bd = 22; for (let i = 0; i < n; i += 1) { const d = Math.hypot(c.map.X(outliers[i].x) - p.x, c.map.Y(outliers[i].y) - p.y); if (d < bd) { bd = d; best = i; } } return best; };
        c.el.addEventListener('pointerdown', e => { drag = hit(e); if (drag >= 0) c.el.setPointerCapture(e.pointerId); });
        c.el.addEventListener('pointermove', e => {
            if (drag < 0) return; const p = c.pos(e), A = c.map;
            outliers[drag].x = clamp(0 + (p.x - A.X(0)) / (A.X(10) - A.X(0)) * 10, 0, 10);
            outliers[drag].y = clamp(-1 + (A.Y(-1) - p.y) / (A.Y(-1) - A.Y(11)) * 12, -1, 11);
            draw();
        });
        const end = () => { drag = -1; }; c.el.addEventListener('pointerup', end); c.el.addEventListener('pointercancel', end);
        K.on(['lfDelta', 'lfNoise', 'lfOutliers'], draw);
        const reset = document.getElementById('lfReset'); if (reset) reset.addEventListener('click', () => { outliers = defaults.map(p => ({ ...p })); K.setValue('lfOutliers', 1); draw(); });
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 11.2 ------------------------------ */
    (function classLab() {
        const c = K.canvas('lossClsCanvas');
        if (!c) return;
        function draw() {
            const { ctx } = c; K.bg(c);
            const m0 = K.num('lcMargin'), g = K.num('lcGamma');
            const box = { x: 46, y: 34, w: 470, h: 296 };
            const A = K.axes(ctx, box, { x0: -4, x1: 4, y0: 0, y1: 5, xt: [-4, -2, 0, 2, 4], yt: [0, 1, 2, 3, 4, 5], title: 'loss versus margin (score × label; right of 0 = correct)' });
            const curves = [['0–1 (accuracy)', m => marginLoss.zeroOne(m), COL.dim], ['hinge', m => marginLoss.hinge(m), COL.cyan], ['squared', m => marginLoss.squared(m), COL.red], ['cross-entropy', m => marginLoss.logistic(m), COL.amber], ['focal γ=' + g, m => marginLoss.focal(m, g), COL.green]];
            curves.forEach(([, f, col]) => { const pts = []; for (let m = -4; m <= 4.001; m += 0.05) pts.push([A.X(m), A.Y(Math.min(5, f(m)))]); K.polyline(ctx, pts, col, 2.2); });
            ctx.strokeStyle = COL.white; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(A.X(m0), box.y); ctx.lineTo(A.X(m0), box.y + box.h); ctx.stroke(); ctx.setLineDash([]);
            curves.forEach(([n, f, col], i) => { K.text(ctx, '● ' + n + '  ' + K.fmt(f(m0)), box.x + 8 + (i % 3) * 150, box.y + box.h + 34 + Math.floor(i / 3) * 18, col, '700 11px system-ui'); });
            // right: who carries the loss?
            const pe = K.num('lcEasyP'), ph = K.num('lcHardP'), fe = K.num('lcEasy') / 100;
            const shCE = easyShare(fe, pe, ph, 0), shFL = easyShare(fe, pe, ph, g);
            K.text(ctx, 'who carries the total loss?', 560, 40, COL.text, '700 11px system-ui');
            K.text(ctx, (fe * 100).toFixed(1) + ' % of examples are easy (p = ' + pe.toFixed(2) + '),', 560, 58, COL.dim, '11px system-ui');
            K.text(ctx, 'the rest are hard (p = ' + ph.toFixed(2) + ')', 560, 72, COL.dim, '11px system-ui');
            [['cross-entropy', shCE, 110], ['focal γ=' + g, shFL, 190]].forEach(([label, share, y]) => {
                K.text(ctx, label, 560, y - 8, COL.text, '700 11px system-ui');
                ctx.fillStyle = COL.violet; ctx.fillRect(560, y, 320 * (1 - share), 26);
                ctx.fillStyle = COL.amber; ctx.fillRect(560 + 320 * (1 - share), y, 320 * share, 26);
                K.text(ctx, 'hard ' + ((1 - share) * 100).toFixed(0) + ' %', 566, y + 17, '#12121f', '700 11px system-ui');
                if (share > 0.12) K.text(ctx, 'easy ' + (share * 100).toFixed(0) + ' %', 560 + 320 * (1 - share) + 6, y + 17, '#2b2108', '700 11px system-ui');
            });
            K.text(ctx, 'Violet = hard examples (the ones worth learning from), amber = easy ones.', 560, 260, COL.dim, '10px system-ui');
            const p = sigmoid(m0);
            K.text(ctx, 'at this margin the model gives p(correct) = ' + p.toFixed(3), 560, 292, COL.text, '11px system-ui');
            K.text(ctx, 'slope of cross-entropy ' + K.fmt(-(1 - p), 3) + ',  of squared ' + K.fmt(2 * (m0 - 1), 2), 560, 310, COL.text, '11px system-ui');
            K.text(ctx, 'squared loss also punishes being too right (m > 1).', 560, 328, COL.dim, '10px system-ui');
            K.out('lcMarginValue', K.fmt(m0, 1)); K.out('lcGammaValue', g.toFixed(1)); K.out('lcEasyValue', (fe * 100).toFixed(1) + ' %'); K.out('lcEasyPValue', pe.toFixed(2)); K.out('lcHardPValue', ph.toFixed(2));
            K.out('lcShareCE', (shCE * 100).toFixed(0) + ' % easy'); K.out('lcShareFL', (shFL * 100).toFixed(0) + ' % easy');
            K.out('lcPCorrect', p.toFixed(3));
        }
        K.on(['lcMargin', 'lcGamma', 'lcEasy', 'lcEasyP', 'lcHardP'], draw);
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 11.3 ------------------------------ */
    (function uncertaintyLab() {
        const c = K.canvas('lossNllCanvas');
        if (!c) return;
        let seed = 11;
        function sample(n, het, rand) {
            const pts = [];
            for (let i = 0; i < n; i += 1) { const x = rand() * 10; pts.push({ x, y: 0.6 + 0.5 * x + K.gauss(rand) * (0.15 + het * 0.25 * x) }); }
            return pts;
        }
        function draw() {
            const { ctx } = c; K.bg(c);
            const het = K.num('lnHet'), n = Math.round(K.num('lnN'));
            const train = sample(n, het, K.rng(seed)), test = sample(800, het, K.rng(seed + 977));
            const lin = wls(train); let ss = 0; train.forEach(p => { ss += (p.y - (lin.m * p.x + lin.c)) ** 2; });
            const sConst = Math.sqrt(ss / n);
            const hf = fitHetero(train);
            let nllC = 0, nllH = 0, covC = 0, covH = 0, nHi = 0, covCHi = 0, covHHi = 0;
            test.forEach(p => {
                const r = p.y - (hf.mean.m * p.x + hf.mean.c), rc = p.y - (lin.m * p.x + lin.c), sh = hf.sigma(p.x);
                nllC += nll(rc, sConst); nllH += nll(r, sh);
                const inC = Math.abs(rc) <= 2 * sConst, inH = Math.abs(r) <= 2 * sh;
                covC += inC ? 1 : 0; covH += inH ? 1 : 0;
                if (p.x > 7) { nHi += 1; covCHi += inC ? 1 : 0; covHHi += inH ? 1 : 0; }
            });
            const T = test.length;
            const box = { x: 46, y: 30, w: 820, h: 290 };
            const A = K.axes(ctx, box, { x0: 0, x1: 10, y0: -4, y1: 12, xt: [0, 2, 4, 6, 8, 10], yt: [-4, 0, 4, 8, 12], title: 'a line plus an error band: constant width (MSE) versus width the model predicts (Gaussian NLL)' });
            // constant band
            ctx.fillStyle = 'rgba(248,113,113,.14)'; ctx.beginPath();
            ctx.moveTo(A.X(0), A.Y(lin.c + 2 * sConst)); ctx.lineTo(A.X(10), A.Y(lin.m * 10 + lin.c + 2 * sConst)); ctx.lineTo(A.X(10), A.Y(lin.m * 10 + lin.c - 2 * sConst)); ctx.lineTo(A.X(0), A.Y(lin.c - 2 * sConst)); ctx.closePath(); ctx.fill();
            K.polyline(ctx, [[A.X(0), A.Y(lin.c + 2 * sConst)], [A.X(10), A.Y(lin.m * 10 + lin.c + 2 * sConst)]], COL.red, 1.5, [5, 4]);
            K.polyline(ctx, [[A.X(0), A.Y(lin.c - 2 * sConst)], [A.X(10), A.Y(lin.m * 10 + lin.c - 2 * sConst)]], COL.red, 1.5, [5, 4]);
            // learned band
            const up = [], dn = [];
            for (let x = 0; x <= 10.001; x += 0.25) { const mu = hf.mean.m * x + hf.mean.c, s = hf.sigma(x); up.push([A.X(x), A.Y(mu + 2 * s)]); dn.push([A.X(x), A.Y(mu - 2 * s)]); }
            ctx.fillStyle = 'rgba(134,239,172,.2)'; ctx.beginPath(); up.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); dn.slice().reverse().forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.fill();
            K.polyline(ctx, up, COL.green, 1.8); K.polyline(ctx, dn, COL.green, 1.8);
            K.polyline(ctx, [[A.X(0), A.Y(hf.mean.c)], [A.X(10), A.Y(hf.mean.m * 10 + hf.mean.c)]], COL.white, 2);
            train.forEach(p => { ctx.fillStyle = COL.cyan; ctx.beginPath(); ctx.arc(A.X(p.x), A.Y(p.y), 3, 0, 7); ctx.fill(); });
            K.text(ctx, '● training data', box.x + 8, box.y + box.h + 34, COL.cyan, '700 11px system-ui');
            K.text(ctx, '- - constant ±2σ (from MSE)', box.x + 130, box.y + box.h + 34, COL.red, '700 11px system-ui');
            K.text(ctx, '■ learned ±2σ (from NLL)', box.x + 330, box.y + box.h + 34, COL.green, '700 11px system-ui');
            K.out('lnHetValue', het.toFixed(2)); K.out('lnNValue', String(n));
            K.out('lnNllC', K.fmt(nllC / T)); K.out('lnNllH', K.fmt(nllH / T));
            K.out('lnCovC', (covC / T * 100).toFixed(0) + ' %'); K.out('lnCovH', (covH / T * 100).toFixed(0) + ' %');
            K.out('lnCovCHi', nHi ? (covCHi / nHi * 100).toFixed(0) + ' %' : '—'); K.out('lnCovHHi', nHi ? (covHHi / nHi * 100).toFixed(0) + ' %' : '—');
        }
        K.on(['lnHet', 'lnN'], draw);
        const again = document.getElementById('lnResample'); if (again) again.addEventListener('click', () => { seed += 17; draw(); });
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 11.4 ------------------------------ */
    (function chooser() {
        const outEl = K.$('chooseOut'); if (!outEl) return;
        function render() {
            const r = recommend(K.$('chooseTask').value, K.$('chooseData').value, K.$('chooseCare').value);
            outEl.innerHTML = '<div class="choose-card"><span class="choose-kicker">Suggested</span><h5>' + r.loss + '</h5>' +
                '<code>' + r.formula + '</code><p><b>Why.</b> ' + r.why + '</p><p><b>Watch out.</b> ' + r.watch + '</p>' +
                '<a href="' + r.where + '">See it in a lab ↓</a></div>';
        }
        ['chooseTask', 'chooseData', 'chooseCare'].forEach(id => K.$(id).addEventListener('change', render));
        render();
    })();
})(typeof window !== 'undefined' ? window : globalThis);
