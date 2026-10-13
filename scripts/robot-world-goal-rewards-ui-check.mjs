import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultNavigationTimeout(180000);page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
try{
  await page.goto(base+'/vision.html#world');await page.waitForFunction(()=>window.flykartVision?.world,{},{timeout:180000});
  await page.locator('#profile').selectOption('robot');await page.locator('#world-map-preset').selectOption('clear');await page.locator('#world-memory-on').evaluate(e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=true;});await page.locator('#world-memory-on').uncheck();await page.locator('#world-task').selectOption('explore');await page.locator('#world-repeat-search').uncheck();
  assert.equal(await page.locator('#world-goal-count').isDisabled(),true);
  await page.locator('#world-goal-reward-options').evaluate(e=>e.open=true);
  await page.locator('#world-adaptive-time').check();assert.equal(await page.locator('#world-goal-count').isDisabled(),false);await page.locator('#world-goal-count').selectOption('3');await page.locator('#world-nose-first').check();
  const initial=await page.evaluate(()=>{const s=window.flykartVision.world;s.step();return{limit:s.episode.sim.goalLimit,count:s.episode.sim.goals.length,cues:s.driver.sensors.slice(0,2),deadline:s.episode.sim.deadlineTicks,mission:s.driver.options.missionCue};});
  assert.equal(initial.limit,3);assert.equal(initial.count,1);assert.deepEqual(initial.cues,[0,0]);assert.equal(initial.mission,false);
  const targets=[];
  for(let goal=1;goal<=3;goal++){
    const r=await page.evaluate(()=>{
      const s=window.flykartVision.world,sim=s.episode.sim,k=sim.kart,g={...sim.goals[0]},before=sim.status.goals;
      // Deterministic positioning verifies actual RGB confirmation and episode plumbing,
      // not this checkpoint's navigation quality.
      s.controller.step=()=>({steer:0,throttle:0,brake:0,reverse:0});s.episode.mission=()=>{throw Error('Visual search accessed the compass');};
      s.searchJudge.settings.enabled=false;s.searchJudge.settings.zeroChill=false;
      k.x=g.x-80;k.y=g.y;k.heading=0;k.speed=0;
      for(let i=0;i<12&&!s.done&&sim.status.goals===before;i++)s.step();
      return{g,goals:sim.status.goals,done:s.done,won:s.won,earned:sim.status.timeBonusTicks,deadline:sim.deadlineTicks,nose:sim.status.noseReward,cue:s.discovery.cue(),next:sim.goals[0]??null};
    });
    assert.equal(r.goals,goal);assert.equal(r.done,goal===3);assert.equal(r.won,goal===3);assert.equal(r.earned,goal===1?300:750);assert.equal(r.nose,0);targets.push(r.g);
    if(goal<3){assert.deepEqual(r.cue,[0,0]);assert.notDeepEqual(r.next,r.g);}
  }
  assert.equal(new Set(targets.map(g=>`${g.x},${g.y}`)).size,3);
  const saved=await download('brain-export-always'),scene=await download('world-map-export');assert.equal(saved.worldSetup.goalRewards.adaptiveTime,true);assert.equal(saved.worldTraining.goalRewards.adaptiveTime,true);assert.equal(scene.exercise.goalRewards.adaptiveTime,true);assert.equal(saved.worldSetup.goalCount,3);
  await page.locator('#world-adaptive-time').uncheck();await page.locator('#world-nose-first').uncheck();
  await page.locator('#brain-import-always').click();await page.locator('#import-file').setInputFiles({name:'adaptive-world.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});await page.waitForFunction(()=>document.querySelector('#import-file').value==='');
  assert.equal(await page.locator('#world-adaptive-time').isChecked(),true);assert.equal(await page.locator('#world-nose-first').isChecked(),true);assert.equal(await page.locator('#world-goal-count').inputValue(),'3');
  const again=await download('brain-export-always');assert.deepEqual(again.controller.network,saved.controller.network);assert.deepEqual(again.worldTraining.goalRewards,saved.worldTraining.goalRewards);
  await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/world-goal-rewards-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#world-goal-reward-options').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/world-goal-rewards-mobile.png'});assert.deepEqual(errors,[]);
  console.log('World goal rewards passed: actual RGB-only three-flag sequence, growing finite time extensions, no sighting orientation bonus, unseen cues zero, exact brain/scene metadata round-trip and mobile layout. No navigation-quality claim.');
}finally{await browser.close();}
