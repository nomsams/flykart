import { COMPACT_CAMERA, COMPACT_RECIPE } from './sensor-contract';
import { bridgeSketch } from './esp32-bridge';
import { CompactStudent, validateStudent } from './compact';
import type { RobotConfig, Wiring } from './model';
export function compactSketch(raw:CompactStudent,w:Wiring,c:RobotConfig,littleEndian=false):string {
  if(c.vibration?.enabled)throw new Error('The compact 30-input student does not include SW-420. Use the USB host bridge for a vibration-aware controller.');
  const s=validateStudent(raw),recipe=COMPACT_CAMERA;if(!c.cameraEnabled)throw new Error('The compact student needs the camera.');
  const declarations=`
// Sensor recipe ${COMPACT_RECIPE}: generated from the shared sensor contract.
// Compact student ${s.hash}: 30 inputs, 12 tanh hidden units, 2 signed PWM outputs.
// Distilled executed outputs; do not apply wheel-gain compensation again.
const int8_t STUDENT_W[398]={${s.weights.join(',')}};
const float SCALE1=${s.scales[0].toPrecision(9)}f, SCALE2=${s.scales[1].toPrecision(9)}f;
bool autonomous=false; uint32_t autoUntil=0; int autoCap=80;
void runStudent(camera_fb_t *fb);
`;
  let source=bridgeSketch(w,c).replace('// Brain and eyes run in the browser; this firmware captures sensors and drives GPIO.','// ARM/M uses the host brain. AUTO runs the compact distilled student on this chip.');
  source=source.replace('void motor(int a,int b,int en,int pwm)',`${declarations}\nvoid motor(int a,int b,int en,int pwm)`);
  source=source.replace('if(command=="ARM") {','int cap=0,seconds=0;\n      if(sscanf(command.c_str(),"AUTO %d %d",&cap,&seconds)==2 && cap>=1 && cap<=120 && seconds>=1 && seconds<=60 && cameraOK) { stopMotors(); autonomous=true; autoCap=cap; autoUntil=millis()+seconds*1000; commandAt=millis(); armed=true; }\n      else if(command=="ARM") { autonomous=false;');
  source=source.replace('else if(command=="STOP") {','else if(command=="STOP") { autonomous=false;').replace('==2 && armed) {','==2 && armed && !autonomous) {');
  source=source.replace('Serial.printf("CONFIG %s\\n",BRIDGE_CONFIG); emitting=true;',`Serial.printf("STUDENT ${s.hash}\\n");\n  if(autonomous) { runStudent(fb); if(fb) esp_camera_fb_return(fb); return; }\n  Serial.printf("CONFIG %s\\n",BRIDGE_CONFIG); emitting=true;`);
  source=source.replace('void setup() {',`
void runStudent(camera_fb_t *fb) {
  RangeSample sample=rangeSample();float sonarCm=sample.cm;
  if(!armed || int32_t(millis()-autoUntil)>=0 || !fb ${c.sonarEnabled?'|| sonarCm<0 || sonarCm<12':''}) { autonomous=false; armed=false; stopMotors(); Serial.println("LOG AUTO stopped: deadline, watchdog or sensor guard"); return; }
  float input[30]={},hidden[12]={},output[2]={}; float mass=0,moment=0;
  for(int y=${recipe.top};y<${recipe.bottom};y++) for(int x=0;x<${recipe.width};x++) {
    int i=(y*160+x)*2; uint16_t pixel=${littleEndian?'uint16_t(fb->buf[i]) | uint16_t(fb->buf[i+1])<<8':'uint16_t(fb->buf[i])<<8 | fb->buf[i+1]'};
    float rgb[3]={float((pixel>>11)&31)*8/255,float((pixel>>5)&63)*4/255,float(pixel&31)*8/255};
    int cell=((y-20)/40)*4+x/40; for(int k=0;k<3;k++) input[cell*3+k]+=rgb[k]/1600;
    if(rgb[0]>${recipe.cueRed}f && rgb[2]>${recipe.cueBlue}f && rgb[1]<min(rgb[0],rgb[2])*${recipe.cueGreenRatio}f) { mass++; moment+=float(x)/159*2-1; }
  }
  input[24]=sonarCm<0?0:constrain(1-sonarCm/220,0.0f,1.0f); input[25]=sonarCm>=0?1:0;
  input[26]=float(demandL)/255; input[27]=float(demandR)/255; input[28]=mass?moment/mass*${recipe.cueBearing}f:0; input[29]=min(1.0f,mass/12800*${recipe.cueArea});
  for(int j=0;j<12;j++) { float v=STUDENT_W[360+j]*SCALE1; for(int i=0;i<30;i++) v+=input[i]*STUDENT_W[j*30+i]*SCALE1; hidden[j]=tanhf(v); }
  for(int j=0;j<2;j++) { float v=STUDENT_W[396+j]*SCALE2; for(int i=0;i<12;i++) v+=hidden[i]*STUDENT_W[372+j*12+i]*SCALE2; output[j]=tanhf(v); }
  // Recheck after camera/inference; STOP and the independent watchdog take priority.
  pollCommands(); if(!autonomous || !armed || int32_t(millis()-autoUntil)>=0) { armed=false; stopMotors(); return; }
  demandL=constrain(int(lroundf(output[0]*255)),-autoCap,autoCap); demandR=constrain(int(lroundf(output[1]*255)),-autoCap,autoCap); commandAt=millis();
  Serial.printf("AUTOFRAME %lu %.2f %d %d %lu\\n",++frameId,sonarCm,issuedL,issuedR,autoUntil-millis());
}
void setup() {`);
  source=source.replace('if(millis()-frameAt>=250)', 'if(millis()-frameAt>=(autonomous?100:250))');return source;
}
