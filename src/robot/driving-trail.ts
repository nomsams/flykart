import type { Pose } from './model';
/** Bounded line segments: teleports and resets never paint a line across the room. */
export class DrivingTrail{
  readonly positions:Float32Array;
  count=0;
  private next=0;
  private last:Pose|null=null;
  constructor(readonly capacity=4000){this.positions=new Float32Array(capacity*6);}
  clear():void{this.count=0;this.next=0;this.last=null;}
  break():void{this.last=null;}
  record(pose:Pose):boolean{
    if(!this.last){this.last={...pose};return false;}
    const distance=Math.hypot(pose.x-this.last.x,pose.z-this.last.z);
    if(distance>1){this.last={...pose};return false;}
    if(distance<.015)return false;
    const at=this.next*6;this.positions.set([this.last.x,.003,this.last.z,pose.x,.003,pose.z],at);
    this.next=(this.next+1)%this.capacity;this.count=Math.min(this.capacity,this.count+1);this.last={...pose};return true;
  }
}
