// The "Evidence" tab: measurements written by `npm run vision:experiments` and the training scripts.
/* eslint-disable @typescript-eslint/no-explicit-any */

const esc = (value: unknown): string => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (value: number, digits = 0): string => `${(value * 100).toFixed(digits)}%`;
const seconds = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : `${value.toFixed(0)} s`);

function table(head: string[], rows: (string | number)[][], classes?: (string | undefined)[][]): string {
  return `<div class="table-scroll"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((row, r) => `<tr>${row.map((cell, c) => `<td${classes?.[r]?.[c] ? ` class="${classes[r][c]}"` : ""}>${cell}</td>`).join("")}</tr>`).join("")}</table></div>`;
}

function gatesHtml(results: any): string {
  const gates: any[] = results?.gates ?? [];
  if (!gates.length) return "";
  return `<div class="verdicts">${gates.map((g) => `<div class="verdict ${esc(g.status)}"><b>${esc(g.title)}</b><span>${esc(g.detail)}</span></div>`).join("")}</div>`;
}

function controllerHtml(data: any): string {
  if (!data?.rows) return "";
  const rows: any[] = data.rows; const brains = [...new Set(rows.map((r) => r.brain))] as string[];
  const levels = [...new Set(rows.map((r) => r.level))] as string[]; const label = (b: string) => (b.includes("sample") ? "v1 demo brain" : "robust controller");
  let html = `<h2>1 · A controller that expects imperfect eyes</h2><p>Laps completed (of the tracks in each group) when the 13 camera-style inputs are corrupted by noise, bias and delay. <b>mild</b> is white noise 0.05 with 2 ticks of delay; <b>brutal</b> is 0.40 white noise plus slowly drifting error and 10 ticks (333 ms) of delay. Untouched inputs are <b>clean</b>.</p>`;
  for (const traffic of [false, true]) {
    html += `<h3>${traffic ? "With rival karts and road objects" : "Alone on the road"}</h3>`;
    const head = ["Tracks", "Controller", ...levels];
    const out: (string | number)[][] = []; const cls: (string | undefined)[][] = [];
    for (const group of ["trained", "unseen", "generated"]) for (const brain of brains) {
      const line: (string | number)[] = [group === "trained" ? "the 7 it trained on" : group === "unseen" ? "8 never trained on" : "4 generated", label(brain)]; const c: (string | undefined)[] = [undefined, undefined];
      for (const level of levels) { const r = rows.find((x) => x.brain === brain && x.level === level && x.traffic === traffic && x.group === group); line.push(r ? `${r.laps}/${r.episodes}` : "—"); c.push(r && brain.includes("sample") ? "dim" : undefined); }
      out.push(line); cls.push(c);
    }
    html += table(head, out, cls);
  }
  return html;
}

function visionHtml(results: any): string {
  const m = results?.vision?.metrics; if (!m) return "";
  const names: string[] = results.vision.names;
  const rows = names.map((name, c) => [esc(name), m.rmse[c].toFixed(3), m.r2[c].toFixed(2), m.calibration[c].toFixed(2), pct(m.coverage[c])]);
  const cls = names.map((_, c) => [undefined, undefined, m.r2[c] > 0.6 ? "good" : m.r2[c] < 0.25 ? "bad" : undefined, m.calibration[c] > 2 || m.calibration[c] < 0.5 ? "bad" : undefined, undefined]);
  return `<h2>2 · What the camera network can see</h2><p>Accuracy on ${esc(m.samples)} frames from tracks it never trained on (${esc(results.vision.heldOut)}). R² = 1 is perfect; 0 is no better than guessing the average. <b>Calibration</b> is the mean squared error divided by the variance the network claimed: 1 means its “±σ” is honest, above 1 means it is overconfident. “Coverage” should be about 95% for ±2σ.</p>${table(["Estimate", "RMSE", "R²", "Calibration", "±2σ coverage"], rows, cls)}<p class="note">${esc(results.vision.network ?? "")}</p>`;
}

function closedLoopHtml(results: any): string {
  const c = results?.closedLoop; if (!c?.rows) return "";
  const rows: any[] = c.rows;
  const body = rows.map((r) => [esc(r.label), `${r.laps}/${r.episodes}`, pct(r.progress), seconds(r.meanLapSeconds), pct(r.offRoad, 1), `${r.strictLaps}/${r.episodes}`, pct(r.strictProgress), r.strictCrashes]);
  return `<h2>3 · Does the kart drive on it?</h2><p>${esc(c.description)}</p>${table(["Driver", "Laps (walls)", "Progress", "Mean lap", "Off-road", "Laps (no walls)", "Progress", "Crashes (no walls)"], body)}`;
}

function memoryHtml(results: any): string {
  const m = results?.memory; if (!m?.rows) return "";
  const rows: any[] = m.rows;
  const one = rows.map((r) => [esc(r.track), seconds(r.laps[0].seconds), seconds(r.laps[1].seconds), seconds(r.laps[2].seconds), r.laps[1].errorCamera.toFixed(3), r.laps[1].errorUsed.toFixed(3), r.wrongPlace.errorUsed.toFixed(3)]);
  const oneClass = rows.map((r) => [undefined, undefined, r.laps[1].seconds !== null && r.laps[0].seconds !== null && r.laps[1].seconds < r.laps[0].seconds - 0.2 ? "good" : undefined, undefined, undefined, r.laps[1].errorUsed < r.laps[1].errorCamera ? "good" : "bad", undefined]);
  const levels: any[] = m.levels ?? [];
  const two = levels.map((l) => [esc(l.label), `${l.finishedWith}/${m.tracks} vs ${l.finishedWithout}/${m.tracks}`, `${pct(l.progressWith)} vs ${pct(l.progressWithout)}`, l.errorCamera.toFixed(3), l.errorUsed.toFixed(3), `${l.errorBetter}/${m.tracks}`, l.bothFinished ? `${l.secondsWith.toFixed(1)} s vs ${l.secondsWithout.toFixed(1)} s (${l.bothFinished} tracks)` : "—"]);
  const twoClass = levels.map((l) => [undefined, l.finishedWith > l.finishedWithout ? "good" : l.finishedWith < l.finishedWithout ? "bad" : undefined, undefined, undefined, l.errorUsed < l.errorCamera ? "good" : "bad", undefined, undefined]);
  const night = rows.map((r) => { const d = r.dark?.night; return d ? [esc(r.track), d.withMemory.finished ? seconds(d.withMemory.seconds) : `stopped at ${pct(d.withMemory.progress)}`, d.withoutMemory.finished ? seconds(d.withoutMemory.seconds) : `stopped at ${pct(d.withoutMemory.progress)}`, d.withMemory.errorCamera.toFixed(3), d.withMemory.errorUsed.toFixed(3)] : [esc(r.track), "—", "—", "—", "—"]; });
  const nightClass = rows.map((r) => { const d = r.dark?.night; return d ? [undefined, d.withMemory.finished && !d.withoutMemory.finished ? "good" : undefined, undefined, undefined, d.withMemory.errorUsed < d.withMemory.errorCamera ? "good" : "bad"] : []; });
  return `<h2>4 · Does the lap memory help?</h2><p>${esc(m.description)}</p><h3>(1) The same light, three laps</h3>${table(["Track", "Lap 1", "Lap 2", "Lap 3", "Error, camera alone (lap 2)", "Error, as used (lap 2)", "Error with another track memory"], one, oneClass)}<h3>(2) Learn in daylight, drive when the light fails (with memory vs without)</h3>${table(["Light on the second lap", "Laps finished", "Mean progress", "Error, camera alone", "Error, as used", "Tracks with lower error", "Lap time where both finished"], two, twoClass)}<h3>Night, track by track</h3>${table(["Track", "With memory", "Without memory", "Error, camera alone", "Error, as used"], night, nightClass)}<p class="note">${esc(m.summary ?? "")}</p>`;
}

function worldHtml(results: any): string {
  const w = results?.world; if (!w?.rows) return "";
  const body = w.rows.map((r: any) => [esc(r.label), r.goals.toFixed(2), `${r.crashes}/${r.episodes}`, r.collisions.toFixed(1)]);
  return `<h2>5 · The open world</h2><p>${esc(w.description)}</p>${table(["Driver", "Goals per run", "Crashes", "Collisions per run"], body)}`;
}

function ablationsHtml(results: any): string {
  let html = "";
  const a = results?.architecture;
  if (a?.variants?.length) {
    const names = Object.keys(a.variants[0].r2);
    html += `<h3>Two additions that did not help the camera network</h3><p>${esc(a.description)}</p>` + table(["Variant", ...names.map((n) => n.replace("Ahead", " ahead").replace("Close", " close"))], a.variants.map((v: any) => [esc(v.label), ...names.map((n) => v.r2[n].toFixed(2))]));
  }
  const p = results?.pushPull;
  if (p?.rows) {
    html += `<h3>Push-pull motor outputs versus steer / throttle / brake / reverse</h3><p>${esc(p.description)} Seeds: ${esc(p.seeds)}.</p>` + table(["Output layout", "Laps on the 7 tracks it learned from", "Laps on 11 unseen tracks"], Object.entries(p.rows).map(([name, r]: [string, any]) => [esc(name === "standard" ? "steer, throttle, brake, reverse (as built)" : "left, right, forward, back (opposing pairs)"), `${r.trained.laps}/${r.trained.episodes} (${pct(r.trained.progress / r.trained.episodes)} progress)`, `${r.unseen.laps}/${r.unseen.episodes} (${pct(r.unseen.progress / r.unseen.episodes)} progress)`]));
  }
  return html ? `<h2>6 · Things that were tried and did not pay off</h2>${html}` : "";
}

export function renderEvidence(results: any, controllerResults: any): string {
  if (!results && !controllerResults) return `<div class="prose"><p class="muted">No measurements were bundled with this build. Run <code>npm run vision:experiments</code> to produce <code>public/vision/results.json</code>.</p></div>`;
  return `<div class="prose wide">
    <h2 style="margin-top:6px">What was measured</h2>
    <p>Everything below was produced by the scripts in <code>scripts/</code> on this repository's simulator, on tracks and worlds the networks never trained on. Numbers that look bad are left in.</p>
    ${gatesHtml(results)}
    ${controllerHtml({ rows: controllerResults?.rows })}
    ${visionHtml(results)}
    ${closedLoopHtml(results)}
    ${memoryHtml(results)}
    ${worldHtml(results)}
    ${ablationsHtml(results)}
    <p class="note">Generated ${esc(results?.generatedAt ?? controllerResults?.generatedAt ?? "")}</p>
  </div>`;
}
