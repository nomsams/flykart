import { SpikingNetwork, clamp } from "../core";
import { VisionModel } from "../vision/perception";
import { worldDomain } from "../vision/world/worldDomain";
import { sensorsFromEstimates } from "../vision/interface";
import { bridgeSketch, BridgeFrame, bridgeConfigId } from "./esp32-bridge";
import { Firmware } from "./firmware";
import { MotorAdapter, motorRequests } from "./controls";
import { RobotConfig, Wiring } from "./model";
import { RoomMemory, MemorySettings } from "./memory";
import { VisualSwarm, VisionSettings, visualFeatures } from "./vision-workbench";
import { ObjectiveSettings, SugarPolicy, cameraCue, EMPTY_CUE } from "./objectives";
import { copyText, decodeRgb565, flashEsp32, FlashImage, RobotSerial, serialApi, validateFlash } from "./serial";
import { CalibrationProfile, DEFAULT_CALIBRATION, DEFAULT_PID, HeadingPID, PIDSettings, StateEstimator, compensate, validatePID } from './state-estimator';

export type HardwareContext = { wiring: Wiring; config: RobotConfig; adapter: MotorAdapter; source: string; brain: SpikingNetwork | null; eyes: VisionModel | null; domain: "world" | "track"; memoryEnabled: boolean; mode: string; manual: [number,number]; memory: RoomMemory; memorySettings: MemorySettings; visionSettings: VisionSettings; objective: ObjectiveSettings; sugarPolicy: SugarPolicy; calibration?:CalibrationProfile; compensationEnabled?:boolean };
type HardwareHost = { context: ()=>HardwareContext; pause: ()=>void; download: (name:string,text:string,type?:string)=>void; message: (text:string,error?:boolean)=>void };

export class HardwarePanel {
  private serial: RobotSerial; private logs: string[]=[]; private flashing=false; private armed=false; private frameAt=-Infinity;
  private timer: ReturnType<typeof setInterval> | null=null; private neuralTimer: ReturnType<typeof setInterval> | null=null;
  private images: FlashImage[]=[]; private chipFrame: BridgeFrame | null=null; private means=[0,0,0];
  private brain: SpikingNetwork | null=null; private eyes: VisionModel | null=null; private firmware: Firmware | null=null; private started=0;
  private estimates=new Float32Array(10); private inputs:number[]=[]; private lastSteer=0; private lastDrive=0; private requests:[number,number]=[0,0];
  private tiny=document.createElement("canvas");
  private memory=new RoomMemory();
  private reportedConfig="";
  private swarm: VisualSwarm|null=null;
  private sugarPolicy=new SugarPolicy(4096);
  private cue={...EMPTY_CUE};
  private tracker:{heading:number;at:number}|null=null;
  private studentId='';private autonomous=false;
  private physicalState=new StateEstimator({x:0,z:0,heading:0});
  constructor(private host: HTMLElement, private app: HardwareHost) {
    host.innerHTML=`<details class="hardware-lab"><summary><span>ESP32-CAM · USB serial & firmware</span><small>Real sensor feed · tethered fly · compiled binary flashing</small></summary><div class="hardware-content"><div class="hardware-intro"><h3>From the habitat to the real robot</h3><p>Download the bridge sketch, compile it with Arduino-ESP32 3.x for AI Thinker ESP32-CAM, then flash the compiled binaries. The bridge captures the camera and sonar; your fly, eyes and editor logic execute here in the browser over USB. For onboard inference, train and export the compact student in the research workbench.</p><ol><li>Connect a USB-UART adapter: adapter RX ← ESP32 GPIO1 TX, adapter TX → GPIO3 RX, and shared GND. Use 3.3 V UART logic and a suitable regulated 5 V board supply.</li><li>For flashing, connect GPIO0 to GND and reset. Select the compiler's binary offsets. After flashing, remove that link and reset again.</li><li>Connect the monitor at 460800 baud. Verify sensors with wheels lifted before arming motors. Recompile and reflash after changing physical GPIO assignments.</li></ol></div><div class="row hardware-actions"><button id="export-bridge" class="primary">Download ESP32 bridge .ino</button><button id="copy-build">Copy compile command</button><button id="serial-connect">Connect USB serial</button><button id="serial-disconnect" disabled>Disconnect</button><label>Baud<select id="serial-baud"><option>460800</option><option>115200</option></select></label><span id="serial-support"></span></div><div class="hardware-live"><div><h4>Real camera · 160 × 120</h4><canvas id="real-camera" width="160" height="120"></canvas><label>Pixel order<select id="serial-byte-order"><option value="be">RGB565 · MSB first</option><option value="le">RGB565 · LSB first</option></select></label></div><div><h4>Actual fly input crop</h4><canvas id="real-fly" width="288" height="144"></canvas><p id="real-sensors">No real sensor frame received.</p><p id="real-neural">Fly disarmed · motors zero</p></div><div class="real-controls"><h4>USB controller · applied sketch</h4><label>Physical PWM cap<input id="serial-pwm-cap" type="number" min="0" max="255" value="80"></label><button id="serial-arm" disabled>Arm applied controller</button><button id="serial-stop" class="danger" disabled>■ STOP motors</button><p>The applied sketch uses the selected fly, sugar memory, manual or independent request mode. Visual filters and gaze votes run on real frames. Sugar steering uses frozen exported reward weights; the car has no physical taste or scent sensor. Firmware pin maps must match. Motor commands expire after 1.5 s. The browser stops after 2.5 s without a sensor frame, when this tab is hidden, or on disconnect. Serial camera transfer is slower than simulation; measure the real frame rate.</p></div></div><details class="flash-panel"><summary>Flash compiled firmware · classic ESP32 / 4 MB</summary><p>Compilation happens in Arduino IDE or arduino-cli. Export compiled binaries and use the offsets from its upload command. A merged image belongs at 0x0; an application-only .bin at 0x10000 needs compatible bootloader and partitions already installed.</p><div class="flash-fields">${["Bootloader","Partitions","Boot app / OTA data","Application / merged image"].map((name,i)=>`<label>${name}<input id="flash-file-${i}" type="file" accept=".bin"><input id="flash-offset-${i}" aria-label="${name} offset" value="${["0x1000","0x8000","0xe000","0x10000"][i]}"></label>`).join("")}</div><button id="review-flash">Review binaries</button><pre id="flash-review">Select compiled .bin files to review.</pre><button id="flash-device" disabled>Choose device & flash reviewed binaries</button><progress id="flash-progress" value="0" max="100"></progress><small>Writing firmware replaces those flash sectors. Full-chip erase is disabled. No device is selected or written until you click Flash.</small></details><div class="serial-console"><div class="row"><h3>Hardware serial log</h3><button id="copy-serial">Copy log</button><button id="save-serial">Save log</button><button id="clear-serial">Clear</button></div><pre id="serial-log" role="log"></pre></div></div></details>`;
    this.serial=new RobotSerial(t=>{if(t.startsWith('POSE ')){const parts=t.slice(5).split(' ').map(Number);if(parts.length===5&&parts.every(Number.isFinite)&&parts[3]>0&&parts[4]>0){const pose={x:parts[0],z:parts[1],heading:parts[2]};if(!this.tracker)this.physicalState=new StateEstimator(pose,this.app.context().calibration??DEFAULT_CALIBRATION);const accepted=this.physicalState.observe(pose,parts[3],parts[4],performance.now()/1000,"external tracker");if(accepted)this.tracker={heading:this.physicalState.pose.heading,at:performance.now()};this.log(`Measured pose ${accepted?"accepted":"rejected"} · estimated ${this.physicalState.pose.x.toFixed(3)} / ${this.physicalState.pose.z.toFixed(3)} · σ ${(Math.sqrt(this.physicalState.covariance[0])*100).toFixed(1)} cm`);}else this.log('Invalid external POSE observation');}if(t.startsWith('AUTOFRAME ')&&this.autonomous){this.element('real-neural').textContent='Onboard '+t;}if(t.startsWith('STUDENT '))this.studentId=t.slice(8).trim();if(t.startsWith("CONFIG ")){const id=t.slice(7);if(id!==this.reportedConfig){this.reportedConfig=id;this.log(`Firmware pin map: ${id}`);}return;}this.log(t);},f=>this.frame(f),()=>{this.stop();this.update();});
    this.on("export-bridge",()=>app.download("flykart_bridge.ino",bridgeSketch(app.context().wiring,app.context().config),"text/plain"));
    this.on("copy-build",async()=>{await copyText('arduino-cli compile --fqbn esp32:esp32:esp32cam --export-binaries flykart_bridge');app.message("Compile command copied. Save the sketch in flykart_bridge/flykart_bridge.ino first.");});
    this.on("serial-connect",async()=>{this.chipFrame=null;this.frameAt=-Infinity;this.reportedConfig="";this.studentId="";this.tracker=null;await this.serial.connect(Number(this.input("serial-baud")));this.update();});
    this.on("serial-disconnect",async()=>{this.stop();await this.serial.disconnect();this.update();});
    this.on("serial-arm",()=>this.arm()); this.on("serial-stop",()=>this.stop());
    this.on("copy-serial",async()=>{await copyText(this.logs.join("\n"));app.message("Hardware log copied.");});
    this.on("save-serial",()=>app.download("robot-hardware-log.txt",this.logs.join("\n"),"text/plain"));
    this.on("clear-serial",()=>{this.logs=[];this.drawLog();});
    this.on("review-flash",()=>this.review());this.on("flash-device",()=>this.flash());
    host.querySelectorAll(".flash-fields input").forEach(input=>input.addEventListener("change",()=>{this.images=[];this.element<HTMLButtonElement>("flash-device").disabled=true;this.element("flash-review").textContent="Files or offsets changed · review again.";}));
    document.addEventListener("visibilitychange",()=>{if(document.hidden) this.stop();});
    window.addEventListener("pagehide",()=>this.stop());
    this.element("serial-support").textContent=serialApi() ? "Web Serial available" : "Open in Chrome / Edge for Web Serial";this.update();
  }
  get busy(): boolean { return this.serial.connected || this.flashing; }
  async calibrationSegment(pwm:[number,number],seconds:number,cancel:()=>boolean,pidEnabled=false,settings:PIDSettings=DEFAULT_PID):Promise<void> {
    const c=this.app.context();bridgeSketch(c.wiring,c.config);
    if(!this.serial.connected||this.reportedConfig!==bridgeConfigId(c.wiring,c.config)||!this.chipFrame||performance.now()-this.frameAt>2500)throw new Error('Connect a fresh USB bridge with this pin map before running a floor segment.');
    if(pwm.some(v=>!Number.isFinite(v)||Math.abs(v)>120/255)||!Number.isFinite(seconds)||seconds<=0||seconds>30)throw new Error('Physical calibration limit: PWM 120, segment 30 seconds.');
    this.stop();this.app.pause();const tune=validatePID(settings),pid=new HeadingPID(tune.kp,tune.ki,tune.kd,tune.limit),target=this.tracker&&performance.now()-this.tracker.at<500?this.tracker.heading:null,started=performance.now();await this.serial.send('ARM');this.armed=true;this.update();
    this.log(`Floor segment started · ${seconds.toFixed(2)}s · ${pwm.map(v=>Math.round(v*255)).join('/')} · PID ${pidEnabled&&target!==null?'external tracker':'off / no feedback'}`);
    try {while(performance.now()-started<seconds*1000){if(cancel()||!this.armed||!this.serial.connected||document.hidden)throw new Error('Calibration segment stopped.');if(performance.now()-this.frameAt>2500)throw new Error('Sensor timeout during floor calibration.');const correction=pidEnabled&&target!==null&&this.tracker&&Math.abs(pwm[0]-pwm[1])<.01?pid.step(target,this.tracker.heading,.1,(performance.now()-this.tracker.at)/1000):0;const issued:[number,number]=[clamp(pwm[0]+correction,-120/255,120/255),clamp(pwm[1]-correction,-120/255,120/255)];this.physicalState.profile=c.calibration??DEFAULT_CALIBRATION;this.physicalState.predict(issued,c.config,.1);await this.serial.send(`M ${Math.round(issued[0]*255)} ${Math.round(issued[1]*255)}`);await new Promise(resolve=>setTimeout(resolve,100));}}finally{this.stop();this.log('Floor segment stopped · measure endpoint before continuing');}
  }
  async startStudent(hash:string,cap:number,seconds:number):Promise<void> {const c=this.app.context();bridgeSketch(c.wiring,c.config);if(!this.serial.connected||this.studentId!==hash||this.reportedConfig!==bridgeConfigId(c.wiring,c.config)||!this.chipFrame?.rgb565.length||performance.now()-this.frameAt>2500)throw new Error('Connect fresh compiled student firmware whose checksum and pin map match this export.');if(!Number.isInteger(cap)||cap<1||cap>120||!Number.isInteger(seconds)||seconds<1||seconds>60)throw new Error('Onboard run limits: PWM 1–120, duration 1–60 seconds.');this.stop();this.app.pause();await this.serial.send(`AUTO ${cap} ${seconds}`);this.armed=true;this.autonomous=true;this.frameAt=performance.now();this.update();this.log(`Onboard student ${hash} explicitly armed for ${seconds}s · cap ${cap}; firmware enforces deadline and sensor guards`);this.timer=setInterval(()=>{if(performance.now()-this.frameAt>(seconds+2)*1000){this.stop();}},500);}
  private element<T extends HTMLElement=HTMLElement>(id:string):T {return this.host.querySelector<T>(`#${id}`)!;}
  private input(id:string):string {return this.element<HTMLInputElement>(id).value;}
  private on(id:string,fn:()=>unknown):void {this.element(id).addEventListener("click",()=>{Promise.resolve().then(fn).catch(e=>{this.log(String(e));this.app.message(e instanceof Error?e.message:String(e),true);});});}
  private log(text:string):void {this.logs.push(`${new Date().toISOString()}  ${text}`);if(this.logs.length>500)this.logs.shift();this.drawLog();}
  private drawLog():void {const el=this.element("serial-log");el.textContent=this.logs.join("\n");el.scrollTop=el.scrollHeight;}
  private update():void {this.element<HTMLButtonElement>("serial-connect").disabled=this.busy;this.element<HTMLButtonElement>("serial-disconnect").disabled=!this.serial.connected;this.element<HTMLButtonElement>("serial-arm").disabled=!this.serial.connected||!this.chipFrame||this.armed;this.element<HTMLButtonElement>("serial-stop").disabled=!this.serial.connected;this.element<HTMLButtonElement>("flash-device").disabled=this.busy||!this.images.length;}
  private async arm():Promise<void> {
    const c=this.app.context();bridgeSketch(c.wiring,c.config);
    if(["fly","reward"].includes(c.mode)&&(!c.brain||!c.eyes))throw new Error("Load a fly controller and matching eyes first.");
    if(c.objective.mode==="trail"&&c.objective.cue==="scent")throw new Error("Virtual pheromone antennae are simulation-only. Select a camera-painted trail before arming the real robot.");
    if(c.mode==="reward"&&c.domain!=="world")throw new Error("Sugar memory steering requires a world-domain fly.");
    if(this.reportedConfig!==bridgeConfigId(c.wiring,c.config))throw new Error("The connected firmware's pin map or sensors differ from this lab. Recompile and flash the current bridge before arming.");
    if(!this.chipFrame||performance.now()-this.frameAt>2500)throw new Error("A fresh bridge sensor frame is required before arming.");
    if(["fly","reward"].includes(c.mode)&&c.config.cameraEnabled&&!this.chipFrame.rgb565.length)throw new Error("Configured camera has no real pixels. Fix the camera or disable it before arming.");
    this.app.pause();this.brain=c.brain?.clone()??null;this.eyes=c.eyes;this.firmware=new Firmware(c.source);this.estimates=new Float32Array(this.eyes?.targetScale.length??(c.domain==="world"?10:13));this.inputs=new Array(this.brain?.inputCount??19).fill(0);this.requests=[0,0];this.lastDrive=this.lastSteer=0;this.started=performance.now();
    this.memory=c.memory.fresh();this.sugarPolicy=SugarPolicy.fromJSON(c.sugarPolicy.toJSON(),c.memorySettings.count);this.swarm=c.eyes?new VisualSwarm(c.eyes,c.visionSettings):null;this.cue={...EMPTY_CUE};
    await this.serial.send("ARM");this.armed=true;this.processFrame(this.chipFrame);
    this.neuralTimer=setInterval(()=>this.tick(),1000/30);
    this.timer=setInterval(()=>{if(performance.now()-this.frameAt>2500){this.log("Sensor timeout · stopping motors");this.stop();return;}const cap=clamp(Number(this.input("serial-pwm-cap"))||0,0,255);void this.serial.send(`M ${Math.round(clamp(this.requests[0],-cap,cap))} ${Math.round(clamp(this.requests[1],-cap,cap))}`).catch(()=>this.stop());},100);
    this.log(`USB controller armed · ${c.mode} requests / applied editor logic · verified firmware pin map · PWM cap applied`);this.update();
  }
  stop():void {
    if(this.timer!==null)clearInterval(this.timer);if(this.neuralTimer!==null)clearInterval(this.neuralTimer);this.timer=this.neuralTimer=null;
    const wasArmed=this.armed;this.armed=false;this.autonomous=false;this.requests=[0,0];if(this.serial?.connected)void this.serial.send("STOP").catch(()=>{});
    if(wasArmed)this.log("Motors disarmed");this.element("real-neural").textContent="Fly disarmed · motors zero";this.update();
  }
  private frame(frame:BridgeFrame):void {if(this.autonomous&&!frame.armed)this.stop();this.chipFrame=frame;this.frameAt=performance.now();this.processFrame(frame);this.log(`Frame ${frame.id} · ${frame.width}×${frame.height} · sonar ${frame.cm===null?"unknown":`${frame.cm} cm`} · device ${frame.armed?"armed":"disarmed"}`);this.update();}
  private processFrame(frame:BridgeFrame):void {
    const raw=this.element<HTMLCanvasElement>("real-camera"),ctx=raw.getContext("2d")!,rgba=frame.rgb565.length?decodeRgb565(frame.rgb565,this.input("serial-byte-order")==="le"):new Uint8ClampedArray(160*120*4);
    for(let i=3;i<rgba.length;i+=4)rgba[i]=255;const image=ctx.createImageData(160,120);image.data.set(rgba);ctx.putImageData(image,0,0);this.means=[0,0,0];for(let i=0;i<rgba.length;i+=4)for(let k=0;k<3;k++)this.means[k]+=rgba[i+k]/(160*120);
    const model=this.eyes??this.app.context().eyes,w=model?.spec.width??48,h=model?.spec.height??24;this.tiny.width=w;this.tiny.height=h;
    const crop=this.tiny.getContext("2d")!,sw=Math.min(160,120*w/h),sh=Math.min(120,160*h/w);crop.drawImage(raw,(160-sw)/2,(120-sh)/2,sw,sh,0,0,w,h);
    const fly=this.element<HTMLCanvasElement>("real-fly"),fc=fly.getContext("2d")!;fc.imageSmoothingEnabled=false;fc.drawImage(this.tiny,0,0,fly.width,fly.height);
    if(this.armed&&this.swarm){const data=crop.getImageData(0,0,w,h).data,n=w*h,planar=new Float32Array(n*3),c=this.app.context();for(let i=0;i<n;i++)for(let k=0;k<3;k++)planar[k*n+i]=data[i*4+k]/255;
      if(frame.rgb565.length){this.estimates.set(this.swarm.see(planar,this.body(),c.domain));const processed=this.swarm.processed;this.cue=cameraCue(processed,w,h,c.objective.mode);const pixels=crop.createImageData(w,h);for(let i=0;i<n;i++){for(let k=0;k<3;k++)pixels.data[i*4+k]=processed[k*n+i]*255;pixels.data[i*4+3]=255;}crop.putImageData(pixels,0,0);fc.drawImage(this.tiny,0,0,fly.width,fly.height);
        if(c.domain==="world"){const recalled=this.memory.observe(visualFeatures(processed,w,h),this.estimates,c.memoryEnabled);if(c.memoryEnabled&&recalled)for(let i=0;i<this.estimates.length;i++)this.estimates[i]=this.estimates[i]*.8+recalled[i]*.2;}
      }else{this.estimates.fill(0);this.cue={...EMPTY_CUE};}
    }
    this.element("real-sensors").textContent=`Real sonar: ${frame.cm===null?"no echo":`${frame.cm.toFixed(1)} cm`} · frame ${frame.id} · mean RGB ${this.means.map(Math.round).join(" / ")}`;
  }
  private body() {const c=this.app.context().config,max=c.rpm/60*Math.PI*c.wheelDiameter*clamp((c.voltage-c.bridgeDrop)/6,0,1.2),cap=clamp(Number(this.input("serial-pwm-cap"))||0,0,255);return {speed:(clamp(this.requests[0],-cap,cap)+clamp(this.requests[1],-cap,cap))/510*max/.99,lastSteer:this.lastSteer,lastDrive:this.lastDrive,sonarCloseness:this.chipFrame?.cm===null||!this.chipFrame?0:clamp(1-this.chipFrame.cm/220,0,1),sonarStrength:+(this.chipFrame?.cm!==null&&!!this.chipFrame)};}
  private tick():void {
    if(!this.armed||!this.firmware)return;
    try {const c=this.app.context(),b=this.body(),mission:[number,number]=[this.cue.bearing,this.cue.strength];if(c.domain==="world"){this.estimates[4]=Math.max(this.estimates[4],b.sonarCloseness);worldDomain.sensors(this.estimates,mission,b,this.inputs);}else sensorsFromEstimates(this.estimates,b,this.inputs);if(this.inputs.length>17){this.inputs[17]=b.sonarCloseness;this.inputs[18]=b.sonarStrength;}
      let action=this.brain?(this.swarm?.step(this.brain,this.inputs,b,mission,c.domain)??this.brain.step(this.inputs)):{steer:0,throttle:0,brake:0,reverse:0};if(c.mode==="reward")action=this.sugarPolicy.action(this.memory.active,action,this.cue,b.sonarCloseness,false);const request=motorRequests(action,c.adapter);this.lastSteer=action.steer;this.lastDrive=action.throttle-(action.reverse??0);
      const demand=c.mode==="manual"?c.manual:["fly","reward"].includes(c.mode)?[request.left,request.right]:[0,0];
      this.firmware.tick({timeMs:performance.now()-this.started,brainLeft:demand[0],brainRight:demand[1],echoUs:this.chipFrame?.cm===null||!this.chipFrame?0:this.chipFrame.cm*58,wiring:c.wiring,camera:{frame:this.chipFrame?.id??0,rgb:this.means},log:t=>this.log(`Sketch: ${t}`)});
      const pwm=this.firmware.motors(c.wiring);this.requests=(c.compensationEnabled?compensate(pwm,c.calibration??DEFAULT_CALIBRATION):pwm).map(n=>n*255) as [number,number];this.element("real-neural").textContent=`Fly steer ${action.steer.toFixed(2)} · drive ${action.throttle.toFixed(2)} · brake ${action.brake.toFixed(2)} · reverse ${(action.reverse??0).toFixed(2)} · motor request ${this.requests.map(Math.round).join(" / ")}`;
    } catch(e){this.log(`Controller error: ${String(e)}`);this.stop();}
  }
  private async review():Promise<void> {
    if(this.busy)throw new Error("Disconnect serial before reviewing a flash operation.");
    this.images=[];this.update();const rows:string[]=[],images:FlashImage[]=[];
    for(let i=0;i<4;i++){const f=this.element<HTMLInputElement>(`flash-file-${i}`).files?.[0];if(!f)continue;if(f.size>4*1024*1024)throw new Error("Binary exceeds the 4 MB board profile.");const data=new Uint8Array(await f.arrayBuffer()),address=Number(this.input(`flash-offset-${i}`));images.push({name:f.name,address,data});const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data))).map(v=>v.toString(16).padStart(2,"0")).join("");rows.push(`${f.name} · 0x${address.toString(16)} · ${data.length} bytes\nSHA-256 ${hash}`);}
    this.images=validateFlash(images);this.element("flash-review").textContent=rows.join("\n\n")+"\n\nReview these addresses against the compiler's upload command before Flash.";this.update();
  }
  private async flash():Promise<void> {if(this.busy)throw new Error("Disconnect the serial monitor first.");this.flashing=true;this.update();try{await flashEsp32(this.images,t=>this.log(t),p=>this.element<HTMLProgressElement>("flash-progress").value=p);}finally{this.flashing=false;this.update();}}
}
