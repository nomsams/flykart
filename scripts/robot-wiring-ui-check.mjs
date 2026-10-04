import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

// Only an isolated browser context is used; no user browser data is accessed.
const base = process.env.ROBOT_LAB_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true, args: ["--enable-webgl"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage(), errors = [];
page.on("pageerror", e => errors.push(e.message));
try {
  await page.goto(`${base}/robot.html?tools=all`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#status").filter({ hasText: "Ready." }).waitFor({ timeout: 60000 });
  await page.locator("#show-pinout").click();
  const view = page.locator("#pinout-diagram");
  assert.equal(await view.locator("g.wire").count(), 17);
  assert.match(await view.locator(".wire-detail").textContent(), /GPIO 4 via level shifter/);
  await view.locator('g[data-net="in1"]').focus(); await view.locator('g[data-net="in1"]').press("Enter");
  assert.match(await view.locator(".wire-detail").textContent(), /ESP32 GPIO 12 → L298N IN1/);
  await view.locator(".wire-netlist summary").click(); await view.locator('button[data-net="left"]').click();
  assert.match(await view.locator(".wire-detail").textContent(), /Front-left \+ rear-left motors/);
  await view.locator(".pin-reference summary").click();
  assert.equal(await view.locator(".camera-pin-grid>div").count(), 15);
  assert.match(await view.locator(".camera-pin-grid").textContent(), /XCLKGPIO 0/);
  await view.locator(".wire-netlist summary").click(); await view.locator(".pin-reference summary").click();
  const [file] = await Promise.all([page.waitForEvent("download"), page.locator("#export-wiring").click()]);
  const svg = await readFile(await file.path(), "utf8");
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"')); assert.ok(svg.includes("GPIO 12")); assert.ok(svg.includes("COMMON REFERENCE GROUND"));
  const parsed = await page.evaluate(source => { const xml = new DOMParser().parseFromString(source, "image/svg+xml"); return { error: !!xml.querySelector("parsererror"), motors: xml.querySelectorAll(".motor").length }; }, svg);
  assert.equal(parsed.error, false); assert.equal(parsed.motors, 4);
  await mkdir(".cache", { recursive: true });
  await page.locator("#pinout").evaluate(dialog => { dialog.scrollTop = 0; });
  await page.screenshot({ path: ".cache/robot-wiring-desktop.png", fullPage: true });
  console.log("Interactive wire selection, camera reservations, four motors and standalone SVG export verified.");

  await page.locator("#edit-pinout").click();
  const preview = page.locator("#hardware-diagram");
  await page.locator("#wire-in1").fill("1");
  assert.match(await preview.locator(".wiring-diagram-heading").textContent(), /DRAFT/);
  assert.match(await preview.locator('g[data-net="in1"]').getAttribute("aria-label"), /GPIO 1/);
  await page.locator("#wire-in1").fill("0");
  assert.ok((await preview.locator('g[data-net="in1"]').getAttribute("class")).includes("bad-wire"));
  await page.locator("#wire-in1").fill("12"); await page.locator("#echo-divider").uncheck();
  assert.ok((await preview.locator('g[data-net="echo"]').getAttribute("class")).includes("bad-wire"));
  assert.equal(await preview.locator(".shifter").count(), 0);
  await page.locator("#echo-divider").check(); await page.locator("#common-ground").uncheck();
  assert.match(await preview.locator("svg").textContent(), /GROUND LINK OPEN/);
  await page.locator("#common-ground").check(); await page.locator("#camera-enabled").uncheck();
  assert.ok((await preview.locator('g[data-net="camera"]').getAttribute("class")).includes("off-wire"));
  await page.locator("#camera-enabled").check(); await page.locator("#board").selectOption("uno");
  assert.match(await preview.locator(".wiring-diagram-heading").textContent(), /UNO/);
  assert.match(await preview.locator("svg").textContent(), /INTERFACE UNSPECIFIED/);
  await page.locator("#board").selectOption("esp32-cam"); await page.locator("#wire-in1").fill("1");
  await page.locator("#apply-hardware").click(); await page.locator("#show-pinout").click();
  assert.match(await view.locator('g[data-net="in1"]').getAttribute("aria-label"), /GPIO 1/);
  assert.match(await view.locator(".wiring-diagram-heading").textContent(), /APPLIED/);
  console.log("Draft edits, pin conflicts, echo shifting, shared ground, disconnections, UNO profile and applied pin synchronization verified.");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#pinout").evaluate(dialog => { dialog.scrollTop = 0; });
  await page.screenshot({ path: ".cache/robot-wiring-mobile.png", fullPage: true });
  const width = await page.locator("#pinout").evaluate(dialog => ({ client: dialog.clientWidth, scroll: dialog.scrollWidth }));
  assert.ok(width.scroll <= width.client + 2, `diagram must scroll inside its viewport: ${JSON.stringify(width)}`);
  const viewport = await view.locator(".wire-viewport").evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(viewport.scroll > viewport.client, "mobile diagram has readable horizontally scrollable wiring");
  assert.deepEqual(errors, []);
  console.log("Robot wiring UI checks passed, including mobile layout.");
} catch (error) {
  console.error("Wiring UI diagnostic:", await page.locator("#status").textContent(), errors);
  await mkdir(".cache", { recursive: true }); await page.screenshot({ path: ".cache/robot-wiring-failure.png", fullPage: true });
  throw error;
} finally { await context.close(); await browser.close(); }
