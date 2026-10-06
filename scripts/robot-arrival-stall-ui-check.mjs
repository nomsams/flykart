import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const [file]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await file.path(),'utf8'));};
try{
  await page.goto(base+'/vision.html');await page.waitForFunction(()=>document.querySelector('#boot-screen').hidden,{},{timeout:60000});await page.locator('#tab-btn-world').click();await page.locator('#world-task').selectOption('explore');
  assert.equal(await page.locator('#world-require-arrival').isChecked(),false);await page.locator('#world-require-arrival').check();assert.equal(await page.locator('#world-search-win').inputValue(),'reach');await page.locator('#world-goal-radius').fill('11');await page.locator('#world-goal-radius').dispatchEvent('change');
  const scene={format:'flykart-world',version:1,world:{seed:7,half:460,obstacles:[],patches:[]},start:{x:0,y:0,heading:0},goals:[{x:100,y:0}],exercise:{task:'explore',searchWin:'reach',goalPreset:'near',goalRadius:10}};
  await page.locator('#world-map-file').setInputFiles({name:'arrival.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(scene))});await page.waitForFunction(()=>window.flykartVision.world.episode.sim.goalRadius===10);
  const visible=await page.evaluate(()=>{const s=window.flykartVision.world;s.controller.step=()=>({steer:0,throttle:0,brake:0,reverse:0});for(let i=0;i<8&&!s.done;i++)s.step();return{found:s.found,won:s.won,done:s.done,goals:s.episode.sim.status.goals};});
  assert.equal(visible.found,true,'Actual rendered pink pixels must confirm the sighting');assert.equal(visible.won,false);assert.equal(visible.done,false);assert.equal(visible.goals,0);
  const arrived=await page.evaluate(()=>{const s=window.flykartVision.world;s.episode.sim.kart.x=92;s.step();return{won:s.won,goals:s.episode.sim.status.goals,radius:s.episode.sim.goalRadius};});assert.equal(arrived.won,true);assert.equal(arrived.goals,1);
  const saved=await download('world-map-export');assert.equal(saved.exercise.goalRadius,10);assert.equal(saved.exercise.searchWin,'reach');
  await page.locator('#world-require-arrival').uncheck();assert.equal(await page.locator('#world-search-win').inputValue(),'sight');await page.locator('#world-search-win').selectOption('reach');assert.equal(await page.locator('#world-require-arrival').isChecked(),true);
  await page.locator('#tab-btn-track').click();await page.locator('summary').filter({hasText:'Visual stall detection'}).click();assert.equal(await page.locator('#stall-enabled').isChecked(),false);
  await page.locator('#stall-enabled').check();await page.locator('#stall-delay').fill('.5');await page.locator('#stall-delay').dispatchEvent('change');await page.locator('#stall-doubling').fill('.5');await page.locator('#stall-doubling').dispatchEvent('change');
  await page.locator('#tab-btn-world').click();await page.locator('#world-task').selectOption('forage');await page.locator('#world-map-preset').selectOption('clear');await page.locator('#world-goal-preset').selectOption('far');await page.locator('#world-goal-count').selectOption('1');
  // Inject repeatable camera telemetry and known sent motor commands, not
  // simulator contact/pose labels. The observer must drive real scoring.
  const stall=await page.evaluate(()=>{const s=window.flykartVision.world,n=48*24,f=new Float32Array(n*3);for(let c=0;c<3;c++)for(let y=0;y<24;y++)for(let x=0;x<48;x++)f[c*n+y*48+x]=(Math.floor(x/6)+Math.floor(y/6))%2?.8:.2;s.episode.render=()=>f;s.controller.step=()=>({steer:0,throttle:1,brake:0,reverse:0});for(let i=0;i<75&&!s.done;i++)s.step();return{bit:s.driver.stall.bit,pain:s.stallPain,rate:s.driver.stall.rate,seconds:s.driver.stall.seconds,inputs:s.driver.sensors.length,radius:s.episode.sim.goalRadius};});
  assert.equal(stall.bit,1);assert.ok(stall.pain>0);assert.ok(stall.rate>.08);assert.equal(stall.inputs,17);assert.equal(stall.radius,10);
  await page.locator('#vision-refresh').click();await page.locator('#world-stall-status').filter({hasText:'Stall bit 1'}).waitFor();
  await page.locator('#world-run').click();await page.waitForFunction(()=>document.querySelector('#world-sensor-log').value.includes('STALL bit=1'));await page.locator('#world-run').click();
  const brain=await download('brain-export-always');assert.equal(brain.experiment.stall.enabled,true);assert.equal(brain.experiment.stall.delaySeconds,.5);assert.equal(brain.worldSetup.goalRadius,10);
  const released=await page.evaluate(()=>{const s=window.flykartVision.world;s.controller.step=()=>({steer:0,throttle:0,brake:0,reverse:0});for(let i=0;i<6;i++)s.step();return s.driver.stall.bit;});assert.equal(released,0);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  console.log('Arrival/stall passed: real pixel sighting cannot win reach mode outside the ring, actual radius arrival, checkbox/select and scene persistence, optional camera/command stall bit, increasing external pain, unchanged input layout, logs and portable settings, stop release and mobile controls. No physical hardware used.');
}finally{await browser.close();}
