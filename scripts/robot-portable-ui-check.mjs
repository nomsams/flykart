import {chromium} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const paste=async(input,data)=>{const dialog=page.locator('#'+input+'-dialog');await dialog.locator('textarea').fill(JSON.stringify(data));await dialog.locator('button[type="submit"]').click();await dialog.waitFor({state:'hidden'});};
const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
try{
  await page.goto(base+'/index.html');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:60000});await page.locator('#stop-btn').click();
  await page.locator('#import-btn').click();await paste('import-file',JSON.parse(await readFile('public/sample-brain.json','utf8')));await page.locator('#stop-btn').click();
  const brain=await download('export-btn');await page.locator('#import-btn').click();const dialog=page.locator('#import-file-dialog');
  await dialog.locator('textarea').fill('{broken');await dialog.locator('button[type="submit"]').click();await dialog.locator('[role="alert"]').filter({hasText:'Invalid JSON'}).waitFor();await dialog.locator('[data-close]').first().click();assert.deepEqual((await download('export-btn')).network,brain.network);await page.locator('#import-btn').click();
  // The unrestricted picker must avoid the MIME filter; a normal chooser still remains available.
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),dialog.locator('[data-any]').click()]);assert.equal(await page.locator('#import-file').getAttribute('accept'),'*/*');
  await page.evaluate(()=>Object.defineProperty(File.prototype,'text',{value:undefined,configurable:true}));
  await chooser.setFiles({name:'unknown-mime.json',mimeType:'application/octet-stream',buffer:Buffer.from(JSON.stringify(brain))});await dialog.waitFor({state:'hidden'});assert.match(await page.locator('#run-state').textContent(),/Checkpoint imported/);
  await page.locator('#import-btn').click();await paste('import-file',brain);assert.match(await page.locator('#run-detail').textContent(),/pasted-checkpoint/);
  await page.locator('#stop-btn').click();
  // Expanded descriptions and live reward chips must stay inside the v1 sidebar.
  await mkdir('.cache',{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:800,height:900},{width:390,height:844}]){
    await page.setViewportSize(viewport);await noOverflow();
    const b=page.locator('#reward-progress').locator('..').locator('.control-help-toggle');await b.click();await noOverflow();
    const contained=await page.evaluate(()=>{const box=document.querySelector('.control-panel').getBoundingClientRect();return [...document.querySelectorAll('.reward-fields label,.reward-breakdown span')].every(e=>{const r=e.getBoundingClientRect();return r.left>=box.left&&r.right<=box.right+1;});});assert.ok(contained);
    await b.click();if(viewport.width===390)await page.locator('.control-panel').screenshot({path:'.cache/racer-portable-mobile.png'});
  }
  await page.setViewportSize({width:1440,height:1000});await page.locator('#generations').fill('100');await page.locator('#population').fill('5');await page.locator('#training-speed').selectOption('1');await page.locator('#evolve-five-btn').click();
  await page.waitForFunction(()=>Number(document.querySelector('#training-throughput').dataset.ticks)>10);
  const slow=await page.locator('#training-throughput').getAttribute('data-ticks');await page.locator('#training-speed').selectOption('0');
  await page.waitForFunction(n=>Number(document.querySelector('#training-throughput').dataset.ticks)>Number(n)+60,slow,{timeout:30000});assert.match(await page.locator('#training-throughput').textContent(),/Fast · maximum.*achieved/);await page.locator('#stop-btn').click();assert.ok(await page.locator('#import-btn').isEnabled());
  await page.goto(base+'/vision.html');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:60000});
  assert.equal(await page.locator('#sonar-row').isVisible(),false);
  assert.equal(await page.locator('#camera-experiment').evaluate(e=>e.parentElement.id),'tab-track');assert.ok(await page.locator('.vision-inspector:not([open])').count()>=2);
  await page.locator('#vision-diagnostics').click();assert.ok(await page.locator('.vision-inspector[open]').count()>=2);await page.locator('#vision-diagnostics').click();
  await page.locator('#import-btn').click();await paste('import-file',brain);assert.equal(await page.locator('#track-controller').inputValue(),'imported');
  for(const viewport of [{width:1440,height:1000},{width:800,height:900},{width:390,height:844}]){await page.setViewportSize(viewport);await noOverflow();}
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'.cache/vision-portable-mobile.png'});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.cache/vision-portable-desktop.png'});
  await page.goto(base+'/robot.html?tools=all');await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});const lab=await download('save-lab');await page.locator('button[aria-controls="lab-file-dialog"]').click();await paste('lab-file',lab);assert.deepEqual((await download('save-lab')).objects,lab.objects);
  assert.deepEqual(errors,[]);console.log('Portable UI passed: JSON paste/any-file/FileReader fallback, import validation, v1 reward containment, responsive Vision workbench, preserved imports, selectable population-training throughput and Stop.');
}finally{await browser.close();}
