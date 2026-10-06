import {clamp} from '../core';
export type HungerSettings={enabled:boolean;initial:number;idleDrain:number;motionDrain:number;chargeRate:number;dockRadius:number;dockHold:number;sated:number};
export const DEFAULT_HUNGER:HungerSettings={enabled:false,initial:.12,idleDrain:.001,motionDrain:.015,chargeRate:.15,dockRadius:.06,dockHold:1,sated:.85};
export function validateHunger(raw:unknown=DEFAULT_HUNGER):HungerSettings{
  const s=raw as HungerSettings,bounds={initial:[0,1],idleDrain:[0,.05],motionDrain:[0,.1],chargeRate:[.01,.5],dockRadius:[.02,.25],dockHold:[.1,5],sated:[.5,1]};
  if(!s||typeof s.enabled!=='boolean')throw new Error('Invalid hunger settings.');
  for(const [k,[min,max]]of Object.entries(bounds)){const v=s[k as keyof HungerSettings];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('Invalid hunger parameter: '+k);}
  return {...s};
}
export class EnergyState {
  energy:number;charging=false;hold=0;charged=0;cycles=0;private wasSated=false;
  constructor(readonly settings:HungerSettings){this.energy=settings.initial;this.wasSated=this.energy>=settings.sated;}
  get hunger():number{return 1-this.energy;}
  /** An external test intervention, never credited as learned reward. */
  injectLow(value=.12):void {if(!Number.isFinite(value)||value<0||value>1)throw Error('Invalid injected energy.');this.energy=value;this.hold=0;this.charging=false;this.wasSated=false;}
  /** Dock contact is a virtual electrical-contact sensor, not a target-position input. */
  step(dt:number,motorEffort:number,dockContact:boolean):number{
    if(!this.settings.enabled)return 0;
    if(!Number.isFinite(dt)||dt<0||dt>1||!Number.isFinite(motorEffort))throw new Error('Invalid energy step.');
    this.hold=dockContact?this.hold+dt:0;this.charging=this.hold>=this.settings.dockHold;
    const before=this.energy,drain=(this.settings.idleDrain+this.settings.motionDrain*Math.abs(motorEffort))*dt;
    this.energy=clamp(before-drain+(this.charging?this.settings.chargeRate*dt:0),0,1);
    const gained=Math.max(0,this.energy-before);this.charged+=gained;
    if(this.energy>=this.settings.sated&&!this.wasSated)this.cycles++;
    this.wasSated=this.energy>=this.settings.sated;
    // Reduction of squared energy deficit: reward tapers naturally as the robot satiates.
    return (1-before)**2-(1-this.energy)**2;
  }
}
