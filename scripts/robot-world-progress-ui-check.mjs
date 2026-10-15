import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.setDefaultNavigationTimeout(90000);
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const load=async data=>{await page.locator('#brain-import-always').click();await page.locator('#import-file-dialog').waitFor({state:'visible'});await page.locator('#import-file').setInputFiles({name:'progress-policy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await page.locator('#import-file-dialog').waitFor({state:'hidden'});};
try{
  await page.goto(base+'/vision.html#world');await page.waitForFunction(()=>document.querySelector('#boot-screen').hidden,{},{timeout:90000});
  assert.equal(await page.locator('#world-progress-on').isChecked(),true);assert.equal(await page.locator('#world-zero-chill').isChecked(),false);
  await page.locator('#world-task').selectOption('explore');await page.locator('#world-search-win').selectOption('reach');await page.locator('#world-map-preset').selectOption('clear');await page.locator('#world-repeat-search').uncheck();
  const brain=await download('brain-export-always');assert.equal(brain.worldTraining.searchJudge.enabled,true);
  // A complete valid inactive controller reliably tests rejection, without
  // relying on one imported champion's evolving motor behavior.
  const network=brain.controller.network;for(const key of ['inputWeights','recurrentWeights','outputWeights'])network[key]=network[key].map(()=>0);network.bias=network.bias.map(()=>-10);
  if(brain.world)brain.world.controller.network=structuredClone(network);
  brain.worldTraining.searchJudge={enabled:true,zeroChill:true,delaySeconds:2,cutoffSeconds:3,weight:2,loopGuard:true,blindReverse:true,antiJitter:true,jitterWindowSeconds:4,jitterWeight:2};brain.worldTraining.maxTicks=300;brain.worldTraining.reverseCoach=false;brain.progressJudge=structuredClone(brain.worldTraining.searchJudge);
  await load(brain);assert.equal(await page.locator('#world-zero-chill').isChecked(),true);assert.equal(await page.locator('#world-progress-weight').inputValue(),'2');
  const parent=(await download('brain-export-always')).controller.network;
  const idle=await page.evaluate(()=>{const s=window.flykartVision.world;for(let i=0;i<100;i++)s.step();return {done:s.done,pain:s.searchJudge.pain,cost:s.searchJudge.penalty,rejected:s.searchJudge.disqualified,reason:s.episode.sim.status.stopReason,inputs:[...s.driver.sensors],pose:{...s.episode.sim.kart}};});
  assert.equal(idle.done,true);assert.equal(idle.rejected,true);assert.ok(idle.pain>0&&idle.cost>0);assert.match(idle.reason,/Zero chill/);assert.deepEqual(idle.inputs.slice(0,2),[0,0]);
  await page.locator('#world-progress-on').uncheck();assert.equal(await page.evaluate(()=>window.flykartVision.world.searchJudge.settings.enabled),false);
  await page.evaluate(()=>{const s=window.flykartVision.world;for(let i=0;i<100;i++)s.step();});assert.equal(await page.evaluate(()=>window.flykartVision.world.searchJudge.disqualified),false);
  await page.locator('#world-progress-on').check();await page.locator('#world-generations').fill('2');await page.locator('#world-population').fill('2');assert.equal(await page.locator('#world-reverse-coach').isDisabled(),true);await page.locator('#world-train-speed').selectOption('0');await page.locator('#vision-render-mode').selectOption('turbo');
  const savedBefore=await page.evaluate(async()=>{const {loadEvolution}=await import('/src/evolution-checkpoint.ts');return (await loadEvolution('world'))?.text??null;});
  await page.locator('#world-train').click();await page.locator('#world-training-status').filter({hasText:'Every generation was rejected'}).waitFor({timeout:90000});
  const report=await download('world-train-report');assert.equal(report.viableGenerations,0);assert.deepEqual(report.brain,parent);assert.ok(report.trials.every(t=>t.disqualified&&t.noProgressPenalty>0));assert.equal(await page.locator('#world-train-adopt').isDisabled(),true);
  assert.equal(await page.evaluate(async()=>{const {loadEvolution}=await import('/src/evolution-checkpoint.ts');return (await loadEvolution('world'))?.text??null;}),savedBefore,'Rejected generations must not create or replace a saved winner');
  const exported=await download('brain-export-always');assert.deepEqual(exported.worldTraining.searchJudge,brain.worldTraining.searchJudge);assert.deepEqual(exported.controller.network,parent);
  await load(exported);assert.equal(await page.locator('#world-zero-chill').isChecked(),true);assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.searchJudge.settings),brain.worldTraining.searchJudge);
  await mkdir('.cache',{recursive:true});await page.locator('#world-progress-controls').screenshot({path:'.cache/world-progress-judge.png'});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  console.log('World progress passed: visible defaults, pain plus negative reward, visual-only inputs, live stop/disable, real worker all-rejected generations keep exact parent and cannot autosave/adopt, brain round-trip and mobile layout.');
}finally{await browser.close();}
