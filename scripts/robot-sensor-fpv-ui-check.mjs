import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.setDefaultNavigationTimeout(90000);page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
const rawMatches=async domain=>assert.equal(await page.evaluate(async domain=>{
  const {drawEye}=await import('/src/vision/ui/draw.ts'),{lowResolution}=await import('/src/vision/ensemble.ts');
  const s=window.flykartVision.inspection[domain],e=s.episode,c=document.createElement('canvas'),actual=document.querySelector('#'+domain+'-eye');c.width=actual.width;c.height=actual.height;
  drawEye(c,lowResolution(e.frame,e.camera.width,e.camera.height,s.settings.resolution??'native'),e.camera);
  return c.toDataURL()===actual.toDataURL();
},domain),true,'Camera must show the selected cart’s exact frame');
const modes=async domain=>{
  assert.equal(await page.evaluate(domain=>{
    const s=window.flykartVision.inspection[domain],e=s.episode,before=JSON.stringify(Array.from(e.frame)),sensors=JSON.stringify(s.driver?.sensors),unit=e.scanSonarUnit??e.sonarUnit,ping=unit.count;
    const select=document.querySelector('#'+domain+'-fpv-mode');select.value='overlay';select.dispatchEvent(new Event('change'));
    const over=document.querySelector('#'+domain+'-eye').toDataURL();select.value='sonar';select.dispatchEvent(new Event('change'));
    const sonar=document.querySelector('#'+domain+'-eye').toDataURL();select.value='camera';select.dispatchEvent(new Event('change'));
    return before===JSON.stringify(Array.from(e.frame))&&sensors===JSON.stringify(s.driver?.sensors)&&unit.count===ping&&over!==sonar&&sonar!==document.querySelector('#'+domain+'-eye').toDataURL();
  },domain),true,'Layers must be distinct and cannot modify raw RGB, neural inputs or ping count');
  await rawMatches(domain);
};
try{
  await page.goto(base+'/vision.html');await page.locator('#boot-screen').waitFor({state:'hidden',timeout:90000});
  await page.locator('#profile').selectOption('robot');await modes('track');
  await page.locator('#track-fpv-mode').selectOption('overlay');assert.match(await page.locator('#track-fpv-status').textContent(),/main lobe 15.0°/);
  // Real worker ghosts: inspection is available during evolution, including one-shot headless refresh.
  await page.locator('#camera-controller-training').evaluate(e=>e.open=true);
  await page.locator('#camera-generations').fill('10');await page.locator('#camera-population').fill('3');await page.locator('#camera-train-ticks').fill('300');await page.locator('#camera-train-speed').selectOption('1');
  await page.locator('#camera-train').click();await page.waitForFunction(()=>document.querySelector('#track-inspect-ghost option[value="2"]')&&!document.querySelector('#track-inspect-ghost').disabled,{},{timeout:90000});
  await page.locator('#track-inspect-ghost').selectOption('2');await page.locator('#track-fpv-mode').selectOption('camera');await rawMatches('track');
  assert.equal(await page.locator('#track-eye').getAttribute('data-cart'),'Cart 3');
  await page.locator('#vision-render-mode').selectOption('headless');await page.locator('#vision-refresh').click();assert.equal(await page.locator('#track-eye').getAttribute('data-cart'),'Cart 3');
  // Click the selected cart using the same track projection as the displayed map.
  const click=await page.evaluate(()=>{const s=window.flykartVision.inspection.trackGhosts[1],m=document.querySelector('#track-map'),b=m.getBoundingClientRect(),W=Number(m.dataset.w),H=Number(m.dataset.h),scale=Math.min(W/780,H/500);return {x:b.left+(W/2+s.episode.car.position.x*scale)*b.width/W,y:b.top+(H/2+s.episode.car.position.y*scale)*b.height/H};});
  await page.mouse.click(click.x,click.y);assert.notEqual(await page.locator('#track-inspect-ghost').inputValue(),'2');
  await page.locator('#track-inspect-ghost').selectOption('-1');await page.locator('#vision-refresh').click();assert.equal(await page.locator('#track-eye').getAttribute('data-cart'),'Live robot');
  await page.locator('#camera-train-stop').click();await page.locator('#camera-train-stop').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#camera-train-stop').disabled,{},{timeout:90000});
  await page.locator('#vision-render-mode').selectOption('full');await page.locator('#tab-btn-world').click();await modes('world');
  await page.locator('#world-population').fill('3');await page.locator('#world-generations').fill('10');await page.locator('#world-train-ticks').fill('300');await page.locator('#world-train-speed').selectOption('1');
  await page.locator('#world-train').click();await page.waitForFunction(()=>document.querySelector('#world-inspect-ghost option[value="2"]')&&!document.querySelector('#world-inspect-ghost').disabled,{},{timeout:90000});
  await page.locator('#world-inspect-ghost').selectOption('2');await page.locator('#world-fpv-mode').selectOption('camera');await rawMatches('world');
  assert.equal(await page.locator('#world-eye').getAttribute('data-cart'),'Cart 3');
  await page.locator('#world-fpv-mode').selectOption('overlay');await page.locator('#vision-render-mode').selectOption('headless');await page.locator('#vision-refresh').click();assert.equal(await page.locator('#world-eye').getAttribute('data-cart'),'Cart 3');
  await page.locator('#world-inspect-ghost').selectOption('-1');await page.locator('#vision-refresh').click();assert.equal(await page.locator('#world-eye').getAttribute('data-cart'),'Live robot');
  await page.waitForTimeout(600);assert.equal(await page.locator('#world-inspect-ghost').inputValue(),'-1','Snapshots must preserve explicit live-cart selection');
  await page.locator('#world-train-stop').click();await page.waitForFunction(()=>document.querySelector('#world-train-stop').disabled,{},{timeout:90000});await page.locator('#vision-render-mode').selectOption('full');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#world-fpv-mode').scrollIntoViewIfNeeded();await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/sensor-fpv-mobile.png'});
  await page.goto(base+'/parking.html');await page.waitForFunction(()=>window.flykartParking,{},{timeout:90000});await page.locator('#parking-fpv-mode').selectOption('sonar');assert.equal(await page.locator('#camera').getAttribute('data-fpv-mode'),'sonar');await page.locator('#parking-fpv-mode').selectOption('overlay');assert.match(await page.locator('#parking-fpv-status').textContent(),/main lobe/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:'.cache/sensor-fpv-parking-mobile.png'});assert.deepEqual(errors,[]);
  console.log('Sensor FPV passed: camera / sonar / overlay, unchanged raw RGB and neural inputs, real Racer/Open World worker-cart selection, click inspection, stable live selection, headless refresh and parking/mobile controls.');
}catch(e){console.error(await page.locator('#boot-screen').textContent().catch(()=>''),errors);await mkdir('.cache',{recursive:true});await page.screenshot({path:'.cache/sensor-fpv-failure.png',fullPage:true}).catch(()=>{});throw e;}finally{await browser.close();}
