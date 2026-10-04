import { BufferGeometry, CylinderGeometry, IcosahedronGeometry } from "three";
import type { WorldObject } from "./model";

export type NaturalShape = {
  part: string; kind: "icosahedron" | "cylinder"; detail: number;
  scale: [number, number, number]; centreY: number;
  radiusTop?: number; radiusBottom?: number; colour: "trunk" | "body"; collidable: boolean;
};

/** One definition shared by the visible mesh and its contact geometry. */
export function naturalShapes(o: WorldObject): NaturalShape[] {
  if (o.kind === "ball") return [{part:'blue ball surface',kind:'icosahedron',detail:2,scale:[o.width/2,o.height/2,o.depth/2],centreY:o.height/2,colour:'body',collidable:true}];
  if (o.kind === "tree") return [
    { part: "tree trunk", kind: "cylinder", detail: 7, radiusTop: .06, radiusBottom: .09, scale: [o.width, o.height * .72, o.width], centreY: o.height * .36, colour: "trunk", collidable: true },
    { part: "tree canopy", kind: "icosahedron", detail: 1, scale: [o.width * .55, o.height * .28, o.depth * .55], centreY: o.height * .74, colour: "body", collidable: true },
  ];
  if (o.kind === "water") return [{ part: "water surface", kind: "cylinder", detail: 40, radiusTop: 1, radiusBottom: 1, scale: [o.width / 2, .008, o.depth / 2], centreY: .006, colour: "body", collidable: false }];
  if (o.kind === "shoe") return [
    { part: "shoe sole", kind: "cylinder", detail: 16, radiusTop: 1, radiusBottom: 1, scale: [o.width / 2, o.height * .15, o.depth / 2], centreY: o.height * .075, colour: "trunk", collidable: true },
    { part: "shoe upper", kind: "icosahedron", detail: 1, scale: [o.width * .48, o.height * .5, o.depth * .48], centreY: o.height * .5, colour: "body", collidable: true },
  ];
  if (["bush", "rock", "stone"].includes(o.kind)) return [{ part: o.kind === "bush" ? "bush foliage" : `${o.kind} surface`, kind: "icosahedron", detail: o.kind === "bush" ? 1 : 0, scale: [o.width / 2, o.height / 2, o.depth / 2], centreY: o.height / 2, colour: "body", collidable: true }];
  return [];
}

export function naturalGeometry(shape: NaturalShape): BufferGeometry {
  return shape.kind === "icosahedron" ? new IcosahedronGeometry(1, shape.detail) : new CylinderGeometry(shape.radiusTop, shape.radiusBottom, 1, shape.detail);
}
