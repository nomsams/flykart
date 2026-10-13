import {clamp,wrapAngle} from '../core';
import {DEFAULT_ROBOT} from '../robot/model';
import {CM_PER_PIXEL} from '../vision/robot';
import {SECTORS,SECTOR_ANGLES,SECTOR_RANGE,SECTOR_SPAN} from '../vision/world/world';
/** Camera-estimated ranges only. Neither the scan map nor lot geometry is read. */
export function parkingGapHints(clearance:ArrayLike<number>,bearing:number,speed:number):{heading:number;speed:number;forwardSpace:number}{
  const px=CM_PER_PIXEL/100,halfWidth=DEFAULT_ROBOT.width/2+.02,front=DEFAULT_ROBOT.length/2+.02;
  const speedM=Math.abs(speed)*90*px,horizon=.35+Math.min(.55,speedM*1.5),sectorHalf=2*SECTOR_SPAN/SECTORS*.32;
  const space=(heading:number)=>{
    let nearest=SECTOR_RANGE*px;
    for(let i=0;i<SECTORS;i++){
      const a=Math.abs(wrapAngle(SECTOR_ANGLES[i]-heading));if(a>=Math.PI/2)continue;
      const range=SECTOR_RANGE*px*(1-clamp(clearance[i],0,1));
      if(range*Math.sin(Math.max(0,a-sectorHalf))<=halfWidth)nearest=Math.min(nearest,range*Math.cos(a));
    }
    return Math.max(0,nearest-front);
  };
  let heading=0,cost=Infinity;
  for(const a of SECTOR_ANGLES){const free=space(a),near=clamp(1-free/horizon,0,1),score=1.6*Math.abs(wrapAngle(a-bearing))/Math.PI+2.4*near**1.5+(free<.035?3:0);if(score<cost){cost=score;heading=a;}}
  const forwardSpace=space(0),target=Math.min(84,forwardSpace/px/.75)*(1-.45*Math.min(1,Math.abs(heading)/.5));
  return{heading,speed:clamp(target/90,0,1),forwardSpace};
}
