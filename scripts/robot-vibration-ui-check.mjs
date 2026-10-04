import {chromium} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const downloaded=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return readFile(await d.path(),'utf8');};
try{
  await page.goto(base+'/robot.html?tools=all');await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});
  const bounds=await page.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,bottom:r.bottom,right:r.right};};return{stage:rect('.stage'),tools:rect('.scene-edit-tools'),sensors:rect('.sensor-rail')};});
  assert.ok(bounds.tools.y>=bounds.stage.bottom&&bounds.tools.y<bounds.stage.bottom+20);assert.ok(bounds.sensors.x>=bounds.stage.right);assert.ok(Math.abs(bounds.sensors.y-bounds.stage.y)<2);
  const initial=JSON.parse(await downloaded('save-lab'));assert.equal(initial.config.vibration.enabled,false);assert.equal(initial.wiring.vibration,-1);
  await page.locator('#advanced').click();await page.locator('#vibration-enabled').check();await page.locator('#wire-vibration').fill('33');await page.locator('#vibration-gpio33').check();await page.locator('#apply-hardware').click();assert.match(await page.locator('#sketch').inputValue(),/const int VIBRATION = 33;/);
  await page.locator('#vibration-shake').click();assert.match(await page.locator('#vibration-status').textContent(),/Vibration event held/);await page.locator('#console-filter').selectOption('vibration');await page.waitForFunction(()=>document.querySelector('#console-lines').textContent.includes('Injected test shake'));
  const lab=JSON.parse(await downloaded('save-lab'));assert.equal(lab.config.vibration.enabled,true);assert.equal(lab.wiring.vibration,33);await page.locator('.hardware-lab>summary').click();const bridge=await downloaded('export-bridge');assert.match(bridge,/attachInterrupt/);assert.match(bridge,/count!=vibrationSent/);
  await page.locator('#task-new-vibration').click();const journey=JSON.parse(await downloaded('task-export'));assert.equal(journey.brain.observation,'robot-task35-sw420-v3');assert.equal(journey.settings.modules.bumper,true);assert.match(await page.locator('#task-contract').textContent(),/30: vibration.event/);
  await page.locator('#show-pinout').click();assert.equal(await page.locator('#pinout-diagram g[data-net="vibration"]').count(),1);assert.match(await page.locator('#pinout-diagram svg[aria-label^="Robot wiring diagram"]').textContent(),/SW-420/);await page.locator('#close-pinout').click();
  await page.reload();await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});assert.equal(JSON.parse(await downloaded('save-lab')).wiring.vibration,33);await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/robot-vibration-desktop.png'});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'.cache/robot-vibration-mobile.png'});assert.deepEqual(errors,[]);
  console.log('SW-420 UI passed: habitat layout, optional digital signal, logs, synchronized pins, bridge ISR export, versioned training inputs, wiring map, persistence and mobile layout.');
}finally{await browser.close();}
