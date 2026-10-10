import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultNavigationTimeout(90000);
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const ready=()=>page.locator('#status').filter({hasText:'Ready ·'}).waitFor({timeout:90000});
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const upload=async object=>{await page.locator('#import-state').setInputFiles({name:'reward-lot.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(object))});await page.locator('#status').filter({hasText:'restored'}).waitFor();};
try{
  await page.goto(base+'/parking.html');await ready();
  assert.equal(await page.locator('#approach-reward').isChecked(),true);assert.equal(await page.locator('#progress-penalty').isChecked(),true);assert.equal(await page.locator('#reverse-reward').isChecked(),false);assert.equal(await page.locator('#path-reward').isChecked(),false);
  const lab=await download('save-state');lab.scene.actors=[];lab.scene.start={x:.8,z:0,heading:0};lab.scene.target={...lab.scene.target,x:0,z:0,heading:0};lab.scene.bays=lab.scene.bays.map(b=>b.id===lab.scene.target.id?{...lab.scene.target}:b);lab.settings={...lab.settings,reverseReward:true,pathReward:true,approachRadius:2,maxTicks:60};
  await upload(lab);await page.locator('#refresh').click();assert.match(await page.locator('#path-coach-info').innerText(),/Route .*Static parked blocks/);
  assert.ok(await page.evaluate(()=>window.flykartParking.session.episode.coachPath.poses.some(p=>p.reverse)));
  assert.ok(await page.evaluate(()=>window.flykartParking.view3d.scene.getObjectByName('coach-reverse')));
  const before=await page.evaluate(()=>({tick:window.flykartParking.session.episode.tick,pixels:Array.from(window.flykartParking.session.episode.frame)}));await page.locator('#show-coach').uncheck();
  assert.equal(await page.evaluate(()=>!!window.flykartParking.view3d.scene.getObjectByName('coach-reverse')),false);
  assert.deepEqual(await page.evaluate(()=>({tick:window.flykartParking.session.episode.tick,pixels:Array.from(window.flykartParking.session.episode.frame)})),before);
  await page.locator('#show-coach').check();await page.evaluate(()=>{const s=window.flykartParking.session;for(let i=0;i<40;i++)s.step({steer:0,throttle:0,reverse:.8,brake:0});});await page.locator('#refresh').click();
  const result=await page.evaluate(()=>window.flykartParking.session.episode.result());assert.ok(result.reverseReward>0);assert.ok(result.approachReward>0);assert.ok(result.pathReward>0);assert.match(await page.locator('#reward-breakdown').innerText(),/reverse .*route .*no-progress penalty/);
  const saved=await download('save-state'),brain=await download('export-brain');assert.equal(saved.settings.pathReward,true);assert.equal(saved.settings.approachRadius,2);assert.equal(brain.controller.provenance.at(-1).settings.reverseReward,true);
  await page.reload();await ready();assert.equal(await page.locator('#reverse-reward').isChecked(),true);assert.equal(await page.locator('#path-reward').isChecked(),true);assert.equal(await page.locator('#approach-radius').inputValue(),'2');
  await upload(saved);await page.locator('#generations').fill('1');await page.locator('#population').fill('2');await page.locator('#training-speed').selectOption('0');await page.locator('#memory-size').selectOption('512');
  for(const box of await page.locator('#curriculum input').all())await box.uncheck();await page.locator('#curriculum input[value=arrival]').check();await page.locator('#evolve').click();await page.waitForFunction(()=>!window.flykartParking.busy&&window.flykartParking.report,{},{timeout:150000});
  const report=await download('export-report');assert.equal(report.settings.pathReward,true);assert.equal(report.settings.reverseReward,true);assert.ok(report.trials.every(t=>t.results.flat().every(r=>['ready','blocked','budget'].includes(r.pathStatus)&&Number.isFinite(r.progressPenalty))));
  await page.locator('#delay-reward').check();await page.locator('#phase').selectOption('sparse');assert.equal(await page.locator('#adopt').isDisabled(),true);await page.locator('#refresh').click();assert.equal(await page.evaluate(()=>window.flykartParking.session.episode.status.reward),0);
  await page.evaluate(()=>window.scrollTo(0,0));await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/parking-reward-desktop.png',fullPage:true});assert.ok(await page.locator('.monitors').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight+1));
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'.cache/parking-reward-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  console.log('Parking reward coach passed: defaults, reverse route/3D overlays, unchanged camera/tick on overlay toggle, actual reverse/progress sugar, state/preferences/brain provenance, ghost training breakdowns, sparse/delay rules and mobile layout. Simulated sensors only.');
}finally{await browser.close();}
