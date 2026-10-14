import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
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

  // A short headless run: small population, two workers, stage 1 only.
  await page.locator("#evo-workers").fill("2");
  await page.locator("#evo-pop").fill("8");
  await page.locator("#evo-battery").fill("2");
  await page.locator("#evo-hours").fill("0");
  await page.locator("#evo-last").selectOption("0");
  await page.locator("#evo-play").click();
  await page.waitForFunction(() => Number(document.getElementById("s-gen")?.textContent) >= 3, null, { timeout: 120000 });
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
  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(missing.filter((u) => !/favicon/.test(u)), [], "no missing files");
  console.log("FlyKart Evolve UI check passed.");
} finally {
  await browser.close();
  server.kill();
}
