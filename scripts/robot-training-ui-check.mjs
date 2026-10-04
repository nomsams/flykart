import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser=await chromium.launch({...(process.platform==="win32"?{channel:"msedge"}:{}),headless:true,args:["--enable-webgl"]});
const context=await browser.newContext({viewport:{width:1440,height:1080},permissions:["clipboard-read","clipboard-write"]});
const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
await page.addInitScript(()=>{
  const mock={commands:[],controller:null,interval:null,armed:false,config:"ESP32CAM:v1:12,13,14,15,-1,-1,2,4:1:1"};
  const emit=()=>{if(!mock.controller)return;const binary="\xf8\0".repeat(160*120);mock.controller.enqueue(new TextEncoder().encode(`CONFIG ${mock.config}\nFRAME 1 60.00 ${+mock.armed} 0 0 160 120 38400 ${btoa(binary)}\n`));};
  const port={readable:null,writable:null,async open(){this.readable=new ReadableStream({start(c){mock.controller=c;},cancel(){mock.controller=null;}});this.writable=new WritableStream({write(bytes){const text=new TextDecoder().decode(bytes).trim();mock.commands.push(text);if(text==="ARM")mock.armed=true;if(text==="STOP")mock.armed=false;}});mock.interval=setInterval(emit,400);emit();},async close(){clearInterval(mock.interval);mock.interval=null;mock.controller=null;}};
  Object.defineProperty(navigator,"serial",{configurable:true,value:{requestPort:async()=>port}});mock.emit=emit;window.__robotSerialMock=mock;
});
const download=async id=>{const[d]=await Promise.all([page.waitForEvent("download"),page.locator(`#${id}`).click()]);return readFile(await d.path(),"utf8");};
try{
  await page.goto((process.env.ROBOT_LAB_URL??"http://127.0.0.1:5173")+"/robot.html?tools=all",{waitUntil:"domcontentloaded",timeout:60000});await page.locator("#status").filter({hasText:"Ready."}).waitFor({timeout:60000});
  await page.locator("#show-pinout").click();
  const pinout=page.locator("#pinout-diagram");
  await pinout.locator('[data-signal="in1"]').click();await pinout.locator('[data-gpio="13"]').click();
  assert.match(await page.locator("#sketch").inputValue(),/const int IN1 = 13;/);assert.match(await page.locator("#sketch").inputValue(),/const int IN2 = 12;/);
  // Drag another socket to an occupied pin and verify the reciprocal swap.
  const a=await pinout.locator('[data-signal="trig"] circle').boundingBox(),b=await pinout.locator('[data-gpio="4"] circle').boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:8});await page.mouse.up();
  assert.match(await page.locator("#sketch").inputValue(),/const int TRIG = 4;/);assert.match(await page.locator("#sketch").inputValue(),/const int ECHO = 2;/);
  await mkdir(".cache",{recursive:true});await page.locator("#pinout").evaluate(d=>d.scrollTop=0);await page.screenshot({path:".cache/robot-editable-wiring.png",fullPage:true});await page.locator("#close-pinout").click();
  await page.locator("#step").click();await page.locator("#copy-log").click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/CAMERA|SYSTEM|SONAR/);
  await page.locator("#copy-log-json").click();assert.ok(Array.isArray(JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()))));
  const combined=JSON.parse(await download("export-fly"));assert.equal(combined.format,"flykart-vision-brain");assert.ok(combined.vision.params);const initial=combined.controller.network;
  await page.locator("#preset").selectOption("room");await page.locator("#train-seconds").fill("5");await page.locator("#train-episodes").fill("1");await page.locator("#sim-rate").selectOption("4");
  await page.locator("#train-evaluate").click();await page.locator("#train-status").filter({hasText:"Training complete"}).waitFor({timeout:30000});
  const evaluation=JSON.parse(await download("train-export"));assert.equal(evaluation.results.length,1);assert.ok(evaluation.episodes[0].frames.length>0);assert.ok(evaluation.episodes[0].steps.length>=150);assert.deepEqual(evaluation.controller.network,initial);
  await page.locator("#train-population").fill("2");await page.locator("#train-generations").fill("1");await page.locator("#train-evolve").click();await page.locator("#train-status").filter({hasText:"Training complete"}).waitFor({timeout:30000});
  const evolved=JSON.parse(await download("train-export"));assert.equal(evolved.results.length,2);assert.equal(evolved.completed,true);assert.equal(evolved.episodes.length,2);assert.equal(await page.locator("#run").textContent(),"▶ Run simulation");
  await page.locator(".hardware-lab>summary").click();const sketch=await download("export-bridge");assert.match(sketch,/IN1=13, IN2=12/);assert.match(sketch,/TRIG=4, ECHO=2/);await writeFile(".cache/bridge-ui-export.ino",sketch);
  await page.locator("#serial-connect").click();await page.locator("#real-sensors").filter({hasText:"60.0 cm"}).waitFor();
  const red=await page.locator("#real-camera").evaluate(c=>Array.from(c.getContext("2d").getImageData(0,0,1,1).data));assert.deepEqual(red,[255,0,0,255]);
  await page.locator("#serial-arm").click();await page.locator("#status").filter({hasText:"pin map or sensors differ"}).waitFor();assert.equal(await page.evaluate(()=>window.__robotSerialMock.commands.includes("ARM")),false);await page.evaluate(()=>{window.__robotSerialMock.config="ESP32CAM:v1:13,12,14,15,-1,-1,4,2:1:1";window.__robotSerialMock.emit();});await page.locator("#serial-arm").click();await page.waitForTimeout(600);assert.ok(await page.evaluate(()=>window.__robotSerialMock.commands.includes("ARM")));assert.ok(await page.evaluate(()=>window.__robotSerialMock.commands.some(c=>c.startsWith("M "))));
  await page.locator("#serial-stop").click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.__robotSerialMock.commands.at(-1)),"STOP");
  await page.locator("#copy-serial").click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/Motors disarmed/);await page.locator("#serial-disconnect").click();
  await page.locator(".flash-panel>summary").click();await page.locator("#flash-file-3").setInputFiles({name:"app.bin",mimeType:"application/octet-stream",buffer:Buffer.from([0xe9,1,2,3])});await page.locator("#review-flash").click();await page.locator("#flash-review").filter({hasText:"SHA-256"}).waitFor();assert.equal(await page.locator("#flash-device").isEnabled(),true);
  await page.screenshot({path:".cache/robot-hardware-desktop.png",fullPage:true});await page.locator("#flash-offset-3").fill("1");await page.locator("#review-flash").click();await page.locator("#status").filter({hasText:"4 KB-aligned"}).waitFor();assert.equal(await page.locator("#flash-device").isEnabled(),false);
  await page.locator(".hardware-lab>summary").click();await page.screenshot({path:".cache/robot-training-desktop.png",fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:".cache/robot-training-mobile.png",fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  assert.deepEqual(errors,[]);console.log("Click/drag GPIO swaps, automatic code sync, clipboard logs, reproducible evaluation/evolution, fly+eyes export, real-frame serial mock, arm/stop/disconnect, flash review and mobile layout verified. No physical hardware used.");
}finally{await browser.close();}
