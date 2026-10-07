import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const reveal=async id=>page.locator('#'+id).evaluate(e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=true;});
const copyFallback=async(domain,clipboard)=>{
  const button=domain==='track'?'copy-sensor-log':'world-copy-logs',log=domain==='track'?'sensor-log':'world-sensor-log';
  await page.evaluate(mode=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:mode==='missing'?undefined:{writeText:()=>Promise.reject(Error('Clipboard denied'))}}),clipboard);
  await reveal(button);await page.locator('#'+button).click();
  await page.waitForFunction(id=>document.getElementById(id).textContent==='Select logs · Ctrl+C',button);
  assert.ok(await page.locator('#'+log).evaluate(e=>document.activeElement===e&&e.selectionStart===0&&e.selectionEnd===e.value.length));
};
const scanOrder=async domain=>{
  assert.equal(await page.locator('#'+domain+'-scan-settings').evaluate(e=>e.open),false);
  const map=await page.locator('#'+domain+'-sonar-map').boundingBox(),settings=await page.locator('#'+domain+'-scan-settings summary').boundingBox();
  assert.ok(map.height>80);assert.ok(map.y+map.height<=settings.y+1,'Scan must precede its settings');
  await page.locator('#'+domain+'-scan-settings summary').click();
  const before=await page.locator('#'+domain+'-sonar-map').evaluate(c=>c.toDataURL());
  await page.locator('#'+domain+'-scan-view').selectOption('top');
  assert.notEqual(await page.locator('#'+domain+'-sonar-map').evaluate(c=>c.toDataURL()),before);
  await page.locator('#'+domain+'-scan-settings summary').click();
};
try{
  await page.goto(base+'/vision.html#world');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:60000});
  assert.equal(await page.locator('.browser-brain-shelf').evaluate(e=>e.open),false);
  await page.locator('#profile').selectOption('robot');
  await page.locator('#world-eye').scrollIntoViewIfNeeded();await page.evaluate(()=>scrollTo(0,0));
  const camera=await page.locator('#world-eye').boundingBox();console.log('Desktop camera begins at',camera.y);
  await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/vision-compact-layout.png'});
  assert.ok(camera.y<480,'Compact top controls must leave the camera in the first screen');
  await scanOrder('world');
  await page.locator('#world-run').click();await page.waitForFunction(()=>window.flykartVision.world.episode.tick>=20);await page.locator('#world-run').click();
  const logs=await page.locator('#world-sensor-log').inputValue();assert.match(logs,/ping=/);
  assert.equal(await page.locator('#sensor-log').inputValue(),logs);
  await copyFallback('world','missing');
  assert.deepEqual(errors,[],'Missing clipboard must not throw a page error');
  await page.locator('#tab-btn-track').click();await scanOrder('track');
  assert.ok(await page.locator('#sonar-panel').evaluate(e=>e.parentElement.contains(document.getElementById('track-eye'))));
  const sonar=await page.locator('#track-sonar-map').boundingBox(),eyes=await page.locator('#virtual-eyes').locator('..').boundingBox();
  assert.ok(sonar.y<eyes.y,'Sonar must appear above virtual eye settings');
  await copyFallback('track','denied');assert.deepEqual(errors,[]);
  await page.locator('#clear-sensor-log').click();assert.equal(await page.locator('#sensor-log').inputValue(),'');assert.equal(await page.locator('#world-sensor-log').inputValue(),'');
  await page.locator('#tab-btn-world').click();await page.locator('#world-run').click();await page.waitForFunction(()=>window.flykartVision.world.episode.tick>=24);await page.locator('#world-run').click();
  assert.ok((await page.locator('#world-sensor-log').inputValue()).length>0);
  await reveal('world-clear-logs');await page.locator('#world-clear-logs').click();assert.equal(await page.locator('#sensor-log').inputValue(),'');assert.equal(await page.locator('#world-sensor-log').inputValue(),'');
  // Compacting disclosures must preserve profile selection and repository loading.
  await page.locator('#brain-project-choice').selectOption('visual');await page.locator('#brain-load-project').click();
  await page.waitForFunction(()=>window.flykartVision.importedWorld?.controller);
  await page.locator('#brain-file-status').filter({hasText:'flykart-visual.json'}).waitFor();
  assert.match(await page.locator('#world-estimates-note').textContent(),/No goal compass/);
  await page.locator('#world-task').selectOption('forage');assert.match(await page.locator('#world-estimates-note').textContent(),/goal compass/i);
  await page.locator('#world-task').selectOption('explore');
  await page.locator('#tab-btn-track').click();await reveal('camera-calibrated');
  await page.locator('#camera-fov').fill('70');await page.locator('#camera-calibrated').check();
  await page.locator('#tab-btn-world').click();assert.match(await page.locator('#world-camera-size').textContent(),/70° FOV/);
  assert.ok(await page.evaluate(()=>Math.abs(window.flykartVision.world.episode.camera.hfov*180/Math.PI-70)<.01));
  await page.locator('#tab-btn-track').click();await page.locator('#camera-calibrated').uncheck();await page.locator('#tab-btn-world').click();
  await page.locator('#brain-import-always').click();await page.locator('#import-file-dialog').waitFor({state:'visible'});await page.locator('#import-file-dialog [data-close]').first().click();
  await page.locator('#profile').selectOption('robot');
  await mkdir('.cache',{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'.cache/vision-compact-desktop.png'});
  for(const width of [820,390]){
    await page.setViewportSize({width,height:844});
    for(const domain of ['track','world']){
      await page.locator('#tab-btn-'+domain).click();
      await page.addStyleTag({content:':root{font-family:Verdana,sans-serif}'});
      const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(size.width<=size.viewport+1,JSON.stringify(size));
      await page.locator('#'+domain+'-sonar-map').scrollIntoViewIfNeeded();
      const map=await page.locator('#'+domain+'-sonar-map').boundingBox(),settings=await page.locator('#'+domain+'-scan-settings summary').boundingBox();assert.ok(map.y+map.height<=settings.y+1);
    }
  }
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'.cache/vision-compact-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Vision layout passed: compact desktop header, scan before settings in both domains, responsive font fallbacks, repository/repeated import controls, actual camera FOV and goal-source labels, clipboard absence/denial fallback and synchronized console clearing.');
}finally{await browser.close();}
