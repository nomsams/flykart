import type {Pose} from '../robot/model';
type Observation={tick:number;travel:number;reversal:number;commandReversal:number;x:number;z:number};
/** External training judge. Actual body motion, never extra sensor/goal inputs. */
export class ParkingMotionJudge{
  #rows:Observation[]=[];
  #direction=0;#leg=0;#acceptedMotion=0;#command=0;#commandTicks=0;#acceptedCommand=0;
  observe(tick:number,before:Pose,after:Pose,drive:number,windowSeconds:number,exempt:boolean){
    if(exempt){this.#rows=[];this.#direction=0;this.#leg=0;this.#acceptedMotion=0;this.#acceptedCommand=0;this.#command=0;this.#commandTicks=0;}
    const dx=after.x-before.x,dz=after.z-before.z,travel=Math.hypot(dx,dz),signed=dx*Math.cos(before.heading)+dz*Math.sin(before.heading);
    let reversal=0,commandReversal=0;
    if(Math.abs(signed)>1e-5){const sign=Math.sign(signed);if(sign!==this.#direction){this.#direction=sign;this.#leg=0;}this.#leg+=Math.abs(signed);
      // Only count a new direction after 1.2 cm of actual movement.
      if(this.#leg>=.012&&this.#acceptedMotion!==sign){reversal=sign;this.#acceptedMotion=sign;}
    }
    const command=Math.abs(drive)>=.15?Math.sign(drive):0;
    if(command!==this.#command){this.#command=command;this.#commandTicks=0;}
    if(command&&++this.#commandTicks===6){if(this.#acceptedCommand&&this.#acceptedCommand!==command)commandReversal=1;this.#acceptedCommand=command;}
    this.#rows.push({tick,travel,reversal,commandReversal,x:after.x,z:after.z});
    while(this.#rows.length&&this.#rows[0].tick<tick-windowSeconds*30)this.#rows.shift();
    const movements=this.#rows.filter(r=>r.reversal!==0);let reversals=0;
    for(let i=1;i<movements.length;i++)if(movements[i].reversal!==movements[i-1].reversal)reversals++;
    const first=this.#rows[0],distance=this.#rows.reduce((a,r)=>a+r.travel,0),net=Math.hypot(after.x-first.x,after.z-first.z),commands=this.#rows.reduce((a,r)=>a+r.commandReversal,0),full=tick-first.tick>=windowSeconds*30-1;
    return{travelCm:distance*100,netCm:net*100,reversals:Math.max(reversals,commands),oscillating:!exempt&&full&&(reversals>=4&&distance>=.08||commands>=4&&net<.04),stalled:!exempt&&full&&net<.04};
  }
}
