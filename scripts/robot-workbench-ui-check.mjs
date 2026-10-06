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
  // All live screens fit with the habitat, and keep following while lower tools are used.
  await mkdir('.cache',{recursive:true});
  for(const viewport of [{width:1440,height:1080},{width:1366,height:768},{width:1024,height:768}]){
    await page.setViewportSize(viewport);await page.evaluate(()=>scrollTo(0,0));
    await page.waitForFunction(()=>document.querySelector('.sensor-rail').getBoundingClientRect().bottom<=innerHeight);
    const bounds=await page.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,left:r.left,height:r.height};};return{stage:rect('.stage'),rail:rect('.sensor-rail'),canvases:['#camera','#fly-eye','#room-map'].map(rect),width:document.documentElement.scrollWidth};});
    assert.ok(Math.abs(bounds.stage.top-bounds.rail.top)<2);assert.ok(bounds.stage.bottom<=viewport.height);assert.ok(bounds.rail.left>=bounds.stage.right);assert.ok(bounds.width<=viewport.width+1);
    for(const r of bounds.canvases){assert.ok(r.height>90,JSON.stringify({viewport,bounds}));assert.ok(r.top>=0&&r.bottom<=viewport.height);}
    if(viewport.width===1366)await page.screenshot({path:'.cache/robot-monitors-laptop.png'});
    await page.locator('#robot-workbench').evaluate(e=>e.scrollIntoView({block:'start'}));
    const sticky=await page.locator('.sensor-rail').boundingBox();assert.ok(sticky.y>=0&&sticky.y<=16);assert.ok(sticky.y+sticky.height<=viewport.height);
    if(viewport.width===1366)await page.screenshot({path:'.cache/robot-monitors-workbench.png'});
  }
  await page.setViewportSize({width:1440,height:1080});await page.evaluate(()=>scrollTo(0,0));
  for(const [index,id] of [[0,'camera'],[1,'fly-eye'],[2,'room-map']]){await page.locator(`[data-monitor="${index}"]`).click();assert.equal(await page.locator('.sensor-rail .sensor-card:visible').count(),1);assert.ok((await page.locator('#'+id).boundingBox()).height>450);assert.ok(await page.locator('#'+id).isVisible());}
  await page.locator('[data-monitor="-1"]').click();assert.equal(await page.locator('.sensor-rail .sensor-card:visible').count(),3);
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
  assert.equal(await page.locator('.workspace>.sensor-rail').count(),1);assert.equal(await page.locator('#camera').count(),1);
  console.log('Robot workbench passed: all three monitors fit and follow lower tools, focused/all views, search, keyboard navigation, deep links, retained values, stop controls, persistence and mobile layout.');
}finally{await browser.close();}
