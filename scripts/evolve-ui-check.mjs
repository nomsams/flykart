import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Integration check for FlyKart Evolve against an isolated, hot-reload-free Vite server and a headless browser.
// It starts a short headless run, looks at the dashboard, then watches one trial in 2D and 3D. Screenshots go to
// EVOLVE_SHOTS (default .cache/evolve-shots).
const port = Number(process.env.EVOLVE_PORT ?? 5186), url = `http://127.0.0.1:${port}`;
const shots = process.env.EVOLVE_SHOTS ?? ".cache/evolve-shots";
await mkdir(shots, { recursive: true });
const server = spawn(process.execPath, ["scripts/robot-check-server.mjs", String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", (b) => { output = (output + b).slice(-4000); });
let ready = false;
for (let i = 0; i < 240 && !ready; i += 1) {
  try { ready = (await fetch(`${url}/evolve.html`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* wait */ }
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) { server.kill(); throw new Error(`Preview server did not start: ${output}`); }
const browser = await chromium.launch({ ...(process.platform === "win32" && process.env.EVOLVE_CHROMIUM !== "1" ? { channel: "msedge" } : {}), headless: true, args: ["--enable-webgl", "--use-gl=swiftshader", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const missing = [];
page.on("response", (r) => { if (r.status() === 404) missing.push(r.url()); });
page.on("console", (m) => { if (m.type() === "error" && !/status of 404/.test(m.text())) errors.push(m.text()); });
try {
  await page.goto(`${url}/evolve.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.locator("#evo-play").waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#evo-gallery canvas").count(), 3, "three habitat previews");
  // The gallery's canvases must contain drawn pixels (floors, props).
  const drawn = await page.locator("#evo-gallery canvas").first().evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`); return seen.size; });
  assert.ok(drawn > 6, `habitat preview has colour variety (${drawn})`);
  await page.screenshot({ path: `${shots}/1-idle.png`, fullPage: true });

  // Starting brains: the bundled one is ticked; add two files from "the computer" (one a perturbed copy, one the
  // repository's 17-input explorer) and a file that is not a brain, then remove one again.
  const bundled = JSON.parse(await readFile("public/vision/robot/world-controller.json", "utf8"));
  const copy = structuredClone(bundled);
  copy.network.bias = copy.network.bias.map((v, k) => v + (k % 5 === 0 ? 0.05 : 0));
  await page.locator("#evo-file").setInputFiles([
    { name: "mine-a.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(copy)) },
    { name: "visual.json", mimeType: "application/json", buffer: await readFile("assets/flykart-visual.json") },
    { name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{\"hello\": 1}") },
  ]);
  await page.waitForFunction(() => document.querySelectorAll("#evo-founder-list li").length === 3);
  assert.equal(await page.locator("#evo-founder-list li[data-bad=true]").count(), 1, "the file that is not a brain is refused, with a reason");
  assert.match((await page.locator("#evo-founder-list li[data-bad=true]").textContent()) ?? "", /notes\.json/);
  assert.match((await page.locator("#evo-founder-list li").nth(1).textContent()) ?? "", /widened from 17 to 19/);
  await page.locator("#evo-founder-list li").nth(1).locator("button").click();
  assert.equal(await page.locator("#evo-founder-list li:not([data-bad=true])").count(), 1, "one valid upload remains after removing one");
  // GitHub, mocked: browsing the repository lists brain files; "Add" fetches one into the founders; a pasted link works too.
  const other = structuredClone(bundled);
  other.network.bias = other.network.bias.map((v, k) => v + (k % 7 === 0 ? 0.08 : 0));
  const cors = { "access-control-allow-origin": "*" };
  const entry = (name, dir) => ({ name, path: `${dir}/${name}`, type: "file", size: 90_000, download_url: `https://raw.githubusercontent.com/nomsams/flykart/main/${dir}/${name}` });
  await page.route("https://api.github.com/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/contents/assets")) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify([entry("trained-a.json", "assets"), entry("readme.md", "assets")]) });
    if (path.endsWith("/contents/public/vision/robot")) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify([entry("trained-b.json", "public/vision/robot")]) });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: "[]" }); // brains/: none here
  });
  await page.route("https://raw.githubusercontent.com/**", (route) => route.fulfill({ status: 200, headers: cors, contentType: "text/plain", body: JSON.stringify(route.request().url().endsWith("trained-a.json") ? other : copy) }));
  await page.locator("#evo-github-browse").click();
  await page.waitForFunction(() => document.querySelectorAll("#evo-github-list li").length === 2);
  assert.match((await page.locator("#evo-github-list li").first().textContent()) ?? "", /trained-a\.json.*assets\/trained-a\.json/);
  await page.locator("#evo-github-list li").first().locator("button").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#evo-founder-list li span")].some((s) => /GitHub: trained-a\.json/.test(s.textContent ?? "")));
  assert.equal(await page.locator("#evo-github-list li").first().locator("button").textContent(), "Added");
  await page.locator("#evo-github-url").fill("https://example.com/not-github.json");
  await page.locator("#evo-github-add").click();
  await page.waitForFunction(() => /Only github\.com/.test(document.getElementById("evo-github-status")?.textContent ?? ""));
  await page.locator("#evo-github-url").fill("https://github.com/nomsams/flykart/blob/main/assets/mine-a.json");
  await page.locator("#evo-github-add").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#evo-founder-list li span")].some((s) => /GitHub: mine-a.json/.test(s.textContent ?? "")));
  await page.screenshot({ path: `${shots}/1b-founders.png`, fullPage: true });

  // A short headless run: small population, two workers, stage 1 only.
  await page.locator("#evo-workers").fill("2");
  await page.locator("#evo-pop").fill("8");
  await page.locator("#evo-battery").fill("2");
  await page.locator("#evo-hours").fill("0");
  await page.locator("#evo-last").selectOption("0");
  await page.locator("#evo-play").click();
  await page.waitForFunction(() => Number(document.getElementById("s-gen")?.textContent) >= 3, null, { timeout: 120000 });
  const startLog = (await page.locator("#evo-log").textContent()) ?? "";
  // bundled + the uploaded copy + trained-a from GitHub + the copy fetched by link (identical to the upload, kept once).
  assert.match(startLog, /Run started from 3 brain\(s\)/, "the run began from the bundled brain, the upload and the GitHub brain");
  assert.match(startLog, /Start: mine-a\.json/);
  assert.match(startLog, /Start: GitHub: trained-a\.json/);
  assert.match(startLog, /identical to an earlier brain/);
  await page.waitForFunction(() => /^back \d+%/.test(document.getElementById("s-overseer")?.textContent ?? ""), null, { timeout: 120000 });
  const headlessStatus = await page.locator("#evo-status").textContent();
  assert.match(headlessStatus ?? "", /Headless/);
  assert.equal(await page.locator("#evo-watch").isHidden(), true, "no watch panel while headless");
  // Switch to watch: the charts appear and fill with the run so far.
  await page.locator("#evo-mode-watch").click();
  await page.waitForFunction(() => document.querySelectorAll("#evo-maxima tbody tr").length >= 0 && !document.getElementById("evo-watch").hidden);
  await page.waitForTimeout(1500);
  const progressInk = await page.locator("#evo-progress").evaluate((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 90 || d[i + 1] > 90) n += 1; return n; });
  assert.ok(progressInk > 500, `progress chart is drawn (${progressInk})`);
  await page.screenshot({ path: `${shots}/2-watch.png`, fullPage: true });
  // Back to headless, then pause.
  await page.locator("#evo-mode-headless").click();
  await page.locator("#evo-play").click();
  await page.waitForFunction(() => document.getElementById("evo-play")?.textContent?.includes("Continue"), null, { timeout: 120000 });

  // Watch a trial in 2D, then 3D.
  await page.locator("#evo-mode-watch").click();
  await page.locator("#w-stage").selectOption("3");
  await page.locator("#w-speed").selectOption("8");
  await page.locator("#w-run").click();
  await page.waitForFunction(() => /flags/.test(document.getElementById("evo-watch-status")?.textContent ?? ""), null, { timeout: 120000 });
  await page.screenshot({ path: `${shots}/3-trial-2d.png`, fullPage: true });
  await page.locator("#w-3d").check();
  await page.locator("#w-run").click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}/4-trial-3d.png`, fullPage: true });
  await page.locator("#g-3d").check();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/5-gallery-3d.png`, fullPage: true });
  // A run that stopped at a stage it could not master (built by a small script): the banner, goals, sorting, the stage
  // filter on table and map, and a rerun of an earlier stage.
  execSync("npx vite-node scripts/evolve-make-stalled-state.ts .cache/stalled-state.json", { stdio: "inherit" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#evo-play").waitFor({ timeout: 60000 });
  await page.locator("#evo-import-file").setInputFiles(".cache/stalled-state.json");
  await page.waitForFunction(() => !document.getElementById("evo-stalled").hidden, null, { timeout: 60000 });
  assert.match((await page.locator("#evo-stalled-text").textContent()) ?? "", /Stage 2 stopped at \d+% of flags found, against a goal of 200%/);
  assert.equal(await page.locator("#evo-more").isVisible(), true);
  assert.equal(await page.locator("#evo-moveon").isVisible(), true);
  assert.equal(await page.locator("#evo-stages li").count(), 6);
  assert.match((await page.locator("#evo-stages li").nth(0).textContent()) ?? "", /moved on without mastering/);
  assert.match((await page.locator("#evo-stages li").nth(1).textContent()) ?? "", /stopped at \d+%/);
  assert.equal(await page.locator("#evo-maxima tbody tr").count(), 4, "the best two maxima of each of the two stages are kept");
  assert.match((await page.locator("#evo-retired").textContent()) ?? "", /4 kept · \d+ weaker ones retired · the best 2/);
  // Sorting by exam score, then showing one stage on the table and on the map.
  await page.locator("#evo-maxima th[data-sort=exam]").click();
  assert.equal(await page.locator("#evo-maxima th[data-sort=exam]").getAttribute("aria-sort"), "descending");
  const exams = await page.locator("#evo-maxima tbody tr td:nth-child(5)").allTextContents();
  const values = exams.map((t) => Number(t.split("±")[0]));
  assert.deepEqual(values, [...values].sort((a, b) => b - a), "sorted by exam, best first");
  await page.locator("#evo-stage-filter").selectOption("1");
  assert.equal(await page.locator("#evo-maxima tbody tr").count(), 2);
  assert.deepEqual([...new Set(await page.locator("#evo-maxima tbody tr td:nth-child(2)").allTextContents())], ["2"]);
  assert.equal(await page.locator("#evo-stage-filter-map").inputValue(), "1", "the map follows the same filter");
  await page.locator("#evo-stage-filter").selectOption("all");
  assert.equal(await page.locator("#evo-maxima tbody tr").count(), 4);
  // A lower goal is shown at once; the banner follows it.
  await page.locator("#evo-stages input[data-goal='1']").fill("60");
  await page.locator("#evo-stages input[data-goal='1']").dispatchEvent("change");
  await page.waitForFunction(() => /goal of 60%/.test(document.getElementById("evo-stalled-text")?.textContent ?? ""));
  // Rerun stage 1 from its best brain with a higher goal.
  await page.locator("#evo-stages input[data-goal='0']").fill("95");
  await page.locator("#evo-stages input[data-goal='0']").dispatchEvent("change");
  page.once("dialog", (dialog) => { assert.match(dialog.message(), /Rerun stage 1 .* goal of 95% of flags/); void dialog.accept(); });
  await page.locator("#evo-stages button[data-rerun='0']").click();
  await page.waitForFunction(() => /Stage 1 will be climbed again/.test(document.getElementById("evo-status")?.textContent ?? ""));
  assert.equal(await page.locator("#evo-stalled").isHidden(), true, "the stop is cleared by the rerun");
  assert.equal(await page.locator("#evo-stages li").nth(0).getAttribute("data-state"), "current");
  assert.match((await page.locator("#s-stage").textContent()) ?? "", /^1 of 6/);
  await page.screenshot({ path: `${shots}/6-stages.png`, fullPage: true });
  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(missing.filter((u) => !/favicon/.test(u)), [], "no missing files");
  console.log("FlyKart Evolve UI check passed.");
} finally {
  await browser.close();
  server.kill();
}
