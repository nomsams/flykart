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
  await page.goto(base+'/vision.html');await page.waitForFunction(()=>document.querySelector('#boot-screen').hidden,{},{timeout:60000}).catch(async e=>{console.error('Vision boot diagnostics:',errors,await page.locator('#boot-screen').innerText());throw e;});
  await page.locator('#brain-load-project').click();await page.waitForFunction(()=>window.flykartVision.imported?.name==='flykart-brain-racer');
  assert.match(await page.locator('#brain-file-status').innerText(),/assets\/flykart-brain-racer.json/);
  const source=JSON.parse(await readFile('assets/flykart-brain-racer.json','utf8'));
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.imported.snapshot),source.network);
  await page.locator('#tab-btn-world').click();await page.locator('#world-scan-status').filter({hasText:'Diagnostic HC-SR04'}).waitFor();
  await page.locator('#brain-project-choice').selectOption('visual');await page.locator('#brain-load-project').click();
  await page.waitForFunction(()=>window.flykartVision.world?.settings.task==='explore'&&window.flykartVision.profile==='kart');
  const visual=JSON.parse(await readFile('assets/flykart-visual.json','utf8'));
  assert.equal(await page.locator('#profile').inputValue(),'kart');
  assert.deepEqual(await page.evaluate(()=>window.flykartVision.world.controller.toJSON()),visual.controller.network);
  assert.equal(await page.locator('#world-sonar-map').evaluate(c=>c.closest('.view-box')?.contains(document.getElementById('world-eye'))),true);
  assert.equal(await page.locator('#world-train-adopt').evaluate(b=>b.closest('.brain-file-bar')?.contains(document.getElementById('brain-import-always'))),true);
  assert.equal(await page.locator('#world-virtual-eyes').evaluate(g=>Boolean(g.closest('#world-eye-settings'))),true);
  await page.locator('#world-task').selectOption('forage');
  await page.locator('#world-driver').selectOption('expert');
  const arena={format:'flykart-world',version:1,world:{seed:7,half:150,obstacles:[{x:80,y:0,radius:12,height:30,tone:.5,kind:'rock'}],patches:[]},start:{x:0,y:0,heading:0},goals:[{x:-80,y:30}],exercise:{task:'forage',searchWin:'reach',goalPreset:'near'}};
  await scene(arena);await page.waitForFunction(()=>window.flykartVision.world.sonarMap.cells.size>0);
  assert.match(await page.locator('#world-scan-status').innerText(),/Diagnostic HC-SR04.*echoes/);
  assert.equal(await page.evaluate(()=>window.flykartVision.world.episode.sonar()),null);
  assert.equal(await page.evaluate(()=>window.flykartVision.world.episode.proprioception().sonarCloseness),undefined);
  await page.locator('#world-scan-settings>summary').click();
  const diagnosticMap=await download('world-scan-export');assert.ok(diagnosticMap.cells.some(([,v])=>v<0));assert.ok(diagnosticMap.cells.some(([,v])=>v>0));
  const colours=await page.locator('#world-sonar-map').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let green=0,yellow=0;for(let i=0;i<data.length;i+=4){if(data[i+1]>data[i]*1.2&&data[i+1]>data[i+2]*1.2)green++;if(data[i]>100&&data[i+1]>70&&data[i+2]<data[i+1]*.75)yellow++;}return{green,yellow};});
  assert.ok(colours.green>5&&colours.yellow>5,'Scanned approaches and echoes must produce coloured pixels');
  await page.locator('#world-scan-enable').click();assert.equal(await page.locator('#profile').inputValue(),'robot');
  assert.equal(await page.evaluate(()=>window.flykartVision.world.episode.scanSonarUnit===window.flykartVision.world.episode.sonarUnit),true);
  await page.locator('#world-driver').selectOption('expert');await scene(arena);
  // Approach, contact and retreat using the real episode/sonar/map pipeline.
  await page.locator('#world-driver').selectOption('vision');
  await scene({...arena,start:{x:118,y:0,heading:0},world:{...arena.world,obstacles:[]}});
  await page.evaluate(()=>{const s=window.flykartVision.world;s.controller.step=()=>({steer:0,throttle:1,brake:0,reverse:0});});
  await page.locator('#world-speed').selectOption('4');await page.locator('#world-run').click();
  await page.waitForFunction(()=>window.flykartVision.world.episode.tick>=65);await page.locator('#world-run').click();
  const contact=await page.evaluate(()=>{const s=window.flykartVision.world,e=s.episode,k=e.sim.kart;return{x:k.x,origin:k.x+e.sonarUnit.spec.mountForward,face:e.sim.world.half-1.5,collisions:e.sim.status.collisions,echo:e.sonar().echo,cells:[...s.sonarMap.cells]};});
  assert.ok(contact.collisions>0);assert.ok(contact.origin<contact.face,'Transducer must remain on the room side of the wall');assert.equal(contact.echo,false,'Contact lies inside the 2 cm blind zone');
  assert.ok(contact.cells.some(([,v])=>v>0),'Earlier echo evidence must remain');assert.ok(!contact.cells.some(([key,v])=>v<0&&Number(key.split(',')[0])*8>=contact.face),'No free space may be carved beyond the wall');
  await page.evaluate(()=>{window.flykartVision.world.controller.step=()=>({steer:0,throttle:0,brake:0,reverse:1});});
  const retreatTick=await page.evaluate(()=>window.flykartVision.world.episode.tick);await page.locator('#world-run').click();
  await page.waitForFunction(t=>window.flykartVision.world.episode.tick>=t+45,retreatTick);await page.locator('#world-run').click();
  assert.ok(await page.evaluate(x=>window.flykartVision.world.episode.sim.kart.x<x,contact.x));assert.equal(await page.evaluate(()=>window.flykartVision.world.episode.sonar().echo),true);
  await page.locator('#world-driver').selectOption('expert');await scene(arena);
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
  await page.locator('#vision-render-mode').selectOption('economy');await page.reload();await page.waitForFunction(()=>document.querySelector('#boot-screen').hidden,{},{timeout:60000}).catch(async e=>{console.error('Vision boot diagnostics:',errors,await page.locator('#boot-screen').innerText());throw e;});assert.equal(await page.locator('#vision-render-mode').inputValue(),'economy');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('#vision-render-mode').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/vision-runtime-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Vision runtime passed: repository weights, sonar activation and mapped echoes, headless live sensor capture and refresh, varied seeded target counts/scene replay, safe near-flag completion and subsequent Start, low-CPU training/cancel, preference persistence and mobile layout.');
}finally{await browser.close();}
