// Chapter 12 · Graphs: structure metrics and generators, message passing, the computation graph, and the kart brain's own wiring.
// Needs edu-common.js. Pure functions are exposed on EduLabs.graph so they can be tested without a page.
(function (root) {
    'use strict';
    const K = root.EduKit;
    const { clamp, COL } = K;

    /* ------------------------------ pure graph code ------------------------------ */

    function makeGraph(n) { return { n, adj: Array.from({ length: n }, () => new Set()), edges: [] }; }
    function addEdge(g, a, b) {
        if (a === b || g.adj[a].has(b)) return false;
        g.adj[a].add(b); g.adj[b].add(a); g.edges.push([a, b]); return true;
    }
    function ring(n, k) { const g = makeGraph(n); for (let i = 0; i < n; i += 1) for (let j = 1; j <= k / 2; j += 1) addEdge(g, i, (i + j) % n); return g; }
    function smallWorld(n, k, beta, rand) {
        const g = ring(n, k); const out = makeGraph(n);
        g.edges.forEach(([a, b]) => {
            if (rand() < beta) {
                let t = Math.floor(rand() * n), tries = 0;
                while ((t === a || out.adj[a].has(t) || g.adj[a].has(t)) && tries < 50) { t = Math.floor(rand() * n); tries += 1; }
                if (tries < 50) { addEdge(out, a, t); return; }
            }
            addEdge(out, a, b);
        });
        return out;
    }
    function randomGraph(n, p, rand) { const g = makeGraph(n); for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) if (rand() < p) addEdge(g, i, j); return g; }
    function scaleFree(n, m, rand) {
        const g = makeGraph(n); const pool = [];
        for (let i = 0; i <= m && i < n; i += 1) for (let j = 0; j < i; j += 1) { addEdge(g, i, j); pool.push(i, j); }
        for (let v = m + 1; v < n; v += 1) {
            let added = 0, guard = 0;
            while (added < m && guard < 200) { const t = pool[Math.floor(rand() * pool.length)]; if (addEdge(g, v, t)) { pool.push(v, t); added += 1; } guard += 1; }
        }
        return g;
    }
    function star(n) { const g = makeGraph(n); for (let i = 1; i < n; i += 1) addEdge(g, 0, i); return g; }
    function tree(n) { const g = makeGraph(n); for (let i = 1; i < n; i += 1) addEdge(g, i, Math.floor((i - 1) / 2)); return g; }
    function communities(n, pIn, pOut, rand) {
        const g = makeGraph(n); const half = Math.floor(n / 2);
        for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) if (rand() < ((i < half) === (j < half) ? pIn : pOut)) addEdge(g, i, j);
        return g;
    }

    function bfs(g, s) {
        const d = new Array(g.n).fill(-1); d[s] = 0; const q = [s];
        for (let h = 0; h < q.length; h += 1) { const u = q[h]; g.adj[u].forEach(v => { if (d[v] < 0) { d[v] = d[u] + 1; q.push(v); } }); }
        return d;
    }
    function shortestPath(g, a, b) {
        const prev = new Array(g.n).fill(-1), seen = new Array(g.n).fill(false); seen[a] = true; const q = [a];
        for (let h = 0; h < q.length; h += 1) { const u = q[h]; if (u === b) break; g.adj[u].forEach(v => { if (!seen[v]) { seen[v] = true; prev[v] = u; q.push(v); } }); }
        if (!seen[b]) return null;
        const path = [b]; while (path[0] !== a) path.unshift(prev[path[0]]);
        return path;
    }
    function metrics(g) {
        const n = g.n, m = g.edges.length;
        let cc = 0;
        for (let i = 0; i < n; i += 1) {
            const nb = [...g.adj[i]]; const k = nb.length; if (k < 2) continue;
            let links = 0; for (let a = 0; a < k; a += 1) for (let b = a + 1; b < k; b += 1) if (g.adj[nb[a]].has(nb[b])) links += 1;
            cc += links / (k * (k - 1) / 2);
        }
        let sum = 0, pairs = 0, diam = 0; const comp = new Array(n).fill(-1); let comps = 0;
        for (let s = 0; s < n; s += 1) {
            const d = bfs(g, s);
            if (comp[s] < 0) { comps += 1; d.forEach((x, i) => { if (x >= 0) comp[i] = comps; }); }
            for (let t = s + 1; t < n; t += 1) if (d[t] > 0) { sum += d[t]; pairs += 1; if (d[t] > diam) diam = d[t]; }
        }
        const deg = g.adj.map(s => s.size);
        return { n, m, density: n > 1 ? 2 * m / (n * (n - 1)) : 0, avgDegree: n ? 2 * m / n : 0, maxDegree: Math.max(0, ...deg), clustering: n ? cc / n : 0, avgPath: pairs ? sum / pairs : 0, diameter: diam, components: comps, degrees: deg };
    }
    /** Watts–Strogatz sweep: clustering and path length relative to the regular lattice, averaged over seeds. */
    function swSweep(n, k, betas, seeds) {
        const base = metrics(ring(n, k));
        return betas.map(b => {
            let c = 0, l = 0;
            for (let s = 0; s < seeds; s += 1) { const mm = metrics(smallWorld(n, k, b, K.rng(100 + s * 31 + Math.round(b * 1e4)))); c += mm.clustering; l += mm.avgPath; }
            return { beta: b, c: c / seeds / base.clustering, l: l / seeds / base.avgPath };
        });
    }

    /** One round of mean-aggregation message passing with a self loop; alpha mixes new and old (1 = fully new). */
    function propagate(g, h, alpha) {
        return h.map((v, i) => {
            let s = v, c = 1; g.adj[i].forEach(j => { s += h[j]; c += 1; });
            return (1 - alpha) * v + alpha * s / c;
        });
    }
    const spread = h => { const mu = h.reduce((a, b) => a + b, 0) / h.length; return Math.sqrt(h.reduce((a, b) => a + (b - mu) ** 2, 0) / h.length); };

    /** Forward and backward through z = w x + b, p = sigmoid(z), then a loss. Returns every local quantity. */
    function neuron(x, w, b, t, loss) {
        const z = w * x + b, p = 1 / (1 + Math.exp(-z));
        const L = loss === 'ce' ? -(t * Math.log(Math.max(p, 1e-12)) + (1 - t) * Math.log(Math.max(1 - p, 1e-12))) : (p - t) * (p - t);
        const dLdp = loss === 'ce' ? (p - t) / Math.max(p * (1 - p), 1e-12) : 2 * (p - t);
        const dpdz = p * (1 - p);
        const dLdz = dLdp * dpdz;
        return { z, p, L, dLdp, dpdz, dLdz, dLdw: dLdz * x, dLdb: dLdz, dLdx: dLdz * w };
    }

    /** Tarjan's strongly connected components on a directed adjacency list. */
    function scc(n, out) {
        let index = 0; const idx = new Array(n).fill(-1), low = new Array(n).fill(0), on = new Array(n).fill(false), stack = [], comp = new Array(n).fill(-1); let count = 0;
        function visit(v) {
            idx[v] = low[v] = index++; stack.push(v); on[v] = true;
            out[v].forEach(w => { if (idx[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); } else if (on[w]) low[v] = Math.min(low[v], idx[w]); });
            if (low[v] === idx[v]) { let w; do { w = stack.pop(); on[w] = false; comp[w] = count; } while (w !== v); count += 1; }
        }
        for (let v = 0; v < n; v += 1) if (idx[v] < 0) visit(v);
        const size = new Array(count).fill(0); comp.forEach(c => { size[c] += 1; });
        return { comp, count, largest: Math.max(0, ...size) };
    }
    /** Wiring statistics of a recurrent weight matrix R[target * H + source], keeping the strongest `keep` fraction of connections. */
    function wiring(R, H, keep) {
        const mags = []; for (let i = 0; i < H; i += 1) for (let j = 0; j < H; j += 1) if (i !== j) mags.push(Math.abs(R[i * H + j]));
        mags.sort((a, b) => b - a);
        const cut = mags[Math.max(0, Math.min(mags.length - 1, Math.round(keep * mags.length) - 1))];
        const out = Array.from({ length: H }, () => new Set()), edges = [];
        let exc = 0, inh = 0;
        for (let i = 0; i < H; i += 1) for (let j = 0; j < H; j += 1) {
            if (i === j) continue; const w = R[i * H + j];
            if (Math.abs(w) >= cut && Math.abs(w) > 0) { out[j].add(i); edges.push({ from: j, to: i, w }); if (w > 0) exc += 1; else inh += 1; }
        }
        let recip = 0; edges.forEach(e => { if (out[e.to].has(e.from)) recip += 1; });
        const outDeg = out.map(s => s.size), inDeg = new Array(H).fill(0); edges.forEach(e => { inDeg[e.to] += 1; });
        const s = scc(H, out);
        return { edges, exc, inh, reciprocity: edges.length ? recip / edges.length : 0, density: edges.length / (H * (H - 1)), outDeg, inDeg, largestScc: s.largest, sccCount: s.count, cut };
    }
    function shuffledReciprocity(R, H, keep, trials) {
        const flat = []; for (let i = 0; i < H; i += 1) for (let j = 0; j < H; j += 1) if (i !== j) flat.push(R[i * H + j]);
        const r = K.rng(4242); let total = 0;
        for (let t = 0; t < trials; t += 1) {
            const a = flat.slice(); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
            const M = new Array(H * H).fill(0); let k = 0; for (let i = 0; i < H; i += 1) for (let j = 0; j < H; j += 1) if (i !== j) M[i * H + j] = a[k++];
            total += wiring(M, H, keep).reciprocity;
        }
        return total / trials;
    }

    root.EduLabs = root.EduLabs || {};
    root.EduLabs.graph = { makeGraph, ring, smallWorld, randomGraph, scaleFree, star, tree, communities, bfs, shortestPath, metrics, swSweep, propagate, spread, neuron, scc, wiring, shuffledReciprocity };
    if (typeof document === 'undefined') return;

    /* ------------------------------ shared drawing ------------------------------ */
    function circleLayout(n, box) { const cx = box.x + box.w / 2, cy = box.y + box.h / 2, r = Math.min(box.w, box.h) / 2 - 22; return Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(2 * Math.PI * i / n - Math.PI / 2), y: cy + r * Math.sin(2 * Math.PI * i / n - Math.PI / 2) })); }
    function build(type, n, p, seed) {
        const r = K.rng(seed);
        if (type === 'ring') return ring(n, 4);
        if (type === 'small') return smallWorld(n, 4, p, r);
        if (type === 'random') return randomGraph(n, p, r);
        if (type === 'scale') return scaleFree(n, 2, r);
        if (type === 'star') return star(n);
        if (type === 'tree') return tree(n);
        return communities(n, 0.55, p * 0.2, r);
    }

    /* ------------------------------ Lab 12.1 ------------------------------ */
    (function explorer() {
        const c = K.canvas('graphCanvas', true); if (!c) return;
        let seed = 7, pos = [], drag = -1, picks = [], lastKey = '';
        const box = { x: 10, y: 30, w: 560, h: 350 };
        let sweep = null;
        const labels = { ring: 'k = 4 neighbours (fixed)', small: 'β = fraction of edges rewired', random: 'p = chance of each edge', scale: 'm = 2 edges per new node (fixed)', star: 'one hub', tree: 'binary tree', comm: 'chance of a bridge between groups' };
        function current() { return build(K.$('grType').value, Math.round(K.num('grN')), K.num('grP'), seed); }
        function draw() {
            const { ctx } = c; K.bg(c);
            const type = K.$('grType').value, n = Math.round(K.num('grN')), p = K.num('grP');
            const g = current(); const mm = metrics(g);
            const key = type + n; if (key !== lastKey) { pos = circleLayout(n, box); picks = []; lastKey = key; }
            // edges
            const path = picks.length === 2 ? shortestPath(g, picks[0], picks[1]) : null;
            const onPath = new Set(); if (path) for (let i = 0; i + 1 < path.length; i += 1) onPath.add(Math.min(path[i], path[i + 1]) + ':' + Math.max(path[i], path[i + 1]));
            g.edges.forEach(([a, b]) => { const hot = onPath.has(Math.min(a, b) + ':' + Math.max(a, b)); ctx.strokeStyle = hot ? COL.amber : 'rgba(184,200,190,.38)'; ctx.lineWidth = hot ? 3.2 : 1.2; ctx.beginPath(); ctx.moveTo(pos[a].x, pos[a].y); ctx.lineTo(pos[b].x, pos[b].y); ctx.stroke(); });
            const maxD = Math.max(1, mm.maxDegree);
            g.adj.forEach((s, i) => {
                const t = s.size / maxD; const r = 5 + 8 * t;
                ctx.fillStyle = picks.includes(i) ? COL.amber : `hsl(${190 - 150 * t}, 75%, ${48 + 14 * t}%)`; ctx.strokeStyle = COL.white; ctx.lineWidth = picks.includes(i) ? 2.5 : 1;
                ctx.beginPath(); ctx.arc(pos[i].x, pos[i].y, r, 0, 7); ctx.fill(); ctx.stroke();
            });
            K.text(ctx, path ? 'shortest path ' + picks[0] + ' → ' + picks[1] + ': ' + (path.length - 1) + ' hops' : picks.length === 1 ? 'now click a second node' : picks.length === 2 && !path ? 'no path: different components' : 'click two nodes to find their shortest path; drag to rearrange', box.x + 6, 20, path ? COL.amber : COL.dim, '700 11px system-ui');
            K.text(ctx, 'bigger and warmer = more connections', box.x + 6, 394, COL.dim, '10px system-ui');
            // degree histogram
            const hb = { x: 625, y: 40, w: 255, h: 120 }; const counts = {}; mm.degrees.forEach(d => { counts[d] = (counts[d] || 0) + 1; });
            const maxDeg = Math.max(...mm.degrees, 1), maxC = Math.max(...Object.values(counts), 1);
            const H = K.axes(ctx, hb, { x0: -0.5, x1: maxDeg + 0.5, y0: 0, y1: maxC * 1.15, xt: maxDeg <= 12 ? Array.from({ length: maxDeg + 1 }, (_, i) => i) : [0, Math.round(maxDeg / 2), maxDeg], yt: [0, maxC], title: 'degree distribution (how many neighbours)' });
            Object.entries(counts).forEach(([d, k]) => { ctx.fillStyle = COL.cyan; const w = Math.max(3, hb.w / (maxDeg + 1) - 3); ctx.fillRect(H.X(Number(d)) - w / 2, H.Y(k), w, H.Y(0) - H.Y(k)); });
            // small-world sweep
            if (!sweep) sweep = swSweep(60, 6, [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1], 4);
            const sb = { x: 625, y: 225, w: 255, h: 120 };
            const S = K.axes(ctx, sb, { x0: Math.log10(0.001), x1: 0, y0: 0, y1: 1.05, xt: [-3, -2, -1, 0], xf: v => (v === 0 ? '1' : '10^' + v), yt: [0, 0.5, 1], title: 'small-world sweep (N = 60, k = 6)' });
            K.polyline(ctx, sweep.map(s => [S.X(Math.log10(s.beta)), S.Y(s.c)]), COL.amber, 2.2);
            K.polyline(ctx, sweep.map(s => [S.X(Math.log10(s.beta)), S.Y(s.l)]), COL.cyan, 2.2);
            K.text(ctx, '● clustering', sb.x + 4, sb.y + sb.h + 28, COL.amber, '700 10px system-ui'); K.text(ctx, '● path length', sb.x + 90, sb.y + sb.h + 28, COL.cyan, '700 10px system-ui');
            K.text(ctx, '(both relative to the ring; β on a log axis)', sb.x, sb.y + sb.h + 42, COL.dim, '10px system-ui');
            if (type === 'small' && p > 0.001) { const x = S.X(Math.log10(clamp(p, 0.001, 1))); ctx.strokeStyle = COL.white; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, sb.y); ctx.lineTo(x, sb.y + sb.h); ctx.stroke(); ctx.setLineDash([]); }
            K.out('grNValue', String(n)); K.out('grPValue', p.toFixed(2)); K.out('grPHint', labels[type]);
            K.out('grM', String(mm.m)); K.out('grDeg', mm.avgDegree.toFixed(1)); K.out('grClust', mm.clustering.toFixed(2));
            K.out('grPath', mm.avgPath.toFixed(2)); K.out('grDiam', String(mm.diameter)); K.out('grComp', String(mm.components));
            c.g = g;
        }
        const hit = e => { const q = c.pos(e); let best = -1, bd = 18; pos.forEach((P, i) => { const d = Math.hypot(P.x - q.x, P.y - q.y); if (d < bd) { bd = d; best = i; } }); return best; };
        let moved = false;
        c.el.addEventListener('pointerdown', e => { drag = hit(e); moved = false; if (drag >= 0) c.el.setPointerCapture(e.pointerId); });
        c.el.addEventListener('pointermove', e => { if (drag < 0) return; const q = c.pos(e); pos[drag] = { x: clamp(q.x, 8, 572), y: clamp(q.y, 8, 392) }; moved = true; draw(); });
        c.el.addEventListener('pointerup', () => { if (drag >= 0 && !moved) { picks = picks.length >= 2 ? [drag] : picks.concat(drag); draw(); } drag = -1; });
        K.on(['grType', 'grN', 'grP'], draw);
        const again = document.getElementById('grAgain'); if (again) again.addEventListener('click', () => { seed += 13; draw(); });
        K.presets('grPresets', b => { K.setValue('grType', b.dataset.type); K.setValue('grP', b.dataset.p); draw(); });
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 12.2 ------------------------------ */
    (function messagePassing() {
        const c = K.canvas('msgCanvas', true); if (!c) return;
        let spike = 3, g = null, pos = [], keyed = '';
        const box = { x: 10, y: 34, w: 440, h: 320 };
        function values(n, mode) {
            if (mode === 'spike') return Array.from({ length: n }, (_, i) => (i === spike ? 1 : 0));
            if (mode === 'noise') { const r = K.rng(5); return Array.from({ length: n }, () => r()); }
            return Array.from({ length: n }, (_, i) => (i < n / 2 ? 1 : 0));
        }
        function draw() {
            const { ctx } = c; K.bg(c);
            const type = K.$('msGraph').value, mode = K.$('msInit').value, T = Math.round(K.num('msRounds')), skip = K.num('msSkip');
            const n = 24; const key = type; if (key !== keyed || !g) { g = build(type, n, type === 'comm' ? 0.25 : type === 'small' ? 0.1 : 0.15, 21); pos = circleLayout(n, box); keyed = key; }
            if (mode === 'spike' && spike >= n) spike = 0;
            const hist = [values(n, mode)];
            for (let t = 0; t < 30; t += 1) hist.push(propagate(g, hist[t], 1 - skip));
            const h = hist[T];
            g.edges.forEach(([a, b]) => { ctx.strokeStyle = 'rgba(184,200,190,.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pos[a].x, pos[a].y); ctx.lineTo(pos[b].x, pos[b].y); ctx.stroke(); });
            const lo = Math.min(...hist[0]), hi = Math.max(...hist[0]) || 1;
            h.forEach((v, i) => {
                const t = clamp((v - lo) / Math.max(hi - lo, 1e-9), 0, 1);
                ctx.fillStyle = `hsl(${220 - 175 * t}, 80%, ${30 + 36 * t}%)`; ctx.strokeStyle = i === spike && mode === 'spike' ? COL.white : 'rgba(255,255,255,.55)'; ctx.lineWidth = i === spike && mode === 'spike' ? 2.5 : 1;
                ctx.beginPath(); ctx.arc(pos[i].x, pos[i].y, 11, 0, 7); ctx.fill(); ctx.stroke();
                K.text(ctx, v.toFixed(2).replace(/^0\./, '.'), pos[i].x, pos[i].y + 3.5, '#fff', '700 9px system-ui', 'center');
            });
            K.text(ctx, mode === 'spike' ? 'click a node to inject the signal there' : 'feature value on every node after ' + T + ' rounds', 18, 24, COL.dim, '700 11px system-ui');
            // spread vs rounds
            const gb = { x: 500, y: 40, w: 380, h: 270 };
            const X = K.axes(ctx, gb, { x0: 0, x1: 30, y0: 0, y1: Math.max(0.05, spread(hist[0]) * 1.1), xt: [0, 5, 10, 15, 20, 25, 30], yt: [0, +(spread(hist[0]) / 2).toFixed(2), +spread(hist[0]).toFixed(2)], title: 'how different the nodes still are (std. dev.) after t rounds' });
            const sp = hist.map(v => spread(v));
            K.polyline(ctx, sp.map((s, t) => [X.X(t), X.Y(s)]), COL.amber, 2.4);
            ctx.strokeStyle = COL.white; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X.X(T), gb.y); ctx.lineTo(X.X(T), gb.y + gb.h); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = COL.white; ctx.beginPath(); ctx.arc(X.X(T), X.Y(sp[T]), 4.5, 0, 7); ctx.fill();
            K.text(ctx, 'rounds of message passing t', gb.x + gb.w - 150, gb.y + gb.h + 30, COL.dim, '10px system-ui');
            const first = sp[0], half = sp.findIndex(s => s <= first * 0.5);
            K.out('msRoundsValue', String(T)); K.out('msSkipValue', skip.toFixed(2));
            K.out('msSpread', sp[T].toFixed(3)); K.out('msRatio', (sp[T] / Math.max(first, 1e-9) * 100).toFixed(0) + ' %');
            K.out('msHalf', half < 0 ? '> 30' : String(half));
        }
        c.el.addEventListener('pointerdown', e => {
            if (K.$('msInit').value !== 'spike' || !g) return; const q = c.pos(e); let best = -1, bd = 20;
            pos.forEach((P, i) => { const d = Math.hypot(P.x - q.x, P.y - q.y); if (d < bd) { bd = d; best = i; } });
            if (best >= 0) { spike = best; draw(); }
        });
        K.on(['msGraph', 'msInit', 'msRounds', 'msSkip'], draw);
        K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 12.3 ------------------------------ */
    (function autodiff() {
        const c = K.canvas('autodiffCanvas'); if (!c) return;
        const runs = { mse: { w: 0, b: 0, hist: [] }, ce: { w: 0, b: 0, hist: [] } };
        function resetRuns() {
            const w = K.num('adW'), b = K.num('adB');
            ['mse', 'ce'].forEach(k => { runs[k].w = w; runs[k].b = b; runs[k].hist = [neuron(K.num('adX'), w, b, K.num('adT'), 'ce').p]; });
        }
        function stepRuns(times) {
            const x = K.num('adX'), t = K.num('adT'), lr = K.num('adLr');
            for (let s = 0; s < times; s += 1) ['mse', 'ce'].forEach(k => { const r = neuron(x, runs[k].w, runs[k].b, t, k); runs[k].w -= lr * r.dLdw; runs[k].b -= lr * r.dLdb; runs[k].hist.push(neuron(x, runs[k].w, runs[k].b, t, 'ce').p); });
        }
        function node(ctx, x, y, w, h, title, value, grad, color) {
            ctx.fillStyle = '#16261f'; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x, y, w, h, 9); ctx.fill(); ctx.stroke();
            K.text(ctx, title, x + w / 2, y + 16, COL.text, '700 11px system-ui', 'center');
            K.text(ctx, K.fmt(value, 2), x + w / 2, y + 36, COL.white, '700 13px system-ui', 'center');
            if (grad !== null) K.text(ctx, 'gradient ' + K.fmt(grad, 3), x + w / 2, y + h - 8, COL.amber, '700 10px system-ui', 'center');
        }
        function arrow(ctx, x1, y1, x2, y2, color) { ctx.strokeStyle = color || COL.dim; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); const a = Math.atan2(y2 - y1, x2 - x1); ctx.fillStyle = color || COL.dim; ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 8 * Math.cos(a - 0.4), y2 - 8 * Math.sin(a - 0.4)); ctx.lineTo(x2 - 8 * Math.cos(a + 0.4), y2 - 8 * Math.sin(a + 0.4)); ctx.fill(); }
        function draw() {
            const { ctx } = c; K.bg(c);
            const x = K.num('adX'), w = K.num('adW'), b = K.num('adB'), t = K.num('adT'), kind = K.$('adLoss').value;
            const r = neuron(x, w, b, t, kind), other = neuron(x, w, b, t, kind === 'ce' ? 'mse' : 'ce');
            // graph: x,w -> mul -> add(b) -> sigmoid -> loss(t)
            const NW = 92, NH = 58; const row1 = 60, row2 = 160, row3 = 255;
            const mul = { x: 190, y: 108 }, add = { x: 330, y: 108 }, sig = { x: 470, y: 108 }, los = { x: 620, y: 108 };
            arrow(ctx, 112, row1 + 29, mul.x, mul.y + 20); arrow(ctx, 112, row2 + 29, mul.x, mul.y + 40);
            arrow(ctx, mul.x + NW, mul.y + 29, add.x, mul.y + 29); arrow(ctx, 112, row3 + 20, add.x + 30, mul.y + NH);
            arrow(ctx, add.x + NW, add.y + 29, sig.x, sig.y + 29); arrow(ctx, sig.x + NW, sig.y + 29, los.x, los.y + 29);
            arrow(ctx, 794, 196, 704, los.y + NH);
            node(ctx, 20, row1, NW, NH, 'x (input)', x, r.dLdx, COL.cyan); node(ctx, 20, row2, NW, NH, 'w (weight)', w, r.dLdw, COL.violet); node(ctx, 20, row3 - 10, NW, NH, 'b (bias)', b, r.dLdb, COL.violet);
            node(ctx, mul.x, mul.y, NW, NH, 'w × x', w * x, r.dLdz, COL.dim); node(ctx, add.x, add.y, NW, NH, 'z = w x + b', r.z, r.dLdz, COL.dim);
            node(ctx, sig.x, sig.y, NW, NH, 'p = σ(z)', r.p, r.dLdp * 1, COL.green); node(ctx, los.x, los.y, NW + 20, NH, (kind === 'ce' ? 'cross-entropy' : 'squared error'), r.L, 1, COL.amber);
            node(ctx, 744, 196, 100, 46, 'target t', t, null, COL.cyan);
            K.text(ctx, 'forward: values flow left → right.  backward: gradients flow right → left, multiplying local slopes.', 20, 22, COL.dim, '700 11px system-ui');
            K.text(ctx, '∂L/∂z = ∂L/∂p · p(1−p) = ' + K.fmt(r.dLdp, 3) + ' · ' + K.fmt(r.dpdz, 3) + ' = ' + K.fmt(r.dLdz, 3), 20, 318, COL.amber, '700 12px system-ui');
            K.text(ctx, 'same point, the other loss: ∂L/∂z = ' + K.fmt(other.dLdz, 3) + (Math.abs(other.dLdz) > Math.abs(r.dLdz) * 1.5 ? '  (stronger signal)' : ''), 20, 338, COL.dim, '11px system-ui');
            // learning curves
            const gb = { x: 520, y: 268, w: 350, h: 62 };
            // keep the plot below the graph: draw as small inset
            K.out('adXValue', K.fmt(x, 1)); K.out('adWValue', K.fmt(w, 1)); K.out('adBValue', K.fmt(b, 1)); K.out('adLrValue', K.num('adLr').toFixed(1));
            K.out('adP', r.p.toFixed(3)); K.out('adL', K.fmt(r.L, 3)); K.out('adGz', K.fmt(r.dLdz, 3));
            K.out('adGzOther', K.fmt(other.dLdz, 3));
            const last = k => runs[k].hist[runs[k].hist.length - 1];
            K.out('adStepsMse', last('mse').toFixed(2) + ' · ' + (runs.mse.hist.length - 1) + ' steps');
            K.out('adStepsCe', last('ce').toFixed(2) + ' · ' + (runs.ce.hist.length - 1) + ' steps');
            // inset history
            const Hh = K.axes(ctx, gb, { x0: 0, x1: Math.max(10, runs.mse.hist.length - 1), y0: 0, y1: 1, xt: [], yt: [0, 1], title: 'p(correct) while training' });
            [['mse', COL.red], ['ce', COL.green]].forEach(([k, col]) => K.polyline(ctx, runs[k].hist.map((p, i) => [Hh.X(i), Hh.Y(p)]), col, 2));
            K.text(ctx, '● squared', gb.x + 4, gb.y + gb.h + 14, COL.red, '700 10px system-ui'); K.text(ctx, '● cross-entropy', gb.x + 70, gb.y + gb.h + 14, COL.green, '700 10px system-ui');
        }
        K.on(['adX', 'adW', 'adB', 'adT', 'adLoss'], () => { resetRuns(); draw(); });
        K.on(['adLr'], draw);
        const bind = (id, fn) => { const el = K.$(id); if (el) el.addEventListener('click', fn); };
        bind('adStep', () => { stepRuns(1); draw(); }); bind('adRun', () => { stepRuns(40); draw(); }); bind('adReset', () => { resetRuns(); draw(); });
        resetRuns(); K.whenVisible(c.el, draw);
    })();

    /* ------------------------------ Lab 12.4 ------------------------------ */
    (function brainGraph() {
        const c = K.canvas('brainGraphCanvas'); if (!c) return;
        let R = null, H = 0, name = 'loading sample-brain.json…';
        function parse(json) {
            const net = json.network || json; const r = net.recurrentWeights, h = net.hiddenCount;
            if (!Array.isArray(r) || !h || r.length !== h * h) throw new Error('no 48 × 48 recurrent matrix in that file');
            R = r; H = h;
        }
        function draw() {
            const { ctx } = c; K.bg(c);
            if (!R) { K.text(ctx, name, 24, 40, COL.text, '13px system-ui'); return; }
            const keep = K.num('bgKeep') / 100; const w = wiring(R, H, keep);
            const pos = circleLayout(H, { x: 10, y: 4, w: 420, h: 392 });
            const maxW = Math.max(...w.edges.map(e => Math.abs(e.w)), 1e-9);
            w.edges.forEach(e => {
                const a = pos[e.from], b = pos[e.to]; const t = Math.abs(e.w) / maxW;
                ctx.strokeStyle = e.w > 0 ? `rgba(251,191,36,${0.15 + 0.6 * t})` : `rgba(167,139,250,${0.15 + 0.6 * t})`; ctx.lineWidth = 0.6 + 1.8 * t;
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            });
            const maxOut = Math.max(...w.outDeg, 1);
            pos.forEach((P, i) => { const t = w.outDeg[i] / maxOut; ctx.fillStyle = `hsl(${200 - 160 * t}, 70%, ${42 + 18 * t}%)`; ctx.strokeStyle = COL.white; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(P.x, P.y, 3.5 + 5 * t, 0, 7); ctx.fill(); ctx.stroke(); });
            K.text(ctx, 'amber = excitatory, violet = inhibitory; node size = how many others it talks to', 14, 402, COL.dim, '10px system-ui');
            // right: out-degree vs in-degree hubs
            const hb = { x: 480, y: 56, w: 400, h: 130 };
            const maxDeg = Math.max(...w.outDeg, ...w.inDeg, 1);
            const X = K.axes(ctx, hb, { x0: 0, x1: H, y0: 0, y1: maxDeg * 1.1, xt: [0, 12, 24, 36, 48], yt: [0, maxDeg], title: 'out-degree (amber) and in-degree (cyan) of every neuron' });
            const bw = hb.w / H;
            for (let i = 0; i < H; i += 1) { ctx.fillStyle = 'rgba(251,191,36,.85)'; ctx.fillRect(X.X(i), X.Y(w.outDeg[i]), bw / 2 - 0.5, X.Y(0) - X.Y(w.outDeg[i])); ctx.fillStyle = 'rgba(103,232,249,.85)'; ctx.fillRect(X.X(i) + bw / 2, X.Y(w.inDeg[i]), bw / 2 - 0.5, X.Y(0) - X.Y(w.inDeg[i])); }
            const shuf = shuffledReciprocity(R, H, keep, 12);
            const lines = [
                ['connections kept', w.edges.length + ' of ' + H * (H - 1) + '  (' + (w.density * 100).toFixed(0) + ' %)'],
                ['excitatory : inhibitory', w.exc + ' : ' + w.inh],
                ['reciprocal pairs (A→B and B→A)', (w.reciprocity * 100).toFixed(0) + ' %   (same weights shuffled: ' + (shuf * 100).toFixed(0) + ' %)'],
                ['largest strongly connected group', w.largestScc + ' of ' + H + ' neurons'],
                ['strongest connection kept ≥', K.fmt(w.cut, 3)],
            ];
            lines.forEach((l, i) => { K.text(ctx, l[0], 490, 235 + i * 34, COL.dim, '11px system-ui'); K.text(ctx, l[1], 490, 251 + i * 34, COL.white, '700 12px system-ui'); });
            K.text(ctx, name, 480, 18, COL.dim, '10px system-ui');
            K.out('bgKeepValue', (keep * 100).toFixed(0) + ' %');
            K.out('bgEdges', String(w.edges.length)); K.out('bgRecip', (w.reciprocity * 100).toFixed(0) + ' % (shuffled ' + (shuf * 100).toFixed(0) + ' %)'); K.out('bgScc', w.largestScc + ' / ' + H);
        }
        K.on(['bgKeep'], draw);
        const file = K.$('bgFile');
        if (file) file.addEventListener('change', async () => { const f = file.files && file.files[0]; if (!f) return; try { parse(JSON.parse(await f.text())); name = f.name; } catch (e) { name = 'could not read ' + f.name + ': ' + e.message; } draw(); });
        fetch('./sample-brain.json').then(r => (r.ok ? r.json() : Promise.reject(new Error('missing')))).then(j => { parse(j); name = 'public/sample-brain.json (the bundled demo brain)'; draw(); }).catch(() => { name = 'sample-brain.json was not found next to this page; drop a brain file below'; draw(); });
        K.whenVisible(c.el, draw);
    })();
})(typeof window !== 'undefined' ? window : globalThis);
