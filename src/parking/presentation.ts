export type ParkingPreviewMode='full'|'low'|'headless';
/** Presentation and pacing only; never changes tick size, inference or rewards. */
export class ParkingPresentation{
  mode:ParkingPreviewMode='full';watchGeneration=0;every=0;watchSpeed=4;
  private suppressedGeneration:number|null=null;
  hideGeneration(generation:number){this.suppressedGeneration=generation;this.mode='headless';}
  clearSuppression(){this.suppressedGeneration=null;}
  scheduled(generation:number){return generation>0&&(generation===this.watchGeneration||this.every>0&&generation%this.every===0);}
  visible(generation:number){return this.mode!=='headless'||this.scheduled(generation)&&generation!==this.suppressedGeneration;}
  speed(base:number,generation:number){return this.mode==='headless'&&this.visible(generation)?this.watchSpeed:base;}
  restore(raw:unknown){const r=raw as Partial<ParkingPresentation>;if(!r||!['full','low','headless'].includes(r.mode??'')||!Number.isInteger(r.watchGeneration)||r.watchGeneration!<0||r.watchGeneration!>1000||!Number.isInteger(r.every)||r.every!<0||r.every!>1000||![1,4,16,64].includes(r.watchSpeed??0))throw Error('Invalid parking display schedule.');this.mode=r.mode!;this.watchGeneration=r.watchGeneration!;this.every=r.every!;this.watchSpeed=r.watchSpeed!;}
  toJSON(){return{mode:this.mode,watchGeneration:this.watchGeneration,every:this.every,watchSpeed:this.watchSpeed};}
}
