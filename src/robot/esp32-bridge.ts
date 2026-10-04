import { validateVibration } from "./vibration";
import {validateGuard} from './collision-guard';
import { RobotConfig, Wiring, wiringIssues } from "./model";
export const bridgeConfigId=(w:Wiring,c:RobotConfig)=>`ESP32CAM:v1:${[w.in1,w.in2,w.in3,w.in4,w.ena,w.enb,w.trig,w.echo].join(",")}:${+c.cameraEnabled}:${+c.sonarEnabled}${c.vibration?.enabled?`:SW420:${w.vibration??-1}:${+c.vibration.activeLow}:${c.vibration.debounceMs}:${c.vibration.holdMs}`:""}${c.guard?.enabled?`:GUARD:${c.guard.margin}:${c.guard.reaction}:${c.guard.deceleration}:${c.guard.stale}:${c.guard.unknown}:${c.guard.crawl}:${c.rpm}:${c.wheelDiameter}:${c.voltage}:${c.bridgeDrop}`:''}`;

export function bridgeSketch(w: Wiring, c: RobotConfig): string {
  if (w.board !== "esp32-cam") throw new Error("The USB bridge targets the AI-Thinker ESP32-CAM.");
  const v=validateVibration(c.vibration), g=validateGuard(c.guard), pin=w.vibration??-1;
  const errors = wiringIssues(w).errors;
  if(v.enabled&&pin<0)errors.push("Connect SW-420 DO to an available input before hardware export.");
  if(v.enabled&&pin===33&&!v.gpio33Access)errors.push("GPIO33 requires explicit confirmation of the modified LED solder pad and isolated LED.");
  if ([w.in1,w.in2,w.in3,w.in4,w.ena,w.enb,w.trig,w.echo,w.vibration??-1].some(p=>p===1||p===3)) errors.push("GPIO1/3 must remain free for the USB serial UART.");
  if (errors.length) throw new Error(errors.join(" "));
  return `// FlyKart AI-Thinker ESP32-CAM / L298N USB bridge
// Arduino-ESP32 3.x. Compile for AI Thinker ESP32-CAM with PSRAM enabled.
// Brain and eyes run in the browser; this firmware captures sensors and drives GPIO.
// USB-UART uses GPIO1 TX / GPIO3 RX; 5 V supply, 3.3 V UART logic, shared GND.
// Motors boot disarmed. ARM is explicit; command watchdog = 1500 ms.
// Keep wheels lifted for initial verification. No WiFi / SD / onboard flash LED.
#include <Arduino.h>
#include <initializer_list>
#include "esp_camera.h"
// Declare this type before Arduino inserts its generated function prototypes.
struct RangeSample {float cm;uint32_t at;uint32_t count;};
RangeSample rangeSample();

const int IN1=${w.in1}, IN2=${w.in2}, IN3=${w.in3}, IN4=${w.in4};
const int ENA=${w.ena}, ENB=${w.enb}, TRIG=${w.trig}, ECHO=${w.echo};
const int VIBRATION=${v.enabled?pin:-1};
const bool VIB_ACTIVE_LOW=${v.activeLow?"true":"false"};
volatile uint32_t vibrationAt=0, vibrationCount=0;
void IRAM_ATTR vibrationEdge() {
  int level=digitalRead(VIBRATION);uint32_t now=micros();
  if((VIB_ACTIVE_LOW?level==LOW:level==HIGH) && (vibrationCount==0 || uint32_t(now-vibrationAt)>=${Math.round(v.debounceMs*1000)}U)) {vibrationAt=now;vibrationCount++;}
}
bool vibrationActive() {return VIBRATION>=0 && vibrationCount>0 && uint32_t(micros()-vibrationAt)<${Math.round(v.holdMs*1000)}U;}
bool vibrationValid() {return VIBRATION>=0;}
uint32_t vibrationSent=0;
void emitVibration() {if(VIBRATION>=0){uint32_t count=vibrationCount;Serial.printf("VIB %lu %d %lu %d\\n",millis(),digitalRead(VIBRATION),count,(vibrationActive()||count!=vibrationSent)?1:0);vibrationSent=count;}}
const char BRIDGE_CONFIG[]="${bridgeConfigId(w,c)}";
volatile bool armed=false; bool cameraOK=false, emitting=false;
volatile int demandL=0, demandR=0, issuedL=0, issuedR=0; volatile uint32_t commandAt=0;
uint32_t frameAt=0, sonarAt=0, frameId=0;
float sonarCm=-1; uint32_t sonarSampleAt=0, sonarCount=0; String command;
portMUX_TYPE sonarMux=portMUX_INITIALIZER_UNLOCKED;
RangeSample rangeSample(){portENTER_CRITICAL(&sonarMux);RangeSample s={sonarCm,sonarSampleAt,sonarCount};portEXIT_CRITICAL(&sonarMux);return s;}
const bool GUARD_ENABLED=${g.enabled?'true':'false'};
const float MAX_SPEED=${(c.rpm/60*Math.PI*c.wheelDiameter*Math.max(0,(c.voltage-c.bridgeDrop)/6)).toFixed(6)}f;
const char B64[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

void motor(int a,int b,int en,int pwm) {
  pwm=constrain(pwm,-255,255);
  // Disable old direction before switching, then enable the new one.
  if(en>=0) { analogWrite(en,0); digitalWrite(a,pwm>0); digitalWrite(b,pwm<0); analogWrite(en,abs(pwm)); }
  else if(pwm>=0) { analogWrite(b,0); analogWrite(a,pwm); }
  else { analogWrite(a,0); analogWrite(b,-pwm); }
}
void stopMotors() { demandL=demandR=0; }
void applyMotors() {
  if(!armed || millis()-commandAt>1500) { armed=false; stopMotors(); issuedL=issuedR=0; motor(IN1,IN2,ENA,0); motor(IN3,IN4,ENB,0); return; }
  int left=demandL,right=demandR;float forward=max(0.0f,(left+right)/510.0f),factor=1;
  if(GUARD_ENABLED&&forward>0){RangeSample s=rangeSample();float speed=forward*MAX_SPEED,stop=${g.margin.toFixed(6)}f+speed*${g.reaction.toFixed(6)}f+speed*speed/(2*${g.deceleration.toFixed(6)}f);
    if(!s.count||uint32_t(millis()-s.at)>${Math.round(g.stale*1000)}U)factor=0;
    else if(s.cm<0)factor=${g.unknown==='stop'?'0':`min(1.0f,${g.crawl.toFixed(6)}f/forward)`};
    else if(s.cm/100<=stop)factor=0;else if(s.cm/100<stop*2)factor=constrain((s.cm/100-stop)/stop,.1f,1.0f);
  }
  issuedL=int(left*factor);issuedR=int(right*factor);motor(IN1,IN2,ENA,issuedL);motor(IN3,IN4,ENB,issuedR);
}
// Independent motor task keeps the watchdog alive during camera/UART blocking.
void motorTask(void*) { for(;;) { applyMotors(); vTaskDelay(pdMS_TO_TICKS(10)); } }
void pollCommands() {
  while(Serial.available()) {
    char ch=Serial.read();
    if(ch=='\\n') {
      command.trim(); int left=0,right=0;
      if(command=="ARM") { stopMotors(); commandAt=millis(); armed=true; if(!emitting) Serial.println("LOG armed"); }
      else if(command=="STOP") { armed=false; stopMotors(); if(!emitting) Serial.println("LOG disarmed"); }
      else if(sscanf(command.c_str(),"M %d %d",&left,&right)==2 && armed) { demandL=constrain(left,-255,255); demandR=constrain(right,-255,255); commandAt=millis(); }
      command="";
    } else if(ch!='\\r') { if(command.length()<63) command+=ch; else { command=""; armed=false; stopMotors(); } }
  }
}
void sampleSonar() {
  if(millis()-sonarAt<67) return; sonarAt=millis();
  ${c.sonarEnabled ? "digitalWrite(TRIG,LOW); delayMicroseconds(2); digitalWrite(TRIG,HIGH); delayMicroseconds(10); digitalWrite(TRIG,LOW); unsigned long pulse=pulseIn(ECHO,HIGH,25000); float cm=pulse>=116 && pulse<=23200 ? pulse/58.0f : -1;" : "float cm=-1;"}
  portENTER_CRITICAL(&sonarMux);sonarCm=cm;sonarSampleAt=millis();sonarCount++;portEXIT_CRITICAL(&sonarMux);
}
// Acquisition stays independent of the long RGB565 UART transmission.
void sensorTask(void*){for(;;){sampleSonar();vTaskDelay(pdMS_TO_TICKS(2));}}
void emitRange(){RangeSample s=rangeSample();Serial.printf("RANGE %lu %.2f %lu\\n",s.at,s.cm,s.count);}
void emitFrame() {
  camera_fb_t *fb=cameraOK ? esp_camera_fb_get() : nullptr;
  uint32_t captured=millis();RangeSample range=rangeSample();
  if(fb && (fb->format!=PIXFORMAT_RGB565 || fb->width!=160 || fb->height!=120 || fb->len!=38400)) { esp_camera_fb_return(fb); fb=nullptr; Serial.println("LOG unexpected camera format"); }
  emitVibration();
  Serial.printf("CONFIG %s\\n",BRIDGE_CONFIG); emitting=true;
  Serial.printf("TIMING %lu %lu %lu %lu\\n",frameId+1,captured,range.at,millis());
  Serial.printf("FRAME %lu %.2f %d %d %d %d %d %d ",++frameId,range.cm,armed?1:0,issuedL,issuedR,fb?160:0,fb?120:0,fb?int(fb->len):0);
  if(fb) {
    // Chunked encoding keeps commands and watchdog responsive during slow UART output.
    char out[257]; int n=0;
    for(size_t i=0;i<fb->len;i+=3) {
      uint32_t v=uint32_t(fb->buf[i])<<16; int count=min(size_t(3),fb->len-i);
      if(count>1) v|=uint32_t(fb->buf[i+1])<<8; if(count>2) v|=fb->buf[i+2];
      out[n++]=B64[(v>>18)&63]; out[n++]=B64[(v>>12)&63]; out[n++]=count>1?B64[(v>>6)&63]:'='; out[n++]=count>2?B64[v&63]:'=';
      if(n==256) { Serial.write(reinterpret_cast<uint8_t*>(out),n); n=0; pollCommands(); yield(); }
    }
    if(n) Serial.write(reinterpret_cast<uint8_t*>(out),n);
    esp_camera_fb_return(fb);
  }
  Serial.println(); emitting=false;emitRange();
}
void setup() {
  Serial.begin(460800); Serial.setTimeout(30); command.reserve(64);
  for(int p : {IN1,IN2,IN3,IN4,ENA,ENB}) if(p>=0) pinMode(p,OUTPUT);
  pinMode(TRIG,OUTPUT); pinMode(ECHO,INPUT);
  if(VIBRATION>=0){pinMode(VIBRATION,INPUT);attachInterrupt(digitalPinToInterrupt(VIBRATION),vibrationEdge,CHANGE);}
  for(int p : {IN1,IN2,IN3,IN4,ENA,ENB}) if(p>=0) digitalWrite(p,LOW);
  // Camera XCLK owns LEDC timer 0 / channel 0. Motor PWM is allocated elsewhere.
  if(ENA<0) { ledcAttachChannel(IN1,1000,8,2); ledcAttachChannel(IN2,1000,8,3); }
  if(ENB<0) { ledcAttachChannel(IN3,1000,8,4); ledcAttachChannel(IN4,1000,8,5); }
  if(ENA>=0) ledcAttachChannel(ENA,1000,8,2); if(ENB>=0) ledcAttachChannel(ENB,1000,8,4);
  applyMotors();
  if(xTaskCreatePinnedToCore(motorTask,"motor_watchdog",2048,nullptr,2,nullptr,1)!=pdPASS) { Serial.println("LOG motor task failed"); while(true) delay(1000); }
  if(xTaskCreatePinnedToCore(sensorTask,"sonar_sampling",2048,nullptr,1,nullptr,0)!=pdPASS){Serial.println("LOG sensor task failed");while(true)delay(1000);}
  ${c.cameraEnabled ? `camera_config_t cam={}; cam.ledc_channel=LEDC_CHANNEL_0; cam.ledc_timer=LEDC_TIMER_0;
  cam.pin_d0=5; cam.pin_d1=18; cam.pin_d2=19; cam.pin_d3=21; cam.pin_d4=36; cam.pin_d5=39; cam.pin_d6=34; cam.pin_d7=35;
  cam.pin_xclk=0; cam.pin_pclk=22; cam.pin_vsync=25; cam.pin_href=23; cam.pin_sccb_sda=26; cam.pin_sccb_scl=27; cam.pin_pwdn=32; cam.pin_reset=-1;
  cam.xclk_freq_hz=20000000; cam.pixel_format=PIXFORMAT_RGB565; cam.frame_size=FRAMESIZE_QQVGA; cam.fb_count=1;
  cam.fb_location=CAMERA_FB_IN_PSRAM; cam.grab_mode=CAMERA_GRAB_WHEN_EMPTY;
  cameraOK=esp_camera_init(&cam)==ESP_OK;` : "cameraOK=false;"}
  Serial.printf("LOG FlyKart bridge ready; camera=%d; disarmed\\n",cameraOK?1:0);
}
void loop() { pollCommands(); if(millis()-frameAt>=250) { frameAt=millis(); emitFrame(); } delay(2); }
`;
}

export type BridgeFrame = { id: number; cm: number | null; armed: boolean; left: number; right: number; width: number; height: number; rgb565: Uint8Array };
export function parseBridgeFrame(line: string): BridgeFrame | null {
  if (!line.startsWith("FRAME ")) return null;
  const match = /^FRAME (\d+) (-?\d+(?:\.\d+)?) ([01]) (-?\d+) (-?\d+) (\d+) (\d+) (\d+) ([A-Za-z0-9+/=]*)$/.exec(line.trimEnd());
  // A camera-disabled line ends in a single separating space.
  const fallback = /^FRAME (\d+) (-?\d+(?:\.\d+)?) ([01]) (-?\d+) (-?\d+) 0 0 0$/.exec(line.trim());
  if (!match && !fallback) throw new Error("Malformed bridge frame.");
  const m = match ?? [...fallback!, "0", "0", "0", ""];
  const width = Number(m[6]), height = Number(m[7]), length = Number(m[8]);
  if (!((width === 160 && height === 120 && length === 38400) || (width === 0 && height === 0 && length === 0))) throw new Error("Unexpected bridge frame dimensions.");
  const binary = atob(m[9]); if (binary.length !== length) throw new Error("Bridge camera payload length differs from header.");
  const cm = Number(m[2]); if (cm > 400 || Math.abs(Number(m[4])) > 255 || Math.abs(Number(m[5])) > 255) throw new Error("Bridge telemetry exceeds range.");
  return { id: Number(m[1]), cm: cm < 0 ? null : cm, armed: m[3] === "1", left: Number(m[4]), right: Number(m[5]), width, height, rgb565: Uint8Array.from(binary, ch=>ch.charCodeAt(0)) };
}
