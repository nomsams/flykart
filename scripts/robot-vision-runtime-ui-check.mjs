import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const scene=async data=>{await page.locator('#world-map-file').setInputFiles({name:'room.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await page.waitForFunction(()=>document.querySelector('#world-map-preset').value==='imported');};
const download=async id=>{const [file]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await file.path(),'utf8'));};
try{
  await page.goto(base+'/vision.html');await page.waitForFunction(()=>document.querySelector('#boot-screen').hidden,{},{timeout:60000});
  await page.locator('#brain-load-project').click();await page.waitForFunction(()=>window.flykartVision.imported?.name==='flykart-brain-racer');
  assert.match(await page.locator('#brain-file-status').innerText(),/assets\/flykart-brain-racer.json/);
  const source=JSON.parse(await readFile('assets/flykart-brain-racer.json','utf8'));
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.imported.snapshot),source.network);
  await page.locator('#tab-btn-world').click();await page.locator('#world-scan-status').filter({hasText:'No sonar is fitted'}).waitFor();
  await page.locator('#world-scan-enable').click();assert.equal(await page.locator('#profile').inputValue(),'robot');
  await page.locator('#world-driver').selectOption('expert');
  const arena={format:'flykart-world',version:1,world:{seed:7,half:150,obstacles:[{x:80,y:0,radius:12,height:30,tone:.5,kind:'rock'}],patches:[]},start:{x:0,y:0,heading:0},goals:[{x:-80,y:30}],exercise:{task:'forage',searchWin:'reach',goalPreset:'near'}};
  await scene(arena);await page.waitForFunction(()=>window.flykartVision.world.sonarMap.cells.size>0);
  assert.match(await page.locator('#world-scan-status').innerText(),/echoes/);
  await mkdir('.cache',{recursive:true});await page.locator('#world-sonar-map').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/vision-runtime-scan-desktop.png'});
  const before=await page.locator('#world-sonar-map').evaluate(c=>c.toDataURL());
  await page.locator('#vision-render-mode').selectOption('headless');await page.locator('#world-run').click();
  await page.waitForFunction(()=>window.flykartVision.world.episode.tick>=12);
  assert.equal(await page.locator('#world-sonar-map').evaluate(c=>c.toDataURL()),before);
  assert.ok(await page.evaluate(()=>window.flykartVision.world.sonarMap.samples.length)>1);
  await page.locator('#vision-refresh').click();assert.notEqual(await page.locator('#world-sonar-map').evaluate(c=>c.toDataURL()),before);
  await page.locator('#world-run').click();
  await page.locator('#world-map-preset').selectOption('clear');await page.locator('#world-goal-preset').selectOption('random');await page.locator('#world-goal-count').selectOption('random');
  const layouts=[];
  for(let seed=1;seed<=8;seed++){await page.locator('#world-seed').fill(String(seed));await page.locator('#world-seed').dispatchEvent('change');layouts.push(await page.evaluate(()=>window.flykartVision.world.episode.sim.goals));}
  assert.ok(new Set(layouts.map(g=>g.length)).size>=3);assert.ok(layouts.some(g=>g.length>2));assert.notDeepEqual(layouts[0],layouts[1]);
  const saved=await download('world-map-export');assert.equal(saved.exercise.goalCount,'random');assert.deepEqual(saved.goals,layouts.at(-1));
  await page.locator('#world-goal-count').selectOption('1');await scene(saved);assert.equal(await page.locator('#world-goal-count').inputValue(),'random');assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.episode.sim.goals),saved.goals);
  // Collect a flag with no possible next target: previously nextGoal threw out
  // of the animation callback, leaving every subsequent Start inert.
  await page.evaluate(async()=>{const {WorldSession}=await import('/src/vision/ui/sessions.ts');const s=window.flykartVision.world;const world={seed:1,half:150,obstacles:[],patches:[{x:0,y:0,radius:120,kind:'water'}]};const test=new WorldSession({...s.settings,world,start:{x:130,y:0,heading:0},goals:[{x:130,y:0}],goalCount:undefined,goalPreset:'far',kind:'expert',sensorOnly:false});Object.defineProperty(test.episode.sim,'goalLimit',{value:Infinity});window.flykartVision.world=test;});
  await page.locator('#world-run').click();await page.locator('#world-status').filter({hasText:'no clear next target'}).waitFor();
  assert.equal(await page.evaluate(()=>window.flykartVision.world.episode.sim.status.crashed),false);
  await page.locator('#world-map-preset').selectOption('clear');await page.locator('#world-goal-preset').selectOption('near');await page.locator('#world-goal-count').selectOption('1');
  await page.locator('#world-run').click();await page.waitForFunction(()=>window.flykartVision.world.episode.tick>=5);await page.locator('#world-run').click();
  // Camera-only training still runs inference with preview disabled, and keeps
  // CPU mode / cancellation available while editing brain setup is locked.
  await page.locator('#world-driver').selectOption('vision');await page.locator('#world-generations').fill('1');await page.locator('#world-population').fill('2');await page.locator('#world-train-ticks').fill('300');await page.locator('#world-reverse-coach').uncheck();
  await page.locator('#world-train').click();await page.locator('#world-train-stop').waitFor({state:'visible'});assert.equal(await page.locator('#vision-render-mode').isEnabled(),true);
  await page.locator('#world-ghost-scores').filter({hasText:'targets'}).waitFor();await page.locator('#vision-refresh').click();await page.locator('#world-train-stop').click();await page.locator('#world-training-status').filter({hasText:'Cancelled'}).waitFor({timeout:60000});
  await page.locator('#vision-render-mode').selectOption('economy');await page.reload();await page.waitForFunction(()=>document.querySelector('#boot-screen').hidden,{},{timeout:60000});assert.equal(await page.locator('#vision-render-mode').inputValue(),'economy');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('#vision-render-mode').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/vision-runtime-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Vision runtime passed: repository weights, sonar activation and mapped echoes, headless live sensor capture and refresh, varied seeded target counts/scene replay, safe near-flag completion and subsequent Start, low-CPU training/cancel, preference persistence and mobile layout.');
}finally{await browser.close();}
