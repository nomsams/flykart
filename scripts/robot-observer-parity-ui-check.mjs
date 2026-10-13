import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
page.setDefaultNavigationTimeout(90000);page.setDefaultTimeout(30000);
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async(id,p=page)=>{await p.locator('#'+id).evaluate(e=>{for(let a=e.parentElement;a;a=a.parentElement)if(a instanceof HTMLDetailsElement)a.open=true;});const[d]=await Promise.all([p.waitForEvent('download'),p.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const load=async b=>{await page.locator('#brain-import-always').click();await page.locator('#import-file').setInputFiles({name:'observer-parent.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(b))});await page.locator('#import-file-dialog').waitFor({state:'hidden'});};
try{
  await page.goto(base+'/vision.html#world');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:90000});
  await page.locator('#world-fpv-mode').selectOption('overlay');await page.locator('#world-fpv-opacity').fill('55');await page.locator('#world-fpv-opacity').dispatchEvent('input');
  const original=await download('brain-export-always');
  assert.deepEqual(original.observerSettings.fpv,{mode:'overlay',opacity:55});
  // A second lab follows display changes, without selecting a different brain.
  const parking=await context.newPage();parking.setDefaultNavigationTimeout(90000);await parking.goto(base+'/parking.html');await parking.locator('#status').filter({hasText:'Ready ·'}).waitFor({timeout:90000});
  assert.equal(await parking.locator('#parking-fpv-mode').inputValue(),'overlay');
  const parent=await parking.evaluate(()=>window.flykartParking.brain.controller);
  await parking.locator('#parking-fpv-mode').selectOption('sonar');await page.waitForFunction(()=>document.querySelector('#world-fpv-mode').value==='sonar');
  assert.deepEqual(await parking.evaluate(()=>window.flykartParking.brain.controller),parent);assert.deepEqual((await download('brain-export-always')).controller.network,original.controller.network);
  await parking.locator('#scan-evidence').selectOption('cells');await page.waitForFunction(()=>document.querySelector('#world-scan-evidence').value==='cells');
  await parking.close();await page.bringToFront();
  console.log("Shared display preferences and unchanged active brains verified.");
  // A zero-action parent keeps this real-worker final comparison deterministic.
  const fixture=structuredClone(original);for(const key of ['inputWeights','recurrentWeights','outputWeights'])fixture.controller.network[key]=fixture.controller.network[key].map(()=>0);fixture.controller.network.bias=fixture.controller.network.bias.map(()=>-10);
  if(fixture.world)fixture.world.controller.network=structuredClone(fixture.controller.network);
  fixture.worldTraining={...fixture.worldTraining,maxTicks:300,reverseCoach:false,retainForward:false,failureRetries:0,searchJudge:{...fixture.worldTraining.searchJudge,enabled:false}};
  fixture.progressJudge={...fixture.worldTraining.searchJudge};fixture.worldSetup={...fixture.worldSetup,mapPreset:'clear',goalPreset:'far',driver:'vision',repeatSearch:false};
  await load(fixture);await page.locator('#world-generations').fill('1');await page.locator('#world-population').fill('2');await page.locator('#world-train-speed').selectOption('0');await page.locator('#vision-render-mode').selectOption('headless');await page.locator('#world-train').click();
  await page.locator('#world-training-status').filter({hasText:'Complete.'}).waitFor({timeout:180000});
  assert.equal(await page.locator('#world-inspect-ghost').isDisabled(),false,'Final comparisons must remain inspectable');
  await page.locator('#world-inspect-ghost').selectOption('1');await page.locator('#vision-refresh').click();assert.equal(await page.locator('#world-eye').getAttribute('data-cart'),'Cart 2');assert.match(await page.locator('#world-ghost-controls').textContent(),/frozen comparison/);
  const comparison=await page.evaluate(async()=>{const {inspectedGenotype}=await import('/src/training-preview.ts');const s=window.flykartVision.inspection.world;return {brain:inspectedGenotype(s),frame:Array.from(s.episode.frame),tick:s.episode.tick,scan:s.sonarMap.toJSON()};});
  assert.ok(comparison.frame.length&&comparison.frame.some(v=>v!==0));assert.deepEqual((await download('world-ghost-export')).controller.network,comparison.brain);
  assert.deepEqual((await download('world-scan-export')),comparison.scan,'Scan export must follow the inspected cart');
  await page.locator('.world-ghost-inspector').getByRole('button',{name:'Previous cart'}).click();assert.equal(await page.locator('#world-inspect-ghost').inputValue(),'0');await page.locator('.world-ghost-inspector').getByRole('button',{name:'Previous cart'}).click();assert.equal(await page.locator('#world-inspect-ghost').inputValue(),'-1');
  await page.locator('#world-inspect-ghost').selectOption('1');await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>window.flykartVision.inspection.world.episode.tick),comparison.tick,'Inspecting a frozen observer must not drive it');
  console.log("Final headless cart frames, exact genotype export and frozen inspection verified.");
  // 3D uses a separate observer canvas, preserving raw camera and controller weights.
  await page.goto(base+'/robot.html?tools=all');await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:90000});
  assert.equal(await page.locator('#robot-fpv-mode').inputValue(),fixture.observerSettings.fpv.mode);
  await page.locator('#step-size').selectOption('30');await page.locator('#step').click();
  const lab=await download('save-lab');assert.ok(lab.roomScan.samples.length>0);assert.equal(lab.learning.trialJudge.enabled,false);
  const raw=await page.locator('#camera').evaluate(c=>c.toDataURL());await page.locator('#robot-fpv-mode').selectOption('sonar');await page.waitForFunction(()=>document.querySelector('#robot-fpv').dataset.fpvMode==='sonar');assert.equal(await page.locator('#camera').isVisible(),false);assert.equal(await page.locator('#robot-fpv').isVisible(),true);
  await page.locator('#robot-fpv-mode').selectOption('overlay');await page.waitForFunction(()=>document.querySelector('#robot-fpv').dataset.fpvMode==='overlay');assert.equal(await page.locator('#camera').evaluate(c=>c.toDataURL()),raw);assert.deepEqual((await download('save-lab')).controller.network,lab.controller.network);
  await page.locator('#room-scan-evidence').selectOption('arcs');await page.waitForFunction(()=>document.querySelector('#room-map').dataset.evidence==='arcs');assert.equal(await page.locator('#room-map').getAttribute('data-beam-kind'),'simulated transmission');
  const saved=await download('save-lab');await page.locator('#lab-file').setInputFiles({name:'observer-lab.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});await page.locator('#status').filter({hasText:'Imported habitat'}).waitFor();const restored=await download('save-lab');assert.deepEqual(restored.roomScan,saved.roomScan);assert.deepEqual(restored.memory.counts,saved.memory.counts);assert.deepEqual(restored.memory.prototypes,saved.memory.prototypes);
  console.log("3D raw-pixel isolation and portable map/lab views verified.");
  // Enable shared judge and leave an idle machine commanded for 15 simulated seconds.
  await page.locator('#robot-judge-enabled').check();await page.locator('#robot-zero-chill').check();await page.locator('#reset').click();
  await page.locator('#default-code').click();await page.locator('#drive-mode').selectOption('manual');await page.locator('#step-size').selectOption('150');for(let i=0;i<3;i++)await page.locator('#step').click();
  const judged=await page.locator('#robot-judge-status').textContent();assert.match(judged,/REJECTED/);assert.ok(Number(judged.match(/pain ([\d.]+)/)?.[1])>0);
  const weights=(await download('save-lab')).controller.network;await page.reload();await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:90000});assert.equal(await page.locator('#robot-zero-chill').isChecked(),true);assert.equal(await page.locator('#robot-judge-enabled').isChecked(),true);assert.deepEqual((await download('save-lab')).controller.network,weights);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/observer-parity-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Observer parity passed: shared views without brain switching, final headless cart selection/export, selected scan export, frozen observers, raw 3D pixel isolation, map/lab round-trip, shared Zero chill and mobile layout.');
}catch(e){console.error(errors);await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/observer-parity-failure.png',fullPage:true}).catch(()=>{});throw e;}finally{await browser.close();}
