import {chromium} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const ready=()=>page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});
const nav=key=>page.locator(`.wb-navigation [data-tool="${key}"]`);
try{
  await page.goto(base+'/robot.html');await ready();
  assert.equal(await page.locator('.wb-panel:visible').count(),1);assert.ok(await page.locator('#lifecycle-panel').isVisible());
  await page.locator('#workbench-search').fill('PID kp');await page.locator('#workbench-results button').first().click();assert.ok(await page.locator('#calibration-panel').isVisible());assert.equal(await page.locator('#cal-pid-kp').evaluate(e=>e===document.activeElement),true);
  await page.locator('#cal-pid-kp').fill('1.25');await nav('tasks').click();await nav('calibrate').click();assert.equal(await page.locator('#cal-pid-kp').inputValue(),'1.25');
  await nav('senses').focus();await page.keyboard.press('Enter');assert.ok(await page.locator('#learning-panel').isVisible());await page.locator('#vision-temporal').selectOption('4');await page.locator('#vision-temporal').locator('..').locator('.wb-help summary').click();assert.match(await page.locator('#vision-temporal').locator('..').locator('.wb-help p').textContent(),/delays responses/);
  await page.locator('a[href="#sensor-console"]').click();assert.ok(await page.locator('#sensor-console').isVisible());assert.equal(await nav('logs').getAttribute('aria-pressed'),'true');
  await nav('tasks').click();await page.locator('#task-mode').selectOption('approach');await page.locator('#task-setup').click();await page.locator('#status').filter({hasText:'Blue-ball task prepared'}).waitFor();await page.locator('#run').click();await page.locator('#workbench-job').filter({hasText:'Simulation running'}).waitFor();await page.locator('#workbench-stop').click();await page.locator('#workbench-job').filter({hasText:'Idle'}).waitFor();assert.match(await page.locator('#run').textContent(),/Run simulation/);
  // Job locks must keep navigation and the global cancel reachable, while restoring the saved lab.
  await nav('research').click();await page.locator('#research-seconds').fill('30');await page.locator('#research-count').fill('4');await page.locator('#research-benchmark').click();
  await page.locator('#research-cancel').waitFor();assert.equal(await nav('logs').isEnabled(),true);await nav('logs').click();assert.ok(await page.locator('#sensor-console').isVisible());assert.equal(await page.locator('#workbench-stop').isEnabled(),true);await page.locator('#workbench-stop').click();
  await page.locator('#workbench-job').filter({hasText:'Idle'}).waitFor({timeout:30000});await nav('research').click();assert.match(await page.locator('#research-status').textContent(),/Research cancelled/);assert.equal(await page.locator('#research-benchmark').isEnabled(),true);
  // Switching workspaces must not recreate controls or erase applied state.
  await page.locator('#workbench-all').click();assert.equal(await page.locator('.wb-panel:visible').count(),7);const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#save-lab').click()]);const lab=JSON.parse(await readFile(await d.path(),'utf8'));assert.equal(lab.learning.lifecycle.settings.mode,'approach');assert.equal(await page.locator('#cal-pid-kp').inputValue(),'1.25');
  await page.reload();await ready();assert.equal(await page.locator('.wb-panel:visible').count(),7);await page.locator('#workbench-focus').click();assert.equal(await page.locator('.wb-panel:visible').count(),1);await page.goto(base+'/robot.html#calibration-panel');await ready();assert.ok(await page.locator('#calibration-panel').isVisible());
  await mkdir('.cache',{recursive:true});await page.locator('#robot-workbench').screenshot({path:'.cache/robot-workbench-desktop.png'});await page.setViewportSize({width:390,height:844});await nav('senses').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#robot-workbench').screenshot({path:'.cache/robot-workbench-mobile.png'});await nav('hardware').click();assert.ok(await page.locator('#serial-connect').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  console.log('Robot workbench passed: focused/all views, searchable controls, native keyboard navigation, inline help, deep links, retained values, stop controls, persistence and mobile layout.');
}finally{await browser.close();}
