import { SensorProfile, CM_PER_PIXEL } from "./robot";
import { DEFAULT_VISION, validateVisionSettings, VisionSettings } from "../robot/vision-workbench";
import { RewardConfig } from '../core';
import { validateRewards } from '../training-recipe';

export type RacingSettings = {
  version: 1; multiLap: boolean; laps: number; impactPain: boolean;
  visual: VisionSettings; resolution: "native" | "32x16" | "16x8";
  cameraNoise?:number; cameraBrightness?:number;
  reward?: RewardConfig;
  camera: { hfov: number; heightCm: number; forwardCm: number; pitchDeg: number } | null;
  sonar: { heightCm: number; forwardCm: number; yawDeg: number; pitchDeg: number; sigmaDeg: number; scale: number; offsetCm: number } | null;
};
export const DEFAULT_RACING: RacingSettings = { version: 1, multiLap: false, laps: 3, impactPain: true, visual: { ...DEFAULT_VISION }, resolution: "native", camera: null, sonar: null };
export function validateRacingSettings(value: unknown): RacingSettings {
  const s = value as RacingSettings;
  if (!s || s.version !== 1 || typeof s.multiLap !== "boolean" || typeof s.impactPain !== "boolean" || ![2,3,5].includes(s.laps) || !["native","32x16","16x8"].includes(s.resolution)) throw new Error("Invalid racing settings.");
  if(s.cameraNoise!==undefined&&(!Number.isFinite(s.cameraNoise)||s.cameraNoise<0||s.cameraNoise>.2)||s.cameraBrightness!==undefined&&(!Number.isFinite(s.cameraBrightness)||s.cameraBrightness<.1||s.cameraBrightness>2))throw new Error('Invalid camera noise or brightness.');
  const fields = (v: object | null, bounds: Record<string, [number,number]>) => {
    if (v === null) return;
    if (!v || typeof v !== "object") throw new Error("Invalid sensor calibration.");
    for (const [key, [min,max]] of Object.entries(bounds)) { const n = (v as Record<string,number>)[key]; if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid calibration: ${key}.`); }
  };
  fields(s.camera, { hfov:[40,140], heightCm:[2,100], forwardCm:[-26,26], pitchDeg:[-30,60] });
  fields(s.sonar, { heightCm:[2,100], forwardCm:[-26,26], yawDeg:[-90,90], pitchDeg:[-30,30], sigmaDeg:[4,24], scale:[.5,1.5], offsetCm:[-30,30] });
  return { version:1, multiLap:s.multiLap, laps:s.laps, impactPain:s.impactPain, ...(s.reward ? {reward:validateRewards(s.reward)} : {}), resolution:s.resolution, cameraNoise:s.cameraNoise??0,cameraBrightness:s.cameraBrightness??1,visual:validateVisionSettings(s.visual), camera:s.camera ? {...s.camera}:null, sonar:s.sonar ? {...s.sonar}:null };
}
export function calibratedProfile(base: SensorProfile, settings: RacingSettings): SensorProfile {
  const c = settings.camera, s = settings.sonar;
  const camera = c ? { ...base.camera, hfov:c.hfov*Math.PI/180, mountHeight:c.heightCm/CM_PER_PIXEL, mountForward:c.forwardCm/CM_PER_PIXEL, pitch:c.pitchDeg*Math.PI/180 } : {...base.camera};
  return { ...base, camera, worldCamera:c ? {...camera}:{...base.worldCamera}, sonar:base.sonar ? { ...base.sonar, ...(s ? { mountHeight:s.heightCm/CM_PER_PIXEL, mountForward:s.forwardCm/CM_PER_PIXEL, yawDeg:s.yawDeg, pitchDeg:s.pitchDeg, lobeSigmaDeg:s.sigmaDeg, rangeScale:s.scale, rangeOffsetCm:s.offsetCm }: {}) } : null };
}
/** Fit true = slope * measured + offset from user-entered metre-independent cm pairs. */
export function fitRange(pairs: readonly [number,number][]): {scale:number;offsetCm:number;rmse:number} {
  if (pairs.length < 3 || pairs.some(p=>p.length!==2 || p.some(n=>!Number.isFinite(n)||n<2||n>400))) throw new Error("Enter at least three measured,true cm pairs in the 2–400 cm range.");
  const mean = (k:number) => pairs.reduce((a,p)=>a+p[k],0)/pairs.length, x=mean(0),y=mean(1);
  const spread=pairs.reduce((a,p)=>a+(p[0]-x)**2,0);
  if (spread < 100) throw new Error("Use distances spanning at least 20 cm.");
  const scale=pairs.reduce((a,p)=>a+(p[0]-x)*(p[1]-y),0)/spread, offsetCm=y-scale*x;
  if (scale<.5||scale>1.5||Math.abs(offsetCm)>30) throw new Error("Fit outside plausible correction bounds; check pair order and units.");
  return {scale,offsetCm,rmse:Math.sqrt(pairs.reduce((a,p)=>a+(p[1]-scale*p[0]-offsetCm)**2,0)/pairs.length)};
}
export function boardFov(widthCm:number,distanceCm:number,pixels:number,imageWidth:number):number {
  if (![widthCm,distanceCm,pixels,imageWidth].every(Number.isFinite) || widthCm<=0||distanceCm<=0||pixels<=0||pixels>imageWidth) throw new Error("Use positive board width, distance and visible pixel width.");
  const fov=2*Math.atan(imageWidth*widthCm/(2*pixels*distanceCm))*180/Math.PI;
  if(fov<40||fov>140)throw new Error("Board measurement gives an implausible FOV (allowed 40–140°).");
  return fov;
}
