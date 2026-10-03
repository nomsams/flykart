import { describe, expect, it } from "vitest";
import { SpikingNetwork } from "../core";
import { DEFAULT_ROBOT, ESP_WIRING } from "./model";
import { programSketch } from "./controls";
import { reconnect, rewritePins } from "./rewiring";
import { Firmware } from "./firmware";
import { bridgeSketch, parseBridgeFrame } from "./esp32-bridge";
import { decodeRgb565, validateFlash } from "./serial";
import { EpisodeRecorder, EpisodeStep, TrainingRun } from "./training";
import { SensorConsole } from "./telemetry";

describe("editable GPIO patchboard",()=>{
  it("swaps occupied GPIOs and synchronizes live pin declarations while preserving code and comments",()=>{
    const w=reconnect(ESP_WIRING,"in1",13);expect(w.in1).toBe(13);expect(w.in2).toBe(12);
    const source=programSketch("sequence",ESP_WIRING)+'\n// const int IN1 = 99;\n';
    const rewritten=rewritePins(source,w);expect(rewritten.source).toContain("const int IN1 = 13;");expect(rewritten.source).toContain("// const int IN1 = 99;");expect(rewritten.source).toContain("left = 120; right = 120;");
    const fw=new Firmware(rewritten.source);for(let t=0;t<600;t+=33)fw.tick({timeMs:t,brainLeft:0,brainRight:0,echoUs:0,wiring:w});expect(fw.motors(w)[0]).toBeGreaterThan(.4);
    expect(ESP_WIRING.in1).toBe(12);
  });
  it("rejects reserved pins, ambiguous custom declarations and unsafe enable swaps",()=>{
    expect(()=>reconnect(ESP_WIRING,"echo",0)).toThrow(/available GPIO/);
    expect(()=>reconnect(ESP_WIRING,"ena",12)).toThrow(/needs a GPIO/);
    expect(()=>rewritePins(programSketch("fly",ESP_WIRING)+"\nconst int IN1 = 7;",ESP_WIRING)).toThrow(/exactly one/);
    expect(()=>rewritePins("void setup(){} void loop(){}",ESP_WIRING)).toThrow(/IN1/);
  });
});

const step=(x:number,blocked=false):EpisodeStep=>({time:0,inputs:Array(19).fill(.2),action:{steer:0,throttle:.5,brake:0},pwm:[100,100],cameraFrame:1,sonar:{cm:null,echo:false},evaluation:{pose:{x,z:0,heading:0},blocked,contact:blocked?"wall":null,surface:null}});
describe("3D controller training",()=>{
  it("scores exploration above stationary spinning and penalizes sustained blocking",()=>{
    const spin=new EpisodeRecorder(),move=new EpisodeRecorder(),blocked=new EpisodeRecorder();
    for(let i=0;i<30;i++){spin.step({...step(0),evaluation:{...step(0).evaluation,pose:{x:0,z:0,heading:i}}},1/30);move.step(step(i*.03),1/30);blocked.step(step(0,true),1/30);}
    expect(move.finish(1,0,1).summary.score).toBeGreaterThan(spin.finish(1,0,1).summary.score);expect(blocked.finish(1,0,1).summary.score).toBeLessThan(0);expect(blocked.contacts).toBe(1);
    expect(move.steps[0].inputs).not.toContain(move.steps[0].evaluation.pose);
  });
  it("records delivered pixel bytes, sensor decisions and explicitly separate evaluation labels",()=>{
    const r=new EpisodeRecorder();r.frame(1,1,1,new Float32Array([1,.5,0]),false);const s=step(0);r.step(s,1/30);s.inputs[0]=99;
    const exported=r.finish(1,0,1);expect([...atob(exported.frames[0].pixels)].map(c=>c.charCodeAt(0))).toEqual([255,128,0]);expect(exported.steps[0].inputs[0]).toBe(.2);expect(exported.steps[0].evaluation.blocked).toBe(false);
  });
  it("repeats candidate mutations and trial noise seeds exactly and retains an unchanged elite when it wins",()=>{
    const parent=new SpikingNetwork(123,19),options={evolve:true,seconds:5,episodes:1,population:2,generations:2,seed:5,rate:.2,amount:.1},a=new TrainingRun(parent,options),b=new TrainingRun(parent,options);
    for(const job of [a,b]){job.recorder.step(step(0),.1);job.recorder.step(step(1),.1);expect(job.advance()).toBe(true);}
    expect(a.brain.toJSON()).toEqual(b.brain.toJSON());expect(a.brain.toJSON()).not.toEqual(parent.toJSON());expect(a.noiseSeed).toBe(b.noiseSeed);
    a.recorder.step(step(0,true),.1);expect(a.advance()).toBe(true);expect(a.best).toEqual(parent.toJSON());
    expect(a.datasets.length).toBe(2);expect(a.results.length).toBe(2);expect(()=>new TrainingRun(parent,{...options,seconds:0})).toThrow(/outside/);
  });
});

describe("serial bridge and flash review",()=>{
  it("decodes RGB565 correctly and rejects malformed payloads",()=>{
    expect([...decodeRgb565(new Uint8Array([0xf8,0,0x07,0xe0,0,0x1f]))]).toEqual([255,0,0,255,0,255,0,255,0,0,255,255]);
    expect([...decodeRgb565(new Uint8Array([0,0xf8]),true)]).toEqual([255,0,0,255]);
    expect(parseBridgeFrame("FRAME 1 -1.00 0 0 0 0 0 0 ")?.cm).toBeNull();
    expect(()=>parseBridgeFrame("FRAME 1 50 0 0 0 160 120 38400 AAAA")).toThrow(/payload length/);expect(()=>decodeRgb565(new Uint8Array([1]))).toThrow(/paired/);
  });
  it("rejects overlapping erase sectors, invalid offsets and oversized binaries",()=>{
    const a={name:"app.bin",address:0x10000,data:new Uint8Array(100)};expect(validateFlash([a])).toEqual([a]);
    expect(()=>validateFlash([a,{...a,address:0x10000}])).toThrow(/overlap/);expect(()=>validateFlash([{...a,address:1}])).toThrow(/aligned/);expect(()=>validateFlash([{...a,address:4*1024*1024}])).toThrow(/4 MB/);
  });
  it("exports real sensor firmware with boot-disarm, timer separation and independent watchdog",()=>{
    const source=bridgeSketch(ESP_WIRING,DEFAULT_ROBOT);expect(source).toContain("FRAMESIZE_QQVGA");expect(source).toContain("GPIO1 TX / GPIO3 RX");expect(source).toContain("xTaskCreatePinnedToCore(motorTask");expect(source).toContain("millis()-commandAt>1500");expect(source).toContain("ledcAttachChannel(IN1,1000,8,2)");
    expect(()=>bridgeSketch({...ESP_WIRING,in1:1},DEFAULT_ROBOT)).toThrow(/GPIO1\/3/);
  });
  it("copies a stable tab-separated console filtered to the requested kind",()=>{const log=new SensorConsole();log.push(1,"sonar","20 cm");log.push(2,"brain","turn left");expect(log.text("sonar")).toBe("1.000s\tSONAR\t20 cm");});
});
