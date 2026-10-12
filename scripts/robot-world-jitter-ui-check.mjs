import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.setDefaultNavigationTimeout(90000);page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async()=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#brain-export-always').click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
try{
  await page.goto(base+'/vision.html#world');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:90000});
  assert.equal(await page.locator('#world-anti-jitter').isChecked(),true);assert.equal(await page.locator('#world-jitter-window').inputValue(),'4');assert.equal(await page.locator('#world-jitter-weight').inputValue(),'2');
  await page.locator('#world-task').selectOption('explore');await page.locator('#world-search-win').selectOption('reach');await page.locator('#world-map-preset').selectOption('clear');
  const parent=(await download()).controller.network;
  const result=await page.evaluate(async()=>{
    const {WorldSession}=await import('/src/vision/ui/sessions.ts'),{goalResult,discoveryScore}=await import('/src/vision/world/training.ts');
    const base=window.flykartVision.world.settings;const common={...base,world:{seed:1,half:460,obstacles:[],patches:[]},start:{x:16,y:0,heading:0},goals:[{x:-300,y:0}],searchJudge:{...base.searchJudge,delaySeconds:20,cutoffSeconds:30,loopGuard:false,blindReverse:false}};
    const make=(antiJitter,zeroChill=false)=>{const s=new WorldSession({...common,searchJudge:{...common.searchJudge,antiJitter,zeroChill}}),act=s.driver.act.bind(s.driver),step=s.episode.step.bind(s.episode);let t=0,x=16;s.driver.act=e=>{const frame=act(e),sign=Math.floor(t/10)%2?-1:1;return {...frame,action:{steer:0,throttle:sign>0?1:0,reverse:sign<0?1:0,brake:0}};};s.episode.step=a=>{step(a);x+=(Math.floor(t++/10)%2?-1:1)*.15;s.episode.sim.kart.x=x;s.episode.sim.kart.y=0;s.episode.sim.kart.heading=0;};return s;};
    const on=make(true),off=make(false),strict=make(false,true);let same=true;for(let i=0;i<240;i++){on.step();off.step();strict.step();same&&=JSON.stringify(on.driver.sensors)===JSON.stringify(off.driver.sensors)&&JSON.stringify(on.lastAction)===JSON.stringify(off.lastAction);}
    const a=goalResult(on,316),b=goalResult(off,316);window.flykartVision.world=on;document.querySelector('#vision-refresh').click();
    return {same,frames:JSON.stringify([...on.episode.frame])===JSON.stringify([...off.episode.frame]),impact:on.episode.sim.status.pain===off.episode.sim.status.pain,on:a,off:b,scoreA:discoveryScore(a,300),scoreB:discoveryScore(b,300),strict:goalResult(strict,316)};
  });
  assert.equal(result.same,true);assert.equal(result.frames,true);assert.equal(result.impact,true);assert.ok(result.on.jitterPain>0&&result.on.jitterPenalty>0);assert.equal(result.off.jitterPenalty,0);assert.ok(result.scoreA<result.scoreB);assert.ok(result.strict.disqualified&&result.strict.rejectionReason.includes('jitter'));
  assert.match(await page.locator('#world-progress-status').textContent(),/jitter ACTIVE.*reversals.*travel.*net.*jitter pain/);
  await page.locator('#world-jitter-window').fill('3');await page.locator('#world-jitter-window').dispatchEvent('change');await page.locator('#world-jitter-weight').fill('4');await page.locator('#world-jitter-weight').dispatchEvent('change');
  const exported=await download();assert.equal(exported.worldTraining.searchJudge.jitterWindowSeconds,3);assert.equal(exported.worldTraining.searchJudge.jitterWeight,4);assert.deepEqual(exported.controller.network,parent);
  await page.locator('#brain-import-always').click();await page.locator('#import-file').setInputFiles({name:'motion-guard.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});await page.waitForFunction(()=>document.querySelector('#import-file').value==='');
  assert.equal(await page.locator('#world-jitter-window').inputValue(),'3');assert.equal(await page.locator('#world-jitter-weight').inputValue(),'4');
  await page.locator('#world-anti-jitter').uncheck();assert.equal(await page.evaluate(()=>window.flykartVision.world.searchJudge.settings.antiJitter),false);
  await page.locator('#world-anti-jitter').check();await page.locator('#world-zero-chill').check();
  await mkdir('.cache',{recursive:true});await page.locator('#world-progress-controls').screenshot({path:'.cache/world-jitter-desktop.png'});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#world-progress-controls').screenshot({path:'.cache/world-jitter-mobile.png'});assert.deepEqual(errors,[]);
  console.log('World jitter passed: Parking motion-judge defaults, real episode fitness and pain/negative reward, unchanged RGB/inputs/impact pain, strict rejection, live controls and brain round-trip without weight changes, desktop/mobile layout. Controlled rocking fixture; convergence not claimed.');
}catch(e){console.error(errors,await page.locator('#boot-screen').textContent().catch(()=>''));throw e;}finally{await browser.close();}
