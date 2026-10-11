import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const base=process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173';
try{
  await page.goto(base+'/parking.html');
  await page.locator('#status').filter({hasText:'Ready ·'}).waitFor({timeout:90000});
  await page.locator('#lot-view').selectOption('plan');
  assert.equal(await page.locator('#sonar-on').isChecked(),true);
  const result=await page.evaluate(()=>{
    const s=window.flykartParking.session,e=s.episode,unit=e.sonarUnit,PX=100/1.1,b=(e.scene.half-.0125)*PX;
    const refresh=()=>document.querySelector('#refresh').click();
    const footprint=()=>JSON.parse(document.querySelector('#scan').dataset.beamFootprint);
    const fails=[];let cases=0,timeouts=0;
    for(const forceTimeout of [false,true])for(const sx of [-1,1])for(const sy of [-1,1])for(const centre of [2.78,2.3,1.8])for(const turn of [-.6,0,.6]){
      e.physics.pose={x:sx*centre,z:sy*centre,heading:Math.atan2(sy,sx)+turn};
      e.status.ticks+=2;unit.update(e.tick,e.pose,e.targets(),true);
      if(forceTimeout)unit.reading={range:400/1.1,echo:false,strength:0};
      s.scan.clear();s.scan.record(unit,e.pose);refresh();cases++;
      const points=footprint();
      if(points.length!==33||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>b+1e-7||Math.abs(p.y)>b+1e-7))fails.push({forceTimeout,sx,sy,centre,turn,points});
      if(!unit.reading.echo){timeouts++;if(s.scan.cells.size!==0||unit.reading.range!==400/1.1)fails.push('Timeout fabricated free/occupied cells or changed raw range');}
    }
    // Leave the visible scene in the exact reported corner-facing timeout case.
    e.physics.pose={x:2.78,z:2.78,heading:Math.PI/4};e.status.ticks+=2;
    unit.update(e.tick,e.pose,e.targets(),true);unit.reading={range:400/1.1,echo:false,strength:0};
    s.scan.clear();s.scan.record(unit,e.pose);e.render();refresh();
    return{cases,timeouts,fails};
  });
  assert.deepEqual(result.fails,[]);assert.equal(result.cases,72);assert.ok(result.timeouts>=36);
  const state=()=>page.evaluate(()=>{
    const s=window.flykartParking.session,e=s.episode;
    return{scan:s.scan.toJSON(),controller:s.network.toJSON(),memory:s.memory.toJSON(),inputs:[...s.driver.sensors],pose:{...e.physics.pose},reading:{...e.sonar()},frame:[...e.frame],score:{...e.status}};
  });
  const before=await state(),beam=await page.locator('#scan').getAttribute('data-beam-footprint');
  await page.locator('#parking-scan-reference').evaluate(e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement)p.open=true;});
  await page.locator('#parking-scan-reference').check();
  assert.equal(await page.locator('#scan').getAttribute('data-beam-footprint'),beam,'Reference overlay must not control occlusion');
  await page.locator('#parking-scan-reference').uncheck();await page.locator('#scan-view').click();
  assert.equal(await page.locator('#scan').getAttribute('data-beam-footprint'),beam,'Top and perspective must share physical beam limits');
  await page.locator('#refresh').click();assert.deepEqual(await state(),before,'Observer clipping must not change inputs, raw sonar, brain, learning or scores');
  assert.match(await page.locator('#sonar-info').innerText(),/no echo.*unknown.*Displayed beam stops at simulated solids/);
  // A retained/imported out-of-room noisy cell stays exported but cannot paint past the wall.
  const cropped=await page.evaluate(()=>{
    const s=window.flykartParking.session,c=document.querySelector('#scan'),ctx=c.getContext('2d'),extent=s.episode.scene.half*100/1.1;
    const key=`${Math.floor(extent/8)+1},0`,scale=Math.min((c.width-36)/2,(c.height-56)/2)/extent;
    const x=Math.round(c.width/2+(Number(key.split(',')[0])*8+4)*scale),y=Math.round(c.height/2+12+4*scale);
    const before=[...ctx.getImageData(x,y,2,2).data];s.scan.cells.set(key,4);document.querySelector('#refresh').click();
    return{before,after:[...ctx.getImageData(x,y,2,2).data],retained:s.scan.toJSON().cells.some(([k,v])=>k===key&&v===4)};
  });
  assert.deepEqual(cropped.after,cropped.before);assert.equal(cropped.retained,true);
  await page.locator('#scan-view').click();await page.locator('#parking-scan-reference').check();
  await mkdir('.cache',{recursive:true});await page.locator('#scan').screenshot({path:'.cache/parking-sonar-corner.png'});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('#scan').scrollIntoViewIfNeeded();await page.screenshot({path:'.cache/parking-sonar-corner-mobile.png'});
  assert.deepEqual(errors,[]);
  console.log(`Parking sonar wall check passed: ${result.cases} corner/grazing/timeout cases, solid beam occlusion with overlay off/on, top/perspective agreement, no privileged neural inputs, unknown timeouts, retained-but-cropped evidence and mobile layout.`);
}finally{await browser.close();}
