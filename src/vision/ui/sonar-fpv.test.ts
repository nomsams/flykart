import {it,expect} from 'vitest';
import {sonarFootprint,sonarViewport,cameraOutline} from './sonar-fpv';
import {HC_SR04,ROBOT_CAMERA} from '../robot';
const pose={x:0,y:0,heading:0},camera={...ROBOT_CAMERA,pitch:0},spec={...HC_SR04,mountHeight:camera.mountHeight,mountForward:camera.mountForward};
const center=(p:ReturnType<typeof sonarFootprint>)=>p.filter(x=>x!==null).reduce((s,p)=>s+p.x,0)/p.filter(Boolean).length;
it('projects a narrow main beam inside the wider RGB camera without needing objects or pixels',()=>{
  const p=sonarFootprint(camera,spec,100,pose,pose);expect(p.every(Boolean)).toBe(true);
  const xs=p.map(p=>p!.x),ys=p.map(p=>p!.y);expect(Math.max(...xs)-Math.min(...xs)).toBeLessThan(camera.width/5);expect(Math.min(...ys)).toBeLessThan(camera.height/2);expect(Math.max(...ys)).toBeGreaterThan(camera.height/2);
});
it('honors sonar yaw, pitch and range-dependent mount parallax',()=>{
  expect(center(sonarFootprint(camera,{...spec,yawDeg:20},100,pose,pose))).toBeGreaterThan(camera.width/2+3);
  const tilted=sonarFootprint(camera,{...spec,pitchDeg:20},100,pose,pose);expect(tilted[0]!.y).toBeGreaterThan(camera.height/2);
  const low={...spec,mountHeight:spec.mountHeight-3};expect(sonarFootprint(camera,low,20,pose,pose)[0]!.y).toBeGreaterThan(sonarFootprint(camera,low,200,pose,pose)[0]!.y);
});
it('holds the measured beam at its acquisition pose while the robot turns, without mutating the sample',()=>{
  const sample={x:0,y:0,heading:0},copy={...sample};const p=sonarFootprint(camera,spec,100,sample,{...pose,heading:.3});expect(center(p)).toBeLessThan(camera.width/2-3);expect(sample).toEqual(copy);
});
it('widens sonar-only view for a beam outside the camera and projects the physical camera boundary',()=>{
  const narrow={...camera,hfov:30*Math.PI/180},side={...spec,yawDeg:40},view=sonarViewport(narrow,side);
  expect(view.hfov).toBeGreaterThan(narrow.hfov);expect(center(sonarFootprint(view,side,100,pose,pose))).toBeLessThan(view.width);
  const outline=cameraOutline(narrow,view);expect(outline.every(p=>p&&p.x>0&&p.x<view.width)).toBe(true);
  const original=cameraOutline(camera,camera);expect(original[0]!.x).toBeCloseTo(0);expect(original[0]!.y).toBeCloseTo(0);expect(original[2]!.x).toBeCloseTo(camera.width);expect(original[2]!.y).toBeCloseTo(camera.height);
});
it('does not project rear-facing echoes as obstacles in front',()=>{
  expect(sonarFootprint(camera,{...spec,yawDeg:180},100,pose,pose).every(p=>p===null)).toBe(true);
});
