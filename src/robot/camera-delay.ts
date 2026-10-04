export class CameraDelay {
  private queue:{pixels:Uint8ClampedArray;dropped:boolean;time:number}[]=[];private last:{pixels:Uint8ClampedArray;dropped:boolean;time:number}|null=null;private at=-Infinity;
  capturedAt=0;age=0;
  constructor(readonly seconds=0){if(!Number.isFinite(seconds)||seconds<0||seconds>1)throw new Error('Camera latency must be 0–1 seconds.');}
  reset():void{this.queue=[];this.last=null;this.at=-Infinity;this.age=0;this.capturedAt=0;}
  deliver(pixels:Uint8ClampedArray,dropped:boolean,time:number):{pixels:Uint8ClampedArray;dropped:boolean}{
    if(!Number.isFinite(time)||pixels.length%4||!pixels.length)throw new Error('Invalid camera delivery frame or timestamp.');
    if(time<this.at){this.queue=[];this.last=null;}this.at=time;
    if(this.queue.at(-1)?.time===time)this.queue.pop();
    this.queue.push({pixels:pixels.slice(),dropped,time});
    while(this.queue.length&&this.queue[0].time<=time-this.seconds+1e-8)this.last=this.queue.shift()!;
    if(this.queue.length>64)throw new Error('Camera delay queue exceeds frame budget.');
    this.capturedAt=this.last?.time??time;this.age=time-this.capturedAt;
    if(this.last)return {pixels:this.last.pixels,dropped:this.last.dropped};
    const black=new Uint8ClampedArray(pixels.length);for(let i=3;i<black.length;i+=4)black[i]=255;return {pixels:black,dropped:true};
  }
}
