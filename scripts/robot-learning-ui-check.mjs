import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import * as THREE from "three";

const browser=await chromium.launch({...(process.platform==="win32"?{channel:"msedge"}:{}),headless:true,args:["--enable-webgl"]});
const context=await browser.newContext({viewport:{width:1440,height:1080},permissions:["clipboard-read","clipboard-write"]});
const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
await page.addInitScript(()=>{
  const mock={commands:[],controller:null,interval:null,armed:false};
  const emit=()=>{if(!mock.controller)return;const binary="\xf8\x1f".repeat(160*120);mock.controller.enqueue(new TextEncoder().encode(`CONFIG ESP32CAM:v1:12,13,14,15,-1,-1,2,4:1:1\nFRAME 1 80.00 ${+mock.armed} 0 0 160 120 38400 ${btoa(binary)}\n`));};
  const port={readable:null,writable:null,async open(){this.readable=new ReadableStream({start(c){mock.controller=c;},cancel(){mock.controller=null;}});this.writable=new WritableStream({write(bytes){const text=new TextDecoder().decode(bytes).trim();mock.commands.push(text);if(text==="ARM")mock.armed=true;if(text==="STOP")mock.armed=false;}});mock.interval=setInterval(emit,400);emit();},async close(){clearInterval(mock.interval);mock.controller=null;}};
  Object.defineProperty(navigator,"serial",{configurable:true,value:{requestPort:async()=>port}});window.__learningSerial=mock;
});
const download=async id=>{const[d]=await Promise.all([page.waitForEvent("download"),page.locator(`#${id}`).click()]);return JSON.parse(await readFile(await d.path(),"utf8"));};
const importLab=async data=>{await page.locator("#lab-file").setInputFiles({name:"learning-lab.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(data,null,2))});await page.locator("#status").filter({hasText:"Imported habitat"}).waitFor();};
const set=async(k,v)=>{const input=page.locator(`#object-editor [data-property="${k}"]`);await input.fill(String(v));await input.dispatchEvent("change");};
const near=(a,b,eps=.035)=>assert.ok(Math.abs(a-b)<eps,`${a} expected close to ${b}`);
const point=async(x,z,y=0)=>{
  await page.locator("#habitat").scrollIntoViewIfNeeded();const r=await page.locator("#habitat").boundingBox(),cam=new THREE.PerspectiveCamera(42,r.width/r.height,.01,80);cam.position.set(3.5,4.8,5.2);cam.lookAt(0,.05,0);cam.updateMatrixWorld();const v=new THREE.Vector3(x,y,z).project(cam);return {x:r.x+(v.x+1)/2*r.width,y:r.y+(1-v.y)/2*r.height};
};
const drag=async(a,b)=>{await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:16});await page.mouse.up();};
const hash=async id=>page.locator(`#${id}`).evaluate(c=>{let hash=0;for(const v of c.getContext("2d").getImageData(0,0,c.width,c.height).data)hash=(hash*31+v)|0;return hash;});
try{
  await page.goto((process.env.ROBOT_LAB_URL??"http://127.0.0.1:5173")+"/robot.html?tools=all",{waitUntil:"domcontentloaded",timeout:60000});await page.locator("#status").filter({hasText:"Ready."}).waitFor({timeout:60000});await page.locator("#preset").selectOption("empty");
  await page.locator("#select-robot").click();await set("x",-.7);await set("z",.6);await set("yaw",30);let lab=await download("save-lab");near(lab.startPose.heading,Math.PI/6,.001);near(lab.currentPose.x,-.7,.001);
  await page.locator("#rotate-right").click();near((await download("save-lab")).startPose.heading,Math.PI/4,.001);
  await page.locator("#undo").click();await page.locator("#select-robot").click();near((await download("save-lab")).startPose.heading,Math.PI/6,.001);
  await page.locator("#overview").click();await page.locator("#scene-tool").selectOption("move");await page.waitForTimeout(100);
  const a=await point(-.7,.6),b=await point(-.35,.4);await drag(a,b);lab=await download("save-lab");near(lab.startPose.x,-.35);near(lab.startPose.z,.4);
  await page.locator("#reset").click();const reset=await download("save-lab");assert.deepEqual(reset.currentPose,lab.startPose);
  // Drawn floor strokes become a saved objective, not an invisible navigation path.
  await page.locator("#scene-tool").selectOption("trail");await drag(await point(.2,-.3),await point(1.1,-.3));lab=await download("save-lab");assert.equal(lab.mission.settings.mode,"trail");assert.ok(lab.mission.trail.length>3);
  await page.locator("#undo").click();assert.equal((await download("save-lab")).mission.trail.length,0);
  await page.locator("#scene-tool").selectOption("orbit");await page.locator("#object-kind").selectOption("block");await page.locator("#add-object").click();lab=await download("save-lab");const block=lab.objects[0];
  await set("x",1);await set("z",1);await set("yaw",45);await page.locator("#scene-tool").selectOption("move");await drag(await point(1,1),await point(1.35,1.25));lab=await download("save-lab");near(lab.objects[0].x,1.35);near(lab.objects[0].z,1.25);near(lab.objects[0].yaw,Math.PI/4,.001);
  await page.locator("#scene-tool").selectOption("rotate");await drag(await point(1.6,1.25),await point(1.35,1.5));lab=await download("save-lab");assert.ok(Math.abs(lab.objects[0].yaw-Math.PI/4)>.5);
  await page.locator("#preset").selectOption("empty");await page.locator("#select-robot").click();await set("x",-1);await set("z",0);await set("yaw",0);
  await page.locator("#scene-tool").selectOption("orbit");await page.locator("#add-sugar").click();await set("x",-.65);await set("z",0);await set("radius",.18);
  await page.locator("#program").selectOption("manual");await page.locator("#step-size").selectOption("30");await page.locator("#step").focus();await page.keyboard.down("w");await page.locator("#step").click();await page.keyboard.up("w");
  await page.locator("#objective-status").filter({hasText:"sugar 1/1"}).waitFor();const learned=await download("save-lab");assert.ok(learned.learning.sugarPolicy.updates>0);assert.ok(learned.learning.sugarPolicy.weights.some(v=>v>0));
  await page.locator("#console-filter").selectOption("reward");await page.locator("#copy-log").click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/Sugar collected/);
  await page.locator("#step").click();assert.equal((await download("save-lab")).learning.sugarPolicy.updates,learned.learning.sugarPolicy.updates,"A collected target must not pay again");
  await importLab(learned);let restored=await download("save-lab");assert.deepEqual(restored.learning.sugarPolicy,learned.learning.sugarPolicy);assert.deepEqual(restored.mission,learned.mission);assert.deepEqual(restored.startPose,learned.startPose);
  // Processing changes only the fly input, not the raw camera capture.
  await page.waitForTimeout(200);const raw=await hash("camera");await page.locator("#vision-layout").selectOption("circle3");await page.locator("#vision-temporal").selectOption("4");await page.locator("#vision-normalize").check();await page.locator("#kenyon-count").selectOption("10000");await page.locator("#apply-vision").click();await page.locator("#swarm-views canvas").first().waitFor();
  assert.equal(await page.locator("#swarm-views canvas").count(),3);assert.equal(await hash("camera"),raw);assert.notDeepEqual(await page.locator("#swarm-views canvas").nth(1).evaluate(c=>c.toDataURL()),await page.locator("#swarm-views canvas").nth(2).evaluate(c=>c.toDataURL()));
  await page.locator("#step-size").selectOption("1");await page.locator("#step").click();assert.match(await page.locator("#kenyon-status").textContent(),/100 active/);
  const combined=await download("export-fly");assert.equal(combined.robotLearning.memorySettings.count,10000);assert.equal(combined.robotLearning.visionSettings.layout,"circle3");assert.ok(combined.robotLearning.memory.counts.some(v=>v>0));
  await page.locator("#brain-file").setInputFiles({name:"robot-fly.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(combined))});await page.locator("#brain-name").filter({hasText:combined.name}).waitFor();assert.equal(await page.locator("#kenyon-count").inputValue(),"10000");
  // Evaluation rewards are included while live reward weights stay frozen.
  lab=await download("save-lab");lab.mission.settings.mode="sugar";lab.mission.goals[0]={...lab.mission.goals[0],...lab.startPose};delete lab.mission.goals[0].heading;lab.mission.trail=[];lab.learning.visionSettings={normalize:false,smooth:false,temporal:1,layout:"single",radius:.08};lab.mode="fly";await importLab(lab);
  await page.locator("#train-seconds").fill("5");await page.locator("#train-episodes").fill("1");await page.locator("#sim-rate").selectOption("4");await page.locator("#train-evaluate").click();await page.locator("#train-status").filter({hasText:"Training complete"}).waitFor({timeout:40000});
  const dataset=await download("train-export");assert.equal(dataset.results[0].taskReward,10);assert.ok(dataset.episodes[0].steps.some(s=>s.evaluation.taskReward===10));assert.equal(dataset.context.initialPose.x,lab.startPose.x);assert.deepEqual((await download("save-lab")).learning.sugarPolicy,lab.learning.sugarPolicy);
  // Simulated antennae cannot silently drive the physical camera/sonar car.
  await page.locator("#objective-mode").selectOption("trail");await page.locator("#objective-cue").selectOption("scent");await page.locator("#apply-objective").click();await page.locator("#forage").click();await page.locator(".hardware-lab>summary").click();await page.locator("#serial-connect").click();await page.locator("#real-sensors").filter({hasText:"80.0 cm"}).waitFor();await page.locator("#serial-arm").click();await page.locator("#status").filter({hasText:"simulation-only"}).waitFor();assert.equal(await page.evaluate(()=>window.__learningSerial.commands.includes("ARM")),false);await page.locator("#serial-disconnect").click();
  await page.locator("#objective-cue").selectOption("paint");await page.locator("#apply-objective").click();await page.locator("#serial-connect").click();await page.locator("#real-sensors").filter({hasText:"80.0 cm"}).waitFor();await page.locator("#serial-arm").click();await page.waitForTimeout(600);assert.ok(await page.evaluate(()=>window.__learningSerial.commands.includes("ARM")));assert.ok(await page.evaluate(()=>window.__learningSerial.commands.some(c=>c.startsWith("M "))));await page.locator("#serial-stop").click();await page.locator("#serial-disconnect").click();
  await page.locator(".hardware-lab>summary").click();
  // A fully populated larger memory must be able to reload its own formatted export.
  lab=await download("save-lab");lab.learning.memorySettings.count=20000;lab.learning.sugarPolicy={format:"robot-sugar-policy",version:1,count:20000,weights:Array(60000).fill(0),updates:0};
  lab.memory={format:"robot-kenyon-memory",version:2,settings:lab.learning.memorySettings,counts:Array(20000).fill(3),means:Array.from({length:20000},()=>Array(10).fill(.7777777910232544)),prototypes:Array.from({length:20000},()=>Array(24).fill(.12345679104328156)),map:[]};
  assert.ok(Buffer.byteLength(JSON.stringify(lab,null,2))>12000000);await importLab(lab);const large=await download("save-lab");assert.equal(large.memory.counts.length,20000);assert.equal(large.memory.prototypes.filter(Boolean).length,20000);
  await page.locator("#demo-trail").click();await page.locator("#vision-layout").selectOption("circle5");await page.locator("#apply-vision").click();await page.locator("#learning-panel").scrollIntoViewIfNeeded();
  await mkdir(".cache",{recursive:true});await page.locator("#learning-panel").screenshot({path:".cache/robot-learning-desktop.png"});await page.screenshot({path:".cache/robot-learning-full.png",fullPage:true});
  await page.locator("#habitat").scrollIntoViewIfNeeded();await page.screenshot({path:".cache/robot-learning-overview.png"});
  await page.setViewportSize({width:390,height:844});await page.locator("#learning-panel").screenshot({path:".cache/robot-learning-mobile.png"});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  assert.deepEqual(errors,[]);console.log("Robot and item drag/rotation, undo/start pose, floor trail drawing, sugar learning and copyable rewards, brain/lab persistence, real distinct swarm crops, unchanged raw pixels, training reward scores, USB cue guard and motor mock, desktop/mobile layout verified. No physical hardware used.");
}finally{await browser.close();}
