import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const widened=n=>n.inputCount===19?n:{...n,inputCount:19,inputWeights:Array.from({length:n.hiddenCount},(_,i)=>[...n.inputWeights.slice(i*17,(i+1)*17),0,0]).flat()};
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const upload=async(id,object)=>page.locator('#'+id).setInputFiles({name:'parking-fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(object))});
const ready=()=>page.locator('#status').filter({hasText:'Ready ·'}).waitFor({timeout:90000});
const shelf=()=>page.locator('.browser-brain-shelf');
const openShelf=async()=>{if(!await shelf().evaluate(e=>e.open))await shelf().locator('summary').first().click();};
try{
  await page.goto(base+'/parking.html');await ready();
  assert.equal(await page.locator('#memory-size').inputValue(),'4096');assert.equal(await page.locator('#cue').inputValue(),'visual');
  const pixelStats=await page.evaluate(()=>Array.from(document.querySelector('#camera').getContext('2d').getImageData(0,0,480,240).data).filter((_,i)=>i%4!==3));assert.ok(Math.max(...pixelStats.slice(0,5000))>Math.min(...pixelStats.slice(0,5000)));
  const first=await page.evaluate(()=>window.flykartParking.scene);
  for(let i=0;i<4;i++)await page.locator('#new-lot').click();const fresh=await page.evaluate(()=>window.flykartParking.scene);assert.notEqual(fresh.seed,first.seed);
  await page.locator('#lesson').selectOption('exit');await page.locator('#drive').selectOption('manual');await page.locator('#remember').check();
  const start=await page.evaluate(()=>({...window.flykartParking.session.episode.physics.pose}));
  await page.getByText('Teach from your own driving',{exact:true}).click();await page.locator('#record-coach').check();await page.locator('#step').focus();await page.keyboard.down('s');await page.locator('#step').click();await page.locator('#step').click();await page.keyboard.up('s');
  const moved=await page.evaluate(()=>({...window.flykartParking.session.episode.physics.pose}));assert.ok(moved.z-start.z>.1,'Manual reverse actually leaves the bay');assert.match(await page.locator('#coach-info').textContent(),/60 manual examples/);
  assert.ok(await page.evaluate(()=>window.flykartParking.session.scan.samples.length>20));
  const saved=await download('save-state');assert.equal(saved.settings.remember,true);assert.equal(saved.brain.robotLearning.memorySettings.count,4096);
  await page.locator('#new-lot').click();await upload('import-state',saved);await page.locator('#status').filter({hasText:'restored'}).waitFor();
  const restored=await download('save-state');assert.deepEqual(restored.scene,saved.scene);assert.deepEqual(restored.brain.worldMemory,saved.brain.worldMemory);assert.deepEqual(restored.scan,saved.scan);assert.equal(await page.evaluate(()=>window.flykartParking.session.driver.options.learnMemory),true,'Guided memory learning resumes after the exact restore preview');
  const invalid=structuredClone(saved);invalid.scene.start={...invalid.scene.actors[0].pose};await upload('import-state',invalid);await page.locator('#import-state-dialog .json-import-error').filter({hasText:'inside'}).waitFor();assert.deepEqual((await page.evaluate(()=>window.flykartParking.scene)),saved.scene);await page.locator('#import-state-dialog [data-close]').first().click();
  // Repeated import remains visible. Paste is the same parser as the file path.
  const visual=JSON.parse(await readFile('assets/flykart-visual.json','utf8'));
  await page.locator('#brain-upload').click();await page.locator('#import-brain-paste').fill(JSON.stringify(visual));await page.locator('#import-brain-dialog button[type=submit]').click();await page.locator('#status').filter({hasText:'Imported world'}).waitFor();
  assert.deepEqual((await download('export-brain')).controller.network,widened(visual.controller.network));
  assert.equal(await page.locator('#brain-upload').isVisible(),true);
  const racer=JSON.parse(await readFile('assets/flykart-brain-racer.json','utf8')),before=await download('export-brain');
  await upload('import-brain',racer);await page.locator('#status').filter({hasText:'Racer parent kept exactly'}).waitFor();assert.deepEqual((await download('export-brain')).controller.network,before.controller.network);
  await page.locator('#adapt-racer').click();assert.equal((await download('export-brain')).controller.domain,'world');
  await upload('import-brain',visual);await page.locator('#status').filter({hasText:'Imported world'}).waitFor();
  await page.locator('#swarm').selectOption('circle9');assert.equal(await page.evaluate(()=>window.flykartParking.session.driver.ensemble.frames.length),9);assert.equal(await page.evaluate(()=>{const f=window.flykartParking.session.driver.ensemble.frames;return f[0].some((v,i)=>v!==f[1][i]);}),true);
  await page.locator('#swarm').selectOption('single');await page.locator('#lesson').selectOption('traffic');await page.locator('#cars').check();await page.locator('#jitter').check();
  const traffic=await download('save-state');assert.ok(traffic.scene.actors.some(a=>a.kind==='pedestrian'));const scene3d=await download('export-3d');
  // A small real sensor-only evolution verifies fresh worlds, control locking, reports and cancellation.
  await page.locator('#lesson').selectOption('arrival');await page.locator('#seconds').fill('2');await page.locator('#seconds').dispatchEvent('change');await page.locator('#memory-size').selectOption('512');await page.locator('#generations').fill('2');await page.locator('#population').fill('2');
  for(const input of await page.locator('#curriculum input').all())await input.uncheck();await page.locator('#curriculum input[value=arrival]').check();await page.locator('#curriculum input[value=exit]').check();await page.locator('#preview').selectOption('headless');
  let parent=(await download('export-brain')).controller.network;await page.locator('#evolve').click();assert.equal(await page.locator('#lesson').isDisabled(),true);await page.locator('#export-report').waitFor({state:'visible'});await page.waitForFunction(()=>!window.flykartParking.busy,{},{timeout:180000});
  const report=await download('export-report');assert.equal(report.generations,2);assert.equal(report.population,2);const seeds=[...report.trials.flatMap(t=>t.scenarios.map(s=>s.seed)),...report.validation.scenarios.map(s=>s.seed)];assert.equal(new Set(seeds).size,seeds.length);assert.deepEqual((await download('export-brain')).controller.network,parent);
  assert.equal(await page.locator('#adopt').isDisabled(),!report.validation.passed);assert.equal(await page.locator('#training-progress').evaluate(e=>e.style.width),'100%');
  if(report.validation.passed){await page.locator('#adopt').click();assert.equal(await page.locator('#adopt').isDisabled(),true);const adopted=await download('export-brain');assert.deepEqual(adopted.controller.network,report.brain);assert.deepEqual(adopted.controller.provenance[0].heldOut,report.validation);parent=adopted.controller.network;}
  await page.locator('#swarm').selectOption('circle3');assert.equal(await page.locator('#adopt').isDisabled(),true);assert.equal(await page.locator('#export-report').isDisabled(),true);assert.equal(await page.evaluate(()=>window.flykartParking.report),null);await page.locator('#swarm').selectOption('single');
  await page.locator('#evolve').click();await page.locator('#cancel').click();await page.waitForFunction(()=>!window.flykartParking.busy);assert.deepEqual((await download('export-brain')).controller.network,parent);assert.equal(await page.locator('#lesson').isDisabled(),false);
  // Low-CPU/headless drawing never skips physics or camera inference.
  await page.locator('#reset').click();await page.locator('#drive').selectOption('manual');await page.locator('#step').focus();await page.keyboard.down('w');await page.locator('#step').click();await page.keyboard.up('w');assert.equal(await page.evaluate(()=>window.flykartParking.session.episode.tick),30);assert.ok(await page.evaluate(()=>window.flykartParking.session.driver.ensemble.frames[0].length>0));await page.locator('#refresh').click();
  await openShelf();await shelf().locator('[data-brain-save]').click();await shelf().locator('[role=status]').filter({hasText:'Saved parking'}).waitFor();const parkingBrain=await download('export-brain');
  // Ensure generated parking exports are accepted by the actual 3D importer and shelf.
  await page.goto(base+'/robot.html?tools=all');await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:90000});
  await page.locator('#scene-file').setInputFiles({name:'parking-3d.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(scene3d))});await page.locator('#status').filter({hasText:'Room, poses, target points and trail loaded'}).waitFor();const actual3d=await download('save-scene');assert.deepEqual(actual3d.objects,scene3d.objects);
  await openShelf();await shelf().getByLabel('Browser brain source').selectOption('parking');await shelf().locator('[data-brain-load]').click();await shelf().locator('[role=status]').filter({hasText:'Loaded parking'}).waitFor();assert.deepEqual((await download('export-brain')).network,parkingBrain.controller.network);
  await page.goto(base+'/vision.html#world');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:90000});await openShelf();await shelf().getByLabel('Browser brain source').selectOption('parking');await shelf().locator('[data-brain-load]').click();await shelf().locator('[role=status]').filter({hasText:'Loaded parking'}).waitFor();assert.deepEqual((await download('brain-export-always')).controller.network,parkingBrain.controller.network);
  await page.goto(base+'/parking.html');await ready();await page.locator('#preview').selectOption('full');await page.locator('#lesson').selectOption('traffic');
  await mkdir('.cache',{recursive:true});assert.ok(await page.locator('.monitors').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight+1),'All three monitors fit at desktop viewport');await page.screenshot({path:'.cache/parking-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.locator('#brain-upload').isVisible(),true);await page.locator('#drive').selectOption('manual');assert.equal(await page.locator('[data-drive=w]').isVisible(),true);await page.screenshot({path:'.cache/parking-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('Parking UI passed: reverse physics, real camera/crops/sonar, replay state, invalid import isolation, repeated file/paste imports, exact visual parent, explicit racer adaptation, fresh independent evolution and cancellation, headless inference, Parking browser checkpoint → 3D + Vision, static scene transfer and mobile layout. No physical hardware used.');
}catch(e){console.log('Parking errors:',errors);console.log(await page.locator('#status,#training-status,#brain-file-status,.browser-brain-shelf [role=status],.json-import-error').allTextContents());throw e;}finally{await browser.close();}
