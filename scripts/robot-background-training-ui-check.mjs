import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true,ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],workers=[];
page.on('pageerror',e=>errors.push(e.message));page.on('worker',w=>workers.push(w.url()));
page.setDefaultNavigationTimeout(90000);
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const wait=async(fn,timeout=90000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await page.evaluate(fn))return;if(await page.evaluate(()=>document.querySelector('#status')?.textContent.includes('Background training worker:')))throw Error(await page.locator('#status').textContent());await new Promise(r=>setTimeout(r,150));}throw Error('Background wait timed out: '+await page.locator('body').innerText());};
// Emulate the browser pausing tab timers/paint without pausing worker execution.
const install=async()=>page.evaluate(()=>{
  window.backgroundTestHidden=false;window.backgroundDroppedTimers=0;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.backgroundTestHidden});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.backgroundTestHidden?'hidden':'visible'});
  const timer=window.setTimeout.bind(window),paint=window.requestAnimationFrame.bind(window);
  window.setTimeout=(fn,delay,...args)=>window.backgroundTestHidden?(window.backgroundDroppedTimers++,-1):timer(fn,delay,...args);
  window.requestAnimationFrame=fn=>window.backgroundTestHidden?-1:paint(t=>{if(!window.backgroundTestHidden)fn(t);});
  window.setTrainingVisibility=hidden=>{window.backgroundTestHidden=hidden;document.dispatchEvent(new Event('visibilitychange'));};
});
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
try{
  await page.goto(base+'/parking.html');await wait(()=>Boolean(window.flykartParking));await install();
  const lab=await download('save-state');lab.settings.maxTicks=60;
  await page.locator('#import-state').setInputFiles({name:'short-lot.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(lab))});await page.locator('#status').filter({hasText:'restored'}).waitFor();
  await page.locator('#memory-size').selectOption('512');await page.locator('#generations').fill('3');await page.locator('#population').fill('2');await page.locator('#training-seed').fill('72');await page.locator('.training-options').evaluate(e=>e.open=true);for(const box of await page.locator('#curriculum input').all())await box.uncheck();await page.locator('#curriculum input[value=arrival]').check();
  const source=await page.evaluate(()=>({brain:window.flykartParking.brain,settings:window.flykartParking.settings}));
  await page.locator('#evolve').click();await page.evaluate(()=>window.setTrainingVisibility(true));
  const pixels=await page.locator('#camera').evaluate(c=>c.toDataURL());
  await wait(()=>!window.flykartParking.busy&&Boolean(window.flykartParking.report));
  const report=await page.evaluate(()=>window.flykartParking.report);assert.equal(report.generations,3);assert.equal(await page.locator('#camera').evaluate(c=>c.toDataURL()),pixels);assert.ok(workers.some(w=>w.includes('training.worker')));
  assert.ok(await page.evaluate(()=>{window.setTimeout(()=>{},0);return window.backgroundDroppedTimers>0;}),'Window timers must really be paused');
  const saved=await page.evaluate(async()=>{const {loadEvolution}=await import('/src/evolution-checkpoint.ts');return (await loadEvolution('parking')).text;});const winner=JSON.parse(saved);assert.equal(winner.controller.generation,3);assert.deepEqual(winner.controller.network,report.brain);
  await page.evaluate(()=>window.setTrainingVisibility(false));
  const direct=await page.evaluate(async data=>{const {trainParking}=await import('/src/parking/training.ts');return trainParking(data.brain,data.settings,{generations:3,population:2,lessons:['arrival'],seed:72,speed:0,preview:()=>false,cancel:()=>false,log:()=>{},progress:()=>{}});},source);
  assert.deepEqual(report.brain,direct.brain);assert.deepEqual(report.trials,direct.trials);assert.deepEqual(report.validation,direct.validation);console.log('Parking completed/autosaved with paused window callbacks; worker/direct results match.');
  await page.locator('#generations').fill('100');await page.locator('#headless-evolve').click();await page.evaluate(()=>window.setTrainingVisibility(true));await wait(()=>window.flykartParking.training.ticks>10);await page.evaluate(()=>document.querySelector('#cancel').click());await wait(()=>!window.flykartParking.busy);assert.match(await page.locator('#training-status').textContent(),/Cancelled/);
  console.log('Hidden-tab cancellation verified.');await page.goto(base+'/vision.html#world');await wait(()=>Boolean(window.flykartVision));await install();await page.locator('#world-driver').selectOption('vision');await page.locator('#world-generations').fill('1');await page.locator('#world-population').fill('2');await page.locator('#world-train-ticks').fill('300');await page.locator('#world-reverse-coach').uncheck();await page.locator('#vision-render-mode').selectOption('turbo');await page.locator('#world-train').click();await page.evaluate(()=>window.setTrainingVisibility(true));await wait(()=>document.querySelector('#world-training-status').textContent.includes('Complete.'));assert.ok(await page.evaluate(async()=>{const {loadEvolution}=await import('/src/evolution-checkpoint.ts');return Boolean(await loadEvolution('world'));}));
  console.log('World background worker completed and autosaved.');await page.goto(base+'/vision.html#track');await wait(()=>Boolean(window.flykartVision));await install();await page.locator('#camera-generations').fill('1');await page.locator('#camera-population').fill('2');await page.locator('#camera-train-ticks').fill('300');await page.locator('#camera-controller-training').evaluate(e=>e.open=true);await page.locator('#camera-train').click();await page.evaluate(()=>window.setTrainingVisibility(true));await wait(()=>document.querySelector('#camera-train-status').textContent.includes('Training complete.'));assert.ok(await page.evaluate(async()=>{const {loadEvolution}=await import('/src/evolution-checkpoint.ts');return Boolean(await loadEvolution('track'));}));
  assert.deepEqual(errors,[]);console.log('Background evolution passed: dedicated Parking/World/Racer workers complete with tab timers and RAF paused, unchanged hidden canvases, generation autosaves, identical direct/worker offspring and scores, and cancellation while hidden. Browser suspension emulated; no hardware used.');
}finally{await browser.close();}
