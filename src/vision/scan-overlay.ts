import type {SonarTarget} from './sonar';
export type ScanProject=(x:number,y:number,z?:number)=>{x:number;y:number};
export type ScanReference={objects:readonly SonarTarget[];path?:readonly {x:number;y:number}[]};
/** Known geometry is an observer reference. This function never edits scan cells or sensors. */
export function drawScanReference(c:CanvasRenderingContext2D,reference:ScanReference,project:ScanProject,opacity=.45,iso=false):void{
  c.save();c.globalAlpha=opacity;c.strokeStyle='#6cd9ff';c.fillStyle='rgba(80,183,226,.10)';c.lineWidth=1;
  const polygon=(points:{x:number;y:number}[])=>{c.beginPath();points.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();};
  for(const o of [...reference.objects].sort((a,b)=>a.x+a.y-b.x-b.y)){
    const vertices=o.kind==='circle'?Array.from({length:16},(_,i)=>({x:o.x+Math.cos(i*Math.PI/8)*o.radius,y:o.y+Math.sin(i*Math.PI/8)*o.radius})):[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:o.x+x*o.halfLength*Math.cos(o.heading)-y*o.halfWidth*Math.sin(o.heading),y:o.y+x*o.halfLength*Math.sin(o.heading)+y*o.halfWidth*Math.cos(o.heading)}));
    const floor=vertices.map(p=>project(p.x,p.y,0)),top=vertices.map(p=>project(p.x,p.y,iso?o.z1:0));
    // Feet/footprints stay on the scan ground. Roofs show supplied scene height, not measured height.
    c.setLineDash(o.z0>0?[3,3]:[]);polygon(floor);c.stroke();polygon(top);c.fill();c.stroke();
    if(iso){c.setLineDash([]);for(let i=0;i<vertices.length;i+=o.kind==='circle'?4:1){const p=vertices[i],a=project(p.x,p.y,o.z0),b=top[i];c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();}}
  }
  if(reference.path?.length){c.setLineDash([5,4]);c.beginPath();reference.path.forEach((p,i)=>{const q=project(p.x,p.y);i?c.lineTo(q.x,q.y):c.moveTo(q.x,q.y);});c.closePath();c.stroke();}
  c.restore();
}
