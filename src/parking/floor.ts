import {DEFAULT_STYLE,type Rgb} from '../vision/camera';
import {hash2} from '../vision/rng';

export type ParkingFloor='transfer'|'asphalt';
/** Preserve the open-world ground appearance for a frozen, grass-trained parent eye. */
export function parkingFloorColour(floor:ParkingFloor,x:number,y:number,out:Rgb=[0,0,0]):Rgb{
  if(floor==='asphalt'){out[0]=.19;out[1]=.23;out[2]=.27;return out;}
  const checker=(Math.floor(x/26)+Math.floor(y/26))%2===0;
  const c=checker?DEFAULT_STYLE.grassA:DEFAULT_STYLE.grassB,k=.93+.14*hash2(Math.floor(x/5),Math.floor(y/5));
  out[0]=c[0]*k;out[1]=c[1]*k;out[2]=c[2]*k;return out;
}
