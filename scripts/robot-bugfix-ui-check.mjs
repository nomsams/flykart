import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

// Isolated browser and fake serial port: no physical device or user's session.
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true,args:['--enable-webgl']});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
  const mock={commands:[],controller:null,interval:null,armed:false,camera:true,config:'ESP32CAM:v1:12,13,14,15,-1,-1,2,4:1:1',delayArm:false,release:null,energy:null};
  const emit=()=>mock.controller?.enqueue(new TextEncoder().encode(`${mock.energy===null?'':`ENERGY ${Math.floor(performance.now())} ${mock.energy} 0\n`}CONFIG ${mock.config}\nFRAME 1 -1.00 ${+mock.armed} 0 0 ${mock.camera?'160 120 38400 '+btoa('\x18\xbf'.repeat(160*120)):'0 0 0'}\n`));
  const port={readable:null,writable:null,async open(){
    this.readable=new ReadableStream({start(c){mock.controller=c;},cancel(){mock.controller=null;}});
    this.writable=new WritableStream({async write(bytes){const text=new TextDecoder().decode(bytes).trim();mock.commands.push(text);if(text==='ARM'){if(mock.delayArm)await new Promise(r=>mock.release=r);mock.armed=true;}if(text==='STOP')mock.armed=false;}});
    mock.interval=setInterval(emit,150);emit();
  },async close(){clearInterval(mock.interval);mock.controller=null;}};
  Object.defineProperty(navigator,'serial',{configurable:true,value:{requestPort:async()=>port}});window.__robotSerial=mock;
});
const ready=()=>page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});
const download=async id=>{const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);return JSON.parse(await readFile(await d.path(),'utf8'));};
const stopReason=reason=>page.locator('#serial-log').filter({hasText:reason}).waitFor();
const armed=()=>page.locator('#serial-log').filter({hasText:'USB controller armed'}).waitFor();
try{
  await page.goto((process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173')+'/robot.html?tools=all',{waitUntil:'domcontentloaded',timeout:60000});await ready();
  const baseline=await download('save-lab');
  for(const corruption of ['adapter','eyes']){
    await page.evaluate(corruption=>{const data=JSON.parse(localStorage.getItem('flykart-robot-habitat-v1'));data.objects=[];data.floorColour='#ff0000';if(corruption==='adapter')data.adapter.turnGain=-1;else data.vision.targetScale[0]=null;localStorage.setItem('flykart-robot-habitat-v1',JSON.stringify(data));},corruption);
    await page.reload();await ready();const restored=await download('save-lab');assert.equal(restored.objects.length,baseline.objects.length);assert.equal(restored.floorColour,baseline.floorColour);
  }
  await page.locator('#brain-file').setInputFiles({name:'racer.json',mimeType:'application/json',buffer:await readFile('public/sample-brain.json')});await page.locator('#adapter').filter({hasText:'TRACK'}).waitFor();
  await page.locator('#restore-brain').click();await page.locator('#brain-name').filter({hasText:'Bundled robot world brain'}).waitFor();const selected=await download('save-lab');await page.reload();await ready();assert.deepEqual((await download('save-lab')).controller.network,selected.controller.network);assert.equal(await page.locator('#adapter').textContent(),'WORLD INPUTS');
  await page.locator('#task-mode').selectOption('approach');await page.locator('#task-setup').click();await page.locator('#task-inheritance').fill('.9');await page.locator('#task-validate').click();await page.locator('#status').filter({hasText:'Apply the task settings'}).waitFor();assert.equal((await download('task-export')).evidence.length,0);
  await page.locator('#drive-mode').selectOption('fly');await page.locator('.hardware-lab>summary').click();await page.locator('#serial-connect').click();await page.locator('#real-sensors').filter({hasText:'Real sonar'}).waitFor();
  await page.evaluate(()=>window.__robotSerial.delayArm=true);await page.locator('#serial-arm').click();await page.waitForFunction(()=>window.__robotSerial.commands.includes('ARM'));
  await page.locator('#serial-stop').click();await page.evaluate(()=>{window.__robotSerial.delayArm=false;window.__robotSerial.release();});await stopReason('Motor arming cancelled');await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.__robotSerial.commands.some(c=>c.startsWith('M '))),false);
  await page.locator('#serial-arm').click();await armed();await page.waitForFunction(()=>window.__robotSerial.commands.some(c=>c.startsWith('M ')));
  await page.evaluate(()=>window.__robotSerial.camera=false);await stopReason('Camera pixels missing');await page.waitForTimeout(100);let count=await page.evaluate(()=>window.__robotSerial.commands.length);await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.__robotSerial.commands.length),count);
  await page.evaluate(()=>window.__robotSerial.camera=true);await page.waitForTimeout(200);await page.locator('#clear-serial').click();await page.locator('#serial-arm').click();await armed();await page.evaluate(()=>window.__robotSerial.config='wrong-pin-map');await stopReason('Firmware configuration changed');
  await page.evaluate(()=>window.__robotSerial.config='ESP32CAM:v1:12,13,14,15,-1,-1,2,4:1:1');await page.waitForTimeout(200);await page.locator('#clear-serial').click();await page.locator('#serial-arm').click();await armed();await page.evaluate(()=>window.__robotSerial.armed=false);await stopReason('Device disarmed');
  await page.locator('#serial-disconnect').click();
  await page.locator('.target-hunger>summary').click();await page.locator('#hunger-prepare').click();await page.locator('#task-setup').click();await page.locator('#status').filter({hasText:'Charging-pod task prepared'}).waitFor();await page.locator('#serial-connect').click();await page.locator('#real-sensors').filter({hasText:'Real sonar'}).waitFor();await page.locator('#serial-arm').click();await page.locator('#status').filter({hasText:'fresh measured ENERGY'}).waitFor();
  await page.evaluate(()=>window.__robotSerial.energy=.12);await page.locator('#real-energy').filter({hasText:'12.0%'}).waitFor();await page.locator('#clear-serial').click();await page.locator('#serial-arm').click();await armed();await page.evaluate(()=>window.__robotSerial.energy=null);await stopReason('Battery/charger telemetry stale');assert.match(await page.locator('#real-neural').textContent(),/disarmed/);
  await page.evaluate(()=>window.__robotSerial.energy=.12);await page.locator('#real-energy').filter({hasText:'12.0%'}).waitFor();await page.locator('#clear-serial').click();await page.locator('#serial-arm').click();await armed();await page.evaluate(()=>window.__robotSerial.energy=3);await stopReason('Invalid ENERGY telemetry');assert.match(await page.locator('#real-neural').textContent(),/disarmed/);await page.locator('#serial-disconnect').click();assert.deepEqual(errors,[]);
  console.log('Robot bug regressions passed: atomic restore, bundled brain persistence, applied evaluation settings, ARM/STOP race, camera loss, configuration changes and MCU disarm, measured hunger telemetry required, stale battery data and invalid energy stops.');
}finally{await browser.close();}
