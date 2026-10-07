import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const source=JSON.parse(await readFile('assets/flykart-visual.json','utf8'));
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const order=async()=>assert.equal(await page.evaluate(()=>{
  const camera=document.querySelector('#camera-controller-training'),ghost=document.querySelector('#world-controller-training');
  return camera.nextElementSibling===ghost&&camera.closest('aside')===ghost.closest('aside');
}),true,'Ghost module belongs immediately below camera training');
const train=async generations=>{
  await page.locator('#world-generations').fill(String(generations));
  await page.locator('#world-train').click();
  await page.locator('#world-training-status').filter({hasText:'Complete.'}).waitFor({timeout:180000});
  return download('world-train-report');
};
try{
  await page.goto(base+'/vision.html#world');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:60000});
  await order();
  // Load through the real repository-checkpoint UI, preserving the source weights and saved scene.
  await page.locator('#brain-project-choice').selectOption('visual');await page.locator('#brain-load-project').click();
  await page.locator('#brain-file-status').filter({hasText:'assets/flykart-visual.json'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.controller.toJSON()),source.controller.network);
  const saved=await download('world-map-export');assert.deepEqual(saved.goals,source.worldArena.goals);
  // Small valid frozen eyes keep this UI regression inexpensive. No claim about navigation quality.
  const tiny=await page.evaluate(async()=>{
    const {VisionCnn}=await import('/src/vision/cnn.ts'),{defaultSpec,serialiseModel}=await import('/src/vision/perception.ts'),{WORLD_CAMERA}=await import('/src/vision/world/worldDomain.ts');
    return serialiseModel(new VisionCnn({...defaultSpec(1,10,'rgb',false),width:8,height:8,channels:[1,1,1],hidden:2},7),WORLD_CAMERA,Array(10).fill(1),'Target curriculum regression',undefined,undefined,'world');
  });
  await page.locator('#brain-import-always').click();
  await page.locator('#import-file').setInputFiles({name:'visual-parent.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...source,vision:tiny}))});
  await page.waitForFunction(()=>document.querySelector('#import-file').value==='');
  // Also exercise explicit scene replay: its saved coordinates must not leak into evolution.
  await page.locator('#world-map-file').setInputFiles({name:'saved-scene.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});
  await page.waitForFunction(()=>document.querySelector('#world-map-file').value==='');
  assert.equal(await page.locator('#world-map-preset').inputValue(),'imported');
  await page.locator('#world-population').fill('2');await page.locator('#world-train-ticks').fill('300');
  await page.locator('#world-failure-retries').selectOption('1');
  const report=await train(4),trials=report.targetTrials.filter(t=>t.phase==='training'),fresh=trials.filter(t=>t.retry===0);
  assert.equal(fresh.length,8);assert.equal(new Set(fresh.map(t=>JSON.stringify(t.targets))).size,8);
  assert.equal(report.failureRetries,1);assert.equal(report.context.goals,undefined);
  assert.deepEqual(report.context.world,saved.world);
  for(let generation=1;generation<=4;generation++){
    const batch=trials.filter(t=>t.generation===generation);assert.equal(batch.filter(t=>!t.retry).length,2);assert.ok(batch.length<=3);
  }
  for(const trial of trials){
    assert.ok(trials.filter(t=>t.seed===trial.seed).length<=2,'A failed seed can only be retried once');
    assert.equal(trial.targets.length,1);
    assert.ok(!saved.goals.some(g=>JSON.stringify(g)===JSON.stringify(trial.targets[0])));
  }
  assert.ok(report.validation.seeds.every(seed=>!report.trainingSeeds.includes(seed)));
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.controller.toJSON()),source.controller.network);
  assert.deepEqual((await download('world-map-export')).goals,saved.goals,'Evolution must not overwrite saved live-scene targets');
  await page.locator('#world-failure-retries').selectOption('0');
  await page.locator('#world-map-preset').selectOption('procedural');
  await page.locator('#tab-btn-track').click();await order();
  assert.equal(await page.locator('#camera-controller-training').evaluate(e=>e.closest('aside').querySelector('#track-controller')!==null),true);
  // Evolve from the shared sidebar must switch to the correct simulation and use a fresh run seed.
  const rerun=await train(2);assert.equal(await page.locator('#tab-world').isVisible(),true);await order();
  assert.notEqual(rerun.targetSeed,report.targetSeed);
  assert.equal(rerun.context.world,undefined,'Procedural training samples fresh seeded rooms too');
  assert.ok(rerun.targetTrials.filter(t=>t.phase==='training').every(t=>t.retry===0));
  assert.equal(new Set(rerun.trainingSeeds).size,4);
  assert.equal((await download('brain-export-always')).worldTraining.failureRetries,0);
  await page.locator('#world-train-adopt').click();
  assert.deepEqual((await download('brain-export-always')).controller.network,rerun.brain);
  await mkdir('.cache',{recursive:true});await writeFile('.cache/target-curriculum-evidence.json',JSON.stringify({trials,rerun:rerun.targetTrials},null,2));
  await page.locator('#world-controller-training').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/target-curriculum-desktop.png'});
  await page.setViewportSize({width:390,height:844});await order();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:'.cache/target-curriculum-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Target curriculum passed: actual repository import, eight fresh target sets across four generations, finite failure retries, independent validation targets and run seeds, preserved parent/room/live goals, shared training order and mobile layout.');
}finally{await browser.close();}
