import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true, args: ["--enable-webgl"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const page = await context.newPage(), errors = [];
page.on("pageerror", error => errors.push(error.message));
const base = process.env.ROBOT_LAB_URL ?? "http://127.0.0.1:5173";
const exportLab = async () => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#save-lab").click()]);
  return JSON.parse(await readFile(await download.path(), "utf8"));
};
const importLab = async data => {
  await page.locator("#lab-file").setInputFiles({ name: "habitat.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
  await page.locator("#status").filter({ hasText: "Imported habitat" }).waitFor();
};
const camera = () => page.locator("#camera").evaluate(canvas => Array.from(canvas.getContext("2d").getImageData(0, 0, 160, 120).data));
const recapture = async () => {
  await page.locator("#floor-colour").dispatchEvent("input");
  await page.waitForTimeout(250);
};
try {
  await page.goto(`${base}/robot.html?tools=all`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#status").filter({ hasText: "Ready." }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#preset option").count(), 8);
  assert.equal(await page.locator("#object-kind option").count(), 17);
  assert.equal(await page.locator('#object-kind option[value="ball"]').count(),1);
  for (const room of ["bedroom", "living", "office", "maze", "clutter"]) {
    await page.locator("#preset").selectOption(room);
    const lab = await exportLab(); assert.ok(lab.objects.length > 5);
    if (room === "bedroom") assert.ok(lab.objects.some(o => o.kind === "bed"));
    if (room === "clutter") for (const kind of ["block", "cable", "shoe", "doormat"]) assert.ok(lab.objects.some(o => o.kind === kind));
  }
  const before = await exportLab();
  await page.locator("#bench-current").click(); await page.waitForTimeout(1200); await page.locator("#run").click();
  assert.deepEqual((await exportLab()).objects, before.objects);
  assert.match(await page.locator("#motion-state").textContent(), /Paused/);
  await page.locator("#survey-room").click(); await page.waitForTimeout(500); await page.locator("#run").click();
  assert.equal((await exportLab()).program, "avoid");

  await page.locator("#preset").selectOption("bedroom");
  await page.locator("#floor-colour").fill("#d75c41"); await page.locator("#floor-colour").dispatchEvent("input"); await page.locator("#floor-colour").dispatchEvent("change");
  await recapture(); const red = await camera();
  await page.locator("#floor-colour").fill("#416ed7"); await page.locator("#floor-colour").dispatchEvent("change"); await recapture(); const blue = await camera();
  assert.notDeepEqual(red, blue, "Floor colour must change the camera pixels");
  await page.locator("#collision-visible").check(); await recapture();
  assert.deepEqual(await camera(), blue, "Contact outlines must not enter the camera");
  await mkdir(".cache", { recursive: true }); await page.screenshot({ path: ".cache/robot-habitat-desktop.png", fullPage: true });
  const saved = await exportLab(); assert.equal(saved.floorColour, "#416ed7");
  await page.reload(); await page.locator("#status").filter({ hasText: "Ready." }).waitFor({ timeout: 60000 }); assert.equal(await page.locator("#floor-colour").inputValue(), saved.floorColour);
  await page.locator("#preset").selectOption("empty"); await importLab(saved);
  assert.deepEqual((await exportLab()).objects, saved.objects); assert.equal(await page.locator("#floor-colour").inputValue(), saved.floorColour);

  // Place a low cable beneath the reset chassis, then enlarge it into an obstacle.
  const cable = { id: "crossing-cable", kind: "cable", x: -1.4, z: 1, yaw: 0, width: .7, depth: .02, height: .01 };
  saved.objects = [cable]; saved.program = "sequence"; saved.mode = "sketch";
  saved.sketch = before.sketch; // Current-habitat drive check's applied sequence.
  const sequence = await page.evaluate(async () => {
    const { programSketch } = await import("/src/robot/controls.ts"); const { ESP_WIRING } = await import("/src/robot/model.ts"); return programSketch("sequence", ESP_WIRING);
  }); saved.sketch = sequence;
  await importLab(saved); await page.locator("#step-size").selectOption("30"); await page.locator("#step").click();
  assert.equal(await page.locator("#hits").textContent(), "0"); assert.match(await page.locator("#console-lines").textContent(), /Crossing loose cable/);
  saved.objects[0].height = .03; await importLab(saved); await page.locator("#step").click();
  assert.match(await page.locator("#motion-state").textContent(), /cable body/);
  assert.ok(Number(await page.locator("#hits").textContent()) > 0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator("#preset").selectOption("bedroom");
  await page.screenshot({ path: ".cache/robot-habitat-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, "Mobile layout must fit");
  assert.deepEqual(errors, []); console.log("8 habitats, 17 items including blue ball, charging pod and imported visuals, preserved-room checks, floor camera colour, overlay isolation, persistence/import, cable traction/contact and mobile layout verified.");
} finally { await browser.close(); }
