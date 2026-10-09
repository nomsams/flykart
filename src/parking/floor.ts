import {DEFAULT_STYLE,type Rgb} from '../vision/camera';
import {hash2} from '../vision/rng';

export type ParkingFloor='transfer'|'asphalt';
/** Preserve the open-world ground appearance for a frozen, grass-trained parent eye. */
export function parkingFloorColour(floor:ParkingFloor,x:number,y:number):Rgb{
  if(floor==='asphalt')return [.19,.23,.27];
  const checker=(Math.floor(x/26)+Math.floor(y/26))%2===0;
  const c=checker?DEFAULT_STYLE.grassA:DEFAULT_STYLE.grassB,k=.93+.14*hash2(Math.floor(x/5),Math.floor(y/5));
  return [c[0]*k,c[1]*k,c[2]*k];
}
