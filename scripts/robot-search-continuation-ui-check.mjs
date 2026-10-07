import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const sourceText=await readFile('assets/flykart-visual.json','utf8'),source=JSON.parse(sourceText);
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const loadVisual=async()=>{await page.locator('#brain-project-choice').selectOption('visual');await page.locator('#brain-load-project').click();await page.locator('#brain-file-status').filter({hasText:'assets/flykart-visual.json'}).waitFor();};
const approach=async()=>page.evaluate(()=>{
  const s=window.flykartVision.world,g={...s.episode.sim.goals[0]},k=s.episode.sim.kart,direction=g.x>=0?1:-1;
  // Deterministic placement tests the real camera/arrival/continuation plumbing,
  // not the navigation quality of this checkpoint.
  s.controller.step=()=>({steer:0,throttle:0,brake:0,reverse:0});
  s.episode.mission=()=>{throw Error('A visual search called the world compass');};
  k.x=g.x-direction*80;k.y=g.y;k.heading=direction===1?0:Math.PI;k.speed=0;
  for(let i=0;i<6&&!s.found;i++)s.step();
  if(!s.found)throw Error('Rendered flag was not confirmed');
  if(s.won)throw Error('Seeing the flag won without arrival');
  k.x=g.x-direction*10;
  return g;
});
try{
  await page.goto(base+'/vision.html#world');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:60000});
  await loadVisual();assert.equal(await page.locator('#repository-brain-select').inputValue(),'visual');
  assert.equal(await page.locator('#world-task').inputValue(),'explore');assert.equal(await page.locator('#world-search-win').inputValue(),'reach');assert.equal(await page.locator('#world-goal-preset').inputValue(),'far');
  assert.equal(await page.locator('#world-repeat-search').isChecked(),true);
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.controller.toJSON()),source.controller.network);
  assert.equal(await page.evaluate(()=>window.flykartVision.world.driver.options.perceiver.model.params),source.vision.params);
  assert.deepEqual((await download('brain-export-always')).controller.network,source.controller.network);
  assert.equal(await (await page.request.get(base+'/checkpoints/flykart-visual.json')).text(),sourceText);
  await page.evaluate(()=>{window.originalSearch=window.flykartVision.world;window.originalController=window.originalSearch.controller;});
  const points=[];
  for(let i=0;i<6;i++){
    const old=await approach();points.push(old);
    await page.locator('#world-run').click();await page.waitForFunction(n=>window.flykartVision.world.searchesCompleted===n,i+1,{timeout:30000});await page.locator('#world-run').click();
    const next=await page.evaluate(()=>{
      const s=window.flykartVision.world,g={...s.episode.sim.goals[0]},k=s.episode.sim.kart;s.episode.render();
      return{goal:g,distance:Math.hypot(g.x-k.x,g.y-k.y),sameSession:s===window.originalSearch,sameController:s.controller===window.originalController,flags:s.episode.scene.sprites.filter(s=>s.shape==='flag').map(s=>({x:s.x,y:s.y}))};
    });
    assert.equal(next.sameSession,true);assert.equal(next.sameController,true);assert.ok(next.distance>=322);assert.notDeepEqual(next.goal,old);assert.deepEqual(next.flags,[next.goal]);
  }
  assert.equal(new Set(points.map(g=>`${g.x},${g.y}`)).size,6);
  await page.locator('summary').filter({hasText:'What reaches the brain'}).click();
  assert.match(await page.locator('#world-input-source').innerText(),/WORLD COMPASS BLOCKED/);assert.match(await page.locator('#world-input-source').innerText(),/fixed pink-colour detector/);
  assert.match(await page.locator('#world-neural-inputs').innerText(),/Image bearing/);assert.match(await page.locator('#world-sensor-log').inputValue(),/Search 6 complete/);
  const scene=await download('world-map-export');assert.equal(scene.exercise.repeatSearch,true);assert.equal(scene.goals.length,1);
  await page.locator('#world-repeat-search').uncheck();const old=await approach();
  await page.locator('#world-run').click();await page.locator('#world-status').filter({hasText:'Search won'}).waitFor();
  assert.equal(await page.evaluate(()=>window.flykartVision.world.searchesCompleted),6);
  const removed=await page.evaluate(()=>{const s=window.flykartVision.world;s.episode.render();return{goals:s.episode.sim.goals.length,flags:s.episode.scene.sprites.filter(s=>s.shape==='flag').length};});assert.deepEqual(removed,{goals:0,flags:0});
  const saved=await download('brain-export-always');assert.equal(saved.worldSetup.repeatSearch,false);
  // Repository selection is independent of the browser-saved brain source.
  if(!await page.locator('.browser-brain-shelf').evaluate(e=>e.open))await page.locator('.browser-brain-shelf>summary').click();
  await page.locator('[data-brain-save]').click();await page.locator('.browser-brain-shelf [role=status]').filter({hasText:'Saved vision brain'}).waitFor();
  await page.locator('#repository-brain-select').selectOption('racer');assert.equal(await page.locator('#brain-project-choice').inputValue(),'racer');await page.locator('#brain-load-project').click();await page.waitForFunction(()=>window.flykartVision.imported?.name==='flykart-brain-racer');
  await page.locator('[aria-label="Browser brain source"]').selectOption('vision');await page.locator('[data-brain-load]').click();await page.locator('.browser-brain-shelf [role=status]').filter({hasText:'Loaded vision brain'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.controller.toJSON()),source.controller.network);assert.equal(await page.locator('#world-repeat-search').isChecked(),false);
  await mkdir('.cache',{recursive:true});await page.locator('#brain-project-choice').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/search-repository-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'.cache/search-repository-mobile.png'});
  await page.goto(base+'/index.html');await page.locator('#repository-brain-select').waitFor({timeout:60000});assert.equal(await page.locator('#repository-brain-select option[value=visual]').evaluate(option=>option.disabled),true);
  assert.deepEqual(errors,[]);
  console.log('Visual search continuation passed: exact selectable repository checkpoints, six fresh distant flags without respawn or compass, actual camera confirmation + arrival, collected flags removed, bounded single-trial option, scene/brain/browser persistence, source audit and mobile layout.');
}finally{await browser.close();}
