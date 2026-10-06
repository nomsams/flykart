import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const nav=key=>page.locator(`.wb-navigation [data-tool="${key}"]`).click();
const json=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const load=async lab=>{await page.locator('#lab-file').setInputFiles({name:'support-lab.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(lab))});await page.locator('#status').filter({hasText:'Imported habitat'}).waitFor();};
try{
  await page.goto(base+'/robot.html');await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});
  const original=await json('save-lab'),brain=original.controller.network;
  const pod={id:'food-pod',kind:'pod',x:0,z:0,yaw:0,width:.12,depth:.22,height:.18};
  const lab=structuredClone(original);lab.objects=[pod];lab.startPose={x:-1,z:0,heading:0};lab.mode='fly';lab.internalEnergy=1;lab.learning.lifecycle.settings.mode='off';lab.learning.lifecycle.settings.hunger={enabled:true,initial:1,idleDrain:.001,motionDrain:.015,chargeRate:.15,dockRadius:.06,dockHold:1,sated:.85};
  await load(lab);await nav('tasks');await page.locator('.target-hunger summary').click();await page.locator('#support-feeding').check();await page.locator('#support-recovery').check();await page.locator('#support-apply').click();
  assert.deepEqual((await json('save-lab')).controller.network,brain,'Live support must keep neural weights');
  await page.locator('#hunger-low').click();assert.match(await page.locator('#hunger-state').textContent(),/12\.0%/);assert.match(await page.locator('#feeding-state').textContent(),/feeding seek/);
  await page.locator('#step-size').selectOption('150');const history=[];
  for(let i=0;i<12;i++){await page.locator('#step').click();history.push({energy:await page.locator('#hunger-state').textContent(),support:await page.locator('#feeding-state').textContent()});}
  await nav('logs');const logs=await json('export-log');await nav('tasks');const after=await json('save-lab');
  await mkdir('.cache',{recursive:true});await writeFile('.cache/support-feeding-evidence.json',JSON.stringify({history,events:logs.events,after},null,2));
  assert.ok(history.some(h=>h.energy.includes('charging / eating')),'Must actually stop, dwell and charge at the pod');
  assert.ok(history.some(h=>h.energy.includes('1 satiation cycles')),'Must satiate through real simulated contact');
  assert.ok(history.some(h=>h.support.includes('feeding roam')),'Must release to roam after charging');
  assert.ok(after.internalEnergy>.6);assert.deepEqual(after.controller.network,brain);assert.equal(after.learning.lifecycle.settings.support.feeding,true);
  await load(after);assert.equal(await page.locator('#support-feeding').isChecked(),true);assert.equal(await page.locator('#support-low').inputValue(),'0.25');
  // Corner recovery is a demonstration teacher. The test keeps a real target in
  // view, and verifies actual movement rather than just a selected UI preset.
  const corner=structuredClone(original);corner.mode='coach';corner.sketch=after.sketch;corner.program=after.program;corner.config.vibration={...corner.config.vibration,enabled:true};corner.startPose={x:0,z:0,heading:0};corner.learning.lifecycle.settings.mode='approach';corner.learning.lifecycle.settings.recoveryPractice=true;corner.objects=[{id:'front',kind:'wall',x:.22,z:0,yaw:0,width:.06,depth:.8,height:.4},{id:'side',kind:'wall',x:0,z:.3,yaw:0,width:.8,depth:.06,height:.4},{id:'task-blue-ball',kind:'ball',x:1,z:0,yaw:0,width:.06,depth:.06,height:.06}];
  await load(corner);await page.locator('#step-size').selectOption('150');for(let i=0;i<3;i++)await page.locator('#step').click();const moved=await json('save-lab');await nav('logs');const cornerLogs=await json('export-log');await writeFile('.cache/support-corner-evidence.json',JSON.stringify({moved,logs:cornerLogs},null,2));await nav('tasks');assert.ok(Math.hypot(moved.currentPose.x,moved.currentPose.z)>.15,'Coach should move out of its starting corner');await nav('logs');const recovery=await json('export-log');assert.ok(recovery.events.some(e=>e.kind==='brain'&&e.data.support==='recovery coach'&&e.data.action.reverse>0));await nav('tasks');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.target-lab').screenshot({path:'.cache/robot-support-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Support passed: preserved weights, low-charge trigger, real stop/dwell/charging/satiation, release-to-roam, portable support settings, rendered-camera corner recovery, copyable structured logs and mobile layout. No physical hardware used.');
}finally{await browser.close();}
