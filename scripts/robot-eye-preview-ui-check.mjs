import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
page.on('pageerror', e => errors.push(e.message));
const base = process.env.ROBOT_LAB_URL ?? 'http://127.0.0.1:5173';
const gallery = domain => page.locator(domain === 'track' ? '#virtual-eyes' : '#world-virtual-eyes');
const verifyPixels = async domain => {
  const result = await page.evaluate(async domain => {
    const { VisualFilter, viewPatches, cropView } = await import('/src/robot/vision-workbench.ts');
    const { lowResolution } = await import('/src/vision/ensemble.ts');
    const s = window.flykartVision[domain], e = s.episode, box = document.getElementById(domain === 'track' ? 'virtual-eyes' : 'world-virtual-eyes');
    const { width: w, height: h } = e.camera, n = w * h;
    const processed = new VisualFilter().process(lowResolution(e.frame, w, h, s.settings.resolution), w, h, s.settings.visual);
    const expected = box.dataset.source === 'inference' ? s.driver.ensemble.frames : viewPatches(s.settings.visual).map((p, i) => i ? cropView(processed, w, h, p) : processed);
    let mismatches = 0;
    [...box.querySelectorAll('canvas')].forEach((canvas, i) => {
      const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      for (let p = 0; p < n; p++) for (let k = 0; k < 3; k++) if (Math.abs(rgba[p * 4 + k] - Math.round(expected[i][k * n + p] * 255)) > 1) mismatches++;
    });
    return { mismatches, tick: e.tick, source: box.dataset.source, count: expected.length, dimensions: [...box.querySelectorAll('canvas')].map(c => [c.width, c.height, c.clientWidth / c.clientHeight]), aspect: w / h };
  }, domain);
  assert.equal(result.mismatches, 0, `${domain}: thumbnails must match real planar RGB inputs`);
  for (const [w, h, aspect] of result.dimensions) { assert.equal(w / h, result.aspect); assert.ok(Math.abs(aspect - result.aspect) < .03, 'CSS must preserve aspect ratio'); }
  return result;
};
try {
  await page.goto(base + '/vision.html');
  await page.locator('#boot-screen').waitFor({ state: 'hidden', timeout: 60000 });
  await page.locator('#camera-experiment summary').filter({ hasText: 'Colour camera & virtual eyes' }).click();
  for (const [layout, count] of [['single', 1], ['circle3', 3], ['circle5', 5], ['circle9', 9], ['scales3', 3]]) {
    await page.locator('#eye-layout').selectOption(layout);
    assert.equal(await gallery('track').locator('canvas').count(), count);
    const result = await verifyPixels('track'); assert.equal(result.tick, 0); assert.equal(result.source, 'preview');
    assert.equal(await page.evaluate(() => window.flykartVision.track.driver.ensemble.frames.length), 0, 'Preview must not advance the network');
  }
  await page.locator('#eye-layout').selectOption('circle9');
  await page.locator('#camera-resolution').selectOption('16x8');
  await page.locator('#eye-normalize').check(); await page.locator('#eye-smooth').check(); await page.locator('#eye-temporal').selectOption('4');
  await verifyPixels('track');
  await page.locator('#track-run').click(); await page.waitForFunction(() => window.flykartVision.track.episode.tick >= 8); await page.locator('#track-run').click();
  assert.equal((await verifyPixels('track')).source, 'inference');
  const hashes = await gallery('track').locator('canvas').evaluateAll(cs => cs.map(c => c.toDataURL()));
  assert.ok(new Set(hashes).size > 3, 'Shifted views must show distinct real crops');
  const stateBefore = await page.evaluate(() => ({ tick: window.flykartVision.track.episode.tick, activity: window.flykartVision.track.controller.activity(), frames: window.flykartVision.track.driver.ensemble.frames.map(f => [...f]) }));
  await page.locator('#vision-refresh').click();
  assert.deepEqual(await page.evaluate(() => ({ tick: window.flykartVision.track.episode.tick, activity: window.flykartVision.track.controller.activity(), frames: window.flykartVision.track.driver.ensemble.frames.map(f => [...f]) })), stateBefore);
  await page.locator('#track-eyes').selectOption('none');
  assert.equal((await verifyPixels('track')).source, 'preview'); assert.match(await page.locator('#eye-disagreement').innerText(), /no eye network selected/);

  await page.locator('#tab-btn-world').click(); await page.locator('#world-driver').selectOption('vision');
  await page.locator('summary').filter({ hasText: /^Virtual eyes & filters$/ }).click();
  for (const [layout, count] of [['circle3', 3], ['circle5', 5], ['circle9', 9], ['scales3', 3], ['single', 1]]) {
    await page.locator('#world-eye-layout').selectOption(layout);
    assert.equal(await gallery('world').locator('canvas').count(), count);
    assert.equal((await verifyPixels('world')).source, 'preview');
    assert.equal(await page.locator('#eye-layout').inputValue(), layout);
    assert.equal(await page.evaluate(() => window.flykartVision.track.settings.visual.layout), layout, 'Shared settings must update both sessions');
  }
  await page.locator('#world-eye-layout').selectOption('scales3');
  await page.locator('#world-run').click(); await page.waitForFunction(() => window.flykartVision.world.episode.tick >= 8); await page.locator('#world-run').click();
  await page.locator('#vision-refresh').click(); assert.equal((await verifyPixels('world')).source, 'inference');
  for (const kind of ['feeling', 'expert', 'blind']) {
    await page.locator('#world-driver').selectOption(kind);
    assert.equal((await verifyPixels('world')).source, 'preview'); assert.match(await page.locator('#world-eye-disagreement').innerText(), /does not use camera eyes/);
  }
  await page.locator('#world-driver').selectOption('vision'); await page.locator('#world-eye-layout').selectOption('circle9');
  await page.locator('#vision-render-mode').selectOption('headless');
  const paused = await gallery('world').locator('canvas').evaluateAll(cs => cs.map(c => c.toDataURL()));
  await page.locator('#world-run').click(); await page.waitForFunction(() => window.flykartVision.world.episode.tick >= 8); await page.locator('#world-run').click();
  assert.deepEqual(await gallery('world').locator('canvas').evaluateAll(cs => cs.map(c => c.toDataURL())), paused, 'Headless leaves previews frozen');
  await page.locator('#vision-refresh').click(); assert.equal((await verifyPixels('world')).source, 'inference');
  // Cached draw buffers must resize when an imported eye model uses another tensor size.
  assert.deepEqual(await page.evaluate(async () => {
    const { drawEye } = await import('/src/vision/ui/draw.ts');
    const c = document.createElement('canvas'); c.width = 8; c.height = 4;
    drawEye(c, new Float32Array(3 * 2 * 2), { width: 2, height: 2 });
    const rgb = new Float32Array(3 * 8 * 4); rgb.fill(1, 0, 8 * 4);
    drawEye(c, rgb, { width: 8, height: 4 });
    return [...c.getContext('2d').getImageData(7, 3, 1, 1).data];
  }), [255, 0, 0, 255]);
  await mkdir('.cache', { recursive: true }); await gallery('world').screenshot({ path: '.cache/eye-preview-world-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await verifyPixels('world');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await gallery('world').screenshot({ path: '.cache/eye-preview-world-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('Eye previews passed: all five layouts in both domains, paused/live real RGB, aspect ratio, inactive modes, shared settings, isolated refresh, headless inspection, tensor resize and mobile layout.');
} finally { await browser.close(); }
