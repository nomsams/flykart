import { clamp } from '../core';
import { mulberry32 } from '../vision/rng';
export type StudentRow={episode:string;input:number[];pwm:[number,number]};
export type CompactStudent={format:'flykart-compact-student';version:1;recipe:'rgb565-grid30-v1';hidden:12;weights:number[];scales:[number,number];hash:string;metrics:{trainEpisodes:number;testEpisodes:number;trainRows:number;testRows:number;floatMAE:number;int8MAE:number;directionAgreement:number};notes:string};
const PARAMETERS=398;
/** Integer RGB565 quantization, centred 160×80 crop, eight 40×40 RGB means. Same loops on ESP32. */
export function compactInput(rgba:Uint8ClampedArray,cm:number|null,previous:[number,number]):number[] {
  if(rgba.length!==160*120*4)throw new Error('Compact recipe requires a 160×120 camera frame.');
  const out=new Array(30).fill(0);let mass=0,moment=0;
  for(let y=20;y<100;y++)for(let x=0;x<160;x++){const i=(y*160+x)*4,cell=Math.floor((y-20)/40)*4+Math.floor(x/40),rgb=[(rgba[i]>>3)*8/255,(rgba[i+1]>>2)*4/255,(rgba[i+2]>>3)*8/255];for(let k=0;k<3;k++)out[cell*3+k]+=rgb[k]/1600;if(rgb[0]>.55&&rgb[2]>.45&&rgb[1]<Math.min(rgb[0],rgb[2])*.78){mass++;moment+=x/159*2-1;}}
  out[24]=cm===null?0:clamp(1-cm/220,0,1);out[25]=+(cm!==null);out[26]=previous[0];out[27]=previous[1];out[28]=mass?moment/mass*.18:0;out[29]=clamp(mass/12800*12,0,1);return out;
}
function forward(input:number[],w:number[]):{hidden:number[];out:[number,number]} {
  const h=Array.from({length:12},(_,j)=>Math.tanh(w[360+j]+input.reduce((s,v,i)=>s+v*w[j*30+i],0))),out=Array.from({length:2},(_,j)=>Math.tanh(w[396+j]+h.reduce((s,v,i)=>s+v*w[372+j*12+i],0))) as [number,number];return {hidden:h,out};
}
export function studentPredict(student:CompactStudent,input:number[]):[number,number] {if(input.length!==30||input.some(v=>!Number.isFinite(v)))throw new Error('Invalid compact input.');return forward(input,student.weights.map((v,i)=>v*student.scales[i<372?0:1])).out;}
export function studentHash(weights:number[],scales:number[]):string {let hash=2166136261;for(const c of JSON.stringify([weights,scales,'rgb565-grid30-v1'])){hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16).padStart(8,'0');}
export function validateStudent(raw:unknown):CompactStudent {const s=raw as CompactStudent;if(!s||s.format!=='flykart-compact-student'||s.version!==1||s.recipe!=='rgb565-grid30-v1'||s.hidden!==12||!Array.isArray(s.weights)||s.weights.length!==PARAMETERS||s.weights.some(v=>!Number.isInteger(v)||v< -127||v>127)||!Array.isArray(s.scales)||s.scales.length!==2||s.scales.some(v=>!Number.isFinite(v)||v<=0||v>100)||s.hash!==studentHash(s.weights,s.scales)||!s.metrics||![s.metrics.trainEpisodes,s.metrics.testEpisodes,s.metrics.trainRows,s.metrics.testRows].every(v=>Number.isInteger(v)&&v>0&&v<=8000)||![s.metrics.floatMAE,s.metrics.int8MAE].every(v=>Number.isFinite(v)&&v>=0&&v<=2)||!Number.isFinite(s.metrics.directionAgreement)||s.metrics.directionAgreement<0||s.metrics.directionAgreement>1||typeof s.notes!=='string'||s.notes.length>4000)throw new Error('Invalid compact student or parameter checksum.');return structuredClone(s);}
export async function distill(rows:StudentRow[],progress:(epoch:number)=>void,cancel:()=>boolean,epochs=30):Promise<CompactStudent> {
  if(rows.length<200||rows.length>8000||rows.some(r=>!r.episode||r.input.length!==30||r.input.some(v=>!Number.isFinite(v)||Math.abs(v)>1.01)||r.pwm.some(v=>!Number.isFinite(v)||Math.abs(v)>1)))throw new Error('Record 200–8,000 valid executed-motor samples across at least three episodes.');
  const episodes=[...new Set(rows.map(r=>r.episode))].sort();if(episodes.length<3)throw new Error('Use at least three independent episodes; one entire episode is held out.');
  const testIds=new Set(episodes.filter((_,i)=>i%4===0)),train=rows.filter(r=>!testIds.has(r.episode)),test=rows.filter(r=>testIds.has(r.episode));if(train.length<100||test.length<50)throw new Error('Insufficient samples in the episode-level train/test split.');
  const rng=mulberry32(2048),w=Array.from({length:PARAMETERS},()=> (rng()-.5)*.2);
  for(let epoch=0;epoch<epochs;epoch++){
    if(cancel())throw new Error('Distillation cancelled.');
    for(let n=0;n<train.length;n++){const row=train[Math.floor(rng()*train.length)],f=forward(row.input,w),delta=f.out.map((v,j)=>(v-row.pwm[j])*(1-v*v)),dh=f.hidden.map((v,i)=>delta.reduce((sum,d,j)=>sum+d*w[372+j*12+i],0)*(1-v*v)),rate=.015/(1+epoch*.05);
      for(let j=0;j<2;j++){for(let i=0;i<12;i++)w[372+j*12+i]-=rate*delta[j]*f.hidden[i];w[396+j]-=rate*delta[j];}for(let j=0;j<12;j++){for(let i=0;i<30;i++)w[j*30+i]-=rate*dh[j]*row.input[i];w[360+j]-=rate*dh[j];}
    }
    progress(epoch+1);await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  const scales:[number,number]=[Math.max(.00001,...w.slice(0,372).map(Math.abs))/127,Math.max(.00001,...w.slice(372).map(Math.abs))/127],weights=w.map((v,i)=>Math.round(v/scales[i<372?0:1])),student:CompactStudent={format:'flykart-compact-student',version:1,recipe:'rgb565-grid30-v1',hidden:12,weights,scales,hash:studentHash(weights,scales),metrics:{trainEpisodes:episodes.length-testIds.size,testEpisodes:testIds.size,trainRows:train.length,testRows:test.length,floatMAE:0,int8MAE:0,directionAgreement:0},notes:'Distilled executed motor policy. 398 int8 parameters plus two scales; 12 hidden activations. Raw camera grid replaces the CNN and full Kenyon memory. Physical transfer unmeasured. Held-out episodes are excluded from fitting.'};
  for(const row of test){const f=forward(row.input,w).out,q=studentPredict(student,row.input);for(let j=0;j<2;j++){student.metrics.floatMAE+=Math.abs(f[j]-row.pwm[j])/(test.length*2);student.metrics.int8MAE+=Math.abs(q[j]-row.pwm[j])/(test.length*2);student.metrics.directionAgreement+=+(Math.sign(q[j])===Math.sign(row.pwm[j]))/(test.length*2);}}student.metrics.directionAgreement=clamp(student.metrics.directionAgreement,0,1);return student;
}
