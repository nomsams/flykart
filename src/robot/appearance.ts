/** Small, inspectable appearance matcher. Scores are similarities, not probabilities. */
export const APPEARANCE_RECIPE='patch-rgb-edge60-v1';
export type AppearanceModel={recipe:typeof APPEARANCE_RECIPE;name:string;positive:number[][];negative:number[][];threshold:number;margin:number};
export type ImageBox={x:number;y:number;width:number;height:number};
export function validateAppearance(raw:unknown):AppearanceModel {
  const m=raw as AppearanceModel;
  if(!m||m.recipe!==APPEARANCE_RECIPE||typeof m.name!=='string'||!m.name.trim()||m.name.length>80||![m.threshold,m.margin].every(Number.isFinite)||m.threshold<.5||m.threshold>.99||m.margin<0||m.margin>.3)throw new Error('Invalid appearance model.');
  for(const [rows,min]of [[m.positive,1],[m.negative,0]] as const)if(!Array.isArray(rows)||rows.length<min||rows.length>40||rows.some(r=>!Array.isArray(r)||r.length!==60||r.some(v=>!Number.isFinite(v)||v<0||v>1)))throw new Error('Appearance examples must contain 60 bounded features (up to 40 per class).');
  return structuredClone(m);
}
export function imageDescriptor(frame:Float32Array,w:number,h:number,box:ImageBox={x:0,y:0,width:w,height:h}):number[]{
  if(frame.length!==w*h*3||w<1||h<1||!Object.values(box).every(Number.isFinite)||box.width<=0||box.height<=0)throw new Error('Invalid appearance crop.');
  const rgb:number[]=[],n=w*h;
  for(let gy=0;gy<4;gy++)for(let gx=0;gx<4;gx++)for(let c=0;c<3;c++){
    let sum=0;for(const sy of [.25,.75])for(const sx of [.25,.75]){const x=Math.min(w-1,Math.max(0,Math.floor(box.x+(gx+sx)*box.width/4))),y=Math.min(h-1,Math.max(0,Math.floor(box.y+(gy+sy)*box.height/4)));sum+=frame[c*n+y*w+x];}rgb.push(sum/4);
  }
  const means=[0,1,2].map(c=>rgb.filter((_,i)=>i%3===c).reduce((a,b)=>a+b,0)/16),light=means.reduce((a,b)=>a+b)/3;
  const normalized=rgb.map(v=>Math.min(1,v/(light+.15)*.5));
  const lum=Array.from({length:16},(_,i)=>(normalized[i*3]+normalized[i*3+1]+normalized[i*3+2])/3),edges:number[]=[];
  for(let y=0;y<4;y++)edges.push([0,1,2].reduce((a,x)=>a+Math.abs(lum[y*4+x+1]-lum[y*4+x]),0)/3);
  for(let x=0;x<4;x++)edges.push([0,1,2].reduce((a,y)=>a+Math.abs(lum[(y+1)*4+x]-lum[y*4+x]),0)/3);
  const contrast=Math.min(1,Math.sqrt(lum.reduce((a,v)=>a+(v-.5)**2,0)/16)*2);
  return [...normalized,...means,contrast,...edges];
}
export function appearanceScore(features:number[],m:AppearanceModel):{score:number;margin:number}{
  const similarity=(r:number[])=>1-features.reduce((sum,v,i)=>sum+Math.abs(v-r[i]),0)/60;
  const score=Math.max(...m.positive.map(similarity)),negative=m.negative.length?Math.max(...m.negative.map(similarity)):0;
  return {score,margin:score-negative};
}
export function appearanceBoxes(frame:Float32Array,w:number,h:number,m:AppearanceModel):{box:ImageBox;score:number}[]{
  const candidates:{box:ImageBox;score:number}[]=[];
  for(const width of [4,6,9,13,18,25,34,48,64].filter(v=>v<=w))for(const aspect of [.5,.75,1,1.5,2]){
    const height=Math.round(width/aspect);if(height<3||height>h)continue;const stride=Math.max(2,Math.round(width/4));
    for(let y=0;y<=h-height;y+=stride)for(let x=0;x<=w-width;x+=stride){const box={x,y,width,height},s=appearanceScore(imageDescriptor(frame,w,h,box),m);if(s.score>=m.threshold&&s.margin>=m.margin)candidates.push({box,score:s.score});}
  }
  const result:typeof candidates=[];
  for(const c of candidates.sort((a,b)=>b.score-a.score)){
    if(result.some(r=>{const a=c.box,b=r.box,intersection=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return intersection/Math.min(a.width*a.height,b.width*b.height)>.35;}))continue;
    result.push(c);if(result.length===12)break;
  }
  return result;
}
