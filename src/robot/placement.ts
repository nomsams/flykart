import { Pose, RobotConfig, robotContactParts, WorldObject } from "./model";
import { rectangle, polygonsOverlap } from "./contacts";
export function validatePose(raw:unknown):Pose {
  const p=raw as Pose;if(!p||![p.x,p.z,p.heading].every(Number.isFinite)||Math.abs(p.x)>3.5||Math.abs(p.z)>3.5||Math.abs(p.heading)>Math.PI*100)throw new Error("Robot position or heading is out of range.");
  return {x:p.x,z:p.z,heading:p.heading};
}
export function placementError(p:Pose,c:RobotConfig,objects:WorldObject[]):string|null {
  const footprint=rectangle({x:p.x,z:p.z,yaw:p.heading,width:c.length,depth:c.width});
  if(footprint.some(v=>Math.abs(v.x)>3.5||Math.abs(v.z)>3.5))return "The robot must fit inside the floor.";
  const hit=objects.flatMap(o=>robotContactParts(o,c)).find(part=>polygonsOverlap(footprint,part.polygon));
  return hit?"Robot placement overlaps "+hit.part+". Move it into free space.":null;
}
