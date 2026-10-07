import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const mapPose=()=>page.locator('#room-map').evaluate(c=>JSON.parse(c.dataset.pose));
try{
  await page.goto(base+'/robot.html?tools=all');await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});
  assert.equal(await page.locator('#map-pose-source').inputValue(),'simulated');
  assert.ok(await page.locator('#world-brain-loader').evaluate(e=>{const r=e.getBoundingClientRect(),stage=document.querySelector('.stage').getBoundingClientRect();return r.top>=stage.bottom&&r.top<stage.bottom+40;}));
  assert.equal(await page.locator('#world-import-brain').isVisible(),true);
  // One click applies the sensor + free pin + code, without pretending hardware pad access was confirmed.
  const before=await download('save-lab');await page.locator('#vibration-connect').click();
  const connected=await download('save-lab');assert.equal(connected.config.vibration.enabled,true);assert.equal(connected.config.vibration.gpio33Access,false);
  assert.deepEqual(connected.wiring,{...before.wiring,vibration:33});assert.match(await page.locator('#sketch').inputValue(),/const int VIBRATION = 33;/);
  assert.match(await page.locator('#vibration-connect-note').innerText(),/Physical build.*GPIO33/);
  await page.locator('#vibration-shake').click();assert.match(await page.locator('#vibration-status').innerText(),/Vibration event held/);
  await page.locator('#vibration-connect').click();assert.equal((await download('save-lab')).config.vibration.enabled,false);
  // Drive the actual physics against a solid wall, then keep applying motor commands.
  const room={format:'flykart-robot-scene',version:1,mission:before.mission,floorColour:'#b7bea7',startPose:{x:0,z:0,heading:0},currentPose:{x:0,z:0,heading:0},objects:[{id:'contact-test-wall',kind:'wall',x:.6,z:0,yaw:Math.PI/2,width:1.6,depth:.09,height:.7}]};
  await page.locator('#scene-file').setInputFiles({name:'solid-wall.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(room))});
  await page.locator('#status').filter({hasText:'Room, poses, target points and trail loaded'}).waitFor();
  await page.locator('#default-code').click();
  const sketch=(await page.locator('#sketch').inputValue()).replace('float left = brainLeft();','float left = 180;').replace('float right = brainRight();','float right = 180;');
  assert.ok(sketch.includes('float left = 180;'));await page.locator('#sketch').fill(sketch);await page.locator('#apply-code').click();await page.locator('#drive-mode').selectOption('sketch');
  await page.locator('#step-size').selectOption('150');await page.locator('#step').click();
  await page.locator('#motion-state').filter({hasText:'wall body · motion blocked'}).waitFor();
  const stopped=(await download('save-scene')).currentPose;assert.deepEqual(await mapPose(),stopped);
  await page.locator('#step').click();const still=(await download('save-scene')).currentPose;
  assert.deepEqual(still,stopped);assert.deepEqual(await mapPose(),still,'Sonar marker must stay still at contact');
  assert.ok(still.x<.6-.045-.13+.008);
  await page.locator('.map-card .monitor-help summary').click();
  await page.locator('#map-pose-source').selectOption('estimated');assert.ok(Math.abs((await mapPose()).x-still.x)>.5,'Command drift stays available, explicitly labelled');
  assert.match(await page.locator('#map-pose-note').textContent(),/can drift/);
  const estimateLab=await download('save-lab');assert.equal(estimateLab.memory.mapPoseSource,'estimated');
  await page.locator('#map-pose-source').selectOption('simulated');assert.deepEqual(await mapPose(),still);
  // Older maps used unlabeled command odometry. Migrate the display only, keeping learned cells.
  await page.locator('#memory-enabled').uncheck();
  delete estimateLab.memory.mapPoseSource;estimateLab.memory.map=[['5,0',3]];
  await page.locator('#lab-file').setInputFiles({name:'legacy-map.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(estimateLab))});
  await page.locator('#status').filter({hasText:'Imported habitat, components, sketch, brain and learned memory'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#room-map').dataset.poseSource==='simulated');
  const migrated=await download('save-lab');assert.deepEqual(migrated.memory.map,[]);assert.deepEqual(migrated.memory.counts,estimateLab.memory.counts);assert.deepEqual(migrated.memory.prototypes,estimateLab.memory.prototypes);
  // Brain file/paste fallback and selectable repository checkpoint stay beside the view after imports.
  await page.locator('#world-import-brain').click();await page.locator('#brain-file-dialog').waitFor({state:'visible'});
  await page.locator('#brain-file-dialog [data-close]').first().click();
  await page.locator('.browser-brain-shelf>summary').click();
  await page.locator('#repository-brain-select').selectOption('visual');await page.locator('#load-racer-checkpoint').click();
  await page.locator('.browser-brain-shelf [role=status]').filter({hasText:'assets/flykart-visual.json'}).waitFor({timeout:60000});
  const source=JSON.parse(await readFile('assets/flykart-visual.json','utf8'));assert.deepEqual((await download('export-brain')).network,source.controller.network);
  assert.equal(await page.locator('#world-import-brain').isVisible(),true);
  await page.locator('.browser-brain-shelf>summary').click();
  await page.locator('.map-card .monitor-help').evaluate(e=>e.open=false);
  await mkdir('.cache',{recursive:true});await page.evaluate(()=>scrollTo(0,0));assert.ok((await page.locator('#room-map').boundingBox()).height>=50);await page.screenshot({path:'.cache/robot-contact-map-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:'.cache/robot-contact-map-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Contact map UI passed: blocked pose stays still across sustained PWM, labelled command drift and map reference export, one-click SW-420/pin/sketch connection without hardware assumptions, quick repeated brain import/repository loading and mobile layout.');
}finally{await browser.close();}
