import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto((process.env.ROBOT_LAB_URL??'http://127.0.0.1:5173')+'/robot.html');
 await page.locator('#status').filter({hasText:'Ready.'}).waitFor({timeout:60000});
 await page.locator('.wb-navigation [data-tool=senses]').click();
 for(const index of [0,1,2,-1])await page.locator(`[data-monitor="${index}"]`).click();
 await page.setViewportSize({width:390,height:844});
 for(const font of ['system-ui','Arial','Verdana']) {
  await page.addStyleTag({content:`:root{font-family:${font}}`});
  const report=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,items:[...document.body.querySelectorAll('*')].filter(e=>{
   const r=e.getBoundingClientRect();if(!r.width||r.right<=innerWidth+1||getComputedStyle(e).visibility!=='visible')return false;
   for(let p=e.parentElement;p;p=p.parentElement)if(['hidden','clip','auto','scroll'].includes(getComputedStyle(p).overflowX)&&p.getBoundingClientRect().right<=innerWidth+1)return false;
   return true;
  }).map(e=>({id:e.id,tag:e.tagName,className:String(e.className),right:e.getBoundingClientRect().right,text:e.textContent.slice(0,90)})).slice(0,12)}));
  console.log(font,JSON.stringify(report));assert.ok(report.width<=report.viewport+1,JSON.stringify(report));
 }
 assert.deepEqual(errors,[]);console.log('Mobile font check passed: monitor selection and all-view layout stay within a 390 px viewport with three font fallbacks.');
}finally {await browser.close();}
