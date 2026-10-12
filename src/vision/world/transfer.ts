import {clamp,type Action} from '../../core';
export type SpeedFeedback='command'|'measured';
export type SonarFeedback='echo-valid'|'amplitude';
/** Open-loop motor estimate: deliberately cannot observe collisions, terrain or pose. */
export class CommandSpeed {
  value=0;
  step(a:Action,dt=1/30):void {
    const drive=clamp(a.throttle,0,1)*55-clamp(a.reverse??0,0,1)*45;
    const braking=clamp(a.brake,0,1)*75,old=this.value;
    this.value=clamp(old+(drive-old*.23-Math.sign(old)*braking)*dt,-48,90);
    if(braking&&drive===0&&Math.sign(this.value)!==Math.sign(old))this.value=0;
  }
}
export function transferContract(s:{task?:string;speedFeedback?:SpeedFeedback;sonarFeedback?:SonarFeedback;sonarOn?:boolean;profile?:{sonar?:unknown};controller:{inputCount:number};vision?:{spec:{width:number;height:number}}|null}){
  return {version:1,stage:'simulation-training',hardwareValidated:false,
    task:s.task??'forage',goalSource:s.task==='explore'?'processed camera pixels':'external goal bearing / range required',
    speedFeedback:s.speedFeedback??'measured',speedUnits:'normalized simulator units; real PWM / speed calibration required',
    camera:s.vision?{width:s.vision.spec.width,height:s.vision.spec.height,colour:'RGB',required:'Match crop, FOV, mount, colour conversion and frame timing in the 3D / hardware adapter'}:null,
    sonar:s.sonarOn!==false&&Boolean(s.profile?.sonar)&&s.controller.inputCount===19?(s.sonarFeedback==='echo-valid'?'front HC-SR04 closeness / echo-valid bit':'simulated closeness / amplitude; amplitude unavailable on basic HC-SR04'):'not connected to neural inputs',
    trainingOnly:['absolute position / trajectory judge','reward / pain scores','collision labels','ground-truth camera training labels'],
    reverseClearance:'Front camera / sonar cannot verify rear clearance; reverse needs a supervised hardware limit or rear sensing',
    nextGate:'Frozen tests on unseen layouts and sensor failures, then measured 3D chassis calibration and supervised low-speed hardware trials'};
}
