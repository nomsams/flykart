import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

// Integration check against a running local Vite server. Uses an isolated,
// headless context, never the user's browser profile or stored app session.
const base = process.env.ROBOT_LAB_URL ?? "http://127.0.0.1:5173";
console.log("Starting isolated browser check…");
const browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true, args: ["--enable-webgl"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${base}/robot.html?tools=all`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#status").filter({ hasText: "Ready." }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#brain-name").textContent(), "Bundled robot world brain");
  assert.equal(await page.locator("#spikes i").count(), 48);
  const camera = await page.locator("#camera").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, 160, 120).data;
    return [...pixels].filter((n, i) => i % 4 !== 3 && n > 0).length;
  });
  assert.ok(camera > 20000, "camera must contain rendered colour pixels");
  console.log("Camera capture verified.");

  assert.equal(await page.locator("#program").inputValue(), "sequence");
  assert.ok(await page.locator("#code-syntax .syntax-keyword").count() > 5);
  await page.locator("#bench-check").click(); await page.locator("#run").click(); await page.locator("#reset").click();
  await page.locator("#step-size").selectOption("150");
  for (let i = 0; i < 7; i++) await page.locator("#step").click();
  assert.match(await page.locator("#motion-state").textContent(), /35\.0 s/);
  assert.match(await page.locator("#check-cycles").textContent(), /2 CYCLES/);
  assert.ok(await page.locator("#check-results .pass").count() > 0);
  assert.equal(await page.locator("#check-results .fail").count(), 0);
  await page.locator("#run").click();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.match(await page.locator("#run").textContent(), /Pause/);
  await page.locator("#run").click();
  await page.locator("#console-filter").selectOption("serial");
  await page.waitForFunction(() => document.querySelector("#console-lines")?.textContent?.includes("camera_frame="));
  assert.match(await page.locator("#console-lines").textContent(), /sonar_cm=/);
  const [logDownload] = await Promise.all([page.waitForEvent("download"), page.locator("#export-log").click()]);
  const recording = JSON.parse(await readFile(await logDownload.path(), "utf8"));
  assert.ok(recording.events.some(e => e.kind === "check" && e.data.passed));
  assert.ok(recording.events.some(e => e.kind === "brain" && e.data.inputs.length === 19));
  await page.locator(".noise-panel summary").click();
  await page.locator("#noise-cameraDropout").fill("1"); await page.locator("#noise-cameraDropout").press("Tab");
  await page.waitForFunction(() => document.querySelector("#camera-stats")?.textContent?.includes("MISSING"));
  const black = await page.locator("#camera").evaluate(canvas => [...canvas.getContext("2d").getImageData(0, 0, 160, 120).data].every((v, i) => i % 4 === 3 || v === 0));
  assert.ok(black, "camera dropout must corrupt delivered pixels");
  await page.locator("#noise-preset").selectOption("clean"); await page.locator("#console-filter").selectOption("all");
  await page.locator(".noise-panel summary").click();
  await page.locator("#default-code").click(); await page.locator("#reset").click(); await page.locator("#step-size").selectOption("1");
  console.log("Repeated drive sequence beyond 27 seconds, focus-loss continuity, Serial console, structured recording and actual camera dropout verified.");

  // Editor changes the motor path, not just the textarea.
  await page.locator("#drive-mode").selectOption("sketch");
  const source = await page.locator("#sketch").inputValue();
  await page.locator("#sketch").fill(source.replace("float left = brainLeft();", "float left = 120;").replace("float right = brainRight();", "float right = 120;"));
  await page.locator("#apply-code").click();
  for (let i = 0; i < 10; i++) await page.locator("#step").click();
  assert.equal(await page.locator("#left-pwm").textContent(), "120");
  assert.ok(Number(await page.locator("#speed").textContent()) > 0);
  assert.equal(await page.locator("#program").inputValue(), "fly");
  console.log("Sketch-driven movement verified.");

  // Collision object editing and undo run through the actual page controls.
  const before = await page.locator("#object-list option").count();
  await page.locator("#object-kind").selectOption("table"); await page.locator("#add-object").click();
  assert.equal(await page.locator("#object-list option").count(), before + 1);
  await page.locator('[data-property="height"]').fill("0.9"); await page.locator('[data-property="height"]').press("Tab");
  assert.equal(await page.locator('[data-property="height"]').inputValue(), "0.900");
  await page.locator("#undo").click(); await page.locator("#undo").click();
  assert.equal(await page.locator("#object-list option").count(), before);
  console.log("Scene edits and undo verified.");

  // Pin conflict validation must inhibit real simulated outputs.
  await page.locator("#advanced").click(); await page.locator("#wire-in1").fill("0");
  assert.match(await page.locator("#wiring-message").textContent(), /camera/);
  await page.locator("#apply-hardware").click(); await page.locator("#step").click();
  assert.equal(await page.locator("#left-pwm").textContent(), "0");
  assert.match(await page.locator("#motion-state").textContent(), /inhibit/);
  await page.locator("#advanced").click(); await page.locator("#wire-in1").fill("12"); await page.locator("#apply-hardware").click();
  console.log("Wiring inhibit verified.");

  // The original brain can be imported while retaining the track adapter.
  await page.locator("#brain-file").setInputFiles("public/sample-brain.json");
  await page.locator("#adapter").filter({ hasText: "TRACK INPUTS" }).waitFor();
  assert.match(await page.locator("#brain-note").textContent(), /racing brain/);
  await page.locator("#restore-brain").click();
  await page.waitForFunction(() => document.querySelector("#adapter")?.textContent === "WORLD INPUTS" || document.querySelector("#status")?.classList.contains("error"));
  assert.equal(await page.locator("#adapter").textContent(), "WORLD INPUTS", await page.locator("#status").textContent());
  console.log("Track import and bundled world restore verified.");
  await page.locator("#default-code").click(); await page.locator("#reset").click();
  await page.waitForFunction(() => document.querySelector("#output-value-throttle")?.textContent === "0.00");

  // Lab export is a self-contained checkpoint and can be imported again.
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#save-lab").click()]);
  const labText = await readFile(await download.path(), "utf8"), lab = JSON.parse(labText);
  assert.equal(lab.format, "flykart-robot-lab"); assert.equal(lab.memory.format, "robot-kenyon-memory");
  assert.equal(lab.vision.domain, "world"); assert.ok(lab.controller.network.inputWeights.length > 0);
  await page.locator("#lab-file").setInputFiles({ name: "saved-lab.json", mimeType: "application/json", buffer: Buffer.from(labText) });
  await page.locator("#status").filter({ hasText: "Imported habitat" }).waitFor();
  assert.equal(await page.locator("#brain-name").textContent(), "Imported lab controller");
  console.log("Lab round-trip verified.");
  await page.locator("#drive-mode").selectOption("fly");
  await page.locator("#sketch").evaluate(editor => { editor.scrollTop = 0; });

  await mkdir(".cache", { recursive: true });
  await page.screenshot({ path: ".cache/robot-habitat-desktop.png", fullPage: true });
  await page.locator("#advanced").click(); await page.screenshot({ path: ".cache/robot-hardware-desktop.png", fullPage: true }); await page.locator("#close-hardware").click();
  await page.locator("#focus").click();
  await page.screenshot({ path: ".cache/robot-habitat-closeup.png", fullPage: true });
  await page.locator("#overview").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".cache/robot-habitat-mobile.png", fullPage: true });
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.scrollWidth <= layout.width + 2, `mobile horizontal overflow: ${JSON.stringify(layout)}`);
  assert.deepEqual(errors, [], "browser must report no application errors");
  console.log("Robot UI checks passed: rendered camera, motor code, object editing, wiring inhibit, brain import, lab round-trip, mobile layout.");
} catch (error) {
  console.error("Robot UI diagnostic:", await page.locator("#status").textContent(), await page.locator("#adapter").textContent(), errors);
  await mkdir(".cache", { recursive: true });
  await page.screenshot({ path: ".cache/robot-habitat-failure.png", fullPage: true });
  throw error;
} finally { await context.close(); await browser.close(); }
