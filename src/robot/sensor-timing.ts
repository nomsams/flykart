export class SensorTiming {
  private channels=new Map<string,{last:number;intervals:number[];age:number;received:number;missing:number}>();
  sample(channel:string,at:number,age=0,valid=true):void{
    if(!Number.isFinite(at)||!Number.isFinite(age)||age<0)return;
    const c=this.channels.get(channel)??{last:-Infinity,intervals:[],age:0,received:0,missing:0};
    if(at>c.last&&Number.isFinite(c.last)){c.intervals.push(at-c.last);if(c.intervals.length>100)c.intervals.shift();}
    c.last=at;c.age=age;c.received++;c.missing+=+!valid;this.channels.set(channel,c);
  }
  report(now:number){return [...this.channels].map(([channel,c])=>({channel,samples:c.received,missing:c.missing,ageMs:Math.max(0,now-c.last+c.age)*1000,hz:c.intervals.length?c.intervals.length/c.intervals.reduce((a,b)=>a+b,0):0,p95GapMs:c.intervals.length?[...c.intervals].sort((a,b)=>a-b)[Math.ceil(c.intervals.length*.95)-1]*1000:0}));}
  reset():void{this.channels.clear();}
}
