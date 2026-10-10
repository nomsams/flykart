import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultNavigationTimeout(90000);
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const ready=()=>page.locator('#status').filter({hasText:'Ready ·'}).waitFor({timeout:90000});
try{
  await page.goto(base+'/parking.html');await ready();
  assert.equal(await page.locator('#slow-driving').isChecked(),false);await page.locator('#slow-driving').check();await page.locator('#slow-mode').selectOption('pain');await page.locator('#slow-weight').fill('2');await page.locator('#slow-weight').dispatchEvent('change');
  const lab=await download('save-state');lab.scene.actors=[];lab.scene.start={x:.8,z:0,heading:0};lab.scene.target={...lab.scene.target,x:0,z:0,heading:0};lab.scene.bays=lab.scene.bays.map(b=>b.id===lab.scene.target.id?{...lab.scene.target}:b);lab.settings.maxTicks=120;
  await page.locator('#import-state').setInputFiles({name:'headless-lot.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(lab))});await page.locator('#status').filter({hasText:'restored'}).waitFor();
  await page.evaluate(()=>{const s=window.flykartParking.session;for(let i=0;i<60;i++)s.step({steer:0,throttle:0,brake:0});});await page.locator('#refresh').click();assert.ok(await page.evaluate(()=>window.flykartParking.session.episode.status.slowPain>1.9));
  const exported=await download('export-brain');assert.equal(exported.controller.provenance.at(-1).settings.slowMode,'pain');
  if(process.env.ROBOT_PARKING_CLI_CHECKPOINT){const checkpoint=JSON.parse(await readFile(process.env.ROBOT_PARKING_CLI_CHECKPOINT,'utf8'));await page.locator('#import-brain').setInputFiles(process.env.ROBOT_PARKING_CLI_CHECKPOINT);await page.locator('#status').filter({hasText:'Imported world controller'}).waitFor();assert.deepEqual((await download('export-brain')).controller.network,checkpoint.controller.network);assert.ok(checkpoint.controller.provenance.some(p=>p.runId?.startsWith('cli-')));}
  await page.locator('#memory-size').selectOption('512');assert.equal(await page.locator('#generations').getAttribute('max'),'1000');assert.equal(await page.locator('#population').getAttribute('max'),'32');
  await page.locator('#generations').fill('3');await page.locator('#population').fill('2');for(const i of await page.locator('#curriculum input').all())await i.uncheck();await page.locator('#curriculum input[value=arrival]').check();
  await page.locator('#training-runtime-controls details>summary').click();await page.locator('#watch-generation').fill('2');await page.locator('#watch-generation').dispatchEvent('change');await page.locator('#watch-speed').selectOption('1');
  const before=await page.locator('#camera').evaluate(c=>c.toDataURL());await page.locator('#headless-evolve').click();
  await page.waitForFunction(()=>window.flykartParking.busy&&window.flykartParking.training.generation===1&&window.flykartParking.training.ticks>10,{},{timeout:60000});
  assert.equal(await page.locator('#camera').evaluate(c=>c.toDataURL()),before);assert.ok(await page.evaluate(()=>window.flykartParking.training.scans.every(n=>n===0)));assert.equal(await page.locator('#preview').isDisabled(),false);assert.equal(await page.locator('#training-speed').isDisabled(),false);
  await page.waitForFunction(()=>window.flykartParking.busy&&window.flykartParking.training.generation===2&&window.flykartParking.training.scans[0]>1,{},{timeout:60000});
  await page.waitForFunction(()=>document.querySelector('#camera').dataset.generation==='2');assert.notEqual(await page.locator('#camera').evaluate(c=>c.toDataURL()),before);
  await page.locator('#training-speed').selectOption('256');await page.locator('#headless-again').click();assert.equal(await page.evaluate(()=>window.flykartParking.training.display),false);
  await page.locator('#watch-now').click();assert.equal(await page.locator('#preview').inputValue(),'low');await page.locator('#headless-again').click();
  await page.waitForFunction(()=>!window.flykartParking.busy&&window.flykartParking.report,{},{timeout:90000});const report=await download('export-report');assert.equal(report.generations,3);assert.equal(report.settings.slowDriving,true);assert.ok(report.trials.flatMap(t=>t.results.flat()).every(r=>Number.isFinite(r.slowPain)));
  await page.locator('#preview').selectOption('full');await page.locator('#training-runtime-controls details>summary').click();await page.evaluate(()=>scrollTo(0,0));await mkdir('.cache',{recursive:true});assert.ok(await page.locator('.monitors').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight+1));await page.screenshot({path:'.cache/parking-headless-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'.cache/parking-headless-mobile.png',fullPage:true});
  await page.goto(base+'/vision.html#world');await page.waitForFunction(()=>Boolean(window.flykartVision),{},{timeout:90000}).catch(async e=>{console.error('Vision boot:',errors,await page.locator('#boot-screen').innerText());throw e;});await page.locator('#vision-render-mode').selectOption('turbo');await page.waitForFunction(()=>document.querySelector('#vision-runtime-note').textContent.includes('longer compute batches'));
  assert.deepEqual(errors,[]);console.log('Parking headless UI passed: slow-pain controls/export, unchanged canvases and skipped maps in headless ghosts, scheduled generation preview, live speed/preview changes, 1000-generation/32-ghost limits, final reports, desktop/mobile fit and Vision throughput mode.');
}finally{await browser.close();}
