import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
try{
  await page.goto(base+'/parking.html');await page.locator('#status').filter({hasText:'Ready ·'}).waitFor({timeout:90000});
  await page.locator('#pain-and-penalty').check();await page.locator('#slow-driving').check();await page.locator('#slow-mode').selectOption('both');
  const lab=await download('save-state');assert.equal(lab.settings.painAndPenalty,true);assert.equal(lab.settings.slowMode,'both');assert.equal(lab.settings.antiJiggle,true);
  lab.scene.actors=[];lab.scene.start={x:.8,z:0,heading:0};lab.scene.target={...lab.scene.target,x:0,z:0,heading:0};lab.scene.bays=lab.scene.bays.map(b=>b.id===lab.scene.target.id?{...lab.scene.target}:b);lab.settings.approachReward=false;lab.settings.progressPenalty=false;lab.settings.maxTicks=600;
  await page.locator('#import-state').setInputFiles({name:'motion-lab.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(lab))});await page.locator('#status').filter({hasText:'restored'}).waitFor();
  await page.evaluate(()=>{const s=window.flykartParking.session;for(let i=0;i<60;i++)s.step({steer:0,throttle:0,brake:0,reverse:0});});await page.locator('#refresh').click();
  assert.ok(await page.evaluate(()=>{const q=window.flykartParking.session.episode.status;return q.pain>0&&q.negativeReward>0&&q.reward<0;}));
  assert.match(await page.locator('#reward-breakdown').innerText(),/negative reward −/);
  await page.locator('#strict-crash').check();await page.locator('#slow-driving').uncheck();
  const rejected=await page.evaluate(()=>{const e=window.flykartParking.session.episode;let sign=1;e.physics.step=()=>{e.physics.pose.x+=sign*.0016;};for(let i=0;i<300&&!e.done;i++){sign=Math.floor(i/10)%2?-1:1;e.step({steer:0,brake:0,throttle:sign>0?1:0,reverse:sign<0?1:0});}document.querySelector('#refresh').click();return e.result();});
  assert.equal(rejected.eradicationReason,'oscillation');assert.ok(rejected.jigglePain>0&&rejected.negativeReward>0);
  assert.match(await page.locator('#motion-judge-status').innerText(),/ERADICATED · oscillation/);
  assert.equal(await page.evaluate(()=>window.flykartParking.view3d.scene.getObjectByName('ghost-0').visible),false);
  const saved=await download('save-state'),exported=await download('export-brain');assert.equal(saved.settings.strictCrash,true);assert.equal(exported.controller.provenance.at(-1).settings.painAndPenalty,true);
  // Content changes must refresh a worker-style scene patched in place, even at the same tick.
  await page.locator('#strict-crash').uncheck();
  const geometry=await page.evaluate(()=>{const s=window.flykartParking.session,e=s.episode;e.scene.actors=[{id:'new-preview-car',kind:'vehicle',pose:{x:1.2,z:0,heading:.4},length:.26,width:.17,height:.11,speed:0,parked:true,route:[],waypoint:0,waitTicks:0}];e.scene.seed++;e.scene.target.x=1.8;e.scene.target.z=0;e.status.ticks+=2;e.render();s.cue.observe(e.frame,e.tick);e.sonarUnit.update(e.tick,e.pose,e.targets(),true);s.scan.clear();document.querySelector('#refresh').click();const b=window.flykartParking.view3d.scene.getObjectByName('actor-new-preview-car');return {position:[b.position.x,b.position.z],height:b.userData.height,echo:e.sonar().echo};});
  assert.deepEqual(geometry.position,[1.2,0]);assert.equal(geometry.height,.11);assert.equal(geometry.echo,true);assert.match(await page.locator('#sensor-agreement').innerText(),/Flag visible \+ near echo/);
  await page.locator('#reset').click();await page.locator('#memory-size').selectOption('512');await page.locator('#seconds').fill('30');await page.locator('#seconds').dispatchEvent('change');
  await page.locator('#generations').fill('1');await page.locator('#population').fill('2');await page.locator('#training-speed').selectOption('1');await page.locator('#preview').selectOption('full');await page.locator('#evolve').click();
  await page.waitForFunction(()=>window.flykartParking.ghosts.length===2&&window.flykartParking.training.ticks>5,{},{timeout:60000});
  await page.locator('#inspect-ghost').selectOption('1');
  assert.equal(await page.locator('#camera').getAttribute('data-ghost'),'2');assert.equal(await page.locator('#scan').getAttribute('data-ghost'),'2');assert.match(await page.locator('#control-source').innerText(),/Ghost 2/);
  const observer=await page.evaluate(async()=>{const {drawEye}=await import('/src/vision/ui/draw.ts');const a=window.flykartParking,s=a.ghosts[1],before={pose:{...s.episode.physics.pose},inputs:[...s.driver.sensors],scan:s.scan.toJSON(),score:s.episode.status.score};document.querySelector('#inspect-ghost').value='1';document.querySelector('#inspect-ghost').dispatchEvent(new Event('change'));const expected=document.createElement('canvas');expected.width=480;expected.height=240;drawEye(expected,s.episode.frame,s.episode.camera);return{expected:expected.toDataURL(),actual:document.querySelector('#camera').toDataURL(),before,after:{pose:{...s.episode.physics.pose},inputs:[...s.driver.sensors],scan:s.scan.toJSON(),score:s.episode.status.score}};});
  assert.equal(observer.actual,observer.expected);assert.deepEqual(observer.after,observer.before);
  // Real pointer hit-testing in each world view. Separate observer poses only for a deterministic click fixture.
  await page.locator('#lot-view').selectOption('plan');
  const top=await page.evaluate(()=>{const a=window.flykartParking;a.ghosts[0].episode.physics.pose={x:-.6,z:.7,heading:0};a.ghosts[1].episode.physics.pose={x:.6,z:.7,heading:0};a.ghosts.forEach(s=>s.episode.status.ticks++);document.querySelector('#refresh').click();const c=document.querySelector('#lot'),r=c.getBoundingClientRect(),scale=Math.min(c.width/6.4,c.height/6.4);c.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+(c.width/2+.6*scale)/c.width*r.width,clientY:r.top+(c.height/2+.7*scale)/c.height*r.height,bubbles:true}));return a.selectedGhost;});assert.equal(top,1);
  await page.locator('#lot-view').selectOption('3d');await page.locator('#inspect-ghost').selectOption('0');await page.locator('#lot-3d').scrollIntoViewIfNeeded();
  const click=await page.evaluate(()=>{const a=window.flykartParking;a.ghosts[0].episode.physics.pose={x:-.6,z:.7,heading:0};a.ghosts[1].episode.physics.pose={x:.6,z:.7,heading:0};a.ghosts.forEach(s=>s.episode.status.ticks++);document.querySelector('#refresh').click();const view=a.view3d,body=view.scene.getObjectByName('ghost-1'),p=body.position.clone();p.y=.04;p.project(view.camera);const r=document.querySelector('#lot-3d').getBoundingClientRect();return{x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height};});
  await page.mouse.click(click.x,click.y);await page.waitForFunction(()=>window.flykartParking.selectedGhost===1,{},{timeout:5000});
  await page.locator('#headless-again').click();await page.locator('#training-speed').selectOption('1');await page.locator('#inspect-ghost').selectOption('0');assert.equal(await page.locator('#preview').inputValue(),'low');
  await page.locator('#cancel').click();await page.waitForFunction(()=>!window.flykartParking.busy,{},{timeout:60000});
  assert.equal(await page.locator('#camera').getAttribute('data-ghost'),'live');assert.equal(await page.locator('#inspect-ghost').isDisabled(),true);
  await mkdir('.cache',{recursive:true});await page.locator('.world-foot').screenshot({path:'.cache/parking-motion-judge.png'});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  console.log('Parking judge passed: combined pain/negative sugar and exports, oscillation eradication and invisible rejected bodies, refreshed in-place car geometry, visible-flag/near-car sonar explanation, selectable actual ghost FPV/sonar/controls, 2D/3D click selection, headless inspection and mobile fit.');
}finally{await browser.close();}
