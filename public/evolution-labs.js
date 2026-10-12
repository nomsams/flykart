// Chapter 13 · Undesired traits: pedigrees and the inbreeding coefficient, an inbreeding-depression simulator,
// selection on a beak-like trait with a founder bottleneck, and diversity collapse in an evolutionary algorithm.
// Needs edu-common.js. Pure functions are exposed on EduLabs.evo so they can be tested without a page.
(function (root) {
    'use strict';
    const K = root.EduKit;
    const { clamp, COL } = K;

    /* ------------------------------ pedigrees ------------------------------ */
    // Individuals are listed oldest first; sire/dam are indexes into the list (or -1 for founders).
    function kinship(ped, i, j, memo) {
        memo = memo || new Map();
        const key = i < j ? i + ',' + j : j + ',' + i;
        if (memo.has(key)) return memo.get(key);
        let v;
        if (i === j) { const p = ped[i]; v = 0.5 * (1 + (p.sire >= 0 && p.dam >= 0 ? kinship(ped, p.sire, p.dam, memo) : 0)); }
        else {
            const a = Math.max(i, j), b = Math.min(i, j), p = ped[a];
            v = p.sire < 0 ? 0 : 0.5 * (kinship(ped, p.sire, b, memo) + kinship(ped, p.dam, b, memo));
        }
        memo.set(key, v); return v;
    }
    const inbreeding = (ped, i) => (ped[i].sire >= 0 && ped[i].dam >= 0 ? kinship(ped, ped[i].sire, ped[i].dam) : 0);
    // Each preset: individuals with (name, sire, dam, generation row, x position 0..1) and the offspring to evaluate.
    const PEDIGREES = {
        unrelated: { title: 'Unrelated parents', people: [['A', -1, -1, 0, 0.2], ['B', -1, -1, 0, 0.35], ['C', -1, -1, 0, 0.65], ['D', -1, -1, 0, 0.8], ['S', 0, 1, 1, 0.28], ['T', 2, 3, 1, 0.72], ['X', 4, 5, 2, 0.5]], note: 'No common ancestor, so no path can carry the same allele to both parents.' },
        halfsibs: { title: 'Half-siblings', people: [['Sire', -1, -1, 0, 0.5], ['M1', -1, -1, 0, 0.25], ['M2', -1, -1, 0, 0.75], ['S', 0, 1, 1, 0.3], ['T', 0, 2, 1, 0.7], ['X', 3, 4, 2, 0.5]], note: 'One shared parent: one common ancestor, two steps either side.' },
        fullsibs: { title: 'Full siblings', people: [['Sire', -1, -1, 0, 0.35], ['Dam', -1, -1, 0, 0.65], ['S', 0, 1, 1, 0.3], ['T', 0, 1, 1, 0.7], ['X', 2, 3, 2, 0.5]], note: 'Two common ancestors; each path goes through just one generation.' },
        cousins: { title: 'First cousins', people: [['G1', -1, -1, 0, 0.35], ['G2', -1, -1, 0, 0.65], ['U1', -1, -1, 1, 0.08], ['P1', 0, 1, 1, 0.3], ['P2', 0, 1, 1, 0.7], ['U2', -1, -1, 1, 0.92], ['C1', 3, 2, 2, 0.2], ['C2', 4, 5, 2, 0.8], ['X', 6, 7, 3, 0.5]], note: 'Two common ancestors (the grandparents); each path is three generations long.' },
        parentchild: { title: 'Parent × offspring', people: [['Sire', -1, -1, 0, 0.35], ['Dam', -1, -1, 0, 0.65], ['Daughter', 0, 1, 1, 0.65], ['X', 0, 2, 2, 0.5]], note: 'The sire is both a parent and a grandparent of the offspring.' },
        uncle: { title: 'Uncle × niece', people: [['G1', -1, -1, 0, 0.35], ['G2', -1, -1, 0, 0.65], ['Uncle', 0, 1, 1, 0.25], ['Mum', 0, 1, 1, 0.65], ['Mate', -1, -1, 1, 0.9], ['Niece', 4, 3, 2, 0.78], ['X', 2, 5, 3, 0.5]], note: 'The uncle shares both grandparents with the niece’s mother.' },
    };
    const sibMatingSeries = gens => { const F = [0, 0]; for (let t = 1; t <= gens; t += 1) F.push((1 + 2 * F[t] + F[t - 1]) / 4); return F.slice(1); };
    const driftSeries = (N, gens) => Array.from({ length: gens + 1 }, (_, t) => 1 - Math.pow(1 - 1 / (2 * N), t));
    const selfingSeries = gens => { const F = [0]; for (let t = 1; t <= gens; t += 1) F.push((1 + F[t - 1]) / 2); return F; };

    /* ------------------------------ inbreeding-depression simulator ------------------------------ */
    const LOCI = 40;                                         // 2 x 20-bit masks per haplotype
    const MASK = (1 << 20) - 1;
    const POPC = new Uint8Array(1024); for (let i = 1; i < 1024; i += 1) POPC[i] = POPC[i >> 1] + (i & 1);
    const pc = v => POPC[v & 1023] + POPC[(v >>> 10) & 1023];
    function newIndividual(rand, q, id) {
        let a0 = 0, a1 = 0, b0 = 0, b1 = 0;
        for (let l = 0; l < 20; l += 1) { if (rand() < q) a0 |= 1 << l; if (rand() < q) a1 |= 1 << l; if (rand() < q) b0 |= 1 << l; if (rand() < q) b1 |= 1 << l; }
        return { a0, a1, b0, b1, id, sire: -1, dam: -1, w: 1 };
    }
    const fitnessOf = (p, s) => Math.pow(1 - s, pc(p.a0 & p.b0) + pc(p.a1 & p.b1));
    const related = (x, y) => x.id === y.sire || x.id === y.dam || y.id === x.sire || y.id === x.dam || (x.sire >= 0 && (x.sire === y.sire || x.sire === y.dam)) || (x.dam >= 0 && (x.dam === y.sire || x.dam === y.dam));
    function simulate(o) {
        const rand = K.rng(o.seed); let nextId = 0;
        const make = () => { const p = newIndividual(rand, o.q, nextId++); p.w = fitnessOf(p, o.s); return p; };
        let pop = Array.from({ length: o.N }, make);
        const H0 = 2 * o.q * (1 - o.q);
        const rows = [];
        for (let gen = 0; gen <= o.gens; gen += 1) {
            let fit = 0, het = 0, dele = 0;
            for (const p of pop) { fit += p.w; het += pc(p.a0 ^ p.b0) + pc(p.a1 ^ p.b1); dele += pc(p.a0) + pc(p.a1) + pc(p.b0) + pc(p.b1); }
            het /= pop.length * LOCI; dele /= pop.length * 2 * LOCI;
            rows.push({ fitness: fit / pop.length, het, F: clamp(1 - het / H0, 0, 1), q: dele });
            if (gen === o.gens) break;
            // breeders: the healthiest `top` fraction (ties broken at random)
            const order = pop.map((p, i) => ({ i, f: p.w + rand() * 1e-6 })).sort((x, y) => y.f - x.f);
            const breeders = order.slice(0, Math.max(2, Math.round(o.top * pop.length))).map(e => pop[e.i]);
            const champion = breeders[Math.floor(rand() * breeders.length)];   // this generation's popular sire
            const next = []; let attempts = 0;
            while (next.length < o.N && attempts < 40 * o.N) {
                attempts += 1;
                const dam = breeders[Math.floor(rand() * breeders.length)];
                let sire = breeders[Math.floor(rand() * breeders.length)], tries = 0;
                if (o.rule === 'avoid') { while ((sire === dam || related(sire, dam)) && tries < 40) { sire = breeders[Math.floor(rand() * breeders.length)]; tries += 1; } }
                else if (o.rule === 'kin') { const kin = breeders.filter(b => b !== dam && related(b, dam)); if (kin.length) sire = kin[Math.floor(rand() * kin.length)]; }
                if (o.sireShare > 0 && rand() < o.sireShare && champion !== dam) sire = champion;
                if (sire === dam) continue;
                // free recombination: each parent passes a random mix of its two haplotypes
                const m0 = (rand() * 1048576) | 0, m1 = (rand() * 1048576) | 0, n0 = (rand() * 1048576) | 0, n1 = (rand() * 1048576) | 0;
                const child = { a0: (dam.a0 & m0) | (dam.b0 & ~m0 & MASK), a1: (dam.a1 & m1) | (dam.b1 & ~m1 & MASK), b0: (sire.a0 & n0) | (sire.b0 & ~n0 & MASK), b1: (sire.a1 & n1) | (sire.b1 & ~n1 & MASK), id: nextId++, sire: sire.id, dam: dam.id, w: 1 };
                child.w = fitnessOf(child, o.s);
                if (rand() < child.w || attempts > 8 * o.N) next.push(child);   // viability selection
            }
            while (next.length < o.N) next.push(pop[Math.floor(rand() * pop.length)]);
            for (let k = 0; k < o.mig; k += 1) next[Math.floor(rand() * next.length)] = make();
            pop = next;
        }
        return rows;
    }
    function replicates(o, reps) {
        const runs = Array.from({ length: reps }, (_, r) => simulate({ ...o, seed: o.seed + 977 * r }));
        const mean = key => runs[0].map((_, t) => runs.reduce((a, run) => a + run[t][key], 0) / reps);
        return { runs, fitness: mean('fitness'), het: mean('het'), F: mean('F'), q: mean('q') };
    }

    /* ------------------------------ a quantitative (beak-like) trait ------------------------------ */
    const TRAIT_LOCI = 30;
    function beakRun(o) {
        const rand = K.rng(o.seed);
        const Vg0 = TRAIT_LOCI * 2 * 0.25;                           // allele freq 0.5, effect 1 per allele
        const Ve = Vg0 * (1 - o.h2) / Math.max(o.h2, 0.02);
        const draw = () => { const a = new Uint8Array(2 * TRAIT_LOCI); for (let i = 0; i < a.length; i += 1) a[i] = rand() < 0.5 ? 1 : 0; return a; };
        const gv = a => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i]; return s; };
        const mu0 = TRAIT_LOCI, sd0 = Math.sqrt(Vg0 + Ve);
        let pop = Array.from({ length: o.founders > 0 ? o.founders : o.N }, draw);
        if (o.founders > 0) { // founders breed to fill the island
            const f = pop; pop = Array.from({ length: o.N }, () => { const a = f[Math.floor(rand() * f.length)], b = f[Math.floor(rand() * f.length)], c = new Uint8Array(2 * TRAIT_LOCI); for (let l = 0; l < TRAIT_LOCI; l += 1) { c[2 * l] = a[2 * l + (rand() < 0.5 ? 1 : 0)]; c[2 * l + 1] = b[2 * l + (rand() < 0.5 ? 1 : 0)]; } return c; });
        }
        const rows = []; const stats = [];
        for (let t = 0; t <= o.gens; t += 1) {
            const g = pop.map(gv); const z = g.map(v => (v - mu0 + root.EduKit.gauss(rand) * Math.sqrt(Ve)) / sd0);
            const mean = z.reduce((a, b) => a + b, 0) / z.length;
            const gm = g.reduce((a, b) => a + b, 0) / g.length; const vg = g.reduce((a, b) => a + (b - gm) ** 2, 0) / g.length;
            rows.push({ mean, vg: vg / Vg0, z });
            if (t === o.gens) break;
            const dir = o.mode === 'alternate' ? (Math.floor(t / o.period) % 2 === 0 ? 1 : -1) : 1;
            const hard = o.mode !== 'episodic' || t % o.period === 0;      // episodic: a drought only every `period` years
            const order = pop.map((_, i) => i).sort((a, b) => dir * (z[b] - z[a]));
            const keep = hard ? order.slice(0, Math.max(2, Math.round((1 - o.mort) * pop.length))) : pop.map((_, i) => i);
            const sel = keep.reduce((a, i) => a + z[i], 0) / keep.length;
            stats.push({ S: sel - mean });
            const next = [];
            for (let k = 0; k < o.N; k += 1) {
                const a = pop[keep[Math.floor(rand() * keep.length)]], b = pop[keep[Math.floor(rand() * keep.length)]], c = new Uint8Array(2 * TRAIT_LOCI);
                for (let l = 0; l < TRAIT_LOCI; l += 1) { c[2 * l] = a[2 * l + (rand() < 0.5 ? 1 : 0)]; c[2 * l + 1] = b[2 * l + (rand() < 0.5 ? 1 : 0)]; }
                if (o.mut > 0) for (let i = 0; i < c.length; i += 1) if (rand() < o.mut) c[i] ^= 1;
                next.push(c);
            }
            pop = next;
        }
        return { rows, stats, sd0 };
    }

    /* ------------------------------ a deceptive landscape ------------------------------ */
    const PEAKS = [{ x: 0.22, y: 0.72, h: 0.72, s: 0.2 }, { x: 0.82, y: 0.2, h: 1.0, s: 0.05 }, { x: 0.72, y: 0.82, h: 0.55, s: 0.1 }, { x: 0.15, y: 0.15, h: 0.45, s: 0.08 }];
    const landscape = (x, y) => { let best = 0; for (const p of PEAKS) { const d2 = (x - p.x) ** 2 + (y - p.y) ** 2; best = Math.max(best, p.h * Math.exp(-d2 / (2 * p.s * p.s))); } return best; };
    const clip01 = v => clamp(v, 0, 1);
    const EA_START = [0.5, 0.5, 0];   // sigma 0 = spread uniformly over the whole map
    function eaInit(o, rand) {
        const pop = []; const st = o.start || EA_START;
        for (let i = 0; i < o.pop; i += 1) { const x = st[2] > 0 ? clip01(st[0] + K.gauss(rand) * st[2]) : rand(), y = st[2] > 0 ? clip01(st[1] + K.gauss(rand) * st[2]) : rand(); pop.push({ x, y, f: landscape(x, y), isl: o.islands ? i % 4 : 0 }); }
        return { pop, gen: 0 };
    }
    function eaStep(state, o, rand) {
        let { pop } = state;
        const groups = o.islands ? [0, 1, 2, 3].map(k => pop.filter(p => p.isl === k)) : [pop];
        const next = [];
        groups.forEach((group, gi) => {
            if (!group.length) return;
            let score = group.map(p => p.f);
            if (o.niche) score = group.map((p, i) => { let c = 0; group.forEach(q => { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < 0.15) c += 1 - d / 0.15; }); return p.f / Math.max(c, 1); });
            const order = group.map((_, i) => i).sort((a, b) => score[b] - score[a]);
            const parents = order.slice(0, Math.max(2, Math.round(o.top * group.length))).map(i => group[i]);
            const best = group[order[0]];
            next.push({ ...best });
            while (next.filter(p => p.isl === gi).length < group.length) {
                const p = parents[Math.floor(rand() * parents.length)];
                const x = clip01(p.x + K.gauss(rand) * o.sigma), y = clip01(p.y + K.gauss(rand) * o.sigma);
                next.push({ x, y, f: landscape(x, y), isl: gi });
            }
        });
        // immigrants replace the worst
        if (o.imm > 0) { next.sort((a, b) => a.f - b.f); for (let k = 0; k < Math.min(o.imm, next.length - 1); k += 1) { const x = rand(), y = rand(); next[k] = { x, y, f: landscape(x, y), isl: next[k].isl }; } }
        // island migration
        if (o.islands && (state.gen + 1) % 8 === 0) { for (let k = 0; k < 4; k += 1) { const from = next.filter(p => p.isl === k); const mover = from[Math.floor(rand() * from.length)]; if (mover) mover.isl = (k + 1) % 4; } }
        state.pop = next; state.gen += 1;
    }
    const diversity = pop => { let s = 0, n = 0; for (let i = 0; i < pop.length; i += 3) for (let j = i + 1; j < pop.length; j += 3) { s += Math.hypot(pop[i].x - pop[j].x, pop[i].y - pop[j].y); n += 1; } return n ? s / n : 0; };
    const foundGlobal = pop => pop.some(p => p.f > 0.9);
    function eaTrials(o, trials, gens) {
        let hit = 0, hitGen = 0;
        for (let t = 0; t < trials; t += 1) {
            const rand = K.rng(900 + t * 31); const st = eaInit(o, rand); let found = -1;
            for (let g = 0; g < gens; g += 1) { eaStep(st, o, rand); if (foundGlobal(st.pop)) { found = g; break; } }
            if (found >= 0) { hit += 1; hitGen += found; }
        }
        return { rate: hit / trials, meanGen: hit ? hitGen / hit : null };
    }

    root.EduLabs = root.EduLabs || {};
    root.EduLabs.evo = { kinship, inbreeding, PEDIGREES, sibMatingSeries, driftSeries, selfingSeries, simulate, replicates, beakRun, PEAKS, landscape, eaInit, eaStep, diversity, foundGlobal, eaTrials, LOCI };
    if (typeof document === 'undefined') return;

    /* ------------------------------ Lab 13.1 ------------------------------ */
    (function pedigreeLab() {
        const c = K.canvas('pedCanvas'); if (!c) return;
        function draw() {
            const { ctx } = c; K.bg(c);
            const key = K.$('pdRel').value, P = PEDIGREES[key], ped = P.people.map(([name, sire, dam, row, x]) => ({ name, sire, dam, row, x }));
            const X = ped.length - 1; const F = inbreeding(ped, X);
            const maxRow = Math.max(...ped.map(p => p.row)); const box = { x: 20, y: 36, w: 440, h: 250 };
            const at = p => ({ x: box.x + p.x * box.w, y: box.y + 20 + p.row * (box.h - 40) / Math.max(maxRow, 1) });
            ped.forEach((p, i) => {
                if (p.sire < 0) return; const a = at(p);
                [p.sire, p.dam].forEach(par => { const b = at(ped[par]); ctx.strokeStyle = 'rgba(184,200,190,.55)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke(); });
                void i;
            });
            // common ancestors of the offspring's parents
            const anc = i => { const s = new Set([i]); (function up(j) { const p = ped[j]; [p.sire, p.dam].forEach(a => { if (a >= 0 && !s.has(a)) { s.add(a); up(a); } }); })(i); return s; };
            const ca = new Set([...anc(ped[X].sire)].filter(a => anc(ped[X].dam).has(a)));
            ped.forEach((p, i) => {
                const q = at(p); const isX = i === X, isCA = ca.has(i);
                ctx.fillStyle = isX ? COL.amber : isCA ? COL.violet : '#25483a'; ctx.strokeStyle = COL.white; ctx.lineWidth = isX ? 2.5 : 1.2;
                ctx.beginPath(); ctx.arc(q.x, q.y, isX ? 17 : 13, 0, 7); ctx.fill(); ctx.stroke();
                K.text(ctx, p.name, q.x, q.y + 3.5, isX ? '#2b2108' : '#fff', '700 10px system-ui', 'center');
            });
            K.text(ctx, P.title + ' → offspring X', box.x, 22, COL.text, '700 12px system-ui');
            K.text(ctx, 'violet = common ancestors of X’s two parents', box.x, 318, COL.violet, '700 11px system-ui');
            K.text(ctx, P.note, box.x, 336, COL.dim, '11px system-ui');
            K.text(ctx, 'F(X) = ' + F.toFixed(4) + ' = chance X carries two copies of one ancestral allele', box.x, 354, COL.amber, '700 12px system-ui');
            // right: repeated mating
            const N = K.num('pdN'); const G = 20; const gb = { x: 520, y: 40, w: 360, h: 260 };
            const A = K.axes(ctx, gb, { x0: 0, x1: G, y0: 0, y1: 1, xt: [0, 5, 10, 15, 20], yt: [0, 0.25, 0.5, 0.75, 1], title: 'inbreeding coefficient F over generations of the same mating' });
            const series = [['selfing', selfingSeries(G), COL.red], ['full-sib mating', sibMatingSeries(G), COL.orange], ['random mating, N = ' + N, driftSeries(N, G), COL.cyan]];
            series.forEach(([, s, col]) => K.polyline(ctx, s.map((v, t) => [A.X(t), A.Y(v)]), col, 2.4));
            series.forEach(([n, s, col], i) => K.text(ctx, '● ' + n + '  F₂₀ = ' + s[G].toFixed(2), gb.x + 6, gb.y + gb.h + 30 + i * 16, col, '700 11px system-ui'));
            K.out('pdNValue', String(N)); K.out('pdF', F.toFixed(4)); K.out('pdFrac', F === 0 ? '0' : '1 in ' + Math.round(1 / F)); K.out('pdSib5', sibMatingSeries(5)[5].toFixed(2));
        }
        K.on(['pdRel', 'pdN'], draw); K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 13.2 ------------------------------ */
    (function simLab() {
        const c = K.canvas('inbSimCanvas'); if (!c) return;
        function draw() {
            const { ctx } = c; K.bg(c);
            const o = { N: Math.round(K.num('isN')), q: K.num('isQ'), s: K.num('isS'), top: K.num('isTop') / 100, sireShare: K.num('isSire') / 100, mig: Math.round(K.num('isMig')), rule: K.$('isRule').value, gens: 60, seed: 5 };
            const r = replicates(o, 10);
            const b1 = { x: 48, y: 36, w: 400, h: 280 };
            const A = K.axes(ctx, b1, { x0: 0, x1: 60, y0: 0, y1: 1, xt: [0, 10, 20, 30, 40, 50, 60], yt: [0, 0.25, 0.5, 0.75, 1], title: 'mean fitness (1 = no harmful homozygotes)' });
            r.runs.forEach(run => K.polyline(ctx, run.map((row, t) => [A.X(t), A.Y(row.fitness)]), 'rgba(167,139,250,.35)', 1.2));
            K.polyline(ctx, r.fitness.map((v, t) => [A.X(t), A.Y(v)]), COL.violet, 3);
            const b2 = { x: 500, y: 36, w: 380, h: 280 };
            const B = K.axes(ctx, b2, { x0: 0, x1: 60, y0: 0, y1: 1, xt: [0, 10, 20, 30, 40, 50, 60], yt: [0, 0.25, 0.5, 0.75, 1], title: 'inbreeding F (red) and diversity left (cyan)' });
            K.polyline(ctx, r.F.map((v, t) => [B.X(t), B.Y(v)]), COL.red, 3);
            K.polyline(ctx, r.het.map((v, t) => [B.X(t), B.Y(v / r.het[0])]), COL.cyan, 3);
            K.polyline(ctx, driftSeries(o.N, 60).map((v, t) => [B.X(t), B.Y(Math.pow(1 - 1 / (2 * o.N), t))]), 'rgba(103,232,249,.6)', 1.4, [5, 4]);
            K.text(ctx, 'dashed: the textbook (1 − 1/2N)ᵗ for random mating', b2.x + 6, b2.y + b2.h + 30, COL.dim, '10px system-ui');
            K.text(ctx, 'thin lines = 10 replicate populations, thick = their average', b1.x + 6, b1.y + b1.h + 30, COL.dim, '10px system-ui');
            const last = r.fitness.length - 1, minFit = Math.min(...r.fitness);
            K.out('isNValue', String(o.N)); K.out('isQValue', o.q.toFixed(2)); K.out('isSValue', o.s.toFixed(2)); K.out('isTopValue', Math.round(o.top * 100) + ' %'); K.out('isSireValue', Math.round(o.sireShare * 100) + ' %'); K.out('isMigValue', String(o.mig));
            K.out('isFit0', r.fitness[0].toFixed(2)); K.out('isFitEnd', r.fitness[last].toFixed(2)); K.out('isFEnd', r.F[last].toFixed(2));
            K.out('isMin', minFit.toFixed(2)); K.out('isHet', (r.het[last] / r.het[0] * 100).toFixed(0) + ' %'); K.out('isQEnd', r.q[last].toFixed(2) + ' (start ' + o.q.toFixed(2) + ')');
        }
        let queued = false; const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
        K.on(['isN', 'isQ', 'isS', 'isTop', 'isSire', 'isMig', 'isRule'], later);
        K.presets('isPresets', b => { const d = b.dataset; ['isN', 'isQ', 'isS', 'isTop', 'isSire', 'isMig', 'isRule'].forEach(id => { if (d[id] !== undefined) K.setValue(id, d[id]); }); later(); });
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 13.3 ------------------------------ */
    (function beakLab() {
        const c = K.canvas('beakCanvas'); if (!c) return;
        function draw() {
            const { ctx } = c; K.bg(c);
            const o = { N: Math.round(K.num('bkN')), gens: Math.round(K.num('bkG')), h2: K.num('bkH2'), mort: K.num('bkMort') / 100, mode: K.$('bkMode').value, period: 4, founders: K.checked('bkBottle') ? 4 : 0, mut: K.num('bkMut') / 1000, seed: 17 };
            const r = beakRun(o);
            const b1 = { x: 48, y: 36, w: 410, h: 250 };
            const lo = Math.min(-0.5, ...r.rows.map(x => x.mean)), hi = Math.max(1, ...r.rows.map(x => x.mean));
            const A = K.axes(ctx, b1, { x0: 0, x1: o.gens, y0: lo, y1: hi * 1.05, xt: [0, Math.round(o.gens / 2), o.gens], yt: [Math.round(lo), 0, Math.round(hi)], title: 'mean beak depth (in SDs of the starting population)' });
            K.polyline(ctx, r.rows.map((x, t) => [A.X(t), A.Y(x.mean)]), COL.amber, 3);
            const b2 = { x: 510, y: 36, w: 370, h: 250 };
            const B = K.axes(ctx, b2, { x0: 0, x1: o.gens, y0: 0, y1: 1.05, xt: [0, Math.round(o.gens / 2), o.gens], yt: [0, 0.5, 1], title: 'genetic variation left (1 = at the start)' });
            K.polyline(ctx, r.rows.map((x, t) => [B.X(t), B.Y(Math.min(1.05, x.vg))]), COL.cyan, 3);
            if (o.mode === 'alternate') for (let t = 0; t < o.gens; t += 1) { if (Math.floor(t / o.period) % 2 === 1) { ctx.fillStyle = 'rgba(96,165,250,.09)'; ctx.fillRect(A.X(t), b1.y, A.X(t + 1) - A.X(t), b1.h); } }
            // histogram start vs end
            const hb = { x: 48, y: 320, w: 410, h: 50 };
            const bins = 24, span = [-4, 6]; const hist = z => { const h = new Array(bins).fill(0); z.forEach(v => { const k = Math.floor((v - span[0]) / (span[1] - span[0]) * bins); if (k >= 0 && k < bins) h[k] += 1; }); const m = z.length; return h.map(v => v / m); };
            const h0 = hist(r.rows[0].z), h1 = hist(r.rows[r.rows.length - 1].z), mx = Math.max(...h0, ...h1, 0.01);
            const bw = hb.w / bins;
            h0.forEach((v, i) => { ctx.fillStyle = 'rgba(184,200,190,.45)'; ctx.fillRect(hb.x + i * bw, hb.y + hb.h - v / mx * hb.h, bw - 1, v / mx * hb.h); });
            h1.forEach((v, i) => { ctx.fillStyle = 'rgba(251,191,36,.6)'; ctx.fillRect(hb.x + i * bw + bw * 0.25, hb.y + hb.h - v / mx * hb.h, bw * 0.5, v / mx * hb.h); });
            K.text(ctx, 'distribution of beak depth: grey = first generation, amber = last', hb.x, hb.y - 6, COL.dim, '10px system-ui');
            const S = r.stats[0] ? r.stats[0].S : 0, Rpred = o.h2 * S, Robs = r.rows[1] ? r.rows[1].mean - r.rows[0].mean : 0;
            K.text(ctx, 'first drought: S = ' + K.fmt(S, 2) + ' SD,  predicted R = h²S = ' + K.fmt(Rpred, 2) + ',  observed ' + K.fmt(Robs, 2), 510, 326, COL.text, '11px system-ui');
            K.text(ctx, 'last year: mean ' + K.fmt(r.rows[o.gens].mean, 2) + ' SD, variation left ' + (r.rows[o.gens].vg * 100).toFixed(0) + ' %', 510, 346, COL.amber, '700 11px system-ui');
            K.out('bkNValue', String(o.N)); K.out('bkGValue', String(o.gens)); K.out('bkH2Value', o.h2.toFixed(2)); K.out('bkMortValue', Math.round(o.mort * 100) + ' %'); K.out('bkMutValue', K.num('bkMut').toFixed(1));
            K.out('bkS', K.fmt(S, 2) + ' SD'); K.out('bkRpred', K.fmt(Rpred, 2) + ' SD'); K.out('bkRobs', K.fmt(Robs, 2) + ' SD'); K.out('bkVar', (r.rows[o.gens].vg * 100).toFixed(0) + ' %');
        }
        let queued = false; const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
        K.on(['bkN', 'bkG', 'bkH2', 'bkMort', 'bkMode', 'bkBottle', 'bkMut'], later);
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 13.4 ------------------------------ */
    (function eaLab() {
        const c = K.canvas('eaCanvas'); if (!c) return;
        const map = { x: 10, y: 10, w: 400, h: 400 };
        const img = document.createElement('canvas'); img.width = 100; img.height = 100;
        { const x = img.getContext('2d'); const d = x.createImageData(100, 100); for (let j = 0; j < 100; j += 1) for (let i = 0; i < 100; i += 1) { const f = landscape(i / 99, 1 - j / 99); const k = (j * 100 + i) * 4; d.data[k] = 16 + 60 * f; d.data[k + 1] = 40 + 150 * f; d.data[k + 2] = 34 + 70 * f; d.data[k + 3] = 255; } x.putImageData(d, 0, 0); }
        let state = null, rand = K.rng(1), runSeed = 1, playing = false; const history = [];
        const opts = () => ({ pop: Math.round(K.num('eaPop')), top: K.num('eaTop') / 100, sigma: K.num('eaSigma'), imm: Math.round(K.num('eaImm')), niche: K.checked('eaNiche'), islands: K.checked('eaIsland') });
        function reset() { runSeed += 1; rand = K.rng(runSeed * 7919); state = eaInit(opts(), rand); history.length = 0; history.push({ div: diversity(state.pop), best: Math.max(...state.pop.map(p => p.f)) }); playing = false; K.out('eaPlay', 'Run'); }
        function draw() {
            const { ctx } = c; K.bg(c);
            if (!state) reset();
            ctx.imageSmoothingEnabled = true; ctx.drawImage(img, map.x, map.y, map.w, map.h);
            PEAKS.forEach((p, i) => { ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(map.x + p.x * map.w, map.y + (1 - p.y) * map.h, 12, 0, 7); ctx.stroke(); ctx.setLineDash([]); if (i === 1) K.text(ctx, 'tallest, narrow', map.x + p.x * map.w - 36, map.y + (1 - p.y) * map.h + 26, COL.amber, '700 10px system-ui'); if (i === 0) K.text(ctx, 'broad decoy', map.x + p.x * map.w - 30, map.y + (1 - p.y) * map.h - 18, COL.dim, '10px system-ui'); });
            const cols = [COL.amber, COL.cyan, COL.pink, COL.green];
            state.pop.forEach(p => { ctx.fillStyle = cols[p.isl % 4]; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(map.x + p.x * map.w, map.y + (1 - p.y) * map.h, 4, 0, 7); ctx.fill(); ctx.stroke(); });
            const gb = { x: 480, y: 40, w: 400, h: 180 };
            const A = K.axes(ctx, gb, { x0: 0, x1: 60, y0: 0, y1: 1.05, xt: [0, 15, 30, 45, 60], yt: [0, 0.5, 1], title: 'best fitness (green) and diversity (cyan) by generation' });
            K.polyline(ctx, history.map((h, t) => [A.X(t), A.Y(h.best)]), COL.green, 2.6);
            K.polyline(ctx, history.map((h, t) => [A.X(t), A.Y(Math.min(1, h.div * 2.5))]), COL.cyan, 2.6);
            const o = opts(); const best = history[history.length - 1].best;
            K.text(ctx, 'generation ' + state.gen + '   best fitness ' + best.toFixed(2) + (best > 0.9 ? '   — found the tallest peak' : state.gen > 8 && best > 0.6 ? '   — on a lower peak so far' : ''), 480, 262, best > 0.9 ? COL.amber : COL.text, '700 12px system-ui');
            K.text(ctx, 'diversity (mean distance between individuals) ' + diversity(state.pop).toFixed(3), 480, 282, COL.dim, '11px system-ui');
            K.text(ctx, 'islands are shown in different colours; fitness sharing divides a crowded niche’s reward', 480, 302, COL.dim, '10px system-ui');
            void o;
            K.out('eaPopValue', String(o.pop)); K.out('eaTopValue', Math.round(o.top * 100) + ' %'); K.out('eaSigmaValue', o.sigma.toFixed(2)); K.out('eaImmValue', String(o.imm));
            K.out('eaGen', String(state.gen)); K.out('eaBest', best.toFixed(2)); K.out('eaDiv', diversity(state.pop).toFixed(3));
        }
        function advance() { if (state.gen >= 60) { playing = false; K.out('eaPlay', 'Run'); return; } eaStep(state, opts(), rand); history.push({ div: diversity(state.pop), best: Math.max(...state.pop.map(p => p.f)) }); }
        let acc = 0;
        K.loop(c.el, dt => { if (!playing) return; acc += dt; if (acc > 0.12) { acc = 0; advance(); draw(); } });
        const bind = (id, fn) => { const el = K.$(id); if (el) el.addEventListener('click', fn); };
        bind('eaPlay', () => { if (state.gen >= 60) reset(); playing = !playing; K.out('eaPlay', playing ? 'Pause' : 'Run'); });
        bind('eaStepBtn', () => { advance(); draw(); });
        bind('eaReset', () => { reset(); draw(); });
        bind('eaTrials', () => {
            const o = opts(); const r = eaTrials(o, 60, 60);
            K.out('eaRate', (r.rate * 100).toFixed(0) + ' % of 60 runs, within 60 generations');
        });
        K.on(['eaPop', 'eaTop', 'eaSigma', 'eaImm', 'eaNiche', 'eaIsland'], () => { reset(); draw(); });
        K.presets('eaPresets', b => { const d = b.dataset; ['eaTop', 'eaSigma', 'eaImm', 'eaPop'].forEach(id => { if (d[id] !== undefined) K.setValue(id, d[id]); }); const n = K.$('eaNiche'), i = K.$('eaIsland'); if (n) n.checked = d.niche === '1'; if (i) i.checked = d.island === '1'; reset(); draw(); });
        K.whenVisible(c.el, draw);
    })();
})(typeof window !== 'undefined' ? window : globalThis);
